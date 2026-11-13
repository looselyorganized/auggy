/** Installed generated-application execution and independent observation assertions. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  parseApplicationStream,
  startApplicationChild,
  withApplicationEdit,
} from "./application-consumer";
import {
  applicationHttp,
  applicationThreadRef,
  readApplicationJsonLines,
  waitForApplicationReady,
} from "./application-http";
import type { ApplicationResponse } from "./application-http";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_ANSWER_TEXT,
  PROVIDER_FIXTURE_FINAL_TEXT,
  type ProviderFixtureEvidence,
} from "./provider-fixture";
import {
  AUTHORING_BOUNDS,
  type AuthoringEffectCounts,
  type GeneratedApplicationRecipe,
  type GeneratedApplicationRunOptions,
} from "./authoring-contract";
import {
  assertAuthoringCommandSucceeded,
  readAuthoringSource,
  runAuthoringBuild,
  runBoundedAuthoringCli,
  snapshotGeneratedAuthoringSources,
} from "./authoring-consumer";
import { redactEvidence } from "./export-evidence";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function validCounts(counts: AuthoringEffectCounts): void {
  for (const count of [counts.providerCalls, counts.toolEffects])
    check(Number.isSafeInteger(count) && count >= 0, "Effect counts must be nonnegative integers");
}

export function assertAuthoringEffectsUnchanged(
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  validCounts(before);
  validCounts(after);
  check(
    before.providerCalls === after.providerCalls && before.toolEffects === after.toolEffects,
    "Provider or actual tool effects changed",
  );
}

export function assertAuthoringDenial(
  response: ApplicationResponse,
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  check(response.status === 401 || response.status === 403, "Unauthorized request was not denied");
  assertAuthoringEffectsUnchanged(before, after);
}

export function assertAuthoringReplay(
  original: ApplicationResponse,
  replay: ApplicationResponse,
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  check(original.status === 200 && replay.status === 200, "Replay response was not successful");
  check(
    applicationHash(original.body) === applicationHash(replay.body),
    "Replay changed the stream",
  );
  assertAuthoringEffectsUnchanged(before, after);
}

/** Exact edit contracts make drift fail before the harness mutates owned source. */
export function assertGeneratedRecipeSources(options: {
  repoRoot: string;
  consumer: string;
  recipe: GeneratedApplicationRecipe;
}): void {
  const { recipe } = options;
  check(
    recipe.schemaVersion === 1 && recipe.entrypoint === "src/index.ts",
    "Unknown authoring recipe",
  );
  snapshotGeneratedAuthoringSources({ ...options, sourceFiles: recipe.sourceFiles });
  const expected = { startup: "src/index.ts", http: "src/http.ts", turn: "src/turn.ts" };
  for (const kind of ["startup", "http", "turn"] as const) {
    const edit = recipe.edits[kind];
    check(edit.path === expected[kind], "Sensitivity edit targets the wrong owned source");
    check(
      edit.before.length > 0 &&
        edit.before.length <= AUTHORING_BOUNDS.editCharacters &&
        edit.after.length <= AUTHORING_BOUNDS.editCharacters &&
        edit.before !== edit.after,
      "Sensitivity edit needs bounded distinct source",
    );
    const source = readAuthoringSource(options.consumer, edit.path).toString("utf8");
    check(source.split(edit.before).length === 2, "Sensitivity anchor must occur exactly once");
    if (kind === "turn") {
      const prepare = source.indexOf("await turn.preparePrompt()");
      const terminal = source.indexOf('if (prepared.kind === "terminal")', prepare);
      const anchor = source.indexOf(edit.before);
      const stop = edit.after.indexOf('return turn.stop("application-limit");');
      const loop = edit.after.indexOf("while (turn.remainingInferences > 0)");
      check(
        prepare >= 0 &&
          terminal > prepare &&
          anchor > terminal &&
          edit.before.includes("while (turn.remainingInferences > 0)") &&
          stop >= 0 &&
          loop > stop,
        "Turn sensitivity stop must follow prepared terminal check and precede the loop",
      );
    }
  }
}

/** Public stream + real provider counts + independent tool effects, without invented traces. */
export function assertGeneratedApplicationTurn(options: {
  response: ApplicationResponse;
  threadId: string;
  provider: ProviderFixtureEvidence;
  toolEffects: number;
  mode: "lookup" | "application-stop" | "answer-only";
  toolName: string;
  expectedOutput: string;
  expectedFinalText: string;
}): { publicRunId: string; threadId: string; bodySHA256: string } {
  const { response, provider } = options;
  validCounts({ providerCalls: provider.calls, toolEffects: options.toolEffects });
  const events = parseApplicationStream(response.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const finishes = events.filter((event) => event.type === "RUN_FINISHED");
  check(
    response.status === 200 &&
      starts.length === 1 &&
      finishes.length === 1 &&
      events.at(-1) === finishes[0] &&
      !events.some((event) => event.type === "RUN_ERROR"),
    "Generated application lacks a successful terminal stream",
  );
  const runId = starts[0]!.runId;
  check(
    typeof runId === "string" &&
      runId.length > 0 &&
      runId === finishes[0]!.runId &&
      options.threadId.length > 0 &&
      starts[0]!.threadId === options.threadId &&
      finishes[0]!.threadId === options.threadId &&
      (finishes[0]!.result as { status?: string } | undefined)?.status === "completed",
    "Generated stream identity or completion status disagrees",
  );
  const tools = events.filter((event) => event.type === "TOOL_CALL_START");
  const results = events.filter((event) => event.type === "TOOL_CALL_RESULT");
  if (options.mode === "application-stop") {
    check(
      provider.calls === 0 &&
        provider.toolRequests === 0 &&
        provider.validatedToolResults === 0 &&
        provider.finalResponses === 0 &&
        provider.rejectedRequests === 0 &&
        options.toolEffects === 0 &&
        !events.some((event) => String(event.type).startsWith("TOOL_CALL_")),
      "Stopped local turn performed provider or tool work",
    );
  } else if (options.mode === "answer-only") {
    check(
      provider.scenario === "answer-only" &&
        provider.calls === 1 &&
        provider.toolRequests === 0 &&
        provider.validatedToolResults === 0 &&
        provider.finalResponses === 1 &&
        provider.rejectedRequests === 0 &&
        options.toolEffects === 0 &&
        tools.length === 0 &&
        results.length === 0,
      "Untouched application did not produce exactly one direct answer",
    );
    check(
      events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("")
        .includes(PROVIDER_FIXTURE_ANSWER_TEXT),
      "Untouched answer marker is missing",
    );
  } else {
    check(options.mode === "lookup", "Unknown generated turn observation mode");
    check(
      provider.scenario === "success" &&
        provider.calls === 2 &&
        provider.toolRequests === 1 &&
        provider.validatedToolResults === 1 &&
        provider.finalResponses === 1 &&
        provider.rejectedRequests === 0 &&
        options.toolEffects === 1,
      "Provider and tool counts do not prove a real lookup roundtrip",
    );
    check(
      tools.length === 1 &&
        results.length === 1 &&
        tools[0]!.toolCallName === options.toolName &&
        typeof tools[0]!.toolCallId === "string" &&
        tools[0]!.toolCallId !== "" &&
        tools[0]!.toolCallId === results[0]!.toolCallId &&
        options.expectedOutput.length > 0 &&
        results[0]!.content === options.expectedOutput,
      "Public tool result does not match the actual lookup",
    );
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    check(
      options.expectedFinalText.length > 0 && text.includes(options.expectedFinalText),
      "Final answer marker is missing",
    );
  }
  return {
    publicRunId: runId,
    threadId: options.threadId,
    bodySHA256: applicationHash(response.body),
  };
}

export const AUTHORING_SAMPLE_OUTPUT = JSON.stringify({
  id: "SAMPLE-001",
  status: "ready",
  label: "Example record",
});

export function assertGeneratedApplicationFailure(options: {
  response: ApplicationResponse;
  threadId: string;
  provider: ProviderFixtureEvidence;
  toolEffects: number;
  scenario: "invalid-tool-arguments" | "provider-failure";
}): void {
  const { response, provider, scenario } = options;
  const events = parseApplicationStream(response.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const finishes = events.filter((event) => event.type === "RUN_FINISHED");
  const failed = scenario === "provider-failure";
  check(
    response.status === 200 &&
      starts.length === 1 &&
      finishes.length === 1 &&
      events.at(-1) === finishes[0] &&
      typeof starts[0]!.runId === "string" &&
      starts[0]!.runId === finishes[0]!.runId &&
      starts[0]!.threadId === options.threadId &&
      finishes[0]!.threadId === options.threadId &&
      (finishes[0]!.result as { status?: string } | undefined)?.status ===
        (failed ? "failed" : "completed") &&
      events.some((event) => event.type === "RUN_ERROR") === failed,
    "Failure path lost its correlated terminal classification",
  );
  check(
    options.toolEffects === 0 && !events.some((event) => event.type === "TOOL_CALL_START"),
    "Failure path executed the business tool",
  );
  check(
    provider.scenario === scenario &&
      provider.calls === (failed ? 1 : 2) &&
      provider.toolRequests === (failed ? 0 : 1) &&
      provider.validatedToolResults === (failed ? 0 : 1) &&
      provider.finalResponses === (failed ? 0 : 1) &&
      provider.rejectedRequests === (failed ? 1 : 0),
    "Failure provider counts do not prove the expected adapter path",
  );
}

function requiresRejectedObservation(observe: () => void): void {
  let rejected = false;
  try {
    observe();
  } catch {
    rejected = true;
  }
  check(rejected, "Negative observation unexpectedly passed");
}
export const AUTHORING_EDITED_OUTPUT = JSON.stringify({
  id: "SAMPLE-001",
  status: "ready",
  label: "Authoring edited record",
});

/** Static replacements are source reviewed; process inputs never become generated JavaScript. */
export function generatedApplicationRecipe(
  sourceFiles: readonly string[],
): GeneratedApplicationRecipe {
  return {
    schemaVersion: 1,
    entrypoint: "src/index.ts",
    sourceFiles,
    capability: {
      slug: "authoring-record",
      tool: {
        name: "authoring_record_lookup_record",
        input: { id: "SAMPLE-001" },
        invalidInput: { id: 17 },
      },
      expectedOutput: AUTHORING_EDITED_OUTPUT,
      route: "/authoring-record/records/SAMPLE-001",
      toolJournal: "data/authoring/tool-effects.jsonl",
    },
    edits: {
      startup: {
        path: "src/index.ts",
        before: "  const host = launch.createHost({ compose: composeAgent });",
        after:
          '  throw new Error("authoring-startup-rejected");\n  const host = launch.createHost({ compose: composeAgent });',
      },
      http: {
        path: "src/http.ts",
        before: "          return response;",
        after:
          '          const headers = new Headers(response.headers);\n          headers.set("x-authoring-edit", "owned-http-handler");\n          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
      },
      turn: {
        path: "src/turn.ts",
        before: "    while (turn.remainingInferences > 0) {",
        after:
          '    return turn.stop("application-limit");\n    while (turn.remainingInferences > 0) {',
      },
    },
    observations: {
      startupRejection: "authoring-startup-rejected",
      httpHeader: { name: "x-authoring-edit", value: "owned-http-handler" },
      baselineProviderCalls: 2,
      baselineToolEffects: 1,
      stoppedProviderCalls: 0,
      stoppedToolEffects: 0,
    },
  };
}

export function assertAuthoringHeader(
  response: ApplicationResponse,
  expected: { name: string; value: string },
): void {
  check(response.headers[expected.name] === expected.value, "Owned HTTP edit marker is missing");
}

export function assertAuthoringStartupRejection(
  result: Awaited<ReturnType<typeof runBoundedAuthoringCli>>,
  marker: string,
): void {
  check(
    marker.length > 0 &&
      `${result.stdout}\n${result.stderr}`.includes(marker) &&
      result.exitCode !== null &&
      result.exitCode !== 0 &&
      !result.timedOut &&
      !result.exceededOutput &&
      !result.spawnFailed &&
      !result.orphanedGroup &&
      result.cleanupConfirmed,
    "Startup edit did not reject cleanly with its exact marker",
  );
}

/** Real generated source runs here; reference-only traces and counters are deliberately absent. */
export async function runGeneratedApplication(
  options: GeneratedApplicationRunOptions,
): Promise<void> {
  const { consumer, sourceFiles } = options.consumer;
  const { recipe } = options;
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  mkdirSync(options.temporaryDirectory, { recursive: true, mode: 0o700 });
  assertGeneratedRecipeSources({ repoRoot: options.repoRoot, consumer, recipe });
  const local = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.core,
    "auggy/cli",
  );
  const runtime = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.core,
    "auggy/application",
  );
  const external = assertInstalledApplicationArtifact(
    options.global.consumer,
    options.repoRoot,
    options.global.core,
    "auggy/cli",
  );
  assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.consumer.provider,
    "@auggy/anthropic",
  );
  check(
    options.global.core.sha256 !== options.consumer.core.sha256 &&
      external.packageRoot !== local.packageRoot,
    "Launch parity needs distinct actual global/local artifacts",
  );
  const configPath = join(consumer, "agent.yaml");
  const originalConfig = readAuthoringSource(consumer, "agent.yaml");
  let restoreConfig = originalConfig;
  const config = parse(originalConfig.toString("utf8"));
  check(config && Array.isArray(config.augments), "Generated configuration lacks inline augments");
  const web = config.augments.find((entry: { type?: string }) => entry.type === "webTransport");
  check(
    web?.options && config.engine?.provider === "anthropic",
    "Generated Anthropic HTTP application required",
  );
  const originalEngine = structuredClone(config.engine);
  const originalWebOptions = structuredClone(web.options);
  const initial = snapshotGeneratedAuthoringSources({
    repoRoot: options.repoRoot,
    consumer,
    sourceFiles,
  });
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const baseURL = `http://127.0.0.1:${port}`;
  const bearer = randomBytes(32).toString("hex");
  const secrets = [bearer, PROVIDER_FIXTURE_API_KEY];
  const env = applicationEnvironment(options.home, options.temporaryDirectory, {
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: bearer,
    AUGGY_PUBLIC_URL: baseURL,
  });
  const provider = createProviderFixture({
    tool: recipe.capability.tool,
    toolResultSentinel: "SAMPLE-001",
    scenario: "answer-only",
  });
  const http = applicationHttp(baseURL, bearer);
  const paths = [
    { name: "direct", command: [process.execPath, recipe.entrypoint] },
    { name: "local-run", command: [process.execPath, local.entry, "run", "--no-open"] },
    { name: "local-dev", command: [process.execPath, local.entry, "dev"] },
    { name: "global-run", command: [process.execPath, external.entry, "run", "--no-open"] },
    { name: "global-dev", command: [process.execPath, external.entry, "dev"] },
  ];
  const owned = new Set<ReturnType<typeof startApplicationChild>>();
  const scenarios: Record<string, unknown> = {};
  const lifecycle: object[] = [];
  let state = "failed";
  let child: ReturnType<typeof startApplicationChild> | undefined;
  const abort = new AbortController();
  const interrupt = () => {
    abort.abort(new Error("Authoring acceptance interrupted"));
    for (const process of owned) process.signal("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const write = (file: string, value: unknown) =>
    writeFileSync(
      join(options.evidenceDirectory, file),
      `${redactEvidence(JSON.stringify(value, null, 2), secrets)}\n`,
      { mode: 0o600 },
    );
  const effects = () => readApplicationJsonLines(consumer, recipe.capability.toolJournal);
  const counts = () => ({
    providerCalls: provider.evidence().calls,
    toolEffects: effects().length,
  });
  const start = async (path: (typeof paths)[number]) => {
    check(!child, "Previous application process is still owned");
    abort.signal.throwIfAborted();
    const before = counts();
    child = startApplicationChild({ command: path.command, cwd: consumer, env, secrets });
    owned.add(child);
    await waitForApplicationReady(child, http, abort.signal);
    assertAuthoringEffectsUnchanged(before, counts());
    lifecycle.push({ event: "ready", path: path.name, pid: child.pid });
  };
  const stop = async () => {
    if (!child) return;
    const current = child;
    const result = await current.stop("SIGTERM");
    if (result.cleanupConfirmed) {
      owned.delete(current);
      child = undefined;
    }
    lifecycle.push({ event: "stopped", ...result });
    check(
      result.cleanupConfirmed &&
        !result.forced &&
        !result.timedOut &&
        !result.exceededOutput &&
        !result.spawnFailed &&
        !result.orphanedGroup &&
        result.exitCode === 0,
      "Generated process failed graceful group cleanup",
    );
  };
  const stopped = async <T>(use: () => Promise<T>): Promise<T> => {
    let value: T | undefined;
    const failures: unknown[] = [];
    try {
      value = await use();
    } catch (error) {
      failures.push(error);
    }
    try {
      await stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "Generated application scenario or cleanup failed");
    return value as T;
  };
  const request = (
    threadId: string,
    key: string,
    auth: "valid" | "missing" | "invalid" = "valid",
  ) =>
    http.request("/agent/run", {
      method: "POST",
      auth,
      idempotencyKey: key,
      signal: abort.signal,
      json: {
        threadId,
        messages: [{ role: "user", content: "Look up sample record SAMPLE-001." }],
      },
    });
  const turn = async (
    label: string,
    mode: "lookup" | "application-stop" | "answer-only",
    output = recipe.capability.expectedOutput,
  ) => {
    provider.setScenario(mode === "answer-only" ? "answer-only" : "success");
    const threadId = `authoring-${randomUUID()}`,
      key = randomUUID();
    const before = effects().length;
    const response = await request(threadId, key);
    const actual = effects().slice(before);
    for (const effect of actual)
      check(
        effect.kind === "tool" &&
          effect.thread === applicationThreadRef(threadId) &&
          typeof effect.turn === "string" &&
          effect.turn.length > 0 &&
          effect.output === applicationHash(output),
        "Independent tool journal did not correlate with this request/result",
      );
    const proof = assertGeneratedApplicationTurn({
      response,
      threadId,
      provider: provider.evidence(),
      toolEffects: actual.length,
      mode,
      toolName: recipe.capability.tool.name,
      expectedOutput: output,
      expectedFinalText: PROVIDER_FIXTURE_FINAL_TEXT,
    });
    scenarios[label] = {
      status: "passed",
      ...proof,
      provider: provider.evidence(),
      toolEffects: actual.length,
    };
    return { response, threadId, key };
  };
  const deny = async (header = false) => {
    for (const auth of ["missing", "invalid"] as const) {
      const before = counts();
      const response = await request(`denial-${randomUUID()}`, randomUUID(), auth);
      assertAuthoringDenial(response, before, counts());
      if (header) assertAuthoringHeader(response, recipe.observations.httpHeader);
    }
  };
  const snapshot = (files = sourceFiles) =>
    snapshotGeneratedAuthoringSources({ repoRoot: options.repoRoot, consumer, sourceFiles: files });
  const failures: unknown[] = [];
  try {
    config.engine = {
      ...config.engine,
      baseURL: provider.baseURL,
      model: "claude-authoring-fixture",
      maxContextTokens: 32000,
      maxTokens: 256,
      requestTimeoutMs: 5000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    web.options.port = port;
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    write("configuration-mutations.json", {
      fields: [
        "engine.baseURL",
        "engine.model",
        "engine.maxContextTokens",
        "engine.maxTokens",
        "engine.requestTimeoutMs",
        "engine.costOverride",
        "augments[webTransport].options.port",
      ],
      envNames: Object.keys(env).filter(
        (name) => name.startsWith("AUGGY_") || name === "ANTHROPIC_API_KEY",
      ),
      originalSHA256: applicationHash(originalConfig),
      fixtureSHA256: applicationHash(readFileSync(configPath)),
    });
    assertOnlyApplicationEdits(initial, snapshot(), ["agent.yaml"]);
    await stopped(async () => {
      await start(paths[0]!);
      await turn("untouched-answer", "answer-only");
    });
    // First prove the ordinary loopback default, then exercise closed authentication.
    web.options.allowAnonymous = false;
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    write("authentication-policy-mutation.json", {
      phase: "after-untouched-answer",
      field: "augments[webTransport].options.allowAnonymous",
      before: originalWebOptions.allowAnonymous ?? null,
      after: false,
    });
    const created = await runBoundedAuthoringCli({
      entry: local.entry,
      args: ["augment", "create", recipe.capability.slug, "--with-skill"],
      cwd: consumer,
      workspace: join(options.home, ".."),
    });
    write("augment-create.json", created);
    assertAuthoringCommandSucceeded(created);
    const afterAuthoring = snapshot();
    assertOnlyApplicationEdits(initial, afterAuthoring, ["agent.yaml", ".gitignore"]);
    write("authoring-command-mutations.json", {
      before: initial,
      after: afterAuthoring,
      allowed: ["agent.yaml", ".gitignore"],
      reason: "CLI registers the custom augment and bootstraps private receipt ignores",
    });
    const adoptedConfig = parse(readFileSync(configPath, "utf8"));
    adoptedConfig.engine = originalEngine;
    adoptedConfig.augments.find(
      (entry: { type?: string }) => entry.type === "webTransport",
    ).options = originalWebOptions;
    restoreConfig = Buffer.from(stringify(adoptedConfig));
    await runAuthoringBuild({
      workspace: join(options.home, ".."),
      consumer,
      evidenceDirectory: options.evidenceDirectory,
      label: "custom-tests",
      command: [process.execPath, "run", "test"],
    });
    await runAuthoringBuild({
      workspace: join(options.home, ".."),
      consumer,
      evidenceDirectory: options.evidenceDirectory,
      label: "custom-typecheck",
      command: [process.execPath, "run", "typecheck"],
    });
    const custom = `src/augments/${recipe.capability.slug}`;
    const customFiles = [
      ...sourceFiles,
      `${custom}/index.ts`,
      `${custom}/schemas.ts`,
      `${custom}/service.ts`,
      `${custom}/README.md`,
      `tests/augments/${recipe.capability.slug}.test.ts`,
      `skills/${recipe.capability.slug}/SKILL.md`,
    ];
    const beforeJournal = snapshot(customFiles);
    const journal = readFileSync(
      join(options.repoRoot, "tests/fixtures/authoring/tool-journal.ts.txt"),
    );
    check(journal.byteLength <= 16384, "Static fixture exceeded bound");
    writeFileSync(join(consumer, custom, "journal.ts"), journal, { mode: 0o600, flag: "wx" });
    const index = readAuthoringSource(consumer, `${custom}/index.ts`).toString("utf8");
    const anchor = "          const record = lookupRecord(parsed.data);";
    check(index.split(anchor).length === 2, "Generated tool journal adapter anchor changed");
    writeFileSync(
      join(consumer, custom, "index.ts"),
      'import { recordToolEffect } from "./journal";\n' +
        index.replace(anchor, `${anchor}\n          recordToolEffect(context, record);`),
    );
    const afterJournal = snapshot(customFiles);
    assertOnlyApplicationEdits(beforeJournal, afterJournal, [`${custom}/index.ts`]);
    write("custom-fixture-mutations.json", {
      before: beforeJournal,
      after: afterJournal,
      added: { [`${custom}/journal.ts`]: applicationHash(journal) },
    });
    await stopped(async () => {
      await start(paths[0]!);
      const route = await http.request(recipe.capability.route);
      check(
        route.status === 200 && route.body === AUTHORING_SAMPLE_OUTPUT,
        "Generated shared service route result changed",
      );
      await turn("generated-tool", "lookup", AUTHORING_SAMPLE_OUTPUT);
      for (const scenario of ["invalid-tool-arguments", "provider-failure"] as const) {
        provider.setScenario(scenario);
        const threadId = `authoring-failure-${randomUUID()}`;
        const before = effects().length;
        const response = await request(threadId, randomUUID());
        assertGeneratedApplicationFailure({
          response,
          threadId,
          scenario,
          provider: provider.evidence(),
          toolEffects: effects().length - before,
        });
        scenarios[scenario] = {
          status: "passed",
          provider: provider.evidence(),
          bodySHA256: applicationHash(response.body),
          toolEffects: effects().length - before,
        };
      }
      for (const [path, status] of [
        [`/${recipe.capability.slug}/records/invalid`, 400],
        [`/${recipe.capability.slug}/records/SAMPLE-999`, 404],
      ] as const)
        check(
          (await http.request(path)).status === status,
          "Generated route validation or missing-record behavior failed",
        );
      const before = counts();
      assertAuthoringDenial(
        await http.request(recipe.capability.route, { auth: "missing" }),
        before,
        counts(),
      );
    });
    const serviceEdit = {
      path: `${custom}/service.ts`,
      before: '  label: "Example record",',
      after: '  label: "Authoring edited record",',
    };
    await withApplicationEdit(
      consumer,
      serviceEdit,
      async () => {
        const baseline = snapshot(customFiles);
        write("shared-service-edit.json", {
          file: serviceEdit.path,
          before: afterJournal[serviceEdit.path],
          after: baseline[serviceEdit.path],
        });
        for (const path of paths) {
          const original = await stopped(async () => {
            await start(path);
            const success = await turn(`${path.name}/baseline`, "lookup");
            requiresRejectedObservation(() =>
              assertAuthoringHeader(success.response, recipe.observations.httpHeader),
            );
            scenarios[`${path.name}/unchanged-http-control`] = { status: "passed", rejected: true };
            check(
              (await http.request(recipe.capability.route)).body ===
                recipe.capability.expectedOutput,
              "Shared service edit did not reach route",
            );
            await deny();
            const before = counts();
            assertAuthoringReplay(
              success.response,
              await request(success.threadId, success.key),
              before,
              counts(),
            );
            return success;
          });
          await stopped(async () => {
            await start(path);
            const before = counts();
            assertAuthoringReplay(
              original.response,
              await request(original.threadId, original.key),
              before,
              counts(),
            );
          });
          for (const kind of ["startup", "http", "turn"] as const) {
            await withApplicationEdit(
              consumer,
              recipe.edits[kind],
              async () => {
                const edited = snapshot(customFiles);
                assertOnlyApplicationEdits(baseline, edited, [recipe.edits[kind].path]);
                if (kind === "startup") {
                  const before = counts();
                  const process = startApplicationChild({
                    command: path.command,
                    cwd: consumer,
                    env,
                    secrets,
                  });
                  owned.add(process);
                  const result = await process.finish();
                  if (result.cleanupConfirmed) owned.delete(process);
                  assertAuthoringStartupRejection(result, recipe.observations.startupRejection);
                  requiresRejectedObservation(() =>
                    assertAuthoringStartupRejection(result, "wrong-authoring-startup-marker"),
                  );
                  scenarios[`${path.name}/wrong-startup-marker-control`] = {
                    status: "passed",
                    rejected: true,
                  };
                  assertAuthoringEffectsUnchanged(before, counts());
                  scenarios[`${path.name}/startup-edit`] = {
                    status: "passed",
                    result,
                    hashes: edited,
                  };
                } else
                  await stopped(async () => {
                    await start(path);
                    const result = await turn(
                      `${path.name}/${kind}-edit`,
                      kind === "turn" ? "application-stop" : "lookup",
                    );
                    if (kind === "http") {
                      assertAuthoringHeader(result.response, recipe.observations.httpHeader);
                      await deny(true);
                    }
                    scenarios[`${path.name}/${kind}-hashes`] = edited;
                  });
              },
              () => owned.size === 0,
            );
            assertOnlyApplicationEdits(baseline, snapshot(customFiles), []);
            await stopped(async () => {
              await start(path);
              await turn(`${path.name}/${kind}-restored`, "lookup");
            });
          }
        }
      },
      () => owned.size === 0,
    );
    assertOnlyApplicationEdits(afterAuthoring, snapshot(), []);
    check(
      applicationHash(readFileSync(join(consumer, "bun.lock"))) === options.consumer.lockSHA256,
      "Execution changed dependency lock",
    );
    state = "passed";
  } catch (error) {
    failures.push(error);
  } finally {
    for (const process of owned) {
      try {
        const result = await process.stop("SIGTERM");
        if (result.cleanupConfirmed) owned.delete(process);
        else failures.push(new Error("Child cleanup unconfirmed"));
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (owned.size === 0) writeFileSync(configPath, restoreConfig, { mode: 0o600 });
    } catch (error) {
      failures.push(error);
    }
    try {
      await provider.stop();
    } catch (error) {
      failures.push(error);
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    write("application.json", {
      state: failures.length ? "failed" : state,
      cleanup: owned.size ? "unconfirmed" : "confirmed",
      scenarios,
      lifecycle,
      local,
      runtime,
      external,
      globalSelection:
        options.global.core.version === options.consumer.core.version
          ? "same-version-artifact-experiment"
          : "distinct-version-artifact-selection",
    });
  }
  if (failures.length)
    throw new AggregateError(failures, "Authoring application or cleanup failed");
}

/** Actual installed-reference acceptance. Call only after the reference producer is accepted. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
  APPLICATION_ROWS,
  applicationEnvironment,
  applicationHash,
  assertApplicationCapability,
  assertApplicationDenial,
  assertApplicationReplay,
  assertApplicationTurn,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  parseApplicationStream,
  snapshotApplicationFiles,
  startApplicationChild,
  withApplicationEdit,
  type ApplicationRecipe,
  type PackedArtifactEvidence,
} from "./application-consumer";
import { applicationHttp, waitForApplicationReady } from "./application-http";
import { correlateApplicationTurn, readApplicationRecords } from "./application-records";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
} from "./provider-fixture";
import { redactEvidence } from "./export-evidence";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface InstalledApplicationOptions {
  repoRoot: string;
  consumer: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  recipe: ApplicationRecipe;
  core: PackedArtifactEvidence;
  provider: PackedArtifactEvidence;
  global: { consumer: string; core: PackedArtifactEvidence };
  expectedToolOutput: string;
}

export async function runInstalledApplication(options: InstalledApplicationOptions): Promise<void> {
  const consumer = realpathSync(options.consumer);
  const repoRoot = realpathSync(options.repoRoot);
  const evidenceDirectory = resolve(options.evidenceDirectory);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  assertApplicationCapability(options.core.manifest);
  assertApplicationCapability(options.global.core.manifest);
  const local = assertInstalledApplicationArtifact(consumer, repoRoot, options.core, "auggy/cli");
  const selectedApplication = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.core,
    "auggy/application",
  );
  const selectedProvider = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.provider,
    "@auggy/anthropic",
  );
  const external = assertInstalledApplicationArtifact(
    options.global.consumer,
    repoRoot,
    options.global.core,
    "auggy/cli",
  );
  check(
    external.packageRoot !== local.packageRoot,
    "Global and local launchers must be separate installations",
  );
  check(
    options.global.core.sha256 !== options.core.sha256 &&
      options.global.core.version === options.core.version,
    "Application selection acceptance requires distinct actual same-version core artifacts",
  );
  const lockPath = join(consumer, "bun.lock");
  check(
    existsSync(lockPath),
    "Packed application must be installed with a retained frozen lock first",
  );
  const lockSHA256 = applicationHash(readFileSync(lockPath));
  const original = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
  check(
    options.recipe.sourceFiles.includes(options.recipe.entrypoint),
    "Reference entrypoint is not in the source allowlist",
  );
  const configPath = join(consumer, "agent.yaml");
  const originalConfig = readFileSync(configPath);
  const config: unknown = parse(originalConfig.toString("utf8"));
  check(object(config), "Reference configuration must be a mapping");
  // Equivalent to the documented first-run setup, isolated to this copied project.
  if (config.id === "${AUGGY_AGENT_ID}") config.id = `aug1_${randomUUID()}`;
  check(
    typeof config.id === "string" &&
      /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.id) &&
      Array.isArray(config.augments),
    "Reference must declare an immutable identity and inline augments",
  );
  const agentId = config.id;
  const web = config.augments.filter((item) => object(item) && item.type === "webTransport");
  check(
    web.length === 1 && object(web[0]) && object(web[0].options),
    "Reference requires one explicit inline webTransport config",
  );
  const bearer = randomBytes(32).toString("hex");
  const secrets = [bearer, PROVIDER_FIXTURE_API_KEY];
  const portReservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = portReservation.port;
  await portReservation.stop(true);
  const baseURL = `http://127.0.0.1:${port}`;
  const env = applicationEnvironment(options.home, options.temporaryDirectory, {
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: bearer,
    AUGGY_PUBLIC_URL: baseURL,
  });
  const provider = createProviderFixture({
    tool: options.recipe.tool,
    toolResultSentinel: options.expectedToolOutput,
  });
  const abort = new AbortController();
  let child: ReturnType<typeof startApplicationChild> | undefined;
  const ownedChildren = new Set<ReturnType<typeof startApplicationChild>>();
  const launchChild = (command: readonly string[]) => {
    const process = startApplicationChild({ command, cwd: consumer, env, secrets });
    ownedChildren.add(process);
    return process;
  };
  const executeCommand = async (command: readonly string[]) => {
    const process = launchChild(command);
    const result = await process.finish();
    if (result.cleanupConfirmed) ownedChildren.delete(process);
    return result;
  };
  let childLabel = "";
  let generation = 0;
  let http = applicationHttp(baseURL, bearer);
  const scenarios: Record<string, unknown> = {};
  let state: "running" | "passed" | "failed" = "running";
  const cleanupErrors: string[] = [];
  const lifecycle: Record<string, unknown>[] = [];
  const pendingRows = new Set<string>(APPLICATION_ROWS);
  const write = (file: string, value: unknown) => {
    const temporary = join(evidenceDirectory, `.${file}-${randomUUID()}.tmp`);
    const failures: unknown[] = [];
    try {
      writeFileSync(temporary, `${redactEvidence(JSON.stringify(value, null, 2), secrets)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, join(evidenceDirectory, file));
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(temporary, { force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Application evidence write failed");
  };
  const progress = () =>
    write("application-scenarios.json", {
      phase: "actual-packed-execution",
      state,
      cleanup: ownedChildren.size ? "unconfirmed" : "confirmed",
      retainedPids: [...ownedChildren].map((process) => process.pid ?? null),
      cleanupErrors,
      scenarios,
      lifecycle,
      pendingRows: [...pendingRows],
    });
  const records = () => readApplicationRecords(consumer, options.recipe);
  const counters = () => {
    const current = records();
    return [
      provider.evidence().calls,
      current.turns.length,
      current.finalization.length,
      current.tools.length,
    ];
  };
  const onSignal = () => {
    abort.abort(new Error("Application acceptance interrupted"));
    for (const process of ownedChildren) process.signal("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const stop = async (signal: "SIGINT" | "SIGTERM" = "SIGTERM") => {
    if (!child) return;
    const current = child;
    const result = await current.stop(signal);
    if (result.cleanupConfirmed) {
      ownedChildren.delete(current);
      child = undefined;
    }
    write(`child-${generation}.json`, { label: childLabel, ...result });
    lifecycle.push({
      event: "stopped",
      generation,
      label: childLabel,
      signal,
      exitCode: result.exitCode,
      forced: result.forced,
      orphanedGroup: result.orphanedGroup,
    });
    check(
      result.cleanupConfirmed &&
        !result.forced &&
        !result.timedOut &&
        !result.spawnFailed &&
        !result.exceededOutput &&
        !result.orphanedGroup &&
        result.exitCode === 0,
      "Installed application did not cleanly release its owned process group",
    );
  };
  const withStoppedChild = async <T>(use: () => Promise<T>): Promise<T> => {
    let value: T | undefined;
    let primary: { error: unknown } | undefined;
    try {
      value = await use();
    } catch (error) {
      primary = { error };
    }
    try {
      await stop();
    } catch (error) {
      if (primary)
        throw new AggregateError(
          [primary.error, error],
          "Scenario failed and child cleanup also failed",
        );
      throw error;
    }
    if (primary) throw primary.error;
    return value as T;
  };
  const paths = [
    {
      name: "direct",
      command: [process.execPath, options.recipe.entrypoint],
      mode: "direct",
      processEntry: realpathSync(join(consumer, options.recipe.entrypoint)),
    },
    {
      name: "local-run",
      command: [process.execPath, local.entry, "run", "--no-open"],
      mode: "foreground",
      processEntry: local.entry,
    },
    {
      name: "local-dev",
      command: [process.execPath, local.entry, "dev"],
      mode: "foreground",
      processEntry: local.entry,
    },
    {
      name: "global-run",
      command: [process.execPath, external.entry, "run", "--no-open"],
      mode: "foreground",
      processEntry: local.entry,
    },
    {
      name: "global-dev",
      command: [process.execPath, external.entry, "dev"],
      mode: "foreground",
      processEntry: local.entry,
    },
  ] as const;
  type Launch = (typeof paths)[number];
  const start = async (path: Launch, label = "inspectable-agent") => {
    abort.signal.throwIfAborted();
    const prior = records().startup.length;
    const priorWork = counters();
    generation++;
    childLabel = `${generation}-${path.name}`;
    http = applicationHttp(baseURL, bearer);
    child = launchChild(path.command);
    await waitForApplicationReady(child, http, abort.signal);
    const deadline = Date.now() + 5_000;
    while (records().startup.length === prior && Date.now() < deadline) await Bun.sleep(25);
    const startup = records().startup;
    check(startup.length === prior + 1, "Application main did not record exactly one startup");
    const ready = startup.at(-1)!;
    const asPath = (value: unknown) => {
      check(typeof value === "string", "Missing startup module provenance");
      return realpathSync(value.startsWith("file:") ? fileURLToPath(value) : value);
    };
    check(
      ready.event === "application.ready" &&
        ready.label === label &&
        ready.mode === path.mode &&
        asPath(ready.appSource) === realpathSync(join(consumer, options.recipe.entrypoint)) &&
        asPath(ready.processEntry) === path.processEntry &&
        asPath(ready.applicationModule) === selectedApplication.entry,
      "Actual startup did not use the selected project main/runtime",
    );
    check(
      Array.isArray(ready.bindings) &&
        ready.bindings.some((binding) => object(binding) && binding.port === port),
      "Application readiness did not include its actual listener",
    );
    check(
      JSON.stringify(counters()) === JSON.stringify(priorWork),
      "Application startup scheduled unexpected model/turn/tool work",
    );
    lifecycle.push({ event: "ready", generation, path: path.name, startup: ready });
    progress();
  };
  const request = async (
    threadId: string,
    key: string,
    auth: "valid" | "missing" | "invalid" = "valid",
  ) =>
    http.request("/agent/run", {
      method: "POST",
      auth,
      idempotencyKey: key,
      signal: abort.signal,
      json: { threadId, messages: [{ role: "user", content: options.recipe.userMessage }] },
    });
  const correlated = async (threadId: string, completion: boolean) => {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const result = correlateApplicationTurn({
          records: records(),
          threadId,
          toolName: options.recipe.tool.name,
          expectedToolOutput: options.expectedToolOutput,
        });
        if (!completion || result.trace) return result;
      } catch {
        /* Actual awaited hook records may arrive just after the public stream. */
      }
      check(Date.now() < deadline, "Actual application turn evidence did not settle");
      abort.signal.throwIfAborted();
      await Bun.sleep(25);
    }
  };
  const success = async (name: string, expectedCalls: 1 | 2 = 2, header = "inspectable-agent") => {
    provider.setScenario("success");
    const threadId = `application-${randomUUID()}`,
      key = randomUUID();
    const response = await request(threadId, key);
    check(
      response.headers["x-auggy-application"] === header,
      "Application HTTP edit is not on the real ingress path",
    );
    const result = await correlated(threadId, true);
    check(result.trace, "Real completed turn summary is missing");
    const proof = assertApplicationTurn({
      httpStatus: response.status,
      body: response.body,
      threadId,
      expectedCalls,
      toolName: options.recipe.tool.name,
      provider: provider.evidence(),
      trace: result.trace,
      finalization: result.finalization,
      toolExecutions: result.tools.length,
      history: "memory-only",
      ...(expectedCalls === 2 ? { expectedFinalText: PROVIDER_FIXTURE_FINAL_TEXT } : {}),
    });
    check(
      result.started.maxInferences === expectedCalls,
      "Actual selected turn program did not observe the application ceiling",
    );
    const usage = result.completed?.usage;
    check(
      object(usage) &&
        usage.inputTokens === expectedCalls * 11 &&
        usage.outputTokens === expectedCalls * 7 &&
        usage.costUsd === 0 &&
        usage.unpricedSteps === 0,
      "Actual usage does not match the real fixture response accounting",
    );
    check(
      result.finalization.trace.recordedInferenceSteps === expectedCalls &&
        result.finalization.trace.snapshot === "recorded",
      "Finalization lost the recorded inference trace",
    );
    scenarios[name] = {
      status: "passed",
      ...proof,
      provider: provider.evidence(),
      finalization: result.finalization,
      usage: result.completed?.usage,
      toolOutputSHA256: applicationHash(options.expectedToolOutput),
    };
    progress();
    return { response, threadId, key };
  };
  let failure: { error: unknown } | undefined;
  try {
    config.engine = {
      provider: "anthropic",
      model: "claude-application-acceptance",
      baseURL: provider.baseURL,
      maxContextTokens: 32_000,
      maxTokens: 256,
      requestTimeoutMs: 5_000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    web[0].options.port = port;
    web[0].options.auth = { type: "bearer", token: "${AUGGY_WEB_TOKEN}" };
    web[0].options.allowAnonymous = false;
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    const configuredSources = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
    write("application-provenance.json", {
      bun: Bun.version,
      consumer,
      local,
      selectedApplication,
      selectedProvider,
      external,
      originalSources: original,
      configuredSources,
      lockSHA256,
      recipeSHA256: applicationHash(JSON.stringify(options.recipe)),
    });
    for (const path of paths) {
      await start(path);
      await success(`launch-${path.name}`);
      await stop(path.name === "local-dev" ? "SIGINT" : "SIGTERM");
    }
    pendingRows.delete("L01-launch-parity");
    scenarios["same-version-artifact-selection"] = {
      status: "passed",
      global: options.global.core.sha256,
      local: options.core.sha256,
      remaining: "different compatible version subcase is owned by application compatibility gate",
    };
    for (const kind of ["startup", "http", "turn"] as const) {
      await withApplicationEdit(
        consumer,
        options.recipe.edits[kind],
        async () => {
          assertOnlyApplicationEdits(
            configuredSources,
            snapshotApplicationFiles(consumer, options.recipe.sourceFiles),
            [options.recipe.edits[kind].path],
          );
          for (const path of paths) {
            await withStoppedChild(async () => {
              await start(
                path,
                kind === "startup" ? "application-startup-edited" : "inspectable-agent",
              );
              await success(
                `edit-${kind}-${path.name}`,
                kind === "turn" ? 1 : 2,
                kind === "http" ? "application-http-edited" : "inspectable-agent",
              );
              if (kind === "http") {
                for (const auth of ["missing", "invalid"] as const) {
                  const before = counters();
                  const denied = await request(`edited-denial-${randomUUID()}`, randomUUID(), auth);
                  check(
                    denied.headers["x-auggy-application"] === "application-http-edited",
                    "Edited HTTP route did not handle its denied request",
                  );
                  assertApplicationDenial(denied.status, before, counters());
                }
              }
            });
          }
        },
        () => ownedChildren.size === 0,
      );
      check(
        applicationHash(readFileSync(lockPath)) === lockSHA256,
        "Application source edit changed the retained lock",
      );
    }
    pendingRows.delete("L02-startup-edit");
    pendingRows.delete("L03-http-edit");
    pendingRows.delete("L04-turn-edit");
    await start(paths[3]);
    const beforeRoute = counters();
    const order = await http.request("/example/orders/DEMO-1001");
    check(
      order.status === 200 &&
        applicationHash(JSON.stringify(JSON.parse(order.body))) ===
          applicationHash(options.expectedToolOutput),
      "Actual creator-only domain route did not use the reference service",
    );
    const deniedRoute = await http.request("/example/orders/DEMO-1001", { auth: "missing" });
    assertApplicationDenial(deniedRoute.status, beforeRoute, counters());
    scenarios["domain-route"] = { status: "passed", bodySHA256: applicationHash(order.body) };
    const replay = await success("replay-original");
    for (const auth of ["missing", "invalid"] as const) {
      const before = counters();
      const denial = await request(`denied-${randomUUID()}`, randomUUID(), auth);
      assertApplicationDenial(denial.status, before, counters());
      scenarios[`auth-${auth}`] = {
        status: "passed",
        httpStatus: denial.status,
        unchangedCounters: before,
      };
    }
    const beforeReplay = counters();
    const immediateReplay = await request(replay.threadId, replay.key);
    check(immediateReplay.status === 200, "Immediate replay did not return HTTP200");
    assertApplicationReplay(replay.response.body, immediateReplay.body, beforeReplay, counters());
    const beforeRestartReplay = counters();
    await stop();
    await start(paths[3]);
    check(
      JSON.stringify(counters()) === JSON.stringify(beforeRestartReplay),
      "Shutdown/startup repeated request work before replay",
    );
    const restartedReplay = await request(replay.threadId, replay.key);
    check(restartedReplay.status === 200, "Restart replay did not return HTTP200");
    assertApplicationReplay(
      replay.response.body,
      restartedReplay.body,
      beforeRestartReplay,
      counters(),
    );
    scenarios["durable-replay"] = {
      status: "passed",
      bodySHA256: applicationHash(restartedReplay.body),
      unchangedCounters: beforeRestartReplay,
    };
    for (const scenario of ["invalid-tool-arguments", "provider-failure"] as const) {
      provider.setScenario(scenario);
      const threadId = `failure-${randomUUID()}`;
      const response = await request(threadId, randomUUID());
      const events = parseApplicationStream(response.body);
      const result = await correlated(threadId, scenario === "invalid-tool-arguments");
      check(
        result.tools.length === 0 && !events.some((event) => event.type === "TOOL_CALL_START"),
        "Rejected/provider failure executed the real domain tool",
      );
      check(
        response.status === 200 &&
          events.filter((event) => event.type === "RUN_STARTED").length === 1 &&
          events.filter((event) => event.type === "RUN_FINISHED").length === 1 &&
          events.at(-1)?.type === "RUN_FINISHED",
        "Failure scenario lost its correlated terminal stream",
      );
      const streamStart = events.find((event) => event.type === "RUN_STARTED")!;
      const streamFinish = events.find((event) => event.type === "RUN_FINISHED")!;
      check(
        typeof streamStart.runId === "string" &&
          streamStart.runId === streamFinish.runId &&
          streamStart.threadId === threadId &&
          streamFinish.threadId === threadId &&
          object(streamFinish.result) &&
          streamFinish.result.status === result.finalization.status,
        "Failure terminal identity/status disagrees with the actual admitted turn",
      );
      check(
        events.some((event) => event.type === "RUN_ERROR") === (scenario === "provider-failure"),
        "Failure stream error classification disagrees with actual settlement",
      );
      const fixture = provider.evidence();
      const providerFailed = scenario === "provider-failure";
      check(
        fixture.scenario === scenario &&
          fixture.calls === (providerFailed ? 1 : 2) &&
          fixture.toolRequests === (providerFailed ? 0 : 1) &&
          fixture.validatedToolResults === (providerFailed ? 0 : 1) &&
          fixture.finalResponses === (providerFailed ? 0 : 1) &&
          fixture.rejectedRequests === (providerFailed ? 1 : 0) &&
          JSON.stringify(fixture.summaries.map(({ outcome, status }) => [outcome, status])) ===
            JSON.stringify(
              providerFailed
                ? [["provider-failure", 503]]
                : [
                    ["tool-request", 200],
                    ["verified-validation-error", 200],
                  ],
            ),
        "Failure fixture counts/outcomes do not match the expected real adapter path",
      );
      check(
        result.finalization.executionStarted &&
          result.finalization.sessionStarted &&
          !result.finalization.outcomeUnknown &&
          !result.finalization.pendingEffects &&
          result.finalization.history === "memory-only" &&
          result.finalization.outcome === (providerFailed ? "failed" : "completed") &&
          result.finalization.disposition === (providerFailed ? "threw" : "returned") &&
          result.finalization.trace.inferenceAttempts === (providerFailed ? 1 : 2) &&
          result.finalization.trace.recordedInferenceSteps === (providerFailed ? 0 : 2),
        "Failure scenario did not settle its supported finalization accurately",
      );
      if (scenario === "provider-failure")
        check(
          result.finalization.status === "failed" &&
            result.finalization.primaryFailureCode === "provider-failed",
          "Provider exception lost its actual failed settlement",
        );
      else
        check(
          result.finalization.status === "completed" &&
            result.finalization.primaryFailureCode === null &&
            result.finalization.trace.successfulToolCalls === 0,
          "Invalid tool arguments bypassed validation or lost recovery",
        );
      scenarios[scenario] = {
        status: "passed",
        provider: provider.evidence(),
        finalization: result.finalization,
        bodySHA256: applicationHash(response.body),
      };
    }
    const entry = join(consumer, options.recipe.entrypoint),
      savedEntry = `${entry}.acceptance-backup`;
    const modules = join(consumer, "node_modules"),
      savedModules = join(consumer, ".acceptance-node-modules");
    check(!existsSync(savedEntry) && !existsSync(savedModules), "Recovery backup already exists");
    const recoveryCounters = counters();
    const recoveryStartupCount = records().startup.length;
    renameSync(entry, savedEntry);
    try {
      await withStoppedChild(async () => {
        const restart = await executeCommand([
          process.execPath,
          external.entry,
          "restart",
          agentId,
          "--config",
          configPath,
        ]);
        check(
          restart.cleanupConfirmed &&
            !restart.orphanedGroup &&
            !restart.timedOut &&
            restart.exitCode === 1 &&
            (await http.request("/health")).status === 200,
          "Broken application restart stopped the existing runtime",
        );
        renameSync(modules, savedModules);
        const status = await executeCommand([process.execPath, external.entry, "status", agentId]);
        const stopped = await executeCommand([process.execPath, external.entry, "stop", agentId]);
        check(
          status.cleanupConfirmed &&
            stopped.cleanupConfirmed &&
            !status.orphanedGroup &&
            !stopped.orphanedGroup &&
            status.exitCode === 0 &&
            stopped.exitCode === 0 &&
            !status.timedOut &&
            !stopped.timedOut,
          "Global recovery required the broken application/dependencies",
        );
        write("application-recovery.json", { restart, status, stopped });
        const owned = child;
        check(owned, "Recovery lost the owned running process");
        const final = await owned.finish();
        if (final.cleanupConfirmed) {
          ownedChildren.delete(owned);
          child = undefined;
        }
        check(
          final.cleanupConfirmed && final.exitCode === 0 && !final.orphanedGroup && !final.timedOut,
          "Recovery did not stop the exact owned process group",
        );
        check(
          JSON.stringify(counters()) === JSON.stringify(recoveryCounters),
          "Recovery invoked new application turn work",
        );
        check(
          records().startup.length === recoveryStartupCount,
          "Recovery invoked application main",
        );
        scenarios.recovery = { status: "passed", exactAgentId: agentId };
        pendingRows.delete("L11-recovery");
      });
    } finally {
      if (ownedChildren.size === 0) {
        if (existsSync(savedModules)) renameSync(savedModules, modules);
        renameSync(savedEntry, entry);
      }
    }
    check(
      applicationHash(readFileSync(lockPath)) === lockSHA256,
      "Actual acceptance mutated the retained lock",
    );
    assertInstalledApplicationArtifact(consumer, repoRoot, options.core, "auggy/application");
    assertInstalledApplicationArtifact(consumer, repoRoot, options.provider, "@auggy/anthropic");
  } catch (error) {
    failure = { error };
  } finally {
    const note = (error: unknown) =>
      cleanupErrors.push(
        error instanceof Error ? error.message : "Cleanup/evidence operation failed",
      );
    try {
      try {
        await stop();
      } catch (error) {
        note(error);
      }
      try {
        await provider.stop();
      } catch (error) {
        note(error);
      }
      for (const process of ownedChildren) {
        try {
          const observed = await process.stop();
          if (observed.cleanupConfirmed) ownedChildren.delete(process);
        } catch (error) {
          note(error);
        }
      }
      if (ownedChildren.size)
        cleanupErrors.push(
          "Owned process cleanup is unconfirmed; copied application/configuration retained for diagnosis",
        );
      else {
        try {
          writeFileSync(configPath, originalConfig);
          check(
            JSON.stringify(snapshotApplicationFiles(consumer, options.recipe.sourceFiles)) ===
              JSON.stringify(original),
            "Application source was not restored after acceptance",
          );
        } catch (error) {
          note(error);
        }
      }
      state = failure || cleanupErrors.length ? "failed" : "passed";
      if (failure || cleanupErrors.length) {
        try {
          write("application-failure.json", {
            primary:
              failure?.error instanceof Error
                ? failure.error.message
                : failure
                  ? "Application acceptance failed"
                  : null,
            cleanupErrors,
          });
        } catch (error) {
          note(error);
        }
      }
      try {
        progress();
      } catch (error) {
        note(error);
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (failure && cleanupErrors.length === 0) throw failure.error;
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure.error] : []), ...cleanupErrors.map((message) => new Error(message))],
      "Application acceptance failed; cleanup/evidence failures were retained",
    );
}

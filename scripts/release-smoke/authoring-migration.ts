import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { MigrationReport } from "../../src/cli/authoring/migration";
import {
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  snapshotApplicationFiles,
  startApplicationChild,
  withApplicationEdit,
} from "./application-consumer";
import {
  applicationHttp,
  readApplicationJsonLines,
  waitForApplicationReady,
  type ApplicationResponse,
} from "./application-http";
import {
  assertAuthoringCommandSucceeded,
  readAuthoringSource,
  prepareAuthoringWorkspace,
  runAuthoringBuild,
  runBoundedAuthoringCli,
} from "./authoring-consumer";
import {
  assertAuthoringHeader,
  assertAuthoringReplay,
  assertGeneratedApplicationTurn,
  generatedApplicationRecipe,
} from "./authoring-application";
import type { GeneratedAuthoringConsumer, InstalledAuthoringCli } from "./authoring-contract";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_ANSWER_TEXT,
} from "./provider-fixture";
import { readBoundedRegularFile } from "./bounded-file";
import { redactEvidence } from "./export-evidence";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Metadata only: receipt contents can contain private preimages and are never read here. */
export function authoringPrivateMetadataDigest(consumer: string): string {
  const entries: object[] = [];
  const visit = (relative: string, depth: number) => {
    check(
      depth <= 5 && entries.length < 256,
      "Private authoring metadata inventory exceeded bound",
    );
    const stat = lstatSync(join(consumer, relative), { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    check(
      !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
      "Private authoring inventory contains a nonregular entry",
    );
    entries.push({
      path: relative,
      size: stat.size.toString(),
      mode: stat.mode.toString(),
      mtime: stat.mtimeNs.toString(),
      ctime: stat.ctimeNs.toString(),
    });
    if (stat.isDirectory()) {
      const names = readdirSync(join(consumer, relative)).sort();
      check(names.length <= 128, "Private authoring directory exceeded bound");
      for (const name of names) visit(join(relative, name), depth + 1);
    }
  };
  visit(".auggy", 0);
  return applicationHash(JSON.stringify(entries));
}

/** Holds one real adapter request so publication can cross a deterministic active turn. */
export function createAuthoringInferenceGate(upstream: string) {
  const target = new URL(upstream);
  check(
    target.protocol === "http:" &&
      target.hostname === "127.0.0.1" &&
      !target.username &&
      !target.password &&
      target.pathname === "/",
    "Inference gate requires a bare loopback fixture URL",
  );
  let pending: { entered: () => void; release: () => void; wait: Promise<void> } | undefined;
  let active: typeof pending;
  let calls = 0;
  const abort = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    error: () => new Response("Inference gate failed", { status: 503 }),
    async fetch(request) {
      check(
        ++calls <= 32 &&
          request.method === "POST" &&
          new URL(request.url).pathname === "/v1/messages",
        "Unexpected inference gate request",
      );
      const body = await request.arrayBuffer();
      check(body.byteLength <= 2 * 1024 * 1024, "Inference gate request exceeded bound");
      if (pending) {
        active = pending;
        pending = undefined;
        active.entered();
        await active.wait;
        active = undefined;
      }
      abort.signal.throwIfAborted();
      return fetch(new URL("/v1/messages", target), {
        method: "POST",
        headers: request.headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    hold() {
      check(!pending && !active, "Only one inference gate may be held");
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<void>((resolve) => {
        release = () => {
          clearTimeout(holdTimer);
          resolve();
        };
      });
      holdTimer = setTimeout(release, 10000);
      pending = { entered, release, wait };
      return {
        release,
        async entered() {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              reached,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Active inference did not reach the gate")),
                  10000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
      };
    },
    async stop() {
      abort.abort();
      pending?.release();
      active?.release();
      await server.stop(true);
    },
  };
}

export function assertAuthoringMigrationReport(
  report: MigrationReport,
  mode: MigrationReport["mode"],
  status: MigrationReport["status"],
): void {
  check(
    report.schemaVersion === 1 && report.mode === mode && report.status === status,
    "Migration report mode/status/schema disagrees with the command",
  );
  check(
    !JSON.stringify(report).includes("migration-private-canary"),
    "Migration report exposed private option values",
  );
  if (status === "planned")
    check(
      typeof report.fingerprint === "string" &&
        report.fingerprint.length > 0 &&
        report.operationId === null &&
        report.activation === null,
      "Migration preview must have a fingerprint but no operation or activation",
    );
  if (status === "complete")
    check(
      typeof report.operationId === "string" &&
        report.operationId.length > 0 &&
        report.activation !== null,
      "Applied migration lacks operation/activation evidence",
    );
}

/** A legacy file-layout fixture using current safe packages, not an old dependency graph. */
export async function runInstalledAuthoringMigration(options: {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  sourceConsumer: GeneratedAuthoringConsumer;
  cli: InstalledAuthoringCli;
}) {
  prepareAuthoringWorkspace(options.workspace);
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const consumer = join(options.workspace, "migration-legacy");
  mkdirSync(consumer, { mode: 0o700 });
  const fixtureFiles = {
    "agent.yaml": "legacy-agent.yaml",
    "augments/memory/augment.yaml": "legacy-memory.yaml",
    "augments/web/augment.yaml": "legacy-web.yaml",
    "augments/sample/augment.yaml": "legacy-custom.yaml",
    "augments/sample/index.ts": "legacy-custom.ts.txt",
  };
  for (const [target, source] of Object.entries(fixtureFiles)) {
    mkdirSync(dirname(join(consumer, target)), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(consumer, target),
      readBoundedRegularFile(join(options.repoRoot, "tests/fixtures/authoring", source), 16384)
        .bytes,
      { flag: "wx", mode: 0o600 },
    );
  }
  mkdirSync(join(consumer, "skills/operator"), { recursive: true, mode: 0o700 });
  mkdirSync(join(consumer, "data"), { mode: 0o700 });
  writeFileSync(join(consumer, "identity.md"), "A deterministic migration fixture.\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    join(consumer, "skills/operator/SKILL.md"),
    "---\nname: operator\ndescription: Retained operator guidance.\n---\nPreserve this owned guidance.\n",
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(join(consumer, "data/retained.txt"), "Retained business state.\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(join(consumer, ".env"), "AUGGY_MIGRATION_UNUSED=private-fixture-value\n", {
    flag: "wx",
    mode: 0o600,
  });
  const selectedManifest = JSON.parse(
    readAuthoringSource(options.sourceConsumer.consumer, "package.json").toString("utf8"),
  );
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "legacy-authoring-fixture", private: true, type: "module", dependencies: selectedManifest.dependencies, overrides: selectedManifest.overrides }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await runAuthoringBuild({
    ...options,
    consumer,
    label: "install-legacy",
    command: [process.execPath, "install", "--ignore-scripts"],
  });
  const local = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.sourceConsumer.core,
    "auggy/cli",
  );
  assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.sourceConsumer.provider,
    "@auggy/anthropic",
  );
  const provider = createProviderFixture({ scenario: "answer-only", toolResultSentinel: "unused" });
  let inferenceGate: ReturnType<typeof createAuthoringInferenceGate> | undefined;
  try {
    inferenceGate = createAuthoringInferenceGate(provider.baseURL);
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const baseURL = `http://127.0.0.1:${port}`,
      bearer = randomBytes(32).toString("hex");
    const secrets = [
      bearer,
      PROVIDER_FIXTURE_API_KEY,
      "migration-private-canary",
      "private-fixture-value",
    ];
    const home = join(options.workspace, "migration-home"),
      temporary = join(options.workspace, "migration-tmp");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    const env = applicationEnvironment(home, temporary, {
      ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
      AUGGY_WEB_TOKEN: bearer,
      AUGGY_PUBLIC_URL: baseURL,
    });
    const configPath = join(consumer, "agent.yaml");
    const legacy = parse(readFileSync(configPath, "utf8"));
    legacy.engine.baseURL = inferenceGate.baseURL;
    writeFileSync(configPath, stringify(legacy));
    const webPath = join(consumer, "augments/web/augment.yaml");
    const web = parse(readFileSync(webPath, "utf8"));
    web.config.port = port;
    writeFileSync(webPath, stringify(web));
    const retained = [
      "identity.md",
      "augments/memory/augment.yaml",
      "augments/web/augment.yaml",
      "augments/sample/augment.yaml",
      "augments/sample/index.ts",
      "skills/operator/SKILL.md",
      "data/retained.txt",
    ];
    const original = snapshotApplicationFiles(consumer, [
      "agent.yaml",
      "package.json",
      ...retained,
    ]);
    const envHash = applicationHash(readBoundedRegularFile(join(consumer, ".env"), 16384).bytes);
    const lock = applicationHash(
      readBoundedRegularFile(join(consumer, "bun.lock"), 2 * 1024 * 1024).bytes,
    );
    const http = applicationHttp(baseURL, bearer);
    let child: ReturnType<typeof startApplicationChild> | undefined;
    let childExited = false;
    const interrupted = new AbortController();
    const onSignal = () => {
      interrupted.abort(new Error("Migration acceptance interrupted"));
      child?.signal("SIGTERM");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const reports: Record<string, unknown> = {};
    const lifecycle: object[] = [];
    const failures: unknown[] = [];
    let status = "failed";
    const write = (name: string, value: unknown) =>
      writeFileSync(
        join(options.evidenceDirectory, name),
        `${redactEvidence(JSON.stringify(value, null, 2), secrets)}\n`,
        { mode: 0o600 },
      );
    const start = async () => {
      check(!child, "Migration probe still owns a process");
      child = startApplicationChild({
        command: [process.execPath, local.entry, "run", "--no-open"],
        cwd: consumer,
        env,
        secrets,
      });
      childExited = false;
      const current = child;
      void current.exited.then(() => {
        if (child === current) childExited = true;
      });
      await waitForApplicationReady(child, http, interrupted.signal);
    };
    const stop = async () => {
      if (!child) return;
      const result = await child.stop("SIGTERM");
      if (result.cleanupConfirmed) child = undefined;
      lifecycle.push(result);
      write("runtime-processes.json", lifecycle);
      check(
        result.cleanupConfirmed &&
          !result.forced &&
          result.exitCode === 0 &&
          !result.timedOut &&
          !result.orphanedGroup,
        "Migration runtime cleanup failed",
      );
    };
    const request = (threadId: string, key: string) =>
      http.request("/agent/run", {
        method: "POST",
        signal: interrupted.signal,
        idempotencyKey: key,
        json: { threadId, messages: [{ role: "user", content: "Reply with the fixture answer." }] },
      });
    const passive = () => ({
      imports: applicationHash(
        readBoundedRegularFile(join(consumer, "data/import-effects.jsonl"), 16384).bytes,
      ),
      calls: provider.evidence().calls,
    });
    const toolEffects = () =>
      readApplicationJsonLines(consumer, "data/import-effects.jsonl").filter(
        (effect) => effect.event === "tool",
      ).length;
    const command = async (
      label: string,
      args: string[],
      expected: MigrationReport["status"],
      mode: MigrationReport["mode"],
    ) => {
      const before = passive();
      const readonly = expected === "planned" || expected === "noop" || expected === "invalid";
      const metadataBefore = readonly ? authoringPrivateMetadataDigest(consumer) : null;
      const result = await runBoundedAuthoringCli({
        entry: options.cli.entry,
        args: ["migrate", "--json", ...args],
        cwd: consumer,
        workspace: options.workspace,
        secrets,
      });
      write(`${label}-command.json`, result);
      if (expected === "invalid")
        check(
          result.exitCode === 1 && result.cleanupConfirmed && !result.timedOut,
          "Invalid migration was not rejected safely",
        );
      else assertAuthoringCommandSucceeded(result);
      const report = JSON.parse(result.stdout) as MigrationReport;
      assertAuthoringMigrationReport(report, mode, expected);
      if (readonly)
        check(
          authoringPrivateMetadataDigest(consumer) === metadataBefore,
          "Passive migration changed private authoring metadata",
        );
      check(
        JSON.stringify(passive()) === JSON.stringify(before),
        "Migration command imported runtime/custom code or called provider",
      );
      reports[label] = report;
      return report;
    };
    const replay = async (originalResponse: ApplicationResponse, threadId: string, key: string) => {
      await start();
      const before = { providerCalls: provider.evidence().calls, toolEffects: toolEffects() };
      assertAuthoringReplay(originalResponse, await request(threadId, key), before, {
        providerCalls: provider.evidence().calls,
        toolEffects: toolEffects(),
      });
      await stop();
    };
    const applyDuringTurn = async (
      label: string,
      args: string[],
      mode: "config" | "application",
    ) => {
      provider.setScenario("answer-only");
      await start();
      const gate = inferenceGate!.hold();
      const threadId = `active-migration-${randomUUID()}`,
        key = randomUUID();
      const beforeEffects = toolEffects();
      const response = request(threadId, key);
      // Attach immediately; a command failure still releases and settles this request below.
      response.catch(() => undefined);
      let report: MigrationReport | undefined;
      const errors: unknown[] = [];
      try {
        await gate.entered();
        check(
          provider.evidence().calls === 0 && child && !childExited,
          "Turn was not held before inference completion",
        );
        report = await command(label, ["--apply", ...args], "complete", mode);
      } catch (error) {
        errors.push(error);
      } finally {
        gate.release();
      }
      try {
        const completed = await response;
        reports[`${label}-active-turn`] = assertGeneratedApplicationTurn({
          response: completed,
          threadId,
          provider: provider.evidence(),
          toolEffects: toolEffects() - beforeEffects,
          mode: "answer-only",
          toolName: "migration_lookup",
          expectedOutput: "unused",
          expectedFinalText: PROVIDER_FIXTURE_ANSWER_TEXT,
        });
        await stop();
        await replay(completed, threadId, key);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Migration did not retain the admitted in-flight turn");
      check(report, "Active migration did not return its result");
      return report;
    };
    try {
      await start();
      const threadId = `migration-${randomUUID()}`,
        key = randomUUID();
      const originalResponse = await request(threadId, key);
      reports.legacyTurn = assertGeneratedApplicationTurn({
        response: originalResponse,
        threadId,
        provider: provider.evidence(),
        toolEffects: toolEffects(),
        mode: "answer-only",
        toolName: "migration_lookup",
        expectedOutput: "unused",
        expectedFinalText: PROVIDER_FIXTURE_ANSWER_TEXT,
      });
      await stop();
      const beforePreview = snapshotApplicationFiles(consumer, [
        "agent.yaml",
        "package.json",
        ...retained,
      ]);
      const preview = await command("config-preview", [], "planned", "config");
      check(
        JSON.stringify(preview.changes.map((change) => change.path).sort()) ===
          JSON.stringify([".gitignore", "agent.yaml"]),
        "Config preview unexpectedly plans supporting source writes",
      );
      assertOnlyApplicationEdits(
        beforePreview,
        snapshotApplicationFiles(consumer, Object.keys(beforePreview)),
        [],
      );
      const converted = await applyDuringTurn("config-apply", [], "config");
      const config = parse(readFileSync(configPath, "utf8"));
      check(
        config.id === legacy.id && config.application === undefined && config.augments.length === 3,
        "Config-only conversion changed identity, order or execution mode",
      );
      const sample = config.augments[2];
      check(
        sample.type === "custom" &&
          sample.source === "./augments/sample/index.ts" &&
          sample.options.zero === 0 &&
          sample.options.disabled === false &&
          sample.options.nullable === null &&
          sample.options.placeholder === "${AUGGY_WEB_TOKEN}" &&
          sample.options.literal === "migration-private-canary",
        "Migration changed custom source base or option semantics",
      );
      assertOnlyApplicationEdits(
        original,
        snapshotApplicationFiles(consumer, Object.keys(original)),
        ["agent.yaml"],
      );
      await command("config-noop", ["--apply"], "noop", "config");
      await replay(originalResponse, threadId, key);
      const appPreview = await command(
        "application-preview",
        ["--application"],
        "planned",
        "application",
      );
      check(
        appPreview.manualActions.some((action) => action.includes("15")),
        "Application adoption failed to disclose the deadline difference",
      );
      const adopted = await applyDuringTurn("application-apply", ["--application"], "application");
      check(
        applicationHash(readFileSync(join(consumer, "bun.lock"))) === lock,
        "Migration installed dependencies or changed the lock",
      );
      check(
        parse(readFileSync(configPath, "utf8")).application?.entrypoint === "./src/index.ts",
        "Application adoption did not activate owned source",
      );
      await runAuthoringBuild({
        ...options,
        consumer,
        label: "install-adopted-tooling",
        command: [process.execPath, "install", "--ignore-scripts"],
      });
      await runAuthoringBuild({
        ...options,
        consumer,
        label: "adopted-typecheck",
        command: [process.execPath, "run", "typecheck"],
      });
      await runAuthoringBuild({
        ...options,
        consumer,
        label: "adopted-tests",
        command: [process.execPath, "run", "test"],
      });
      await replay(originalResponse, threadId, key);
      const edit = generatedApplicationRecipe([]).edits.http;
      await withApplicationEdit(
        consumer,
        edit,
        async () => {
          await command(
            "changed-output-rollback-refused",
            ["--rollback", adopted.operationId!],
            "invalid",
            "rollback",
          );
          provider.setScenario("answer-only");
          await start();
          const freshThread = `migrated-owned-${randomUUID()}`;
          const response = await request(freshThread, randomUUID());
          assertAuthoringHeader(response, generatedApplicationRecipe([]).observations.httpHeader);
          reports.applicationTurn = assertGeneratedApplicationTurn({
            response,
            threadId: freshThread,
            provider: provider.evidence(),
            toolEffects: toolEffects(),
            mode: "answer-only",
            toolName: "migration_lookup",
            expectedOutput: "unused",
            expectedFinalText: PROVIDER_FIXTURE_ANSWER_TEXT,
          });
          await stop();
        },
        () => !child,
      );
      await command(
        "application-rollback",
        ["--rollback", adopted.operationId!, "--apply"],
        "rolled-back",
        "rollback",
      );
      await command(
        "config-rollback",
        ["--rollback", converted.operationId!, "--apply"],
        "rolled-back",
        "rollback",
      );
      assertOnlyApplicationEdits(
        original,
        snapshotApplicationFiles(consumer, Object.keys(original)),
        [],
      );
      check(
        applicationHash(readBoundedRegularFile(join(consumer, ".env"), 16384).bytes) === envHash,
        "Migration changed private environment bytes",
      );
      await replay(originalResponse, threadId, key);
      status = "passed";
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      write("migration.json", {
        status: failures.length ? "failed" : status,
        cleanupConfirmed: !child,
        consumer,
        reports,
        sourceHashes: original,
        privateEnvironmentRetained:
          applicationHash(readBoundedRegularFile(join(consumer, ".env"), 16384).bytes) === envHash,
        importEffects: readApplicationJsonLines(consumer, "data/import-effects.jsonl").length,
      });
    }
    if (failures.length)
      throw new AggregateError(failures, "Installed migration or cleanup failed");
    return { status, consumer, cleanupConfirmed: !child };
  } finally {
    try {
      await inferenceGate?.stop();
    } finally {
      await provider.stop();
    }
  }
}

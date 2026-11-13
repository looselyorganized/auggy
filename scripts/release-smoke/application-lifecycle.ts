/** L10: faults in actual installed application source, never a replacement runtime. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  snapshotApplicationFiles,
  startApplicationChild,
} from "./application-consumer";
import { applicationHttp, waitForApplicationReady } from "./application-http";
import { readApplicationRecords } from "./application-records";
import type { InstalledApplicationOptions } from "./application-runner";
import { redactEvidence } from "./export-evidence";
import { createProviderFixture, PROVIDER_FIXTURE_API_KEY } from "./provider-fixture";

const BOOT = "application-lifecycle-actual-augment-boot";
const SHUTDOWN = "application-lifecycle-actual-augment-shutdown";
const AUGMENT = "src/augments/example/index.ts";
const COMPOSE = "src/agent.ts";
const START = "  const ready = await host.start({ http: prepared.http.map(configureHttp) });";
type ChildResult = Awaited<ReturnType<ReturnType<typeof startApplicationChild>["finish"]>>;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function replaceOnce(source: string, before: string, after: string) {
  check(source.split(before).length === 2, "Lifecycle source anchor is missing or ambiguous");
  return source.replace(before, after);
}
export function assertApplicationLifecycleResult(
  result: Pick<
    ChildResult,
    | "cleanupConfirmed"
    | "timedOut"
    | "spawnFailed"
    | "exceededOutput"
    | "orphanedGroup"
    | "exitCode"
    | "signal"
    | "stdout"
    | "stderr"
  >,
  expected: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    boots: number;
    shutdowns: number;
    fault?: "prepare" | "after-start";
  },
) {
  check(
    result.cleanupConfirmed &&
      !result.timedOut &&
      !result.spawnFailed &&
      !result.exceededOutput &&
      !result.orphanedGroup,
    "Lifecycle child did not reach a confirmed bounded process-group exit",
  );
  check(
    result.exitCode === expected.exitCode && result.signal === expected.signal,
    "Lifecycle exit propagation differs",
  );
  const lines = result.stdout.split(/\r?\n/);
  check(
    lines.filter((line) => line === BOOT).length === expected.boots &&
      lines.filter((line) => line === SHUTDOWN).length === expected.shutdowns,
    "Actual augment boot/shutdown count differs",
  );
  if (expected.fault)
    check(
      new RegExp(`^error: application-lifecycle-${expected.fault}-fault$`, "im").test(
        `${result.stdout}\n${result.stderr}`,
      ),
      "Intended application startup fault was not observed",
    );
}

export async function runInstalledApplicationLifecycle(options: InstalledApplicationOptions) {
  const consumer = realpathSync(options.consumer);
  const local = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    options.core,
    "auggy/cli",
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
    options.provider,
    "@auggy/anthropic",
  );
  const original = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
  const lock = applicationHash(readFileSync(join(consumer, "bun.lock")));
  const paths = ["agent.yaml", options.recipe.entrypoint, COMPOSE, AUGMENT];
  const originalBytes = new Map(paths.map((path) => [path, readFileSync(join(consumer, path))]));
  const config = parse(originalBytes.get("agent.yaml")!.toString("utf8"));
  check(
    config && typeof config === "object" && Array.isArray(config.augments),
    "Lifecycle reference config missing",
  );
  if (config.id === "${AUGGY_AGENT_ID}") config.id = `aug1_${randomUUID()}`;
  check(
    typeof config.id === "string" && /^aug1_[0-9a-f-]{36}$/.test(config.id),
    "Invalid lifecycle agent identity",
  );
  const web = config.augments.filter((item: { type?: string }) => item.type === "webTransport");
  check(web.length === 1 && web[0].options, "Lifecycle reference web binding missing");
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const bearer = randomBytes(32).toString("hex");
  const secrets = [bearer, PROVIDER_FIXTURE_API_KEY];
  const env = applicationEnvironment(options.home, options.temporaryDirectory, {
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: bearer,
  });
  const provider = createProviderFixture({
    tool: options.recipe.tool,
    toolResultSentinel: options.expectedToolOutput,
  });
  const abort = new AbortController();
  const active = new Set<ReturnType<typeof startApplicationChild>>();
  const scenarios: Record<string, unknown> = {};
  const errors: unknown[] = [];
  const evidence = options.evidenceDirectory;
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  let state: "running" | "passed" | "failed" = "running";
  let sequence = 0;
  const write = (name: string, value: unknown) => {
    const path = join(evidence, name);
    const temporary = `${path}.tmp-${randomUUID()}`;
    writeFileSync(temporary, `${redactEvidence(JSON.stringify(value, null, 2), secrets)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  };
  const progress = () =>
    write("application-lifecycle.json", {
      schemaVersion: 1,
      row: "L10",
      state,
      cleanup: active.size ? "unconfirmed" : "confirmed",
      retainedPids: [...active].map((child) => child.pid),
      scenarios,
      coreSHA256: options.core.sha256,
      providerSHA256: options.provider.sha256,
      lockSHA256: lock,
      errors: errors.map((error) => (error instanceof Error ? error.message : "Lifecycle failure")),
    });
  const atomicSource = (path: string, bytes: string | Buffer) => {
    check(active.size === 0, "Cannot edit source while process cleanup is unconfirmed");
    const destination = join(consumer, path);
    const temporary = `${destination}.lifecycle-${randomUUID()}`;
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  };
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
  const beforeWork = counters();
  const launchPaths = [
    { name: "direct-script", command: [process.execPath, "run", "start"], delegated: false },
    {
      name: "local",
      command: [process.execPath, local.entry, "run", "--no-open"],
      delegated: false,
    },
    {
      name: "global",
      command: [process.execPath, external.entry, "run", "--no-open"],
      delegated: true,
    },
  ];
  const launch = (command: readonly string[]) => {
    abort.signal.throwIfAborted();
    const child = startApplicationChild({ command, cwd: consumer, env, secrets });
    active.add(child);
    return child;
  };
  const recordResult = (
    name: string,
    child: ReturnType<typeof startApplicationChild>,
    result: ChildResult,
  ) => {
    if (result.cleanupConfirmed) active.delete(child);
    const { stdout, stderr, ...metadata } = result;
    writeFileSync(join(evidence, `${++sequence}-${name}.log`), `${stdout}\n${stderr}`, {
      mode: 0o600,
    });
    return metadata;
  };
  const assertQuiet = () =>
    check(
      JSON.stringify(counters()) === JSON.stringify(beforeWork),
      "Lifecycle-only operation scheduled turn/provider/tool work",
    );
  const normal = async (
    path: (typeof launchPaths)[number],
    name: string,
    signal: "SIGINT" | "SIGTERM",
  ) => {
    const prior = records().startup.length;
    const child = launch(path.command);
    await waitForApplicationReady(
      child,
      applicationHttp(`http://127.0.0.1:${port}`, bearer),
      abort.signal,
    );
    const deadline = Date.now() + 5_000;
    while (records().startup.length === prior && Date.now() < deadline) await Bun.sleep(25);
    check(records().startup.length === prior + 1, "Lifecycle next start did not execute main once");
    const result = await child.stop(signal);
    const metadata = recordResult(name, child, result);
    check(!result.forced, "Lifecycle clean shutdown required forced termination");
    assertApplicationLifecycleResult(result, { exitCode: 0, signal: null, boots: 1, shutdowns: 1 });
    assertQuiet();
    scenarios[name] = {
      status: "passed",
      requestedSignal: signal,
      ...metadata,
      resourceEvidence: "real listener and same-identity next start; actual augment shutdown once",
    };
    progress();
  };
  const onSignal = () => {
    abort.abort(new Error("Application lifecycle acceptance interrupted"));
    for (const child of active) void child.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    progress();
    config.engine = {
      provider: "anthropic",
      model: "claude-application-lifecycle",
      baseURL: provider.baseURL,
      maxContextTokens: 32_000,
      maxTokens: 256,
      requestTimeoutMs: 5_000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    web[0].options.port = port;
    web[0].options.auth = { type: "bearer", token: "${AUGGY_WEB_TOKEN}" };
    web[0].options.allowAnonymous = false;
    atomicSource("agent.yaml", stringify(config));
    const augmented = replaceOnce(
      originalBytes.get(AUGMENT)!.toString("utf8"),
      '    category: "capabilities",',
      `    category: "capabilities",\n    onBoot: async () => { console.info(${JSON.stringify(BOOT)}); },\n    onShutdown: async () => { console.info(${JSON.stringify(SHUTDOWN)}); },`,
    );
    atomicSource(AUGMENT, augmented);
    const configured = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
    for (const path of launchPaths) {
      await normal(path, `initial-${path.name}`, "SIGTERM");
      for (const fault of ["prepare", "after-start"] as const) {
        const edited = fault === "prepare" ? COMPOSE : options.recipe.entrypoint;
        const base = originalBytes.get(edited)!.toString("utf8");
        const source =
          fault === "prepare"
            ? replaceOnce(
                base,
                "  configured.compose({ turnProgram, onTurnFinalized: observeFinalization });",
                '  (() => { configured.compose({ turnProgram, onTurnFinalized: observeFinalization }); throw new Error("application-lifecycle-prepare-fault"); })();',
              )
            : replaceOnce(
                base,
                START,
                `${START}\n  throw new Error("application-lifecycle-after-start-fault");`,
              );
        atomicSource(edited, source);
        assertOnlyApplicationEdits(
          configured,
          snapshotApplicationFiles(consumer, options.recipe.sourceFiles),
          [edited],
        );
        const prior = records().startup.length;
        const child = launch(path.command);
        const result = await child.finish();
        const metadata = recordResult(`${fault}-${path.name}`, child, result);
        assertApplicationLifecycleResult(result, {
          exitCode: 1,
          signal: null,
          boots: fault === "prepare" ? 0 : 1,
          shutdowns: 1,
          fault,
        });
        check(records().startup.length === prior, "Failed main emitted application readiness");
        assertQuiet();
        scenarios[`${fault}-${path.name}`] = {
          status: "passed",
          ...metadata,
          gracefulAugmentCleanup: "exactly-once",
        };
        atomicSource(edited, originalBytes.get(edited)!);
        await normal(path, `recovered-${fault}-${path.name}`, "SIGINT");
      }
    }
    // Abrupt exits deliberately bypass cleanup; only dead-process recovery may release their claims.
    for (const fault of ["exit-23", "sigkill"] as const) {
      const source = replaceOnce(
        originalBytes.get(options.recipe.entrypoint)!.toString("utf8"),
        START,
        `${START}\n  ${fault === "exit-23" ? "process.exit(23);" : 'process.kill(process.pid, "SIGKILL");'}`,
      );
      atomicSource(options.recipe.entrypoint, source);
      const child = launch(launchPaths[2]!.command);
      const result = await child.finish();
      const metadata = recordResult(fault, child, result);
      assertApplicationLifecycleResult(result, {
        exitCode: fault === "exit-23" ? 23 : 137,
        signal: null,
        boots: 1,
        shutdowns: 0,
      });
      assertQuiet();
      scenarios[fault] = {
        status: "passed",
        ...metadata,
        gracefulCleanup: false,
        ownership: "dead process; next-start recovery asserted separately",
      };
      atomicSource(options.recipe.entrypoint, originalBytes.get(options.recipe.entrypoint)!);
      await normal(launchPaths[2]!, `recovered-${fault}`, "SIGTERM");
    }
    assertQuiet();
    state = "passed";
  } catch (error) {
    errors.push(error);
    state = "failed";
  } finally {
    try {
      for (const child of [...active]) {
        try {
          const result = await child.stop();
          recordResult("cleanup", child, result);
          check(result.cleanupConfirmed, "Lifecycle process cleanup remains unknown");
        } catch (error) {
          errors.push(error);
        }
      }
      if (active.size === 0) {
        for (const [path, bytes] of originalBytes) {
          try {
            atomicSource(path, bytes);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          check(
            JSON.stringify(snapshotApplicationFiles(consumer, options.recipe.sourceFiles)) ===
              JSON.stringify(original),
            "Lifecycle source restoration differs",
          );
          check(
            applicationHash(readFileSync(join(consumer, "bun.lock"))) === lock,
            "Lifecycle changed retained lock",
          );
        } catch (error) {
          errors.push(error);
        }
      } else errors.push(new Error("Lifecycle sources retained because child cleanup is unknown"));
      try {
        await provider.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) state = "failed";
      try {
        progress();
      } catch (error) {
        errors.push(error);
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Installed application lifecycle acceptance failed");
}

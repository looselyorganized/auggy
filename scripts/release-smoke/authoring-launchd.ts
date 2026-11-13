/** Actual generated-project service execution; reference instrumentation is not required. */
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import {
  APPLICATION_BOUNDS,
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  parseApplicationStream,
  startApplicationChild,
} from "./application-consumer";
import { applicationHttp, type ApplicationResponse } from "./application-http";
import {
  applicationLaunchdAvailability,
  applicationLaunchdListedPid,
  inspectApplicationLaunchdManifest,
  inspectApplicationLaunchdPlist,
  writeApplicationLaunchdReport,
} from "./application-launchd";
import { readBoundedRegularFile } from "./bounded-file";
import { redactEvidence } from "./export-evidence";
import { snapshotGeneratedAuthoringSources } from "./authoring-consumer";
import type { GeneratedAuthoringConsumer } from "./authoring-contract";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_ANSWER_TEXT,
  PROVIDER_FIXTURE_API_KEY,
  type ProviderFixtureEvidence,
} from "./provider-fixture";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inside(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function assertGeneratedServiceAnswer(
  response: ApplicationResponse,
  threadId: string,
  provider: ProviderFixtureEvidence,
  header?: string,
) {
  const events = parseApplicationStream(response.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const ends = events.filter((event) => event.type === "RUN_FINISHED");
  const text = events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta)
    .join("");
  check(
    response.status === 200 &&
      starts.length === 1 &&
      ends.length === 1 &&
      events.at(-1) === ends[0] &&
      typeof starts[0]!.runId === "string" &&
      starts[0]!.runId !== "" &&
      starts[0]!.runId === ends[0]!.runId &&
      starts[0]!.threadId === threadId &&
      ends[0]!.threadId === threadId &&
      (ends[0]!.result as { status?: unknown })?.status === "completed" &&
      !events.some(
        (event) => event.type === "RUN_ERROR" || String(event.type).startsWith("TOOL_CALL_"),
      ) &&
      text.includes(PROVIDER_FIXTURE_ANSWER_TEXT),
    "Generated service did not return its correlated final answer",
  );
  check(
    provider.scenario === "answer-only" &&
      provider.calls === 1 &&
      provider.finalResponses === 1 &&
      provider.toolRequests === 0 &&
      provider.validatedToolResults === 0 &&
      provider.rejectedRequests === 0,
    "Generated service answer did not cross the real provider adapter exactly once",
  );
  check(
    response.headers["x-auggy-owned-service"] === header,
    "Generated service HTTP source marker disagrees",
  );
  return { threadId, runId: starts[0]!.runId, bodySHA256: applicationHash(response.body) };
}

/** New create owns this documentation file; any other data implies a used consumer. */
export function assertFreshGeneratedServiceState(consumer: string) {
  for (const [directory, child] of [
    ["data", "workspace"],
    ["data/workspace", "README.md"],
  ] as const) {
    const path = join(consumer, directory);
    const info = lstatSync(path);
    check(
      info.isDirectory() && !info.isSymbolicLink(),
      "Generated service state directory must be ordinary",
    );
    const handle = opendirSync(path);
    try {
      const first = handle.readSync();
      check(
        first?.name === child && handle.readSync() === null,
        "Generated service consumer already contains runtime state",
      );
    } finally {
      handle.closeSync();
    }
  }
  const file = "data/workspace/README.md";
  const bytes = readBoundedRegularFile(join(consumer, file), 16 * 1024).bytes;
  return { path: file, sha256: applicationHash(bytes), bytesArchived: false };
}

export interface GeneratedServiceLogSizes {
  stdout: number | null;
  stderr: number | null;
}

/** Metadata only: never archive service log bytes or follow aliases. */
export function inspectGeneratedServiceLogs(
  home: string,
  agentId: string,
): GeneratedServiceLogSizes {
  check(
    /^aug1_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(agentId),
    "Invalid generated service identity",
  );
  for (const relativePath of [".auggy", ".auggy/logs"]) {
    const info = lstatSync(join(home, relativePath), { throwIfNoEntry: false });
    if (!info) return { stdout: null, stderr: null };
    check(
      info.isDirectory() && !info.isSymbolicLink(),
      "Generated service log parent must be ordinary",
    );
  }
  const sizes: GeneratedServiceLogSizes = { stdout: null, stderr: null };
  for (const [stream, suffix] of [
    ["stdout", "log"],
    ["stderr", "err"],
  ] as const) {
    const info = lstatSync(join(home, ".auggy/logs", `${agentId}.${suffix}`), {
      throwIfNoEntry: false,
    });
    if (!info) continue;
    check(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        Number.isSafeInteger(info.size),
      "Generated service logs must be ordinary single-link files",
    );
    sizes[stream] = info.size;
  }
  return sizes;
}

/** Polling bounds detection/stop latency, not the filesystem's instantaneous byte count. */
export function watchGeneratedServiceLogs(options: {
  home: string;
  agentId: string;
  onFailure: (error: Error) => void;
  intervalMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 100;
  check(
    Number.isSafeInteger(intervalMs) && intervalMs >= 10 && intervalMs <= 1000,
    "Invalid service log polling interval",
  );
  const maximumObserved = { stdout: 0, stderr: 0 };
  let failure: Error | undefined;
  const inspect = () => {
    try {
      const sizes = inspectGeneratedServiceLogs(options.home, options.agentId);
      for (const stream of ["stdout", "stderr"] as const)
        maximumObserved[stream] = Math.max(maximumObserved[stream], sizes[stream] ?? 0);
      check(
        maximumObserved.stdout <= APPLICATION_BOUNDS.outputBytes &&
          maximumObserved.stderr <= APPLICATION_BOUNDS.outputBytes,
        "Generated service log exceeded the observed output limit",
      );
    } catch (error) {
      if (failure) return;
      failure =
        error instanceof Error ? error : new Error("Generated service log inspection failed");
      options.onFailure(failure);
    }
  };
  const timer = setInterval(inspect, intervalMs);
  inspect();
  return {
    checkpoint() {
      inspect();
      if (failure) throw failure;
    },
    stop() {
      clearInterval(timer);
      inspect();
      return {
        intervalMs,
        limitBytes: APPLICATION_BOUNDS.outputBytes,
        maximumObserved,
        failure: failure?.message ?? null,
        enforcement:
          "bounded polling followed by owned-service stop; writes may overshoot between observations",
      };
    },
  };
}

export interface GeneratedLaunchdOptions {
  repoRoot: string;
  consumer: GeneratedAuthoringConsumer;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
}

export async function runGeneratedApplicationLaunchd(options: GeneratedLaunchdOptions) {
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    state: "running",
    platform: process.platform,
    cleanupConfirmed: false,
    commands: [],
    lifecycle: [],
    scenarios: {},
    cleanupErrors: [],
  };
  const secrets = [PROVIDER_FIXTURE_API_KEY];
  const write = () =>
    writeApplicationLaunchdReport(
      join(evidence, "authoring-launchd.json"),
      `${redactEvidence(JSON.stringify(report, null, 2), secrets)}\n`,
    );
  if (!applicationLaunchdAvailability(process.platform).available) {
    Object.assign(report, {
      state: "unavailable",
      reason: "macos-launchd-required",
      cleanupConfirmed: true,
    });
    write();
    return report;
  }
  write();
  try {
    await executeGeneratedLaunchd(options, report, secrets, write);
  } catch (error) {
    report.state = "failed";
    report.failure ??= redactEvidence(
      error instanceof Error ? error.message : "Generated service failed",
      secrets,
    );
    write();
    throw error;
  }
  return report;
}

async function executeGeneratedLaunchd(
  options: GeneratedLaunchdOptions,
  report: Record<string, unknown>,
  secrets: string[],
  write: () => void,
) {
  const repoRoot = realpathSync(options.repoRoot);
  const consumer = realpathSync(options.consumer.consumer),
    home = realpathSync(options.home);
  check(
    home !== realpathSync(homedir()) &&
      !inside(home, repoRoot) &&
      !inside(consumer, repoRoot) &&
      !existsSync(join(home, ".auggy")),
    "Generated launchd acceptance requires a fresh isolated consumer and HOME",
  );
  const generatedWorkspace = assertFreshGeneratedServiceState(consumer);
  report.generatedWorkspace = generatedWorkspace;
  const snapshot = () =>
    snapshotGeneratedAuthoringSources({
      repoRoot,
      consumer,
      sourceFiles: options.consumer.sourceFiles,
    });
  const original = snapshot();
  assertOnlyApplicationEdits(options.consumer.installedSources, original, []);
  const local = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.consumer.core,
    "auggy/cli",
  );
  const application = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.consumer.core,
    "auggy/application",
  );
  const adapter = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.consumer.provider,
    "@auggy/anthropic",
  );
  const read = (file: string, bound = APPLICATION_BOUNDS.sourceBytes) =>
    readBoundedRegularFile(join(consumer, file), bound).bytes;
  const originalConfig = read("agent.yaml"),
    originalEnv = read(".env"),
    originalHttp = read("src/http.ts");
  const lock = applicationHash(read("bun.lock"));
  check(
    (lstatSync(join(consumer, ".env")).mode & 0o777) === 0o600,
    "Generated environment must be private",
  );
  const config: unknown = parse(originalConfig.toString("utf8"));
  check(
    object(config) && typeof config.name === "string" && Array.isArray(config.augments),
    "Missing generated configuration",
  );
  const web = config.augments.filter((item) => object(item) && item.type === "webTransport");
  check(
    web.length === 1 && object(web[0]) && object(web[0].options),
    "Expected one generated web listener",
  );
  const httpAnchor = "          return response;";
  const httpSource = originalHttp.toString("utf8");
  check(httpSource.split(httpAnchor).length === 2, "Generated service HTTP anchor changed");
  const agentId = `aug1_${randomUUID()}`,
    label = `com.auggy.agent.${agentId}`;
  config.id = agentId;
  const configPath = join(consumer, "agent.yaml"),
    envPath = join(consumer, ".env");
  const storePath = join(home, ".auggy/plists", `${label}.plist`);
  const installPath = join(home, "Library/LaunchAgents", `${label}.plist`);
  const manifestPath = join(home, ".auggy", `${agentId}.json`);
  const env = applicationEnvironment(home, options.temporaryDirectory);
  const commands = report.commands as Record<string, unknown>[];
  const lifecycle = report.lifecycle as Record<string, unknown>[];
  const scenarios = report.scenarios as Record<string, unknown>;
  const cleanupErrors = report.cleanupErrors as string[];
  const owned = new Set<ReturnType<typeof startApplicationChild>>(),
    knownPids = new Set<number>();
  const command = async (args: readonly string[], privateOutput = false) => {
    check(commands.length < 64, "Generated service command count exceeded its bound");
    const child = startApplicationChild({
      command: args,
      cwd: consumer,
      env,
      secrets,
      timeoutMs: args[2] === "stop" ? APPLICATION_BOUNDS.shutdownMs : 30_000,
    });
    owned.add(child);
    const result = await child.finish();
    if (result.cleanupConfirmed) owned.delete(child);
    commands.push({
      command: args,
      ...result,
      ...(privateOutput
        ? { stdout: "[inspected privately]", stderr: "[inspected privately]" }
        : {}),
    });
    write();
    check(
      result.cleanupConfirmed &&
        !result.timedOut &&
        !result.spawnFailed &&
        !result.exceededOutput &&
        !result.orphanedGroup,
      "Generated service control command did not settle",
    );
    return result;
  };
  const cli = async (...args: string[]) => {
    const result = await command([process.execPath, local.entry, ...args]);
    check(result.exitCode === 0 && result.signal === null, "Generated service CLI command failed");
  };
  const listing = async () => {
    const result = await command(["/bin/launchctl", "list"], true);
    check(result.exitCode === 0, "Actual launchctl listing failed");
    return applicationLaunchdListedPid(result.stdout, label);
  };
  let attempted = false,
    changed = false,
    unavailable = false,
    primary: unknown;
  let provider: ReturnType<typeof createProviderFixture> | undefined;
  const abort = new AbortController();
  const onSignal = () => {
    abort.abort(new Error("Generated launchd acceptance interrupted"));
    for (const child of owned) child.signal("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let cleanupStarted = false;
  const logWatch = watchGeneratedServiceLogs({
    home,
    agentId,
    onFailure: (error) => {
      abort.abort(error);
      if (!cleanupStarted) {
        for (const child of owned) {
          try {
            child.signal("SIGTERM");
          } catch {
            /* Cleanup still owns the child. */
          }
        }
      }
    },
  });

  try {
    const initial = await command(["/bin/launchctl", "list"], true);
    if (initial.exitCode !== 0) {
      unavailable = true;
      throw new Error("launchctl-domain-unavailable");
    }
    check(
      applicationLaunchdListedPid(initial.stdout, label) === undefined,
      "Refusing an existing service label",
    );
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    check(typeof port === "number", "Generated service port was not assigned");
    const bearer = randomBytes(32).toString("hex"),
      baseURL = `http://127.0.0.1:${port}`;
    secrets.push(bearer);
    provider = createProviderFixture({
      scenario: "answer-only",
      toolResultSentinel: "unused-answer-only-service",
    });
    const http = applicationHttp(baseURL, bearer);
    config.engine = {
      provider: "anthropic",
      model: "claude-generated-service",
      baseURL: provider.baseURL,
      maxContextTokens: 32_000,
      maxTokens: 256,
      requestTimeoutMs: 5_000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    web[0].options.port = port;
    web[0].options.auth = { type: "bearer", token: "${AUGGY_WEB_TOKEN}" };
    web[0].options.allowAnonymous = false;
    changed = true;
    writeFileSync(
      envPath,
      `AUGGY_AGENT_ID=${agentId}\nANTHROPIC_API_KEY=${PROVIDER_FIXTURE_API_KEY}\nAUGGY_WEB_TOKEN=${bearer}\nAUGGY_PUBLIC_URL=${baseURL}\n`,
      { mode: 0o600 },
    );
    writeFileSync(configPath, stringify(config));
    Object.assign(report, {
      consumer,
      home,
      agentId,
      label,
      local,
      application,
      adapter,
      lockSHA256: lock,
      originalSources: original,
      configuredSources: snapshot(),
      actualUserLaunchAgentsTouched: false,
    });
    const expected = {
      agentId,
      name: config.name,
      consumer,
      configPath,
      home,
      cli: local.entry,
      bun: process.execPath,
      port,
    };
    const ready = async () => {
      const deadline = Date.now() + APPLICATION_BOUNDS.readinessMs;
      while (true) {
        logWatch.checkpoint();
        abort.signal.throwIfAborted();
        let healthy = false;
        try {
          const response = await http.request("/health", {
            timeoutMs: 1_000,
            signal: abort.signal,
          });
          healthy = response.status === 200 && JSON.parse(response.body)?.status === "healthy";
        } catch {
          /* Bounded startup retry. */
        }
        if (healthy && existsSync(manifestPath)) break;
        check(Date.now() < deadline, "Generated service readiness timed out");
        await Bun.sleep(100);
      }
      check(
        lstatSync(installPath).isSymbolicLink() && realpathSync(installPath) === storePath,
        "Generated service installation escaped isolated HOME",
      );
      const bytes = readBoundedRegularFile(storePath, 32_768).bytes;
      const captured = join(
        realpathSync(options.evidenceDirectory),
        `.generated-plist-${randomUUID()}.plist`,
      );
      let plist: unknown;
      try {
        writeFileSync(captured, bytes, { mode: 0o600, flag: "wx" });
        const result = await command(
          ["/usr/bin/plutil", "-convert", "json", "-o", "-", captured],
          true,
        );
        check(result.exitCode === 0, "Cannot decode generated service plist");
        plist = JSON.parse(result.stdout);
      } finally {
        rmSync(captured, { force: true });
      }
      const unit = inspectApplicationLaunchdPlist(plist, expected);
      const manifestBytes = readBoundedRegularFile(manifestPath, 32_768).bytes;
      const manifest = inspectApplicationLaunchdManifest(
        JSON.parse(manifestBytes.toString("utf8")),
        expected,
        unit.generation,
      );
      knownPids.add(manifest.pid);
      check(
        !processGone(manifest.pid) && (await listing()) === manifest.pid,
        "Generated service PID differs from launchctl",
      );
      let domain: string | undefined;
      for (const candidate of [`gui/${process.getuid!()}`, `user/${process.getuid!()}`]) {
        const result = await command(["/bin/launchctl", "print", `${candidate}/${label}`], true);
        if (
          result.exitCode === 0 &&
          new RegExp(`\\bpid = ${manifest.pid}\\b`).test(result.stdout)
        ) {
          domain = candidate;
          break;
        }
      }
      check(domain, "Generated service domain was not verified");
      lifecycle.push({
        event: "ready",
        domain,
        ...manifest,
        unit,
        plistSHA256: applicationHash(bytes),
        manifestSHA256: applicationHash(manifestBytes),
      });
      write();
      return manifest;
    };
    const request = async (phase: string, marker?: string) => {
      logWatch.checkpoint();
      provider!.reset();
      provider!.setScenario("answer-only");
      const threadId = `generated-service-${randomUUID()}`;
      const body = {
        threadId,
        messages: [{ role: "user", content: "Reply with the fixture answer." }],
      };
      const denied = await http.request("/agent/run", {
        method: "POST",
        auth: "missing",
        json: body,
        signal: abort.signal,
      });
      check(
        (denied.status === 401 || denied.status === 403) && provider!.evidence().calls === 0,
        "Generated service authorization caused provider work",
      );
      const key = randomUUID();
      const response = await http.request("/agent/run", {
        method: "POST",
        json: body,
        idempotencyKey: key,
        signal: abort.signal,
      });
      const proof = assertGeneratedServiceAnswer(response, threadId, provider!.evidence(), marker);
      let rejectedWrongMarker = false;
      try {
        assertGeneratedServiceAnswer(
          response,
          threadId,
          provider!.evidence(),
          "wrong-service-marker",
        );
      } catch {
        rejectedWrongMarker = true;
      }
      check(rejectedWrongMarker, "Generated service verifier accepted the wrong source marker");
      const replay = await http.request("/agent/run", {
        method: "POST",
        json: body,
        idempotencyKey: key,
        signal: abort.signal,
      });
      check(
        replay.status === 200 &&
          applicationHash(replay.body) === applicationHash(response.body) &&
          provider!.evidence().calls === 1,
        "Generated service replay repeated provider work or changed the result",
      );
      logWatch.checkpoint();
      scenarios[phase] = {
        state: "passed",
        ...proof,
        provider: provider!.evidence(),
        denialStatus: denied.status,
        replay: "unchanged-no-effects",
        wrongMarkerRejected: true,
      };
      write();
      return { body, key, response };
    };
    attempted = true;
    await cli("start", "--config", configPath);
    const first = await ready();
    check(provider.evidence().calls === 0, "Service startup unexpectedly invoked a provider");
    const firstRequest = await request("untouched-generated-answer");
    await cli("status", agentId);
    const marker = "generated-project-owned-handler";
    writeFileSync(
      join(consumer, "src/http.ts"),
      httpSource.replace(
        httpAnchor,
        `          response.headers.set("x-auggy-owned-service", "${marker}");\n${httpAnchor}`,
      ),
    );
    assertOnlyApplicationEdits(original, snapshot(), ["agent.yaml", "src/http.ts"]);
    await cli("restart", agentId, "--config", configPath);
    const second = await ready();
    check(
      first.generation !== second.generation &&
        first.claimNonce !== second.claimNonce &&
        first.pid !== second.pid &&
        processGone(first.pid),
      "Generated service restart did not replace and reap the prior generation",
    );
    const beforeRestartReplay = provider.evidence().calls;
    const restartReplay = await http.request("/agent/run", {
      method: "POST",
      json: firstRequest.body,
      idempotencyKey: firstRequest.key,
      signal: abort.signal,
    });
    check(
      restartReplay.status === 200 &&
        applicationHash(restartReplay.body) === applicationHash(firstRequest.response.body) &&
        provider.evidence().calls === beforeRestartReplay,
      "Generated service restart lost durable replay",
    );
    scenarios["restart-replay"] = {
      state: "passed",
      providerCallsBefore: beforeRestartReplay,
      providerCallsAfter: provider.evidence().calls,
    };
    await request("edited-handler-after-restart", marker);
  } catch (error) {
    if (unavailable) report.reason = "launchctl-domain-unavailable";
    else {
      primary = error;
      report.failure = redactEvidence(
        error instanceof Error ? error.message : "Generated service failure",
        secrets,
      );
    }
  } finally {
    cleanupStarted = true;
    try {
      if (attempted) {
        try {
          await cli("stop", agentId);
        } catch {
          cleanupErrors.push("service-stop-failed");
        }
      }
      for (const child of owned) {
        try {
          if ((await child.stop()).cleanupConfirmed) owned.delete(child);
          else cleanupErrors.push("control-process-unconfirmed");
        } catch {
          cleanupErrors.push("control-process-cleanup-failed");
        }
      }
      let released = !attempted;
      if (attempted) {
        try {
          check(
            (await listing()) === undefined &&
              !existsSync(installPath) &&
              !existsSync(storePath) &&
              !existsSync(manifestPath) &&
              [...knownPids].every(processGone),
            "Generated service ownership is live or unknown",
          );
          const databasePath = join(home, ".auggy/runtime-claims.sqlite");
          check(
            knownPids.size === 0 || existsSync(databasePath),
            "Generated runtime lost its claim database",
          );
          if (existsSync(databasePath)) {
            const db = new Database(databasePath, { readonly: true });
            try {
              const claims = db
                .query<{ count: number }, [string]>(
                  "SELECT count(*) AS count FROM runtime_resource_claims WHERE agent_id = ?",
                )
                .get(agentId);
              const generation = db
                .query<{ active: number; launch_generation: string }, [string]>(
                  "SELECT active, launch_generation FROM launchd_generation_state WHERE agent_id = ?",
                )
                .get(agentId);
              check(
                claims?.count === 0 &&
                  (!generation || generation.active === 0) &&
                  (knownPids.size === 0 ||
                    generation?.launch_generation === lifecycle.at(-1)?.generation),
                "Generated service claims remain active",
              );
              report.finalOwnership = {
                claimCount: claims.count,
                activeGeneration: generation?.active ?? null,
              };
            } finally {
              db.close();
            }
          }
          released = true;
        } catch {
          cleanupErrors.push("service-ownership-unconfirmed");
        }
      }
      report.cleanupConfirmed = released && owned.size === 0;
      if (report.cleanupConfirmed && changed) {
        try {
          writeFileSync(configPath, originalConfig);
          writeFileSync(envPath, originalEnv);
          writeFileSync(join(consumer, "src/http.ts"), originalHttp);
          assertOnlyApplicationEdits(original, snapshot(), []);
          check(
            applicationHash(read("bun.lock")) === lock,
            "Generated service changed consumer lock",
          );
        } catch {
          cleanupErrors.push("source-restoration-failed");
        }
      } else if (!report.cleanupConfirmed)
        report.retainedFixture = {
          consumer,
          home,
          label,
          agentId,
          reason: "live-or-unknown-ownership",
        };
      try {
        await provider?.stop();
      } catch {
        cleanupErrors.push("provider-stop-failed");
      }
      const serviceLogs = logWatch.stop();
      report.serviceLogs = serviceLogs;
      if (serviceLogs.failure) primary ??= new Error(serviceLogs.failure);
      report.state =
        primary || cleanupErrors.length ? "failed" : unavailable ? "unavailable" : "passed";
      write();
    } finally {
      logWatch.stop();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (primary || cleanupErrors.length)
    throw new Error("Actual generated launchd acceptance failed; inspect authoring-launchd.json");
}

/** Real macOS service acceptance; generated units never substitute for this gate. */
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
  APPLICATION_BOUNDS,
  applicationEnvironment,
  applicationHash,
  assertApplicationCapability,
  assertApplicationDenial,
  assertApplicationTurn,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  snapshotApplicationFiles,
  startApplicationChild,
} from "./application-consumer";
import { applicationHttp } from "./application-http";
import { correlateApplicationTurn, readApplicationRecords } from "./application-records";
import type { InstalledApplicationOptions } from "./application-runner";
import { redactEvidence } from "./export-evidence";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
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
export function applicationLaunchdAvailability(platform: string) {
  return platform === "darwin"
    ? { available: true as const }
    : { available: false as const, reason: "macos-launchd-required" as const };
}
interface LaunchExpectation {
  agentId: string;
  name: string;
  consumer: string;
  configPath: string;
  home: string;
  cli: string;
  bun: string;
  port: number;
}
/** Input must be real plutil JSON; this inspector grants no execution ownership. */
export function inspectApplicationLaunchdPlist(value: unknown, expected: LaunchExpectation) {
  check(object(value) && object(value.EnvironmentVariables), "Invalid installed launchd plist");
  const args = [
    expected.bun,
    "run",
    expected.cli,
    "dev",
    expected.name,
    "--config",
    expected.configPath,
    "--internal-mode",
    "launchd",
  ];
  const label = `com.auggy.agent.${expected.agentId}`;
  check(
    value.Label === label &&
      JSON.stringify(value.ProgramArguments) === JSON.stringify(args) &&
      value.WorkingDirectory === expected.consumer &&
      value.KeepAlive === true &&
      value.RunAtLoad === true &&
      value.ThrottleInterval === 10 &&
      value.EnvironmentVariables.HOME === expected.home,
    "Installed launchd unit does not select the exact local application",
  );
  const generation = value.EnvironmentVariables.AUGGY_LAUNCH_GENERATION;
  check(
    typeof generation === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation),
    "Installed launchd generation is missing or malformed",
  );
  check(
    value.StandardOutPath === join(expected.home, ".auggy/logs", `${expected.agentId}.log`) &&
      value.StandardErrorPath === join(expected.home, ".auggy/logs", `${expected.agentId}.err`) &&
      Object.keys(value.EnvironmentVariables).sort().join(",") ===
        "AUGGY_LAUNCH_GENERATION,HOME,PATH",
    "Launchd unit leaked environment or escaped isolated log ownership",
  );
  return { label, generation, arguments: args, workingDirectory: expected.consumer };
}
export function inspectApplicationLaunchdManifest(
  value: unknown,
  expected: LaunchExpectation,
  generation: string,
) {
  check(
    object(value) &&
      value.agentId === expected.agentId &&
      value.name === expected.name &&
      value.mode === "launchd" &&
      value.launchGeneration === generation &&
      value.configPath === expected.configPath &&
      value.agentDir === expected.consumer &&
      value.port === expected.port &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 1 &&
      typeof value.claimNonce === "string" &&
      /^[0-9a-f-]{36}$/.test(value.claimNonce) &&
      typeof value.processIdentity === "string" &&
      /^ps-sha256:[0-9a-f]{64}$/.test(value.processIdentity) &&
      value.resourceClaimStore === "sqlite-v1",
    "Runtime manifest does not acknowledge the exact launchd installation",
  );
  return {
    pid: Number(value.pid),
    claimNonce: value.claimNonce,
    processIdentity: value.processIdentity,
    generation,
  };
}
/** Successful full listing distinguishes absence from a failed inspection command. */
export function applicationLaunchdListedPid(
  text: string,
  label: string,
): number | null | undefined {
  check(/^PID\s+Status\s+Label\s*$/m.test(text), "Malformed launchctl service listing header");
  const matches = text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length === 3 && columns[2] === label);
  check(matches.length <= 1, "Duplicate launchd label in actual service listing");
  if (!matches[0]) return undefined;
  if (matches[0][0] === "-") return null;
  check(/^[1-9][0-9]*$/.test(matches[0][0]!), "Malformed launchd PID listing");
  const pid = Number(matches[0][0]);
  check(Number.isSafeInteger(pid), "Malformed launchd PID listing");
  return pid;
}
function regularJson(path: string, limit = 32_768): unknown {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, "Invalid service metadata");
  return JSON.parse(readFileSync(path, "utf8"));
}
function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function runInstalledApplicationLaunchd(options: InstalledApplicationOptions) {
  try {
    return await executeInstalledApplicationLaunchd(options);
  } catch (error) {
    const path = join(resolve(options.evidenceDirectory), "application-launchd.json");
    if (existsSync(path)) {
      const report = regularJson(path, APPLICATION_BOUNDS.outputBytes);
      if (object(report) && report.state === "running") {
        report.state = "failed";
        report.failure = "setup-or-evidence-failure";
        writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      }
    }
    throw error;
  }
}

async function executeInstalledApplicationLaunchd(options: InstalledApplicationOptions) {
  const evidenceDirectory = resolve(options.evidenceDirectory);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    row: "L12-macos-launchd",
    state: "running",
    platform: process.platform,
    bun: Bun.version,
    cleanupConfirmed: false,
    generatedUnitAcceptance: "separate; never substituted for actual launchd",
    commands: [],
    lifecycle: [],
    scenarios: {},
    cleanupErrors: [],
  };
  const secrets = [PROVIDER_FIXTURE_API_KEY];
  const write = () =>
    writeFileSync(
      join(evidenceDirectory, "application-launchd.json"),
      `${redactEvidence(JSON.stringify(report, null, 2), secrets)}\n`,
      { mode: 0o600 },
    );
  const availability = applicationLaunchdAvailability(process.platform);
  if (!availability.available) {
    Object.assign(report, {
      state: "unavailable",
      reason: availability.reason,
      cleanupConfirmed: true,
    });
    write();
    return report;
  }
  write();
  const consumer = realpathSync(options.consumer),
    home = realpathSync(options.home),
    repoRoot = realpathSync(options.repoRoot);
  check(
    home !== realpathSync(homedir()) &&
      !inside(consumer, repoRoot) &&
      !inside(home, repoRoot) &&
      !existsSync(join(home, ".auggy")) &&
      !existsSync(join(consumer, ".env")) &&
      !existsSync(join(consumer, "data")),
    "Launchd acceptance requires a fresh isolated consumer and HOME, with no live user state",
  );
  assertApplicationCapability(options.core.manifest);
  const local = assertInstalledApplicationArtifact(consumer, repoRoot, options.core, "auggy/cli");
  const application = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.core,
    "auggy/application",
  );
  const adapter = assertInstalledApplicationArtifact(
    consumer,
    repoRoot,
    options.provider,
    "@auggy/anthropic",
  );
  const original = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
  const lockSHA256 = applicationHash(readFileSync(join(consumer, "bun.lock")));
  const configPath = join(consumer, "agent.yaml"),
    originalConfig = readFileSync(configPath);
  const config: unknown = parse(originalConfig.toString("utf8"));
  check(object(config) && Array.isArray(config.augments), "Missing reference inline configuration");
  check(
    config.id === "${AUGGY_AGENT_ID}",
    "Launchd fixture must not reuse an existing agent identity",
  );
  const web = config.augments.filter((entry) => object(entry) && entry.type === "webTransport");
  check(web.length === 1 && object(web[0]) && object(web[0].options), "Expected one web listener");
  const agentId = `aug1_${randomUUID()}`,
    label = `com.auggy.agent.${agentId}`;
  config.id = agentId;
  const envPath = join(consumer, ".env"),
    storePath = join(home, ".auggy/plists", `${label}.plist`),
    installPath = join(home, "Library/LaunchAgents", `${label}.plist`),
    manifestPath = join(home, ".auggy", `${agentId}.json`);
  const env = applicationEnvironment(home, options.temporaryDirectory);
  const ownedCommands = new Set<ReturnType<typeof startApplicationChild>>();
  const commands = report.commands as Record<string, unknown>[],
    lifecycle = report.lifecycle as Record<string, unknown>[],
    scenarios = report.scenarios as Record<string, unknown>,
    cleanupErrors = report.cleanupErrors as string[];
  const command = async (args: readonly string[], keepOutput = true) => {
    check(commands.length < 64, "Launchd command count exceeded its bound");
    const child = startApplicationChild({
      command: args,
      cwd: consumer,
      env,
      secrets,
      timeoutMs: args[2] === "stop" ? APPLICATION_BOUNDS.shutdownMs : 30_000,
    });
    ownedCommands.add(child);
    const result = await child.finish();
    if (result.cleanupConfirmed) ownedCommands.delete(child);
    commands.push({
      command: args,
      cwd: consumer,
      ...result,
      ...(!keepOutput
        ? { stdout: "[metadata inspected privately]", stderr: "[metadata inspected privately]" }
        : {}),
    });
    write();
    check(
      result.cleanupConfirmed &&
        !result.timedOut &&
        !result.spawnFailed &&
        !result.exceededOutput &&
        !result.orphanedGroup,
      "Launchd control command did not settle within its bound",
    );
    return result;
  };
  const listing = async () => {
    const result = await command(["/bin/launchctl", "list"], false);
    check(result.exitCode === 0, "Actual launchctl listing is unavailable");
    return applicationLaunchdListedPid(result.stdout, label);
  };
  const cli = async (...args: string[]) => {
    const result = await command([process.execPath, local.entry, ...args]);
    check(result.exitCode === 0 && result.signal === null, "Actual local launchd command failed");
  };
  let serviceAttempted = false,
    environmentWritten = false,
    configWritten = false;
  let provider: ReturnType<typeof createProviderFixture> | undefined;
  const knownPids = new Set<number>(),
    abort = new AbortController();
  const onSignal = () => {
    abort.abort(new Error("Launchd acceptance interrupted"));
    for (const child of ownedCommands) child.signal("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let primary: unknown;
  let unavailable = false;
  try {
    const initialListing = await command(["/bin/launchctl", "list"], false);
    if (initialListing.exitCode !== 0) {
      unavailable = true;
      throw new Error("launchctl-domain-unavailable");
    }
    check(
      applicationLaunchdListedPid(initialListing.stdout, label) === undefined,
      "Refusing to touch a pre-existing launchd label",
    );
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    check(typeof port === "number", "Ephemeral launchd listener port was not assigned");
    check(typeof config.name === "string", "Reference name is missing");
    const expected: LaunchExpectation = {
      agentId,
      name: config.name,
      consumer,
      configPath,
      home,
      cli: local.entry,
      bun: process.execPath,
      port,
    };
    const bearer = randomBytes(32).toString("hex"),
      baseURL = `http://127.0.0.1:${port}`;
    secrets.push(bearer);
    const http = applicationHttp(baseURL, bearer);
    provider = createProviderFixture({
      tool: options.recipe.tool,
      toolResultSentinel: options.expectedToolOutput,
    });
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
    writeFileSync(
      envPath,
      `ANTHROPIC_API_KEY=${PROVIDER_FIXTURE_API_KEY}\nAUGGY_WEB_TOKEN=${bearer}\nAUGGY_PUBLIC_URL=${baseURL}\n`,
      { mode: 0o600, flag: "wx" },
    );
    environmentWritten = true;
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    configWritten = true;
    Object.assign(report, {
      consumer,
      home,
      agentId,
      label,
      local,
      application,
      adapter,
      lockSHA256,
      originalSources: original,
      configuredSources: snapshotApplicationFiles(consumer, options.recipe.sourceFiles),
      servicePaths: { storePath, installPath, manifestPath },
      actualUserLaunchAgentsTouched: false,
    });
    write();
    const records = () => readApplicationRecords(consumer, options.recipe);
    const counters = () => {
      const current = records();
      return [
        provider!.evidence().calls,
        current.turns.length,
        current.finalization.length,
        current.tools.length,
      ];
    };
    const ready = async (priorStarts: number, priorCounters: number[]) => {
      const deadline = Date.now() + APPLICATION_BOUNDS.readinessMs;
      while (true) {
        abort.signal.throwIfAborted();
        let healthy = false;
        try {
          const response = await http.request("/health", { timeoutMs: 1000, signal: abort.signal });
          healthy = response.status === 200 && JSON.parse(response.body)?.status === "healthy";
        } catch {
          /* Bounded listener startup retries only. */
        }
        if (healthy && records().startup.length > priorStarts && existsSync(manifestPath)) break;
        check(Date.now() < deadline, "Launchd application readiness timed out");
        await Bun.sleep(100);
      }
      check(
        lstatSync(installPath).isSymbolicLink() && realpathSync(installPath) === storePath,
        "Installed launchd symlink escaped isolated control ownership",
      );
      const plistStat = lstatSync(storePath);
      check(
        plistStat.isFile() && !plistStat.isSymbolicLink() && plistStat.size <= 32_768,
        "Invalid installed plist file",
      );
      const parsed = await command(
        ["/usr/bin/plutil", "-convert", "json", "-o", "-", storePath],
        false,
      );
      check(parsed.exitCode === 0, "Cannot decode the actual installed plist");
      const unit = inspectApplicationLaunchdPlist(JSON.parse(parsed.stdout), expected);
      const manifest = inspectApplicationLaunchdManifest(
        regularJson(manifestPath),
        expected,
        unit.generation,
      );
      knownPids.add(manifest.pid);
      check(
        !processGone(manifest.pid) && (await listing()) === manifest.pid,
        "launchctl and runtime PID disagree",
      );
      let domain: string | undefined;
      for (const candidate of [`gui/${process.getuid!()}`, `user/${process.getuid!()}`]) {
        const result = await command(["/bin/launchctl", "print", `${candidate}/${label}`], false);
        if (
          result.exitCode === 0 &&
          new RegExp(`\\bpid = ${manifest.pid}\\b`).test(result.stdout)
        ) {
          domain = candidate;
          break;
        }
      }
      check(domain, "Unable to bind the actual launchd domain to the acknowledged PID");
      const startup = records().startup;
      check(startup.length === priorStarts + 1, "Launchd invoked project main more than once");
      const event = startup.at(-1)!;
      const asPath = (value: unknown) => {
        check(typeof value === "string", "Missing startup source navigation");
        return realpathSync(value.startsWith("file:") ? fileURLToPath(value) : value);
      };
      check(
        event.event === "application.ready" &&
          event.mode === "launchd" &&
          event.label === "inspectable-agent" &&
          asPath(event.appSource) === realpathSync(join(consumer, options.recipe.entrypoint)) &&
          asPath(event.processEntry) === local.entry &&
          asPath(event.applicationModule) === application.entry &&
          Array.isArray(event.bindings) &&
          event.bindings.some((binding) => object(binding) && binding.port === port),
        "launchd did not execute the actual selected application main/listener",
      );
      check(
        JSON.stringify(counters()) === JSON.stringify(priorCounters),
        "Service startup unexpectedly executed a turn",
      );
      lifecycle.push({
        event: "ready",
        domain,
        ...manifest,
        unit,
        startup: event,
        plistSHA256: applicationHash(readFileSync(storePath)),
        manifestSHA256: applicationHash(readFileSync(manifestPath)),
      });
      write();
      return manifest;
    };
    const request = async (phase: string) => {
      provider!.setScenario("success");
      const before = counters();
      const denial = await http.request("/agent/run", {
        method: "POST",
        auth: "missing",
        signal: abort.signal,
        json: {
          threadId: randomUUID(),
          messages: [{ role: "user", content: options.recipe.userMessage }],
        },
      });
      assertApplicationDenial(denial.status, before, counters());
      const threadId = `launchd-${randomUUID()}`;
      const response = await http.request("/agent/run", {
        method: "POST",
        idempotencyKey: randomUUID(),
        signal: abort.signal,
        json: { threadId, messages: [{ role: "user", content: options.recipe.userMessage }] },
      });
      const deadline = Date.now() + 5000;
      let result: ReturnType<typeof correlateApplicationTurn> | undefined;
      while (!result?.trace && Date.now() < deadline) {
        try {
          result = correlateApplicationTurn({
            records: records(),
            threadId,
            expectedToolOutput: options.expectedToolOutput,
            toolName: options.recipe.tool.name,
          });
        } catch {
          /* Await actual post-turn records. */
        }
        if (!result?.trace) await Bun.sleep(25);
      }
      check(
        result?.trace && response.headers["x-auggy-application"] === "inspectable-agent",
        "Actual launchd turn diagnostics missing",
      );
      const proof = assertApplicationTurn({
        httpStatus: response.status,
        body: response.body,
        threadId,
        expectedCalls: 2,
        toolName: options.recipe.tool.name,
        provider: provider!.evidence(),
        trace: result.trace,
        finalization: result.finalization,
        toolExecutions: result.tools.length,
        history: "memory-only",
        expectedFinalText: PROVIDER_FIXTURE_FINAL_TEXT,
      });
      const usage = result.completed?.usage;
      check(
        object(usage) &&
          usage.inputTokens === 22 &&
          usage.outputTokens === 14 &&
          usage.costUsd === 0 &&
          usage.unpricedSteps === 0 &&
          result.finalization.trace.recordedInferenceSteps === 2 &&
          result.finalization.trace.snapshot === "recorded",
        "Launchd turn lacks real provider usage corroboration",
      );
      scenarios[phase] = {
        state: "passed",
        ...proof,
        provider: provider!.evidence(),
        finalization: result.finalization,
        usage,
        denialStatus: denial.status,
      };
      write();
    };
    const initialCounters = counters();
    serviceAttempted = true;
    await cli("start", "--config", configPath);
    const first = await ready(0, initialCounters);
    await request("initial-turn");
    const restartCounters = counters();
    await cli("restart", agentId, "--config", configPath);
    const second = await ready(1, restartCounters);
    check(
      first.generation !== second.generation &&
        first.claimNonce !== second.claimNonce &&
        first.pid !== second.pid &&
        processGone(first.pid),
      "Restart did not replace and reap the acknowledged installation generation",
    );
    await request("restarted-turn");
  } catch (error) {
    if (unavailable) report.reason = "launchctl-domain-unavailable";
    else primary = error;
    report.failure = redactEvidence(
      error instanceof Error ? error.message : "launchd acceptance failed",
      secrets,
    );
  } finally {
    try {
      if (serviceAttempted) {
        try {
          await cli("stop", agentId);
        } catch {
          cleanupErrors.push("service-stop-failed");
        }
      }
      for (const child of ownedCommands) {
        try {
          const result = await child.stop();
          if (result.cleanupConfirmed) ownedCommands.delete(child);
          else cleanupErrors.push("control-process-unconfirmed");
        } catch {
          cleanupErrors.push("control-process-cleanup-failed");
        }
      }
      let released = !serviceAttempted;
      if (serviceAttempted) {
        try {
          check(
            (await listing()) === undefined &&
              !existsSync(installPath) &&
              !existsSync(storePath) &&
              !existsSync(manifestPath) &&
              [...knownPids].every(processGone),
            "Service ownership remains live or unknown",
          );
          const databasePath = join(home, ".auggy/runtime-claims.sqlite");
          check(
            knownPids.size === 0 || existsSync(databasePath),
            "Started runtime lost its claim database",
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
                "Runtime claims or launch generation remain active",
              );
              report.finalOwnership = {
                claimCount: claims.count,
                activeGeneration: generation?.active ?? null,
                generation: generation?.launch_generation ?? null,
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
      const cleanupConfirmed = released && ownedCommands.size === 0;
      report.cleanupConfirmed = cleanupConfirmed;
      if (cleanupConfirmed) {
        try {
          if (configWritten) writeFileSync(configPath, originalConfig);
          if (environmentWritten) unlinkSync(envPath);
          assertOnlyApplicationEdits(
            original,
            snapshotApplicationFiles(consumer, options.recipe.sourceFiles),
            [],
          );
          check(
            applicationHash(readFileSync(join(consumer, "bun.lock"))) === lockSHA256,
            "Launchd run changed the consumer lock",
          );
        } catch {
          cleanupErrors.push("fixture-restoration-failed");
        }
      } else
        report.retainedFixture = {
          consumer,
          home,
          agentId,
          label,
          reason: "live-or-unknown-ownership",
        };
      try {
        await provider?.stop();
      } catch {
        cleanupErrors.push("provider-stop-failed");
      }
      report.state =
        primary || cleanupErrors.length ? "failed" : unavailable ? "unavailable" : "passed";
      write();
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
  if (primary || cleanupErrors.length)
    throw new Error("Actual launchd acceptance failed; inspect application-launchd.json");
  return report;
}

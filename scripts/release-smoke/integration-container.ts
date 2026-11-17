/** Real Docker operations with exact run ownership. No prune or host implementation mounts. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeploymentProfile } from "../../src/cli/deploy/contracts";
import { runAcceptedBuildCommand } from "./accepted-main-artifacts";
import { applicationHash } from "./application-consumer";
import { INTEGRATION_LIMITS } from "./integration-contracts";
import {
  assertIntegrationEnvironment,
  createIntegrationBudget,
  readIntegrationFile,
  redactIntegrationDiagnostic,
  withIntegrationChild,
} from "./integration-consumer";

const OWNER_LABEL = "org.auggy.integration.run";
const COMMAND_MS = INTEGRATION_LIMITS.scenarioMs;
const RESOURCE_LIMITS = Object.freeze({ volume: 4, image: 4, container: 8 });
const WORK_COMMANDS = 128;
// One exact ownership inspection and one removal for each possible reserved resource.
const CLEANUP_COMMANDS = 2 * Object.values(RESOURCE_LIMITS).reduce((sum, count) => sum + count, 0);

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

type DockerOptions = {
  cwd: string;
  env: Record<string, string>;
  binary?: string;
  secrets: readonly string[];
};
type Resource = { kind: "container" | "image" | "volume"; id: string };

/** Server query, not docker --version. An unavailable daemon never becomes container acceptance. */
export async function probeIntegrationDocker(options: DockerOptions) {
  assertIntegrationEnvironment(options.env);
  const result = await runAcceptedBuildCommand({
    command: [options.binary ?? "docker", "info", "--format", "{{json .ServerVersion}}"],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: INTEGRATION_LIMITS.readinessRequestMs,
    maxOutputBytes: 64 * 1024,
  });
  if (result.status !== "passed" || result.cleanupUnknown)
    return {
      status: "unavailable" as const,
      reason: "Docker server query failed",
      cleanupConfirmed: !result.cleanupUnknown,
    };
  let version: unknown;
  try {
    version = JSON.parse(result.stdout.trim());
  } catch {
    version = null;
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))
    return {
      status: "unavailable" as const,
      reason: "Docker server identity is invalid",
      cleanupConfirmed: true,
    };
  return { status: "available" as const, version, cleanupConfirmed: true };
}

export interface IntegrationDockerScope {
  createVolume(): Promise<string>;
  build(options: { context: string; exportSHA256: string }): Promise<{ imageId: string }>;
  assertFrozenLockFailure(options: { context: string; exportSHA256: string }): Promise<void>;
  start(options: {
    imageId: string;
    volume: string;
    profile: DeploymentProfile;
    env: Readonly<Record<string, string>>;
  }): Promise<{ containerId: string; origin: string | null }>;
  /** Explicit operator workspace; does not start Auggy or repair permissions implicitly. */
  startUtility(options: {
    imageId: string;
    volume: string;
    restoreVolume?: string;
    env: Readonly<Record<string, string>>;
  }): Promise<{ containerId: string }>;
  status(containerId: string): Promise<{ running: boolean; exitCode: number }>;
  logs(containerId: string): Promise<string>;
  imageMetadata(
    imageId: string,
  ): Promise<{ user: string; exposedPorts: string[]; hasPortEnvironment: boolean }>;
  stop(containerId: string): Promise<void>;
  /** Only bounded explicit commands inside this run's container; caller owns recovery semantics. */
  exec(containerId: string, arguments_: readonly string[]): Promise<{ stdout: string }>;
}

/**
 * Caller must validate exported manifest/source before entry. Build/run are actual daemon actions.
 * Local Docker proof and Railway proof remain independent; this scope never contacts Railway.
 */
export async function withIntegrationDocker<T>(
  options: DockerOptions & { runId: string; timeoutMs?: number; signal?: AbortSignal },
  observe: (scope: IntegrationDockerScope) => Promise<T>,
) {
  check(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.runId),
    "Docker integration run needs a UUID",
  );
  const availability = await probeIntegrationDocker(options);
  if (availability.status === "unavailable")
    return {
      status: "unavailable" as const,
      availability,
      cleanup: {
        status: availability.cleanupConfirmed ? ("not-needed" as const) : ("failed" as const),
        remainingOwnedIds: [] as string[],
      },
    };
  const budget = createIntegrationBudget(
    options.timeoutMs ?? INTEGRATION_LIMITS.phaseBuildMs,
    options.signal,
  );
  const directory = mkdtempSync(join(realpathSync(options.cwd), ".m5-docker-"));
  const resources: Resource[] = [];
  const candidates: Resource[] = [];
  const confirmedAbsent = new Set<Resource>();
  const commands: {
    label: string;
    status: "passed" | "failed";
    durationMs: number;
    cleanupUnknown: boolean;
    stdoutSHA256: string;
    stderrSHA256: string;
    failureDiagnostic?: string;
  }[] = [];
  let workCalls = 0;
  let cleanupCalls = 0;
  let commandCleanupFailed = false;
  let active = true;
  let cleanupBudget: ReturnType<typeof createIntegrationBudget> | undefined;
  const pendingCommands = new Set<ReturnType<typeof withIntegrationChild>>();
  const binary = options.binary ?? "docker";
  const execute = async (
    label: string,
    args: readonly string[],
    cleanup = false,
    frozenFailure = false,
  ) => {
    check(cleanup || (active && !budget.signal.aborted), "Docker phase has ended");
    if (cleanup)
      check(++cleanupCalls <= CLEANUP_COMMANDS, "Docker cleanup command count exceeded bound");
    else check(++workCalls <= WORK_COMMANDS, "Docker integration command count exceeded bound");
    check(
      args.length <= 64 && args.every((arg) => arg.length <= 4096 && !arg.includes("\0")),
      "Docker command exceeded argument bound",
    );
    const timeoutMs = cleanup
      ? Math.min(INTEGRATION_LIMITS.shutdownMs, cleanupBudget?.remainingMs() ?? 0)
      : Math.min(COMMAND_MS, budget.remainingMs());
    check(timeoutMs > 0, "Docker phase deadline exceeded");
    const operation = withIntegrationChild(
      {
        label,
        command: [binary, ...args],
        cwd: options.cwd,
        env: options.env,
        secrets: options.secrets,
        signal: cleanup ? cleanupBudget!.signal : budget.signal,
        timeoutMs,
        maxOutputBytes: INTEGRATION_LIMITS.outputBytes,
      },
      async ({ child }) => {
        await child.finish();
      },
    );
    pendingCommands.add(operation);
    const result = await operation.finally(() => {
      pendingCommands.delete(operation);
    });
    commandCleanupFailed ||= !result.process.cleanupConfirmed;
    const stdout = redactIntegrationDiagnostic(result.process.stdout, options.secrets);
    const stderr = redactIntegrationDiagnostic(result.process.stderr, options.secrets);
    commands.push({
      label,
      status: result.status,
      durationMs: result.process.durationMs,
      cleanupUnknown: !result.process.cleanupConfirmed,
      stdoutSHA256: applicationHash(stdout),
      stderrSHA256: applicationHash(stderr),
      ...(result.status === "failed" && !frozenFailure
        ? { failureDiagnostic: stderr.slice(-2048) }
        : {}),
    });
    if (frozenFailure) {
      check(
        result.status === "failed" &&
          result.process.cleanupConfirmed &&
          result.process.exitCode !== null &&
          result.process.exitCode > 0 &&
          !result.process.spawnFailed &&
          !result.process.timedOut &&
          !result.process.exceededOutput &&
          !result.process.forced &&
          !result.process.orphanedGroup &&
          `${stdout}\n${stderr}`.includes("lockfile had changes, but lockfile is frozen"),
        "Expected a normally exited frozen-lock build rejection",
      );
    } else
      check(
        result.status === "passed" && result.process.cleanupConfirmed,
        "Docker integration command failed",
      );
    return (label === "container-logs" ? `${stdout}\n${stderr}` : stdout).trim();
  };
  const owned = async (resource: Resource, cleanup: boolean) => {
    const template = resource.kind === "volume" ? "{{json .Labels}}" : "{{json .Config.Labels}}";
    const result = await execute(
      "verify-resource-owner",
      [resource.kind, "inspect", "--format", template, resource.id],
      cleanup,
    );
    const labels: unknown = JSON.parse(result);
    check(
      labels !== null &&
        typeof labels === "object" &&
        !Array.isArray(labels) &&
        (labels as Record<string, unknown>)[OWNER_LABEL] === options.runId,
      "Docker resource does not belong to this run",
    );
  };
  const requireResource = (kind: Resource["kind"], id: string) => {
    const resource = resources.find((item) => item.kind === kind && item.id === id);
    check(resource, "Docker operation requires a resource created by this run");
    return resource;
  };
  const reserve = (kind: Resource["kind"], id: string): Resource => {
    check(active && !budget.signal.aborted, "Docker phase has ended");
    check(
      candidates.filter((item) => item.kind === kind).length < RESOURCE_LIMITS[kind],
      `Docker ${kind} count exceeded bound`,
    );
    const candidate = { kind, id };
    // Reserve before any asynchronous command: in-flight and uncertain creates still consume capacity.
    // Keep the reservation until final cleanup even if command output never confirms creation.
    candidates.push(candidate);
    return candidate;
  };
  const startOwnedContainer = async (input: {
    imageId: string;
    volume: string;
    profile: DeploymentProfile;
    env: Readonly<Record<string, string>>;
    utility?: boolean;
    restoreVolume?: string;
  }) => {
    await owned(requireResource("image", input.imageId), false);
    await owned(requireResource("volume", input.volume), false);
    if (input.restoreVolume) {
      check(input.utility && input.restoreVolume !== input.volume, "Invalid utility restore mount");
      await owned(requireResource("volume", input.restoreVolume), false);
    }
    assertIntegrationEnvironment(input.env);
    check(
      Object.entries(input.env).every(([key, value]) => !/[\r\n]/.test(key + value)),
      "Docker env file values must be single-line",
    );
    if (input.profile.kind === "http")
      check(
        Number.isSafeInteger(input.profile.port) &&
          input.profile.port > 0 &&
          input.profile.port <= 65535,
        "Docker HTTP profile has an invalid port",
      );
    const name = `auggy-m5-${options.runId}-${randomUUID()}`;
    reserve("container", name);
    const envFile = join(directory, `${randomUUID()}.env`);
    writeFileSync(
      envFile,
      `${Object.entries(input.env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    let containerId: string;
    try {
      containerId = await execute("create-container", [
        "create",
        "--name",
        name,
        "--label",
        `${OWNER_LABEL}=${options.runId}`,
        "--mount",
        `type=volume,src=${input.volume},dst=/app/data`,
        ...(input.restoreVolume
          ? ["--mount", `type=volume,src=${input.restoreVolume},dst=/restore`]
          : []),
        "--env-file",
        envFile,
        ...(input.profile.kind === "http" ? ["--publish", `127.0.0.1::${input.profile.port}`] : []),
        ...(input.utility ? ["--entrypoint", "bun"] : []),
        input.imageId,
        ...(input.utility
          ? [
              "--no-env-file",
              "--no-install",
              "--config=/dev/null",
              "-e",
              "setInterval(() => {}, 1000)",
            ]
          : []),
      ]);
    } finally {
      rmSync(envFile, { force: true });
    }
    check(/^[a-f0-9]{64}$/.test(containerId), "Docker container identity is invalid");
    const resource = { kind: "container" as const, id: containerId };
    await owned(resource, false);
    resources.push(resource);
    await execute("start-container", ["start", containerId]);
    let origin: string | null = null;
    if (input.profile.kind === "http") {
      const mapping = await execute("read-container-port", [
        "port",
        containerId,
        `${input.profile.port}/tcp`,
      ]);
      const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
      check(
        match && Number(match[1]) > 0 && Number(match[1]) <= 65535,
        "Container port mapping is not loopback",
      );
      origin = `http://127.0.0.1:${match[1]}`;
    }
    return { containerId, origin };
  };
  const scope: IntegrationDockerScope = {
    async createVolume() {
      const name = `auggy-m5-${options.runId}-${randomUUID()}`;
      const candidate = reserve("volume", name);
      const created = await execute("create-volume", [
        "volume",
        "create",
        "--label",
        `${OWNER_LABEL}=${options.runId}`,
        name,
      ]);
      check(created === name, "Docker returned an unexpected volume identity");
      await owned(candidate, false);
      resources.push(candidate);
      return name;
    },
    async build(input) {
      const context = realpathSync(input.context);
      const manifest = readIntegrationFile(context, "auggy-deployment.json", 4 * 1024 * 1024);
      check(
        /^[a-f0-9]{64}$/.test(input.exportSHA256) &&
          applicationHash(manifest) === input.exportSHA256,
        "Docker export identity mismatch",
      );
      const tag = `auggy-m5:${options.runId}-${randomUUID()}`;
      reserve("image", tag);
      const iidName = `${randomUUID()}.iid`;
      await execute("build-image", [
        "build",
        "--label",
        `${OWNER_LABEL}=${options.runId}`,
        "--iidfile",
        join(directory, iidName),
        "--tag",
        tag,
        context,
      ]);
      const imageId = readIntegrationFile(directory, iidName, 128).toString("utf8").trim();
      check(/^sha256:[a-f0-9]{64}$/.test(imageId), "Docker image identity is invalid");
      await owned({ kind: "image", id: imageId }, false);
      resources.push({ kind: "image", id: imageId });
      return { imageId };
    },
    async assertFrozenLockFailure(input) {
      const context = realpathSync(input.context);
      const manifest = readIntegrationFile(context, "auggy-deployment.json", 4 * 1024 * 1024);
      check(
        /^[a-f0-9]{64}$/.test(input.exportSHA256) &&
          applicationHash(manifest) === input.exportSHA256,
        "Docker export identity mismatch",
      );
      const tag = `auggy-m5:${options.runId}-${randomUUID()}`;
      const candidate = reserve("image", tag);
      await execute(
        "reject-stale-frozen-lock",
        ["build", "--label", `${OWNER_LABEL}=${options.runId}`, "--tag", tag, context],
        false,
        true,
      );
      const residue = await execute("verify-failed-image-absent", [
        "image",
        "ls",
        "--format",
        "{{.ID}}",
        "--filter",
        `reference=${tag}`,
      ]);
      check(residue === "", "Rejected build left an unexpected image");
      confirmedAbsent.add(candidate);
    },
    start: startOwnedContainer,
    async startUtility(input) {
      const result = await startOwnedContainer({
        ...input,
        utility: true,
        profile: { kind: "none" },
      });
      return { containerId: result.containerId };
    },
    async status(containerId) {
      await owned(requireResource("container", containerId), false);
      const state = JSON.parse(
        await execute("container-status", [
          "container",
          "inspect",
          "--format",
          "{{json .State}}",
          containerId,
        ]),
      ) as Record<string, unknown>;
      check(
        state && typeof state.Running === "boolean" && Number.isSafeInteger(state.ExitCode),
        "Invalid container process state",
      );
      return { running: state.Running, exitCode: state.ExitCode as number };
    },
    async logs(containerId) {
      await owned(requireResource("container", containerId), false);
      // Acceptance needs complete history: truncation can hide a factory or unauthorized effect.
      // The existing process output ceiling fails the observation instead of accepting a suffix.
      return execute("container-logs", ["logs", containerId]);
    },
    async imageMetadata(imageId) {
      await owned(requireResource("image", imageId), false);
      const config = JSON.parse(
        await execute("image-metadata", [
          "image",
          "inspect",
          "--format",
          "{{json .Config}}",
          imageId,
        ]),
      ) as Record<string, unknown>;
      check(
        config &&
          (config.User === undefined || typeof config.User === "string") &&
          Array.isArray(config.Env) &&
          config.Env.length <= 128 &&
          config.Env.every((value: unknown) => typeof value === "string"),
        "Invalid image metadata",
      );
      const ports = config.ExposedPorts;
      check(
        ports === null ||
          ports === undefined ||
          (typeof ports === "object" && !Array.isArray(ports)),
        "Invalid image ports",
      );
      const exposedPorts = Object.keys((ports ?? {}) as object);
      check(
        exposedPorts.length <= 128 &&
          exposedPorts.every((port) => /^\d{1,5}\/(?:tcp|udp)$/.test(port)),
        "Invalid image port inventory",
      );
      return {
        user: (config.User as string | undefined) ?? "",
        exposedPorts,
        hasPortEnvironment: (config.Env as string[]).some((value) => value.startsWith("PORT=")),
      };
    },
    async stop(containerId) {
      await owned(requireResource("container", containerId), false);
      await execute("stop-container", ["stop", "--time", "15", containerId]);
    },
    async exec(containerId, arguments_) {
      await owned(requireResource("container", containerId), false);
      check(arguments_.length > 0, "Container execution requires an explicit command");
      return { stdout: await execute("container-command", ["exec", containerId, ...arguments_]) };
    },
  };
  let value: T | undefined;
  let passed = false;
  const remainingOwnedIds: string[] = [];
  try {
    value = await budget.run(INTEGRATION_LIMITS.phaseBuildMs, () => observe(scope));
    passed = true;
  } catch {
    // Details remain in bounded, redacted private command diagnostics, never raw exceptions.
  } finally {
    active = false;
    // Disposal aborts every live work command, whose supervisor kills its owned process group.
    budget.dispose();
    let drained = false;
    try {
      // Await the actual bounded kill/reap results, not a race that abandons a still-running CLI.
      // Each supervisor has the existing 15s shutdown + 5s reap ceiling; they settle in parallel.
      const terminal = await Promise.allSettled([...pendingCommands]);
      drained =
        !commandCleanupFailed &&
        terminal.every(
          (result) => result.status === "fulfilled" && result.value.process.cleanupConfirmed,
        );
      commandCleanupFailed ||= !drained;
    } catch {
      commandCleanupFailed = true;
    }
    cleanupBudget = createIntegrationBudget(
      INTEGRATION_LIMITS.shutdownMs + INTEGRATION_LIMITS.reapMs,
    );
    // Candidate names recover resources created just before a CLI timeout. Verify exact label first.
    const cleanupResources = [...candidates].reverse();
    for (const resource of cleanupResources) {
      if (confirmedAbsent.has(resource)) continue;
      try {
        check(drained, "Docker command cleanup remains unknown");
        await owned(resource, true);
        await execute(
          "remove-owned-resource",
          resource.kind === "container"
            ? ["container", "rm", "--force", resource.id]
            : resource.kind === "image"
              ? ["image", "rm", resource.id]
              : ["volume", "rm", resource.id],
          true,
        );
      } catch {
        // Absence and an unavailable daemon cannot be conflated; leave a visible conservative failure.
        remainingOwnedIds.push(`${resource.kind}:${resource.id}`);
      }
    }
    if (drained) rmSync(directory, { recursive: true, force: true });
    else remainingOwnedIds.push("local:temporary-files");
    cleanupBudget.dispose();
  }
  const cleaned = remainingOwnedIds.length === 0 && !commandCleanupFailed;
  return {
    status: passed && cleaned ? ("passed" as const) : ("failed" as const),
    ...(passed && cleaned ? { value } : {}),
    availability,
    commands,
    resources,
    cleanup: { status: cleaned ? ("complete" as const) : ("failed" as const), remainingOwnedIds },
  };
}

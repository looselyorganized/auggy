/**
 * Railway CLI subprocess wrapper.
 *
 * Sole owner of `railway` binary knowledge in the codebase. Every Railway
 * operation calls `runRailway(args, opts)` which uses the injected spawn
 * factory (defaults to an owned POSIX process group). Tests override it to mock
 * subprocess behavior without spawning anything.
 *
 * Operator pre-requisites: `railway` CLI installed (https://docs.railway.com/develop/cli)
 * and `railway login` completed. We trust the operator's auth context — same
 * pattern as `git push` trusts `git`. No token storage in this codebase.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { Readable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAllText } from "../_shared/stream";
import { DEPLOYMENT_READINESS_DEFAULTS } from "./contracts";
import { validateHealthPath } from "./profile";

export class RailwayCliMissingError extends Error {
  constructor() {
    super(
      "Railway CLI not found. Install it: https://docs.railway.com/develop/cli, then `railway login`.",
    );
    this.name = "RailwayCliMissingError";
  }
}

export class RailwayNotLoggedInError extends Error {
  constructor(detail: string) {
    super(`Railway CLI not authenticated: ${detail}\nRun \`railway login\` and try again.`);
    this.name = "RailwayNotLoggedInError";
  }
}

export class RailwayWorkspaceRequiredError extends Error {
  constructor(detail: string) {
    super(
      `Railway workspace required: ${detail}\n` +
        "Run `auggy deploy --workspace <workspace>` or enter a Railway workspace when prompted.",
    );
    this.name = "RailwayWorkspaceRequiredError";
  }
}

interface SpawnHandle {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals): void;
  /** True while any process in this handle's owned group still exists. */
  isRunning(): boolean;
}

interface InteractiveSpawnHandle {
  exited: Promise<number>;
}

export type RailwaySpawnFactory = (
  cmd: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    ownedProcessGroup?: boolean;
  },
) => SpawnHandle;

export type RailwayInteractiveSpawnFactory = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => InteractiveSpawnHandle;

type RailwayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CreateRailwayCliOptions {
  spawn?: RailwaySpawnFactory;
  interactiveSpawn?: RailwayInteractiveSpawnFactory;
  fetch?: RailwayFetch;
  railwayConfigPath?: string;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

interface RunOrThrowOptions {
  retryTransient?: boolean;
  acceptNonZero?: (result: { stdout: string; stderr: string; exitCode: number }) => boolean;
}

export interface RailwayStatus {
  project?: { id?: string; name?: string };
  service?: { id?: string; name?: string };
  deployment?: { id?: string; status?: string };
}

export interface RailwayTarget {
  projectId: string;
  serviceId: string;
  environmentId: string;
}

export interface RailwayIngress extends RailwayTarget {
  serviceName: string;
  domains: Array<{ domain: string; targetPort: number | null }>;
  /** Only HTTP-related keys escape the secret-bearing variable response. */
  httpVariables: string[];
  healthPath: string | null;
  replicas: number;
  latestDeploymentId: string | null;
}

export interface RailwayStatusOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  target?: RailwayTarget;
}

export interface RailwayWorkspace {
  id: string;
  name: string;
}

export interface RailwayProject {
  id: string;
  name: string;
  workspaceId?: string;
  workspaceName?: string;
}

const defaultSpawn: RailwaySpawnFactory = (cmd, opts = {}) => {
  // npm's official railway.js wrapper synchronously spawns the native binary.
  // Bounded reads use a detached POSIX group owning both processes; killing
  // only the wrapper leaks the native request and inherited output pipes.
  // Ordinary commands retain foreground process-group signal behavior.
  const ownsGroup = opts.ownedProcessGroup === true;
  if (process.platform === "win32")
    throw new Error(
      "Railway deployment requires POSIX process-group supervision on this platform.",
    );
  const child = spawnChild(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    detached: ownsGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processId = child.pid;
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new RailwayCliMissingError()
          : new Error("Railway subprocess could not start."),
      ),
    );
    child.once("exit", (code) => resolve(code ?? 1));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(opts.stdin);
  return {
    exited,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    kill(signal = "SIGKILL") {
      if (processId === undefined) return;
      try {
        if (ownsGroup) process.kill(-processId, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new RailwaySubprocessCleanupError();
      }
    },
    isRunning() {
      if (processId === undefined) return false;
      if (!ownsGroup) return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-processId, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw new RailwaySubprocessCleanupError();
      }
    },
  };
};

export class RailwaySubprocessCleanupError extends Error {
  constructor() {
    super(
      "Railway subprocess group cleanup could not be verified within its deadline; deployment stopped.",
    );
    this.name = "RailwaySubprocessCleanupError";
  }
}

function commandError(
  args: readonly string[],
  result: { stderr: string; exitCode: number },
): Error {
  return new Error(
    `railway ${args.join(" ")} exited ${result.exitCode}${result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : ""}`,
  );
}

const defaultInteractiveSpawn: RailwayInteractiveSpawnFactory = (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    exited: proc.exited,
  };
};

export interface RailwayCli {
  checkPresence(): Promise<true>;
  checkAuth(): Promise<string>;
  listWorkspaces(): Promise<RailwayWorkspace[]>;
  listProjects(args?: { workspace?: string }): Promise<RailwayProject[]>;
  createProject(args: { projectName: string; workspace?: string; cwd: string }): Promise<string>;
  linkProject(args: { projectId: string; cwd: string }): Promise<void>;
  linkService(args: { serviceName: string; cwd: string }): Promise<void>;
  link(args: { projectId: string; serviceName: string; cwd: string }): Promise<void>;
  createService(args: { serviceName: string; cwd: string }): Promise<void>;
  setVariable(args: { key: string; value: string; cwd: string }): Promise<void>;
  up(args: { cwd: string }): Promise<void>;
  generateDomain(args: { cwd: string; port?: number }): Promise<string>;
  addVolume(args: { name: string; mountPath: string; cwd: string }): Promise<void>;
  status(args: RailwayStatusOptions): Promise<RailwayStatus>;
  inspectIngress(args: { cwd: string }): Promise<RailwayIngress>;
  inspectVolume(args: { cwd: string; target: RailwayTarget }): Promise<string | null>;
  destroyService(args: { cwd: string }): Promise<void>;
  logs(args: { cwd: string }): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function targetId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(
      "Railway did not report a valid linked target. Relink the project, service and environment.",
    );
  }
  return value;
}

const serviceInstanceQuery =
  "query AuggyDeployment($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { serviceName healthcheckPath numReplicas buildCommand builder dockerfilePath preDeployCommand railwayConfigFile rootDirectory startCommand cronSchedule latestDeployment { id status } } }";

// Narrow projection of Railway CLI v5.30.1 EnvironmentInstances.graphql.
const volumeQuery =
  "query AuggyVolume($projectId: String!, $environmentId: String!) { environment(id: $environmentId, projectId: $projectId) { id volumeInstances(first: 500) { edges { node { serviceId environmentId mountPath state deletedAt isPendingDeletion volume { id } } } pageInfo { hasNextPage } } } }";

export class RailwayDeploymentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailwayDeploymentPolicyError";
  }
}

/** Reject control variables without ever exposing secret-bearing values. */
export function assertNoRailwayBuildVariables(variables: Record<string, unknown>): void {
  if (
    Object.keys(variables).some(
      (key) =>
        key === "RAILWAY_DOCKERFILE_PATH" ||
        key.startsWith("RAILPACK_") ||
        key.startsWith("NIXPACKS_"),
    ) ||
    (Object.hasOwn(variables, "RAILWAY_RUN_UID") && variables.RAILWAY_RUN_UID !== "0")
  ) {
    throw new RailwayDeploymentPolicyError(
      "Managed Railway deployment requires the generated Dockerfile and inherited image user. Review/remove build, Dockerfile or runtime-user override variables, or deploy the exported Docker context manually.",
    );
  }
}

function assertManagedServiceSettings(instance: Record<string, unknown>): void {
  const absent = (value: unknown) => value === null || value === "";
  const noPreDeploy =
    instance.preDeployCommand === null ||
    (Array.isArray(instance.preDeployCommand) && instance.preDeployCommand.length === 0);
  if (
    !absent(instance.buildCommand) ||
    !absent(instance.startCommand) ||
    !absent(instance.railwayConfigFile) ||
    !absent(instance.cronSchedule) ||
    !(absent(instance.dockerfilePath) || instance.dockerfilePath === "Dockerfile") ||
    !(absent(instance.rootDirectory) || instance.rootDirectory === "/") ||
    !noPreDeploy ||
    !["RAILPACK", "DOCKERFILE"].includes(instance.builder as string) ||
    instance.numReplicas !== 1
  ) {
    throw new RailwayDeploymentPolicyError(
      "Managed Railway deployment requires the root generated Dockerfile, its default entrypoint, one replica, and no custom Railway config, build/start/pre-deploy command or cron override. Review/reset the service settings or deploy the exported Docker context manually.",
    );
  }
}

function apiArgs(target: RailwayTarget): string[] {
  return [
    "api",
    serviceInstanceQuery,
    "--variables",
    JSON.stringify({
      serviceId: target.serviceId,
      environmentId: target.environmentId,
    }),
    "--compact",
  ];
}

function serviceInstance(value: unknown): Record<string, unknown> {
  const root = record(value);
  const instance = record(record(root?.data)?.serviceInstance);
  if (!root || root.errors !== undefined || !instance) {
    throw new Error("Railway service metadata is unavailable or malformed; deployment stopped.");
  }
  return instance;
}

/** Ambient target selectors can redirect creation before any linked-target read. */
export function assertNoAmbientRailwayTarget(): void {
  for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID"]) {
    if (process.env[key] !== undefined)
      throw new RailwayDeploymentPolicyError(
        `Unset ${key} before deploying; Auggy requires an explicit linked Railway target.`,
      );
  }
}

/** Match the exact staged-directory link written by Railway, never an ancestor's target. */
function readLinkedTarget(configPath: string, cwd: string): RailwayTarget {
  assertNoAmbientRailwayTarget();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      configPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > DEPLOYMENT_READINESS_DEFAULTS.railwayStatusOutputBytes)
      throw new Error();
    const bytes = Buffer.alloc(DEPLOYMENT_READINESS_DEFAULTS.railwayStatusOutputBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(descriptor, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > DEPLOYMENT_READINESS_DEFAULTS.railwayStatusOutputBytes || used !== stat.size)
      throw new Error();
    const parsed = record(JSON.parse(bytes.subarray(0, used).toString("utf8")));
    const path = realpathSync(cwd);
    const linked = record(record(parsed?.projects)?.[path]);
    if (!linked || linked.projectPath !== path) throw new Error();
    return {
      projectId: targetId(linked.project),
      serviceId: targetId(linked.service),
      environmentId: targetId(linked.environment),
    };
  } catch {
    throw new Error(
      "Cannot verify Railway's linked project, service and environment. Relink the staged target before deploying.",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameTarget(left: RailwayTarget, right: RailwayTarget): boolean {
  return (
    left.projectId === right.projectId &&
    left.serviceId === right.serviceId &&
    left.environmentId === right.environmentId
  );
}

export function createRailwayCli(opts: CreateRailwayCliOptions = {}): RailwayCli {
  const spawn = opts.spawn ?? defaultSpawn;
  const interactiveSpawn = opts.interactiveSpawn ?? defaultInteractiveSpawn;
  const fetchImpl: RailwayFetch = opts.fetch ?? fetch;
  const railwayConfigPath = opts.railwayConfigPath ?? join(homedir(), ".railway", "config.json");
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = opts.retryDelayMs ?? 750;

  /** Every bounded read owns termination, stream cancellation and child reaping. */
  async function boundedJson(args: string[], request: RailwayStatusOptions): Promise<unknown> {
    const timeoutMs =
      request.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayStatusRequestTimeoutMs;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > DEPLOYMENT_READINESS_DEFAULTS.railwayStatusRequestTimeoutMs
    ) {
      throw new Error("Railway status timeout must be finite, positive and at most 15000 ms.");
    }
    if (request.signal?.aborted) throw new Error("Railway metadata read was cancelled.");
    const deadline = performance.now() + timeoutMs;
    let handle: SpawnHandle;
    try {
      handle = spawn(["railway", ...args], { cwd: request.cwd, ownedProcessGroup: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RailwayCliMissingError();
      throw new Error("Railway metadata read could not start.");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bytes = 0;
    const readers = [handle.stdout.getReader(), handle.stderr.getReader()];
    let stopped = false;
    let rejectStopped!: (error: Error) => void;
    const stopPromise = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        handle.kill("SIGKILL");
      } catch {
        /* Reaping below decides completion. */
      }
      for (const reader of readers) void reader.cancel().catch(() => {});
      rejectStopped(
        new Error("Railway metadata read exceeded its time/output bound or was cancelled."),
      );
    };
    const read = async (index: number): Promise<string> => {
      const chunks: Uint8Array[] = [];
      const reader = readers[index]!;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > DEPLOYMENT_READINESS_DEFAULTS.railwayStatusOutputBytes) {
          stop();
          throw new Error();
        }
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    // Reserve part of the same deadline to reap after SIGKILL. No retry extends it.
    const reserve = Math.min(250, timeoutMs / 4);
    timer = setTimeout(stop, Math.max(0, deadline - performance.now() - reserve));
    request.signal?.addEventListener("abort", stop, { once: true });
    const completion = Promise.all([read(0), read(1), handle.exited]);
    try {
      const [stdout, , code] = await Promise.race([completion, stopPromise]);
      if (code !== 0 || handle.isRunning()) throw new Error();
      const parsed: unknown = JSON.parse(stdout);
      if (!record(parsed)) throw new Error();
      return parsed;
    } catch {
      stop();
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = async (): Promise<boolean> => {
        const reaped = await handle.exited.then(
          () => true,
          () => false,
        );
        if (!reaped) return false;
        while (performance.now() < deadline) {
          try {
            if (!handle.isRunning()) return true;
          } catch {
            /* A dying group can briefly be unsignalable; require disappearance by the deadline. */
          }
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(5, Math.max(0, deadline - performance.now()))),
          );
        }
        try {
          return !handle.isRunning();
        } catch {
          return false;
        }
      };
      const reaped = await Promise.race([
        cleanup(),
        new Promise<false>((resolve) => {
          reapTimer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
        }),
      ]);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      if (!reaped) throw new RailwaySubprocessCleanupError();
      throw new Error(
        "Railway metadata read failed, timed out or exceeded its output limit; no readiness was verified.",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", stop);
    }
  }

  async function runRailway(
    args: string[],
    runOpts: RunOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let handle: SpawnHandle;
    try {
      handle = spawn(["railway", ...args], runOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RailwayCliMissingError();
      }
      throw err;
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      readAllText(handle.stdout),
      readAllText(handle.stderr),
      handle.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function runOrThrow(
    args: string[],
    runOpts: RunOptions = {},
    options: RunOrThrowOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const maxAttempts = options.retryTransient ? 3 : 1;
    let lastResult: { stdout: string; stderr: string; exitCode: number } | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let result: { stdout: string; stderr: string; exitCode: number };
      result = await runRailway(args, runOpts);
      lastResult = result;
      if (result.exitCode === 0 || options.acceptNonZero?.(result)) {
        return { stdout: result.stdout, stderr: result.stderr };
      }
      if (attempt < maxAttempts && isTransientRailwayFailure(result.stdout, result.stderr)) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw commandError(args, result);
    }
    const result = lastResult!;
    throw commandError(args, result);
  }

  async function runInteractiveOrThrow(args: string[], runOpts: RunOptions = {}): Promise<void> {
    let handle: InteractiveSpawnHandle;
    try {
      handle = interactiveSpawn(["railway", ...args], runOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RailwayCliMissingError();
      }
      throw err;
    }
    const exitCode = await handle.exited;
    if (exitCode !== 0) {
      throw new Error(`railway ${args.join(" ")} exited ${exitCode}`);
    }
  }

  return {
    async checkPresence() {
      const { exitCode } = await runRailway(["--version"]);
      if (exitCode !== 0) throw new RailwayCliMissingError();
      return true;
    },

    async checkAuth() {
      const { stdout, stderr, exitCode } = await runRailway(["whoami"]);
      if (exitCode !== 0) {
        throw new RailwayNotLoggedInError(stderr.trim() || "non-zero exit");
      }
      // Output forms observed: "Logged in as foo@example.com" or just "foo@example.com".
      const match = stdout.match(/(?:Logged in as\s+)?([^\s]+@[^\s]+|\S+)$/m);
      return match ? match[1]!.trim() : stdout.trim();
    },

    async listWorkspaces() {
      const workspaces = await queryWorkspacesFromRailwayGraphql({
        fetchImpl,
        configPath: railwayConfigPath,
      });
      if (workspaces) return workspaces;

      const { stdout } = await runOrThrow(["list", "--json"], {}, { retryTransient: true });
      return extractWorkspaces(stdout);
    },

    async listProjects({ workspace } = {}) {
      const { stdout } = await runOrThrow(["list", "--json"], {}, { retryTransient: true });
      return extractProjects(stdout, workspace);
    },

    async createProject({ projectName, workspace, cwd }) {
      const args = ["init", "--name", projectName];
      const cleanWorkspace = workspace?.trim();
      if (cleanWorkspace) args.push("--workspace", cleanWorkspace);
      args.push("--json");

      let stdout: string;
      try {
        ({ stdout } = await runOrThrow(args, { cwd }));
      } catch (err) {
        const message = (err as Error).message;
        if (!cleanWorkspace && isWorkspaceRequiredFailure(message)) {
          throw new RailwayWorkspaceRequiredError(message);
        }
        throw err;
      }
      const fromInit = extractProjectId(stdout);
      if (fromInit) return fromInit;
      const status = await this.status({ cwd });
      if (status.project?.id) return status.project.id;
      throw new Error(`railway init --json produced no project id: ${stdout.trim()}`);
    },

    async linkProject({ projectId, cwd }) {
      await runOrThrow(["link", "--project", projectId], { cwd }, { retryTransient: true });
    },

    async linkService({ serviceName, cwd }) {
      await runOrThrow(["service", "link", serviceName], { cwd }, { retryTransient: true });
    },

    async link({ projectId, serviceName, cwd }) {
      await runOrThrow(["link", "--project", projectId], { cwd }, { retryTransient: true });
      await runOrThrow(["service", "link", serviceName], { cwd }, { retryTransient: true });
    },

    async createService({ serviceName, cwd }) {
      await runOrThrow(
        ["add", "--service", serviceName],
        { cwd },
        {
          retryTransient: true,
          acceptNonZero: (result) => isAlreadyExistsFailure(result.stdout, result.stderr),
        },
      );
      await runOrThrow(["service", "link", serviceName], { cwd }, { retryTransient: true });
    },

    async setVariable({ key, value, cwd }) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error("Invalid Railway variable key.");
      }
      const args = ["variable", "set", key, "--stdin", "--skip-deploys"];
      for (let attempt = 1; attempt <= 3; attempt++) {
        let result: { stdout: string; stderr: string; exitCode: number };
        try {
          result = await runRailway(args, { cwd, stdin: value });
        } catch (error) {
          if (error instanceof RailwayCliMissingError) throw error;
          throw new Error(`Railway variable update for ${key} failed before completion.`);
        }
        if (result.exitCode === 0) return;

        const transient = isTransientRailwayFailure(result.stdout, result.stderr);
        if (transient && attempt < 3) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        if (transient) {
          throw new Error(
            `Railway variable update for ${key} has an unknown outcome after 3 attempts; deployment stopped.`,
          );
        }
        throw new Error(
          `Railway variable update for ${key} failed with exit code ${result.exitCode}.`,
        );
      }
    },

    async up({ cwd }) {
      await runOrThrow(["up", "--detach", "--no-gitignore"], { cwd }, { retryTransient: true });
    },

    async generateDomain({ cwd, port }) {
      // Idempotent: first call generates, second returns the existing URL.
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
        throw new Error("Invalid Railway domain port.");
      const { stdout } = await runOrThrow(
        ["domain", ...(port === undefined ? [] : ["--port", String(port)]), "--json"],
        { cwd },
        { retryTransient: true },
      );
      const url = extractDomainUrl(stdout);
      if (!url) {
        throw new Error(`railway domain --json produced no URL: ${stdout.trim()}`);
      }
      return url;
    },

    async addVolume({ mountPath, cwd }) {
      await runOrThrow(
        ["volume", "add", "--mount-path", mountPath],
        { cwd },
        {
          retryTransient: true,
          acceptNonZero: (result) =>
            isAlreadyExistsFailure(result.stdout, result.stderr) ||
            /\bvolume\b[\s\S]*\bmounted at\b/i.test(`${result.stdout}\n${result.stderr}`),
        },
      );
    },

    async status(request) {
      if (!request.target)
        return (await boundedJson(["status", "--json"], request)) as RailwayStatus;
      if (!sameTarget(readLinkedTarget(railwayConfigPath, request.cwd), request.target))
        throw new Error("Railway linked target changed during deployment.");
      const instance = serviceInstance(await boundedJson(apiArgs(request.target), request));
      assertManagedServiceSettings(instance);
      const deployment =
        instance.latestDeployment === null ? null : record(instance.latestDeployment);
      if (
        instance.latestDeployment !== null &&
        (!deployment || typeof deployment.status !== "string")
      )
        throw new Error("Railway deployment metadata is malformed.");
      return {
        project: { id: request.target.projectId },
        service: { id: request.target.serviceId },
        ...(deployment
          ? { deployment: { id: targetId(deployment.id), status: targetId(deployment.status) } }
          : {}),
      };
    },

    async inspectIngress({ cwd }) {
      // Source shapes: railwayapp/cli v5.30.1 config.rs, variable.rs and domain.rs;
      // serviceInstance fields: docs.railway.com/integrations/api/manage-services.
      const target = readLinkedTarget(railwayConfigPath, cwd);
      const flags = [
        "--project",
        target.projectId,
        "--service",
        target.serviceId,
        "--environment",
        target.environmentId,
      ];
      const variables = record(
        await boundedJson(["variable", "list", ...flags, "--json"], { cwd }),
      )!;
      if (
        Object.values(variables).some((value) => typeof value !== "string") ||
        variables.RAILWAY_PROJECT_ID !== target.projectId ||
        variables.RAILWAY_SERVICE_ID !== target.serviceId ||
        variables.RAILWAY_ENVIRONMENT_ID !== target.environmentId
      ) {
        throw new Error("Railway variable metadata does not match the linked deployment target.");
      }
      assertNoRailwayBuildVariables(variables);
      const domainResult = record(
        await boundedJson(["domain", "list", ...flags, "--json"], { cwd }),
      )!;
      if (!Array.isArray(domainResult.domains))
        throw new Error("Railway domain metadata is unavailable or malformed.");
      const domains = domainResult.domains.map((value): RailwayIngress["domains"][number] => {
        const item = record(value);
        if (
          !item ||
          (item.type !== "custom" && item.type !== "service") ||
          typeof item.domain !== "string" ||
          !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(item.domain) ||
          (item.targetPort !== null &&
            (typeof item.targetPort !== "number" ||
              !Number.isInteger(item.targetPort) ||
              item.targetPort < 1 ||
              item.targetPort > 65535))
        ) {
          throw new Error("Railway domain metadata is unavailable or malformed.");
        }
        targetId(item.id);
        return { domain: item.domain, targetPort: item.targetPort as number | null };
      });
      const instance = serviceInstance(await boundedJson(apiArgs(target), { cwd }));
      assertManagedServiceSettings(instance);
      const healthPath = instance.healthcheckPath;
      if (healthPath !== null) validateHealthPath(healthPath);
      if (!Number.isSafeInteger(instance.numReplicas) || (instance.numReplicas as number) < 1)
        throw new Error("Railway replica metadata is unavailable or malformed.");
      const latest = instance.latestDeployment === null ? null : record(instance.latestDeployment);
      if (instance.latestDeployment !== null && (!latest || typeof latest.status !== "string"))
        throw new Error("Railway deployment metadata is unavailable or malformed.");
      if (!sameTarget(readLinkedTarget(railwayConfigPath, cwd), target))
        throw new Error("Railway linked target changed during preflight.");
      return {
        ...target,
        serviceName: targetId(instance.serviceName),
        domains,
        httpVariables: [
          "PORT",
          "AUGGY_PUBLIC_URL",
          "RAILWAY_PUBLIC_DOMAIN",
          "RAILWAY_HEALTHCHECK_TIMEOUT_SEC",
        ].filter((key) => Object.hasOwn(variables, key)),
        healthPath: healthPath as string | null,
        replicas: instance.numReplicas as number,
        latestDeploymentId: latest ? targetId(latest.id) : null,
      };
    },

    async inspectVolume({ cwd, target }) {
      if (!sameTarget(readLinkedTarget(railwayConfigPath, cwd), target))
        throw new Error("Railway linked target changed during volume inspection.");
      const value = record(
        await boundedJson(
          [
            "api",
            volumeQuery,
            "--variables",
            JSON.stringify({ projectId: target.projectId, environmentId: target.environmentId }),
            "--compact",
          ],
          { cwd },
        ),
      );
      const environment = record(record(value?.data)?.environment);
      const volumes = record(environment?.volumeInstances);
      const edges = volumes?.edges;
      if (
        !value ||
        value.errors !== undefined ||
        environment?.id !== target.environmentId ||
        !Array.isArray(edges) ||
        edges.length > 500 ||
        record(volumes?.pageInfo)?.hasNextPage !== false
      )
        throw new Error(
          "Railway volume metadata is unavailable, incomplete or exceeds the supported bound.",
        );
      const selected: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const edge of edges) {
        const node = record(record(edge)?.node);
        if (
          !node ||
          node.environmentId !== target.environmentId ||
          (node.serviceId !== null && typeof node.serviceId !== "string")
        )
          throw new Error("Railway volume target metadata is malformed.");
        const id = targetId(record(node.volume)?.id);
        if (seen.has(id)) throw new Error("Railway volume metadata contains duplicate bindings.");
        seen.add(id);
        if (node.serviceId === target.serviceId) selected.push(node);
      }
      if (selected.length > 1)
        throw new Error("Railway service has ambiguous volume bindings; deployment stopped.");
      const selectedVolume = selected[0];
      if (
        selectedVolume &&
        (selectedVolume.mountPath !== "/app/data" ||
          selectedVolume.state !== "READY" ||
          selectedVolume.isPendingDeletion !== false ||
          selectedVolume.deletedAt !== null)
      )
        throw new Error(
          "Railway requires one ready, retained volume mounted at /app/data. Review the selected service's volume before deploying.",
        );
      if (!sameTarget(readLinkedTarget(railwayConfigPath, cwd), target))
        throw new Error("Railway linked target changed during volume inspection.");
      return selectedVolume ? targetId(record(selectedVolume.volume)?.id) : null;
    },

    async destroyService({ cwd }) {
      await runOrThrow(["service", "delete", "--yes"], { cwd });
    },

    async logs({ cwd }) {
      await runInteractiveOrThrow(["logs"], { cwd });
    },
  };
}

async function queryWorkspacesFromRailwayGraphql(args: {
  fetchImpl: RailwayFetch;
  configPath: string;
}): Promise<RailwayWorkspace[] | null> {
  const token = readRailwayAccessToken(args.configPath);
  if (!token) return null;

  try {
    const res = await args.fetchImpl("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      body: JSON.stringify({
        query: "{ me { workspaces { id name } } }",
      }),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    return readGraphqlWorkspaces(parsed);
  } catch {
    return null;
  }
}

function readRailwayAccessToken(configPath: string): string | null {
  try {
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const user = (parsed as Record<string, unknown>).user;
    if (!user || typeof user !== "object") return null;
    const token = (user as Record<string, unknown>).accessToken;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function readGraphqlWorkspaces(value: unknown): RailwayWorkspace[] | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;
  const me = (data as Record<string, unknown>).me;
  if (!me || typeof me !== "object") return null;
  const workspaces = (me as Record<string, unknown>).workspaces;
  if (!Array.isArray(workspaces)) return null;

  const out = new Map<string, RailwayWorkspace>();
  for (const workspace of workspaces) {
    const read = readWorkspace(workspace);
    if (read) out.set(read.id, read);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractProjectId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      if (typeof root.id === "string") return root.id;
      const project = root.project;
      if (project && typeof project === "object") {
        const id = (project as Record<string, unknown>).id;
        if (typeof id === "string") return id;
      }
    }
  } catch {
    // Fall through to regex for older/non-JSON Railway output.
  }
  const match = stdout.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return match?.[0] ?? null;
}

function extractWorkspaces(stdout: string): RailwayWorkspace[] {
  const parsed = JSON.parse(stdout) as unknown;
  const workspaces = new Map<string, RailwayWorkspace>();
  collectWorkspaces(parsed, workspaces);
  return [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractProjects(stdout: string, workspace?: string): RailwayProject[] {
  const parsed = JSON.parse(stdout) as unknown;
  const projects = new Map<string, RailwayProject>();
  collectProjects(parsed, projects);
  const filter = workspace?.trim();
  return [...projects.values()]
    .filter((project) => {
      if (!filter) return true;
      return project.workspaceId === filter || project.workspaceName === filter;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectWorkspaces(value: unknown, workspaces: Map<string, RailwayWorkspace>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspaces(item, workspaces);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const workspace = readWorkspace(record.workspace);
  if (workspace) {
    workspaces.set(workspace.id, workspace);
  }
  for (const item of Object.values(record)) {
    collectWorkspaces(item, workspaces);
  }
}

function collectProjects(value: unknown, projects: Map<string, RailwayProject>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProjects(item, projects);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  collectProjects(record.projects, projects);

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const deletedAt = record.deletedAt;
  const workspace = readWorkspace(record.workspace);
  if (id && name && workspace && !deletedAt) {
    projects.set(id, {
      id,
      name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  }
}

function readWorkspace(value: unknown): RailwayWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id || !name) return null;
  return { id, name };
}

function isWorkspaceRequiredFailure(value: string): boolean {
  return /--workspace required/i.test(value) || /workspace required/i.test(value);
}

function isTransientRailwayFailure(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return [
    "failed to fetch",
    "operation timed out",
    "timed out",
    "timeout",
    "econnreset",
    "etimedout",
    "econnrefused",
    "socket hang up",
    "network error",
    "temporary failure",
    "tls handshake timeout",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
  ].some((marker) => text.includes(marker));
}

function isAlreadyExistsFailure(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return [
    "already exists",
    "already attached",
    "already mounted",
    "maximum of 1 railway provided domain",
  ].some((marker) => text.includes(marker));
}

function extractDomainUrl(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const fromJson = findDomainUrl(parsed);
    if (fromJson) return fromJson;
  } catch {
    // Fall through to text parsing for older/non-JSON Railway output.
  }
  return urlFromString(stdout);
}

function findDomainUrl(value: unknown): string | null {
  if (typeof value === "string") return urlFromString(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDomainUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of ["url", "domain", "serviceDomain", "publicUrl"]) {
    const found = findDomainUrl(record[key]);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    const found = findDomainUrl(item);
    if (found) return found;
  }
  return null;
}

function urlFromString(value: string): string | null {
  const httpMatch = value.match(/https?:\/\/[a-z0-9.-]+/i);
  if (httpMatch) return httpMatch[0]!;
  const railwayDomainMatch = value.match(/\b[a-z0-9.-]+\.up\.railway\.app\b/i);
  return railwayDomainMatch ? `https://${railwayDomainMatch[0]}` : null;
}

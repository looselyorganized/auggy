/**
 * Railway CLI subprocess wrapper.
 *
 * Sole owner of `railway` binary knowledge in the codebase. Every Railway
 * operation calls `runRailway(args, opts)` which uses the injected spawn
 * factory (defaults to `Bun.spawn`). Tests override the factory to mock
 * subprocess behavior without spawning anything.
 *
 * Operator pre-requisites: `railway` CLI installed (https://docs.railway.com/develop/cli)
 * and `railway login` completed. We trust the operator's auth context — same
 * pattern as `git push` trusts `git`. No token storage in this codebase.
 */

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

interface SpawnHandle {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export type RailwaySpawnFactory = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => SpawnHandle;

interface CreateRailwayCliOptions {
  spawn?: RailwaySpawnFactory;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface RailwayStatus {
  project: { id: string; name: string };
  service: { id: string; name: string };
  deployment: { status: string };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

const defaultSpawn: RailwaySpawnFactory = (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
};

export interface RailwayCli {
  checkPresence(): Promise<true>;
  checkAuth(): Promise<string>;
  link(args: { projectId: string; serviceName: string; cwd: string }): Promise<void>;
  setVariable(args: { key: string; value: string; cwd: string }): Promise<void>;
  up(args: { cwd: string }): Promise<void>;
  generateDomain(args: { cwd: string }): Promise<string>;
  addVolume(args: { name: string; mountPath: string; cwd: string }): Promise<void>;
  status(args: { cwd: string }): Promise<RailwayStatus>;
  destroyService(args: { cwd: string }): Promise<void>;
}

export function createRailwayCli(opts: CreateRailwayCliOptions = {}): RailwayCli {
  const spawn = opts.spawn ?? defaultSpawn;

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
      readAll(handle.stdout),
      readAll(handle.stderr),
      handle.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function runOrThrow(
    args: string[],
    runOpts: RunOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr, exitCode } = await runRailway(args, runOpts);
    if (exitCode !== 0) {
      throw new Error(
        `railway ${args.join(" ")} exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
    return { stdout, stderr };
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

    async link({ projectId, serviceName, cwd }) {
      await runOrThrow(["link", "--project", projectId, "--service", serviceName], { cwd });
    },

    async setVariable({ key, value, cwd }) {
      await runOrThrow(["variables", "--set", `${key}=${value}`], { cwd });
    },

    async up({ cwd }) {
      await runOrThrow(["up", "--detach"], { cwd });
    },

    async generateDomain({ cwd }) {
      // Idempotent: first call generates, second returns the existing URL.
      const { stdout } = await runOrThrow(["domain", "--generate"], { cwd });
      const match = stdout.match(/https:\/\/[a-z0-9.\-]+/i);
      if (!match) {
        throw new Error(`railway domain --generate produced no URL: ${stdout.trim()}`);
      }
      return match[0];
    },

    async addVolume({ name, mountPath, cwd }) {
      await runOrThrow(["volume", "add", name, "--mount-path", mountPath], { cwd });
    },

    async status({ cwd }) {
      const { stdout } = await runOrThrow(["status", "--json"], { cwd });
      const parsed = JSON.parse(stdout) as RailwayStatus;
      return parsed;
    },

    async destroyService({ cwd }) {
      await runOrThrow(["service", "delete", "--yes"], { cwd });
    },
  };
}

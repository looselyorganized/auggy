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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAllText } from "../_shared/stream";

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
}

interface InteractiveSpawnHandle {
  exited: Promise<number>;
}

export type RailwaySpawnFactory = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
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
}

interface RunOrThrowOptions {
  retryTransient?: boolean;
  acceptNonZero?: (result: { stdout: string; stderr: string; exitCode: number }) => boolean;
}

export interface RailwayStatus {
  project?: { id?: string; name?: string };
  service?: { id?: string; name?: string };
  deployment?: { status?: string };
}

export interface RailwayWorkspace {
  id: string;
  name: string;
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
  createProject(args: { projectName: string; workspace?: string; cwd: string }): Promise<string>;
  linkProject(args: { projectId: string; cwd: string }): Promise<void>;
  linkService(args: { serviceName: string; cwd: string }): Promise<void>;
  link(args: { projectId: string; serviceName: string; cwd: string }): Promise<void>;
  createService(args: { serviceName: string; cwd: string }): Promise<void>;
  setVariable(args: { key: string; value: string; cwd: string }): Promise<void>;
  up(args: { cwd: string }): Promise<void>;
  generateDomain(args: { cwd: string }): Promise<string>;
  addVolume(args: { name: string; mountPath: string; cwd: string }): Promise<void>;
  status(args: { cwd: string }): Promise<RailwayStatus>;
  destroyService(args: { cwd: string }): Promise<void>;
  logs(args: { cwd: string }): Promise<void>;
}

export function createRailwayCli(opts: CreateRailwayCliOptions = {}): RailwayCli {
  const spawn = opts.spawn ?? defaultSpawn;
  const interactiveSpawn = opts.interactiveSpawn ?? defaultInteractiveSpawn;
  const fetchImpl: RailwayFetch = opts.fetch ?? fetch;
  const railwayConfigPath = opts.railwayConfigPath ?? join(homedir(), ".railway", "config.json");
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelayMs = opts.retryDelayMs ?? 750;

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
      const result = await runRailway(args, runOpts);
      lastResult = result;
      if (result.exitCode === 0 || options.acceptNonZero?.(result)) {
        return { stdout: result.stdout, stderr: result.stderr };
      }
      if (attempt < maxAttempts && isTransientRailwayFailure(result.stdout, result.stderr)) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw new Error(
        `railway ${args.join(" ")} exited ${result.exitCode}${
          result.stderr ? `: ${result.stderr.trim()}` : ""
        }`,
      );
    }
    const result = lastResult!;
    throw new Error(
      `railway ${args.join(" ")} exited ${result.exitCode}${
        result.stderr ? `: ${result.stderr.trim()}` : ""
      }`,
    );
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
      try {
        await runOrThrow(
          ["variable", "set", `${key}=${value}`, "--skip-deploys"],
          { cwd },
          {
            retryTransient: true,
          },
        );
      } catch (err) {
        if (!isTransientRailwayFailure("", String((err as Error).message))) throw err;
        const { stdout } = await runOrThrow(
          ["variable", "list", "--json"],
          { cwd },
          {
            retryTransient: true,
          },
        );
        if (!variableListHasKey(stdout, key)) throw err;
      }
    },

    async up({ cwd }) {
      await runOrThrow(["up", "--detach"], { cwd }, { retryTransient: true });
    },

    async generateDomain({ cwd }) {
      // Idempotent: first call generates, second returns the existing URL.
      const { stdout } = await runOrThrow(["domain", "--json"], { cwd }, { retryTransient: true });
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

    async status({ cwd }) {
      const { stdout } = await runOrThrow(["status", "--json"], { cwd }, { retryTransient: true });
      const parsed = JSON.parse(stdout) as RailwayStatus;
      return parsed;
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

function variableListHasKey(stdout: string, key: string): boolean {
  try {
    return jsonHasVariableKey(JSON.parse(stdout) as unknown, key);
  } catch {
    return stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === key || line.trim().startsWith(`${key}=`));
  }
}

function jsonHasVariableKey(value: unknown, key: string): boolean {
  if (typeof value === "string") return value === key || value.startsWith(`${key}=`);
  if (Array.isArray(value)) return value.some((item) => jsonHasVariableKey(item, key));
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, key)) return true;
  for (const field of ["key", "name", "variable"]) {
    if (record[field] === key) return true;
  }
  return Object.values(record).some((item) => jsonHasVariableKey(item, key));
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

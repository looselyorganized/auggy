/**
 * Agent index — `~/.auggy/agents.json`.
 *
 * Maps agent name → { localDir, createdAt, cloud }. Load-bearing facility
 * metadata: every CLI command that finds an agent on disk goes through here.
 *
 * Pattern mirrors `pid-registry.ts`: atomic write via temp+rename, defensive
 * recovery on corruption, no in-memory caching across invocations.
 */

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IndexFile, IndexEntry } from "./types";

const SCHEMA_VERSION = 1 as const;

// Lock acquisition tuning. Spin with short busy-waits up to LOCK_TIMEOUT_MS,
// matching the cadence in pid-registry's other file-coordination paths.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 50;

interface IndexOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
}

function getAuggyDir(opts: IndexOptions = {}): string {
  return opts.auggyDir ?? join(homedir(), ".auggy");
}

function indexPath(opts: IndexOptions): string {
  return join(getAuggyDir(opts), "agents.json");
}

function ensureDir(opts: IndexOptions): void {
  mkdirSync(getAuggyDir(opts), { recursive: true });
}

function emptyIndex(): IndexFile {
  return { version: SCHEMA_VERSION, agents: {} };
}

function lockPath(opts: IndexOptions): string {
  return join(getAuggyDir(opts), "agents.json.lock");
}

/**
 * Local copy of the liveness check from `pid-registry`. Inlined to avoid an
 * import cycle and because the body is trivial.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockHandle {
  release: () => void;
}

interface LockFileContents {
  pid: number;
  acquired: string;
}

/**
 * Acquire a cross-process advisory lock on `agents.json.lock`.
 *
 * Uses `openSync(path, "wx")` for atomic exclusive create — same primitive
 * used by `pid-registry` for atomic per-agent manifests. On EEXIST:
 *  - Read the existing lock; if its recorded PID is dead, unlink the stale
 *    lock and retry.
 *  - If the recorded PID is live, busy-wait `LOCK_POLL_MS` and retry until
 *    `LOCK_TIMEOUT_MS` elapses, then throw a clear error naming the holder.
 *
 * Synchronous on purpose — the rest of this module is sync, and CLI mutators
 * are short-running. Blocking the event loop for at most 5s is acceptable.
 */
function acquireLock(opts: IndexOptions = {}): LockHandle {
  ensureDir(opts);
  const path = lockPath(opts);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const payload: LockFileContents = {
    pid: process.pid,
    acquired: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            // Already gone — nothing to do.
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Inspect the existing lock through a file descriptor to avoid a
      // TOCTOU race against the path. If the holder is dead, take it over.
      let holderPid: number | null = null;
      let readFd: number | null = null;
      try {
        readFd = openSync(path, "r");
        const stats = fstatSync(readFd);
        const buf = Buffer.alloc(stats.size);
        if (stats.size > 0) {
          readSync(readFd, buf, 0, stats.size, 0);
        }
        const parsed = JSON.parse(buf.toString("utf-8")) as Partial<LockFileContents>;
        if (typeof parsed.pid === "number") holderPid = parsed.pid;
      } catch {
        // Lock was unlinked between EEXIST and our read, OR content was
        // unparseable. Either way, treat as stale.
      } finally {
        if (readFd !== null) {
          try {
            closeSync(readFd);
          } catch {
            // best-effort
          }
        }
      }

      if (holderPid === null || !isProcessAlive(holderPid)) {
        try {
          unlinkSync(path);
        } catch {
          // Race: another caller already cleaned it up. Loop and retry.
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `agent-index: timed out after ${LOCK_TIMEOUT_MS}ms waiting for lock at ${path} ` +
            `(held by live PID ${holderPid}).`,
        );
      }

      // Busy-wait briefly. Synchronous on purpose to keep the API sync.
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * Read the index. Returns an empty index when the file doesn't exist.
 *
 * On JSON parse failure, backs up the corrupt file to
 * `agents.json.corrupt-<ISO>` and returns an empty index — operator can
 * recover from the backup if needed.
 *
 * Throws on unknown schema versions (forward-compat guard).
 */
export function readIndex(opts: IndexOptions = {}): IndexFile {
  const path = indexPath(opts);

  // Open via fd to avoid existsSync+readFileSync TOCTOU.
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyIndex();
    }
    throw err;
  }

  let raw: string;
  try {
    const stats = fstatSync(fd);
    const buf = Buffer.alloc(stats.size);
    if (stats.size > 0) {
      readSync(fd, buf, 0, stats.size, 0);
    }
    raw = buf.toString("utf-8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(getAuggyDir(opts), `agents.json.corrupt-${ts}`);
    renameSync(path, backupPath);
    console.warn(
      `[agent-index] corrupt agents.json detected; backed up to ${backupPath}. Recreating empty index.`,
    );
    return emptyIndex();
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: number }).version !== SCHEMA_VERSION
  ) {
    const got = (parsed as { version?: number } | null)?.version;
    throw new Error(
      `agents.json has unknown schema version ${got} (expected ${SCHEMA_VERSION}). ` +
        `This file may be from a newer version of aug1.`,
    );
  }

  return parsed as IndexFile;
}

/**
 * Write the index atomically: write to `agents.json.tmp`, then rename
 * over the target. Same hygiene as `pid-registry.ts`.
 */
export function writeIndex(idx: IndexFile, opts: IndexOptions = {}): void {
  ensureDir(opts);
  const target = indexPath(opts);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2));
  renameSync(tmp, target);
}

/**
 * Add an agent to the index. Throws if `name` is already registered.
 *
 * Holds an advisory lock for the read-modify-write window so two concurrent
 * CLI invocations don't lose each other's updates.
 */
export function addAgent(name: string, localDir: string, opts: IndexOptions = {}): void {
  const lock = acquireLock(opts);
  try {
    const idx = readIndex(opts);
    if (idx.agents[name]) {
      throw new Error(
        `Agent "${name}" already registered at ${idx.agents[name].localDir}. ` +
          `Choose a different name or remove the existing one with \`aug1 remove ${name}\`.`,
      );
    }
    idx.agents[name] = {
      localDir,
      createdAt: new Date().toISOString(),
      cloud: null,
    };
    writeIndex(idx, opts);
  } finally {
    lock.release();
  }
}

/**
 * Remove an agent from the index. Idempotent — no-op when not present.
 *
 * Holds an advisory lock for the read-modify-write window. The lock is
 * released even when no entry exists.
 */
export function removeAgent(name: string, opts: IndexOptions = {}): void {
  const lock = acquireLock(opts);
  try {
    const idx = readIndex(opts);
    if (!idx.agents[name]) return;
    delete idx.agents[name];
    writeIndex(idx, opts);
  } finally {
    lock.release();
  }
}

/**
 * Look up an agent by name. Returns null if not registered.
 */
export function getAgent(name: string, opts: IndexOptions = {}): IndexEntry | null {
  const idx = readIndex(opts);
  return idx.agents[name] ?? null;
}

/**
 * List all registered agents with their names.
 */
export function listAgents(opts: IndexOptions = {}): Array<IndexEntry & { name: string }> {
  const idx = readIndex(opts);
  return Object.entries(idx.agents).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

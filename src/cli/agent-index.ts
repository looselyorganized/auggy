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

interface LockHandle {
  release: () => void;
}

interface LockFileContents {
  pid: number;
  acquired: string;
}

/**
 * Try to atomically create the lock file. Returns a release handle on
 * success, or null if the lock is already held (EEXIST). Any other I/O
 * error propagates.
 *
 * Extracted from `acquireLock` so the happy path and the force-recovery
 * retry path share a single implementation.
 */
function tryAcquire(path: string, body: string): LockHandle | null {
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
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return null;
  }
}

/**
 * Acquire a cross-process advisory lock on `agents.json.lock`.
 *
 * Uses `openSync(path, "wx")` for atomic exclusive create — same primitive
 * used by `pid-registry` for atomic per-agent manifests. On EEXIST: busy-wait
 * `LOCK_POLL_MS` and retry until `LOCK_TIMEOUT_MS` elapses. Once the deadline
 * passes we assume the previous holder crashed, force-unlink the lock, and
 * retry once. If that retry still fails (e.g. permissions/IO error), throw.
 *
 * Why time-based recovery instead of PID liveness checks: reading the lock
 * file's content to extract a holder PID requires a second `openSync(path, "r")`,
 * which CodeQL flags as TOCTOU against the EEXIST signal even though we only
 * extract a number. Time-based recovery uses a single primitive (`openSync(wx)`),
 * so there is no path-based race surface to flag.
 *
 * Synchronous on purpose — the rest of this module is sync, and CLI mutators
 * are short-running. Blocking the event loop for at most 5s is acceptable.
 */
function acquireLock(opts: IndexOptions = {}): LockHandle {
  ensureDir(opts);
  const path = lockPath(opts);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const body = JSON.stringify({
    pid: process.pid,
    acquired: new Date().toISOString(),
  } satisfies LockFileContents);

  for (;;) {
    const handle = tryAcquire(path, body);
    if (handle) return handle;

    if (Date.now() >= deadline) {
      // Force-recover: assume the previous holder crashed.
      try {
        unlinkSync(path);
      } catch {
        // Race: someone else cleaned it up. Recovery retry below will succeed.
      }
      const recovered = tryAcquire(path, body);
      if (recovered) return recovered;
      throw new Error(
        `Could not acquire agents.json lock at ${path} after ${LOCK_TIMEOUT_MS}ms ` +
          `(another process holding it).`,
      );
    }

    Bun.sleepSync(LOCK_POLL_MS);
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

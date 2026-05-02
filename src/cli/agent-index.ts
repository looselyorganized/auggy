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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IndexFile, IndexEntry } from "./types";

const SCHEMA_VERSION = 1 as const;

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
  if (!existsSync(path)) return emptyIndex();

  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
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
 */
export function addAgent(
  name: string,
  localDir: string,
  opts: IndexOptions = {},
): void {
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
}

/**
 * Remove an agent from the index. Idempotent — no-op when not present.
 */
export function removeAgent(name: string, opts: IndexOptions = {}): void {
  const idx = readIndex(opts);
  if (!idx.agents[name]) return;
  delete idx.agents[name];
  writeIndex(idx, opts);
}

/**
 * Look up an agent by name. Returns null if not registered.
 */
export function getAgent(
  name: string,
  opts: IndexOptions = {},
): IndexEntry | null {
  const idx = readIndex(opts);
  return idx.agents[name] ?? null;
}

/**
 * List all registered agents with their names.
 */
export function listAgents(
  opts: IndexOptions = {},
): Array<IndexEntry & { name: string }> {
  const idx = readIndex(opts);
  return Object.entries(idx.agents).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

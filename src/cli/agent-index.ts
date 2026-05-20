/**
 * Agent store — filesystem-as-truth.
 *
 * An agent IS a directory at `<auggyDir>/agents/<name>/` containing
 * `agent.yaml` and (optionally) `.auggy-meta.json`. There is no central
 * index file; `listAgents` scans the directory, `getAgent` checks one path.
 *
 * Per-agent metadata (`.auggy-meta.json`) carries the createdAt timestamp
 * and cloud-deployment record. Missing or unreadable meta is tolerated —
 * we synthesize defaults from the dir's mtime — because the agent's
 * existence is signaled by its directory, not by a metadata file.
 *
 * Atomic-create semantics live in `create.ts` (scaffold into a sibling
 * `.tmp-<uuid>` dir, `renameSync` to the final path). This module exposes
 * read/mutate primitives that the rest of the CLI calls.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudRecord, IndexEntry } from "./types";

const META_SCHEMA_VERSION = 1 as const;
const META_FILENAME = ".auggy-meta.json";
const LEGACY_INDEX_FILENAME = "agents.json";

interface AgentStoreOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
}

interface AgentMeta {
  version: typeof META_SCHEMA_VERSION;
  createdAt: string;
  cloud: CloudRecord;
}

function getAuggyDir(opts: AgentStoreOptions = {}): string {
  return opts.auggyDir ?? join(homedir(), ".auggy");
}

function getAgentsRoot(opts: AgentStoreOptions = {}): string {
  return join(getAuggyDir(opts), "agents");
}

function agentDir(name: string, opts: AgentStoreOptions = {}): string {
  return join(getAgentsRoot(opts), name);
}

function metaPath(localDir: string): string {
  return join(localDir, META_FILENAME);
}

function readMeta(localDir: string): AgentMeta {
  const path = metaPath(localDir);
  if (!existsSync(path)) {
    return synthesizeMeta(localDir);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgentMeta>;
    if (parsed.version !== META_SCHEMA_VERSION) {
      return synthesizeMeta(localDir);
    }
    return {
      version: META_SCHEMA_VERSION,
      createdAt: parsed.createdAt ?? synthesizeMeta(localDir).createdAt,
      cloud: parsed.cloud ?? null,
    };
  } catch {
    return synthesizeMeta(localDir);
  }
}

function synthesizeMeta(localDir: string): AgentMeta {
  let createdAt: string;
  try {
    const stats = statSync(localDir);
    createdAt = stats.birthtime?.toISOString() ?? stats.mtime.toISOString();
  } catch {
    createdAt = new Date().toISOString();
  }
  return { version: META_SCHEMA_VERSION, createdAt, cloud: null };
}

function writeMeta(localDir: string, meta: AgentMeta): void {
  const path = metaPath(localDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, path);
}

/**
 * One-shot migration from the legacy `agents.json` index.
 *
 * For each entry whose `localDir` still exists and lacks `.auggy-meta.json`,
 * write a meta file derived from the index entry. Rename the legacy file
 * aside with a timestamp so the operator can recover from backup if needed
 * and so we never run the migration twice.
 *
 * Best-effort: any failure is logged but does not block the caller.
 */
function migrateLegacyIndex(opts: AgentStoreOptions = {}): void {
  const legacyPath = join(getAuggyDir(opts), LEGACY_INDEX_FILENAME);
  if (!existsSync(legacyPath)) return;

  try {
    const raw = readFileSync(legacyPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      agents?: Record<string, IndexEntry>;
    };
    if (parsed?.version === 1 && parsed.agents) {
      for (const [, entry] of Object.entries(parsed.agents)) {
        if (!entry?.localDir || !existsSync(entry.localDir)) continue;
        if (existsSync(metaPath(entry.localDir))) continue;
        try {
          writeMeta(entry.localDir, {
            version: META_SCHEMA_VERSION,
            createdAt: entry.createdAt,
            cloud: entry.cloud,
          });
        } catch (err) {
          console.warn(
            `[agent-store] migration: failed to write meta for ${entry.localDir}: ${(err as Error).message}`,
          );
        }
      }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(legacyPath, join(getAuggyDir(opts), `agents.json.migrated-${ts}`));
  } catch (err) {
    console.warn(`[agent-store] migration warning: ${(err as Error).message}`);
  }
}

function migrateOnce(opts: AgentStoreOptions = {}): void {
  const legacyPath = join(getAuggyDir(opts), LEGACY_INDEX_FILENAME);
  if (!existsSync(legacyPath)) return;
  migrateLegacyIndex(opts);
}

function isAgentDir(localDir: string): boolean {
  return existsSync(localDir) && existsSync(join(localDir, "agent.yaml"));
}

/**
 * Return the agent's entry, or `null` when no agent dir lives at the
 * expected path. The localDir is derived from the name — agents that
 * live elsewhere on disk are not discoverable through this API.
 */
export function getAgent(name: string, opts: AgentStoreOptions = {}): IndexEntry | null {
  migrateOnce(opts);
  const localDir = agentDir(name, opts);
  if (!isAgentDir(localDir)) return null;
  const meta = readMeta(localDir);
  return {
    localDir,
    createdAt: meta.createdAt,
    cloud: meta.cloud,
  };
}

/**
 * List all agents under `<auggyDir>/agents/`. Subdirectories without
 * `agent.yaml` are skipped (incomplete scaffolds, `.tmp-*` staging dirs).
 * Hidden directories (leading `.`) are also skipped.
 */
export function listAgents(
  opts: AgentStoreOptions = {},
): Array<IndexEntry & { name: string }> {
  migrateOnce(opts);
  const root = getAgentsRoot(opts);
  if (!existsSync(root)) return [];

  const out: Array<IndexEntry & { name: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const localDir = join(root, entry.name);
    if (!isAgentDir(localDir)) continue;
    const meta = readMeta(localDir);
    out.push({
      name: entry.name,
      localDir,
      createdAt: meta.createdAt,
      cloud: meta.cloud,
    });
  }
  return out;
}

/**
 * Remove the agent directory in its entirety. No-op if the dir is missing.
 *
 * Refuses to remove a path that does not contain `agent.yaml` — guards
 * against accidentally nuking arbitrary paths when callers pass derived
 * paths through this function.
 */
export function removeAgent(name: string, opts: AgentStoreOptions = {}): void {
  const localDir = agentDir(name, opts);
  if (!existsSync(localDir)) return;
  if (!existsSync(join(localDir, "agent.yaml"))) {
    throw new Error(`Refusing to delete "${localDir}" — it does not contain agent.yaml.`);
  }
  rmSync(localDir, { recursive: true, force: true });
}

/**
 * Write the cloud record into the agent's `.auggy-meta.json`. Throws when
 * the agent dir does not exist (callers should ensure the agent is
 * scaffolded before deploy).
 */
export function setCloud(
  name: string,
  record: NonNullable<CloudRecord>,
  opts: AgentStoreOptions = {},
): void {
  const localDir = agentDir(name, opts);
  if (!isAgentDir(localDir)) {
    throw new Error(`Cannot set cloud for "${name}": agent dir not found at ${localDir}.`);
  }
  const meta = readMeta(localDir);
  meta.cloud = record;
  writeMeta(localDir, meta);
}

/**
 * Clear the cloud record. No-op when the agent dir is missing or has no
 * cloud record set.
 */
export function clearCloud(name: string, opts: AgentStoreOptions = {}): void {
  const localDir = agentDir(name, opts);
  if (!isAgentDir(localDir)) return;
  const meta = readMeta(localDir);
  if (meta.cloud === null) return;
  meta.cloud = null;
  writeMeta(localDir, meta);
}

/**
 * Write the `.auggy-meta.json` for a freshly-scaffolded agent. Called by
 * `create.ts` before the atomic `renameSync` lifts the tempdir into place.
 * Exposed for tests that seed an agent without going through `runCreate`.
 *
 * `localDir` must already exist.
 */
export function writeAgentMeta(
  localDir: string,
  fields: { createdAt?: string; cloud?: CloudRecord } = {},
): void {
  if (!existsSync(localDir)) {
    throw new Error(`writeAgentMeta: ${localDir} does not exist.`);
  }
  writeMeta(localDir, {
    version: META_SCHEMA_VERSION,
    createdAt: fields.createdAt ?? new Date().toISOString(),
    cloud: fields.cloud ?? null,
  });
}

/**
 * Compute the canonical local directory for an agent name under the given
 * (optional) auggyDir. Does NOT check existence — callers that need to
 * know whether the agent exists should use `getAgent`.
 */
export function resolveAgentDir(name: string, opts: AgentStoreOptions = {}): string {
  return agentDir(name, opts);
}

/**
 * Best-effort sweep of stale `.tmp-*` scaffolds older than `maxAgeMs`.
 * Called from `runCreate` before a new scaffold so retry-after-crash flows
 * don't leave staging dirs lying around indefinitely.
 */
export function sweepStaleTempDirs(
  opts: AgentStoreOptions & { maxAgeMs?: number } = {},
): void {
  const root = getAgentsRoot(opts);
  if (!existsSync(root)) return;
  const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(".tmp-")) continue;
    const path = join(root, entry.name);
    try {
      const stats = statSync(path);
      if (stats.mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Test seam — used by tests that need to seed an "existing" agent without
// running the full `runCreate` flow. Production code should not call this.
// ---------------------------------------------------------------------------

/**
 * Test-only: seed an agent directory under `<auggyDir>/agents/<name>/`.
 *
 * Creates the dir, writes a minimal `agent.yaml`, and writes
 * `.auggy-meta.json`. Mirrors what `runCreate` produces, minus the
 * augment-specific files. Idempotent.
 *
 * Aliased as `addAgent` for compatibility with tests that pre-date the
 * filesystem-as-truth refactor; new tests should use `seedAgentForTest`.
 */
export function seedAgentForTest(
  name: string,
  opts: AgentStoreOptions & {
    yaml?: string;
    cloud?: CloudRecord;
    createdAt?: string;
  } = {},
): string {
  const localDir = agentDir(name, opts);
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    join(localDir, "agent.yaml"),
    opts.yaml ?? `id: aug1_${name}\nname: ${name}\n`,
  );
  writeAgentMeta(localDir, {
    createdAt: opts.createdAt,
    cloud: opts.cloud,
  });
  return localDir;
}

export { migrateLegacyIndex };

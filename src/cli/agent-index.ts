/**
 * Agent store — filesystem-as-truth.
 *
 * An agent IS a directory at `<auggyDir>/agents/<name>/` containing
 * `agent.yaml`. There is no central index file; `listAgents` scans the
 * directory, `getAgent` checks one path.
 *
 * Cloud-deployment metadata persists in `<agentDir>/.auggy-cloud.json`,
 * which exists only when the agent has been deployed. `createdAt` is
 * derived from the directory's filesystem birthtime/mtime — not stored.
 * File-existence carries information: present = deployed, absent = not.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudRecord, IndexEntry } from "./types";

const CLOUD_FILENAME = ".auggy-cloud.json";
const LEGACY_INDEX_FILENAME = "agents.json";
const LEGACY_META_FILENAME = ".auggy-meta.json";

interface AgentStoreOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
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

function cloudPath(localDir: string): string {
  return join(localDir, CLOUD_FILENAME);
}

/**
 * Derive the createdAt timestamp from the agent directory's filesystem
 * birthtime (preferred) or mtime (fallback for filesystems that don't
 * track birthtime). Stat failures fall back to "now" so a malformed dir
 * doesn't crash listAgents.
 */
function deriveCreatedAt(localDir: string): string {
  try {
    const stats = statSync(localDir);
    return (stats.birthtime ?? stats.mtime).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Read the cloud-deploy record. Returns null when the file is absent
 * (agent hasn't been deployed) or unreadable (treat as not-deployed
 * rather than crash the read path).
 */
function readCloud(localDir: string): CloudRecord {
  const path = cloudPath(localDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as NonNullable<CloudRecord>;
    return parsed;
  } catch {
    return null;
  }
}

function writeCloud(localDir: string, record: NonNullable<CloudRecord>): void {
  const path = cloudPath(localDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

function deleteCloud(localDir: string): void {
  const path = cloudPath(localDir);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}

/**
 * One-shot migration from older storage shapes:
 *   - Legacy `agents.json` (pre-filesystem-as-truth): distribute each
 *     entry's non-null cloud record into `<localDir>/.auggy-cloud.json`,
 *     then rename the legacy file aside with a timestamp.
 *   - In-progress `.auggy-meta.json` (intermediate shape never released):
 *     if it contains a cloud record, write it to `.auggy-cloud.json`;
 *     then delete the meta file.
 *
 * Best-effort: any failure is logged but does not block the caller.
 */
function migrateLegacyIndex(opts: AgentStoreOptions = {}): void {
  migrateLegacyAgentsJson(opts);
  migrateLegacyMetaFiles(opts);
}

function migrateLegacyAgentsJson(opts: AgentStoreOptions): void {
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
        if (existsSync(cloudPath(entry.localDir))) continue;
        if (entry.cloud === null) continue;
        try {
          writeCloud(entry.localDir, entry.cloud);
        } catch (err) {
          console.warn(
            `[agent-store] migration: failed to write cloud for ${entry.localDir}: ${(err as Error).message}`,
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

function migrateLegacyMetaFiles(opts: AgentStoreOptions): void {
  const root = getAgentsRoot(opts);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const localDir = join(root, entry.name);
    const metaPath = join(localDir, LEGACY_META_FILENAME);
    if (!existsSync(metaPath)) continue;
    try {
      const raw = readFileSync(metaPath, "utf-8");
      const parsed = JSON.parse(raw) as { cloud?: CloudRecord };
      if (parsed?.cloud && !existsSync(cloudPath(localDir))) {
        writeCloud(localDir, parsed.cloud);
      }
      unlinkSync(metaPath);
    } catch (err) {
      console.warn(
        `[agent-store] migration: failed to convert ${metaPath}: ${(err as Error).message}`,
      );
    }
  }
}

function migrateOnce(opts: AgentStoreOptions = {}): void {
  const legacyIndex = join(getAuggyDir(opts), LEGACY_INDEX_FILENAME);
  if (existsSync(legacyIndex)) {
    migrateLegacyAgentsJson(opts);
  }
  // Always sweep for stray .auggy-meta.json files — cheap, scoped to
  // existing agent dirs, and lets in-progress-branch installs upgrade
  // without operator intervention.
  migrateLegacyMetaFiles(opts);
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
  return {
    localDir,
    createdAt: deriveCreatedAt(localDir),
    cloud: readCloud(localDir),
  };
}

/**
 * List all agents under `<auggyDir>/agents/`. Subdirectories without
 * `agent.yaml` are skipped (incomplete scaffolds, `.tmp-*` staging dirs).
 * Hidden directories (leading `.`) are also skipped.
 */
export function listAgents(opts: AgentStoreOptions = {}): Array<IndexEntry & { name: string }> {
  migrateOnce(opts);
  const root = getAgentsRoot(opts);
  if (!existsSync(root)) return [];

  const out: Array<IndexEntry & { name: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const localDir = join(root, entry.name);
    if (!isAgentDir(localDir)) continue;
    out.push({
      name: entry.name,
      localDir,
      createdAt: deriveCreatedAt(localDir),
      cloud: readCloud(localDir),
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
 * Write the cloud record into the agent's `.auggy-cloud.json`. Throws
 * when the agent dir does not exist (callers should ensure the agent is
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
  writeCloud(localDir, record);
}

/**
 * Clear the cloud record by deleting `.auggy-cloud.json`. No-op when
 * the agent dir is missing or the file doesn't exist. The absence of
 * the file IS the "not-deployed" state — there is no null sentinel to
 * write.
 */
export function clearCloud(name: string, opts: AgentStoreOptions = {}): void {
  const localDir = agentDir(name, opts);
  if (!isAgentDir(localDir)) return;
  deleteCloud(localDir);
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
export function sweepStaleTempDirs(opts: AgentStoreOptions & { maxAgeMs?: number } = {}): void {
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
 * Creates the dir and writes a minimal `agent.yaml`. If `cloud` is
 * supplied, also writes `.auggy-cloud.json` so tests can simulate a
 * deployed agent. `createdAt` is intentionally not configurable —
 * tests that need it can stat the dir after seeding.
 */
export function seedAgentForTest(
  name: string,
  opts: AgentStoreOptions & {
    yaml?: string;
    cloud?: NonNullable<CloudRecord>;
  } = {},
): string {
  const localDir = agentDir(name, opts);
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, "agent.yaml"), opts.yaml ?? `id: aug1_${name}\nname: ${name}\n`);
  if (opts.cloud) {
    writeCloud(localDir, opts.cloud);
  }
  return localDir;
}

export { migrateLegacyIndex };

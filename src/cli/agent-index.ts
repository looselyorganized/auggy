/**
 * Agent store — filesystem-as-truth.
 *
 * An agent IS a directory containing `agent.yaml`. There is no central
 * index file for product workflows; command resolution starts from cwd,
 * an explicit --config path, or a named child directory.
 *
 * Cloud-deployment metadata persists in `<agentDir>/.auggy-cloud.json`,
 * which exists only when the agent has been deployed. `createdAt` is
 * derived from the directory's filesystem birthtime/mtime — not stored.
 * File-existence carries information: present = deployed, absent = not.
 *
 * This module exposes small filesystem helpers for cloud metadata plus
 * older test seams that still seed `<auggyDir>/agents/<name>/`.
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
import { parse as parseYaml } from "yaml";
import type { CloudRecord, IndexEntry } from "./types";

const CLOUD_FILENAME = ".auggy-cloud.json";

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

/** Read deployment metadata only when it is well-formed and identity-bound. */
export function readBoundCloudRecord(localDir: string, agentId: string): CloudRecord {
  const path = cloudPath(localDir);
  if (!existsSync(path)) return null;
  let record: CloudRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf-8")) as CloudRecord;
  } catch (error) {
    throw new Error(`Invalid cloud deployment metadata at ${path}; refusing cloud mutation.`, {
      cause: error,
    });
  }
  if (
    record?.version !== 1 ||
    record.agentId !== agentId ||
    record.provider !== "railway" ||
    !record.projectId ||
    !record.serviceId ||
    !record.url ||
    !record.volumeId ||
    !Number.isFinite(Date.parse(record.deployedAt))
  ) {
    throw new Error(
      `Cloud deployment metadata at ${path} is legacy, malformed, or belongs to another immutable agent. Remove it explicitly only after verifying the Railway target.`,
    );
  }
  return record;
}

function writeCloud(localDir: string, record: NonNullable<CloudRecord>): void {
  const path = cloudPath(localDir);
  const tmp = `${path}.tmp-${process.pid}`;
  const parsed = parseYaml(readFileSync(join(localDir, "agent.yaml"), "utf8")) as Record<
    string,
    unknown
  > | null;
  const agentId = parsed?.id;
  if (
    typeof agentId !== "string" ||
    !/^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agentId)
  ) {
    throw new Error("Cannot write cloud metadata without a valid immutable agent id");
  }
  if (record.agentId !== undefined && record.agentId !== agentId) {
    throw new Error("Cannot bind cloud metadata to a different immutable agent");
  }
  writeFileSync(tmp, `${JSON.stringify({ ...record, version: 1, agentId }, null, 2)}\n`);
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

function isAgentDir(localDir: string): boolean {
  return existsSync(localDir) && existsSync(join(localDir, "agent.yaml"));
}

/**
 * Return the agent's entry, or `null` when no agent dir lives at the
 * expected path. The localDir is derived from the name — agents that
 * live elsewhere on disk are not discoverable through this API.
 */
export function getAgent(name: string, opts: AgentStoreOptions = {}): IndexEntry | null {
  const localDir = agentDir(name, opts);
  if (!isAgentDir(localDir)) return null;
  return {
    localDir,
    createdAt: deriveCreatedAt(localDir),
    cloud: readCloud(localDir),
  };
}

/**
 * Read an agent entry from an explicit project directory. Used by
 * project-local workflows where the agent is not under ~/.auggy/agents.
 */
export function getAgentFromDir(localDir: string): IndexEntry | null {
  if (!isAgentDir(localDir)) return null;
  return {
    localDir,
    createdAt: deriveCreatedAt(localDir),
    cloud: readCloud(localDir),
  };
}

/**
 * List all agent projects under the configured agent root. Subdirectories without
 * `agent.yaml` are skipped (incomplete scaffolds, `.tmp-*` staging dirs).
 * Hidden directories (leading `.`) are also skipped.
 */
export function listAgents(opts: AgentStoreOptions = {}): Array<IndexEntry & { name: string }> {
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

export function setCloudForDir(localDir: string, record: NonNullable<CloudRecord>): void {
  if (!isAgentDir(localDir)) {
    throw new Error(`Cannot set cloud: agent dir not found at ${localDir}.`);
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
  writeFileSync(
    join(localDir, "agent.yaml"),
    opts.yaml ?? `id: aug1_00000000-0000-4000-8000-000000000001\nname: ${name}\n`,
  );
  if (opts.cloud) {
    writeCloud(localDir, opts.cloud);
  }
  return localDir;
}

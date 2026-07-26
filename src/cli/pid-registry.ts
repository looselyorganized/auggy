/**
 * Local runtime registry for independently operated Auggy agents.
 *
 * Modern manifests are keyed by immutable config id. Display names remain
 * useful aliases, but an ambiguous alias fails closed. Atomic resource claim
 * transactions prevent two local agents from consuming one exclusive
 * listener or inbound identity before either transport starts.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../lib/sqlite";
import { writeDurableJson } from "../lib/durable-json";
import { VALID_NAME_RE } from "./config-parser";
import type { PidManifest } from "./types";

interface PidRegistryOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
  /** Deterministic process-incarnation inspection for tests. */
  processIdentityForPid?: (pid: number) => string | null;
}

interface RuntimePidRegistryOptions extends PidRegistryOptions {
  internalMode?: string;
  /** @internal Deterministic publication barrier for generation-fence tests. */
  __testHooks?: { afterManifestPublished?: (manifest: PidManifest) => void };
}

interface ManifestRecord {
  path: string;
  manifest: PidManifest;
}

interface ResourceClaimRecord {
  version: 1 | 2;
  claim: string;
  agentId: string;
  agentName: string;
  pid: number;
  claimNonce: string;
  processIdentity?: string;
}

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_DATABASE_APPLICATION_ID = 0x4155434c; // "AUCL"
const CLAIM_DATABASE_SCHEMA_VERSION = 2;
const RESOURCE_CLAIM_SCHEMA = `CREATE TABLE IF NOT EXISTS runtime_resource_claims (
  claim            TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  pid              INTEGER NOT NULL,
  claim_nonce      TEXT NOT NULL,
  process_identity TEXT NOT NULL
)`;
const LAUNCHD_GENERATION_SCHEMA = `CREATE TABLE IF NOT EXISTS launchd_generation_state (
  agent_id          TEXT PRIMARY KEY,
  launch_generation TEXT NOT NULL,
  active            INTEGER NOT NULL CHECK (active IN (0, 1))
)`;

interface ResourceClaimRow {
  claim: string;
  agent_id: string;
  agent_name: string;
  pid: number;
  claim_nonce: string;
  process_identity: string;
}

export interface LaunchdGenerationState {
  launchGeneration: string;
  active: boolean;
}

export class RuntimeResourceConflictError extends Error {}

function registryDir(opts: PidRegistryOptions = {}): string {
  return opts.auggyDir ?? join(homedir(), ".auggy");
}

function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function ensureDir(opts: PidRegistryOptions = {}): string {
  return ensurePrivateDir(registryDir(opts));
}

function claimsDir(opts: PidRegistryOptions = {}): string {
  return ensurePrivateDir(join(ensureDir(opts), "runtime-claims"));
}

function manifestKey(manifest: PidManifest): string {
  return manifest.agentId ?? manifest.name;
}

function manifestPathForKey(key: string, opts: PidRegistryOptions = {}): string {
  return join(registryDir(opts), `${key}.json`);
}

function claimPath(claim: string, opts: PidRegistryOptions = {}): string {
  const digest = createHash("sha256")
    .update("auggy-runtime-resource\0")
    .update(claim)
    .digest("hex");
  return join(claimsDir(opts), `${digest}.json`);
}

function isSafeClaim(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

const STATE_PATH_CLAIM_PREFIX = "agent-state-path-v1:";

function statePathFromClaim(claim: string): string | null {
  if (!claim.startsWith(STATE_PATH_CLAIM_PREFIX)) return null;
  const encoded = claim.slice(STATE_PATH_CLAIM_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (
    !encoded ||
    !isAbsolute(decoded) ||
    Buffer.from(decoded, "utf8").toString("base64url") !== encoded
  ) {
    throw new Error("Invalid canonical agent state-path claim in runtime registry");
  }
  return decoded;
}

function pathsOverlap(first: string, second: string): boolean {
  const fromFirst = relative(first, second);
  const fromSecond = relative(second, first);
  const isWithin = (value: string) =>
    value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return isWithin(fromFirst) || isWithin(fromSecond);
}

function parseManifest(value: unknown, source: string): PidManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Auggy runtime manifest at ${source}`);
  }
  const record = value as Record<string, unknown>;
  const validBase =
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.name === "string" &&
    VALID_NAME_RE.test(record.name) &&
    (record.port === null ||
      (Number.isSafeInteger(record.port) &&
        (record.port as number) > 0 &&
        (record.port as number) <= 65_535)) &&
    typeof record.configPath === "string" &&
    isAbsolute(record.configPath) &&
    typeof record.agentDir === "string" &&
    isAbsolute(record.agentDir) &&
    typeof record.startedAt === "string" &&
    Number.isFinite(Date.parse(record.startedAt)) &&
    (record.mode === "dev" || record.mode === "launchd");
  if (!validBase) throw new Error(`Invalid Auggy runtime manifest at ${source}`);

  const modernFields = [
    record.agentId,
    record.claimNonce,
    record.processIdentity,
    record.resourceClaims,
    record.resourceClaimStore,
    record.launchGeneration,
  ];
  const hasModernField = modernFields.some((field) => field !== undefined);
  if (hasModernField) {
    if (
      typeof record.agentId !== "string" ||
      !AGENT_ID_RE.test(record.agentId) ||
      typeof record.claimNonce !== "string" ||
      !UUID_RE.test(record.claimNonce) ||
      (record.processIdentity !== undefined && !isSafeClaim(record.processIdentity)) ||
      !Array.isArray(record.resourceClaims) ||
      !record.resourceClaims.every(isSafeClaim) ||
      new Set(record.resourceClaims).size !== record.resourceClaims.length ||
      (record.resourceClaimStore !== undefined && record.resourceClaimStore !== "sqlite-v1") ||
      (record.launchGeneration !== undefined &&
        (typeof record.launchGeneration !== "string" ||
          !UUID_RE.test(record.launchGeneration) ||
          record.mode !== "launchd")) ||
      (record.mode === "launchd" && record.launchGeneration === undefined) ||
      (record.resourceClaimStore === "sqlite-v1" &&
        !(record.resourceClaims as string[]).includes(`agent-id:${String(record.agentId)}`))
    ) {
      throw new Error(`Invalid Auggy runtime manifest at ${source}`);
    }
  }
  return record as unknown as PidManifest;
}

function readManifestPath(path: string): PidManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Auggy runtime manifest at ${path}`, { cause: error });
  }
  return parseManifest(parsed, path);
}

function allManifestRecords(opts: PidRegistryOptions = {}): ManifestRecord[] {
  const dir = registryDir(opts);
  if (!existsSync(dir)) return [];
  const records: ManifestRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      records.push({ path, manifest: readManifestPath(path) });
    } catch {
      // Preserve malformed or unrelated JSON for operator inspection. It must
      // never become a signal target and is never deleted implicitly.
    }
  }
  return records;
}

function recordForIdentifier(
  identifier: string,
  opts: PidRegistryOptions = {},
): ManifestRecord | null {
  if (!AGENT_ID_RE.test(identifier) && !VALID_NAME_RE.test(identifier)) {
    throw new Error(`Invalid agent runtime identifier "${identifier}"`);
  }

  const exactPath = manifestPathForKey(identifier, opts);
  if (existsSync(exactPath)) {
    return { path: exactPath, manifest: readManifestPath(exactPath) };
  }
  if (AGENT_ID_RE.test(identifier)) return null;

  const matches = allManifestRecords(opts).filter((record) => record.manifest.name === identifier);
  if (matches.length > 1) {
    throw new Error(
      `Agent name "${identifier}" is ambiguous across ${matches.length} running identities. Use the immutable aug1_ id.`,
    );
  }
  return matches[0] ?? null;
}

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return an OS process-incarnation marker that changes when a PID is reused.
 * The marker contains no command line or environment data.
 */
export function getProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = afterCommand[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (startTicks && /^\d+$/.test(startTicks) && UUID_RE.test(bootId)) {
        return `linux:${bootId}:${startTicks}`;
      }
    } catch {
      return null;
    }
  }

  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    timeout: 1_000,
    maxBuffer: 4_096,
  });
  const started = result.status === 0 ? result.stdout.trim() : "";
  if (!started) return null;
  const digest = createHash("sha256")
    .update("auggy-process-incarnation\0")
    .update(process.platform)
    .update("\0")
    .update(started)
    .digest("hex");
  return `ps-sha256:${digest}`;
}

export type RuntimeProcessStatus = "alive" | "gone" | "reused" | "unverifiable";

/** Inspect both PID existence and its recorded OS process incarnation. */
export function inspectRuntimeProcess(
  manifest: Pick<PidManifest, "pid" | "processIdentity">,
  opts: PidRegistryOptions = {},
): RuntimeProcessStatus {
  if (!isProcessAlive(manifest.pid)) return "gone";
  if (!manifest.processIdentity) return "unverifiable";
  const current = (opts.processIdentityForPid ?? getProcessIdentity)(manifest.pid);
  if (!current) return "unverifiable";
  return current === manifest.processIdentity ? "alive" : "reused";
}

/** Write a validated PID manifest atomically without acquiring resource claims. */
export function writePidManifest(manifest: PidManifest, opts: PidRegistryOptions = {}): void {
  ensureDir(opts);
  const key = manifestKey(parseManifest(manifest, "new runtime manifest"));
  writeFileSync(manifestPathForKey(key, opts), JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

function parseClaim(value: unknown, source: string): ResourceClaimRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Auggy runtime resource claim at ${source}`);
  }
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    !isSafeClaim(record.claim) ||
    typeof record.agentId !== "string" ||
    !AGENT_ID_RE.test(record.agentId) ||
    typeof record.agentName !== "string" ||
    !VALID_NAME_RE.test(record.agentName) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    typeof record.claimNonce !== "string" ||
    !UUID_RE.test(record.claimNonce) ||
    (record.version === 2 && !isSafeClaim(record.processIdentity)) ||
    (record.version === 1 && record.processIdentity !== undefined)
  ) {
    throw new Error(`Invalid Auggy runtime resource claim at ${source}`);
  }
  return record as unknown as ResourceClaimRecord;
}

function readClaim(path: string): ResourceClaimRecord {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Auggy runtime resource claim at ${path}`, { cause: error });
  }
  return parseClaim(value, path);
}

function claimDatabasePath(opts: PidRegistryOptions): string {
  return join(ensureDir(opts), "runtime-claims.sqlite");
}

function hasExactClaimSchemaV1(objects: readonly SqliteSchemaObject[]): boolean {
  return (
    objects.length === 1 &&
    objects[0]?.type === "table" &&
    objects[0].name === "runtime_resource_claims" &&
    canonicalSqliteSchemaSql(objects[0].sql) === canonicalSqliteSchemaSql(RESOURCE_CLAIM_SCHEMA)
  );
}

function hasExactClaimSchemaV2(objects: readonly SqliteSchemaObject[]): boolean {
  const byName = new Map(objects.map((object) => [object.name, object]));
  const claims = byName.get("runtime_resource_claims");
  const generations = byName.get("launchd_generation_state");
  return (
    objects.length === 2 &&
    claims?.type === "table" &&
    generations?.type === "table" &&
    canonicalSqliteSchemaSql(claims.sql) === canonicalSqliteSchemaSql(RESOURCE_CLAIM_SCHEMA) &&
    canonicalSqliteSchemaSql(generations.sql) ===
      canonicalSqliteSchemaSql(LAUNCHD_GENERATION_SCHEMA)
  );
}

function openClaimDatabase(opts: PidRegistryOptions) {
  return openHardenedSqlite({
    path: claimDatabasePath(opts),
    label: "runtime resource claim registry",
    synchronous: "FULL",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "runtime resource claim registry",
        applicationId: CLAIM_DATABASE_APPLICATION_ID,
        schemaVersion: CLAIM_DATABASE_SCHEMA_VERSION,
        initialize(target) {
          target.run(RESOURCE_CLAIM_SCHEMA);
          target.run(LAUNCHD_GENERATION_SCHEMA);
        },
        isLegacy() {
          return false;
        },
        migrateOwned(target, fromVersion, objects) {
          if (fromVersion !== 1 || !hasExactClaimSchemaV1(objects)) {
            throw new Error("runtime resource claim registry: unsupported schema migration");
          }
          target.run(LAUNCHD_GENERATION_SCHEMA);
        },
        validate(_target, objects) {
          if (!hasExactClaimSchemaV2(objects)) {
            throw new Error(
              "runtime resource claim registry: database schema is missing, incompatible, or unexpected",
            );
          }
        },
      });
    },
  });
}

function assertLaunchdGenerationFields(agentId: string, launchGeneration: string): void {
  if (!AGENT_ID_RE.test(agentId) || !UUID_RE.test(launchGeneration)) {
    throw new Error("Launchd generation state requires a valid agent id and generation");
  }
}

function assertLaunchdGenerationActiveInDatabase(
  db: ReturnType<typeof openClaimDatabase>["db"],
  manifest: PidManifest,
): void {
  if (manifest.mode !== "launchd") return;
  const agentId = manifest.agentId;
  const launchGeneration = manifest.launchGeneration;
  if (!agentId || !launchGeneration) {
    throw new RuntimeResourceConflictError(
      "Launchd runtime admission requires an exact generation",
    );
  }
  const state = db
    .query<{ launch_generation: string; active: number }, [string]>(
      "SELECT launch_generation, active FROM launchd_generation_state WHERE agent_id = ?",
    )
    .get(agentId);
  if (state?.active !== 1 || state.launch_generation !== launchGeneration) {
    throw new RuntimeResourceConflictError(
      `Launchd installation generation ${launchGeneration} is closed or superseded for agent "${manifest.name}".`,
    );
  }
}

function assertLaunchdGenerationActive(manifest: PidManifest, opts: PidRegistryOptions): void {
  if (manifest.mode !== "launchd") return;
  const database = openClaimDatabase(opts);
  try {
    assertLaunchdGenerationActiveInDatabase(database.db, manifest);
  } finally {
    database.close();
  }
}

/** Mark one launchd installation generation as the only generation allowed to boot. */
export function activateLaunchdGeneration(
  agentId: string,
  launchGeneration: string,
  opts: PidRegistryOptions = {},
): void {
  assertLaunchdGenerationFields(agentId, launchGeneration);
  const database = openClaimDatabase(opts);
  try {
    database.db
      .query(
        `INSERT INTO launchd_generation_state (agent_id, launch_generation, active)
         VALUES (?, ?, 1)
         ON CONFLICT(agent_id) DO UPDATE SET
           launch_generation = excluded.launch_generation,
           active = 1`,
      )
      .run(agentId, launchGeneration);
  } finally {
    database.close();
  }
}

/** Permanently close an exact launchd generation before its job is unloaded. */
export function closeLaunchdGeneration(
  agentId: string,
  launchGeneration: string,
  opts: PidRegistryOptions = {},
): void {
  assertLaunchdGenerationFields(agentId, launchGeneration);
  const database = openClaimDatabase(opts);
  try {
    database.db
      .transaction(() => {
        const state = database.db
          .query<{ launch_generation: string; active: number }, [string]>(
            "SELECT launch_generation, active FROM launchd_generation_state WHERE agent_id = ?",
          )
          .get(agentId);
        if (state && state.launch_generation !== launchGeneration) {
          throw new RuntimeResourceConflictError(
            `Agent ${agentId} has a different launchd installation generation.`,
          );
        }
        database.db
          .query(
            `INSERT INTO launchd_generation_state (agent_id, launch_generation, active)
             VALUES (?, ?, 0)
             ON CONFLICT(agent_id) DO UPDATE SET active = 0`,
          )
          .run(agentId, launchGeneration);
      })
      .immediate();
  } finally {
    database.close();
  }
}

/** Read the durable launchd installation generation for exact-id recovery. */
export function readLaunchdGenerationState(
  agentId: string,
  opts: PidRegistryOptions = {},
): LaunchdGenerationState | null {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error("Launchd generation lookup requires a valid agent id");
  }
  const database = openClaimDatabase(opts);
  try {
    const state = database.db
      .query<{ launch_generation: string; active: number }, [string]>(
        "SELECT launch_generation, active FROM launchd_generation_state WHERE agent_id = ?",
      )
      .get(agentId);
    if (!state) return null;
    if (!UUID_RE.test(state.launch_generation) || (state.active !== 0 && state.active !== 1)) {
      throw new Error(`Invalid launchd generation state for agent ${agentId}`);
    }
    return { launchGeneration: state.launch_generation, active: state.active === 1 };
  } finally {
    database.close();
  }
}

/** Close whichever launchd generation is currently recorded for one agent. */
export function closeActiveLaunchdGeneration(
  agentId: string,
  opts: PidRegistryOptions = {},
): LaunchdGenerationState | null {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error("Launchd generation closure requires a valid agent id");
  }
  const database = openClaimDatabase(opts);
  try {
    let result: LaunchdGenerationState | null = null;
    database.db
      .transaction(() => {
        const state = database.db
          .query<{ launch_generation: string; active: number }, [string]>(
            "SELECT launch_generation, active FROM launchd_generation_state WHERE agent_id = ?",
          )
          .get(agentId);
        if (!state) return;
        if (!UUID_RE.test(state.launch_generation) || (state.active !== 0 && state.active !== 1)) {
          throw new Error(`Invalid launchd generation state for agent ${agentId}`);
        }
        database.db
          .query("UPDATE launchd_generation_state SET active = 0 WHERE agent_id = ?")
          .run(agentId);
        result = { launchGeneration: state.launch_generation, active: state.active === 1 };
      })
      .immediate();
    return result;
  } finally {
    database.close();
  }
}

function claimRecordFromRow(row: ResourceClaimRow): ResourceClaimRecord {
  return parseClaim(
    {
      version: 2,
      claim: row.claim,
      agentId: row.agent_id,
      agentName: row.agent_name,
      pid: row.pid,
      claimNonce: row.claim_nonce,
      processIdentity: row.process_identity,
    },
    "runtime resource claim registry",
  );
}

function rejectOrRemoveLegacyClaim(claim: string, opts: PidRegistryOptions): void {
  const path = claimPath(claim, opts);
  if (!existsSync(path)) return;
  const existing = readClaim(path);
  const status = inspectRuntimeProcess(existing, opts);
  if (status === "alive" || status === "unverifiable") {
    throw new RuntimeResourceConflictError(
      `Runtime resource "${claim}" is already claimed by pre-upgrade agent "${existing.agentName}". Stop all pre-upgrade runtimes before retrying.`,
    );
  }
  unlinkSync(path);
}

function acquireResourceClaims(manifest: PidManifest, opts: PidRegistryOptions): string[] {
  const claims = [...(manifest.resourceClaims ?? [])].sort();
  if (claims.length === 0) return [];
  if (!manifest.agentId || !manifest.claimNonce) {
    throw new Error("Modern runtime resource claims require immutable agentId and claimNonce");
  }
  if (!manifest.processIdentity) {
    throw new Error("Modern runtime resource claims require an OS process identity");
  }
  if (manifest.resourceClaimStore !== "sqlite-v1") {
    throw new Error("Modern runtime resource claims require the crash-recoverable SQLite store");
  }

  const database = openClaimDatabase(opts);
  const db = database.db;
  try {
    const select = db.query<ResourceClaimRow, [string]>(
      "SELECT claim, agent_id, agent_name, pid, claim_nonce, process_identity FROM runtime_resource_claims WHERE claim = ?",
    );
    const selectStatePaths = db.query<ResourceClaimRow, []>(
      "SELECT claim, agent_id, agent_name, pid, claim_nonce, process_identity FROM runtime_resource_claims WHERE claim LIKE 'agent-state-path-v1:%'",
    );
    const remove = db.query("DELETE FROM runtime_resource_claims WHERE claim = ?");
    const insert = db.query(
      `INSERT INTO runtime_resource_claims
         (claim, agent_id, agent_name, pid, claim_nonce, process_identity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      assertLaunchdGenerationActiveInDatabase(db, manifest);
      for (const claim of claims) {
        rejectOrRemoveLegacyClaim(claim, opts);
        const requestedStatePath = statePathFromClaim(claim);
        if (requestedStatePath) {
          for (const stateRow of selectStatePaths.all()) {
            if (stateRow.claim === claim) continue;
            const existingStatePath = statePathFromClaim(stateRow.claim);
            if (!existingStatePath || !pathsOverlap(requestedStatePath, existingStatePath)) {
              continue;
            }
            const existing = claimRecordFromRow(stateRow);
            const status = inspectRuntimeProcess(existing, opts);
            if (status === "alive" || status === "unverifiable") {
              throw new RuntimeResourceConflictError(
                `Agent state directory overlaps the live state owned by agent "${existing.agentName}".`,
              );
            }
            remove.run(stateRow.claim);
          }
        }
        const row = select.get(claim);
        if (row) {
          const existing = claimRecordFromRow(row);
          const status = inspectRuntimeProcess(existing, opts);
          if (status === "alive" || status === "unverifiable") {
            throw new RuntimeResourceConflictError(
              `Runtime resource "${claim}" is already claimed by agent "${existing.agentName}".`,
            );
          }
          remove.run(claim);
        }
        insert.run(
          claim,
          manifest.agentId!,
          manifest.name,
          manifest.pid,
          manifest.claimNonce!,
          manifest.processIdentity!,
        );
      }
    }).immediate();
    return claims;
  } finally {
    database.close();
  }
}

function releaseResourceClaims(manifest: PidManifest, opts: PidRegistryOptions): void {
  if (!manifest.agentId || !manifest.claimNonce) return;
  const claims = manifest.resourceClaims ?? [];
  if (manifest.resourceClaimStore !== "sqlite-v1") {
    for (const claim of claims) {
      const path = claimPath(claim, opts);
      if (!existsSync(path)) continue;
      const existing = readClaim(path);
      if (existing.agentId === manifest.agentId && existing.claimNonce === manifest.claimNonce) {
        unlinkSync(path);
      }
    }
    return;
  }
  if (claims.length === 0) return;
  const database = openClaimDatabase(opts);
  try {
    const remove = database.db.query(
      "DELETE FROM runtime_resource_claims WHERE claim = ? AND agent_id = ? AND claim_nonce = ?",
    );
    database.db
      .transaction(() => {
        for (const claim of claims) remove.run(claim, manifest.agentId!, manifest.claimNonce!);
      })
      .immediate();
  } finally {
    database.close();
  }
}

function sameManifestOwner(current: PidManifest, expected: PidManifest): boolean {
  if (expected.agentId && expected.claimNonce) {
    return current.agentId === expected.agentId && current.claimNonce === expected.claimNonce;
  }
  return (
    !current.agentId &&
    current.name === expected.name &&
    current.pid === expected.pid &&
    current.startedAt === expected.startedAt
  );
}

function removeManifestRecord(
  record: ManifestRecord,
  opts: PidRegistryOptions,
  expected: PidManifest = record.manifest,
): boolean {
  if (expected.resourceClaimStore === "sqlite-v1" && expected.agentId && expected.claimNonce) {
    const database = openClaimDatabase(opts);
    try {
      return database.db
        .transaction(() => {
          if (!existsSync(record.path)) return false;
          const current = readManifestPath(record.path);
          if (!sameManifestOwner(current, expected)) return false;
          database.db
            .query("DELETE FROM runtime_resource_claims WHERE agent_id = ? AND claim_nonce = ?")
            .run(expected.agentId!, expected.claimNonce!);
          unlinkSync(record.path);
          return true;
        })
        .immediate();
    } finally {
      database.close();
    }
  }

  if (!existsSync(record.path)) return false;
  const current = readManifestPath(record.path);
  if (!sameManifestOwner(current, expected)) return false;
  releaseResourceClaims(expected, opts);
  unlinkSync(record.path);
  return true;
}

/**
 * Do not let an identity-keyed runtime overlap a pre-upgrade name-keyed
 * runtime. Legacy manifests did not acquire resource leases, so checking them
 * before modern claims is the only safe upgrade boundary for non-port
 * transports such as Telegram polling.
 */
function removeStaleOrRejectLivePreSqliteManifest(
  manifest: PidManifest,
  opts: PidRegistryOptions,
): void {
  if (!manifest.agentId) return;

  const records = new Map<string, ManifestRecord>();
  const exactLegacyPath = manifestPathForKey(manifest.name, opts);
  if (existsSync(exactLegacyPath)) {
    records.set(exactLegacyPath, {
      path: exactLegacyPath,
      manifest: readManifestPath(exactLegacyPath),
    });
  }
  for (const record of allManifestRecords(opts)) {
    if (record.manifest.resourceClaimStore !== "sqlite-v1") records.set(record.path, record);
  }

  for (const record of records.values()) {
    if (isProcessAlive(record.manifest.pid)) {
      throw new RuntimeResourceConflictError(
        `Pre-upgrade runtime for agent "${record.manifest.name}" may still be running. Stop all pre-upgrade runtimes before starting an agent with the crash-recoverable claim registry.`,
      );
    }
    removeManifestRecord(record, opts);
  }
}

/** Claim the local registry and every declared exclusive resource atomically. */
export function claimRuntimePidManifest(
  manifest: PidManifest,
  opts: RuntimePidRegistryOptions = {},
): boolean {
  if (opts.internalMode === "railway") return false;
  parseManifest(manifest, "new runtime manifest");
  if (manifest.agentId && !manifest.processIdentity) {
    throw new Error("Modern runtime manifests require an OS process identity");
  }
  if (manifest.agentId && manifest.resourceClaimStore !== "sqlite-v1") {
    throw new Error("Modern runtime manifests require the crash-recoverable SQLite claim store");
  }
  removeStaleOrRejectLivePreSqliteManifest(manifest, opts);

  if (manifest.agentId) {
    const exactPath = manifestPathForKey(manifestKey(manifest), opts);
    const existing = existsSync(exactPath)
      ? { path: exactPath, manifest: readManifestPath(exactPath) }
      : null;
    const status = existing ? inspectRuntimeProcess(existing.manifest, opts) : "gone";
    if (status === "alive" || status === "unverifiable") {
      throw new RuntimeResourceConflictError(
        `Agent "${manifest.name}" already has a live or unverifiable runtime manifest.`,
      );
    }

    acquireResourceClaims(manifest, opts);
    try {
      if (existing) removeManifestRecord(existing, opts);
      writeDurableJson(exactPath, manifest, "Auggy runtime manifest");
      opts.__testHooks?.afterManifestPublished?.(manifest);
      try {
        assertLaunchdGenerationActive(manifest, opts);
      } catch (error) {
        removeManifestRecord({ path: exactPath, manifest }, opts, manifest);
        throw error;
      }
      return true;
    } catch (error) {
      releaseResourceClaims(manifest, opts);
      throw error;
    }
  }

  acquireResourceClaims(manifest, opts);
  try {
    try {
      writePidManifest(manifest, opts);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = recordForIdentifier(manifestKey(manifest), opts);
      const status = existing ? inspectRuntimeProcess(existing.manifest, opts) : "gone";
      if (status === "alive" || status === "unverifiable") throw error;
      if (existing) removeManifestRecord(existing, opts);
      writePidManifest(manifest, opts);
      return true;
    }
  } catch (error) {
    if (manifest.agentId && manifest.claimNonce) {
      releaseResourceClaims(manifest, opts);
    }
    throw error;
  }
}

/** Reserve one immutable agent identity while an operator mutates its project. */
export function claimAgentMaintenance(
  agentId: string,
  agentName: string,
  additionalClaims: readonly string[] = [],
  opts: PidRegistryOptions = {},
): () => void {
  if (!AGENT_ID_RE.test(agentId) || !VALID_NAME_RE.test(agentName)) {
    throw new Error("Maintenance claims require a valid immutable agent identity and name");
  }
  const processIdentity = (opts.processIdentityForPid ?? getProcessIdentity)(process.pid);
  if (!processIdentity) {
    throw new Error("Cannot establish the operator process incarnation for maintenance");
  }
  const claim: PidManifest = {
    pid: process.pid,
    name: agentName,
    agentId,
    claimNonce: randomUUID(),
    processIdentity,
    resourceClaims: [...new Set([`agent-id:${agentId}`, ...additionalClaims])].sort(),
    resourceClaimStore: "sqlite-v1",
    port: null,
    configPath: "/maintenance/agent.yaml",
    agentDir: "/maintenance",
    startedAt: new Date().toISOString(),
    mode: "dev",
  };
  removeStaleOrRejectLivePreSqliteManifest(claim, opts);
  acquireResourceClaims(claim, opts);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResourceClaims(claim, opts);
  };
}

/** Serialize launchd control-plane mutations without conflicting with the runtime itself. */
export function claimAgentLifecycle(
  agentId: string,
  agentName: string,
  opts: PidRegistryOptions = {},
): () => void {
  if (!AGENT_ID_RE.test(agentId) || !VALID_NAME_RE.test(agentName)) {
    throw new Error("Lifecycle claims require a valid immutable agent identity and name");
  }
  const processIdentity = (opts.processIdentityForPid ?? getProcessIdentity)(process.pid);
  if (!processIdentity) {
    throw new Error("Cannot establish the operator process incarnation for lifecycle control");
  }
  const claim: PidManifest = {
    pid: process.pid,
    name: agentName,
    agentId,
    claimNonce: randomUUID(),
    processIdentity,
    resourceClaims: [`agent-lifecycle:${agentId}`],
    resourceClaimStore: "sqlite-v1",
    port: null,
    configPath: "/lifecycle/agent.yaml",
    agentDir: "/lifecycle",
    startedAt: new Date().toISOString(),
    mode: "dev",
  };
  acquireResourceClaims(claim, opts);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResourceClaims(claim, opts);
  };
}

/** Release a manifest only when claimRuntimePidManifest actually wrote it. */
export function releaseRuntimePidManifest(
  manifest: PidManifest,
  claimed: boolean,
  opts: PidRegistryOptions = {},
): void {
  if (!claimed) return;
  const record = recordForIdentifier(manifestKey(manifest), opts);
  if (record) removeManifestRecord(record, opts, manifest);
}

/** Read by immutable id or by an unambiguous display-name alias. */
export function readPidManifest(
  identifier: string,
  opts: PidRegistryOptions = {},
): PidManifest | null {
  return recordForIdentifier(identifier, opts)?.manifest ?? null;
}

/** Read a manifest only when its process is still alive. */
export function readLivePidManifest(
  identifier: string,
  opts: PidRegistryOptions = {},
): PidManifest | null {
  const record = recordForIdentifier(identifier, opts);
  if (!record) return null;
  const status = inspectRuntimeProcess(record.manifest, opts);
  if (status === "alive") return record.manifest;
  if (status === "unverifiable") {
    throw new Error(
      `Cannot verify the process incarnation for agent "${record.manifest.name}"; refusing to treat PID ${record.manifest.pid} as its runtime.`,
    );
  }
  removeManifestRecord(record, opts);
  return null;
}

/** Format a conflict using details from the existing runtime manifest. */
export function formatAgentAlreadyRunningMessage(
  name: string,
  manifest: PidManifest | null,
): string {
  const details = manifest
    ? ` (PID ${manifest.pid}${manifest.port !== null ? `, port ${manifest.port}` : ""})`
    : "";
  const consoleUrl =
    manifest?.port !== null && manifest?.port !== undefined
      ? `\nConsole: http://localhost:${manifest.port}/console`
      : "";

  return `Agent "${name}" is already running${details}.${consoleUrl}\nStop it with: auggy stop ${name}`;
}

/** Remove a manifest and only the resource claims owned by its claim nonce. */
export function removePidManifest(identifier: string, opts: PidRegistryOptions = {}): void {
  const record = recordForIdentifier(identifier, opts);
  if (record) removeManifestRecord(record, opts);
}

/** Remove only the exact PID-manifest generation captured by the caller. */
export function removePidManifestIfOwned(
  manifest: PidManifest,
  opts: PidRegistryOptions = {},
): boolean {
  const record = recordForIdentifier(manifestKey(manifest), opts);
  return record ? removeManifestRecord(record, opts, manifest) : false;
}

/** List live manifests. Malformed files are preserved and never signaled. */
export function listPidManifests(opts: PidRegistryOptions = {}): PidManifest[] {
  const manifests: PidManifest[] = [];
  for (const record of allManifestRecords(opts)) {
    const status = inspectRuntimeProcess(record.manifest, opts);
    if (status === "alive" || status === "unverifiable") {
      manifests.push(record.manifest);
    } else {
      removeManifestRecord(record, opts);
    }
  }
  return manifests;
}

export function tryClaimName(name: string, opts: PidRegistryOptions = {}): boolean {
  try {
    return readLivePidManifest(name, opts) === null;
  } catch {
    return false;
  }
}

export function getAuggyDir(): string {
  return ensureDir();
}

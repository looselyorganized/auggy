import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../lib/sqlite";
import type {
  DurableJobErrorCode,
  DurableJobLease,
  DurableJobPayload,
  DurableJobRecord,
  DurableJobScheduleDefinition,
  DurableJobScheduleSummary,
  DurableJobState,
  DurableJobStore,
  DurableJobSummary,
  DurableScheduleMaterializationResult,
  SqliteDurableJobStoreOptions,
} from "./types";
import { DURABLE_JOB_ERROR_CODES } from "./types";
import { nextUtcCron, parseUtcCron } from "./cron";

export const DURABLE_JOBS_APPLICATION_ID = 0x444a4f42; // "DJOB"
export const DURABLE_JOBS_SCHEMA_VERSION = 2;
const LABEL = "durable jobs";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST = 100;
const MAX_PRUNE = 1_000;
const MAX_SCHEDULES = 100;
const MAX_SCHEDULE_TICK = 100;
const MAX_LEASE_MS = 60 * 60_000;
const MAX_RECOVERY_PER_TRANSITION = 100;
const MAX_ATTEMPT_EXHAUSTION_PER_CLAIM = 100;
const DEFAULT_MAX_TOTAL_RECORDS = 10_000;
const DEFAULT_MAX_QUEUED_RECORDS = 1_000;
const DEFAULT_MAX_PRIVATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCHEDULE_PRIVATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS_PER_JOB = 20;
const DEFAULT_MAX_AUDIT_RECORDS = 200_000;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MIN_AUDIT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_TOTAL_RECORDS = 1_000_000;
const MAX_QUEUED_RECORDS = 1_000_000;
const MAX_PRIVATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RETENTION_MS = 3_650 * 24 * 60 * 60_000;
const MAX_ATTEMPTS_PER_JOB = 1_000;
const MAX_AUDIT_RECORDS = 1_000_000;

const OUTCOME_REASON_CODES = new Set([
  "cancel-completion-race",
  "cancel-failure-race",
  "execution-outcome-unknown",
  "lease-expired",
  "process-restarted",
  "shutdown-interrupted",
]);
const CANCEL_REASON_CODES = new Set(["deadline-exceeded", "operator-requested", "shutdown"]);
const ERROR_CODES = new Set<string>(DURABLE_JOB_ERROR_CODES);

/** Exact branded schema shipped before schedule persistence. */
const V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS durable_jobs (
    job_id                 TEXT PRIMARY KEY,
    idempotency_key_hash   TEXT NOT NULL UNIQUE,
    binding_hash           TEXT NOT NULL,
    payload_json           TEXT NOT NULL,
    private_bytes          INTEGER NOT NULL CHECK (private_bytes >= 1),
    state                  TEXT NOT NULL CHECK (state IN ('queued','leased','running','completed','failed','canceled','outcome_unknown')),
    attempt                INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    available_at           INTEGER NOT NULL,
    lease_owner            TEXT,
    lease_token            TEXT,
    lease_expires_at       INTEGER,
    started_at             INTEGER,
    completed_at           INTEGER,
    result_json            TEXT,
    error_code             TEXT,
    cancel_requested       INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
    cancel_reason          TEXT,
    incident_id            TEXT UNIQUE,
    incident_version       INTEGER,
    incident_reason_code   TEXT,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_durable_jobs_claim
     ON durable_jobs(state, available_at, created_at, job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_durable_jobs_retention
     ON durable_jobs(state, updated_at, job_id)`,
  `CREATE TABLE IF NOT EXISTS durable_job_attempts (
    job_id       TEXT NOT NULL,
    attempt      INTEGER NOT NULL CHECK (attempt >= 1),
    lease_token  TEXT NOT NULL,
    worker_id    TEXT NOT NULL,
    claimed_at   INTEGER NOT NULL,
    started_at   INTEGER,
    settled_at   INTEGER,
    state        TEXT NOT NULL CHECK (state IN ('leased','running','completed','failed','canceled','outcome_unknown','requeued')),
    PRIMARY KEY (job_id, attempt),
    FOREIGN KEY (job_id) REFERENCES durable_jobs(job_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS durable_job_incidents (
    incident_id    TEXT PRIMARY KEY,
    job_id         TEXT NOT NULL UNIQUE,
    version        INTEGER NOT NULL CHECK (version >= 1),
    reason_code    TEXT NOT NULL,
    detected_at    INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES durable_jobs(job_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS durable_job_reconciliations (
    incident_id      TEXT PRIMARY KEY,
    job_id           TEXT NOT NULL,
    incident_version INTEGER NOT NULL CHECK (incident_version >= 1),
    disposition      TEXT NOT NULL CHECK (disposition IN ('retry','cancel','confirm_completed')),
    evidence_sha256  TEXT NOT NULL,
    reconciled_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_durable_job_incidents_time
     ON durable_job_incidents(detected_at, incident_id)`,
] as const;

const SCHEDULE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS durable_job_schedules (
    schedule_id           TEXT PRIMARY KEY,
    cron                  TEXT NOT NULL,
    definition_hash       TEXT NOT NULL,
    binding_json          TEXT NOT NULL,
    payload_json          TEXT NOT NULL,
    private_bytes         INTEGER NOT NULL CHECK (private_bytes >= 1),
    revision              INTEGER NOT NULL CHECK (revision >= 1),
    version               INTEGER NOT NULL CHECK (version >= 1),
    config_enabled        INTEGER NOT NULL CHECK (config_enabled IN (0,1)),
    operator_paused       INTEGER NOT NULL CHECK (operator_paused IN (0,1)),
    next_fire_at          INTEGER NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_durable_job_schedules_due
     ON durable_job_schedules(config_enabled, operator_paused, next_fire_at, schedule_id)`,
  `CREATE TABLE IF NOT EXISTS durable_job_schedule_occurrences (
    schedule_id           TEXT NOT NULL,
    revision              INTEGER NOT NULL CHECK (revision >= 1),
    scheduled_for         INTEGER NOT NULL,
    job_id                TEXT NOT NULL UNIQUE,
    created_at            INTEGER NOT NULL,
    PRIMARY KEY (schedule_id, revision, scheduled_for),
    FOREIGN KEY (schedule_id) REFERENCES durable_job_schedules(schedule_id),
    FOREIGN KEY (job_id) REFERENCES durable_jobs(job_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_durable_job_schedule_occurrences_job
     ON durable_job_schedule_occurrences(job_id)`,
] as const;

const SCHEMA = [...V1_SCHEMA, ...SCHEDULE_SCHEMA] as const;

const EXPECTED_SCHEMA = new Map(
  SCHEMA.map((sql) => {
    const name = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i)?.[1];
    if (!name) throw new Error(`${LABEL}: invalid schema declaration`);
    return [name, canonicalSqliteSchemaSql(sql)] as const;
  }),
);
const EXPECTED_V1_SCHEMA = new Map(
  V1_SCHEMA.map((sql) => {
    const name = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i)?.[1];
    if (!name) throw new Error(`${LABEL}: invalid v1 schema declaration`);
    return [name, canonicalSqliteSchemaSql(sql)] as const;
  }),
);

interface Row {
  job_id: string;
  idempotency_key_hash: string;
  binding_hash: string;
  payload_json: string;
  private_bytes: number;
  state: DurableJobState;
  attempt: number;
  version: number;
  available_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result_json: string | null;
  error_code: string | null;
  cancel_requested: number;
  cancel_reason: string | null;
  incident_id: string | null;
  incident_version: number | null;
  incident_reason_code: string | null;
  created_at: number;
  updated_at: number;
}

interface ScheduleRow {
  schedule_id: string;
  cron: string;
  definition_hash: string;
  binding_json: string;
  payload_json: string;
  private_bytes: number;
  revision: number;
  version: number;
  config_enabled: number;
  operator_paused: number;
  next_fire_at: number;
  created_at: number;
  updated_at: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${LABEL}: ${label} must contain 1 to 128 safe characters`);
  }
  return value;
}

function safeText(value: string, label: string, max = 256): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${LABEL}: ${label} is invalid`);
  }
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > max || hasControlCharacter) {
    throw new Error(`${LABEL}: ${label} is invalid`);
  }
  return normalized;
}

function safeCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error(`${LABEL}: ${label} must be a non-secret fixed code`);
  }
  return value;
}

function allowedReason(value: string, label: string, allowed: ReadonlySet<string>): string {
  const code = safeCode(value, label);
  if (!allowed.has(code)) throw new Error(`${LABEL}: ${label} is not allowed`);
  return code;
}

function allowedErrorCode(value: unknown): DurableJobErrorCode {
  const code = safeCode(value, "errorCode");
  if (!ERROR_CODES.has(code)) throw new Error(`${LABEL}: errorCode is not allowed`);
  return code as DurableJobErrorCode;
}

function safeTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${LABEL}: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${LABEL}: ${label} timestamp addition exceeds the safe integer range`);
  }
  return result;
}

function jsonStringBytes(value: string, remaining: number): number {
  let bytes = 2;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f)
      bytes +=
        character === "\b" ||
        character === "\t" ||
        character === "\n" ||
        character === "\f" ||
        character === "\r"
          ? 2
          : 6;
    else if (character === '"' || character === "\\") bytes += 2;
    else if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint >= 0xd800 && codePoint <= 0xdfff) bytes += 6;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
    if (bytes > remaining) return bytes;
  }
  return bytes;
}

function boundedJson(value: unknown, _label: string): string {
  const chunks: string[] = [];
  let bytes = 0;
  let nodes = 0;
  const append = (chunk: string, chunkBytes = Buffer.byteLength(chunk, "utf8")) => {
    if (bytes + chunkBytes > MAX_JSON_BYTES) {
      throw new Error(`${LABEL}: private JSON exceeds ${MAX_JSON_BYTES} bytes`);
    }
    bytes += chunkBytes;
    chunks.push(chunk);
  };
  const serialize = (current: unknown, depth: number): void => {
    if (depth > 16) throw new Error(`${LABEL}: private JSON exceeds maximum nesting`);
    nodes++;
    if (nodes > 10_000) throw new Error(`${LABEL}: private JSON exceeds maximum nodes`);
    if (current === null) {
      append("null", 4);
      return;
    }
    if (typeof current === "string") {
      const stringBytes = jsonStringBytes(current, MAX_JSON_BYTES - bytes);
      if (bytes + stringBytes > MAX_JSON_BYTES) {
        throw new Error(`${LABEL}: private JSON exceeds ${MAX_JSON_BYTES} bytes`);
      }
      append(JSON.stringify(current), stringBytes);
      return;
    }
    if (typeof current === "boolean") {
      append(current ? "true" : "false", current ? 4 : 5);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new Error(`${LABEL}: private JSON contains a non-finite number`);
      append(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      append("[", 1);
      for (let index = 0; index < current.length; index++) {
        if (index > 0) append(",", 1);
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new Error(`${LABEL}: private JSON arrays must contain dense data properties`);
        }
        serialize(descriptor.value, depth + 1);
      }
      append("]", 1);
      return;
    }
    if (typeof current === "object" && Object.getPrototypeOf(current) === Object.prototype) {
      const object = current as Record<string, unknown>;
      const keys: string[] = [];
      const remainingNodes = 10_000 - nodes;
      // Descriptor reads reject ordinary accessors without invoking them.
      // Proxies remain part of the trusted programmatic submission boundary.
      for (const key in object) {
        if (!Object.hasOwn(object, key)) continue;
        if (keys.length >= remainingNodes) {
          throw new Error(`${LABEL}: private JSON exceeds maximum nodes`);
        }
        keys.push(key);
      }
      keys.sort();
      append("{", 1);
      for (let index = 0; index < keys.length; index++) {
        if (index > 0) append(",", 1);
        const key = keys[index]!;
        const keyBytes = jsonStringBytes(key, MAX_JSON_BYTES - bytes);
        if (bytes + keyBytes > MAX_JSON_BYTES) {
          throw new Error(`${LABEL}: private JSON exceeds ${MAX_JSON_BYTES} bytes`);
        }
        append(JSON.stringify(key), keyBytes);
        append(":", 1);
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error(`${LABEL}: private JSON cannot contain enumerable accessors`);
        }
        serialize(descriptor.value, depth + 1);
      }
      append("}", 1);
      return;
    }
    throw new Error(`${LABEL}: private JSON must contain only JSON values`);
  };
  serialize(value, 0);
  return chunks.join("");
}

function payloadJson(payload: DurableJobPayload): string {
  const candidate = payload as unknown;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new Error(`${LABEL}: payload must use version 1`);
  }
  const version = Object.getOwnPropertyDescriptor(candidate, "version");
  const value = Object.getOwnPropertyDescriptor(candidate, "value");
  if (
    !version?.enumerable ||
    !("value" in version) ||
    version.value !== 1 ||
    !value?.enumerable ||
    !("value" in value)
  ) {
    throw new Error(`${LABEL}: payload must use own enumerable data properties for version 1`);
  }
  return boundedJson(payload, "payload");
}

function parsePayload(value: string): DurableJobPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch (error) {
    throw new Error(`${LABEL}: stored payload is invalid`, { cause: error });
  }
  // JSON.parse creates ordinary own data properties; descriptor-only input
  // validation is required in payloadJson before serialization, not here.
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { version?: unknown }).version !== 1 ||
    !("value" in payload)
  ) {
    throw new Error(`${LABEL}: stored payload version is invalid`);
  }
  // This both validates stored content and guarantees canonical encoding.
  if (boundedJson(payload, "stored payload") !== value) {
    throw new Error(`${LABEL}: stored payload is not canonical`);
  }
  return payload as DurableJobPayload;
}

function hasExactSchema(objects: readonly SqliteSchemaObject[]): boolean {
  return hasExactSchemaObjects(objects, EXPECTED_SCHEMA);
}

function hasExactV1Schema(objects: readonly SqliteSchemaObject[]): boolean {
  return hasExactSchemaObjects(objects, EXPECTED_V1_SCHEMA);
}

function hasExactSchemaObjects(
  objects: readonly SqliteSchemaObject[],
  expected: ReadonlyMap<string, string>,
): boolean {
  return (
    objects.length === expected.size &&
    objects.every((object) => expected.get(object.name) === canonicalSqliteSchemaSql(object.sql))
  );
}

function validateRows(
  db: Database,
  maxTotalRecords: number,
  maxQueuedRecords: number,
  maxPrivateBytes: number,
  maxSchedulePrivateBytes: number,
  maxAttemptsPerJob: number,
  maxAuditRecords: number,
): void {
  if (db.query("PRAGMA foreign_key_check").get()) {
    throw new Error(`${LABEL}: stored foreign-key graph is inconsistent`);
  }
  const capacity = db
    .query<{ total: number; outstanding: number; private_bytes: number }, []>(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN state IN ('queued','leased','running','outcome_unknown') THEN 1 ELSE 0 END), 0) AS outstanding,
         COALESCE(SUM(private_bytes), 0) AS private_bytes
       FROM durable_jobs`,
    )
    .get();
  if (!capacity || !Number.isSafeInteger(capacity.total) || capacity.total > maxTotalRecords) {
    throw new Error(`${LABEL}: stored jobs exceed configured total record capacity`);
  }
  if (!Number.isSafeInteger(capacity.outstanding) || capacity.outstanding > maxQueuedRecords) {
    throw new Error(`${LABEL}: stored jobs exceed configured outstanding capacity`);
  }
  if (
    !Number.isSafeInteger(capacity.private_bytes) ||
    capacity.private_bytes < 0 ||
    capacity.private_bytes > maxPrivateBytes
  ) {
    throw new Error(`${LABEL}: stored jobs exceed configured private byte capacity`);
  }
  const invalid = db
    .query<Row, []>(
      `SELECT * FROM durable_jobs
       WHERE typeof(attempt) <> 'integer' OR attempt < 0 OR attempt > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(version) <> 'integer' OR version < 1 OR version > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(private_bytes) <> 'integer' OR private_bytes < 1 OR private_bytes > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(available_at) <> 'integer' OR available_at < 0 OR available_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(created_at) <> 'integer' OR created_at < 0 OR created_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(updated_at) <> 'integer' OR updated_at < created_at OR updated_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR (lease_expires_at IS NOT NULL AND (typeof(lease_expires_at) <> 'integer' OR lease_expires_at < 0 OR lease_expires_at > ${MAX_SAFE_SQLITE_INTEGER}))
          OR (started_at IS NOT NULL AND (typeof(started_at) <> 'integer' OR started_at < created_at OR started_at > updated_at OR started_at > ${MAX_SAFE_SQLITE_INTEGER}))
          OR (completed_at IS NOT NULL AND (typeof(completed_at) <> 'integer' OR completed_at < created_at OR completed_at > updated_at OR completed_at > ${MAX_SAFE_SQLITE_INTEGER}))
          OR (incident_version IS NOT NULL AND (typeof(incident_version) <> 'integer' OR incident_version < 1 OR incident_version > ${MAX_SAFE_SQLITE_INTEGER}))
          OR typeof(cancel_requested) <> 'integer' OR cancel_requested NOT IN (0,1)
          OR (state IN ('leased','running') AND (lease_owner IS NULL OR lease_token IS NULL OR lease_expires_at IS NULL))
          OR (state NOT IN ('leased','running') AND (lease_owner IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
          OR (state = 'leased' AND (started_at IS NOT NULL OR cancel_requested <> 0))
          OR (state = 'running' AND started_at IS NULL)
          OR (state IN ('completed','failed','canceled') AND completed_at IS NULL)
          OR (state NOT IN ('completed','failed','canceled') AND completed_at IS NOT NULL)
          OR (state <> 'completed' AND result_json IS NOT NULL)
          OR (state = 'outcome_unknown' AND (incident_id IS NULL OR incident_version IS NULL OR incident_reason_code IS NULL))
          OR (state <> 'outcome_unknown' AND (incident_id IS NOT NULL OR incident_version IS NOT NULL OR incident_reason_code IS NOT NULL))
       LIMIT 1`,
    )
    .get();
  if (invalid) throw new Error(`${LABEL}: stored job state is inconsistent`);
  for (const row of db.query<Row, []>("SELECT * FROM durable_jobs").all()) {
    safeId(row.job_id, "stored job ID");
    if (
      !/^[a-f0-9]{64}$/.test(row.idempotency_key_hash) ||
      !/^[a-f0-9]{64}$/.test(row.binding_hash)
    ) {
      throw new Error(`${LABEL}: stored binding is invalid`);
    }
    parsePayload(row.payload_json);
    if (row.private_bytes < Buffer.byteLength(row.payload_json, "utf8") + 1) {
      throw new Error(`${LABEL}: stored private byte accounting is inconsistent`);
    }
    if (row.lease_owner !== null) safeText(row.lease_owner, "stored lease owner", 128);
    if (row.lease_token !== null) safeId(row.lease_token, "stored lease token");
    if (row.error_code !== null) allowedErrorCode(row.error_code);
    if (row.cancel_reason !== null) {
      allowedReason(row.cancel_reason, "stored cancel reason", CANCEL_REASON_CODES);
    }
    if (row.incident_reason_code !== null) {
      allowedReason(row.incident_reason_code, "stored incident reason", OUTCOME_REASON_CODES);
    }
    if (row.result_json !== null) {
      let result: unknown;
      try {
        result = JSON.parse(row.result_json);
      } catch (error) {
        throw new Error(`${LABEL}: stored result is invalid`, { cause: error });
      }
      if (boundedJson(result, "stored result") !== row.result_json) {
        throw new Error(`${LABEL}: stored result is not canonical`);
      }
    }
  }
  const invalidAttempt = db
    .query<{ job_id: string }, []>(
      `SELECT a.job_id FROM durable_job_attempts a JOIN durable_jobs j ON j.job_id = a.job_id
       WHERE typeof(a.attempt) <> 'integer' OR a.attempt < 1 OR a.attempt > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(a.claimed_at) <> 'integer' OR a.claimed_at < j.created_at OR a.claimed_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR (a.started_at IS NOT NULL AND (typeof(a.started_at) <> 'integer' OR a.started_at < a.claimed_at OR a.started_at > ${MAX_SAFE_SQLITE_INTEGER}))
          OR (a.settled_at IS NOT NULL AND (typeof(a.settled_at) <> 'integer' OR a.settled_at < a.claimed_at OR a.settled_at > ${MAX_SAFE_SQLITE_INTEGER}))
          OR (a.started_at IS NOT NULL AND a.settled_at IS NOT NULL AND a.settled_at < a.started_at)
          OR a.attempt > j.attempt
          OR (a.state = 'leased' AND (a.started_at IS NOT NULL OR a.settled_at IS NOT NULL))
          OR (a.state = 'running' AND (a.started_at IS NULL OR a.settled_at IS NOT NULL))
          OR (a.state NOT IN ('leased','running') AND a.settled_at IS NULL)
          OR (a.state = 'leased' AND (j.state <> 'leased' OR a.attempt <> j.attempt OR a.lease_token <> j.lease_token))
          OR (a.state = 'running' AND (j.state <> 'running' OR a.attempt <> j.attempt OR a.lease_token <> j.lease_token))
       LIMIT 1`,
    )
    .get();
  if (invalidAttempt) throw new Error(`${LABEL}: stored job attempt is inconsistent`);
  const invalidAttemptHistory = db
    .query<{ job_id: string }, []>(
      `SELECT j.job_id FROM durable_jobs j
       LEFT JOIN durable_job_attempts a ON a.job_id = j.job_id
       GROUP BY j.job_id
       HAVING COUNT(a.attempt) <> j.attempt OR COALESCE(MAX(a.attempt), 0) <> j.attempt
          OR (j.state = 'leased' AND SUM(CASE WHEN a.attempt = j.attempt AND a.state = 'leased' AND a.lease_token = j.lease_token THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'running' AND SUM(CASE WHEN a.attempt = j.attempt AND a.state = 'running' AND a.lease_token = j.lease_token THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'completed' AND SUM(CASE WHEN a.attempt = j.attempt AND a.state IN ('completed','outcome_unknown') THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'failed' AND SUM(CASE WHEN a.attempt = j.attempt AND a.state = 'failed' THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'outcome_unknown' AND SUM(CASE WHEN a.attempt = j.attempt AND a.state = 'outcome_unknown' THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'queued' AND j.attempt > 0 AND SUM(CASE WHEN a.attempt = j.attempt AND a.state IN ('requeued','outcome_unknown') THEN 1 ELSE 0 END) <> 1)
          OR (j.state = 'canceled' AND j.attempt > 0 AND SUM(CASE WHEN a.attempt = j.attempt AND a.state IN ('canceled','outcome_unknown','requeued') THEN 1 ELSE 0 END) <> 1)
       LIMIT 1`,
    )
    .get();
  if (invalidAttemptHistory) throw new Error(`${LABEL}: stored attempt history is inconsistent`);
  const overAttemptCapacity = db
    .query<{ job_id: string }, [number]>(
      `SELECT job_id FROM durable_job_attempts GROUP BY job_id HAVING COUNT(*) > ? LIMIT 1`,
    )
    .get(maxAttemptsPerJob);
  if (overAttemptCapacity) {
    throw new Error(`${LABEL}: stored attempt history exceeds configured capacity`);
  }
  const invalidIncident = db
    .query<{ incident_id: string }, []>(
      `SELECT i.incident_id FROM durable_job_incidents i JOIN durable_jobs j ON j.job_id = i.job_id
       WHERE typeof(i.version) <> 'integer' OR i.version < 1 OR i.version > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(i.detected_at) <> 'integer' OR i.detected_at < j.created_at OR i.detected_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR i.detected_at > j.updated_at OR j.state <> 'outcome_unknown' OR j.incident_id <> i.incident_id
          OR j.incident_version <> i.version OR j.incident_reason_code <> i.reason_code
          OR i.detected_at < j.created_at
       LIMIT 1`,
    )
    .get();
  if (invalidIncident) throw new Error(`${LABEL}: stored incident is inconsistent`);
  const missingIncident = db
    .query<{ job_id: string }, []>(
      `SELECT j.job_id FROM durable_jobs j LEFT JOIN durable_job_incidents i ON i.incident_id = j.incident_id
       WHERE j.state = 'outcome_unknown' AND i.incident_id IS NULL LIMIT 1`,
    )
    .get();
  if (missingIncident)
    throw new Error(`${LABEL}: stored outcome-unknown job is missing its incident`);
  const invalidReconciliation = db
    .query<{ incident_id: string }, []>(
      `SELECT incident_id FROM durable_job_reconciliations
       WHERE typeof(incident_version) <> 'integer' OR incident_version < 1 OR incident_version > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(reconciled_at) <> 'integer' OR reconciled_at < 0 OR reconciled_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR length(evidence_sha256) <> 64 OR evidence_sha256 GLOB '*[^0-9a-f]*'
       LIMIT 1`,
    )
    .get();
  if (invalidReconciliation) throw new Error(`${LABEL}: stored reconciliation is inconsistent`);
  const auditCount = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_reconciliations")
    .get()?.count;
  if (
    typeof auditCount !== "number" ||
    !Number.isSafeInteger(auditCount) ||
    auditCount < 0 ||
    auditCount > maxAuditRecords
  ) {
    throw new Error(`${LABEL}: stored reconciliation audit exceeds configured capacity`);
  }
  for (const attempt of db
    .query<{ job_id: string; lease_token: string; worker_id: string }, []>(
      "SELECT job_id, lease_token, worker_id FROM durable_job_attempts",
    )
    .all()) {
    safeId(attempt.job_id, "stored attempt job ID");
    safeId(attempt.lease_token, "stored attempt lease token");
    safeText(attempt.worker_id, "stored attempt worker ID", 128);
  }
  for (const incident of db
    .query<{ incident_id: string; job_id: string; reason_code: string }, []>(
      "SELECT incident_id, job_id, reason_code FROM durable_job_incidents",
    )
    .all()) {
    safeId(incident.incident_id, "stored incident ID");
    safeId(incident.job_id, "stored incident job ID");
    allowedReason(incident.reason_code, "stored incident reason", OUTCOME_REASON_CODES);
  }
  for (const reconciliation of db
    .query<{ incident_id: string; job_id: string }, []>(
      "SELECT incident_id, job_id FROM durable_job_reconciliations",
    )
    .all()) {
    safeId(reconciliation.incident_id, "stored reconciliation incident ID");
    safeId(reconciliation.job_id, "stored reconciliation job ID");
  }
  const scheduleCount = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_schedules")
    .get()?.count;
  if (
    typeof scheduleCount !== "number" ||
    !Number.isSafeInteger(scheduleCount) ||
    scheduleCount < 0 ||
    scheduleCount > MAX_SCHEDULES
  ) {
    throw new Error(`${LABEL}: stored schedules exceed configured capacity`);
  }
  const schedulePrivateBytes = db
    .query<{ bytes: number }, []>(
      "SELECT COALESCE(SUM(private_bytes), 0) AS bytes FROM durable_job_schedules",
    )
    .get()?.bytes;
  if (
    !Number.isSafeInteger(schedulePrivateBytes) ||
    (schedulePrivateBytes ?? 0) < 0 ||
    (schedulePrivateBytes ?? 0) > maxSchedulePrivateBytes
  ) {
    throw new Error(`${LABEL}: stored schedules exceed configured private byte capacity`);
  }
  for (const schedule of db.query<ScheduleRow, []>("SELECT * FROM durable_job_schedules").all()) {
    safeId(schedule.schedule_id, "stored schedule ID");
    try {
      parseUtcCron(schedule.cron);
    } catch {
      throw new Error(`${LABEL}: stored schedule cron is invalid`);
    }
    if (!/^[a-f0-9]{64}$/.test(schedule.definition_hash)) {
      throw new Error(`${LABEL}: stored schedule definition is invalid`);
    }
    if (
      !Number.isSafeInteger(schedule.revision) ||
      schedule.revision < 1 ||
      !Number.isSafeInteger(schedule.version) ||
      schedule.version < 1 ||
      !Number.isSafeInteger(schedule.private_bytes) ||
      schedule.private_bytes < 1 ||
      !Number.isSafeInteger(schedule.next_fire_at) ||
      schedule.next_fire_at < 0 ||
      !Number.isSafeInteger(schedule.created_at) ||
      schedule.created_at < 0 ||
      !Number.isSafeInteger(schedule.updated_at) ||
      schedule.updated_at < schedule.created_at ||
      !Number.isSafeInteger(schedule.config_enabled) ||
      !Number.isSafeInteger(schedule.operator_paused) ||
      schedule.config_enabled < 0 ||
      schedule.config_enabled > 1 ||
      schedule.operator_paused < 0 ||
      schedule.operator_paused > 1
    ) {
      throw new Error(`${LABEL}: stored schedule state is inconsistent`);
    }
    let binding: string;
    let payload: string;
    try {
      binding = boundedJson(JSON.parse(schedule.binding_json), "stored schedule binding");
      payload = payloadJson(JSON.parse(schedule.payload_json) as DurableJobPayload);
    } catch {
      throw new Error(`${LABEL}: stored schedule private data is invalid`);
    }
    if (binding !== schedule.binding_json || payload !== schedule.payload_json) {
      throw new Error(`${LABEL}: stored schedule payload is not canonical`);
    }
    if (
      schedule.private_bytes !==
      safeAdd(
        Buffer.byteLength(binding, "utf8"),
        Buffer.byteLength(payload, "utf8"),
        "schedule bytes",
      )
    ) {
      throw new Error(`${LABEL}: stored schedule byte accounting is inconsistent`);
    }
    if (sha256(`${schedule.cron}\n${binding}\n${payload}`) !== schedule.definition_hash) {
      throw new Error(`${LABEL}: stored schedule definition is inconsistent`);
    }
  }
  const invalidOccurrence = db
    .query<{ schedule_id: string }, []>(
      `SELECT o.schedule_id FROM durable_job_schedule_occurrences o
       JOIN durable_job_schedules s ON s.schedule_id = o.schedule_id
       JOIN durable_jobs j ON j.job_id = o.job_id
       WHERE typeof(o.revision) <> 'integer' OR o.revision < 1 OR o.revision > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(o.scheduled_for) <> 'integer' OR o.scheduled_for < 0 OR o.scheduled_for > ${MAX_SAFE_SQLITE_INTEGER}
          OR typeof(o.created_at) <> 'integer' OR o.created_at < 0 OR o.created_at > ${MAX_SAFE_SQLITE_INTEGER}
          OR o.revision > s.revision
          OR o.created_at < s.created_at OR o.created_at < j.created_at
       LIMIT 1`,
    )
    .get();
  if (invalidOccurrence) throw new Error(`${LABEL}: stored schedule occurrence is inconsistent`);
}

function summary(row: Row): DurableJobSummary {
  const incident =
    row.incident_id && row.incident_version && row.incident_reason_code
      ? { id: row.incident_id, version: row.incident_version, reasonCode: row.incident_reason_code }
      : undefined;
  return {
    id: row.job_id,
    state: row.state,
    attempt: row.attempt,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableAt: row.available_at,
    cancelRequested: row.cancel_requested === 1,
    ...(incident ? { incident } : {}),
  };
}

function scheduleSummary(row: ScheduleRow): DurableJobScheduleSummary {
  return {
    id: row.schedule_id,
    cron: row.cron,
    revision: row.revision,
    version: row.version,
    configEnabled: row.config_enabled === 1,
    operatorPaused: row.operator_paused === 1,
    enabled: row.config_enabled === 1 && row.operator_paused === 0,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function record(row: Row): DurableJobRecord {
  const parsedResult = row.result_json === null ? undefined : JSON.parse(row.result_json);
  return {
    ...summary(row),
    payload: parsePayload(row.payload_json),
    ...(parsedResult === undefined ? {} : { result: parsedResult }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum = MAX_SAFE_SQLITE_INTEGER,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${LABEL}: ${label} must be an integer from 1 to ${maximum}`);
  }
  return selected;
}

export function createSqliteDurableJobStore(
  options: SqliteDurableJobStoreOptions,
): DurableJobStore {
  const maxTotalRecords = positiveOption(
    options.maxTotalRecords,
    DEFAULT_MAX_TOTAL_RECORDS,
    "maxTotalRecords",
    MAX_TOTAL_RECORDS,
  );
  const maxQueuedRecords = positiveOption(
    options.maxQueuedRecords,
    DEFAULT_MAX_QUEUED_RECORDS,
    "maxQueuedRecords",
    MAX_QUEUED_RECORDS,
  );
  if (maxQueuedRecords > maxTotalRecords) {
    throw new Error(`${LABEL}: maxQueuedRecords cannot exceed maxTotalRecords`);
  }
  const maxPrivateBytes = positiveOption(
    options.maxPrivateBytes,
    DEFAULT_MAX_PRIVATE_BYTES,
    "maxPrivateBytes",
    MAX_PRIVATE_BYTES,
  );
  const maxSchedulePrivateBytes = positiveOption(
    options.maxSchedulePrivateBytes,
    DEFAULT_MAX_SCHEDULE_PRIVATE_BYTES,
    "maxSchedulePrivateBytes",
    MAX_PRIVATE_BYTES,
  );
  const maxAttemptsPerJob = positiveOption(
    options.maxAttemptsPerJob,
    DEFAULT_MAX_ATTEMPTS_PER_JOB,
    "maxAttemptsPerJob",
    MAX_ATTEMPTS_PER_JOB,
  );
  const maxAuditRecords = positiveOption(
    options.maxAuditRecords,
    DEFAULT_MAX_AUDIT_RECORDS,
    "maxAuditRecords",
    MAX_AUDIT_RECORDS,
  );
  const terminalRetentionMs = positiveOption(
    options.terminalRetentionMs,
    DEFAULT_TERMINAL_RETENTION_MS,
    "terminalRetentionMs",
    MAX_RETENTION_MS,
  );
  const auditRetentionMs = positiveOption(
    options.auditRetentionMs,
    DEFAULT_AUDIT_RETENTION_MS,
    "auditRetentionMs",
    MAX_RETENTION_MS,
  );
  if (auditRetentionMs < MIN_AUDIT_RETENTION_MS) {
    throw new Error(`${LABEL}: auditRetentionMs must be at least ${MIN_AUDIT_RETENTION_MS}`);
  }
  if (auditRetentionMs < terminalRetentionMs) {
    throw new Error(`${LABEL}: auditRetentionMs cannot be shorter than terminalRetentionMs`);
  }
  const database = openHardenedSqlite({
    path: options.dbPath,
    label: LABEL,
    foreignKeys: true,
    synchronous: "FULL",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: LABEL,
        applicationId: DURABLE_JOBS_APPLICATION_ID,
        schemaVersion: DURABLE_JOBS_SCHEMA_VERSION,
        initialize(database) {
          for (const sql of SCHEMA) database.run(sql);
        },
        migrateOwned(database, fromVersion, objects) {
          if (fromVersion !== 1 || !hasExactV1Schema(objects)) {
            throw new Error(`${LABEL}: database schema is incompatible`);
          }
          for (const sql of SCHEDULE_SCHEMA) database.run(sql);
        },
        validate(database, objects) {
          if (!hasExactSchema(objects))
            throw new Error(`${LABEL}: database schema is incompatible`);
          validateRows(
            database,
            maxTotalRecords,
            maxQueuedRecords,
            maxPrivateBytes,
            maxSchedulePrivateBytes,
            maxAttemptsPerJob,
            maxAuditRecords,
          );
        },
        isLegacy() {
          return false;
        },
      });
    },
  });
  const db = database.db;
  const now = () => safeTime(options.now?.() ?? Date.now(), "clock result");
  const mintJobId = () => safeId(options.jobId?.() ?? randomUUID().replaceAll("-", ""), "job ID");
  const mintToken = () =>
    safeId(options.leaseToken?.() ?? randomUUID().replaceAll("-", ""), "lease token");
  const mintIncident = () =>
    safeId(options.incidentId?.() ?? randomUUID().replaceAll("-", ""), "incident ID");
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error(`${LABEL}: store is closed`);
  };
  const select = db.query<Row, [string]>("SELECT * FROM durable_jobs WHERE job_id = ?");
  const selectByKey = db.query<Row, [string]>(
    "SELECT * FROM durable_jobs WHERE idempotency_key_hash = ?",
  );
  const selectSchedule = db.query<ScheduleRow, [string]>(
    "SELECT * FROM durable_job_schedules WHERE schedule_id = ?",
  );

  function activeRow(jobId: string, token: string, at: number, state?: "leased" | "running"): Row {
    const row = select.get(safeId(jobId, "job ID"));
    const safeToken = safeId(token, "lease token");
    if (
      !row ||
      (state !== undefined && row.state !== state) ||
      !["leased", "running"].includes(row.state) ||
      row.lease_token !== safeToken ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= at
    ) {
      throw new Error(`${LABEL}: lease is no longer active`);
    }
    return row;
  }

  function assertMutableVersion(row: Row): void {
    if (row.version >= MAX_SAFE_SQLITE_INTEGER) {
      throw new Error(`${LABEL}: job version exhausted the safe integer range`);
    }
  }

  function quarantine(
    dbRow: Row,
    at: number,
    reason: string,
    expired: boolean,
    incidentId = mintIncident(),
  ): Row {
    assertMutableVersion(dbRow);
    const reasonCode = allowedReason(reason, "reasonCode", OUTCOME_REASON_CODES);
    const expiryPredicate = expired ? "lease_expires_at <= ?" : "lease_expires_at > ?";
    const change = db
      .query(
        `UPDATE durable_jobs SET state = 'outcome_unknown', version = version + 1, updated_at = ?,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          incident_id = ?, incident_version = 1, incident_reason_code = ?, error_code = NULL
         WHERE job_id = ? AND state = ? AND lease_token = ? AND ${expiryPredicate}`,
      )
      .run(at, incidentId, reasonCode, dbRow.job_id, dbRow.state, dbRow.lease_token, at);
    if (change.changes !== 1) throw new Error(`${LABEL}: lease is no longer active`);
    db.query(
      `INSERT INTO durable_job_incidents (incident_id, job_id, version, reason_code, detected_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(incidentId, dbRow.job_id, reasonCode, at);
    db.query(
      `UPDATE durable_job_attempts SET state = 'outcome_unknown', settled_at = ?
       WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = ?`,
    ).run(at, dbRow.job_id, dbRow.attempt, dbRow.lease_token, dbRow.state);
    return select.get(dbRow.job_id)!;
  }

  function recoverExpired(at: number): { requeued: number; quarantined: number } {
    const expired = db
      .query<Row, [number]>(
        `SELECT * FROM durable_jobs
         WHERE state IN ('leased','running') AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC, job_id ASC LIMIT ${MAX_RECOVERY_PER_TRANSITION}`,
      )
      .all(at);
    let requeued = 0;
    let quarantined = 0;
    for (const row of expired) {
      assertMutableVersion(row);
      if (row.state === "running") {
        quarantine(row, at, "lease-expired", true);
        quarantined++;
        continue;
      }
      const nextState = row.cancel_requested === 1 ? "canceled" : "queued";
      const change = db
        .query(
          `UPDATE durable_jobs SET state = ?, version = version + 1, available_at = ?, completed_at = ?, updated_at = ?,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE job_id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at <= ?`,
        )
        .run(
          nextState,
          at,
          nextState === "canceled" ? at : null,
          at,
          row.job_id,
          row.lease_token,
          at,
        );
      if (change.changes !== 1) continue;
      db.query(
        `UPDATE durable_job_attempts SET state = ?, settled_at = ?
         WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'leased'`,
      ).run(
        nextState === "canceled" ? "canceled" : "requeued",
        at,
        row.job_id,
        row.attempt,
        row.lease_token,
      );
      if (nextState === "queued") requeued++;
    }
    return { requeued, quarantined };
  }

  function jobCapacity(): { total: number; outstanding: number; privateBytes: number } {
    const counts = db
      .query<{ total: number; outstanding: number; private_bytes: number }, []>(
        `SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN state IN ('queued','leased','running','outcome_unknown') THEN 1 ELSE 0 END), 0) AS outstanding,
             COALESCE(SUM(private_bytes), 0) AS private_bytes
           FROM durable_jobs`,
      )
      .get();
    if (
      !counts ||
      !Number.isSafeInteger(counts.total) ||
      counts.total < 0 ||
      !Number.isSafeInteger(counts.outstanding) ||
      counts.outstanding < 0 ||
      !Number.isSafeInteger(counts.private_bytes) ||
      counts.private_bytes < 0
    ) {
      throw new Error(`${LABEL}: stored job capacity accounting is inconsistent`);
    }
    return {
      total: counts.total,
      outstanding: counts.outstanding,
      privateBytes: counts.private_bytes,
    };
  }

  function hasJobCapacity(
    capacity: { total: number; outstanding: number; privateBytes: number },
    privateBytes: number,
  ): boolean {
    return (
      capacity.total < maxTotalRecords &&
      capacity.outstanding < maxQueuedRecords &&
      privateBytes <= maxPrivateBytes - capacity.privateBytes
    );
  }

  function submitInTransaction(
    input: {
      idempotencyKey: string;
      binding: unknown;
      payload: DurableJobPayload;
      availableAt?: number;
    },
    transactionTime = now(),
  ) {
    const key = safeText(input.idempotencyKey, "idempotency key", 256);
    const storedPayload = payloadJson(input.payload);
    const storedBinding = boundedJson(input.binding, "binding");
    const bindingHash = sha256(`${storedBinding}\n${storedPayload}`);
    const keyHash = sha256(key);
    const existing = selectByKey.get(keyHash);
    if (existing) {
      if (existing.binding_hash !== bindingHash)
        throw new Error(`${LABEL}: idempotency binding conflicts`);
      return { status: "joined" as const, job: summary(existing) };
    }
    const privateBytes = safeAdd(
      Buffer.byteLength(storedBinding, "utf8"),
      Buffer.byteLength(storedPayload, "utf8"),
      "private byte accounting",
    );
    const capacity = jobCapacity();
    if (capacity.total >= maxTotalRecords) {
      throw new Error(`${LABEL}: total record capacity exhausted; prune terminal jobs`);
    }
    if (capacity.outstanding >= maxQueuedRecords) {
      throw new Error(
        `${LABEL}: outstanding job capacity exhausted; process, cancel, or reconcile active jobs`,
      );
    }
    if (privateBytes > maxPrivateBytes - capacity.privateBytes) {
      throw new Error(`${LABEL}: private byte capacity exhausted; prune terminal jobs`);
    }
    const availableAt =
      input.availableAt === undefined
        ? transactionTime
        : safeTime(input.availableAt, "availableAt");
    const jobId = mintJobId();
    db.query(
      `INSERT INTO durable_jobs (
        job_id,idempotency_key_hash,binding_hash,payload_json,private_bytes,state,attempt,version,available_at,created_at,updated_at
      ) VALUES (?,?,?,?,?, 'queued',0,1,?,?,?)`,
    ).run(
      jobId,
      keyHash,
      bindingHash,
      storedPayload,
      privateBytes,
      availableAt,
      transactionTime,
      transactionTime,
    );
    return { status: "created" as const, job: summary(select.get(jobId)!) };
  }

  const submitTx = db.transaction(
    (input: {
      idempotencyKey: string;
      binding: unknown;
      payload: DurableJobPayload;
      availableAt?: number;
    }) => submitInTransaction(input),
  );

  const claimTx = db.transaction(
    (input: { workerId: string; leaseMs: number }): DurableJobLease | null => {
      const workerId = safeText(input.workerId, "worker ID", 128);
      const leaseMs = safeTime(input.leaseMs, "leaseMs");
      if (leaseMs < 1 || leaseMs > MAX_LEASE_MS)
        throw new Error(`${LABEL}: leaseMs must be from 1 to ${MAX_LEASE_MS}`);
      const at = now();
      recoverExpired(at);
      let exhaustedTransitions = 0;
      while (true) {
        const candidate = db
          .query<Row, [number]>(
            `SELECT * FROM durable_jobs WHERE state = 'queued' AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC, job_id ASC LIMIT 1`,
          )
          .get(at);
        if (!candidate) return null;
        if (candidate.attempt >= maxAttemptsPerJob) {
          assertMutableVersion(candidate);
          const exhausted = db
            .query(
              `UPDATE durable_jobs SET state = 'failed', version = version + 1, completed_at = ?, updated_at = ?,
                error_code = 'attempt-limit-exceeded'
               WHERE job_id = ? AND state = 'queued' AND version = ?`,
            )
            .run(at, at, candidate.job_id, candidate.version);
          if (exhausted.changes !== 1) continue;
          if (candidate.attempt > 0) {
            db.query(
              `UPDATE durable_job_attempts SET state = 'failed', settled_at = ?
               WHERE job_id = ? AND attempt = ? AND state IN ('requeued','outcome_unknown')`,
            ).run(at, candidate.job_id, candidate.attempt);
          }
          exhaustedTransitions++;
          if (exhaustedTransitions >= MAX_ATTEMPT_EXHAUSTION_PER_CLAIM) return null;
          continue;
        }
        if (candidate.attempt >= MAX_SAFE_SQLITE_INTEGER) {
          throw new Error(`${LABEL}: job counters exhausted the safe integer range`);
        }
        if (candidate.version >= MAX_SAFE_SQLITE_INTEGER) {
          throw new Error(`${LABEL}: job version exhausted the safe integer range`);
        }
        const token = mintToken();
        const expiresAt = safeAdd(at, leaseMs, "lease expiry");
        const update = db
          .query(
            `UPDATE durable_jobs SET state = 'leased', attempt = attempt + 1, version = version + 1,
            lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE job_id = ? AND state = 'queued' AND available_at <= ?
             AND attempt < ${MAX_SAFE_SQLITE_INTEGER} AND version < ${MAX_SAFE_SQLITE_INTEGER}`,
          )
          .run(workerId, token, expiresAt, at, candidate.job_id, at);
        if (update.changes !== 1) continue;
        const leased = select.get(candidate.job_id)!;
        db.query(
          `INSERT INTO durable_job_attempts (job_id,attempt,lease_token,worker_id,claimed_at,state)
         VALUES (?,?,?,?,?,'leased')`,
        ).run(leased.job_id, leased.attempt, token, workerId, at);
        return {
          job: summary(leased),
          payload: parsePayload(leased.payload_json),
          token,
          expiresAt,
        };
      }
    },
  );

  function scheduleDefinition(input: DurableJobScheduleDefinition, at: number) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    ) {
      throw new Error(`${LABEL}: schedule definition is invalid`);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new Error(`${LABEL}: schedule definition is invalid`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = Object.keys(descriptors).sort();
    const allowed = new Set(["id", "cron", "binding", "payload", "enabled"]);
    if (
      names.some((name) => !allowed.has(name)) ||
      !["id", "cron", "binding", "payload"].every((name) => names.includes(name))
    ) {
      throw new Error(`${LABEL}: schedule definition is invalid`);
    }
    for (const name of names) {
      const descriptor = descriptors[name]!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${LABEL}: schedule definition is invalid`);
      }
    }
    const idValue = descriptors.id!.value;
    if (typeof idValue !== "string") {
      throw new Error(`${LABEL}: schedule definition is invalid`);
    }
    const id = safeId(idValue, "schedule ID");
    let cron: string;
    try {
      if (typeof descriptors.cron!.value !== "string") throw new Error();
      parseUtcCron(descriptors.cron!.value);
      cron = descriptors.cron!.value;
    } catch {
      throw new Error(`${LABEL}: schedule cron is invalid`);
    }
    const enabled = descriptors.enabled?.value;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`${LABEL}: schedule enabled is invalid`);
    }
    const binding = boundedJson(descriptors.binding!.value, "schedule binding");
    const payload = payloadJson(descriptors.payload!.value as DurableJobPayload);
    const privateBytes = safeAdd(
      Buffer.byteLength(binding, "utf8"),
      Buffer.byteLength(payload, "utf8"),
      "schedule private byte accounting",
    );
    const next = nextUtcCron(cron, new Date(at));
    if (!next || !Number.isSafeInteger(next.getTime()) || next.getTime() <= at) {
      throw new Error(`${LABEL}: schedule cron has no bounded next occurrence`);
    }
    return {
      id,
      cron,
      binding,
      payload,
      privateBytes,
      enabled: enabled ?? true,
      nextFireAt: next.getTime(),
      definitionHash: sha256(`${cron}\n${binding}\n${payload}`),
    };
  }

  function materializedSchedulePrivateBytes(
    definition: ReturnType<typeof scheduleDefinition>,
    revision: number,
  ): number {
    let target: unknown;
    try {
      target = JSON.parse(definition.binding);
    } catch {
      throw new Error(`${LABEL}: schedule definition is invalid`);
    }
    const jobBinding = boundedJson(
      {
        durableSchedule: {
          id: definition.id,
          revision,
          // Preflight the greatest safe timestamp so configuration cannot
          // accept a definition that a later schedule tick can never submit.
          scheduledFor: MAX_SAFE_SQLITE_INTEGER,
        },
        target,
      },
      "schedule job binding",
    );
    return safeAdd(
      Buffer.byteLength(jobBinding, "utf8"),
      Buffer.byteLength(definition.payload, "utf8"),
      "schedule materialized private byte accounting",
    );
  }

  const syncSchedulesTx = db.transaction(
    (definitions: readonly DurableJobScheduleDefinition[], explicitNow?: number) => {
      if (!Array.isArray(definitions) || definitions.length > MAX_SCHEDULES) {
        throw new Error(`${LABEL}: schedules must contain at most ${MAX_SCHEDULES} definitions`);
      }
      const at = explicitNow === undefined ? now() : safeTime(explicitNow, "schedule now");
      const parsed = definitions.map((definition) => scheduleDefinition(definition, at));
      const ids = new Set<string>();
      for (const definition of parsed) {
        if (ids.has(definition.id)) throw new Error(`${LABEL}: schedule IDs must be unique`);
        ids.add(definition.id);
      }
      // A declaration removed from configuration first becomes disabled. If it
      // never produced an occurrence it has no history to preserve and can be
      // reclaimed, keeping schedule metadata bounded across config rotations.
      for (const row of db.query<ScheduleRow, []>("SELECT * FROM durable_job_schedules").all()) {
        if (ids.has(row.schedule_id) || row.config_enabled === 0) continue;
        if (row.version >= MAX_SAFE_SQLITE_INTEGER) {
          throw new Error(`${LABEL}: schedule version exhausted the safe integer range`);
        }
        db.query(
          `UPDATE durable_job_schedules SET config_enabled = 0, version = version + 1, updated_at = ?
           WHERE schedule_id = ? AND version = ?`,
        ).run(at, row.schedule_id, row.version);
      }
      db.query(
        `DELETE FROM durable_job_schedules
         WHERE config_enabled = 0
           AND NOT EXISTS (
             SELECT 1 FROM durable_job_schedule_occurrences o WHERE o.schedule_id = durable_job_schedules.schedule_id
           )`,
      ).run();
      const existingSchedulePrivateBytes = db
        .query<{ bytes: number }, []>(
          "SELECT COALESCE(SUM(private_bytes), 0) AS bytes FROM durable_job_schedules",
        )
        .get()?.bytes;
      if (
        !Number.isSafeInteger(existingSchedulePrivateBytes) ||
        (existingSchedulePrivateBytes ?? 0) < 0 ||
        (existingSchedulePrivateBytes ?? 0) > maxSchedulePrivateBytes
      ) {
        throw new Error(`${LABEL}: stored schedules exceed configured private byte capacity`);
      }
      let schedulePrivateBytes = existingSchedulePrivateBytes as number;
      const existingCount = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_schedules")
        .get()?.count;
      if (!Number.isSafeInteger(existingCount) || (existingCount ?? 0) > MAX_SCHEDULES) {
        throw new Error(`${LABEL}: stored schedules exceed configured capacity`);
      }
      let admittedScheduleCount = existingCount ?? 0;
      for (const definition of parsed) {
        const row = selectSchedule.get(definition.id);
        if (!row) {
          if (admittedScheduleCount >= MAX_SCHEDULES) {
            throw new Error(`${LABEL}: schedule capacity exhausted`);
          }
          if (materializedSchedulePrivateBytes(definition, 1) > maxPrivateBytes) {
            throw new Error(`${LABEL}: schedule definition exceeds job private byte capacity`);
          }
          if (definition.privateBytes > maxSchedulePrivateBytes - schedulePrivateBytes) {
            throw new Error(`${LABEL}: schedule private byte capacity exhausted`);
          }
          db.query(
            `INSERT INTO durable_job_schedules (
              schedule_id,cron,definition_hash,binding_json,payload_json,private_bytes,revision,version,
              config_enabled,operator_paused,next_fire_at,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,1,1,?,?,?, ?,?)`,
          ).run(
            definition.id,
            definition.cron,
            definition.definitionHash,
            definition.binding,
            definition.payload,
            definition.privateBytes,
            definition.enabled ? 1 : 0,
            0,
            definition.nextFireAt,
            at,
            at,
          );
          admittedScheduleCount++;
          schedulePrivateBytes += definition.privateBytes;
          continue;
        }
        if (row.version >= MAX_SAFE_SQLITE_INTEGER || row.revision >= MAX_SAFE_SQLITE_INTEGER) {
          throw new Error(`${LABEL}: schedule counters exhausted the safe integer range`);
        }
        const changed = row.definition_hash !== definition.definitionHash;
        const configChanged = row.config_enabled !== (definition.enabled ? 1 : 0);
        const nextRevision = changed ? row.revision + 1 : row.revision;
        if (materializedSchedulePrivateBytes(definition, nextRevision) > maxPrivateBytes) {
          throw new Error(`${LABEL}: schedule definition exceeds job private byte capacity`);
        }
        if (!changed && !configChanged) continue;
        const nextPrivateBytes = schedulePrivateBytes - row.private_bytes + definition.privateBytes;
        if (!Number.isSafeInteger(nextPrivateBytes) || nextPrivateBytes < 0) {
          throw new Error(`${LABEL}: stored schedule private byte accounting is inconsistent`);
        }
        if (nextPrivateBytes > maxSchedulePrivateBytes) {
          throw new Error(`${LABEL}: schedule private byte capacity exhausted`);
        }
        db.query(
          `UPDATE durable_job_schedules SET cron = ?, definition_hash = ?, binding_json = ?, payload_json = ?,
             private_bytes = ?, revision = CASE WHEN ? THEN revision + 1 ELSE revision END,
             config_enabled = ?, next_fire_at = CASE WHEN ? THEN ? ELSE next_fire_at END,
             version = version + 1, updated_at = ?
           WHERE schedule_id = ? AND version = ?`,
        ).run(
          definition.cron,
          definition.definitionHash,
          definition.binding,
          definition.payload,
          definition.privateBytes,
          changed ? 1 : 0,
          definition.enabled ? 1 : 0,
          changed ? 1 : 0,
          definition.nextFireAt,
          at,
          definition.id,
          row.version,
        );
        schedulePrivateBytes = nextPrivateBytes;
      }
      return db
        .query<ScheduleRow, []>("SELECT * FROM durable_job_schedules ORDER BY schedule_id ASC")
        .all()
        .map(scheduleSummary);
    },
  );

  const materializeSchedulesTx = db.transaction(
    (
      explicitNow: number | undefined,
      requestedLimit: number | undefined,
    ): DurableScheduleMaterializationResult => {
      const at = explicitNow === undefined ? now() : safeTime(explicitNow, "schedule now");
      const limit = requestedLimit ?? MAX_SCHEDULE_TICK;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCHEDULE_TICK) {
        throw new Error(`${LABEL}: schedule tick limit must be between 1 and ${MAX_SCHEDULE_TICK}`);
      }
      const due = db
        .query<ScheduleRow, [number, number]>(
          `SELECT * FROM durable_job_schedules
           WHERE config_enabled = 1 AND operator_paused = 0 AND next_fire_at <= ?
           ORDER BY next_fire_at ASC, schedule_id ASC LIMIT ?`,
        )
        .all(at, limit);
      const capacity = jobCapacity();
      let materialized = 0;
      for (const row of due) {
        const occurrenceAt = safeTime(row.next_fire_at, "stored next fire time");
        const next = nextUtcCron(parseUtcCron(row.cron), new Date(at));
        if (!next || !Number.isSafeInteger(next.getTime()) || next.getTime() <= at) {
          throw new Error(`${LABEL}: stored schedule cron has no bounded next occurrence`);
        }
        const occurrenceKey = `schedule-${row.schedule_id}-${row.revision}-${occurrenceAt}`;
        let target: unknown;
        let payload: DurableJobPayload;
        try {
          target = JSON.parse(row.binding_json);
          payload = parsePayload(row.payload_json);
        } catch {
          throw new Error(`${LABEL}: stored schedule private data is invalid`);
        }
        const binding = {
          durableSchedule: {
            id: row.schedule_id,
            revision: row.revision,
            scheduledFor: occurrenceAt,
          },
          target,
        };
        const jobPrivateBytes = safeAdd(
          Buffer.byteLength(boundedJson(binding, "schedule job binding"), "utf8"),
          Buffer.byteLength(payloadJson(payload), "utf8"),
          "schedule materialized private byte accounting",
        );
        // This is a deterministic, transaction-local preflight. Capacity is
        // the only expected reason to stop a tick early; any other store error
        // aborts the whole transaction rather than leaving partial state.
        if (!hasJobCapacity(capacity, jobPrivateBytes)) break;
        const submitted = submitInTransaction(
          {
            idempotencyKey: occurrenceKey,
            binding,
            payload,
            availableAt: occurrenceAt,
          },
          at,
        );
        if (submitted.status !== "created") {
          throw new Error(`${LABEL}: schedule occurrence binding is inconsistent`);
        }
        db.query(
          `INSERT INTO durable_job_schedule_occurrences (schedule_id,revision,scheduled_for,job_id,created_at)
           VALUES (?,?,?,?,?)`,
        ).run(row.schedule_id, row.revision, occurrenceAt, submitted.job.id, at);
        if (row.version >= MAX_SAFE_SQLITE_INTEGER) {
          throw new Error(`${LABEL}: schedule version exhausted the safe integer range`);
        }
        const update = db
          .query(
            `UPDATE durable_job_schedules SET next_fire_at = ?, version = version + 1, updated_at = ?
             WHERE schedule_id = ? AND revision = ? AND version = ?
               AND config_enabled = 1 AND operator_paused = 0 AND next_fire_at = ?`,
          )
          .run(next.getTime(), at, row.schedule_id, row.revision, row.version, occurrenceAt);
        if (update.changes !== 1)
          throw new Error(`${LABEL}: schedule changed during materialization`);
        capacity.total++;
        capacity.outstanding++;
        capacity.privateBytes += jobPrivateBytes;
        materialized++;
      }
      const remaining = db
        .query<{ count: number }, [number]>(
          `SELECT COUNT(*) AS count FROM durable_job_schedules
           WHERE config_enabled = 1 AND operator_paused = 0 AND next_fire_at <= ?`,
        )
        .get(at)?.count;
      if (!Number.isSafeInteger(remaining) || (remaining ?? 0) < 0) {
        throw new Error(`${LABEL}: schedule due count is invalid`);
      }
      return { materialized, remaining: remaining ?? 0 };
    },
  );

  return {
    submit(input) {
      assertOpen();
      return submitTx.immediate(input);
    },
    claim(input) {
      assertOpen();
      return claimTx.immediate(input);
    },
    markExecutionStarted(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at, "leased");
          assertMutableVersion(row);
          if (
            db
              .query(
                "UPDATE durable_jobs SET state = 'running', version = version + 1, started_at = ?, updated_at = ? WHERE job_id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at > ? AND cancel_requested = 0",
              )
              .run(at, at, row.job_id, input.token, at).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'running', started_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'leased'",
          ).run(at, row.job_id, row.attempt, input.token);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    heartbeat(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at);
          assertMutableVersion(row);
          const leaseMs = safeTime(input.leaseMs, "leaseMs");
          if (leaseMs < 1 || leaseMs > MAX_LEASE_MS)
            throw new Error(`${LABEL}: leaseMs must be from 1 to ${MAX_LEASE_MS}`);
          const expiresAt = safeAdd(at, leaseMs, "lease expiry");
          if (
            db
              .query(
                "UPDATE durable_jobs SET lease_expires_at = ?, version = version + 1, updated_at = ? WHERE job_id = ? AND state IN ('leased','running') AND lease_token = ? AND lease_expires_at > ?",
              )
              .run(expiresAt, at, row.job_id, input.token, at).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    releaseUnstarted(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at, "leased");
          assertMutableVersion(row);
          const errorCode = allowedErrorCode(input.errorCode);
          const availableAt =
            input.availableAt === undefined ? at : safeTime(input.availableAt, "availableAt");
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = 'queued', version = version + 1, available_at = ?, updated_at = ?, error_code = ?,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
                 WHERE job_id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at > ?`,
              )
              .run(availableAt, at, errorCode, row.job_id, input.token, at).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'requeued', settled_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'leased'",
          ).run(at, row.job_id, row.attempt, input.token);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    rejectUnstarted(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at, "leased");
          assertMutableVersion(row);
          const errorCode = allowedErrorCode(input.errorCode);
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = 'failed', version = version + 1, completed_at = ?, updated_at = ?, error_code = ?,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
                 WHERE job_id = ? AND state = 'leased' AND lease_token = ? AND lease_expires_at > ?`,
              )
              .run(at, at, errorCode, row.job_id, input.token, at).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'failed', settled_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'leased'",
          ).run(at, row.job_id, row.attempt, input.token);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    complete(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at, "running");
          assertMutableVersion(row);
          if (row.cancel_requested)
            return summary(quarantine(row, at, "cancel-completion-race", false));
          const result = boundedJson(input.result, "result");
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = 'completed', version = version + 1, completed_at = ?, updated_at = ?, result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?`,
              )
              .run(at, at, result, row.job_id, input.token, at).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'completed', settled_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'running'",
          ).run(at, row.job_id, row.attempt, input.token);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    failDefinite(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at, "running");
          assertMutableVersion(row);
          if (row.cancel_requested)
            return summary(quarantine(row, at, "cancel-failure-race", false));
          const errorCode = allowedErrorCode(input.errorCode);
          const retryAt =
            input.retryAt === undefined ? undefined : safeTime(input.retryAt, "retryAt");
          const nextState = retryAt === undefined ? "failed" : "queued";
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = ?, version = version + 1, available_at = ?, started_at = NULL, completed_at = ?, updated_at = ?, error_code = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state = 'running' AND lease_token = ? AND lease_expires_at > ?`,
              )
              .run(
                nextState,
                retryAt ?? row.available_at,
                retryAt === undefined ? at : null,
                at,
                errorCode,
                row.job_id,
                input.token,
                at,
              ).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = ?, settled_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'running'",
          ).run(
            retryAt === undefined ? "failed" : "requeued",
            at,
            row.job_id,
            row.attempt,
            input.token,
          );
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    markOutcomeUnknown(input) {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const row = activeRow(input.jobId, input.token, at);
          return summary(quarantine(row, at, input.reasonCode, false));
        })
        .immediate();
    },
    cancel(input) {
      assertOpen();
      return db
        .transaction(() => {
          const jobId = safeId(input.jobId, "job ID");
          const row = select.get(jobId);
          if (!row) return { status: "not_found" as const };
          if (
            !Number.isSafeInteger(input.expectedVersion) ||
            input.expectedVersion < 1 ||
            row.version !== input.expectedVersion
          )
            return { status: "version_conflict" as const };
          const reason =
            input.reasonCode === undefined
              ? "operator-requested"
              : allowedReason(input.reasonCode, "reasonCode", CANCEL_REASON_CODES);
          if (row.state === "queued" || row.state === "leased") {
            const at = now();
            assertMutableVersion(row);
            if (
              db
                .query(
                  `UPDATE durable_jobs SET state = 'canceled', version = version + 1, completed_at = ?, updated_at = ?, cancel_requested = 1, cancel_reason = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state = ? AND version = ?`,
                )
                .run(at, at, reason, jobId, row.state, input.expectedVersion).changes !== 1
            ) {
              return { status: "version_conflict" as const };
            }
            if (row.state === "leased")
              db.query(
                "UPDATE durable_job_attempts SET state = 'canceled', settled_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'leased'",
              ).run(at, jobId, row.attempt, row.lease_token);
            return { status: "canceled" as const, job: summary(select.get(jobId)!) };
          }
          if (row.state === "running") {
            const at = now();
            assertMutableVersion(row);
            if (
              db
                .query(
                  "UPDATE durable_jobs SET cancel_requested = 1, cancel_reason = ?, version = version + 1, updated_at = ? WHERE job_id = ? AND state = 'running' AND version = ?",
                )
                .run(reason, at, jobId, input.expectedVersion).changes !== 1
            ) {
              return { status: "version_conflict" as const };
            }
            return { status: "cancellation_requested" as const, job: summary(select.get(jobId)!) };
          }
          return { status: "unchanged" as const, job: summary(row) };
        })
        .immediate();
    },
    recoverExpiredLeases() {
      assertOpen();
      return db.transaction(() => recoverExpired(now())).immediate();
    },
    recoverInterrupted() {
      assertOpen();
      return db.transaction(() => recoverExpired(now())).immediate();
    },
    reconcile(input) {
      assertOpen();
      return db
        .transaction(() => {
          const jobId = safeId(input.jobId, "job ID");
          if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
            throw new Error(`${LABEL}: expectedVersion is invalid`);
          safeText(input.evidence, "evidence", 400);
          if (!(["retry", "cancel", "confirm_completed"] as const).includes(input.disposition))
            throw new Error(`${LABEL}: reconciliation disposition is invalid`);
          const row = select.get(jobId);
          if (
            row?.state !== "outcome_unknown" ||
            row.version !== input.expectedVersion ||
            !row.incident_id ||
            !row.incident_version
          )
            return { reconciled: false };
          const auditCount = db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM durable_job_reconciliations",
            )
            .get()?.count;
          if (
            typeof auditCount !== "number" ||
            !Number.isSafeInteger(auditCount) ||
            auditCount < 0 ||
            auditCount >= maxAuditRecords
          ) {
            throw new Error(`${LABEL}: reconciliation audit capacity exhausted`);
          }
          const at = now();
          assertMutableVersion(row);
          const state =
            input.disposition === "retry"
              ? "queued"
              : input.disposition === "cancel"
                ? "canceled"
                : "completed";
          const change = db
            .query(
              `UPDATE durable_jobs SET state = ?, version = version + 1, available_at = ?, started_at = NULL, completed_at = ?, updated_at = ?, incident_id = NULL, incident_version = NULL, incident_reason_code = NULL, error_code = NULL, cancel_requested = CASE WHEN ? = 'cancel' THEN 1 ELSE 0 END, cancel_reason = CASE WHEN ? = 'cancel' THEN 'operator-requested' ELSE NULL END WHERE job_id = ? AND state = 'outcome_unknown' AND version = ?`,
            )
            .run(
              state,
              input.disposition === "retry" ? at : row.available_at,
              input.disposition === "retry" ? null : at,
              at,
              input.disposition,
              input.disposition,
              jobId,
              input.expectedVersion,
            );
          if (change.changes !== 1) return { reconciled: false };
          db.query(
            `INSERT INTO durable_job_reconciliations (incident_id,job_id,incident_version,disposition,evidence_sha256,reconciled_at) VALUES (?,?,?,?,?,?)`,
          ).run(
            row.incident_id,
            jobId,
            row.incident_version,
            input.disposition,
            sha256(input.evidence),
            at,
          );
          db.query("DELETE FROM durable_job_incidents WHERE incident_id = ?").run(row.incident_id);
          return { reconciled: true, job: summary(select.get(jobId)!) };
        })
        .immediate();
    },
    retryFailed(input) {
      assertOpen();
      return db
        .transaction(() => {
          const jobId = safeId(input.jobId, "job ID");
          if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
            throw new Error(`${LABEL}: expectedVersion is invalid`);
          }
          const row = select.get(jobId);
          if (row?.state !== "failed" || row.version !== input.expectedVersion) {
            return { retried: false };
          }
          if (row.attempt >= maxAttemptsPerJob || row.version >= MAX_SAFE_SQLITE_INTEGER) {
            return { retried: false };
          }
          const outstanding = db
            .query<{ count: number }, []>(
              `SELECT COUNT(*) AS count FROM durable_jobs
               WHERE state IN ('queued','leased','running','outcome_unknown')`,
            )
            .get()?.count;
          if (
            !Number.isSafeInteger(outstanding) ||
            (outstanding ?? 0) < 0 ||
            (outstanding ?? 0) >= maxQueuedRecords
          ) {
            return { retried: false };
          }
          const at = now();
          const availableAt =
            input.availableAt === undefined ? at : safeTime(input.availableAt, "availableAt");
          const change = db
            .query(
              `UPDATE durable_jobs SET state = 'queued', version = version + 1, available_at = ?,
                started_at = NULL, completed_at = NULL, result_json = NULL, error_code = NULL,
                cancel_requested = 0, cancel_reason = NULL, updated_at = ?
               WHERE job_id = ? AND state = 'failed' AND version = ?`,
            )
            .run(availableAt, at, jobId, input.expectedVersion);
          if (change.changes !== 1) return { retried: false };
          const attempt = db
            .query(
              `UPDATE durable_job_attempts SET state = 'requeued'
               WHERE job_id = ? AND attempt = ? AND state = 'failed'`,
            )
            .run(jobId, row.attempt);
          if (attempt.changes !== 1) {
            throw new Error(`${LABEL}: stored job attempt is inconsistent`);
          }
          return { retried: true, job: summary(select.get(jobId)!) };
        })
        .immediate();
    },
    syncSchedules(definitions, input = {}) {
      assertOpen();
      return syncSchedulesTx.immediate(definitions, input.now);
    },
    materializeDueSchedules(input = {}) {
      assertOpen();
      return materializeSchedulesTx.immediate(input.now, input.limit);
    },
    listSchedules(input = {}) {
      assertOpen();
      const limit = input.limit ?? MAX_SCHEDULES;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCHEDULES) {
        throw new Error(`${LABEL}: schedule list limit must be between 1 and ${MAX_SCHEDULES}`);
      }
      return db
        .query<ScheduleRow, [number]>(
          "SELECT * FROM durable_job_schedules ORDER BY schedule_id ASC LIMIT ?",
        )
        .all(limit)
        .map(scheduleSummary);
    },
    pauseSchedule(input) {
      assertOpen();
      return db
        .transaction(() => {
          const id = safeId(input.scheduleId, "schedule ID");
          if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
            throw new Error(`${LABEL}: expectedVersion is invalid`);
          }
          const row = selectSchedule.get(id);
          if (!row || row.version !== input.expectedVersion || row.operator_paused === 1) {
            return { paused: false };
          }
          if (row.version >= MAX_SAFE_SQLITE_INTEGER) {
            throw new Error(`${LABEL}: schedule version exhausted the safe integer range`);
          }
          const at = now();
          const update = db
            .query(
              `UPDATE durable_job_schedules SET operator_paused = 1, version = version + 1, updated_at = ?
               WHERE schedule_id = ? AND version = ? AND operator_paused = 0`,
            )
            .run(at, id, input.expectedVersion);
          if (update.changes !== 1) return { paused: false };
          return { paused: true, schedule: scheduleSummary(selectSchedule.get(id)!) };
        })
        .immediate();
    },
    resumeSchedule(input) {
      assertOpen();
      return db
        .transaction(() => {
          const id = safeId(input.scheduleId, "schedule ID");
          if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
            throw new Error(`${LABEL}: expectedVersion is invalid`);
          }
          const row = selectSchedule.get(id);
          if (!row || row.version !== input.expectedVersion || row.operator_paused === 0) {
            return { resumed: false };
          }
          if (row.version >= MAX_SAFE_SQLITE_INTEGER) {
            throw new Error(`${LABEL}: schedule version exhausted the safe integer range`);
          }
          const at = now();
          const update = db
            .query(
              `UPDATE durable_job_schedules SET operator_paused = 0, version = version + 1, updated_at = ?
               WHERE schedule_id = ? AND version = ? AND operator_paused = 1`,
            )
            .run(at, id, input.expectedVersion);
          if (update.changes !== 1) return { resumed: false };
          return { resumed: true, schedule: scheduleSummary(selectSchedule.get(id)!) };
        })
        .immediate();
    },
    get(jobId) {
      assertOpen();
      const row = select.get(safeId(jobId, "job ID"));
      return row ? record(row) : null;
    },
    getSummary(jobId) {
      assertOpen();
      const row = select.get(safeId(jobId, "job ID"));
      return row ? summary(row) : null;
    },
    list(input = {}) {
      assertOpen();
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST)
        throw new Error(`${LABEL}: list limit must be between 1 and ${MAX_LIST}`);
      if (
        input.state !== undefined &&
        !(
          [
            "queued",
            "leased",
            "running",
            "completed",
            "failed",
            "canceled",
            "outcome_unknown",
          ] as const
        ).includes(input.state)
      )
        throw new Error(`${LABEL}: job state is invalid`);
      const rows =
        input.state === undefined
          ? db
              .query<Row, [number]>(
                "SELECT * FROM durable_jobs ORDER BY created_at DESC, job_id DESC LIMIT ?",
              )
              .all(limit)
          : db
              .query<Row, [DurableJobState, number]>(
                "SELECT * FROM durable_jobs WHERE state = ? ORDER BY created_at DESC, job_id DESC LIMIT ?",
              )
              .all(input.state, limit);
      return rows.map(summary);
    },
    prune(input = {}) {
      assertOpen();
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE)
        throw new Error(`${LABEL}: prune limit must be between 1 and ${MAX_PRUNE}`);
      const at = now();
      const before =
        input.before === undefined
          ? Math.max(0, at - terminalRetentionMs)
          : safeTime(input.before, "before");
      return db
        .transaction(() => {
          const jobs = db
            .query<{ job_id: string }, [number, number]>(
              `SELECT job_id FROM durable_jobs WHERE state IN ('completed','failed','canceled')
               AND updated_at < ? ORDER BY updated_at ASC, job_id ASC LIMIT ?`,
            )
            .all(before, limit);
          for (const job of jobs) {
            db.query("DELETE FROM durable_jobs WHERE job_id = ?").run(job.job_id);
          }
          return jobs.length;
        })
        .immediate();
    },
    pruneAudit(input = {}) {
      assertOpen();
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE) {
        throw new Error(`${LABEL}: audit prune limit must be between 1 and ${MAX_PRUNE}`);
      }
      const at = now();
      const latestAllowedCutoff = Math.max(0, at - auditRetentionMs);
      const before =
        input.before === undefined ? latestAllowedCutoff : safeTime(input.before, "audit before");
      if (before > latestAllowedCutoff) {
        throw new Error(`${LABEL}: audit retention cutoff is too recent`);
      }
      return db
        .transaction(
          () =>
            db
              .query(
                `DELETE FROM durable_job_reconciliations WHERE incident_id IN (
                  SELECT incident_id FROM durable_job_reconciliations
                  WHERE reconciled_at < ? ORDER BY reconciled_at ASC, incident_id ASC LIMIT ?
                )`,
              )
              .run(before, limit).changes,
        )
        .immediate();
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}

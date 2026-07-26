import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../lib/sqlite";
import type {
  DurableJobLease,
  DurableJobPayload,
  DurableJobRecord,
  DurableJobState,
  DurableJobStore,
  DurableJobSummary,
  SqliteDurableJobStoreOptions,
} from "./types";

export const DURABLE_JOBS_APPLICATION_ID = 0x444a4f42; // "DJOB"
export const DURABLE_JOBS_SCHEMA_VERSION = 1;
const LABEL = "durable jobs";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST = 100;
const MAX_PRUNE = 1_000;
const MAX_LEASE_MS = 60 * 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS durable_jobs (
    job_id                 TEXT PRIMARY KEY,
    idempotency_key_hash   TEXT NOT NULL UNIQUE,
    binding_hash           TEXT NOT NULL,
    payload_json           TEXT NOT NULL,
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
    reconciled_at    INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES durable_jobs(job_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_durable_job_incidents_time
     ON durable_job_incidents(detected_at, incident_id)`,
] as const;

const EXPECTED_SCHEMA = new Map(
  SCHEMA.map((sql) => {
    const name = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i)?.[1];
    if (!name) throw new Error(`${LABEL}: invalid schema declaration`);
    return [name, canonicalSqliteSchemaSql(sql)] as const;
  }),
);

interface Row {
  job_id: string;
  idempotency_key_hash: string;
  binding_hash: string;
  payload_json: string;
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

function safeTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${LABEL}: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalValue(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > 16) throw new Error(`${LABEL}: private JSON exceeds maximum nesting`);
  budget.nodes++;
  if (budget.nodes > 10_000) throw new Error(`${LABEL}: private JSON exceeds maximum nodes`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${LABEL}: private JSON contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1, budget));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalValue(object[key], depth + 1, budget)]),
    );
  }
  throw new Error(`${LABEL}: private JSON must contain only JSON values`);
}

function boundedJson(value: unknown, label: string): string {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new Error(`${LABEL}: ${label} is invalid`);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`${LABEL}: ${label} exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return json;
}

function payloadJson(payload: DurableJobPayload): string {
  const candidate = payload as unknown;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    (candidate as { version?: unknown }).version !== 1 ||
    !("value" in candidate)
  ) {
    throw new Error(`${LABEL}: payload must use version 1`);
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
  return (
    objects.length === EXPECTED_SCHEMA.size &&
    objects.every(
      (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
    )
  );
}

function validateRows(db: Database): void {
  const invalid = db
    .query<Row, []>(
      `SELECT * FROM durable_jobs
       WHERE attempt < 0 OR version < 1 OR available_at < 0 OR created_at < 0 OR updated_at < created_at
          OR cancel_requested NOT IN (0,1)
          OR (state IN ('leased','running') AND (lease_owner IS NULL OR lease_token IS NULL OR lease_expires_at IS NULL))
          OR (state NOT IN ('leased','running') AND (lease_owner IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
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
       WHERE a.attempt > j.attempt OR a.claimed_at < j.created_at
          OR (a.state = 'leased' AND (j.state <> 'leased' OR a.attempt <> j.attempt OR a.lease_token <> j.lease_token))
          OR (a.state = 'running' AND (j.state <> 'running' OR a.attempt <> j.attempt OR a.lease_token <> j.lease_token))
       LIMIT 1`,
    )
    .get();
  if (invalidAttempt) throw new Error(`${LABEL}: stored job attempt is inconsistent`);
  const invalidIncident = db
    .query<{ incident_id: string }, []>(
      `SELECT i.incident_id FROM durable_job_incidents i JOIN durable_jobs j ON j.job_id = i.job_id
       WHERE j.state <> 'outcome_unknown' OR j.incident_id <> i.incident_id
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
       WHERE incident_version < 1 OR reconciled_at < 0
          OR length(evidence_sha256) <> 64 OR evidence_sha256 GLOB '*[^0-9a-f]*'
       LIMIT 1`,
    )
    .get();
  if (invalidReconciliation) throw new Error(`${LABEL}: stored reconciliation is inconsistent`);
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

export function createSqliteDurableJobStore(
  options: SqliteDurableJobStoreOptions,
): DurableJobStore {
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
        validate(database, objects) {
          if (!hasExactSchema(objects))
            throw new Error(`${LABEL}: database schema is incompatible`);
          validateRows(database);
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

  function activeRow(jobId: string, token: string, state?: "leased" | "running"): Row {
    const row = select.get(safeId(jobId, "job ID"));
    if (
      !row ||
      (state !== undefined && row.state !== state) ||
      !["leased", "running"].includes(row.state) ||
      row.lease_token !== safeId(token, "lease token") ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now()
    ) {
      throw new Error(`${LABEL}: lease is no longer active`);
    }
    return row;
  }

  function unknown(dbRow: Row, at: number, reason: string, incidentId = mintIncident()): Row {
    const change = db
      .query(
        `UPDATE durable_jobs SET state = 'outcome_unknown', version = version + 1, updated_at = ?,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          incident_id = ?, incident_version = 1, incident_reason_code = ?, error_code = ?
         WHERE job_id = ? AND state IN ('leased','running')`,
      )
      .run(at, incidentId, reason, reason, dbRow.job_id);
    if (change.changes !== 1) throw new Error(`${LABEL}: lease is no longer active`);
    db.query(
      `INSERT INTO durable_job_incidents (incident_id, job_id, version, reason_code, detected_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(incidentId, dbRow.job_id, reason, at);
    db.query(
      `UPDATE durable_job_attempts SET state = 'outcome_unknown', settled_at = ?
       WHERE job_id = ? AND attempt = ?`,
    ).run(at, dbRow.job_id, dbRow.attempt);
    return select.get(dbRow.job_id)!;
  }

  const submitTx = db.transaction(
    (input: {
      idempotencyKey: string;
      binding: unknown;
      payload: DurableJobPayload;
      availableAt?: number;
    }) => {
      const key = safeText(input.idempotencyKey, "idempotency key", 256);
      const storedPayload = payloadJson(input.payload);
      const bindingHash = sha256(
        boundedJson({ binding: input.binding, payload: input.payload }, "binding"),
      );
      const keyHash = sha256(key);
      const existing = selectByKey.get(keyHash);
      if (existing) {
        if (existing.binding_hash !== bindingHash)
          throw new Error(`${LABEL}: idempotency binding conflicts`);
        return { status: "joined" as const, job: summary(existing) };
      }
      const at = now();
      const availableAt =
        input.availableAt === undefined ? at : safeTime(input.availableAt, "availableAt");
      const jobId = mintJobId();
      db.query(
        `INSERT INTO durable_jobs (
        job_id,idempotency_key_hash,binding_hash,payload_json,state,attempt,version,available_at,created_at,updated_at
      ) VALUES (?,?,?,?, 'queued',0,1,?,?,?)`,
      ).run(jobId, keyHash, bindingHash, storedPayload, availableAt, at, at);
      return { status: "created" as const, job: summary(select.get(jobId)!) };
    },
  );

  const claimTx = db.transaction(
    (input: { workerId: string; leaseMs: number }): DurableJobLease | null => {
      const workerId = safeText(input.workerId, "worker ID", 128);
      const leaseMs = safeTime(input.leaseMs, "leaseMs");
      if (leaseMs < 1 || leaseMs > MAX_LEASE_MS)
        throw new Error(`${LABEL}: leaseMs must be from 1 to ${MAX_LEASE_MS}`);
      const at = now();
      const candidate = db
        .query<Row, [number]>(
          `SELECT * FROM durable_jobs WHERE state = 'queued' AND available_at <= ?
         ORDER BY available_at ASC, created_at ASC, job_id ASC LIMIT 1`,
        )
        .get(at);
      if (!candidate) return null;
      const token = mintToken();
      const expiresAt = at + leaseMs;
      const update = db
        .query(
          `UPDATE durable_jobs SET state = 'leased', attempt = attempt + 1, version = version + 1,
          lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE job_id = ? AND state = 'queued' AND available_at <= ?`,
        )
        .run(workerId, token, expiresAt, at, candidate.job_id, at);
      if (update.changes !== 1) return null;
      const leased = select.get(candidate.job_id)!;
      db.query(
        `INSERT INTO durable_job_attempts (job_id,attempt,lease_token,worker_id,claimed_at,state)
       VALUES (?,?,?,?,?,'leased')`,
      ).run(leased.job_id, leased.attempt, token, workerId, at);
      return { job: summary(leased), token, expiresAt };
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
          const row = activeRow(input.jobId, input.token, "leased");
          const at = now();
          if (row.cancel_requested) {
            db.query(
              `UPDATE durable_jobs SET state = 'canceled', version = version + 1, completed_at = ?, updated_at = ?,
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ?`,
            ).run(at, at, row.job_id);
            db.query(
              "UPDATE durable_job_attempts SET state = 'canceled', settled_at = ? WHERE job_id = ? AND attempt = ?",
            ).run(at, row.job_id, row.attempt);
            return summary(select.get(row.job_id)!);
          }
          if (
            db
              .query(
                "UPDATE durable_jobs SET state = 'running', version = version + 1, started_at = ?, updated_at = ? WHERE job_id = ? AND state = 'leased' AND lease_token = ?",
              )
              .run(at, at, row.job_id, input.token).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'running', started_at = ? WHERE job_id = ? AND attempt = ?",
          ).run(at, row.job_id, row.attempt);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    heartbeat(input) {
      assertOpen();
      return db
        .transaction(() => {
          const row = activeRow(input.jobId, input.token);
          const leaseMs = safeTime(input.leaseMs, "leaseMs");
          if (leaseMs < 1 || leaseMs > MAX_LEASE_MS)
            throw new Error(`${LABEL}: leaseMs must be from 1 to ${MAX_LEASE_MS}`);
          const at = now();
          const expiresAt = at + leaseMs;
          if (
            db
              .query(
                "UPDATE durable_jobs SET lease_expires_at = ?, version = version + 1, updated_at = ? WHERE job_id = ? AND lease_token = ? AND lease_expires_at > ?",
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
          const row = activeRow(input.jobId, input.token, "leased");
          const at = now();
          const errorCode = safeText(input.errorCode, "errorCode", 64);
          const availableAt =
            input.availableAt === undefined ? at : safeTime(input.availableAt, "availableAt");
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = 'queued', version = version + 1, available_at = ?, updated_at = ?, error_code = ?,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
                 WHERE job_id = ? AND state = 'leased' AND lease_token = ?`,
              )
              .run(availableAt, at, errorCode, row.job_id, input.token).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'requeued', settled_at = ? WHERE job_id = ? AND attempt = ?",
          ).run(at, row.job_id, row.attempt);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    complete(input) {
      assertOpen();
      return db
        .transaction(() => {
          const row = activeRow(input.jobId, input.token, "running");
          const at = now();
          if (row.cancel_requested) return summary(unknown(row, at, "cancel-completion-race"));
          const result = boundedJson(input.result, "result");
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = 'completed', version = version + 1, completed_at = ?, updated_at = ?, result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state = 'running' AND lease_token = ?`,
              )
              .run(at, at, result, row.job_id, input.token).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = 'completed', settled_at = ? WHERE job_id = ? AND attempt = ?",
          ).run(at, row.job_id, row.attempt);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    failDefinite(input) {
      assertOpen();
      return db
        .transaction(() => {
          const row = activeRow(input.jobId, input.token, "running");
          const at = now();
          if (row.cancel_requested) return summary(unknown(row, at, "cancel-failure-race"));
          const errorCode = safeText(input.errorCode, "errorCode", 64);
          const retryAt =
            input.retryAt === undefined ? undefined : safeTime(input.retryAt, "retryAt");
          const nextState = retryAt === undefined ? "failed" : "queued";
          if (
            db
              .query(
                `UPDATE durable_jobs SET state = ?, version = version + 1, available_at = ?, completed_at = ?, updated_at = ?, error_code = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state = 'running' AND lease_token = ?`,
              )
              .run(
                nextState,
                retryAt ?? row.available_at,
                retryAt === undefined ? at : null,
                at,
                errorCode,
                row.job_id,
                input.token,
              ).changes !== 1
          ) {
            throw new Error(`${LABEL}: lease is no longer active`);
          }
          db.query(
            "UPDATE durable_job_attempts SET state = ?, settled_at = ? WHERE job_id = ? AND attempt = ?",
          ).run(retryAt === undefined ? "failed" : "requeued", at, row.job_id, row.attempt);
          return summary(select.get(row.job_id)!);
        })
        .immediate();
    },
    markOutcomeUnknown(input) {
      assertOpen();
      return db
        .transaction(() => {
          const row = activeRow(input.jobId, input.token);
          return summary(unknown(row, now(), safeText(input.reasonCode, "reasonCode", 64)));
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
          const at = now();
          const reason =
            input.reasonCode === undefined ? null : safeText(input.reasonCode, "reasonCode", 64);
          if (row.state === "queued" || row.state === "leased") {
            db.query(
              `UPDATE durable_jobs SET state = 'canceled', version = version + 1, completed_at = ?, updated_at = ?, cancel_requested = 1, cancel_reason = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ?`,
            ).run(at, at, reason, jobId);
            if (row.state === "leased")
              db.query(
                "UPDATE durable_job_attempts SET state = 'canceled', settled_at = ? WHERE job_id = ? AND attempt = ?",
              ).run(at, jobId, row.attempt);
            return { status: "canceled" as const, job: summary(select.get(jobId)!) };
          }
          if (row.state === "running") {
            db.query(
              "UPDATE durable_jobs SET cancel_requested = 1, cancel_reason = ?, version = version + 1, updated_at = ? WHERE job_id = ? AND state = 'running'",
            ).run(reason, at, jobId);
            return { status: "cancellation_requested" as const, job: summary(select.get(jobId)!) };
          }
          return { status: "unchanged" as const, job: summary(row) };
        })
        .immediate();
    },
    recoverInterrupted() {
      assertOpen();
      return db
        .transaction(() => {
          const at = now();
          const interrupted = db
            .query<Row, []>(
              "SELECT * FROM durable_jobs WHERE state IN ('leased','running') ORDER BY job_id",
            )
            .all();
          let requeued = 0;
          let quarantined = 0;
          for (const row of interrupted) {
            if (row.state === "leased") {
              db.query(
                `UPDATE durable_jobs SET state = CASE WHEN cancel_requested = 1 THEN 'canceled' ELSE 'queued' END, version = version + 1, available_at = ?, completed_at = CASE WHEN cancel_requested = 1 THEN ? ELSE NULL END, updated_at = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ?`,
              ).run(at, at, at, row.job_id);
              db.query(
                "UPDATE durable_job_attempts SET state = CASE WHEN ? = 1 THEN 'canceled' ELSE 'requeued' END, settled_at = ? WHERE job_id = ? AND attempt = ?",
              ).run(row.cancel_requested, at, row.job_id, row.attempt);
              if (row.cancel_requested) continue;
              requeued++;
            } else {
              unknown(row, at, "process-restarted");
              quarantined++;
            }
          }
          return { requeued, quarantined };
        })
        .immediate();
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
          const at = now();
          const state =
            input.disposition === "retry"
              ? "queued"
              : input.disposition === "cancel"
                ? "canceled"
                : "completed";
          db.query(
            `UPDATE durable_jobs SET state = ?, version = version + 1, available_at = ?, completed_at = ?, updated_at = ?, incident_id = NULL, incident_version = NULL, incident_reason_code = NULL, error_code = NULL, cancel_requested = CASE WHEN ? = 'cancel' THEN 1 ELSE 0 END WHERE job_id = ? AND state = 'outcome_unknown' AND version = ?`,
          ).run(
            state,
            input.disposition === "retry" ? at : row.available_at,
            input.disposition === "retry" ? null : at,
            at,
            input.disposition,
            jobId,
            input.expectedVersion,
          );
          const changes = db
            .query<{ changes: number }, []>("SELECT changes() AS changes")
            .get()?.changes;
          if (changes !== 1) return { reconciled: false };
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
    get(jobId) {
      assertOpen();
      const row = select.get(safeId(jobId, "job ID"));
      return row ? record(row) : null;
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
      const before = input.before === undefined ? now() : safeTime(input.before, "before");
      return db
        .transaction(
          () =>
            db
              .query(
                `DELETE FROM durable_jobs WHERE job_id IN (SELECT job_id FROM durable_jobs WHERE state IN ('completed','failed','canceled') AND updated_at < ? ORDER BY updated_at ASC, job_id ASC LIMIT ?)`,
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

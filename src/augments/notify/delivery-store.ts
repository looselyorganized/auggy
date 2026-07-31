import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../lib/sqlite";

export const NOTIFY_DELIVERY_APPLICATION_ID = 0x4e544659; // "NTFY"
export const NOTIFY_DELIVERY_SCHEMA_VERSION = 2;
const MAX_INCIDENTS = 100;
const MAX_OUTSTANDING_ATTEMPTS = 1_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_POLICY_WINDOW_MS = TERMINAL_RETENTION_MS;
const MAX_TERMINAL_ATTEMPTS = 10_000;
const MAX_MAINTENANCE_DELETE = 1_000;
const MAX_INTERNAL_ATTEMPTS = 20;
const EMPTY_SHA256 = "0".repeat(64);

const V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notify_delivery_attempts (
    attempt_id       TEXT PRIMARY KEY,
    operation_hash   TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    destination      TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'outcome_unknown')),
    incident_id      TEXT UNIQUE,
    incident_version INTEGER NOT NULL DEFAULT 1,
    reason_code      TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notify_attempt_operation
     ON notify_delivery_attempts(operation_hash, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notify_attempt_incident
     ON notify_delivery_attempts(state, updated_at, incident_id)`,
  `CREATE TABLE IF NOT EXISTS notify_quota_events (
    attempt_id          TEXT PRIMARY KEY,
    peer_hash           TEXT NOT NULL,
    destination         TEXT NOT NULL,
    summary_hash        TEXT NOT NULL,
    reserved_at         INTEGER NOT NULL,
    destination_explicit INTEGER NOT NULL CHECK (destination_explicit IN (0, 1)),
    charge_state        TEXT NOT NULL CHECK (charge_state IN ('reserved', 'charged', 'released')),
    FOREIGN KEY (attempt_id) REFERENCES notify_delivery_attempts(attempt_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notify_quota_time
     ON notify_quota_events(charge_state, reserved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notify_quota_destination
     ON notify_quota_events(destination, charge_state, reserved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notify_quota_peer
     ON notify_quota_events(peer_hash, destination, charge_state, reserved_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notify_quota_summary
     ON notify_quota_events(summary_hash, charge_state, reserved_at)`,
  `CREATE TABLE IF NOT EXISTS notify_delivery_recoveries (
    incident_id      TEXT PRIMARY KEY,
    attempt_id       TEXT NOT NULL UNIQUE,
    incident_version INTEGER NOT NULL,
    disposition      TEXT NOT NULL CHECK (disposition IN ('confirmed-delivered', 'confirmed-no-effect')),
    evidence_sha256  TEXT NOT NULL,
    resolved_at      INTEGER NOT NULL
  )`,
] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notify_delivery_attempts (
    attempt_id       TEXT PRIMARY KEY,
    operation_hash   TEXT NOT NULL,
    thread_id        TEXT NOT NULL,
    destination      TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'outcome_unknown')),
    incident_id      TEXT UNIQUE,
    incident_version INTEGER NOT NULL DEFAULT 1,
    reason_code      TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    payload_hash     TEXT NOT NULL DEFAULT '${EMPTY_SHA256}',
    replay_protected INTEGER NOT NULL DEFAULT 0 CHECK (replay_protected IN (0, 1)),
    max_attempts     INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1 AND max_attempts <= 20)
  )`,
  ...V1_SCHEMA.slice(1),
  `CREATE TABLE IF NOT EXISTS notify_internal_retry_authorizations (
    operation_hash TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 2 AND attempt_number <= 20),
    evidence_sha256 TEXT NOT NULL,
    authorized_at  INTEGER NOT NULL,
    PRIMARY KEY (operation_hash, attempt_number)
  )`,
  `CREATE TABLE IF NOT EXISTS notify_internal_operation_acknowledgements (
    operation_hash   TEXT PRIMARY KEY,
    settlement_sha256 TEXT NOT NULL,
    acknowledged_at INTEGER NOT NULL
  )`,
] as const;

function expectedSchema(schema: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    schema.map((sql) => {
      const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
      if (!match?.[1]) throw new Error("notify delivery store: invalid schema declaration");
      return [match[1], canonicalSqliteSchemaSql(sql)] as const;
    }),
  );
}

const V1_EXPECTED_SCHEMA = expectedSchema(V1_SCHEMA);
const EXPECTED_SCHEMA = expectedSchema(SCHEMA);

function hasExactSchema(
  objects: readonly SqliteSchemaObject[],
  expected: ReadonlyMap<string, string>,
): boolean {
  return (
    objects.length === expected.size &&
    objects.every((object) => expected.get(object.name) === canonicalSqliteSchemaSql(object.sql))
  );
}

function migrateV1(db: Database): void {
  db.run(
    `ALTER TABLE notify_delivery_attempts
       ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '${EMPTY_SHA256}'`,
  );
  db.run(
    `ALTER TABLE notify_delivery_attempts
       ADD COLUMN replay_protected INTEGER NOT NULL DEFAULT 0
       CHECK (replay_protected IN (0, 1))`,
  );
  db.run(
    `ALTER TABLE notify_delivery_attempts
       ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1
       CHECK (max_attempts >= 1 AND max_attempts <= 20)`,
  );
  db.run("UPDATE notify_delivery_attempts SET payload_hash = operation_hash");
  for (const sql of SCHEMA.slice(V1_SCHEMA.length)) db.run(sql);
}

function validateStoredRows(db: Database): void {
  const invalidAttempt = db
    .query<{ attempt_id: string }, []>(
      `SELECT attempt_id FROM notify_delivery_attempts
        WHERE created_at < 0 OR updated_at < created_at OR incident_version < 1
           OR length(operation_hash) <> 64 OR operation_hash GLOB '*[^0-9a-f]*'
           OR length(payload_hash) <> 64 OR payload_hash GLOB '*[^0-9a-f]*'
           OR replay_protected NOT IN (0, 1)
           OR max_attempts < 1 OR max_attempts > 20
           OR (state = 'outcome_unknown' AND (incident_id IS NULL OR reason_code IS NULL))
           OR (state <> 'outcome_unknown' AND (incident_id IS NOT NULL OR reason_code IS NOT NULL))
        LIMIT 1`,
    )
    .get();
  if (invalidAttempt) {
    throw new Error("notify delivery store: stored attempt state is inconsistent");
  }
  const invalidProtectedOperation = db
    .query<{ operation_hash: string }, []>(
      `SELECT operation_hash
         FROM notify_delivery_attempts
        WHERE replay_protected = 1
        GROUP BY operation_hash
       HAVING MIN(payload_hash) <> MAX(payload_hash)
           OR MIN(max_attempts) <> MAX(max_attempts)
           OR SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) > 1
           OR SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) > 1
           OR SUM(CASE WHEN state = 'outcome_unknown' THEN 1 ELSE 0 END) > 1
           OR SUM(CASE WHEN state IN ('pending', 'sent', 'outcome_unknown') THEN 1 ELSE 0 END) > 1
        LIMIT 1`,
    )
    .get();
  if (invalidProtectedOperation) {
    throw new Error("notify delivery store: protected operation state is inconsistent");
  }
  const invalidProtectedAttemptAccounting = db
    .query<{ operation_hash: string }, []>(
      `WITH operations AS (
         SELECT operation_hash, COUNT(*) AS attempt_count, MAX(max_attempts) AS base_attempts
           FROM notify_delivery_attempts
          WHERE replay_protected = 1
          GROUP BY operation_hash
       ),
       authorizations AS (
         SELECT operation_hash, COUNT(*) AS authorization_count,
                MIN(attempt_number) AS first_authorized,
                MAX(attempt_number) AS last_authorized
           FROM notify_internal_retry_authorizations
          GROUP BY operation_hash
       )
       SELECT operations.operation_hash
         FROM operations
         LEFT JOIN authorizations USING (operation_hash)
        WHERE COALESCE(authorizations.authorization_count, 0)
              NOT IN (
                MAX(operations.attempt_count - operations.base_attempts, 0),
                MAX(operations.attempt_count - operations.base_attempts, 0) + 1
              )
           OR (
             COALESCE(authorizations.authorization_count, 0) > 0
             AND (
               authorizations.first_authorized <> operations.base_attempts + 1
               OR authorizations.last_authorized <>
                  operations.base_attempts + authorizations.authorization_count
             )
           )
        LIMIT 1`,
    )
    .get();
  if (invalidProtectedAttemptAccounting) {
    throw new Error("notify delivery store: protected attempt accounting is inconsistent");
  }
  const invalidQuota = db
    .query<{ attempt_id: string }, []>(
      `SELECT attempt_id FROM notify_quota_events
        WHERE reserved_at < 0
           OR length(peer_hash) <> 64 OR peer_hash GLOB '*[^0-9a-f]*'
           OR length(summary_hash) <> 64 OR summary_hash GLOB '*[^0-9a-f]*'
        LIMIT 1`,
    )
    .get();
  if (invalidQuota) throw new Error("notify delivery store: stored quota state is inconsistent");
  const invalidRecovery = db
    .query<{ incident_id: string }, []>(
      `SELECT incident_id FROM notify_delivery_recoveries
        WHERE incident_version < 1 OR resolved_at < 0
           OR length(evidence_sha256) <> 64 OR evidence_sha256 GLOB '*[^0-9a-f]*'
        LIMIT 1`,
    )
    .get();
  if (invalidRecovery) {
    throw new Error("notify delivery store: stored recovery state is inconsistent");
  }
  const invalidInternalAuthorization = db
    .query<{ operation_hash: string }, []>(
      `SELECT authorization.operation_hash
         FROM notify_internal_retry_authorizations AS authorization
        WHERE length(authorization.operation_hash) <> 64
           OR authorization.operation_hash GLOB '*[^0-9a-f]*'
           OR length(authorization.evidence_sha256) <> 64
           OR authorization.evidence_sha256 GLOB '*[^0-9a-f]*'
           OR authorization.authorized_at < 0
           OR NOT EXISTS (
             SELECT 1 FROM notify_delivery_attempts AS attempt
              WHERE attempt.operation_hash = authorization.operation_hash
                AND attempt.replay_protected = 1
           )
           OR authorization.attempt_number > (
             SELECT COUNT(*) + 1 FROM notify_delivery_attempts AS attempt
              WHERE attempt.operation_hash = authorization.operation_hash
                AND attempt.replay_protected = 1
           )
        LIMIT 1`,
    )
    .get();
  if (invalidInternalAuthorization) {
    throw new Error("notify delivery store: internal retry authorization is inconsistent");
  }
  const invalidInternalAcknowledgement = db
    .query<{ operation_hash: string }, []>(
      `SELECT acknowledgement.operation_hash
         FROM notify_internal_operation_acknowledgements AS acknowledgement
        WHERE length(acknowledgement.operation_hash) <> 64
           OR acknowledgement.operation_hash GLOB '*[^0-9a-f]*'
           OR length(acknowledgement.settlement_sha256) <> 64
           OR acknowledgement.settlement_sha256 GLOB '*[^0-9a-f]*'
           OR acknowledgement.acknowledged_at < 0
           OR NOT EXISTS (
             SELECT 1 FROM notify_delivery_attempts AS attempt
              WHERE attempt.operation_hash = acknowledgement.operation_hash
                AND attempt.replay_protected = 1
                AND attempt.state IN ('sent', 'failed')
           )
           OR EXISTS (
             SELECT 1 FROM notify_delivery_attempts AS attempt
              WHERE attempt.operation_hash = acknowledgement.operation_hash
                AND attempt.state IN ('pending', 'outcome_unknown')
           )
        LIMIT 1`,
    )
    .get();
  if (invalidInternalAcknowledgement) {
    throw new Error("notify delivery store: internal acknowledgement is inconsistent");
  }
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`notify delivery store: ${label} must contain 1 to 128 safe characters`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`notify delivery store: ${label} must be lowercase SHA-256`);
  }
  return value;
}

function boundedText(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  let hasControl = false;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      hasControl = true;
      break;
    }
  }
  if (!normalized || normalized.length > max || hasControl) {
    throw new Error(`notify delivery store: ${label} is invalid`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`notify delivery store: ${label} must be a non-negative safe integer`);
  }
  return value;
}

export interface NotifyQuotaPolicy {
  enforce: boolean;
  globalMaxPerHour: number;
  perPeerCooldownMs: number;
  dedupWindowMs: number;
  destinationExplicit: boolean;
  destinationMaxPerHour?: number;
  destinationCooldownMs?: number;
}

export type NotifyReserveResult =
  | { status: "reserved"; attemptId: string }
  | { status: "rate_limited"; message: string }
  | { status: "in_flight" }
  | { status: "outcome_unknown"; incidentId: string; incidentVersion: number };

export type NotifyInternalReserveResult =
  | { status: "reserved"; attemptId: string; attemptCount: number }
  | { status: "rate_limited"; message: string; attemptCount: number }
  | { status: "in_flight"; attemptCount: number }
  | { status: "already_sent"; attemptCount: number }
  | { status: "attempts_exhausted"; attemptCount: number }
  | { status: "operation_conflict"; attemptCount: number }
  | {
      status: "outcome_unknown";
      incidentId: string;
      incidentVersion: number;
      attemptCount: number;
    };

export type NotifyInternalInspectResult =
  | { status: "not_found"; attemptCount: 0 }
  | { status: "failed"; attemptCount: number }
  | Exclude<NotifyInternalReserveResult, { status: "reserved" | "rate_limited" }>;

export interface NotifyDeliveryIncident {
  id: string;
  version: number;
  attemptId: string;
  threadId: string;
  destination: string;
  reasonCode: string;
  detectedAt: number;
}

export interface NotifyDeliveryStore {
  reserve(input: {
    operationHash: string;
    threadId: string;
    peerHash: string;
    destination: string;
    summaryHash: string;
    policy: NotifyQuotaPolicy;
  }): NotifyReserveResult;
  /**
   * Reserve one provider attempt for a trusted automatic caller. Unlike the
   * model-facing reserve path, the operation remains terminally replay-safe,
   * binds to one immutable payload, and always consumes normal quota.
   */
  reserveInternal(input: {
    operationHash: string;
    payloadHash: string;
    maxAttempts: number;
    threadId: string;
    peerHash: string;
    destination: string;
    summaryHash: string;
    policy: Omit<NotifyQuotaPolicy, "enforce">;
  }): NotifyInternalReserveResult;
  /** Read replay state for one protected operation without reserving quota or a provider attempt. */
  inspectInternal(input: {
    operationHash: string;
    payloadHash: string;
    maxAttempts: number;
    threadId: string;
    destination: string;
  }): NotifyInternalInspectResult;
  /**
   * Record that the source durably settled its outbox generation. Attempts
   * remain replay-readable, but no longer consume active terminal capacity.
   */
  acknowledgeInternal(input: {
    operationHash: string;
    settlementSha256: string;
  }): "acknowledged" | "already_acknowledged" | "not_found" | "not_terminal" | "conflict";
  authorizeInternalRetry(input: {
    operationHash: string;
    expectedAttemptCount: number;
    evidence: string;
  }):
    | { status: "authorized"; attemptCount: number; authorizedAttempt: number }
    | {
        status:
          | "not_found"
          | "operation_conflict"
          | "not_exhausted"
          | "not_definitively_failed"
          | "attempt_limit_reached";
        attemptCount: number;
      };
  settle(
    attemptId: string,
    outcome: "sent" | "failed" | "outcome_unknown",
    reasonCode?: string,
  ): NotifyDeliveryIncident | null;
  listIncidents(limit?: number): NotifyDeliveryIncident[];
  /** Startup-only conversion of unfinished sends into durable incidents. */
  prepareForRuntime(): NotifyDeliveryIncident[];
  listIncidentThreads(): string[];
  hasIncidentThread(threadId: string): boolean;
  reconcile(input: {
    incidentId: string;
    expectedVersion: number;
    disposition: "confirmed-delivered" | "confirmed-no-effect";
    evidence: string;
  }): { resolved: boolean; threadId?: string; releaseThread?: boolean };
  close(): void;
}

export interface NotifyDeliveryStoreOptions {
  dbPath: string;
  now?: () => number;
  attemptId?: () => string;
  incidentId?: () => string;
  /** Test-only terminal-attempt capacity seam. */
  terminalAttemptCapacity?: number;
}

interface AttemptRow {
  attempt_id: string;
  operation_hash: string;
  thread_id: string;
  destination: string;
  state: "pending" | "sent" | "failed" | "outcome_unknown";
  incident_id: string | null;
  incident_version: number;
  reason_code: string | null;
  created_at: number;
  updated_at: number;
  payload_hash: string;
  replay_protected: 0 | 1;
  max_attempts: number;
}

export function createNotifyDeliveryStore(
  options: NotifyDeliveryStoreOptions,
): NotifyDeliveryStore {
  const now = options.now ?? Date.now;
  const mintAttemptId = options.attemptId ?? randomUUID;
  const mintIncidentId = options.incidentId ?? randomUUID;
  const terminalAttemptCapacity = options.terminalAttemptCapacity ?? MAX_TERMINAL_ATTEMPTS;
  if (
    !Number.isSafeInteger(terminalAttemptCapacity) ||
    terminalAttemptCapacity < 1 ||
    terminalAttemptCapacity > MAX_TERMINAL_ATTEMPTS
  ) {
    throw new Error(
      `notify delivery store: terminalAttemptCapacity must be between 1 and ${MAX_TERMINAL_ATTEMPTS}`,
    );
  }
  const database = openHardenedSqlite({
    path: options.dbPath,
    label: "notify delivery store",
    synchronous: "FULL",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "notify delivery store",
        applicationId: NOTIFY_DELIVERY_APPLICATION_ID,
        schemaVersion: NOTIFY_DELIVERY_SCHEMA_VERSION,
        initialize(target) {
          for (const statement of SCHEMA) target.run(statement);
        },
        isLegacy(_target, objects) {
          return (
            hasExactSchema(objects, V1_EXPECTED_SCHEMA) || hasExactSchema(objects, EXPECTED_SCHEMA)
          );
        },
        migrateLegacy(target) {
          const objects = target
            .query<SqliteSchemaObject, []>(
              `SELECT type, name, sql FROM sqlite_schema
               WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
            )
            .all();
          if (hasExactSchema(objects, V1_EXPECTED_SCHEMA)) migrateV1(target);
        },
        migrateOwned(target, fromVersion, objects) {
          if (fromVersion !== 1 || !hasExactSchema(objects, V1_EXPECTED_SCHEMA)) {
            throw new Error("notify delivery store: unsupported prior owned schema");
          }
          migrateV1(target);
        },
        validate(_target, objects) {
          if (!hasExactSchema(objects, EXPECTED_SCHEMA)) {
            throw new Error("notify delivery store: incompatible or unexpected database schema");
          }
          validateStoredRows(_target);
        },
      });
    },
  });
  const db = database.db;
  let closed = false;

  const clock = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("notify delivery store: clock returned an invalid timestamp");
    }
    return value;
  };

  const selectUnresolvedOperation = db.query<AttemptRow, [string]>(
    `SELECT * FROM notify_delivery_attempts
      WHERE operation_hash = ? AND state IN ('pending', 'outcome_unknown')
      ORDER BY created_at DESC LIMIT 1`,
  );
  const selectInternalOperation = db.query<AttemptRow, [string]>(
    `SELECT * FROM notify_delivery_attempts
      WHERE operation_hash = ?
      ORDER BY created_at ASC, attempt_id ASC`,
  );
  const hasInternalRetryAuthorization = db.query<{ found: number }, [string, number]>(
    `SELECT 1 AS found FROM notify_internal_retry_authorizations
      WHERE operation_hash = ? AND attempt_number = ?`,
  );
  const insertInternalRetryAuthorization = db.query(
    `INSERT INTO notify_internal_retry_authorizations (
       operation_hash, attempt_number, evidence_sha256, authorized_at
     ) VALUES (?, ?, ?, ?)`,
  );
  const selectInternalAcknowledgement = db.query<{ settlement_sha256: string }, [string]>(
    `SELECT settlement_sha256
       FROM notify_internal_operation_acknowledgements
      WHERE operation_hash = ?`,
  );
  const insertInternalAcknowledgement = db.query(
    `INSERT INTO notify_internal_operation_acknowledgements (
       operation_hash, settlement_sha256, acknowledged_at
     ) VALUES (?, ?, ?)`,
  );
  const insertAttempt = db.query(
    `INSERT INTO notify_delivery_attempts (
       attempt_id, operation_hash, thread_id, destination, state, created_at, updated_at,
       payload_hash, replay_protected, max_attempts
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  );
  const insertQuota = db.query(
    `INSERT INTO notify_quota_events (
       attempt_id, peer_hash, destination, summary_hash, reserved_at,
       destination_explicit, charge_state
     ) VALUES (?, ?, ?, ?, ?, ?, 'reserved')`,
  );
  const countGlobal = db.query<{ count: number }, [number]>(
    `SELECT COUNT(*) AS count FROM notify_quota_events
      WHERE destination_explicit = 0 AND charge_state <> 'released' AND reserved_at > ?`,
  );
  const countDestination = db.query<{ count: number }, [string, number]>(
    `SELECT COUNT(*) AS count FROM notify_quota_events
      WHERE destination = ? AND destination_explicit = 1
        AND charge_state <> 'released' AND reserved_at > ?`,
  );
  const latestPeer = db.query<{ reserved_at: number | null }, [string, string]>(
    `SELECT MAX(reserved_at) AS reserved_at FROM notify_quota_events
      WHERE peer_hash = ? AND destination = ? AND destination_explicit = 0
        AND charge_state <> 'released'`,
  );
  const latestDestination = db.query<{ reserved_at: number | null }, [string]>(
    `SELECT MAX(reserved_at) AS reserved_at FROM notify_quota_events
      WHERE destination = ? AND destination_explicit = 1 AND charge_state <> 'released'`,
  );
  const latestSummary = db.query<{ reserved_at: number | null }, [string]>(
    `SELECT MAX(reserved_at) AS reserved_at FROM notify_quota_events
      WHERE summary_hash = ? AND charge_state <> 'released'`,
  );
  const updateSettlement = db.query(
    `UPDATE notify_delivery_attempts
        SET state = ?, incident_id = ?, incident_version = ?, reason_code = ?, updated_at = ?
      WHERE attempt_id = ? AND state = 'pending'`,
  );
  const updateQuota = db.query(
    `UPDATE notify_quota_events SET charge_state = ? WHERE attempt_id = ?`,
  );
  const selectAttempt = db.query<AttemptRow, [string]>(
    "SELECT * FROM notify_delivery_attempts WHERE attempt_id = ?",
  );
  const listUnknown = db.query<AttemptRow, [number]>(
    `SELECT * FROM notify_delivery_attempts WHERE state = 'outcome_unknown'
      ORDER BY updated_at ASC, incident_id ASC LIMIT ?`,
  );
  const selectIncident = db.query<AttemptRow, [string]>(
    `SELECT * FROM notify_delivery_attempts
      WHERE state = 'outcome_unknown' AND incident_id = ?`,
  );
  const resolveAttempt = db.query(
    `UPDATE notify_delivery_attempts
        SET state = ?, incident_id = NULL, reason_code = NULL, updated_at = ?
      WHERE attempt_id = ? AND state = 'outcome_unknown'
        AND incident_id = ? AND incident_version = ?`,
  );
  const insertRecovery = db.query(
    `INSERT INTO notify_delivery_recoveries (
       incident_id, attempt_id, incident_version, disposition, evidence_sha256, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const countThreadUnknown = db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM notify_delivery_attempts
      WHERE thread_id = ? AND state = 'outcome_unknown'`,
  );
  const selectInterrupted = db.query<AttemptRow, []>(
    "SELECT * FROM notify_delivery_attempts WHERE state = 'pending'",
  );
  const promoteInterrupted = db.query(
    `UPDATE notify_delivery_attempts
        SET state = 'outcome_unknown', incident_id = ?,
            reason_code = 'process-restarted', updated_at = ?
      WHERE attempt_id = ? AND state = 'pending'`,
  );
  const purgeQuota = db.query(
    "DELETE FROM notify_quota_events WHERE charge_state = 'released' AND reserved_at < ?",
  );
  const purgeTerminal = db.query(
    `DELETE FROM notify_delivery_attempts AS candidate
      WHERE candidate.state IN ('sent', 'failed') AND candidate.updated_at < ?
        AND candidate.replay_protected = 0`,
  );
  const purgeRecoveries = db.query("DELETE FROM notify_delivery_recoveries WHERE resolved_at < ?");
  const purgeInternalRetryAuthorizations = db.query(
    `DELETE FROM notify_internal_retry_authorizations
      WHERE NOT EXISTS (
        SELECT 1 FROM notify_delivery_attempts
         WHERE notify_delivery_attempts.operation_hash =
               notify_internal_retry_authorizations.operation_hash
      )`,
  );
  const deleteOldestTerminal = db.query(
    `DELETE FROM notify_delivery_attempts WHERE attempt_id IN (
       SELECT attempt_id FROM notify_delivery_attempts
        WHERE state IN ('sent', 'failed') AND replay_protected = 0
        ORDER BY updated_at ASC, attempt_id ASC LIMIT ?
     )`,
  );
  const countTerminal = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM notify_delivery_attempts
      WHERE state IN ('sent', 'failed')
        AND (
          replay_protected = 0
          OR NOT EXISTS (
            SELECT 1 FROM notify_internal_operation_acknowledgements AS acknowledgement
             WHERE acknowledgement.operation_hash =
                   notify_delivery_attempts.operation_hash
          )
        )`,
  );
  const countOutstanding = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM notify_delivery_attempts
      WHERE state IN ('pending', 'outcome_unknown')`,
  );
  const latestDurableTimestamp = db.query<{ latest_at: number | null }, []>(
    `SELECT MAX(value) AS latest_at FROM (
       SELECT MAX(created_at) AS value FROM notify_delivery_attempts
       UNION ALL SELECT MAX(updated_at) FROM notify_delivery_attempts
       UNION ALL SELECT MAX(reserved_at) FROM notify_quota_events
       UNION ALL SELECT MAX(resolved_at) FROM notify_delivery_recoveries
       UNION ALL SELECT MAX(authorized_at) FROM notify_internal_retry_authorizations
       UNION ALL
       SELECT MAX(acknowledged_at) FROM notify_internal_operation_acknowledgements
     )`,
  );

  function incident(row: AttemptRow): NotifyDeliveryIncident {
    if (!row.incident_id || !row.reason_code) {
      throw new Error("notify delivery store: outcome-unknown row is missing incident metadata");
    }
    return {
      id: row.incident_id,
      version: row.incident_version,
      attemptId: row.attempt_id,
      threadId: row.thread_id,
      destination: row.destination,
      reasonCode: row.reason_code,
      detectedAt: row.updated_at,
    };
  }

  function monotonicClock(): number {
    return Math.max(clock(), latestDurableTimestamp.get()?.latest_at ?? 0);
  }

  function maintain(at: number, reserveCapacity: boolean): void {
    purgeQuota.run(at - TERMINAL_RETENTION_MS);
    const terminalCutoff = at - TERMINAL_RETENTION_MS;
    purgeTerminal.run(terminalCutoff);
    purgeRecoveries.run(at - TERMINAL_RETENTION_MS);
    purgeInternalRetryAuthorizations.run();
    const terminalCount = countTerminal.get()?.count ?? 0;
    const target = terminalAttemptCapacity - (reserveCapacity ? 1 : 0);
    if (terminalCount > target) {
      deleteOldestTerminal.run(Math.min(MAX_MAINTENANCE_DELETE, terminalCount - target));
    }
    const remaining = countTerminal.get()?.count ?? 0;
    if (remaining > terminalAttemptCapacity - (reserveCapacity ? 1 : 0)) {
      throw new Error(
        "notify delivery store: terminal record capacity requires operator maintenance",
      );
    }
  }

  function quotaRejection(
    input: {
      peerHash: string;
      destination: string;
      summaryHash: string;
      policy: NotifyQuotaPolicy;
    },
    reservedAt: number,
  ): { status: "rate_limited"; message: string } | null {
    if (!input.policy.enforce) return null;
    const hourStart = reservedAt - 3_600_000;
    if (input.policy.destinationExplicit) {
      const last = latestDestination.get(input.destination)?.reserved_at;
      const cooldown = input.policy.destinationCooldownMs ?? 0;
      if (last != null && reservedAt - last < cooldown) {
        return {
          status: "rate_limited",
          message: `Notification suppressed — per-destination cooldown active for '${input.destination}'.`,
        };
      }
      const maximum = input.policy.destinationMaxPerHour ?? input.policy.globalMaxPerHour;
      if ((countDestination.get(input.destination, hourStart)?.count ?? 0) >= maximum) {
        return {
          status: "rate_limited",
          message: `Notification suppressed — per-destination cap reached for '${input.destination}' (${maximum}/hr).`,
        };
      }
    } else {
      const last = latestPeer.get(input.peerHash, input.destination)?.reserved_at;
      if (last != null && reservedAt - last < input.policy.perPeerCooldownMs) {
        return {
          status: "rate_limited",
          message: "Notification suppressed — per-peer cooldown active.",
        };
      }
      if ((countGlobal.get(hourStart)?.count ?? 0) >= input.policy.globalMaxPerHour) {
        return {
          status: "rate_limited",
          message: `Notification suppressed — global limit reached (${input.policy.globalMaxPerHour} per hour).`,
        };
      }
    }
    const recentSummary = latestSummary.get(input.summaryHash)?.reserved_at;
    if (
      input.policy.dedupWindowMs > 0 &&
      recentSummary != null &&
      reservedAt - recentSummary < input.policy.dedupWindowMs
    ) {
      return {
        status: "rate_limited",
        message: "Notification suppressed — the same message was already attempted recently.",
      };
    }
    return null;
  }

  const reserveTransaction = db.transaction(
    (input: {
      operationHash: string;
      threadId: string;
      peerHash: string;
      destination: string;
      summaryHash: string;
      policy: NotifyQuotaPolicy;
    }): NotifyReserveResult => {
      const reservedAt = monotonicClock();
      maintain(reservedAt, true);
      const existing = selectUnresolvedOperation.get(input.operationHash);
      if (existing?.state === "pending") return { status: "in_flight" };
      if (existing?.state === "outcome_unknown") {
        return {
          status: "outcome_unknown",
          incidentId: existing.incident_id!,
          incidentVersion: existing.incident_version,
        };
      }
      if ((countOutstanding.get()?.count ?? 0) >= MAX_OUTSTANDING_ATTEMPTS) {
        throw new Error(
          `notify delivery store: ${MAX_OUTSTANDING_ATTEMPTS} unresolved attempts require operator recovery`,
        );
      }

      const rateLimited = quotaRejection(input, reservedAt);
      if (rateLimited) return rateLimited;

      const attemptId = safeId(mintAttemptId(), "attempt ID");
      insertAttempt.run(
        attemptId,
        input.operationHash,
        input.threadId,
        input.destination,
        reservedAt,
        reservedAt,
        input.operationHash,
        0,
        1,
      );
      if (input.policy.enforce) {
        insertQuota.run(
          attemptId,
          input.peerHash,
          input.destination,
          input.summaryHash,
          reservedAt,
          input.policy.destinationExplicit ? 1 : 0,
        );
      }
      return { status: "reserved", attemptId };
    },
  );

  const reserveInternalTransaction = db.transaction(
    (input: {
      operationHash: string;
      payloadHash: string;
      maxAttempts: number;
      threadId: string;
      peerHash: string;
      destination: string;
      summaryHash: string;
      policy: NotifyQuotaPolicy;
    }): NotifyInternalReserveResult => {
      const reservedAt = monotonicClock();
      maintain(reservedAt, false);
      const existing = selectInternalOperation.all(input.operationHash);
      const attemptCount = existing.length;
      if (attemptCount > 0) {
        if (
          existing.some(
            (row) =>
              row.replay_protected !== 1 ||
              row.payload_hash !== input.payloadHash ||
              row.max_attempts !== input.maxAttempts ||
              row.thread_id !== input.threadId ||
              row.destination !== input.destination,
          )
        ) {
          return { status: "operation_conflict", attemptCount };
        }
        const nonFailed = existing.filter((row) => row.state !== "failed");
        if (nonFailed.length > 1) {
          return { status: "operation_conflict", attemptCount };
        }
        const terminal = nonFailed[0];
        if (terminal?.state === "pending") return { status: "in_flight", attemptCount };
        if (terminal?.state === "sent") return { status: "already_sent", attemptCount };
        if (terminal?.state === "outcome_unknown") {
          return {
            status: "outcome_unknown",
            incidentId: terminal.incident_id!,
            incidentVersion: terminal.incident_version,
            attemptCount,
          };
        }
        if (selectInternalAcknowledgement.get(input.operationHash)) {
          return { status: "attempts_exhausted", attemptCount };
        }
        const nextAttempt = attemptCount + 1;
        const explicitlyAuthorized =
          hasInternalRetryAuthorization.get(input.operationHash, nextAttempt)?.found === 1;
        if (attemptCount >= input.maxAttempts && !explicitlyAuthorized) {
          return { status: "attempts_exhausted", attemptCount };
        }
      }

      maintain(reservedAt, true);
      if ((countOutstanding.get()?.count ?? 0) >= MAX_OUTSTANDING_ATTEMPTS) {
        throw new Error(
          `notify delivery store: ${MAX_OUTSTANDING_ATTEMPTS} unresolved attempts require operator recovery`,
        );
      }
      const rateLimited = quotaRejection(input, reservedAt);
      if (rateLimited) return { ...rateLimited, attemptCount };

      const attemptId = safeId(mintAttemptId(), "attempt ID");
      insertAttempt.run(
        attemptId,
        input.operationHash,
        input.threadId,
        input.destination,
        reservedAt,
        reservedAt,
        input.payloadHash,
        1,
        input.maxAttempts,
      );
      insertQuota.run(
        attemptId,
        input.peerHash,
        input.destination,
        input.summaryHash,
        reservedAt,
        input.policy.destinationExplicit ? 1 : 0,
      );
      return { status: "reserved", attemptId, attemptCount: attemptCount + 1 };
    },
  );

  const authorizeInternalRetryTransaction = db.transaction(
    (input: {
      operationHash: string;
      expectedAttemptCount: number;
      evidence: string;
    }): ReturnType<NotifyDeliveryStore["authorizeInternalRetry"]> => {
      maintain(clock(), false);
      const existing = selectInternalOperation.all(input.operationHash);
      const attemptCount = existing.length;
      if (attemptCount === 0) return { status: "not_found", attemptCount };
      if (
        existing.some(
          (row) =>
            row.replay_protected !== 1 ||
            row.payload_hash !== existing[0]!.payload_hash ||
            row.max_attempts !== existing[0]!.max_attempts ||
            row.thread_id !== existing[0]!.thread_id ||
            row.destination !== existing[0]!.destination,
        )
      ) {
        return { status: "operation_conflict", attemptCount };
      }
      if (attemptCount !== input.expectedAttemptCount) {
        return { status: "operation_conflict", attemptCount };
      }
      if (selectInternalAcknowledgement.get(input.operationHash)) {
        return { status: "operation_conflict", attemptCount };
      }
      if (existing.some((row) => row.state !== "failed")) {
        return { status: "not_definitively_failed", attemptCount };
      }
      const priorAuthorizations = Math.max(0, attemptCount - existing[0]!.max_attempts);
      const exhaustedAt = existing[0]!.max_attempts + priorAuthorizations;
      if (attemptCount < exhaustedAt) return { status: "not_exhausted", attemptCount };
      if (attemptCount >= MAX_INTERNAL_ATTEMPTS) {
        return { status: "attempt_limit_reached", attemptCount };
      }
      const authorizedAttempt = attemptCount + 1;
      if (hasInternalRetryAuthorization.get(input.operationHash, authorizedAttempt)?.found === 1) {
        return { status: "operation_conflict", attemptCount };
      }
      insertInternalRetryAuthorization.run(
        input.operationHash,
        authorizedAttempt,
        sha256(input.evidence),
        Math.max(clock(), ...existing.map((row) => row.updated_at)),
      );
      return { status: "authorized", attemptCount, authorizedAttempt };
    },
  );

  const acknowledgeInternalTransaction = db.transaction(
    (input: {
      operationHash: string;
      settlementSha256: string;
    }): ReturnType<NotifyDeliveryStore["acknowledgeInternal"]> => {
      const existing = selectInternalOperation.all(input.operationHash);
      if (existing.length === 0) return "not_found";
      if (
        existing.some(
          (row) =>
            row.replay_protected !== 1 ||
            row.payload_hash !== existing[0]!.payload_hash ||
            row.max_attempts !== existing[0]!.max_attempts ||
            row.thread_id !== existing[0]!.thread_id ||
            row.destination !== existing[0]!.destination,
        )
      ) {
        return "conflict";
      }
      if (existing.some((row) => row.state === "pending" || row.state === "outcome_unknown")) {
        return "not_terminal";
      }
      const acknowledgement = selectInternalAcknowledgement.get(input.operationHash);
      if (acknowledgement) {
        return acknowledgement.settlement_sha256 === input.settlementSha256
          ? "already_acknowledged"
          : "conflict";
      }
      insertInternalAcknowledgement.run(
        input.operationHash,
        input.settlementSha256,
        Math.max(clock(), ...existing.map((row) => row.updated_at)),
      );
      return "acknowledged";
    },
  );

  const settleTransaction = db.transaction(
    (
      attemptId: string,
      outcome: "sent" | "failed" | "outcome_unknown",
      reasonCode: string | undefined,
    ): NotifyDeliveryIncident | null => {
      const current = selectAttempt.get(attemptId);
      if (!current) throw new Error("notify delivery store: unknown attempt");
      const settledAt = Math.max(clock(), current.created_at, current.updated_at);
      let incidentId: string | null = null;
      let nextVersion = 1;
      if (outcome === "outcome_unknown") {
        incidentId = safeId(mintIncidentId(), "incident ID");
        nextVersion = current.incident_version;
      }
      const result = updateSettlement.run(
        outcome,
        incidentId,
        nextVersion,
        outcome === "outcome_unknown"
          ? boundedText(reasonCode ?? "delivery-outcome-unknown", "reason code", 64)
          : null,
        settledAt,
        safeId(attemptId, "attempt ID"),
      );
      if (result.changes !== 1) {
        throw new Error("notify delivery store: attempt is missing or already settled");
      }
      // A dispatched attempt consumes quota even when the adapter reports a
      // failure: the remote boundary was crossed and retry pressure must stay
      // bounded. Only explicit operator confirmation of no effect releases it.
      updateQuota.run("charged", attemptId);
      if (outcome !== "outcome_unknown") return null;
      return incident(selectAttempt.get(attemptId)!);
    },
  );

  const reconcileTransaction = db.transaction(
    (input: {
      incidentId: string;
      expectedVersion: number;
      disposition: "confirmed-delivered" | "confirmed-no-effect";
      evidence: string;
    }) => {
      const row = selectIncident.get(input.incidentId);
      if (!row || row.incident_version !== input.expectedVersion) {
        return { resolved: false } as const;
      }
      const resolvedAt = Math.max(clock(), row.created_at, row.updated_at);
      const nextState = input.disposition === "confirmed-delivered" ? "sent" : "failed";
      if (
        resolveAttempt.run(
          nextState,
          resolvedAt,
          row.attempt_id,
          input.incidentId,
          input.expectedVersion,
        ).changes !== 1
      ) {
        return { resolved: false } as const;
      }
      updateQuota.run(
        input.disposition === "confirmed-delivered" ? "charged" : "released",
        row.attempt_id,
      );
      insertRecovery.run(
        input.incidentId,
        row.attempt_id,
        input.expectedVersion,
        input.disposition,
        sha256(input.evidence),
        resolvedAt,
      );
      const remaining = countThreadUnknown.get(row.thread_id)?.count ?? 0;
      return {
        resolved: true,
        threadId: row.thread_id,
        releaseThread: remaining === 0,
      } as const;
    },
  );

  db.transaction(() => maintain(clock(), false)).immediate();

  function validateQuotaPolicy(policy: NotifyQuotaPolicy): void {
    nonNegativeInteger(policy.globalMaxPerHour, "globalMaxPerHour");
    nonNegativeInteger(policy.perPeerCooldownMs, "perPeerCooldownMs");
    nonNegativeInteger(policy.dedupWindowMs, "dedupWindowMs");
    if (
      policy.perPeerCooldownMs > MAX_POLICY_WINDOW_MS ||
      policy.dedupWindowMs > MAX_POLICY_WINDOW_MS
    ) {
      throw new Error("notify delivery store: quota and dedup windows cannot exceed 30 days");
    }
    if (policy.destinationMaxPerHour !== undefined) {
      nonNegativeInteger(policy.destinationMaxPerHour, "destinationMaxPerHour");
    }
    if (policy.destinationCooldownMs !== undefined) {
      nonNegativeInteger(policy.destinationCooldownMs, "destinationCooldownMs");
      if (policy.destinationCooldownMs > MAX_POLICY_WINDOW_MS) {
        throw new Error("notify delivery store: destination cooldown cannot exceed 30 days");
      }
    }
  }

  return {
    reserve(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      digest(input.peerHash, "peerHash");
      digest(input.summaryHash, "summaryHash");
      boundedText(input.threadId, "threadId");
      boundedText(input.destination, "destination");
      validateQuotaPolicy(input.policy);
      return reserveTransaction.immediate(input);
    },
    reserveInternal(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      digest(input.payloadHash, "payloadHash");
      digest(input.peerHash, "peerHash");
      digest(input.summaryHash, "summaryHash");
      boundedText(input.threadId, "threadId");
      boundedText(input.destination, "destination");
      if (
        !Number.isSafeInteger(input.maxAttempts) ||
        input.maxAttempts < 1 ||
        input.maxAttempts > MAX_INTERNAL_ATTEMPTS
      ) {
        throw new Error(
          `notify delivery store: maxAttempts must be between 1 and ${MAX_INTERNAL_ATTEMPTS}`,
        );
      }
      const policy: NotifyQuotaPolicy = { ...input.policy, enforce: true };
      validateQuotaPolicy(policy);
      return reserveInternalTransaction.immediate({ ...input, policy });
    },
    inspectInternal(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      digest(input.payloadHash, "payloadHash");
      boundedText(input.threadId, "threadId");
      boundedText(input.destination, "destination");
      if (
        !Number.isSafeInteger(input.maxAttempts) ||
        input.maxAttempts < 1 ||
        input.maxAttempts > MAX_INTERNAL_ATTEMPTS
      ) {
        throw new Error(
          `notify delivery store: maxAttempts must be between 1 and ${MAX_INTERNAL_ATTEMPTS}`,
        );
      }
      const existing = selectInternalOperation.all(input.operationHash);
      const attemptCount = existing.length;
      if (attemptCount === 0) return { status: "not_found", attemptCount: 0 };
      if (
        existing.some(
          (row) =>
            row.replay_protected !== 1 ||
            row.payload_hash !== input.payloadHash ||
            row.max_attempts !== input.maxAttempts ||
            row.thread_id !== input.threadId ||
            row.destination !== input.destination,
        )
      ) {
        return { status: "operation_conflict", attemptCount };
      }
      const nonFailed = existing.filter((row) => row.state !== "failed");
      if (nonFailed.length > 1) return { status: "operation_conflict", attemptCount };
      const terminal = nonFailed[0];
      if (terminal?.state === "pending") return { status: "in_flight", attemptCount };
      if (terminal?.state === "sent") return { status: "already_sent", attemptCount };
      if (terminal?.state === "outcome_unknown") {
        return {
          status: "outcome_unknown",
          incidentId: terminal.incident_id!,
          incidentVersion: terminal.incident_version,
          attemptCount,
        };
      }
      if (selectInternalAcknowledgement.get(input.operationHash)) {
        return { status: "attempts_exhausted", attemptCount };
      }
      const nextAttempt = attemptCount + 1;
      const explicitlyAuthorized =
        hasInternalRetryAuthorization.get(input.operationHash, nextAttempt)?.found === 1;
      if (attemptCount >= input.maxAttempts && !explicitlyAuthorized) {
        return { status: "attempts_exhausted", attemptCount };
      }
      return { status: "failed", attemptCount };
    },
    acknowledgeInternal(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      digest(input.settlementSha256, "settlementSha256");
      return acknowledgeInternalTransaction.immediate(input);
    },
    authorizeInternalRetry(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      if (
        !Number.isSafeInteger(input.expectedAttemptCount) ||
        input.expectedAttemptCount < 1 ||
        input.expectedAttemptCount > MAX_INTERNAL_ATTEMPTS
      ) {
        throw new Error(
          `notify delivery store: expectedAttemptCount must be between 1 and ${MAX_INTERNAL_ATTEMPTS}`,
        );
      }
      boundedText(input.evidence, "evidence", 400);
      return authorizeInternalRetryTransaction.immediate(input);
    },
    settle(attemptId, outcome, reasonCode) {
      if (closed) throw new Error("notify delivery store: store is closed");
      if (!(["sent", "failed", "outcome_unknown"] as const).includes(outcome)) {
        throw new Error("notify delivery store: invalid settlement outcome");
      }
      if (
        outcome === "outcome_unknown" &&
        reasonCode !== undefined &&
        !/^[a-z0-9-]{1,64}$/.test(reasonCode)
      ) {
        throw new Error("notify delivery store: reasonCode must be a fixed safe code");
      }
      return settleTransaction.immediate(attemptId, outcome, reasonCode);
    },
    listIncidents(limit = 50) {
      if (closed) throw new Error("notify delivery store: store is closed");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INCIDENTS) {
        throw new Error(
          `notify delivery store: incident limit must be between 1 and ${MAX_INCIDENTS}`,
        );
      }
      return listUnknown.all(limit).map(incident);
    },
    prepareForRuntime() {
      if (closed) throw new Error("notify delivery store: store is closed");
      const promoted = db
        .transaction(() => {
          const detectedAt = clock();
          const interrupted = selectInterrupted.all();
          if (interrupted.length > MAX_OUTSTANDING_ATTEMPTS) {
            throw new Error(
              `notify delivery store: more than ${MAX_OUTSTANDING_ATTEMPTS} unfinished attempts require operator repair`,
            );
          }
          const incidents: NotifyDeliveryIncident[] = [];
          for (const row of interrupted) {
            promoteInterrupted.run(
              safeId(mintIncidentId(), "incident ID"),
              Math.max(detectedAt, row.created_at, row.updated_at),
              row.attempt_id,
            );
            updateQuota.run("charged", row.attempt_id);
            incidents.push(incident(selectAttempt.get(row.attempt_id)!));
          }
          return incidents;
        })
        .immediate();
      database.secureArtifacts();
      return promoted;
    },
    listIncidentThreads() {
      if (closed) throw new Error("notify delivery store: store is closed");
      return [
        ...new Set(listUnknown.all(MAX_OUTSTANDING_ATTEMPTS).map((row) => incident(row).threadId)),
      ];
    },
    hasIncidentThread(threadId) {
      if (closed) throw new Error("notify delivery store: store is closed");
      boundedText(threadId, "threadId");
      return (countThreadUnknown.get(threadId)?.count ?? 0) > 0;
    },
    reconcile(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      safeId(input.incidentId, "incident ID");
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error("notify delivery store: expectedVersion is invalid");
      }
      if (
        input.disposition !== "confirmed-delivered" &&
        input.disposition !== "confirmed-no-effect"
      ) {
        throw new Error("notify delivery store: disposition is invalid");
      }
      boundedText(input.evidence, "evidence", 400);
      return reconcileTransaction.immediate(input);
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}

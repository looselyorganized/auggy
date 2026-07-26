import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../lib/sqlite";

export const NOTIFY_DELIVERY_APPLICATION_ID = 0x4e544659; // "NTFY"
export const NOTIFY_DELIVERY_SCHEMA_VERSION = 1;
const MAX_INCIDENTS = 100;
const MAX_OUTSTANDING_ATTEMPTS = 1_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_POLICY_WINDOW_MS = TERMINAL_RETENTION_MS;
const MAX_TERMINAL_ATTEMPTS = 10_000;
const MAX_MAINTENANCE_DELETE = 1_000;

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

const EXPECTED_SCHEMA = new Map(
  SCHEMA.map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error("notify delivery store: invalid schema declaration");
    return [match[1], canonicalSqliteSchemaSql(sql)] as const;
  }),
);

function hasExactSchema(objects: readonly SqliteSchemaObject[]): boolean {
  return (
    objects.length === EXPECTED_SCHEMA.size &&
    objects.every(
      (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
    )
  );
}

function validateStoredRows(db: Database): void {
  const invalidAttempt = db
    .query<{ attempt_id: string }, []>(
      `SELECT attempt_id FROM notify_delivery_attempts
        WHERE created_at < 0 OR updated_at < created_at OR incident_version < 1
           OR (state = 'outcome_unknown' AND (incident_id IS NULL OR reason_code IS NULL))
           OR (state <> 'outcome_unknown' AND (incident_id IS NOT NULL OR reason_code IS NOT NULL))
        LIMIT 1`,
    )
    .get();
  if (invalidAttempt) {
    throw new Error("notify delivery store: stored attempt state is inconsistent");
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
}

export function createNotifyDeliveryStore(
  options: NotifyDeliveryStoreOptions,
): NotifyDeliveryStore {
  const now = options.now ?? Date.now;
  const mintAttemptId = options.attemptId ?? randomUUID;
  const mintIncidentId = options.incidentId ?? randomUUID;
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
          return hasExactSchema(objects);
        },
        validate(_target, objects) {
          if (!hasExactSchema(objects)) {
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
  const insertAttempt = db.query(
    `INSERT INTO notify_delivery_attempts (
       attempt_id, operation_hash, thread_id, destination, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
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
    `DELETE FROM notify_delivery_attempts
      WHERE state IN ('sent', 'failed') AND updated_at < ?`,
  );
  const purgeRecoveries = db.query("DELETE FROM notify_delivery_recoveries WHERE resolved_at < ?");
  const deleteOldestTerminal = db.query(
    `DELETE FROM notify_delivery_attempts WHERE attempt_id IN (
       SELECT attempt_id FROM notify_delivery_attempts
        WHERE state IN ('sent', 'failed')
        ORDER BY updated_at ASC, attempt_id ASC LIMIT ?
     )`,
  );
  const countTerminal = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM notify_delivery_attempts
      WHERE state IN ('sent', 'failed')`,
  );
  const countOutstanding = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM notify_delivery_attempts
      WHERE state IN ('pending', 'outcome_unknown')`,
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

  function maintain(at: number, reserveCapacity: boolean): void {
    purgeQuota.run(at - TERMINAL_RETENTION_MS);
    purgeTerminal.run(at - TERMINAL_RETENTION_MS);
    purgeRecoveries.run(at - TERMINAL_RETENTION_MS);
    const terminalCount = countTerminal.get()?.count ?? 0;
    const target = MAX_TERMINAL_ATTEMPTS - (reserveCapacity ? 1 : 0);
    if (terminalCount > target) {
      deleteOldestTerminal.run(Math.min(MAX_MAINTENANCE_DELETE, terminalCount - target));
    }
    const remaining = countTerminal.get()?.count ?? 0;
    if (remaining > MAX_TERMINAL_ATTEMPTS - (reserveCapacity ? 1 : 0)) {
      throw new Error(
        "notify delivery store: terminal record capacity requires operator maintenance",
      );
    }
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
      const reservedAt = clock();
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

      if (input.policy.enforce) {
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
          const maximum = input.policy.destinationMaxPerHour;
          if (
            maximum !== undefined &&
            (countDestination.get(input.destination, hourStart)?.count ?? 0) >= maximum
          ) {
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
      }

      const attemptId = safeId(mintAttemptId(), "attempt ID");
      insertAttempt.run(
        attemptId,
        input.operationHash,
        input.threadId,
        input.destination,
        reservedAt,
        reservedAt,
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

  const settleTransaction = db.transaction(
    (
      attemptId: string,
      outcome: "sent" | "failed" | "outcome_unknown",
      reasonCode: string | undefined,
    ): NotifyDeliveryIncident | null => {
      const settledAt = clock();
      let incidentId: string | null = null;
      let nextVersion = 1;
      if (outcome === "outcome_unknown") {
        incidentId = safeId(mintIncidentId(), "incident ID");
        const current = selectAttempt.get(attemptId);
        if (!current) throw new Error("notify delivery store: unknown attempt");
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
      const resolvedAt = clock();
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

  return {
    reserve(input) {
      if (closed) throw new Error("notify delivery store: store is closed");
      digest(input.operationHash, "operationHash");
      digest(input.peerHash, "peerHash");
      digest(input.summaryHash, "summaryHash");
      boundedText(input.threadId, "threadId");
      boundedText(input.destination, "destination");
      nonNegativeInteger(input.policy.globalMaxPerHour, "globalMaxPerHour");
      nonNegativeInteger(input.policy.perPeerCooldownMs, "perPeerCooldownMs");
      nonNegativeInteger(input.policy.dedupWindowMs, "dedupWindowMs");
      if (
        input.policy.perPeerCooldownMs > MAX_POLICY_WINDOW_MS ||
        input.policy.dedupWindowMs > MAX_POLICY_WINDOW_MS
      ) {
        throw new Error("notify delivery store: quota and dedup windows cannot exceed 30 days");
      }
      if (input.policy.destinationMaxPerHour !== undefined) {
        nonNegativeInteger(input.policy.destinationMaxPerHour, "destinationMaxPerHour");
      }
      if (input.policy.destinationCooldownMs !== undefined) {
        nonNegativeInteger(input.policy.destinationCooldownMs, "destinationCooldownMs");
        if (input.policy.destinationCooldownMs > MAX_POLICY_WINDOW_MS) {
          throw new Error("notify delivery store: destination cooldown cannot exceed 30 days");
        }
      }
      return reserveTransaction.immediate(input);
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
              detectedAt,
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

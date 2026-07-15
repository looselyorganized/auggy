/**
 * Durable inbox ledger for AgentMail inbound delivery.
 *
 * Live delivery and REST catch-up both write here before any model turn is
 * admitted. A message is claimed with a renewable lease, then explicitly
 * completed, retried, or discarded. Message identity is scoped to an inbox;
 * provider event IDs are an additional replay guard, never the primary key.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  normalizeAgentMailMessage,
  receivedEventTypeForLabels,
  type AgentMailInboundEnvelope,
  type AgentMailInboundMessage,
  type AgentMailInboundSource,
  type AgentMailReceivedEventType,
} from "./provider";

const SCHEMA_VERSION = 1;
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
const DEFAULT_CHECKPOINT_OVERLAP_MS = 60_000;
const MAX_LEASE_MS = 60 * 60_000;
const MAX_ANNOTATION_CHARS = 500;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_messages (
    inbox_id          TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    event_type        TEXT NOT NULL CHECK (event_type IN (
      'message.received',
      'message.received.spam',
      'message.received.blocked',
      'message.received.unauthenticated'
    )),
    provider_event_id TEXT UNIQUE,
    first_source      TEXT NOT NULL CHECK (first_source IN ('rest', 'websocket', 'webhook')),
    last_source       TEXT NOT NULL CHECK (last_source IN ('rest', 'websocket', 'webhook')),
    message_timestamp TEXT NOT NULL,
    message_ts_ms     INTEGER NOT NULL,
    payload_json      TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'processed', 'discarded')),
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    available_at      INTEGER NOT NULL,
    lease_owner       TEXT,
    lease_token       TEXT,
    lease_expires_at  INTEGER,
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    processed_at      INTEGER,
    last_error        TEXT,
    discard_reason    TEXT,
    PRIMARY KEY (inbox_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_inbound_claim
     ON agentmail_inbound_messages(state, available_at, lease_expires_at, message_ts_ms, message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_inbound_thread
     ON agentmail_inbound_messages(inbox_id, thread_id, message_ts_ms)`,
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_checkpoints (
    inbox_id        TEXT PRIMARY KEY,
    after_timestamp TEXT NOT NULL,
    after_ts_ms     INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
];

export type AgentMailLedgerState = "pending" | "processing" | "processed" | "discarded";

export interface AgentMailLedgerRecord {
  envelope: AgentMailInboundEnvelope;
  state: AgentMailLedgerState;
  attemptCount: number;
  availableAt: number;
  leaseOwner: string | undefined;
  leaseExpiresAt: number | undefined;
  firstSeenAt: number;
  lastSeenAt: number;
  processedAt: number | undefined;
  lastError: string | undefined;
  discardReason: string | undefined;
}

export interface AgentMailLedgerClaim {
  envelope: AgentMailInboundEnvelope;
  attemptCount: number;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: number;
}

export interface AgentMailLedgerEnqueueResult {
  status: "enqueued" | "duplicate";
  state: AgentMailLedgerState;
}

export interface AgentMailCatchUpBatchResult {
  enqueued: number;
  duplicates: number;
  checkpoint: string | undefined;
}

export interface AgentMailCatchUpWatermark {
  inboxId: string;
  /** Newest metadata timestamp fully scanned in this provider page. */
  through: string;
}

export interface AgentMailLedgerCounts {
  pending: number;
  processing: number;
  processed: number;
  discarded: number;
}

export interface AgentMailInboundLedger {
  enqueue(envelope: AgentMailInboundEnvelope): AgentMailLedgerEnqueueResult;
  /** Atomically persist a REST page's received mail and its fully scanned watermark. */
  recordCatchUpBatch(
    envelopes: readonly AgentMailInboundEnvelope[],
    watermark?: AgentMailCatchUpWatermark,
  ): AgentMailCatchUpBatchResult;
  /** Returns an overlapped cursor so timestamp ties and page-boundary crashes replay safely. */
  catchUpAfter(inboxId: string): string;
  checkpoint(inboxId: string): string | undefined;
  claimNext(input: { workerId: string; leaseMs: number }): AgentMailLedgerClaim | null;
  renew(claim: AgentMailLedgerClaim, leaseMs: number): boolean;
  complete(claim: AgentMailLedgerClaim): boolean;
  retry(claim: AgentMailLedgerClaim, input: { error: string; availableAt?: number }): boolean;
  discard(claim: AgentMailLedgerClaim, reason: string): boolean;
  get(inboxId: string, messageId: string): AgentMailLedgerRecord | null;
  counts(): AgentMailLedgerCounts;
  close(): void;
}

export interface AgentMailInboundLedgerOptions {
  dbPath: string;
  initialLookbackMs?: number;
  checkpointOverlapMs?: number;
  /** Test-only clock seam. */
  now?: () => number;
  /** Test-only lease-token seam. */
  leaseToken?: () => string;
}

export class AgentMailLedgerConflictError extends Error {
  readonly code = "AGENTMAIL_LEDGER_CONFLICT";

  constructor(detail: string) {
    super(`agentMail ledger conflict (${detail})`);
    this.name = "AgentMailLedgerConflictError";
  }
}

interface LedgerRow {
  inbox_id: string;
  message_id: string;
  thread_id: string;
  event_type: AgentMailReceivedEventType;
  provider_event_id: string | null;
  first_source: AgentMailInboundSource;
  last_source: AgentMailInboundSource;
  message_timestamp: string;
  message_ts_ms: number;
  payload_json: string;
  state: AgentMailLedgerState;
  attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  processed_at: number | null;
  last_error: string | null;
  discard_reason: string | null;
}

interface PreparedEnvelope {
  envelope: AgentMailInboundEnvelope;
  payloadJson: string;
  timestampMs: number;
}

function validateDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agentMail ledger: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function replaceControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    output += codePoint <= 31 || codePoint === 127 ? " " : character;
  }
  return output;
}

function requireText(value: string, label: string, max = 256): string {
  const normalized = replaceControlCharacters(value).trim();
  if (!normalized) throw new Error(`agentMail ledger: ${label} is required`);
  if (normalized.length > max) throw new Error(`agentMail ledger: ${label} is too long`);
  return normalized;
}

function annotation(value: string, label: string): string {
  const normalized = replaceControlCharacters(value).trim();
  if (!normalized) throw new Error(`agentMail ledger: ${label} is required`);
  return normalized.slice(0, MAX_ANNOTATION_CHARS);
}

function optionalNumber(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

function optionalString(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function prepareDatabasePath(configuredPath: string): { path: string; persistent: boolean } {
  if (configuredPath === ":memory:") return { path: configuredPath, persistent: false };
  const path = resolve(configuredPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error("agentMail ledger: dbPath must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new Error("agentMail ledger: dbPath must point to a regular file");
    }
  }
  return { path, persistent: true };
}

function secureSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

export function createAgentMailInboundLedger(
  options: AgentMailInboundLedgerOptions,
): AgentMailInboundLedger {
  const initialLookbackMs = validateDuration(
    options.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS,
    "initialLookbackMs",
  );
  const checkpointOverlapMs = validateDuration(
    options.checkpointOverlapMs ?? DEFAULT_CHECKPOINT_OVERLAP_MS,
    "checkpointOverlapMs",
  );
  const now = options.now ?? Date.now;
  const nextLeaseToken = options.leaseToken ?? randomUUID;
  const databasePath = prepareDatabasePath(options.dbPath);
  const db = new Database(databasePath.path, { create: true });
  let closed = false;

  try {
    if (databasePath.persistent) secureSqliteFiles(databasePath.path);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = FULL");
    db.run(SCHEMA_STATEMENTS[0]!);

    const versionRow = db
      .prepare<{ value: string }, [string]>(
        `SELECT value FROM agentmail_inbound_meta WHERE key = ?`,
      )
      .get("schema_version");
    if (versionRow) {
      const version = Number(versionRow.value);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error("agentMail ledger: database schema version is invalid");
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `agentMail ledger: database schema ${versionRow.value} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
    }
    for (const statement of SCHEMA_STATEMENTS.slice(1)) db.run(statement);
    db.prepare(
      `INSERT INTO agentmail_inbound_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(SCHEMA_VERSION));
    if (databasePath.persistent) secureSqliteFiles(databasePath.path);
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }

  const selectMessage = db.prepare<LedgerRow, [string, string]>(
    `SELECT * FROM agentmail_inbound_messages WHERE inbox_id = ? AND message_id = ?`,
  );
  const selectProviderEvent = db.prepare<{ inbox_id: string; message_id: string }, [string]>(
    `SELECT inbox_id, message_id FROM agentmail_inbound_messages WHERE provider_event_id = ?`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO agentmail_inbound_messages (
       inbox_id, message_id, thread_id, event_type, provider_event_id,
       first_source, last_source, message_timestamp, message_ts_ms, payload_json,
       state, attempt_count, available_at, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );
  const updateDuplicate = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET provider_event_id = COALESCE(provider_event_id, ?),
           last_source = ?,
           payload_json = CASE
             WHEN state IN ('pending', 'processing') THEN ? ELSE payload_json END,
           last_seen_at = ?
     WHERE inbox_id = ? AND message_id = ?`,
  );
  const upsertCheckpoint = db.prepare(
    `INSERT INTO agentmail_inbound_checkpoints
       (inbox_id, after_timestamp, after_ts_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(inbox_id) DO UPDATE SET
       after_timestamp = CASE
         WHEN excluded.after_ts_ms > after_ts_ms THEN excluded.after_timestamp
         ELSE after_timestamp END,
       after_ts_ms = MAX(after_ts_ms, excluded.after_ts_ms),
       updated_at = excluded.updated_at`,
  );
  const selectCheckpoint = db.prepare<{ after_timestamp: string; after_ts_ms: number }, [string]>(
    `SELECT after_timestamp, after_ts_ms FROM agentmail_inbound_checkpoints WHERE inbox_id = ?`,
  );
  const claimMessage = db.prepare<LedgerRow, [string, string, number, number, number, number]>(
    `UPDATE agentmail_inbound_messages
       SET state = 'processing',
           attempt_count = attempt_count + 1,
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           last_error = CASE WHEN state = 'processing' THEN 'processing lease expired' ELSE last_error END,
           last_seen_at = ?
     WHERE rowid = (
       SELECT rowid FROM agentmail_inbound_messages
       WHERE (state = 'pending' AND available_at <= ?)
          OR (state = 'processing' AND lease_expires_at <= ?)
       ORDER BY message_ts_ms ASC, message_id ASC
       LIMIT 1
     )
     RETURNING *`,
  );
  const renewClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET lease_expires_at = ?, last_seen_at = ?
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
  );
  const completeClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'processed', processed_at = ?, last_seen_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error = NULL, discard_reason = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
  );
  const retryClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'pending', available_at = ?, last_seen_at = ?, last_error = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
  );
  const discardClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'discarded', processed_at = ?, last_seen_at = ?, discard_reason = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
  );
  const countStates = db.prepare<{ state: AgentMailLedgerState; count: number }, []>(
    `SELECT state, COUNT(*) AS count FROM agentmail_inbound_messages GROUP BY state`,
  );

  function assertOpen(): void {
    if (closed) throw new Error("agentMail ledger: store is closed");
  }

  function clock(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("agentMail ledger: clock returned an invalid timestamp");
    }
    return value;
  }

  function secureAfterWrite(): void {
    if (databasePath.persistent) secureSqliteFiles(databasePath.path);
  }

  function immediate<T>(fn: () => T): T {
    db.run("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.run("COMMIT");
      secureAfterWrite();
      return result;
    } catch (error) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite already rolled back.
      }
      throw error;
    }
  }

  function prepareEnvelope(envelope: AgentMailInboundEnvelope): PreparedEnvelope {
    if (!(["rest", "websocket", "webhook"] as const).includes(envelope.source)) {
      throw new Error("agentMail ledger: invalid inbound source");
    }
    const message = normalizeAgentMailMessage(envelope.message, envelope.message.inboxId);
    const inferredType = receivedEventTypeForLabels(message.labels);
    if (envelope.eventType !== inferredType) {
      throw new AgentMailLedgerConflictError("event classification does not match message labels");
    }
    if (envelope.source === "rest" && envelope.providerEventId !== undefined) {
      throw new Error("agentMail ledger: REST catch-up must not declare a provider event ID");
    }
    if (envelope.source !== "rest") {
      requireText(envelope.providerEventId ?? "", "providerEventId");
    }
    const timestampMs = Date.parse(message.timestamp);
    return {
      envelope: { ...envelope, message },
      payloadJson: JSON.stringify(message),
      timestampMs,
    };
  }

  function rowMessage(row: LedgerRow): AgentMailInboundMessage {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      throw new AgentMailLedgerConflictError("stored message payload is not valid JSON");
    }
    const message = normalizeAgentMailMessage(payload, row.inbox_id);
    if (
      message.messageId !== row.message_id ||
      message.threadId !== row.thread_id ||
      Date.parse(message.timestamp) !== row.message_ts_ms
    ) {
      throw new AgentMailLedgerConflictError(
        "stored message identity does not match its ledger row",
      );
    }
    return message;
  }

  function rowEnvelope(row: LedgerRow): AgentMailInboundEnvelope {
    return {
      source: row.last_source,
      eventType: row.event_type,
      providerEventId:
        row.last_source === "rest" ? undefined : optionalString(row.provider_event_id),
      message: rowMessage(row),
    };
  }

  function rowRecord(row: LedgerRow): AgentMailLedgerRecord {
    return {
      envelope: rowEnvelope(row),
      state: row.state,
      attemptCount: row.attempt_count,
      availableAt: row.available_at,
      leaseOwner: optionalString(row.lease_owner),
      leaseExpiresAt: optionalNumber(row.lease_expires_at),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      processedAt: optionalNumber(row.processed_at),
      lastError: optionalString(row.last_error),
      discardReason: optionalString(row.discard_reason),
    };
  }

  function enqueuePrepared(
    prepared: PreparedEnvelope,
    seenAt: number,
  ): AgentMailLedgerEnqueueResult {
    const { envelope, payloadJson, timestampMs } = prepared;
    const { message } = envelope;

    if (envelope.providerEventId) {
      const eventOwner = selectProviderEvent.get(envelope.providerEventId);
      if (
        eventOwner &&
        (eventOwner.inbox_id !== message.inboxId || eventOwner.message_id !== message.messageId)
      ) {
        throw new AgentMailLedgerConflictError("provider event ID was reused for another message");
      }
    }

    const existing = selectMessage.get(message.inboxId, message.messageId);
    if (!existing) {
      insertMessage.run(
        message.inboxId,
        message.messageId,
        message.threadId,
        envelope.eventType,
        envelope.providerEventId ?? null,
        envelope.source,
        envelope.source,
        message.timestamp,
        timestampMs,
        payloadJson,
        seenAt,
        seenAt,
        seenAt,
      );
      return { status: "enqueued", state: "pending" };
    }

    const existingMessage = rowMessage(existing);
    if (
      existing.thread_id !== message.threadId ||
      existing.message_ts_ms !== timestampMs ||
      existingMessage.from !== message.from ||
      existing.event_type !== envelope.eventType
    ) {
      throw new AgentMailLedgerConflictError(
        "message ID was reused with incompatible identity data",
      );
    }
    if (
      existing.provider_event_id &&
      envelope.providerEventId &&
      existing.provider_event_id !== envelope.providerEventId
    ) {
      throw new AgentMailLedgerConflictError(
        "message was delivered with conflicting provider event IDs",
      );
    }

    updateDuplicate.run(
      envelope.providerEventId ?? null,
      envelope.source,
      payloadJson,
      seenAt,
      message.inboxId,
      message.messageId,
    );
    return { status: "duplicate", state: existing.state };
  }

  function validateClaim(claim: AgentMailLedgerClaim): void {
    requireText(claim.envelope.message.inboxId, "claim inboxId");
    requireText(claim.envelope.message.messageId, "claim messageId");
    requireText(claim.leaseToken, "claim leaseToken");
  }

  function validateLeaseMs(leaseMs: number): number {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
      throw new Error(`agentMail ledger: leaseMs must be between 1 and ${MAX_LEASE_MS}`);
    }
    return leaseMs;
  }

  return {
    enqueue(envelope) {
      assertOpen();
      const prepared = prepareEnvelope(envelope);
      const seenAt = clock();
      return immediate(() => enqueuePrepared(prepared, seenAt));
    },

    recordCatchUpBatch(envelopes, watermark) {
      assertOpen();
      if (envelopes.length === 0 && !watermark) {
        return { enqueued: 0, duplicates: 0, checkpoint: undefined };
      }
      const prepared = envelopes.map((envelope) => {
        if (envelope.source !== "rest") {
          throw new Error("agentMail ledger: catch-up batches may only contain REST envelopes");
        }
        return prepareEnvelope(envelope);
      });
      const inboxId = watermark?.inboxId ?? prepared[0]!.envelope.message.inboxId;
      requireText(inboxId, "catch-up watermark inboxId");
      if (prepared.some((item) => item.envelope.message.inboxId !== inboxId)) {
        throw new Error("agentMail ledger: catch-up batch spans multiple inboxes");
      }
      const watermarkMs = watermark ? Date.parse(watermark.through) : undefined;
      if (watermark && !Number.isFinite(watermarkMs)) {
        throw new Error("agentMail ledger: catch-up watermark must be an ISO-8601 timestamp");
      }
      const newestMessage = prepared.reduce<PreparedEnvelope | undefined>(
        (newest, item) => (!newest || item.timestampMs > newest.timestampMs ? item : newest),
        undefined,
      );
      if (
        watermarkMs !== undefined &&
        newestMessage !== undefined &&
        watermarkMs < newestMessage.timestampMs
      ) {
        throw new Error("agentMail ledger: catch-up watermark precedes a persisted message");
      }
      const seenAt = clock();
      return immediate(() => {
        let enqueued = 0;
        let duplicates = 0;
        for (const item of prepared) {
          const result = enqueuePrepared(item, seenAt);
          if (result.status === "enqueued") enqueued++;
          else duplicates++;
        }
        const checkpointTimestamp = watermark?.through ?? newestMessage!.envelope.message.timestamp;
        const checkpointMs = watermarkMs ?? newestMessage!.timestampMs;
        upsertCheckpoint.run(inboxId, checkpointTimestamp, checkpointMs, seenAt);
        const checkpointRow = selectCheckpoint.get(inboxId);
        return {
          enqueued,
          duplicates,
          checkpoint: checkpointRow?.after_timestamp,
        };
      });
    },

    catchUpAfter(inboxId) {
      assertOpen();
      requireText(inboxId, "inboxId");
      const checkpointRow = selectCheckpoint.get(inboxId);
      const base = checkpointRow?.after_ts_ms ?? clock() - initialLookbackMs;
      return new Date(Math.max(0, base - (checkpointRow ? checkpointOverlapMs : 0))).toISOString();
    },

    checkpoint(inboxId) {
      assertOpen();
      requireText(inboxId, "inboxId");
      return selectCheckpoint.get(inboxId)?.after_timestamp;
    },

    claimNext(input) {
      assertOpen();
      const workerId = requireText(input.workerId, "workerId", 128);
      const leaseMs = validateLeaseMs(input.leaseMs);
      const claimedAt = clock();
      const token = requireText(nextLeaseToken(), "lease token", 256);
      const expiresAt = claimedAt + leaseMs;
      const row = claimMessage.get(workerId, token, expiresAt, claimedAt, claimedAt, claimedAt);
      if (!row) return null;
      secureAfterWrite();
      return {
        envelope: rowEnvelope(row),
        attemptCount: row.attempt_count,
        workerId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
      };
    },

    renew(claim, leaseMsInput) {
      assertOpen();
      validateClaim(claim);
      const leaseMs = validateLeaseMs(leaseMsInput);
      const renewedAt = clock();
      const result = renewClaim.run(
        renewedAt + leaseMs,
        renewedAt,
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
        renewedAt,
      );
      secureAfterWrite();
      return result.changes === 1;
    },

    complete(claim) {
      assertOpen();
      validateClaim(claim);
      const completedAt = clock();
      const result = completeClaim.run(
        completedAt,
        completedAt,
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
        completedAt,
      );
      secureAfterWrite();
      return result.changes === 1;
    },

    retry(claim, input) {
      assertOpen();
      validateClaim(claim);
      const retriedAt = clock();
      const availableAt = Math.max(retriedAt, input.availableAt ?? retriedAt);
      if (!Number.isSafeInteger(availableAt)) {
        throw new Error("agentMail ledger: retry availableAt must be a safe integer");
      }
      const result = retryClaim.run(
        availableAt,
        retriedAt,
        annotation(input.error, "retry error"),
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
        retriedAt,
      );
      secureAfterWrite();
      return result.changes === 1;
    },

    discard(claim, reason) {
      assertOpen();
      validateClaim(claim);
      const discardedAt = clock();
      const result = discardClaim.run(
        discardedAt,
        discardedAt,
        annotation(reason, "discard reason"),
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
        discardedAt,
      );
      secureAfterWrite();
      return result.changes === 1;
    },

    get(inboxId, messageId) {
      assertOpen();
      requireText(inboxId, "inboxId");
      requireText(messageId, "messageId");
      const row = selectMessage.get(inboxId, messageId);
      return row ? rowRecord(row) : null;
    },

    counts() {
      assertOpen();
      const counts: AgentMailLedgerCounts = {
        pending: 0,
        processing: 0,
        processed: 0,
        discarded: 0,
      };
      for (const row of countStates.all()) counts[row.state] = row.count;
      return counts;
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
      if (databasePath.persistent) secureSqliteFiles(databasePath.path);
    },
  };
}

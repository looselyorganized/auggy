/**
 * Durable inbox ledger for AgentMail inbound delivery.
 *
 * Live delivery and REST catch-up both write here before any model turn is
 * admitted. A message is claimed with a renewable lease, then explicitly
 * completed, retried, or discarded. Message identity is scoped to an inbox;
 * provider event IDs are an additional replay guard, never the primary key.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openHardenedSqlite } from "../../lib/sqlite";
import { canonicalizeEmail, isWellFormedEmail } from "../visitorAuth/email-validation";
import {
  normalizeAgentMailMessage,
  receivedEventTypeForLabels,
  type AgentMailInboundEnvelope,
  type AgentMailInboundMessage,
  type AgentMailInboundSource,
  type AgentMailReceivedEventType,
} from "./provider";
import {
  createAgentMailCreatorAttentionStore,
  type AgentMailCreatorAttentionStore,
  validateStoredCreatorAttentionRows,
} from "./creator-attention";
import {
  AGENTMAIL_CREATOR_DIGEST_SCHEMA,
  createAgentMailCreatorDigestStore,
  type AgentMailCreatorDigestStore,
  validateStoredCreatorDigestRows,
} from "./creator-digest";
import { validateAgentMailInboundRateLimit } from "./inbound-policy";

export const AGENTMAIL_LEDGER_APPLICATION_ID = 0x414d494c; // "AMIL"
export const AGENTMAIL_LEDGER_SCHEMA_VERSION = 5;
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
const DEFAULT_CHECKPOINT_OVERLAP_MS = 60_000;
const INBOUND_QUOTA_WINDOW_MS = 60 * 60_000;
export const AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX = 1_000;
const POLICY_REJECTION_FILTER_BYTES = 256 * 1024;
const POLICY_REJECTION_FILTER_HASHES = 4;
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
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_quarantines (
    inbox_id          TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    incident_id       TEXT NOT NULL UNIQUE,
    incident_version  INTEGER NOT NULL DEFAULT 1,
    reason_code       TEXT NOT NULL,
    quarantined_at    INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, message_id),
    FOREIGN KEY (inbox_id, message_id)
      REFERENCES agentmail_inbound_messages(inbox_id, message_id)
      ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_inbound_quarantine_time
     ON agentmail_inbound_quarantines(quarantined_at, incident_id)`,
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_recoveries (
    incident_id       TEXT PRIMARY KEY,
    inbox_id          TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    incident_version  INTEGER NOT NULL,
    disposition       TEXT NOT NULL CHECK (disposition IN ('confirmed-handled', 'confirmed-no-effect')),
    evidence_sha256   TEXT NOT NULL,
    resolved_at       INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_creator_attention (
    inbox_id          TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN (
      'open', 'pending_review', 'sent', 'rejected', 'failed', 'ambiguous', 'dismissed'
    )),
    record_version     INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1),
    review_id          TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    terminal_at        INTEGER,
    PRIMARY KEY (inbox_id, message_id),
    FOREIGN KEY (inbox_id, message_id)
      REFERENCES agentmail_inbound_messages(inbox_id, message_id)
      ON DELETE CASCADE,
    CHECK (state != 'pending_review' OR review_id IS NOT NULL),
    CHECK (
      (state IN ('sent', 'rejected', 'failed', 'dismissed') AND terminal_at IS NOT NULL)
      OR
      (state IN ('open', 'pending_review', 'ambiguous') AND terminal_at IS NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_creator_attention_queue
     ON agentmail_creator_attention(state, updated_at DESC, inbox_id, message_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_creator_attention_review
     ON agentmail_creator_attention(review_id) WHERE review_id IS NOT NULL`,
  ...AGENTMAIL_CREATOR_DIGEST_SCHEMA,
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_quota_reservations (
    inbox_id          TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    sender_key_sha256 TEXT NOT NULL CHECK (
      length(sender_key_sha256) = 64
      AND sender_key_sha256 = lower(sender_key_sha256)
      AND sender_key_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    admitted_at       INTEGER NOT NULL CHECK (admitted_at >= 0),
    PRIMARY KEY (inbox_id, message_id),
    FOREIGN KEY (inbox_id, message_id)
      REFERENCES agentmail_inbound_messages(inbox_id, message_id)
      ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_inbound_quota_window
     ON agentmail_inbound_quota_reservations(inbox_id, admitted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_inbound_quota_sender_window
     ON agentmail_inbound_quota_reservations(inbox_id, sender_key_sha256, admitted_at)`,
  `CREATE TABLE IF NOT EXISTS agentmail_inbound_quota_rejections (
    inbox_id              TEXT PRIMARY KEY,
    global_rejections     INTEGER NOT NULL DEFAULT 0 CHECK (global_rejections >= 0),
    per_sender_rejections INTEGER NOT NULL DEFAULT 0 CHECK (per_sender_rejections >= 0),
    last_rejected_at      INTEGER CHECK (last_rejected_at IS NULL OR last_rejected_at >= 0),
    rejection_filter      BLOB NOT NULL CHECK (
      typeof(rejection_filter) = 'blob' AND length(rejection_filter) = 262144
    )
  )`,
];

const EXPECTED_SCHEMA: ReadonlyMap<string, string> = new Map([
  ["agentmail_inbound_meta", SCHEMA_STATEMENTS[0]!],
  ["agentmail_inbound_messages", SCHEMA_STATEMENTS[1]!],
  ["idx_agentmail_inbound_claim", SCHEMA_STATEMENTS[2]!],
  ["idx_agentmail_inbound_thread", SCHEMA_STATEMENTS[3]!],
  ["agentmail_inbound_checkpoints", SCHEMA_STATEMENTS[4]!],
  ["agentmail_inbound_quarantines", SCHEMA_STATEMENTS[5]!],
  ["idx_agentmail_inbound_quarantine_time", SCHEMA_STATEMENTS[6]!],
  ["agentmail_inbound_recoveries", SCHEMA_STATEMENTS[7]!],
  ["agentmail_creator_attention", SCHEMA_STATEMENTS[8]!],
  ["idx_agentmail_creator_attention_queue", SCHEMA_STATEMENTS[9]!],
  ["idx_agentmail_creator_attention_review", SCHEMA_STATEMENTS[10]!],
  ["agentmail_creator_digest_batches", SCHEMA_STATEMENTS[11]!],
  ["agentmail_creator_digest_items", SCHEMA_STATEMENTS[12]!],
  ["agentmail_creator_digest_watermarks", SCHEMA_STATEMENTS[13]!],
  ["agentmail_creator_digest_retirement_ranges", SCHEMA_STATEMENTS[14]!],
  ["idx_agentmail_creator_digest_item_source", SCHEMA_STATEMENTS[15]!],
  ["idx_agentmail_creator_digest_watermark_time", SCHEMA_STATEMENTS[16]!],
  ["idx_agentmail_creator_digest_retirement_end", SCHEMA_STATEMENTS[17]!],
  ["trg_agentmail_creator_digest_batches_immutable", SCHEMA_STATEMENTS[18]!],
  ["trg_agentmail_creator_digest_items_immutable", SCHEMA_STATEMENTS[19]!],
  ["trg_agentmail_creator_digest_watermarks_immutable", SCHEMA_STATEMENTS[20]!],
  ["trg_agentmail_creator_digest_retirement_ranges_immutable", SCHEMA_STATEMENTS[21]!],
  ["agentmail_inbound_quota_reservations", SCHEMA_STATEMENTS[22]!],
  ["idx_agentmail_inbound_quota_window", SCHEMA_STATEMENTS[23]!],
  ["idx_agentmail_inbound_quota_sender_window", SCHEMA_STATEMENTS[24]!],
  ["agentmail_inbound_quota_rejections", SCHEMA_STATEMENTS[25]!],
] as const);

const V4_EXPECTED_SCHEMA: ReadonlyMap<string, string> = new Map(
  [...EXPECTED_SCHEMA].filter(
    ([name]) =>
      name !== "agentmail_inbound_quota_reservations" &&
      name !== "idx_agentmail_inbound_quota_window" &&
      name !== "idx_agentmail_inbound_quota_sender_window" &&
      name !== "agentmail_inbound_quota_rejections",
  ),
);

const V1_EXPECTED_SCHEMA: ReadonlyMap<string, string> = new Map([
  ["agentmail_inbound_meta", SCHEMA_STATEMENTS[0]!],
  ["agentmail_inbound_messages", SCHEMA_STATEMENTS[1]!],
  ["idx_agentmail_inbound_claim", SCHEMA_STATEMENTS[2]!],
  ["idx_agentmail_inbound_thread", SCHEMA_STATEMENTS[3]!],
  ["agentmail_inbound_checkpoints", SCHEMA_STATEMENTS[4]!],
] as const);

const V2_EXPECTED_SCHEMA: ReadonlyMap<string, string> = new Map([
  ["agentmail_inbound_meta", SCHEMA_STATEMENTS[0]!],
  ["agentmail_inbound_messages", SCHEMA_STATEMENTS[1]!],
  ["idx_agentmail_inbound_claim", SCHEMA_STATEMENTS[2]!],
  ["idx_agentmail_inbound_thread", SCHEMA_STATEMENTS[3]!],
  ["agentmail_inbound_checkpoints", SCHEMA_STATEMENTS[4]!],
  ["agentmail_inbound_quarantines", SCHEMA_STATEMENTS[5]!],
  ["idx_agentmail_inbound_quarantine_time", SCHEMA_STATEMENTS[6]!],
  ["agentmail_inbound_recoveries", SCHEMA_STATEMENTS[7]!],
] as const);

const V3_EXPECTED_SCHEMA: ReadonlyMap<string, string> = new Map([
  ["agentmail_inbound_meta", SCHEMA_STATEMENTS[0]!],
  ["agentmail_inbound_messages", SCHEMA_STATEMENTS[1]!],
  ["idx_agentmail_inbound_claim", SCHEMA_STATEMENTS[2]!],
  ["idx_agentmail_inbound_thread", SCHEMA_STATEMENTS[3]!],
  ["agentmail_inbound_checkpoints", SCHEMA_STATEMENTS[4]!],
  ["agentmail_inbound_quarantines", SCHEMA_STATEMENTS[5]!],
  ["idx_agentmail_inbound_quarantine_time", SCHEMA_STATEMENTS[6]!],
  ["agentmail_inbound_recoveries", SCHEMA_STATEMENTS[7]!],
  ["agentmail_creator_attention", SCHEMA_STATEMENTS[8]!],
  ["idx_agentmail_creator_attention_queue", SCHEMA_STATEMENTS[9]!],
  ["idx_agentmail_creator_attention_review", SCHEMA_STATEMENTS[10]!],
] as const);

function canonicalSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function pragmaInteger(db: Database, name: "application_id" | "user_version"): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  const value = row?.[name];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`agentMail ledger: invalid SQLite ${name}`);
  }
  return value as number;
}

function schemaObjects(db: Database): Array<{ name: string; sql: string; type: string }> {
  return db
    .query<{ name: string; sql: string; type: string }, []>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

function validateExactSchema(
  db: Database,
  expectedSchema: ReadonlyMap<string, string> = EXPECTED_SCHEMA,
  expectedVersion = AGENTMAIL_LEDGER_SCHEMA_VERSION,
): void {
  const objects = schemaObjects(db);
  if (objects.length !== expectedSchema.size) {
    throw new Error("agentMail ledger: database schema contains missing or unexpected objects");
  }
  for (const object of objects) {
    const expected = expectedSchema.get(object.name);
    if (!expected || canonicalSchemaSql(object.sql) !== canonicalSchemaSql(expected)) {
      throw new Error(`agentMail ledger: database schema object is incompatible: ${object.name}`);
    }
  }

  const versions = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM agentmail_inbound_meta ORDER BY key",
    )
    .all();
  if (
    versions.length !== 1 ||
    versions[0]?.key !== "schema_version" ||
    versions[0].value !== String(expectedVersion)
  ) {
    throw new Error("agentMail ledger: database schema version metadata is incompatible");
  }
}

function safeStoredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`agentMail ledger: stored ${label} is invalid`);
  }
  return value as number;
}

function storedText(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`agentMail ledger: stored ${label} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      throw new Error(`agentMail ledger: stored ${label} contains control characters`);
    }
  }
  return value;
}

function validateStoredRows(db: Database): void {
  const messages = db
    .query<Record<string, unknown>, []>("SELECT * FROM agentmail_inbound_messages")
    .all();
  for (const row of messages) {
    const inboxId = storedText(row.inbox_id, "inbox_id", 256);
    const messageId = storedText(row.message_id, "message_id", 256);
    const threadId = storedText(row.thread_id, "thread_id", 256);
    const eventType = storedText(row.event_type, "event_type", 64);
    const firstSource = storedText(row.first_source, "first_source", 16);
    const lastSource = storedText(row.last_source, "last_source", 16);
    const timestamp = storedText(row.message_timestamp, "message_timestamp", 128);
    const messageTimestamp = safeStoredInteger(row.message_ts_ms, "message_ts_ms");
    const attemptCount = safeStoredInteger(row.attempt_count, "attempt_count");
    safeStoredInteger(row.available_at, "available_at");
    const firstSeenAt = safeStoredInteger(row.first_seen_at, "first_seen_at");
    const lastSeenAt = safeStoredInteger(row.last_seen_at, "last_seen_at");
    if (lastSeenAt < firstSeenAt) {
      throw new Error("agentMail ledger: stored message timestamps are inconsistent");
    }
    if (row.provider_event_id !== null) storedText(row.provider_event_id, "provider_event_id", 256);
    if ((firstSource !== "rest" || lastSource !== "rest") && row.provider_event_id === null) {
      throw new Error("agentMail ledger: stored live source is missing provider_event_id");
    }
    if (row.last_error !== null) storedText(row.last_error, "last_error", MAX_ANNOTATION_CHARS);
    if (row.discard_reason !== null) {
      storedText(row.discard_reason, "discard_reason", MAX_ANNOTATION_CHARS);
    }
    if (row.lease_owner !== null) storedText(row.lease_owner, "lease_owner", 128);
    if (row.lease_token !== null) storedText(row.lease_token, "lease_token", 256);

    let message: AgentMailInboundMessage;
    try {
      message = normalizeAgentMailMessage(JSON.parse(String(row.payload_json)), inboxId);
    } catch (error) {
      throw new Error("agentMail ledger: stored payload is invalid", { cause: error });
    }
    if (
      message.inboxId !== inboxId ||
      message.messageId !== messageId ||
      message.threadId !== threadId ||
      message.timestamp !== timestamp ||
      Date.parse(message.timestamp) !== messageTimestamp ||
      receivedEventTypeForLabels(message.labels) !== eventType
    ) {
      throw new Error("agentMail ledger: stored payload identity is inconsistent");
    }

    const state = row.state;
    const hasLease =
      row.lease_owner !== null || row.lease_token !== null || row.lease_expires_at !== null;
    const processedAt =
      row.processed_at === null ? undefined : safeStoredInteger(row.processed_at, "processed_at");
    if (processedAt !== undefined && (processedAt < firstSeenAt || processedAt > lastSeenAt)) {
      throw new Error("agentMail ledger: stored processed_at is inconsistent");
    }
    if (state === "pending") {
      if (hasLease || processedAt !== undefined || row.discard_reason !== null) {
        throw new Error("agentMail ledger: stored pending state is inconsistent");
      }
    } else if (state === "processing") {
      if (
        attemptCount < 1 ||
        typeof row.lease_owner !== "string" ||
        typeof row.lease_token !== "string" ||
        !row.lease_owner ||
        !row.lease_token ||
        row.lease_expires_at === null ||
        processedAt !== undefined ||
        row.discard_reason !== null
      ) {
        throw new Error("agentMail ledger: stored processing state is inconsistent");
      }
      safeStoredInteger(row.lease_expires_at, "lease_expires_at");
    } else if (state === "processed") {
      if (
        hasLease ||
        attemptCount < 1 ||
        processedAt === undefined ||
        row.last_error !== null ||
        row.discard_reason !== null
      ) {
        throw new Error("agentMail ledger: stored processed state is inconsistent");
      }
    } else if (state === "discarded") {
      if (
        hasLease ||
        attemptCount < 1 ||
        processedAt === undefined ||
        row.last_error !== null ||
        typeof row.discard_reason !== "string" ||
        !row.discard_reason
      ) {
        throw new Error("agentMail ledger: stored discarded state is inconsistent");
      }
    } else {
      throw new Error("agentMail ledger: stored message state is invalid");
    }
  }

  const quarantines = db
    .query<Record<string, unknown>, []>(
      `SELECT q.*, m.state AS message_state
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id`,
    )
    .all();
  for (const row of quarantines) {
    storedText(row.inbox_id, "quarantine inbox_id", 256);
    storedText(row.message_id, "quarantine message_id", 256);
    storedText(row.incident_id, "quarantine incident_id", 128);
    if (safeStoredInteger(row.incident_version, "quarantine incident_version") < 1) {
      throw new Error("agentMail ledger: stored quarantine version is invalid");
    }
    storedText(row.reason_code, "quarantine reason_code", 64);
    safeStoredInteger(row.quarantined_at, "quarantined_at");
    if (row.message_state !== "processing") {
      throw new Error("agentMail ledger: quarantined message must remain processing");
    }
  }

  const recoveries = db
    .query<Record<string, unknown>, []>("SELECT * FROM agentmail_inbound_recoveries")
    .all();
  for (const row of recoveries) {
    storedText(row.incident_id, "recovery incident_id", 128);
    storedText(row.inbox_id, "recovery inbox_id", 256);
    storedText(row.message_id, "recovery message_id", 256);
    if (safeStoredInteger(row.incident_version, "recovery incident_version") < 1) {
      throw new Error("agentMail ledger: stored recovery version is invalid");
    }
    if (row.disposition !== "confirmed-handled" && row.disposition !== "confirmed-no-effect") {
      throw new Error("agentMail ledger: stored recovery disposition is invalid");
    }
    const digest = storedText(row.evidence_sha256, "recovery evidence hash", 64);
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error("agentMail ledger: stored recovery evidence hash is invalid");
    }
    safeStoredInteger(row.resolved_at, "recovery resolved_at");
  }

  const checkpoints = db
    .query<Record<string, unknown>, []>("SELECT * FROM agentmail_inbound_checkpoints")
    .all();
  for (const row of checkpoints) {
    storedText(row.inbox_id, "checkpoint inbox_id", 256);
    const timestamp = storedText(row.after_timestamp, "checkpoint timestamp", 128);
    const timestampMs = safeStoredInteger(row.after_ts_ms, "checkpoint after_ts_ms");
    safeStoredInteger(row.updated_at, "checkpoint updated_at");
    if (Date.parse(timestamp) !== timestampMs) {
      throw new Error("agentMail ledger: stored checkpoint timestamp is inconsistent");
    }
  }

  const quotaReservations = db
    .query<Record<string, unknown>, []>("SELECT * FROM agentmail_inbound_quota_reservations")
    .all();
  for (const row of quotaReservations) {
    storedText(row.inbox_id, "quota inbox_id", 256);
    storedText(row.message_id, "quota message_id", 256);
    const senderKey = storedText(row.sender_key_sha256, "quota sender key", 64);
    if (!/^[0-9a-f]{64}$/.test(senderKey)) {
      throw new Error("agentMail ledger: stored quota sender key is invalid");
    }
    safeStoredInteger(row.admitted_at, "quota admitted_at");
  }
  const quotaRejections = db
    .query<Record<string, unknown>, []>("SELECT * FROM agentmail_inbound_quota_rejections")
    .all();
  for (const row of quotaRejections) {
    storedText(row.inbox_id, "quota rejection inbox_id", 256);
    safeStoredInteger(row.global_rejections, "global quota rejections");
    safeStoredInteger(row.per_sender_rejections, "per-sender quota rejections");
    if (row.last_rejected_at !== null) {
      safeStoredInteger(row.last_rejected_at, "last quota rejection timestamp");
    }
    policyRejectionFilter(row.rejection_filter as Uint8Array);
  }
  validateStoredCreatorAttentionRows(db);
  validateStoredCreatorDigestRows(db);
}

function quotaSenderKey(inboxId: string, canonicalSender: string): string {
  return createHash("sha256")
    .update(inboxId, "utf8")
    .update("\0", "utf8")
    .update(canonicalSender, "utf8")
    .digest("hex");
}

function policyRejectionFilter(value?: Uint8Array): Uint8Array {
  if (value === undefined) return new Uint8Array(POLICY_REJECTION_FILTER_BYTES);
  if (!(value instanceof Uint8Array) || value.byteLength !== POLICY_REJECTION_FILTER_BYTES) {
    throw new Error("agentMail ledger: stored policy rejection filter is invalid");
  }
  return new Uint8Array(value);
}

function policyRejectionFilterPositions(inboxId: string, messageId: string): number[] {
  const digest = createHash("sha256")
    .update(inboxId, "utf8")
    .update("\0", "utf8")
    .update(messageId, "utf8")
    .digest();
  const bitCount = POLICY_REJECTION_FILTER_BYTES * 8;
  return Array.from(
    { length: POLICY_REJECTION_FILTER_HASHES },
    (_, index) => digest.readUInt32BE(index * 4) % bitCount,
  );
}

function policyRejectionFilterHas(filter: Uint8Array, inboxId: string, messageId: string): boolean {
  return policyRejectionFilterPositions(inboxId, messageId).every(
    (position) => (filter[position >>> 3]! & (1 << (position & 7))) !== 0,
  );
}

function addPolicyRejectionFilter(filter: Uint8Array, inboxId: string, messageId: string): void {
  for (const position of policyRejectionFilterPositions(inboxId, messageId)) {
    filter[position >>> 3] = filter[position >>> 3]! | (1 << (position & 7));
  }
}

function classificationLabel(eventType: AgentMailReceivedEventType): string {
  switch (eventType) {
    case "message.received":
      return "received";
    case "message.received.spam":
      return "spam";
    case "message.received.blocked":
      return "blocked";
    case "message.received.unauthenticated":
      return "unauthenticated";
  }
}

function policyRejectionPayloadForIdentity(
  message: Pick<AgentMailInboundMessage, "inboxId" | "threadId" | "messageId" | "timestamp">,
  eventType: AgentMailReceivedEventType,
): string {
  return JSON.stringify({
    inboxId: message.inboxId,
    threadId: message.threadId,
    messageId: message.messageId,
    labels: [classificationLabel(eventType)],
    timestamp: message.timestamp,
    from: "policy-rejected@redacted.invalid",
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "",
    preview: undefined,
    text: undefined,
    html: undefined,
    extractedText: undefined,
    extractedHtml: undefined,
    size: 0,
    attachments: [],
    inReplyTo: undefined,
    references: [],
    createdAt: undefined,
    updatedAt: undefined,
  } satisfies AgentMailInboundMessage);
}

function policyRejectionPayload(
  message: AgentMailInboundMessage,
  eventType: AgentMailReceivedEventType,
): string {
  return policyRejectionPayloadForIdentity(message, eventType);
}

function backfillQuotaReservations(db: Database, migratedAt: number): void {
  if (!Number.isSafeInteger(migratedAt) || migratedAt < 0) {
    throw new Error("agentMail ledger: migration clock returned an invalid timestamp");
  }
  const cutoff = Math.max(0, migratedAt - INBOUND_QUOTA_WINDOW_MS);
  const rows = db
    .query<
      {
        inbox_id: string;
        message_id: string;
        payload_json: string;
        admitted_at: number;
      },
      [number]
    >(
      `SELECT inbox_id, message_id, payload_json,
              COALESCE(processed_at, last_seen_at) AS admitted_at
         FROM agentmail_inbound_messages
        WHERE state IN ('processing', 'processed')
          AND COALESCE(processed_at, last_seen_at) > ?`,
    )
    .all(cutoff);
  const insert = db.prepare(
    `INSERT INTO agentmail_inbound_quota_reservations
       (inbox_id, message_id, sender_key_sha256, admitted_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const message = normalizeAgentMailMessage(JSON.parse(row.payload_json), row.inbox_id);
    const canonicalSender = canonicalizeEmail(message.from);
    if (!canonicalSender) {
      throw new Error("agentMail ledger: cannot safely migrate sender identity");
    }
    insert.run(
      row.inbox_id,
      row.message_id,
      quotaSenderKey(row.inbox_id, canonicalSender),
      safeStoredInteger(row.admitted_at, "migration admitted_at"),
    );
  }
}

function compactLegacyPolicyRejections(db: Database): void {
  // Validate before redaction so migration cannot hide a corrupt legacy payload.
  validateStoredRows(db);
  const inboxes = db
    .query<{ inbox_id: string }, []>(
      `SELECT DISTINCT inbox_id
         FROM agentmail_inbound_messages
        WHERE state = 'discarded' AND discard_reason LIKE 'policy-%'
        ORDER BY inbox_id`,
    )
    .all();
  const selectRows = db.query<
    {
      inbox_id: string;
      message_id: string;
      thread_id: string;
      event_type: AgentMailReceivedEventType;
      message_timestamp: string;
    },
    [string]
  >(
    `SELECT inbox_id, message_id, thread_id, event_type, message_timestamp
       FROM agentmail_inbound_messages
      WHERE inbox_id = ? AND state = 'discarded' AND discard_reason LIKE 'policy-%'
      ORDER BY processed_at DESC, message_id DESC`,
  );
  const compact = db.prepare(
    `UPDATE agentmail_inbound_messages
        SET payload_json = ?
      WHERE inbox_id = ? AND message_id = ?
        AND state = 'discarded' AND discard_reason LIKE 'policy-%'`,
  );
  const insertFilter = db.prepare(
    `INSERT INTO agentmail_inbound_quota_rejections (
       inbox_id, global_rejections, per_sender_rejections, last_rejected_at, rejection_filter
     ) VALUES (?, 0, 0, NULL, ?)`,
  );
  const prune = db.prepare(
    `DELETE FROM agentmail_inbound_messages
      WHERE inbox_id = ?
        AND state = 'discarded'
        AND discard_reason LIKE 'policy-%'
        AND rowid NOT IN (
          SELECT rowid
            FROM agentmail_inbound_messages
           WHERE inbox_id = ?
             AND state = 'discarded'
             AND discard_reason LIKE 'policy-%'
           ORDER BY processed_at DESC, message_id DESC
           LIMIT ?
        )`,
  );

  for (const inbox of inboxes) {
    const inboxId = storedText(inbox.inbox_id, "legacy policy inbox_id", 256);
    const filter = policyRejectionFilter();
    for (const row of selectRows.all(inboxId)) {
      const messageId = storedText(row.message_id, "legacy policy message_id", 256);
      const payload = policyRejectionPayloadForIdentity(
        {
          inboxId,
          threadId: storedText(row.thread_id, "legacy policy thread_id", 256),
          messageId,
          timestamp: storedText(row.message_timestamp, "legacy policy timestamp", 128),
        },
        row.event_type,
      );
      addPolicyRejectionFilter(filter, inboxId, messageId);
      if (compact.run(payload, inboxId, messageId).changes !== 1) {
        throw new Error("agentMail ledger: legacy policy rejection changed during migration");
      }
    }
    insertFilter.run(inboxId, filter);
    prune.run(inboxId, inboxId, AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX);
  }
}

function prepareAgentMailDatabase(db: Database, migratedAt: number): void {
  const applicationId = pragmaInteger(db, "application_id");
  const userVersion = pragmaInteger(db, "user_version");
  const objects = schemaObjects(db);
  let metadataVersion: number | undefined;

  if (applicationId !== 0 && applicationId !== AGENTMAIL_LEDGER_APPLICATION_ID) {
    throw new Error("agentMail ledger: database belongs to another application");
  }
  if (userVersion > AGENTMAIL_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `agentMail ledger: database schema ${userVersion} is newer than supported version ${AGENTMAIL_LEDGER_SCHEMA_VERSION}`,
    );
  }
  if (
    objects.some((object) => object.type === "table" && object.name === "agentmail_inbound_meta")
  ) {
    try {
      const row = db
        .query<{ value: string }, []>(
          "SELECT value FROM agentmail_inbound_meta WHERE key = 'schema_version'",
        )
        .get();
      metadataVersion = row ? Number(row.value) : undefined;
      if (metadataVersion !== undefined && metadataVersion > AGENTMAIL_LEDGER_SCHEMA_VERSION) {
        throw new Error(
          `agentMail ledger: database schema ${row?.value} is newer than supported version ${AGENTMAIL_LEDGER_SCHEMA_VERSION}`,
        );
      }
    } catch (error) {
      if ((error as Error).message.includes("newer than supported")) throw error;
      // Exact structural admission below reports malformed lookalike metadata.
    }
  }

  if (applicationId === 0 && userVersion === 0 && objects.length === 0) {
    for (const statement of SCHEMA_STATEMENTS) db.run(statement);
    db.prepare("INSERT INTO agentmail_inbound_meta (key, value) VALUES ('schema_version', ?)").run(
      String(AGENTMAIL_LEDGER_SCHEMA_VERSION),
    );
  } else if (
    (applicationId === AGENTMAIL_LEDGER_APPLICATION_ID && userVersion === 1) ||
    (applicationId === 0 && userVersion === 0 && metadataVersion === 1)
  ) {
    validateExactSchema(db, V1_EXPECTED_SCHEMA, 1);
    for (const statement of SCHEMA_STATEMENTS.slice(5)) db.run(statement);
    backfillQuotaReservations(db, migratedAt);
    compactLegacyPolicyRejections(db);
    db.prepare("UPDATE agentmail_inbound_meta SET value = ? WHERE key = 'schema_version'").run(
      String(AGENTMAIL_LEDGER_SCHEMA_VERSION),
    );
  } else if (
    (applicationId === AGENTMAIL_LEDGER_APPLICATION_ID && userVersion === 2) ||
    (applicationId === 0 && userVersion === 0 && metadataVersion === 2)
  ) {
    validateExactSchema(db, V2_EXPECTED_SCHEMA, 2);
    for (const statement of SCHEMA_STATEMENTS.slice(8)) db.run(statement);
    backfillQuotaReservations(db, migratedAt);
    compactLegacyPolicyRejections(db);
    db.prepare("UPDATE agentmail_inbound_meta SET value = ? WHERE key = 'schema_version'").run(
      String(AGENTMAIL_LEDGER_SCHEMA_VERSION),
    );
  } else if (
    (applicationId === AGENTMAIL_LEDGER_APPLICATION_ID && userVersion === 3) ||
    (applicationId === 0 && userVersion === 0 && metadataVersion === 3)
  ) {
    validateExactSchema(db, V3_EXPECTED_SCHEMA, 3);
    for (const statement of SCHEMA_STATEMENTS.slice(11)) db.run(statement);
    backfillQuotaReservations(db, migratedAt);
    compactLegacyPolicyRejections(db);
    const updated = db
      .prepare("UPDATE agentmail_inbound_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(AGENTMAIL_LEDGER_SCHEMA_VERSION));
    if (updated.changes !== 1) {
      throw new Error("agentMail ledger: schema version metadata changed during migration");
    }
  } else if (
    (applicationId === AGENTMAIL_LEDGER_APPLICATION_ID && userVersion === 4) ||
    (applicationId === 0 && userVersion === 0 && metadataVersion === 4)
  ) {
    validateExactSchema(db, V4_EXPECTED_SCHEMA, 4);
    for (const statement of SCHEMA_STATEMENTS.slice(22)) db.run(statement);
    backfillQuotaReservations(db, migratedAt);
    compactLegacyPolicyRejections(db);
    const updated = db
      .prepare("UPDATE agentmail_inbound_meta SET value = ? WHERE key = 'schema_version'")
      .run(String(AGENTMAIL_LEDGER_SCHEMA_VERSION));
    if (updated.changes !== 1) {
      throw new Error("agentMail ledger: schema version metadata changed during migration");
    }
  } else {
    if (
      (applicationId === 0 && userVersion !== 0) ||
      (applicationId === AGENTMAIL_LEDGER_APPLICATION_ID && userVersion < 1)
    ) {
      throw new Error("agentMail ledger: database identity and schema version disagree");
    }
    validateExactSchema(db);
  }

  validateExactSchema(db);
  validateStoredRows(db);
  db.run(`PRAGMA application_id = ${AGENTMAIL_LEDGER_APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${AGENTMAIL_LEDGER_SCHEMA_VERSION}`);
}

export type AgentMailLedgerState =
  | "pending"
  | "processing"
  | "processed"
  | "discarded"
  | "outcome_unknown";

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
  outcomeUnknown: number;
}

export interface AgentMailInboundQuotaLimits {
  /** Lowercase sender mailbox, revalidated against the exact stored claim. */
  canonicalSender: string;
  globalMaxPerHour: number;
  perSenderMaxPerHour: number;
}

export type AgentMailInboundRateLimitReason =
  | "policy-rate-limit-per-sender"
  | "policy-rate-limit-global";

export type AgentMailInboundQuotaDecision =
  | {
      status: "admitted";
      reservation: "created" | "existing";
      reservedAt: number;
    }
  | {
      status: "discarded";
      reason: AgentMailInboundRateLimitReason;
    };

export interface AgentMailInboundQuotaStatus {
  rollingGlobalUsage: number;
  globalRejections: number;
  perSenderRejections: number;
  lastRejectedAt: number | undefined;
}

export interface AgentMailInboundIncident {
  id: string;
  version: number;
  inboxId: string;
  messageId: string;
  threadId: string;
  reasonCode: string;
  quarantinedAt: number;
}

export interface AgentMailInboundLedger {
  /** Durable creator-attention state sharing this ledger's admitted message identity. */
  readonly creatorAttention: AgentMailCreatorAttentionStore;
  /** Immutable creator-digest batches and append-only settlement watermarks. */
  readonly creatorDigest: AgentMailCreatorDigestStore;
  enqueue(envelope: AgentMailInboundEnvelope): AgentMailLedgerEnqueueResult;
  /** Atomically persist a REST page's received mail and its fully scanned watermark. */
  recordCatchUpBatch(
    envelopes: readonly AgentMailInboundEnvelope[],
    watermark?: AgentMailCatchUpWatermark,
  ): AgentMailCatchUpBatchResult;
  /** Returns an overlapped cursor so timestamp ties and page-boundary crashes replay safely. */
  catchUpAfter(inboxId: string): string;
  checkpoint(inboxId: string): string | undefined;
  /**
   * Convert abandoned processing claims into durable ambiguity incidents.
   * Runtime startup fences every retained claim; live workers fence only
   * expired claims before seeking more work.
   */
  fenceInterruptedClaims(input?: {
    expiredOnly?: boolean;
    /** Restrict recovery to one configured inbox when a ledger is shared. */
    inboxId?: string;
  }): AgentMailInboundIncident[];
  claimNext(input: {
    workerId: string;
    leaseMs: number;
    /** Restrict the atomic claim to one configured inbox. */
    inboxId?: string;
  }): AgentMailLedgerClaim | null;
  /**
   * Atomically reserve one rolling-hour quota slot for an exact live claim.
   * Existing reservations survive retries and are admitted idempotently.
   * A rejected claim is terminally discarded in the same transaction.
   */
  reserveInboundQuota(
    claim: AgentMailLedgerClaim,
    input: AgentMailInboundQuotaLimits,
  ): AgentMailInboundQuotaDecision;
  /** Atomically compact and terminally retain a pre-model policy rejection. */
  discardInboundPolicy(claim: AgentMailLedgerClaim, reason: string): boolean;
  /** Metadata-only quota diagnostics; never returns sender identities or digests. */
  inboundQuotaStatus(inboxId: string): AgentMailInboundQuotaStatus;
  renew(claim: AgentMailLedgerClaim, leaseMs: number): boolean;
  complete(claim: AgentMailLedgerClaim): boolean;
  /**
   * Return a pre-model claim to pending without charging the claim attempt.
   * This is exclusively for typed backpressure before any model/tool effect.
   */
  defer(claim: AgentMailLedgerClaim, input: { reason: string; availableAt?: number }): boolean;
  retry(claim: AgentMailLedgerClaim, input: { error: string; availableAt?: number }): boolean;
  discard(claim: AgentMailLedgerClaim, reason: string): boolean;
  quarantine(claim: AgentMailLedgerClaim, reasonCode: string): AgentMailInboundIncident | null;
  listIncidents(limit?: number, inboxId?: string): AgentMailInboundIncident[];
  /** Every provider thread held by at least one unresolved incident. */
  listIncidentThreads(inboxId?: string): string[];
  hasIncidentThread(threadId: string, inboxId?: string): boolean;
  reconcileIncident(input: {
    incidentId: string;
    expectedVersion: number;
    disposition: "confirmed-handled" | "confirmed-no-effect";
    evidence: string;
    /** Bind operator recovery to the owning inbox. */
    inboxId?: string;
  }): { resolved: boolean; threadId?: string; releaseThread?: boolean };
  get(inboxId: string, messageId: string): AgentMailLedgerRecord | null;
  counts(inboxId?: string): AgentMailLedgerCounts;
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
  /** Test-only incident-id seam. */
  incidentId?: () => string;
  /** Test-only creator-digest batch-id seam. */
  digestBatchId?: () => string;
  /**
   * Maximum creator-attention records retained in this ledger. Default 1000.
   * Terminal rows for unresolved inbound incidents never become reclaimable
   * capacity until that incident is reconciled.
   */
  attentionMaxRecords?: number;
  /**
   * Terminal creator-attention retention. Default 30 days. Unresolved inbound
   * incidents retain their linked replay evidence beyond this horizon.
   */
  attentionRetentionMs?: number;
  /** Maximum retained immutable creator-digest batches. Default 1000. */
  digestMaxBatches?: number;
  /** Maximum retained creator-digest items. Default 10000. */
  digestMaxItems?: number;
  /** Settled creator-digest retention. Default 30 days. */
  digestRetentionMs?: number;
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
  incident_id?: string | null;
  incident_version?: number | null;
  reason_code?: string | null;
  quarantined_at?: number | null;
}

interface IncidentRow {
  incident_id: string;
  incident_version: number;
  inbox_id: string;
  message_id: string;
  thread_id: string;
  reason_code: string;
  quarantined_at: number;
}

interface QuotaReservationRow {
  sender_key_sha256: string;
  admitted_at: number;
}

interface QuotaRejectionRow {
  global_rejections: number;
  per_sender_rejections: number;
  last_rejected_at: number | null;
  rejection_filter: Uint8Array;
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

function checkedTimestampAdd(base: number, duration: number, label: string): number {
  const result = base + duration;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`agentMail ledger: ${label} exceeds the safe timestamp range`);
  }
  return result;
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
  const nextIncidentId = options.incidentId ?? randomUUID;
  const database = openHardenedSqlite({
    path: options.dbPath,
    label: "agentMail ledger",
    foreignKeys: true,
    synchronous: "FULL",
    prepare: (db) => prepareAgentMailDatabase(db, now()),
  });
  const db = database.db;
  let closed = false;

  const selectMessage = db.prepare<LedgerRow, [string, string]>(
    `SELECT m.*, q.incident_id, q.incident_version, q.reason_code, q.quarantined_at
       FROM agentmail_inbound_messages m
       LEFT JOIN agentmail_inbound_quarantines q
         ON q.inbox_id = m.inbox_id AND q.message_id = m.message_id
      WHERE m.inbox_id = ? AND m.message_id = ?`,
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
  const claimMessage = db.prepare<LedgerRow, [string, string, number, number, string, number]>(
    `UPDATE agentmail_inbound_messages
       SET state = 'processing',
           attempt_count = attempt_count + 1,
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           last_seen_at = ?
     WHERE rowid = (
       SELECT rowid FROM agentmail_inbound_messages
       WHERE state = 'pending' AND inbox_id = ? AND available_at <= ?
         AND NOT EXISTS (
           SELECT 1
             FROM agentmail_inbound_quarantines q
             JOIN agentmail_inbound_messages quarantined
               ON quarantined.inbox_id = q.inbox_id
              AND quarantined.message_id = q.message_id
            WHERE quarantined.inbox_id = agentmail_inbound_messages.inbox_id
              AND quarantined.thread_id = agentmail_inbound_messages.thread_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM agentmail_inbound_messages active
            WHERE active.inbox_id = agentmail_inbound_messages.inbox_id
              AND active.thread_id = agentmail_inbound_messages.thread_id
              AND active.state = 'processing'
         )
       ORDER BY message_ts_ms ASC, message_id ASC
       LIMIT 1
     )
     RETURNING *`,
  );
  const claimMessageAnyInbox = db.prepare<LedgerRow, [string, string, number, number, number]>(
    `UPDATE agentmail_inbound_messages
       SET state = 'processing',
           attempt_count = attempt_count + 1,
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           last_seen_at = ?
     WHERE rowid = (
       SELECT rowid FROM agentmail_inbound_messages
       WHERE state = 'pending' AND available_at <= ?
         AND NOT EXISTS (
           SELECT 1
             FROM agentmail_inbound_quarantines q
             JOIN agentmail_inbound_messages quarantined
               ON quarantined.inbox_id = q.inbox_id
              AND quarantined.message_id = q.message_id
            WHERE quarantined.inbox_id = agentmail_inbound_messages.inbox_id
              AND quarantined.thread_id = agentmail_inbound_messages.thread_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM agentmail_inbound_messages active
            WHERE active.inbox_id = agentmail_inbound_messages.inbox_id
              AND active.thread_id = agentmail_inbound_messages.thread_id
              AND active.state = 'processing'
         )
       ORDER BY message_ts_ms ASC, message_id ASC
       LIMIT 1
     )
     RETURNING *`,
  );
  const renewClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET lease_expires_at = ?, last_seen_at = ?
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const completeClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'processed', processed_at = ?, last_seen_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error = NULL, discard_reason = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const retryClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'pending', available_at = ?, last_seen_at = ?, last_error = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const deferClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'pending', attempt_count = attempt_count - 1,
           available_at = ?, last_seen_at = ?, last_error = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND attempt_count = ? AND attempt_count > 0
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const discardClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET state = 'discarded', processed_at = ?, last_seen_at = ?, discard_reason = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const discardPolicyClaim = db.prepare(
    `UPDATE agentmail_inbound_messages
       SET payload_json = ?, state = 'discarded', processed_at = ?, last_seen_at = ?,
           discard_reason = ?, lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, last_error = NULL
     WHERE inbox_id = ? AND message_id = ?
       AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM agentmail_inbound_quarantines q
          WHERE q.inbox_id = agentmail_inbound_messages.inbox_id
            AND q.message_id = agentmail_inbound_messages.message_id
       )`,
  );
  const selectQuotaReservation = db.prepare<QuotaReservationRow, [string, string]>(
    `SELECT sender_key_sha256, admitted_at
       FROM agentmail_inbound_quota_reservations
      WHERE inbox_id = ? AND message_id = ?`,
  );
  const deleteExpiredQuotaReservations = db.prepare(
    `DELETE FROM agentmail_inbound_quota_reservations
      WHERE inbox_id = ? AND admitted_at <= ?
        AND EXISTS (
          SELECT 1 FROM agentmail_inbound_messages m
           WHERE m.inbox_id = agentmail_inbound_quota_reservations.inbox_id
             AND m.message_id = agentmail_inbound_quota_reservations.message_id
             AND m.state IN ('processed', 'discarded')
        )`,
  );
  const countSenderQuotaReservations = db.prepare<{ count: number }, [string, string, number]>(
    `SELECT COUNT(*) AS count
       FROM agentmail_inbound_quota_reservations
      WHERE inbox_id = ? AND sender_key_sha256 = ? AND admitted_at > ?`,
  );
  const countGlobalQuotaReservations = db.prepare<{ count: number }, [string, number]>(
    `SELECT COUNT(*) AS count
       FROM agentmail_inbound_quota_reservations
      WHERE inbox_id = ? AND admitted_at > ?`,
  );
  const insertQuotaReservation = db.prepare(
    `INSERT INTO agentmail_inbound_quota_reservations
       (inbox_id, message_id, sender_key_sha256, admitted_at)
     VALUES (?, ?, ?, ?)`,
  );
  const writePolicyRejectionState = db.prepare(
    `INSERT INTO agentmail_inbound_quota_rejections (
       inbox_id, global_rejections, per_sender_rejections, last_rejected_at, rejection_filter
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(inbox_id) DO UPDATE SET
       global_rejections = excluded.global_rejections,
       per_sender_rejections = excluded.per_sender_rejections,
       last_rejected_at = excluded.last_rejected_at,
       rejection_filter = excluded.rejection_filter`,
  );
  const prunePolicyTombstones = db.prepare(
    `DELETE FROM agentmail_inbound_messages
      WHERE inbox_id = ?
        AND state = 'discarded'
        AND discard_reason LIKE 'policy-%'
        AND rowid NOT IN (
          SELECT rowid
            FROM agentmail_inbound_messages
           WHERE inbox_id = ?
             AND state = 'discarded'
             AND discard_reason LIKE 'policy-%'
           ORDER BY processed_at DESC, message_id DESC
           LIMIT ?
        )`,
  );
  const selectPolicyRejectionState = db.prepare<QuotaRejectionRow, [string]>(
    `SELECT global_rejections, per_sender_rejections, last_rejected_at, rejection_filter
       FROM agentmail_inbound_quota_rejections
      WHERE inbox_id = ?`,
  );
  const selectQuotaRejectionStatus = db.prepare<
    Omit<QuotaRejectionRow, "rejection_filter">,
    [string]
  >(
    `SELECT global_rejections, per_sender_rejections, last_rejected_at
       FROM agentmail_inbound_quota_rejections
      WHERE inbox_id = ?`,
  );
  const countStates = db.prepare<{ state: AgentMailLedgerState; count: number }, []>(
    `SELECT state, COUNT(*) AS count FROM agentmail_inbound_messages GROUP BY state`,
  );
  const countStatesByInbox = db.prepare<{ state: AgentMailLedgerState; count: number }, [string]>(
    `SELECT state, COUNT(*) AS count
       FROM agentmail_inbound_messages
      WHERE inbox_id = ?
      GROUP BY state`,
  );
  const countQuarantines = db.prepare<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM agentmail_inbound_quarantines",
  );
  const countQuarantinesByInbox = db.prepare<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM agentmail_inbound_quarantines WHERE inbox_id = ?",
  );
  const insertQuarantine = db.prepare<
    IncidentRow,
    [string, string, number, string, string, string]
  >(
    `INSERT INTO agentmail_inbound_quarantines (
       inbox_id, message_id, incident_id, incident_version, reason_code, quarantined_at
     )
     SELECT inbox_id, message_id, ?, 1, ?, ?
      FROM agentmail_inbound_messages
      WHERE inbox_id = ? AND message_id = ?
        AND state = 'processing' AND lease_token = ?
     ON CONFLICT(inbox_id, message_id) DO NOTHING
     RETURNING incident_id, incident_version, inbox_id, message_id,
       (SELECT thread_id FROM agentmail_inbound_messages m
         WHERE m.inbox_id = agentmail_inbound_quarantines.inbox_id
           AND m.message_id = agentmail_inbound_quarantines.message_id) AS thread_id,
       reason_code, quarantined_at`,
  );
  const listQuarantines = db.prepare<IncidentRow, [number]>(
    `SELECT q.incident_id, q.incident_version, q.inbox_id, q.message_id,
            m.thread_id, q.reason_code, q.quarantined_at
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      ORDER BY q.quarantined_at ASC, q.incident_id ASC LIMIT ?`,
  );
  const listQuarantinesByInbox = db.prepare<IncidentRow, [string, number]>(
    `SELECT q.incident_id, q.incident_version, q.inbox_id, q.message_id,
            m.thread_id, q.reason_code, q.quarantined_at
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE q.inbox_id = ?
      ORDER BY q.quarantined_at ASC, q.incident_id ASC LIMIT ?`,
  );
  const listQuarantinedThreads = db.prepare<{ thread_id: string }, []>(
    `SELECT DISTINCT m.thread_id
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      ORDER BY m.thread_id`,
  );
  const listQuarantinedThreadsByInbox = db.prepare<{ thread_id: string }, [string]>(
    `SELECT DISTINCT m.thread_id
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE m.inbox_id = ?
      ORDER BY m.thread_id`,
  );
  const countThreadQuarantinesByProviderThread = db.prepare<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE m.thread_id = ?`,
  );
  const countThreadQuarantinesByInboxAndProviderThread = db.prepare<
    { count: number },
    [string, string]
  >(
    `SELECT COUNT(*) AS count
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE m.inbox_id = ? AND m.thread_id = ?`,
  );
  const selectQuarantineByIncident = db.prepare<IncidentRow, [string]>(
    `SELECT q.incident_id, q.incident_version, q.inbox_id, q.message_id,
            m.thread_id, q.reason_code, q.quarantined_at
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE q.incident_id = ?`,
  );
  const selectInterruptedClaims = db.prepare<
    { inbox_id: string; message_id: string; thread_id: string },
    [number, number]
  >(
    `SELECT m.inbox_id, m.message_id, m.thread_id
       FROM agentmail_inbound_messages m
       LEFT JOIN agentmail_inbound_quarantines q
         ON q.inbox_id = m.inbox_id AND q.message_id = m.message_id
      WHERE m.state = 'processing' AND q.incident_id IS NULL
        AND (? = 0 OR m.lease_expires_at <= ?)
      ORDER BY m.message_ts_ms, m.message_id
      LIMIT 1001`,
  );
  const selectInterruptedClaimsByInbox = db.prepare<
    { inbox_id: string; message_id: string; thread_id: string },
    [string, number, number]
  >(
    `SELECT m.inbox_id, m.message_id, m.thread_id
       FROM agentmail_inbound_messages m
       LEFT JOIN agentmail_inbound_quarantines q
         ON q.inbox_id = m.inbox_id AND q.message_id = m.message_id
      WHERE m.inbox_id = ? AND m.state = 'processing' AND q.incident_id IS NULL
        AND (? = 0 OR m.lease_expires_at <= ?)
      ORDER BY m.message_ts_ms, m.message_id
      LIMIT 1001`,
  );
  const promoteInterruptedClaim = db.prepare<IncidentRow, [string, string, string, string, number]>(
    `INSERT INTO agentmail_inbound_quarantines (
       inbox_id, message_id, incident_id, incident_version, reason_code, quarantined_at
     ) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(inbox_id, message_id) DO NOTHING
     RETURNING incident_id, incident_version, inbox_id, message_id,
       (SELECT thread_id FROM agentmail_inbound_messages m
         WHERE m.inbox_id = agentmail_inbound_quarantines.inbox_id
           AND m.message_id = agentmail_inbound_quarantines.message_id) AS thread_id,
       reason_code, quarantined_at`,
  );
  const selectQuarantineByMessage = db.prepare<IncidentRow, [string, string]>(
    `SELECT q.incident_id, q.incident_version, q.inbox_id, q.message_id,
            m.thread_id, q.reason_code, q.quarantined_at
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE q.inbox_id = ? AND q.message_id = ?`,
  );
  const resolveHandledMessage = db.prepare(
    `UPDATE agentmail_inbound_messages
        SET state = 'processed', processed_at = ?, last_seen_at = ?,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error = NULL, discard_reason = NULL
      WHERE inbox_id = ? AND message_id = ? AND state = 'processing'`,
  );
  const resolveRetryMessage = db.prepare(
    `UPDATE agentmail_inbound_messages
        SET state = 'pending', available_at = ?, last_seen_at = ?, processed_at = NULL,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error = 'operator confirmed no external effect', discard_reason = NULL
      WHERE inbox_id = ? AND message_id = ? AND state = 'processing'`,
  );
  const insertRecovery = db.prepare(
    `INSERT INTO agentmail_inbound_recoveries (
       incident_id, inbox_id, message_id, incident_version,
       disposition, evidence_sha256, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteQuarantine = db.prepare(
    `DELETE FROM agentmail_inbound_quarantines
      WHERE incident_id = ? AND incident_version = ?`,
  );
  const countThreadQuarantines = db.prepare<{ count: number }, [string, string]>(
    `SELECT COUNT(*) AS count
       FROM agentmail_inbound_quarantines q
       JOIN agentmail_inbound_messages m
         ON m.inbox_id = q.inbox_id AND m.message_id = q.message_id
      WHERE m.inbox_id = ? AND m.thread_id = ?`,
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
    database.secureArtifacts();
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

  function recordPolicyRejection(
    inboxId: string,
    messageId: string,
    reason: string,
    rejectedAt: number,
  ): void {
    const stored = selectPolicyRejectionState.get(inboxId);
    const globalRejections = safeStoredInteger(
      stored?.global_rejections ?? 0,
      "global quota rejection count",
    );
    const perSenderRejections = safeStoredInteger(
      stored?.per_sender_rejections ?? 0,
      "per-sender quota rejection count",
    );
    const nextGlobal = globalRejections + (reason === "policy-rate-limit-global" ? 1 : 0);
    const nextPerSender = perSenderRejections + (reason === "policy-rate-limit-per-sender" ? 1 : 0);
    if (!Number.isSafeInteger(nextGlobal) || !Number.isSafeInteger(nextPerSender)) {
      throw new Error("agentMail ledger: quota rejection counter exceeds safe integer range");
    }
    const filter = policyRejectionFilter(stored?.rejection_filter);
    addPolicyRejectionFilter(filter, inboxId, messageId);
    const quotaRejection =
      reason === "policy-rate-limit-global" || reason === "policy-rate-limit-per-sender";
    writePolicyRejectionState.run(
      inboxId,
      nextGlobal,
      nextPerSender,
      quotaRejection ? rejectedAt : (stored?.last_rejected_at ?? null),
      filter,
    );
  }

  const creatorAttention = createAgentMailCreatorAttentionStore({
    db,
    now: clock,
    assertOpen,
    immediate,
    maxRecords: options.attentionMaxRecords,
    retentionMs: options.attentionRetentionMs,
  });
  const creatorDigest = createAgentMailCreatorDigestStore({
    db,
    now: clock,
    assertOpen,
    immediate,
    batchId: options.digestBatchId,
    maxBatches: options.digestMaxBatches,
    maxItems: options.digestMaxItems,
    retentionMs: options.digestRetentionMs,
  });

  function prepareEnvelope(envelope: AgentMailInboundEnvelope): PreparedEnvelope {
    if (!(["rest", "websocket", "webhook"] as const).includes(envelope.source)) {
      throw new Error("agentMail ledger: invalid inbound source");
    }
    const message = normalizeAgentMailMessage(envelope.message, envelope.message.inboxId);
    storedText(message.inboxId, "inbox_id", 256);
    storedText(message.messageId, "message_id", 256);
    storedText(message.threadId, "thread_id", 256);
    storedText(message.timestamp, "message_timestamp", 128);
    const inferredType = receivedEventTypeForLabels(message.labels);
    if (envelope.eventType !== inferredType) {
      throw new AgentMailLedgerConflictError("event classification does not match message labels");
    }
    if (envelope.source === "rest" && envelope.providerEventId !== undefined) {
      throw new Error("agentMail ledger: REST catch-up must not declare a provider event ID");
    }
    const providerEventId =
      envelope.source === "rest"
        ? undefined
        : requireText(envelope.providerEventId ?? "", "providerEventId");
    const timestampMs = Date.parse(message.timestamp);
    return {
      envelope: { ...envelope, providerEventId, message },
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
      state: row.incident_id ? "outcome_unknown" : row.state,
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

  function incidentRecord(row: IncidentRow): AgentMailInboundIncident {
    return {
      id: row.incident_id,
      version: row.incident_version,
      inboxId: row.inbox_id,
      messageId: row.message_id,
      threadId: row.thread_id,
      reasonCode: row.reason_code,
      quarantinedAt: row.quarantined_at,
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
      const rejection = selectPolicyRejectionState.get(message.inboxId);
      if (
        rejection &&
        policyRejectionFilterHas(
          policyRejectionFilter(rejection.rejection_filter),
          message.inboxId,
          message.messageId,
        )
      ) {
        return { status: "duplicate", state: "discarded" };
      }
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
    const policyTombstone =
      existing.state === "discarded" && existing.discard_reason?.startsWith("policy-");
    if (
      existing.thread_id !== message.threadId ||
      existing.message_ts_ms !== timestampMs ||
      (!policyTombstone && existingMessage.from !== message.from) ||
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
    requireText(claim.workerId, "claim workerId", 128);
    requireText(claim.leaseToken, "claim leaseToken");
  }

  function validateLeaseMs(leaseMs: number): number {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
      throw new Error(`agentMail ledger: leaseMs must be between 1 and ${MAX_LEASE_MS}`);
    }
    return leaseMs;
  }

  function validateIncidentId(value: string): string {
    const id = requireText(value, "incidentId", 128);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error("agentMail ledger: incidentId contains unsafe characters");
    }
    return id;
  }

  function fenceInterruptedClaims(
    expiredOnly: boolean,
    inboxIdInput?: string,
  ): AgentMailInboundIncident[] {
    const detectedAt = clock();
    const inboxId = inboxIdInput === undefined ? undefined : requireText(inboxIdInput, "inboxId");
    return immediate(() => {
      const interruptedClaims =
        inboxId === undefined
          ? selectInterruptedClaims.all(expiredOnly ? 1 : 0, detectedAt)
          : selectInterruptedClaimsByInbox.all(inboxId, expiredOnly ? 1 : 0, detectedAt);
      if (interruptedClaims.length > 1_000) {
        throw new Error(
          "agentMail ledger: more than 1000 interrupted claims require operator repair",
        );
      }
      const incidents: AgentMailInboundIncident[] = [];
      for (const claim of interruptedClaims) {
        const row = promoteInterruptedClaim.get(
          claim.inbox_id,
          claim.message_id,
          validateIncidentId(nextIncidentId()),
          expiredOnly ? "processing-lease-expired" : "process-restarted",
          detectedAt,
        );
        if (row) incidents.push(incidentRecord(row));
      }
      return incidents;
    });
  }

  return {
    creatorAttention,
    creatorDigest,

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
      storedText(inboxId, "checkpoint inbox_id", 256);
      if (prepared.some((item) => item.envelope.message.inboxId !== inboxId)) {
        throw new Error("agentMail ledger: catch-up batch spans multiple inboxes");
      }
      const watermarkMs = watermark ? Date.parse(watermark.through) : undefined;
      if (watermark) storedText(watermark.through, "checkpoint timestamp", 128);
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

    fenceInterruptedClaims(input) {
      assertOpen();
      return fenceInterruptedClaims(input?.expiredOnly === true, input?.inboxId);
    },

    claimNext(input) {
      assertOpen();
      const inboxId =
        input.inboxId === undefined ? undefined : requireText(input.inboxId, "inboxId");
      // A claimed record may already have crossed the model/tool boundary.
      // Expiry therefore creates an incident; it never grants a new lease.
      fenceInterruptedClaims(true, inboxId);
      const workerId = requireText(input.workerId, "workerId", 128);
      const leaseMs = validateLeaseMs(input.leaseMs);
      const claimedAt = clock();
      const token = requireText(nextLeaseToken(), "lease token", 256);
      const expiresAt = checkedTimestampAdd(claimedAt, leaseMs, "lease expiry");
      const row =
        inboxId === undefined
          ? claimMessageAnyInbox.get(workerId, token, expiresAt, claimedAt, claimedAt)
          : claimMessage.get(workerId, token, expiresAt, claimedAt, inboxId, claimedAt);
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

    reserveInboundQuota(claim, input) {
      assertOpen();
      validateClaim(claim);
      const inboxId = requireText(claim.envelope.message.inboxId, "claim inboxId");
      const messageId = requireText(claim.envelope.message.messageId, "claim messageId");
      const canonicalSender = requireText(input.canonicalSender, "canonicalSender", 254);
      if (
        canonicalSender !== canonicalizeEmail(input.canonicalSender) ||
        !isWellFormedEmail(canonicalSender)
      ) {
        throw new Error(
          "agentMail ledger: canonicalSender must be a trimmed, lowercase, well-formed email address",
        );
      }
      const { globalMaxPerHour, perSenderMaxPerHour } = validateAgentMailInboundRateLimit({
        globalMaxPerHour: input.globalMaxPerHour,
        perSenderMaxPerHour: input.perSenderMaxPerHour,
      });

      const decision = immediate(() => {
        const admittedAt = clock();
        const cutoff = admittedAt - INBOUND_QUOTA_WINDOW_MS;
        const liveClaim = selectMessage.get(inboxId, messageId);
        if (
          liveClaim?.state !== "processing" ||
          liveClaim.incident_id ||
          liveClaim.lease_owner !== claim.workerId ||
          liveClaim.lease_token !== claim.leaseToken ||
          liveClaim.lease_expires_at === null ||
          liveClaim.lease_expires_at <= admittedAt
        ) {
          throw new AgentMailLedgerConflictError("quota reservation requires the exact live claim");
        }
        const liveMessage = rowMessage(liveClaim);
        const storedSender = canonicalizeEmail(liveMessage.from);
        if (!isWellFormedEmail(storedSender) || canonicalSender !== storedSender) {
          throw new AgentMailLedgerConflictError("quota sender does not match the claimed message");
        }
        const senderKey = quotaSenderKey(inboxId, canonicalSender);

        const existing = selectQuotaReservation.get(inboxId, messageId);
        if (existing) {
          if (existing.sender_key_sha256 !== senderKey) {
            throw new AgentMailLedgerConflictError("stored quota sender does not match the claim");
          }
          return {
            status: "admitted",
            reservation: "existing",
            reservedAt: safeStoredInteger(existing.admitted_at, "quota admitted_at"),
          } as const;
        }

        deleteExpiredQuotaReservations.run(inboxId, cutoff);
        const perSenderUsage = safeStoredInteger(
          countSenderQuotaReservations.get(inboxId, senderKey, cutoff)?.count ?? 0,
          "per-sender quota count",
        );
        const reason: AgentMailInboundRateLimitReason | undefined =
          perSenderUsage >= perSenderMaxPerHour
            ? "policy-rate-limit-per-sender"
            : safeStoredInteger(
                  countGlobalQuotaReservations.get(inboxId, cutoff)?.count ?? 0,
                  "global quota count",
                ) >= globalMaxPerHour
              ? "policy-rate-limit-global"
              : undefined;
        if (reason) {
          const discarded = discardPolicyClaim.run(
            policyRejectionPayload(liveMessage, liveClaim.event_type),
            admittedAt,
            admittedAt,
            reason,
            inboxId,
            messageId,
            claim.leaseToken,
            admittedAt,
          );
          if (discarded.changes !== 1) {
            throw new AgentMailLedgerConflictError("rate-limited claim changed before discard");
          }
          recordPolicyRejection(inboxId, messageId, reason, admittedAt);
          prunePolicyTombstones.run(inboxId, inboxId, AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX);
          return { status: "discarded", reason } as const;
        }

        insertQuotaReservation.run(inboxId, messageId, senderKey, admittedAt);
        return {
          status: "admitted",
          reservation: "created",
          reservedAt: admittedAt,
        } as const;
      });
      secureAfterWrite();
      return decision;
    },

    discardInboundPolicy(claim, reasonInput) {
      assertOpen();
      validateClaim(claim);
      if (
        typeof reasonInput !== "string" ||
        !/^policy-[a-z0-9.-]+$/.test(reasonInput) ||
        reasonInput.length > MAX_ANNOTATION_CHARS
      ) {
        throw new Error("agentMail ledger: inbound policy reason is invalid");
      }
      const inboxId = requireText(claim.envelope.message.inboxId, "claim inboxId");
      const messageId = requireText(claim.envelope.message.messageId, "claim messageId");
      const discarded = immediate(() => {
        const discardedAt = clock();
        const liveClaim = selectMessage.get(inboxId, messageId);
        if (
          liveClaim?.state !== "processing" ||
          liveClaim.incident_id ||
          liveClaim.lease_owner !== claim.workerId ||
          liveClaim.lease_token !== claim.leaseToken ||
          liveClaim.lease_expires_at === null ||
          liveClaim.lease_expires_at <= discardedAt
        ) {
          return false;
        }
        const changed = discardPolicyClaim.run(
          policyRejectionPayload(rowMessage(liveClaim), liveClaim.event_type),
          discardedAt,
          discardedAt,
          reasonInput,
          inboxId,
          messageId,
          claim.leaseToken,
          discardedAt,
        );
        if (changed.changes !== 1) return false;
        recordPolicyRejection(inboxId, messageId, reasonInput, discardedAt);
        prunePolicyTombstones.run(inboxId, inboxId, AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX);
        return true;
      });
      secureAfterWrite();
      return discarded;
    },

    inboundQuotaStatus(inboxIdInput) {
      assertOpen();
      const inboxId = requireText(inboxIdInput, "inboxId");
      const timestamp = clock();
      const cutoff = timestamp - INBOUND_QUOTA_WINDOW_MS;
      const rejection = selectQuotaRejectionStatus.get(inboxId);
      const lastRejectedAt =
        rejection?.last_rejected_at === null || rejection?.last_rejected_at === undefined
          ? undefined
          : safeStoredInteger(rejection.last_rejected_at, "last rejected timestamp");
      return {
        rollingGlobalUsage: safeStoredInteger(
          countGlobalQuotaReservations.get(inboxId, cutoff)?.count ?? 0,
          "global quota count",
        ),
        globalRejections: safeStoredInteger(
          rejection?.global_rejections ?? 0,
          "global quota rejection count",
        ),
        perSenderRejections: safeStoredInteger(
          rejection?.per_sender_rejections ?? 0,
          "per-sender quota rejection count",
        ),
        lastRejectedAt,
      };
    },

    renew(claim, leaseMsInput) {
      assertOpen();
      validateClaim(claim);
      const leaseMs = validateLeaseMs(leaseMsInput);
      const renewedAt = clock();
      const result = renewClaim.run(
        checkedTimestampAdd(renewedAt, leaseMs, "lease expiry"),
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

    defer(claim, input) {
      assertOpen();
      validateClaim(claim);
      const deferredAt = clock();
      const availableAt = Math.max(deferredAt, input.availableAt ?? deferredAt);
      if (!Number.isSafeInteger(availableAt)) {
        throw new Error("agentMail ledger: defer availableAt must be a safe integer");
      }
      const result = deferClaim.run(
        availableAt,
        deferredAt,
        annotation(input.reason, "defer reason"),
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
        deferredAt,
        claim.attemptCount,
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

    quarantine(claim, reasonCode) {
      assertOpen();
      validateClaim(claim);
      const reason = requireText(reasonCode, "quarantine reason", 64);
      if (!/^[a-z0-9-]+$/.test(reason)) {
        throw new Error("agentMail ledger: quarantine reason must be a fixed reason code");
      }
      const quarantinedAt = clock();
      const incidentId = validateIncidentId(nextIncidentId());
      const row = insertQuarantine.get(
        incidentId,
        reason,
        quarantinedAt,
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
        claim.leaseToken,
      );
      secureAfterWrite();
      if (row) return incidentRecord(row);
      const existing = selectQuarantineByMessage.get(
        claim.envelope.message.inboxId,
        claim.envelope.message.messageId,
      );
      return existing ? incidentRecord(existing) : null;
    },

    listIncidents(limit = 50, inboxIdInput) {
      assertOpen();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("agentMail ledger: incident limit must be between 1 and 100");
      }
      if (inboxIdInput === undefined) return listQuarantines.all(limit).map(incidentRecord);
      const inboxId = requireText(inboxIdInput, "inboxId");
      return listQuarantinesByInbox.all(inboxId, limit).map(incidentRecord);
    },

    listIncidentThreads(inboxIdInput) {
      assertOpen();
      if (inboxIdInput === undefined) {
        return listQuarantinedThreads.all().map((row) => row.thread_id);
      }
      const inboxId = requireText(inboxIdInput, "inboxId");
      return listQuarantinedThreadsByInbox.all(inboxId).map((row) => row.thread_id);
    },

    hasIncidentThread(threadId, inboxIdInput) {
      assertOpen();
      requireText(threadId, "threadId");
      if (inboxIdInput !== undefined) {
        const inboxId = requireText(inboxIdInput, "inboxId");
        return (
          (countThreadQuarantinesByInboxAndProviderThread.get(inboxId, threadId)?.count ?? 0) > 0
        );
      }
      return (countThreadQuarantinesByProviderThread.get(threadId)?.count ?? 0) > 0;
    },

    reconcileIncident(input) {
      assertOpen();
      const incidentId = validateIncidentId(input.incidentId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error("agentMail ledger: expected incident version is invalid");
      }
      if (
        input.disposition !== "confirmed-handled" &&
        input.disposition !== "confirmed-no-effect"
      ) {
        throw new Error("agentMail ledger: recovery disposition is invalid");
      }
      const evidence = requireText(input.evidence, "recovery evidence", 400);
      const evidenceDigest = createHash("sha256").update(evidence, "utf8").digest("hex");
      const resolvedAt = clock();
      const result = immediate(() => {
        const incident = selectQuarantineByIncident.get(incidentId);
        const expectedInbox =
          input.inboxId === undefined ? undefined : requireText(input.inboxId, "inboxId");
        if (
          !incident ||
          incident.incident_version !== input.expectedVersion ||
          (expectedInbox !== undefined && incident.inbox_id !== expectedInbox)
        ) {
          return { resolved: false } as const;
        }
        const updated =
          input.disposition === "confirmed-handled"
            ? resolveHandledMessage.run(
                resolvedAt,
                resolvedAt,
                incident.inbox_id,
                incident.message_id,
              )
            : resolveRetryMessage.run(
                resolvedAt,
                resolvedAt,
                incident.inbox_id,
                incident.message_id,
              );
        if (updated.changes !== 1) return { resolved: false } as const;
        insertRecovery.run(
          incident.incident_id,
          incident.inbox_id,
          incident.message_id,
          incident.incident_version,
          input.disposition,
          evidenceDigest,
          resolvedAt,
        );
        if (deleteQuarantine.run(incidentId, input.expectedVersion).changes !== 1) {
          throw new Error("agentMail ledger: incident changed during recovery");
        }
        const remaining =
          countThreadQuarantines.get(incident.inbox_id, incident.thread_id)?.count ?? 0;
        return {
          resolved: true,
          threadId: incident.thread_id,
          releaseThread: remaining === 0,
        } as const;
      });
      secureAfterWrite();
      return result;
    },

    get(inboxId, messageId) {
      assertOpen();
      requireText(inboxId, "inboxId");
      requireText(messageId, "messageId");
      const row = selectMessage.get(inboxId, messageId);
      return row ? rowRecord(row) : null;
    },

    counts(inboxIdInput) {
      assertOpen();
      const counts: AgentMailLedgerCounts = {
        pending: 0,
        processing: 0,
        processed: 0,
        discarded: 0,
        outcomeUnknown: 0,
      };
      const inboxId = inboxIdInput === undefined ? undefined : requireText(inboxIdInput, "inboxId");
      const stateRows = inboxId === undefined ? countStates.all() : countStatesByInbox.all(inboxId);
      for (const row of stateRows) {
        if (row.state === "outcome_unknown") continue;
        counts[row.state] = row.count;
      }
      counts.outcomeUnknown =
        inboxId === undefined
          ? (countQuarantines.get()?.count ?? 0)
          : (countQuarantinesByInbox.get(inboxId)?.count ?? 0);
      counts.processing = Math.max(0, counts.processing - counts.outcomeUnknown);
      return counts;
    },

    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}

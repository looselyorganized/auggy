import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../lib/sqlite";
import type { AgentMailMessageClassification } from "./provider";

export const AGENTMAIL_ORCHESTRATION_APPLICATION_ID = 0x414d4f52; // "AMOR"
export const AGENTMAIL_ORCHESTRATION_SCHEMA_VERSION = 1;
const AGENTMAIL_ORCHESTRATION_CONTRACT = "agentmail-provider-native-orchestration/2026-08-13";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agentmail_mailboxes (
    inbox_id             TEXT PRIMARY KEY,
    checkpoint_timestamp INTEGER NOT NULL DEFAULT 0,
    checkpoint_message_id TEXT,
    updated_at           INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_store_metadata (
    singleton            INTEGER PRIMARY KEY CHECK (singleton = 1),
    contract_fingerprint TEXT NOT NULL CHECK (length(contract_fingerprint) = 64),
    created_at           INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_messages (
    inbox_id        TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    thread_id       TEXT NOT NULL,
    event_id        TEXT,
    classification  TEXT NOT NULL CHECK (classification IN ('received', 'spam', 'blocked', 'unauthenticated')),
    sender_address  TEXT NOT NULL,
    sender_hash      TEXT NOT NULL,
    payload_hash     TEXT NOT NULL,
    received_at      INTEGER NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'no_reply', 'draft_ready', 'quarantined', 'completed')),
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    claimed_at       INTEGER,
    last_error_code  TEXT,
    policy_version   INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, message_id),
    UNIQUE (inbox_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_message_work
     ON agentmail_messages(inbox_id, state, received_at, message_id)`,
  `CREATE TABLE IF NOT EXISTS agentmail_drafts (
    inbox_id                TEXT NOT NULL,
    draft_id                TEXT NOT NULL,
    kind                    TEXT NOT NULL CHECK (kind IN ('new', 'reply', 'reply_all', 'forward')),
    source_message_id       TEXT,
    thread_id               TEXT,
    operation_id            TEXT NOT NULL,
    client_id               TEXT NOT NULL,
    provider_revision       TEXT NOT NULL,
    provider_updated_at     INTEGER NOT NULL,
    material_hash           TEXT NOT NULL CHECK (length(material_hash) = 64),
    send_at                 INTEGER,
    state                   TEXT NOT NULL CHECK (state IN ('ready', 'stale', 'approved', 'sending', 'scheduled', 'sent', 'ambiguous', 'failed', 'deleted')),
    approval_generation     INTEGER NOT NULL DEFAULT 0 CHECK (approval_generation >= 0),
    approval_manifest_hash  TEXT CHECK (approval_manifest_hash IS NULL OR length(approval_manifest_hash) = 64),
    approved_at             INTEGER,
    send_operation_kind     TEXT CHECK (send_operation_kind IS NULL OR send_operation_kind IN ('send', 'schedule')),
    send_operation_id       TEXT,
    send_key                TEXT,
    send_started_at         INTEGER,
    sent_message_id         TEXT,
    sent_thread_id          TEXT,
    outcome_code            TEXT,
    reconciliation_state    TEXT NOT NULL DEFAULT 'none' CHECK (reconciliation_state IN ('none', 'required', 'confirmed_sent', 'confirmed_not_sent')),
    reconciliation_hash     TEXT CHECK (reconciliation_hash IS NULL OR length(reconciliation_hash) = 64),
    reconciled_at           INTEGER,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, draft_id),
    UNIQUE (inbox_id, operation_id),
    UNIQUE (inbox_id, client_id),
    CHECK (
      (kind = 'new' AND source_message_id IS NULL) OR
      (kind IN ('reply', 'reply_all', 'forward') AND source_message_id IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_draft_source_operation
     ON agentmail_drafts(inbox_id, source_message_id, operation_id)
     WHERE source_message_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_draft_state
     ON agentmail_drafts(inbox_id, state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS agentmail_draft_delivery_operations (
    inbox_id                 TEXT NOT NULL,
    operation_id             TEXT NOT NULL,
    draft_id                 TEXT NOT NULL,
    kind                     TEXT NOT NULL CHECK (kind IN ('send', 'schedule')),
    idempotency_key          TEXT NOT NULL,
    approval_generation      INTEGER NOT NULL CHECK (approval_generation >= 1),
    approval_manifest_hash   TEXT NOT NULL CHECK (length(approval_manifest_hash) = 64),
    provider_revision        TEXT NOT NULL,
    material_hash            TEXT NOT NULL CHECK (length(material_hash) = 64),
    send_at                  INTEGER,
    state                    TEXT NOT NULL CHECK (state IN ('reserved', 'scheduled', 'sent', 'outcome_unknown', 'failed', 'reconciled_not_sent')),
    sent_message_id          TEXT,
    sent_thread_id           TEXT,
    outcome_code             TEXT,
    reconciliation_hash      TEXT CHECK (reconciliation_hash IS NULL OR length(reconciliation_hash) = 64),
    reconciled_at            INTEGER,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, operation_id),
    UNIQUE (inbox_id, idempotency_key),
    FOREIGN KEY (inbox_id, draft_id)
      REFERENCES agentmail_drafts(inbox_id, draft_id) ON DELETE CASCADE,
    CHECK ((kind = 'schedule' AND send_at IS NOT NULL) OR (kind = 'send' AND send_at IS NULL)),
    CHECK ((state = 'sent' AND sent_message_id IS NOT NULL AND sent_thread_id IS NOT NULL) OR state <> 'sent'),
    CHECK ((state = 'outcome_unknown' AND reconciliation_hash IS NULL) OR state <> 'outcome_unknown')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_draft_delivery_active
     ON agentmail_draft_delivery_operations(inbox_id, draft_id)
     WHERE state IN ('reserved', 'scheduled', 'outcome_unknown')`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_draft_delivery_state
     ON agentmail_draft_delivery_operations(inbox_id, state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS agentmail_rate_reservations (
    inbox_id      TEXT NOT NULL,
    direction     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    operation_id  TEXT NOT NULL,
    actor_hash    TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    occurred_at   INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, direction, operation_id, actor_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_rate_window
     ON agentmail_rate_reservations(inbox_id, direction, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_rate_actor
     ON agentmail_rate_reservations(inbox_id, direction, actor_hash, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS agentmail_outbound_operations (
    inbox_id        TEXT NOT NULL,
    operation_id    TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    send_key        TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('reserved', 'sent', 'ambiguous', 'failed')),
    sent_message_id TEXT,
    sent_thread_id  TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, operation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_provider_events (
    inbox_id    TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    message_id  TEXT,
    payload_hash TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_creator_attention (
    inbox_id                   TEXT NOT NULL,
    attention_id               TEXT NOT NULL,
    kind                       TEXT NOT NULL CHECK (kind IN ('draft_ready', 'delivery_failure')),
    subject_id                 TEXT NOT NULL,
    related_message_id         TEXT,
    operation_key              TEXT NOT NULL,
    state                      TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'presented', 'failed', 'ambiguous', 'superseded', 'dismissed')),
    record_version             INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1),
    destination                TEXT,
    destination_binding_hash   TEXT,
    payload_hash               TEXT,
    max_attempts               INTEGER,
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_result_code           TEXT,
    settlement_hash            TEXT,
    notify_acknowledged_at     INTEGER,
    created_at                 INTEGER NOT NULL,
    updated_at                 INTEGER NOT NULL,
    settled_at                 INTEGER,
    PRIMARY KEY (inbox_id, attention_id),
    UNIQUE (inbox_id, operation_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_creator_attention_state
     ON agentmail_creator_attention(inbox_id, state, created_at, attention_id)`,
] as const;

function expectedSchema(): ReadonlyMap<string, string> {
  return new Map(
    SCHEMA.map((sql) => {
      const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
      if (!match?.[1]) throw new Error("agentMail store: invalid schema declaration");
      return [match[1], canonicalSqliteSchemaSql(sql)] as const;
    }),
  );
}

const EXPECTED_SCHEMA = expectedSchema();
const AGENTMAIL_ORCHESTRATION_CONTRACT_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify([
      AGENTMAIL_ORCHESTRATION_CONTRACT,
      [...EXPECTED_SCHEMA.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ]),
    "utf8",
  )
  .digest("hex");

function validateSchema(db: Database, objects: readonly SqliteSchemaObject[]): void {
  if (
    objects.length !== EXPECTED_SCHEMA.size ||
    !objects.every(
      (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
    )
  ) {
    throw new Error(
      "agentMail store: schema does not match the provider-native orchestration contract",
    );
  }
  const metadata = db
    .query<{ contract_fingerprint: string }, []>(
      "SELECT contract_fingerprint FROM agentmail_store_metadata WHERE singleton = 1",
    )
    .get();
  if (metadata?.contract_fingerprint !== AGENTMAIL_ORCHESTRATION_CONTRACT_FINGERPRINT) {
    throw new Error("agentMail store: orchestration contract fingerprint is missing or corrupt");
  }
}

export type AgentMailWorkState =
  | "pending"
  | "processing"
  | "no_reply"
  | "draft_ready"
  | "quarantined"
  | "completed";

export interface AgentMailWorkItem {
  inboxId: string;
  messageId: string;
  threadId: string;
  eventId?: string;
  classification: AgentMailMessageClassification;
  sender: string;
  senderHash: string;
  payloadHash: string;
  receivedAt: number;
  state: AgentMailWorkState;
  attemptCount: number;
  policyVersion: number;
}

export type AgentMailProviderDraftKind = "new" | "reply" | "reply_all" | "forward";
export type AgentMailProviderDraftState =
  | "ready"
  | "stale"
  | "approved"
  | "sending"
  | "scheduled"
  | "sent"
  | "ambiguous"
  | "failed"
  | "deleted";
export type AgentMailDraftDeliveryKind = "send" | "schedule";
export type AgentMailDraftDeliveryState =
  | "reserved"
  | "scheduled"
  | "sent"
  | "outcome_unknown"
  | "failed"
  | "reconciled_not_sent";

/**
 * Content-free provider draft projection. Material fields are represented only
 * by a SHA-256 digest; editable content remains exclusively in AgentMail.
 */
export interface AgentMailProviderDraftRecord {
  inboxId: string;
  draftId: string;
  kind: AgentMailProviderDraftKind;
  sourceMessageId?: string;
  threadId?: string;
  operationId: string;
  clientId: string;
  providerRevision: string;
  providerUpdatedAt: number;
  materialHash: string;
  sendAt?: number;
  state: AgentMailProviderDraftState;
  approvalGeneration: number;
  approvalManifestHash?: string;
  approvedAt?: number;
  sendOperationKind?: AgentMailDraftDeliveryKind;
  sendOperationId?: string;
  sendKey?: string;
  sendStartedAt?: number;
  sentMessageId?: string;
  sentThreadId?: string;
  outcomeCode?: string;
  reconciliationState: "none" | "required" | "confirmed_sent" | "confirmed_not_sent";
  reconciliationHash?: string;
  reconciledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailDraftDeliveryOperation {
  inboxId: string;
  operationId: string;
  draftId: string;
  kind: AgentMailDraftDeliveryKind;
  idempotencyKey: string;
  approvalGeneration: number;
  approvalManifestHash: string;
  providerRevision: string;
  materialHash: string;
  sendAt?: number;
  state: AgentMailDraftDeliveryState;
  sentMessageId?: string;
  sentThreadId?: string;
  outcomeCode?: string;
  reconciliationHash?: string;
  reconciledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailDraftReference {
  inboxId: string;
  sourceMessageId: string;
  threadId: string;
  draftId: string;
  clientId: string;
  providerUpdatedAt: number;
  state: "ready" | "stale" | "approved" | "sending" | "sent" | "ambiguous" | "failed";
  sendKey?: string;
  sendStartedAt?: number;
  sentMessageId?: string;
  sentThreadId?: string;
}

export type AgentMailRateReservation =
  | { status: "reserved" | "replay" }
  | {
      status: "rate_limited";
      reason: "global" | "actor" | "duplicate";
      retryAfterMs: number;
    }
  | { status: "conflict" };

export interface AgentMailOutboundOperation {
  operationId: string;
  payloadHash: string;
  sendKey: string;
  state: "reserved" | "sent" | "ambiguous" | "failed";
  sentMessageId?: string;
  sentThreadId?: string;
}

export type AgentMailCreatorAttentionKind = "draft_ready" | "delivery_failure";
export type AgentMailCreatorAttentionState =
  | "pending"
  | "dispatching"
  | "presented"
  | "failed"
  | "ambiguous"
  | "superseded"
  | "dismissed";

const AGENTMAIL_CREATOR_ATTENTION_STATES = new Set<AgentMailCreatorAttentionState>([
  "pending",
  "dispatching",
  "presented",
  "failed",
  "ambiguous",
  "superseded",
  "dismissed",
]);

/**
 * Metadata-only creator-attention outbox entry. Mail content, addresses, and
 * provider responses remain outside Auggy's orchestration database.
 */
export interface AgentMailCreatorAttentionRecord {
  inboxId: string;
  attentionId: string;
  kind: AgentMailCreatorAttentionKind;
  /** Provider draft ID for draft_ready; provider event ID for delivery_failure. */
  subjectId: string;
  relatedMessageId?: string;
  operationKey: string;
  state: AgentMailCreatorAttentionState;
  version: number;
  destination?: string;
  destinationBindingHash?: string;
  payloadHash?: string;
  maxAttempts?: number;
  attemptCount: number;
  lastResultCode?: string;
  settlementHash?: string;
  notifyAcknowledgedAt?: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
}

export type AgentMailCreatorAttentionSettlement =
  | { status: "retry"; attemptCount: number; resultCode: string }
  | {
      status: "presented" | "failed" | "ambiguous" | "dismissed";
      attemptCount: number;
      resultCode: string;
    };

export interface AgentMailOrchestrationStore {
  claimMessage(input: {
    messageId: string;
    threadId: string;
    eventId?: string;
    classification: AgentMailMessageClassification;
    sender: string;
    senderHash: string;
    payloadHash: string;
    receivedAt: number;
    policyVersion: number;
  }): { status: "claimed" | "duplicate" | "conflict" };
  claimNext(): AgentMailWorkItem | undefined;
  claimPending(messageId: string): AgentMailWorkItem | undefined;
  deferMessage(messageId: string, errorCode: string): void;
  settleMessage(
    messageId: string,
    outcome: "no_reply" | "draft_ready" | "quarantined" | "completed",
    errorCode?: string,
  ): void;
  recoverInterrupted(staleBefore: number): number;
  recoverAmbiguousMutations(): { drafts: number; outbound: number };
  recoverCreatorAttention(): { dispatching: number; superseded: number };
  getMessage(messageId: string): AgentMailWorkItem | undefined;
  hasPendingWork(): boolean;
  listPendingMessageIds(limit?: number): string[];
  advanceCheckpoint(timestamp: number, messageId: string): void;
  getCheckpoint(): { timestamp: number; messageId?: string };
  recordProviderDraft(input: {
    draftId: string;
    kind: AgentMailProviderDraftKind;
    sourceMessageId?: string;
    threadId?: string;
    operationId: string;
    clientId: string;
    providerRevision: string;
    providerUpdatedAt: number;
    materialHash: string;
    sendAt?: number;
  }): { status: "recorded" | "duplicate" | "conflict" };
  getProviderDraft(draftId: string): AgentMailProviderDraftRecord | undefined;
  listProviderDrafts(limit?: number): AgentMailProviderDraftRecord[];
  refreshProviderDraft(input: {
    draftId: string;
    expectedProviderRevision: string;
    providerRevision: string;
    providerUpdatedAt: number;
    materialHash: string;
    sendAt?: number;
  }): AgentMailProviderDraftRecord;
  approveProviderDraft(input: {
    draftId: string;
    expectedProviderRevision: string;
    expectedMaterialHash: string;
    approvalGeneration: number;
    manifestHash: string;
  }): AgentMailProviderDraftRecord;
  reserveProviderDraftDelivery(input: {
    draftId: string;
    operationId: string;
    kind: AgentMailDraftDeliveryKind;
    expectedProviderRevision: string;
    expectedMaterialHash: string;
    approvalGeneration: number;
    manifestHash: string;
    sendAt?: number;
  }):
    | { status: "reserved"; operation: AgentMailDraftDeliveryOperation }
    | { status: "replay" | "conflict"; operation: AgentMailDraftDeliveryOperation };
  getDraftDeliveryOperation(operationId: string): AgentMailDraftDeliveryOperation | undefined;
  settleProviderDraftDelivery(
    operationId: string,
    outcome:
      | { status: "scheduled"; sendAt: number }
      | { status: "sent"; messageId: string; threadId: string }
      | { status: "outcome_unknown"; code: string }
      | { status: "failed"; code: string },
  ): AgentMailDraftDeliveryOperation;
  reconcileProviderDraftDelivery(input: {
    operationId: string;
    evidenceHash: string;
    resolution: { status: "sent"; messageId: string; threadId: string } | { status: "not_sent" };
  }): AgentMailDraftDeliveryOperation;
  compact(input: { terminalBefore: number; maxRows: number }): {
    drafts: number;
    deliveryOperations: number;
    messages: number;
    outboundOperations: number;
    providerEvents: number;
    rateReservations: number;
    creatorAttention: number;
  };
  recordDraft(input: {
    sourceMessageId: string;
    threadId: string;
    draftId: string;
    clientId: string;
    providerUpdatedAt: number;
  }): { status: "recorded" | "duplicate" | "conflict" };
  getDraftByMessage(messageId: string): AgentMailDraftReference | undefined;
  getDraftById(draftId: string): AgentMailDraftReference | undefined;
  listDrafts(limit?: number): AgentMailDraftReference[];
  updateDraftReference(input: {
    sourceMessageId: string;
    expectedUpdatedAt: number;
    providerUpdatedAt: number;
  }): void;
  markThreadDraftsStale(threadId: string, exceptSourceMessageId: string): number;
  markDraftStale(sourceMessageId: string): void;
  approveDraft(input: {
    sourceMessageId: string;
    approvalEvidence: string;
    expectedUpdatedAt: number;
  }): void;
  reserveDraftSend(
    sourceMessageId: string,
  ): { status: "reserved"; sendKey: string } | { status: "replay"; draft: AgentMailDraftReference };
  settleDraftSend(
    sourceMessageId: string,
    outcome: { status: "sent"; messageId: string } | { status: "ambiguous" | "failed" | "ready" },
  ): void;
  reserveInboundRate(input: {
    messageId: string;
    senderHash: string;
    payloadHash: string;
    globalMaxPerHour: number;
    perSenderMaxPerHour: number;
  }): AgentMailRateReservation;
  reserveOutboundRate(input: {
    operationId: string;
    recipientHashes: string[];
    payloadHash: string;
    globalMaxPerHour: number;
    perRecipientCooldownMs: number;
    dedupWindowMs: number;
  }): AgentMailRateReservation;
  reserveOutboundOperation(input: { operationId: string; payloadHash: string }):
    | { status: "reserved"; operation: AgentMailOutboundOperation }
    | {
        status: "replay" | "conflict";
        operation: AgentMailOutboundOperation;
      };
  settleOutboundOperation(
    operationId: string,
    outcome:
      | { status: "sent"; messageId: string; threadId: string }
      | { status: "ambiguous" | "failed" },
  ): void;
  recordProviderEvent(input: {
    eventId: string;
    eventType: string;
    messageId?: string;
    payloadHash: string;
    observedAt: number;
  }): "recorded" | "duplicate" | "conflict";
  getCreatorAttention(attentionId: string): AgentMailCreatorAttentionRecord | undefined;
  listCreatorAttention(input?: {
    states?: readonly AgentMailCreatorAttentionState[];
    acknowledgementPending?: boolean;
    limit?: number;
  }): AgentMailCreatorAttentionRecord[];
  bindCreatorAttention(input: {
    attentionId: string;
    destination: string;
    destinationBindingHash: string;
    payloadHash: string;
    maxAttempts: number;
  }): { status: "bound" | "duplicate" | "conflict"; record: AgentMailCreatorAttentionRecord };
  claimCreatorAttention(attentionId: string): AgentMailCreatorAttentionRecord | undefined;
  settleCreatorAttention(input: {
    attentionId: string;
    expectedVersion: number;
    outcome: AgentMailCreatorAttentionSettlement;
  }): AgentMailCreatorAttentionRecord;
  acknowledgeCreatorAttention(input: {
    attentionId: string;
    expectedVersion: number;
    settlementHash: string;
  }): AgentMailCreatorAttentionRecord;
  close(): void;
}

interface StoreOptions {
  dbPath: string;
  inboxId: string;
  clock?: () => number;
  sendKey?: () => string;
}

interface MessageRow {
  inbox_id: string;
  message_id: string;
  thread_id: string;
  event_id: string | null;
  classification: AgentMailMessageClassification;
  sender_address: string;
  sender_hash: string;
  payload_hash: string;
  received_at: number;
  state: AgentMailWorkState;
  attempt_count: number;
  policy_version: number;
}

interface DraftRow {
  inbox_id: string;
  draft_id: string;
  kind: AgentMailProviderDraftKind;
  source_message_id: string | null;
  thread_id: string | null;
  operation_id: string;
  client_id: string;
  provider_revision: string;
  provider_updated_at: number;
  material_hash: string;
  send_at: number | null;
  state: AgentMailProviderDraftState;
  approval_generation: number;
  approval_manifest_hash: string | null;
  approved_at: number | null;
  send_operation_kind: AgentMailDraftDeliveryKind | null;
  send_operation_id: string | null;
  send_key: string | null;
  send_started_at: number | null;
  sent_message_id: string | null;
  sent_thread_id: string | null;
  outcome_code: string | null;
  reconciliation_state: AgentMailProviderDraftRecord["reconciliationState"];
  reconciliation_hash: string | null;
  reconciled_at: number | null;
  created_at: number;
  updated_at: number;
}

const DRAFT_COLUMNS = `inbox_id, draft_id, kind, source_message_id, thread_id,
  operation_id, client_id, provider_revision, provider_updated_at, material_hash, send_at, state,
  approval_generation, approval_manifest_hash, approved_at, send_operation_kind, send_operation_id,
  send_key, send_started_at, sent_message_id, sent_thread_id, outcome_code, reconciliation_state,
  reconciliation_hash, reconciled_at, created_at, updated_at`;

const DRAFT_DELIVERY_COLUMNS = `inbox_id, operation_id, draft_id, kind, idempotency_key,
  approval_generation, approval_manifest_hash, provider_revision, material_hash, send_at, state,
  sent_message_id, sent_thread_id, outcome_code, reconciliation_hash, reconciled_at,
  created_at, updated_at`;

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function assertBoundedIdentifier(value: string, field: string): void {
  let hasControlCharacter = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (!value || value.length > 1_024 || hasControlCharacter) {
    throw new Error(`agentMail store: ${field} is invalid`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agentMail store: ${field} must be a non-negative integer`);
  }
}

function assertOptionalTimestamp(value: number | undefined, field: string): void {
  if (value !== undefined) assertTimestamp(value, field);
}

function assertDraftIdentity(input: {
  draftId: string;
  kind: AgentMailProviderDraftKind;
  sourceMessageId?: string;
  threadId?: string;
  operationId: string;
  clientId: string;
  providerRevision: string;
  providerUpdatedAt: number;
  materialHash: string;
  sendAt?: number;
}): void {
  assertBoundedIdentifier(input.draftId, "draftId");
  assertBoundedIdentifier(input.operationId, "operationId");
  assertBoundedIdentifier(input.clientId, "clientId");
  assertBoundedIdentifier(input.providerRevision, "providerRevision");
  if (input.sourceMessageId !== undefined) {
    assertBoundedIdentifier(input.sourceMessageId, "sourceMessageId");
  }
  if (input.threadId !== undefined) assertBoundedIdentifier(input.threadId, "threadId");
  if (
    (input.kind === "new" && input.sourceMessageId !== undefined) ||
    (input.kind !== "new" && input.sourceMessageId === undefined)
  ) {
    throw new Error("agentMail store: provider draft kind and source message are inconsistent");
  }
  if (!validHash(input.materialHash)) {
    throw new Error("agentMail store: provider draft material hash is invalid");
  }
  assertTimestamp(input.providerUpdatedAt, "providerUpdatedAt");
  assertOptionalTimestamp(input.sendAt, "sendAt");
}

function messageFromRow(row: MessageRow): AgentMailWorkItem {
  return {
    inboxId: row.inbox_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    ...(row.event_id === null ? {} : { eventId: row.event_id }),
    classification: row.classification,
    sender: row.sender_address,
    senderHash: row.sender_hash,
    payloadHash: row.payload_hash,
    receivedAt: row.received_at,
    state: row.state,
    attemptCount: row.attempt_count,
    policyVersion: row.policy_version,
  };
}

function draftFromRow(row: DraftRow): AgentMailDraftReference {
  if (row.source_message_id === null || row.thread_id === null) {
    throw new Error("agentMail store: provider draft is not a legacy reply reference");
  }
  const state =
    row.state === "scheduled" ? "sending" : row.state === "deleted" ? "stale" : row.state;
  return {
    inboxId: row.inbox_id,
    sourceMessageId: row.source_message_id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    clientId: row.client_id,
    providerUpdatedAt: row.provider_updated_at,
    state,
    ...(row.send_key === null ? {} : { sendKey: row.send_key }),
    ...(row.send_started_at === null ? {} : { sendStartedAt: row.send_started_at }),
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.sent_thread_id === null ? {} : { sentThreadId: row.sent_thread_id }),
  };
}

function providerDraftFromRow(row: DraftRow): AgentMailProviderDraftRecord {
  return {
    inboxId: row.inbox_id,
    draftId: row.draft_id,
    kind: row.kind,
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    operationId: row.operation_id,
    clientId: row.client_id,
    providerRevision: row.provider_revision,
    providerUpdatedAt: row.provider_updated_at,
    materialHash: row.material_hash,
    ...(row.send_at === null ? {} : { sendAt: row.send_at }),
    state: row.state,
    approvalGeneration: row.approval_generation,
    ...(row.approval_manifest_hash === null
      ? {}
      : { approvalManifestHash: row.approval_manifest_hash }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.send_operation_kind === null ? {} : { sendOperationKind: row.send_operation_kind }),
    ...(row.send_operation_id === null ? {} : { sendOperationId: row.send_operation_id }),
    ...(row.send_key === null ? {} : { sendKey: row.send_key }),
    ...(row.send_started_at === null ? {} : { sendStartedAt: row.send_started_at }),
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.sent_thread_id === null ? {} : { sentThreadId: row.sent_thread_id }),
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code }),
    reconciliationState: row.reconciliation_state,
    ...(row.reconciliation_hash === null ? {} : { reconciliationHash: row.reconciliation_hash }),
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface DraftDeliveryRow {
  inbox_id: string;
  operation_id: string;
  draft_id: string;
  kind: AgentMailDraftDeliveryKind;
  idempotency_key: string;
  approval_generation: number;
  approval_manifest_hash: string;
  provider_revision: string;
  material_hash: string;
  send_at: number | null;
  state: AgentMailDraftDeliveryState;
  sent_message_id: string | null;
  sent_thread_id: string | null;
  outcome_code: string | null;
  reconciliation_hash: string | null;
  reconciled_at: number | null;
  created_at: number;
  updated_at: number;
}

function draftDeliveryFromRow(row: DraftDeliveryRow): AgentMailDraftDeliveryOperation {
  return {
    inboxId: row.inbox_id,
    operationId: row.operation_id,
    draftId: row.draft_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    approvalGeneration: row.approval_generation,
    approvalManifestHash: row.approval_manifest_hash,
    providerRevision: row.provider_revision,
    materialHash: row.material_hash,
    ...(row.send_at === null ? {} : { sendAt: row.send_at }),
    state: row.state,
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.sent_thread_id === null ? {} : { sentThreadId: row.sent_thread_id }),
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code }),
    ...(row.reconciliation_hash === null ? {} : { reconciliationHash: row.reconciliation_hash }),
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface OutboundOperationRow {
  operation_id: string;
  payload_hash: string;
  send_key: string;
  state: AgentMailOutboundOperation["state"];
  sent_message_id: string | null;
  sent_thread_id: string | null;
}

interface CreatorAttentionRow {
  inbox_id: string;
  attention_id: string;
  kind: AgentMailCreatorAttentionKind;
  subject_id: string;
  related_message_id: string | null;
  operation_key: string;
  state: AgentMailCreatorAttentionState;
  record_version: number;
  destination: string | null;
  destination_binding_hash: string | null;
  payload_hash: string | null;
  max_attempts: number | null;
  attempt_count: number;
  last_result_code: string | null;
  settlement_hash: string | null;
  notify_acknowledged_at: number | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

function outboundOperationFromRow(row: OutboundOperationRow): AgentMailOutboundOperation {
  return {
    operationId: row.operation_id,
    payloadHash: row.payload_hash,
    sendKey: row.send_key,
    state: row.state,
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.sent_thread_id === null ? {} : { sentThreadId: row.sent_thread_id }),
  };
}

function creatorAttentionFromRow(row: CreatorAttentionRow): AgentMailCreatorAttentionRecord {
  return {
    inboxId: row.inbox_id,
    attentionId: row.attention_id,
    kind: row.kind,
    subjectId: row.subject_id,
    ...(row.related_message_id === null ? {} : { relatedMessageId: row.related_message_id }),
    operationKey: row.operation_key,
    state: row.state,
    version: row.record_version,
    ...(row.destination === null ? {} : { destination: row.destination }),
    ...(row.destination_binding_hash === null
      ? {}
      : { destinationBindingHash: row.destination_binding_hash }),
    ...(row.payload_hash === null ? {} : { payloadHash: row.payload_hash }),
    ...(row.max_attempts === null ? {} : { maxAttempts: row.max_attempts }),
    attemptCount: row.attempt_count,
    ...(row.last_result_code === null ? {} : { lastResultCode: row.last_result_code }),
    ...(row.settlement_hash === null ? {} : { settlementHash: row.settlement_hash }),
    ...(row.notify_acknowledged_at === null
      ? {}
      : { notifyAcknowledgedAt: row.notify_acknowledged_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
  };
}

export function hashAgentMailOrchestrationValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function creatorAttentionIdentity(
  inboxId: string,
  kind: AgentMailCreatorAttentionKind,
  subjectId: string,
): { attentionId: string; operationKey: string } {
  const digest = hashAgentMailOrchestrationValue(
    JSON.stringify(["agentmail-creator-attention/v1", inboxId, kind, subjectId]),
  );
  return {
    attentionId: `attention.${digest}`,
    operationKey: `agentmail.attention.${digest}`,
  };
}

function creatorAttentionSettlementHash(
  record: Pick<
    AgentMailCreatorAttentionRecord,
    "attentionId" | "operationKey" | "state" | "attemptCount"
  >,
): string {
  return hashAgentMailOrchestrationValue(
    JSON.stringify([
      "agentmail-creator-attention-settlement/v1",
      record.attentionId,
      record.operationKey,
      record.state,
      record.attemptCount,
    ]),
  );
}

export function createAgentMailOrchestrationStore(
  options: StoreOptions,
): AgentMailOrchestrationStore {
  assertBoundedIdentifier(options.inboxId, "inboxId");
  const clock = options.clock ?? Date.now;
  const createSendKey = options.sendKey ?? (() => `auggy-${randomUUID()}`);
  const hardened = openHardenedSqlite({
    path: options.dbPath,
    label: "agentMail orchestration store",
    create: true,
    foreignKeys: true,
    synchronous: "FULL",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "agentMail orchestration store",
        applicationId: AGENTMAIL_ORCHESTRATION_APPLICATION_ID,
        schemaVersion: AGENTMAIL_ORCHESTRATION_SCHEMA_VERSION,
        initialize(database) {
          database
            .transaction(() => {
              for (const sql of SCHEMA) database.run(sql);
              database.run(
                `INSERT INTO agentmail_store_metadata(
                   singleton, contract_fingerprint, created_at
                 ) VALUES (1, ?, ?)`,
                [AGENTMAIL_ORCHESTRATION_CONTRACT_FINGERPRINT, clock()],
              );
            })
            .immediate();
        },
        validate: validateSchema,
        isLegacy: () => false,
      });
    },
  });
  const db = hardened.db;
  const inboxId = options.inboxId;
  db.run(
    `INSERT INTO agentmail_mailboxes(inbox_id, updated_at) VALUES (?, ?)
     ON CONFLICT(inbox_id) DO NOTHING`,
    [inboxId, clock()],
  );

  const findMessage = db.query<MessageRow, [string, string]>(
    `SELECT inbox_id, message_id, thread_id, event_id, classification, sender_address, sender_hash,
            payload_hash, received_at, state, attempt_count, policy_version
       FROM agentmail_messages WHERE inbox_id = ? AND message_id = ?`,
  );
  const findDraft = db.query<DraftRow, [string, string]>(
    `SELECT ${DRAFT_COLUMNS}
       FROM agentmail_drafts
      WHERE inbox_id = ? AND source_message_id = ?
      ORDER BY created_at ASC, draft_id ASC LIMIT 1`,
  );
  const findDraftById = db.query<DraftRow, [string, string]>(
    `SELECT ${DRAFT_COLUMNS}
       FROM agentmail_drafts WHERE inbox_id = ? AND draft_id = ?`,
  );
  const findDraftDelivery = db.query<DraftDeliveryRow, [string, string]>(
    `SELECT ${DRAFT_DELIVERY_COLUMNS}
       FROM agentmail_draft_delivery_operations
      WHERE inbox_id = ? AND operation_id = ?`,
  );
  const findCreatorAttention = db.query<CreatorAttentionRow, [string, string]>(
    `SELECT * FROM agentmail_creator_attention
      WHERE inbox_id = ? AND attention_id = ?`,
  );

  function enqueueCreatorAttention(input: {
    kind: AgentMailCreatorAttentionKind;
    subjectId: string;
    relatedMessageId?: string;
    state?: "pending" | "superseded";
  }): AgentMailCreatorAttentionRecord {
    assertBoundedIdentifier(input.subjectId, "attention subjectId");
    if (input.relatedMessageId !== undefined) {
      assertBoundedIdentifier(input.relatedMessageId, "attention relatedMessageId");
    }
    const identity = creatorAttentionIdentity(inboxId, input.kind, input.subjectId);
    const existing = findCreatorAttention.get(inboxId, identity.attentionId);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.subject_id !== input.subjectId ||
        existing.related_message_id !== (input.relatedMessageId ?? null) ||
        existing.operation_key !== identity.operationKey
      ) {
        throw new Error("agentMail store: creator attention identity conflict");
      }
      return creatorAttentionFromRow(existing);
    }
    const at = clock();
    const state = input.state ?? "pending";
    const settledAt = state === "superseded" ? at : null;
    const resultCode = state === "superseded" ? "draft_was_stale_at_creation" : null;
    db.run(
      `INSERT INTO agentmail_creator_attention(
         inbox_id, attention_id, kind, subject_id, related_message_id,
         operation_key, state, last_result_code, created_at, updated_at, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        inboxId,
        identity.attentionId,
        input.kind,
        input.subjectId,
        input.relatedMessageId ?? null,
        identity.operationKey,
        state,
        resultCode,
        at,
        at,
        settledAt,
      ],
    );
    const created = findCreatorAttention.get(inboxId, identity.attentionId);
    if (!created) throw new Error("agentMail store: creator attention was not persisted");
    if (state === "superseded") {
      const record = creatorAttentionFromRow(created);
      const settlementHash = creatorAttentionSettlementHash(record);
      db.run(
        `UPDATE agentmail_creator_attention
            SET settlement_hash = ?
          WHERE inbox_id = ? AND attention_id = ?`,
        [settlementHash, inboxId, identity.attentionId],
      );
      return creatorAttentionFromRow(findCreatorAttention.get(inboxId, identity.attentionId)!);
    }
    return creatorAttentionFromRow(created);
  }

  function supersedePendingDraftAttention(draftIdsSql: string, params: string[]): number {
    const candidates = db
      .query<CreatorAttentionRow, string[]>(
        `SELECT attention.* FROM agentmail_creator_attention AS attention
          WHERE attention.inbox_id = ? AND attention.kind = 'draft_ready'
            AND attention.state = 'pending' AND attention.subject_id IN (${draftIdsSql})`,
      )
      .all(inboxId, ...params);
    let changed = 0;
    for (const candidate of candidates) {
      const at = clock();
      const next = creatorAttentionFromRow({
        ...candidate,
        state: "superseded",
        record_version: candidate.record_version + 1,
        updated_at: at,
        settled_at: at,
      });
      const settlementHash = creatorAttentionSettlementHash(next);
      changed += db.run(
        `UPDATE agentmail_creator_attention
            SET state = 'superseded', record_version = record_version + 1,
                last_result_code = 'draft_no_longer_pending_review', settlement_hash = ?,
                updated_at = ?, settled_at = ?
          WHERE inbox_id = ? AND attention_id = ? AND state = 'pending'`,
        [settlementHash, at, at, inboxId, candidate.attention_id],
      ).changes;
    }
    return changed;
  }

  function enqueueRecordedDeliveryFailures(messageId: string): number {
    assertBoundedIdentifier(messageId, "delivery failure messageId");
    const failures = db
      .query<{ event_id: string }, [string, string]>(
        `SELECT event_id FROM agentmail_provider_events
          WHERE inbox_id = ? AND message_id = ?
            AND event_type IN ('message.bounced', 'message.complained', 'message.rejected')
          ORDER BY observed_at ASC, event_id ASC`,
      )
      .all(inboxId, messageId);
    for (const failure of failures) {
      enqueueCreatorAttention({
        kind: "delivery_failure",
        subjectId: failure.event_id,
        relatedMessageId: messageId,
      });
    }
    return failures.length;
  }

  const claimMessage = db.transaction(
    (input: Parameters<AgentMailOrchestrationStore["claimMessage"]>[0]) => {
      assertBoundedIdentifier(input.messageId, "messageId");
      assertBoundedIdentifier(input.threadId, "threadId");
      assertBoundedIdentifier(input.sender, "sender");
      if (input.eventId !== undefined) assertBoundedIdentifier(input.eventId, "eventId");
      if (!validHash(input.senderHash) || !validHash(input.payloadHash)) {
        throw new Error("agentMail store: claim hashes must be SHA-256 values");
      }
      if (
        !Number.isSafeInteger(input.receivedAt) ||
        input.receivedAt < 0 ||
        !Number.isSafeInteger(input.policyVersion) ||
        input.policyVersion < 1
      ) {
        throw new Error("agentMail store: claim timestamps and policy version are invalid");
      }
      const existing = findMessage.get(inboxId, input.messageId);
      if (existing) {
        return {
          status:
            existing.thread_id === input.threadId &&
            existing.payload_hash === input.payloadHash &&
            (existing.event_id === null ||
              input.eventId === undefined ||
              existing.event_id === input.eventId)
              ? "duplicate"
              : "conflict",
        } as const;
      }
      const at = clock();
      try {
        db.run(
          `INSERT INTO agentmail_messages(
             inbox_id, message_id, thread_id, event_id, classification, sender_address, sender_hash,
             payload_hash, received_at, state, policy_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            inboxId,
            input.messageId,
            input.threadId,
            input.eventId ?? null,
            input.classification,
            input.sender,
            input.senderHash,
            input.payloadHash,
            input.receivedAt,
            input.policyVersion,
            at,
            at,
          ],
        );
      } catch (error) {
        if (String(error).includes("UNIQUE")) return { status: "conflict" } as const;
        throw error;
      }
      return { status: "claimed" } as const;
    },
  );

  const claimNext = db.transaction(() => {
    const row = db
      .query<MessageRow, [string]>(
        `SELECT inbox_id, message_id, thread_id, event_id, classification, sender_address, sender_hash,
                payload_hash, received_at, state, attempt_count, policy_version
           FROM agentmail_messages
          WHERE inbox_id = ? AND state = 'pending'
          ORDER BY received_at ASC, message_id ASC LIMIT 1`,
      )
      .get(inboxId);
    if (!row) return undefined;
    const at = clock();
    db.run(
      `UPDATE agentmail_messages
          SET state = 'processing', attempt_count = attempt_count + 1,
              claimed_at = ?, updated_at = ?
        WHERE inbox_id = ? AND message_id = ? AND state = 'pending'`,
      [at, at, inboxId, row.message_id],
    );
    return {
      ...messageFromRow(row),
      state: "processing" as const,
      attemptCount: row.attempt_count + 1,
    };
  });

  const claimPending = db.transaction((messageId: string) => {
    assertBoundedIdentifier(messageId, "messageId");
    const row = findMessage.get(inboxId, messageId);
    if (row?.state !== "pending") return undefined;
    const at = clock();
    const result = db.run(
      `UPDATE agentmail_messages
          SET state = 'processing', attempt_count = attempt_count + 1,
              claimed_at = ?, updated_at = ?
        WHERE inbox_id = ? AND message_id = ? AND state = 'pending'`,
      [at, at, inboxId, messageId],
    );
    if (result.changes !== 1) return undefined;
    return {
      ...messageFromRow(row),
      state: "processing" as const,
      attemptCount: row.attempt_count + 1,
    };
  });

  const recordProviderDraft = db.transaction(
    (input: Parameters<AgentMailOrchestrationStore["recordProviderDraft"]>[0]) => {
      assertDraftIdentity(input);
      const existing = findDraftById.get(inboxId, input.draftId);
      if (existing) {
        const exact =
          existing.kind === input.kind &&
          existing.source_message_id === (input.sourceMessageId ?? null) &&
          existing.thread_id === (input.threadId ?? null) &&
          existing.operation_id === input.operationId &&
          existing.client_id === input.clientId &&
          existing.provider_revision === input.providerRevision &&
          existing.provider_updated_at === input.providerUpdatedAt &&
          existing.material_hash === input.materialHash &&
          existing.send_at === (input.sendAt ?? null);
        return { status: exact ? "duplicate" : "conflict" } as const;
      }

      const source =
        input.sourceMessageId === undefined
          ? undefined
          : findMessage.get(inboxId, input.sourceMessageId);
      if (source && input.threadId !== undefined && source.thread_id !== input.threadId) {
        throw new Error("agentMail store: draft source thread does not match the claimed message");
      }
      const threadId = input.threadId ?? source?.thread_id;
      let initialState: AgentMailProviderDraftState = "ready";
      if (source && (input.kind === "reply" || input.kind === "reply_all")) {
        const newerMessage = db
          .query<{ present: number }, [string, string, number, number, string]>(
            `SELECT 1 AS present FROM agentmail_messages
              WHERE inbox_id = ? AND thread_id = ?
                AND (received_at > ? OR (received_at = ? AND message_id > ?))
              LIMIT 1`,
          )
          .get(
            inboxId,
            source.thread_id,
            source.received_at,
            source.received_at,
            source.message_id,
          );
        if (newerMessage) initialState = "stale";
      }
      const at = clock();
      try {
        db.run(
          `INSERT INTO agentmail_drafts(
             inbox_id, draft_id, kind, source_message_id, thread_id, operation_id, client_id,
             provider_revision, provider_updated_at, material_hash, send_at, state,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inboxId,
            input.draftId,
            input.kind,
            input.sourceMessageId ?? null,
            threadId ?? null,
            input.operationId,
            input.clientId,
            input.providerRevision,
            input.providerUpdatedAt,
            input.materialHash,
            input.sendAt ?? null,
            initialState,
            at,
            at,
          ],
        );
      } catch (error) {
        if (String(error).includes("UNIQUE")) return { status: "conflict" } as const;
        throw error;
      }
      enqueueCreatorAttention({
        kind: "draft_ready",
        subjectId: input.draftId,
        ...(input.sourceMessageId === undefined ? {} : { relatedMessageId: input.sourceMessageId }),
        ...(initialState === "stale" ? { state: "superseded" as const } : {}),
      });
      return { status: "recorded" } as const;
    },
  );

  return {
    claimMessage(input) {
      return claimMessage.immediate(input);
    },
    claimNext() {
      return claimNext.immediate();
    },
    claimPending(messageId) {
      return claimPending.immediate(messageId);
    },
    deferMessage(messageId, errorCode) {
      assertBoundedIdentifier(messageId, "messageId");
      assertBoundedIdentifier(errorCode, "errorCode");
      const result = db.run(
        `UPDATE agentmail_messages
            SET state = 'pending', claimed_at = NULL, last_error_code = ?, updated_at = ?
          WHERE inbox_id = ? AND message_id = ? AND state = 'processing'`,
        [errorCode, clock(), inboxId, messageId],
      );
      if (result.changes !== 1) throw new Error("agentMail store: message is not actively claimed");
    },
    settleMessage(messageId, outcome, errorCode) {
      assertBoundedIdentifier(messageId, "messageId");
      if (errorCode !== undefined) assertBoundedIdentifier(errorCode, "errorCode");
      const result = db.run(
        `UPDATE agentmail_messages
            SET state = ?, claimed_at = NULL, last_error_code = ?, updated_at = ?
          WHERE inbox_id = ? AND message_id = ? AND state = 'processing'`,
        [outcome, errorCode ?? null, clock(), inboxId, messageId],
      );
      if (result.changes !== 1) throw new Error("agentMail store: message is not actively claimed");
    },
    recoverInterrupted(staleBefore) {
      if (!Number.isSafeInteger(staleBefore) || staleBefore < 0) {
        throw new Error("agentMail store: staleBefore must be a non-negative integer");
      }
      return db.run(
        `UPDATE agentmail_messages
            SET state = 'pending', claimed_at = NULL, last_error_code = 'interrupted', updated_at = ?
          WHERE inbox_id = ? AND state = 'processing' AND claimed_at <= ?`,
        [clock(), inboxId, staleBefore],
      ).changes;
    },
    recoverAmbiguousMutations() {
      return db
        .transaction(() => {
          const at = clock();
          db.run(
            `UPDATE agentmail_draft_delivery_operations
                SET state = 'outcome_unknown', outcome_code = 'interrupted_before_settlement',
                    updated_at = ?
              WHERE inbox_id = ? AND state = 'reserved'`,
            [at, inboxId],
          );
          const drafts = db.run(
            `UPDATE agentmail_drafts
                SET state = 'ambiguous', outcome_code = 'interrupted_before_settlement',
                    reconciliation_state = 'required', updated_at = ?
              WHERE inbox_id = ? AND state = 'sending'`,
            [at, inboxId],
          ).changes;
          const outbound = db.run(
            `UPDATE agentmail_outbound_operations SET state = 'ambiguous', updated_at = ?
              WHERE inbox_id = ? AND state = 'reserved'`,
            [at, inboxId],
          ).changes;
          return { drafts, outbound };
        })
        .immediate();
    },
    recoverCreatorAttention() {
      return db
        .transaction(() => {
          const dispatching = db.run(
            `UPDATE agentmail_creator_attention
                SET state = 'pending', record_version = record_version + 1,
                    last_result_code = 'interrupted_dispatch', updated_at = ?
              WHERE inbox_id = ? AND state = 'dispatching'`,
            [clock(), inboxId],
          ).changes;
          const obsoleteDrafts = db
            .query<{ draft_id: string }, [string]>(
              `SELECT draft_id FROM agentmail_drafts
                WHERE inbox_id = ? AND state IN ('stale', 'sent')`,
            )
            .all(inboxId);
          const superseded =
            obsoleteDrafts.length === 0
              ? 0
              : supersedePendingDraftAttention(
                  obsoleteDrafts.map(() => "?").join(", "),
                  obsoleteDrafts.map((draft) => draft.draft_id),
                );
          return { dispatching, superseded };
        })
        .immediate();
    },
    getMessage(messageId) {
      const row = findMessage.get(inboxId, messageId);
      return row ? messageFromRow(row) : undefined;
    },
    hasPendingWork() {
      return (
        (db
          .query<{ present: number }, [string]>(
            `SELECT 1 AS present FROM agentmail_messages
              WHERE inbox_id = ? AND state = 'pending' LIMIT 1`,
          )
          .get(inboxId)?.present ?? 0) === 1
      );
    },
    listPendingMessageIds(limit = 1_000) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("agentMail store: pending message limit must be between 1 and 10000");
      }
      return db
        .query<{ message_id: string }, [string, number]>(
          `SELECT message_id FROM agentmail_messages
            WHERE inbox_id = ? AND state = 'pending'
            ORDER BY received_at ASC, message_id ASC LIMIT ?`,
        )
        .all(inboxId, limit)
        .map((row) => row.message_id);
    },
    advanceCheckpoint(checkpointTimestamp, messageId) {
      if (!Number.isSafeInteger(checkpointTimestamp) || checkpointTimestamp < 0) {
        throw new Error("agentMail store: checkpoint timestamp is invalid");
      }
      const message = findMessage.get(inboxId, messageId);
      if (!message) throw new Error("agentMail store: checkpoint message must be durably claimed");
      const current = this.getCheckpoint();
      if (
        checkpointTimestamp < current.timestamp ||
        (checkpointTimestamp === current.timestamp &&
          current.messageId &&
          messageId <= current.messageId)
      ) {
        return;
      }
      db.run(
        `UPDATE agentmail_mailboxes
            SET checkpoint_timestamp = ?, checkpoint_message_id = ?, updated_at = ?
          WHERE inbox_id = ?`,
        [checkpointTimestamp, messageId, clock(), inboxId],
      );
    },
    getCheckpoint() {
      const row = db
        .query<{ checkpoint_timestamp: number; checkpoint_message_id: string | null }, [string]>(
          `SELECT checkpoint_timestamp, checkpoint_message_id
             FROM agentmail_mailboxes WHERE inbox_id = ?`,
        )
        .get(inboxId);
      return {
        timestamp: row?.checkpoint_timestamp ?? 0,
        ...(row?.checkpoint_message_id ? { messageId: row.checkpoint_message_id } : {}),
      };
    },
    recordProviderDraft(input) {
      return recordProviderDraft.immediate(input);
    },
    getProviderDraft(draftId) {
      assertBoundedIdentifier(draftId, "draftId");
      const row = findDraftById.get(inboxId, draftId);
      return row ? providerDraftFromRow(row) : undefined;
    },
    listProviderDrafts(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("agentMail store: provider draft limit must be between 1 and 1000");
      }
      return db
        .query<DraftRow, [string, number]>(
          `SELECT ${DRAFT_COLUMNS} FROM agentmail_drafts
            WHERE inbox_id = ? ORDER BY updated_at DESC, draft_id ASC LIMIT ?`,
        )
        .all(inboxId, limit)
        .map(providerDraftFromRow);
    },
    refreshProviderDraft(input) {
      assertBoundedIdentifier(input.draftId, "draftId");
      assertBoundedIdentifier(input.expectedProviderRevision, "expectedProviderRevision");
      assertBoundedIdentifier(input.providerRevision, "providerRevision");
      assertTimestamp(input.providerUpdatedAt, "providerUpdatedAt");
      assertOptionalTimestamp(input.sendAt, "sendAt");
      if (!validHash(input.materialHash)) {
        throw new Error("agentMail store: provider draft material hash is invalid");
      }
      return db
        .transaction(() => {
          const current = findDraftById.get(inboxId, input.draftId);
          if (!current) throw new Error("agentMail store: provider draft not found");
          if (current.provider_revision !== input.expectedProviderRevision) {
            throw new Error("agentMail store: provider draft revision changed before refresh");
          }
          if (
            current.provider_revision === input.providerRevision &&
            current.provider_updated_at === input.providerUpdatedAt &&
            current.material_hash === input.materialHash &&
            current.send_at === (input.sendAt ?? null)
          ) {
            return providerDraftFromRow(current);
          }
          if (
            current.provider_revision === input.providerRevision ||
            input.providerUpdatedAt < current.provider_updated_at
          ) {
            throw new Error("agentMail store: provider draft refresh did not advance its revision");
          }
          if (
            current.state === "sending" ||
            current.state === "scheduled" ||
            current.state === "sent" ||
            current.state === "ambiguous" ||
            current.state === "deleted"
          ) {
            throw new Error(
              "agentMail store: provider draft cannot be refreshed in its current state",
            );
          }
          const state = current.state === "stale" ? "stale" : "ready";
          const at = clock();
          const result = db.run(
            `UPDATE agentmail_drafts
                SET provider_revision = ?, provider_updated_at = ?, material_hash = ?, send_at = ?,
                    state = ?, approval_manifest_hash = NULL,
                    approved_at = NULL, send_operation_kind = NULL, send_operation_id = NULL,
                    send_key = NULL, send_started_at = NULL, outcome_code = NULL,
                    reconciliation_state = 'none', reconciliation_hash = NULL,
                    reconciled_at = NULL, updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND provider_revision = ?`,
            [
              input.providerRevision,
              input.providerUpdatedAt,
              input.materialHash,
              input.sendAt ?? null,
              state,
              at,
              inboxId,
              input.draftId,
              input.expectedProviderRevision,
            ],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: provider draft changed before refresh");
          }
          return providerDraftFromRow(findDraftById.get(inboxId, input.draftId)!);
        })
        .immediate();
    },
    approveProviderDraft(input) {
      assertBoundedIdentifier(input.draftId, "draftId");
      assertBoundedIdentifier(input.expectedProviderRevision, "expectedProviderRevision");
      if (
        !validHash(input.expectedMaterialHash) ||
        !validHash(input.manifestHash) ||
        !Number.isSafeInteger(input.approvalGeneration) ||
        input.approvalGeneration < 1
      ) {
        throw new Error("agentMail store: provider draft approval manifest is invalid");
      }
      return db
        .transaction(() => {
          const current = findDraftById.get(inboxId, input.draftId);
          if (!current || input.approvalGeneration !== current.approval_generation + 1) {
            throw new Error("agentMail store: provider draft approval generation is not monotonic");
          }
          const at = clock();
          const result = db.run(
            `UPDATE agentmail_drafts
                SET state = 'approved', approval_generation = ?, approval_manifest_hash = ?,
                    approved_at = ?, updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND state = 'ready'
                AND provider_revision = ? AND material_hash = ?
                AND approval_generation = ?`,
            [
              input.approvalGeneration,
              input.manifestHash,
              at,
              at,
              inboxId,
              input.draftId,
              input.expectedProviderRevision,
              input.expectedMaterialHash,
              current.approval_generation,
            ],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: provider draft changed or is not awaiting approval");
          }
          return providerDraftFromRow(findDraftById.get(inboxId, input.draftId)!);
        })
        .immediate();
    },
    reserveProviderDraftDelivery(input) {
      assertBoundedIdentifier(input.draftId, "draftId");
      assertBoundedIdentifier(input.operationId, "operationId");
      assertBoundedIdentifier(input.expectedProviderRevision, "expectedProviderRevision");
      if (
        !validHash(input.expectedMaterialHash) ||
        !validHash(input.manifestHash) ||
        !Number.isSafeInteger(input.approvalGeneration) ||
        input.approvalGeneration < 1
      ) {
        throw new Error("agentMail store: draft delivery manifest is invalid");
      }
      if (
        (input.kind === "schedule" && input.sendAt === undefined) ||
        (input.kind === "send" && input.sendAt !== undefined)
      ) {
        throw new Error("agentMail store: draft delivery kind and schedule are inconsistent");
      }
      assertOptionalTimestamp(input.sendAt, "sendAt");
      return db
        .transaction(() => {
          const existing = findDraftDelivery.get(inboxId, input.operationId);
          if (existing) {
            const exact =
              existing.draft_id === input.draftId &&
              existing.kind === input.kind &&
              existing.approval_generation === input.approvalGeneration &&
              existing.approval_manifest_hash === input.manifestHash &&
              existing.provider_revision === input.expectedProviderRevision &&
              existing.material_hash === input.expectedMaterialHash &&
              existing.send_at === (input.sendAt ?? null);
            return {
              status: exact ? "replay" : "conflict",
              operation: draftDeliveryFromRow(existing),
            } as const;
          }
          const draft = findDraftById.get(inboxId, input.draftId);
          if (
            draft?.state !== "approved" ||
            draft.provider_revision !== input.expectedProviderRevision ||
            draft.material_hash !== input.expectedMaterialHash ||
            draft.approval_generation !== input.approvalGeneration ||
            draft.approval_manifest_hash !== input.manifestHash
          ) {
            throw new Error("agentMail store: draft approval changed before delivery reservation");
          }
          if (input.kind === "schedule" && draft.send_at !== (input.sendAt ?? null)) {
            throw new Error("agentMail store: draft schedule changed before delivery reservation");
          }
          const idempotencyKey = createSendKey();
          if (!/^[A-Za-z0-9._~-]{1,256}$/.test(idempotencyKey)) {
            throw new Error("agentMail store: generated send key is invalid");
          }
          const at = clock();
          try {
            db.run(
              `INSERT INTO agentmail_draft_delivery_operations(
                 inbox_id, operation_id, draft_id, kind, idempotency_key,
                 approval_generation, approval_manifest_hash, provider_revision,
                 material_hash, send_at, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
              [
                inboxId,
                input.operationId,
                input.draftId,
                input.kind,
                idempotencyKey,
                input.approvalGeneration,
                input.manifestHash,
                input.expectedProviderRevision,
                input.expectedMaterialHash,
                input.sendAt ?? null,
                at,
                at,
              ],
            );
          } catch (error) {
            if (String(error).includes("UNIQUE")) {
              throw new Error("agentMail store: another delivery operation is already active");
            }
            throw error;
          }
          const updated = db.run(
            `UPDATE agentmail_drafts
                SET state = 'sending', send_operation_kind = ?, send_operation_id = ?,
                    send_key = ?, send_started_at = ?, outcome_code = NULL,
                    reconciliation_state = 'none', reconciliation_hash = NULL,
                    reconciled_at = NULL, updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND state = 'approved'`,
            [input.kind, input.operationId, idempotencyKey, at, at, inboxId, input.draftId],
          );
          if (updated.changes !== 1) {
            throw new Error("agentMail store: draft changed during delivery reservation");
          }
          return {
            status: "reserved",
            operation: draftDeliveryFromRow(findDraftDelivery.get(inboxId, input.operationId)!),
          } as const;
        })
        .immediate();
    },
    getDraftDeliveryOperation(operationId) {
      assertBoundedIdentifier(operationId, "operationId");
      const row = findDraftDelivery.get(inboxId, operationId);
      return row ? draftDeliveryFromRow(row) : undefined;
    },
    settleProviderDraftDelivery(operationId, outcome) {
      assertBoundedIdentifier(operationId, "operationId");
      if (outcome.status === "scheduled") assertTimestamp(outcome.sendAt, "sendAt");
      if (outcome.status === "sent") {
        assertBoundedIdentifier(outcome.messageId, "messageId");
        assertBoundedIdentifier(outcome.threadId, "threadId");
      }
      if (outcome.status === "outcome_unknown" || outcome.status === "failed") {
        assertBoundedIdentifier(outcome.code, "outcomeCode");
      }
      return db
        .transaction(() => {
          const operation = findDraftDelivery.get(inboxId, operationId);
          if (!operation) {
            throw new Error("agentMail store: no reserved draft delivery to settle");
          }
          if (operation.state !== "reserved" && operation.state !== "scheduled") {
            const exact =
              (outcome.status === "sent" &&
                operation.state === "sent" &&
                operation.sent_message_id === outcome.messageId &&
                operation.sent_thread_id === outcome.threadId) ||
              ((outcome.status === "outcome_unknown" || outcome.status === "failed") &&
                operation.state === outcome.status &&
                operation.outcome_code === outcome.code);
            if (exact) return draftDeliveryFromRow(operation);
            throw new Error("agentMail store: draft delivery was already settled differently");
          }
          if (
            operation.state === "scheduled" &&
            outcome.status === "scheduled" &&
            operation.send_at === outcome.sendAt
          ) {
            return draftDeliveryFromRow(operation);
          }
          if (
            (outcome.status === "scheduled" &&
              (operation.state !== "reserved" ||
                operation.kind !== "schedule" ||
                operation.send_at !== outcome.sendAt)) ||
            (operation.kind === "send" && outcome.status === "scheduled")
          ) {
            throw new Error("agentMail store: draft delivery settlement does not match its kind");
          }
          const nextOperationState: AgentMailDraftDeliveryState =
            outcome.status === "outcome_unknown" ? "outcome_unknown" : outcome.status;
          const nextDraftState: AgentMailProviderDraftState =
            outcome.status === "scheduled"
              ? "scheduled"
              : outcome.status === "outcome_unknown"
                ? "ambiguous"
                : outcome.status === "failed"
                  ? operation.state === "scheduled"
                    ? "failed"
                    : "approved"
                  : "sent";
          const at = clock();
          db.run(
            `UPDATE agentmail_draft_delivery_operations
                SET state = ?, sent_message_id = ?, sent_thread_id = ?, outcome_code = ?,
                    updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = ?`,
            [
              nextOperationState,
              outcome.status === "sent" ? outcome.messageId : null,
              outcome.status === "sent" ? outcome.threadId : null,
              outcome.status === "outcome_unknown" || outcome.status === "failed"
                ? outcome.code
                : null,
              at,
              inboxId,
              operationId,
              operation.state,
            ],
          );
          db.run(
            `UPDATE agentmail_drafts
                SET state = ?, sent_message_id = ?, sent_thread_id = ?, outcome_code = ?,
                    reconciliation_state = ?, updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND state = ?
                AND send_operation_id = ?`,
            [
              nextDraftState,
              outcome.status === "sent" ? outcome.messageId : null,
              outcome.status === "sent" ? outcome.threadId : null,
              outcome.status === "outcome_unknown" || outcome.status === "failed"
                ? outcome.code
                : null,
              outcome.status === "outcome_unknown" ? "required" : "none",
              at,
              inboxId,
              operation.draft_id,
              operation.state === "scheduled" ? "scheduled" : "sending",
              operationId,
            ],
          );
          if (outcome.status === "sent") {
            supersedePendingDraftAttention("?", [operation.draft_id]);
            enqueueRecordedDeliveryFailures(outcome.messageId);
          }
          return draftDeliveryFromRow(findDraftDelivery.get(inboxId, operationId)!);
        })
        .immediate();
    },
    reconcileProviderDraftDelivery(input) {
      assertBoundedIdentifier(input.operationId, "operationId");
      if (!validHash(input.evidenceHash)) {
        throw new Error("agentMail store: reconciliation evidence hash is invalid");
      }
      if (input.resolution.status === "sent") {
        assertBoundedIdentifier(input.resolution.messageId, "messageId");
        assertBoundedIdentifier(input.resolution.threadId, "threadId");
      }
      return db
        .transaction(() => {
          const operation = findDraftDelivery.get(inboxId, input.operationId);
          if (!operation) throw new Error("agentMail store: draft delivery operation not found");
          const resolvedState = input.resolution.status === "sent" ? "sent" : "reconciled_not_sent";
          if (operation.state !== "outcome_unknown") {
            const exact =
              operation.state === resolvedState &&
              operation.reconciliation_hash === input.evidenceHash &&
              (input.resolution.status !== "sent" ||
                (operation.sent_message_id === input.resolution.messageId &&
                  operation.sent_thread_id === input.resolution.threadId));
            if (exact) return draftDeliveryFromRow(operation);
            throw new Error("agentMail store: draft delivery is not awaiting reconciliation");
          }
          const at = clock();
          db.run(
            `UPDATE agentmail_draft_delivery_operations
                SET state = ?, sent_message_id = ?, sent_thread_id = ?,
                    reconciliation_hash = ?, reconciled_at = ?, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = 'outcome_unknown'`,
            [
              resolvedState,
              input.resolution.status === "sent" ? input.resolution.messageId : null,
              input.resolution.status === "sent" ? input.resolution.threadId : null,
              input.evidenceHash,
              at,
              at,
              inboxId,
              input.operationId,
            ],
          );
          db.run(
            `UPDATE agentmail_drafts
                SET state = ?, sent_message_id = ?, sent_thread_id = ?,
                    reconciliation_state = ?, reconciliation_hash = ?, reconciled_at = ?,
                    updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND state = 'ambiguous'
                AND send_operation_id = ? AND reconciliation_state = 'required'`,
            [
              input.resolution.status === "sent" ? "sent" : "approved",
              input.resolution.status === "sent" ? input.resolution.messageId : null,
              input.resolution.status === "sent" ? input.resolution.threadId : null,
              input.resolution.status === "sent" ? "confirmed_sent" : "confirmed_not_sent",
              input.evidenceHash,
              at,
              at,
              inboxId,
              operation.draft_id,
              input.operationId,
            ],
          );
          if (input.resolution.status === "sent") {
            supersedePendingDraftAttention("?", [operation.draft_id]);
            enqueueRecordedDeliveryFailures(input.resolution.messageId);
          }
          return draftDeliveryFromRow(findDraftDelivery.get(inboxId, input.operationId)!);
        })
        .immediate();
    },
    compact(input) {
      assertTimestamp(input.terminalBefore, "terminalBefore");
      if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > 100_000) {
        throw new Error("agentMail store: compaction maxRows must be between 1 and 100000");
      }
      return db
        .transaction(() => {
          let remaining = input.maxRows;
          const remove = (sql: string, bindings: Array<string | number>): number => {
            if (remaining === 0) return 0;
            const changed = db.run(sql, [...bindings, remaining]).changes;
            remaining -= changed;
            return changed;
          };
          const creatorAttention = remove(
            `DELETE FROM agentmail_creator_attention WHERE rowid IN (
               SELECT rowid FROM agentmail_creator_attention
                WHERE inbox_id = ? AND updated_at < ?
                  AND state IN ('presented', 'failed', 'superseded', 'dismissed')
                  AND (destination IS NULL OR notify_acknowledged_at IS NOT NULL)
                ORDER BY updated_at ASC, attention_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const deliveryOperations = remove(
            `DELETE FROM agentmail_draft_delivery_operations WHERE rowid IN (
               SELECT delivery.rowid FROM agentmail_draft_delivery_operations AS delivery
                WHERE delivery.inbox_id = ? AND delivery.updated_at < ?
                  AND delivery.state IN ('sent', 'failed', 'reconciled_not_sent')
                  AND EXISTS (
                    SELECT 1 FROM agentmail_drafts AS draft
                     WHERE draft.inbox_id = delivery.inbox_id
                       AND draft.draft_id = delivery.draft_id
                       AND draft.state IN ('stale', 'sent', 'deleted')
                  )
                ORDER BY delivery.updated_at ASC, delivery.operation_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const drafts = remove(
            `DELETE FROM agentmail_drafts WHERE rowid IN (
               SELECT draft.rowid FROM agentmail_drafts AS draft
                WHERE draft.inbox_id = ? AND draft.updated_at < ?
                  AND draft.state IN ('stale', 'sent', 'deleted')
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_creator_attention AS attention
                     WHERE attention.inbox_id = draft.inbox_id
                       AND attention.subject_id = draft.draft_id
                       AND attention.state IN ('pending', 'dispatching', 'ambiguous')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_draft_delivery_operations AS delivery
                     WHERE delivery.inbox_id = draft.inbox_id
                       AND delivery.draft_id = draft.draft_id
                       AND delivery.state IN ('reserved', 'scheduled', 'outcome_unknown')
                  )
                ORDER BY draft.updated_at ASC, draft.draft_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const messages = remove(
            `DELETE FROM agentmail_messages WHERE rowid IN (
               SELECT message.rowid FROM agentmail_messages AS message
                WHERE message.inbox_id = ? AND message.updated_at < ?
                  AND message.state IN ('no_reply', 'draft_ready', 'quarantined', 'completed')
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_drafts AS draft
                     WHERE draft.inbox_id = message.inbox_id
                       AND draft.source_message_id = message.message_id
                  )
                ORDER BY message.updated_at ASC, message.message_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const outboundOperations = remove(
            `DELETE FROM agentmail_outbound_operations WHERE rowid IN (
               SELECT rowid FROM agentmail_outbound_operations
                WHERE inbox_id = ? AND updated_at < ? AND state IN ('sent', 'failed')
                ORDER BY updated_at ASC, operation_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const providerEvents = remove(
            `DELETE FROM agentmail_provider_events WHERE rowid IN (
               SELECT event.rowid FROM agentmail_provider_events AS event
                WHERE event.inbox_id = ? AND event.observed_at < ?
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_creator_attention AS attention
                     WHERE attention.inbox_id = event.inbox_id
                       AND attention.subject_id = event.event_id
                       AND attention.state IN ('pending', 'dispatching', 'ambiguous')
                  )
                ORDER BY event.observed_at ASC, event.event_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const rateReservations = remove(
            `DELETE FROM agentmail_rate_reservations WHERE rowid IN (
               SELECT rowid FROM agentmail_rate_reservations
                WHERE inbox_id = ? AND occurred_at < ?
                ORDER BY occurred_at ASC, operation_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          return {
            drafts,
            deliveryOperations,
            messages,
            outboundOperations,
            providerEvents,
            rateReservations,
            creatorAttention,
          };
        })
        .immediate();
    },
    recordDraft(input) {
      for (const [field, value] of Object.entries(input)) {
        if (field !== "providerUpdatedAt") assertBoundedIdentifier(String(value), field);
      }
      assertTimestamp(input.providerUpdatedAt, "providerUpdatedAt");
      const existing = findDraft.get(inboxId, input.sourceMessageId);
      if (existing) {
        return {
          status:
            existing.draft_id === input.draftId &&
            existing.client_id === input.clientId &&
            existing.provider_updated_at === input.providerUpdatedAt
              ? "duplicate"
              : "conflict",
        } as const;
      }
      const source = findMessage.get(inboxId, input.sourceMessageId);
      if (!source || source.thread_id !== input.threadId) {
        throw new Error("agentMail store: legacy draft source does not match claimed message");
      }
      const materialHash = hashAgentMailOrchestrationValue(
        JSON.stringify([
          "agentmail-legacy-draft-reference/v1",
          input.sourceMessageId,
          input.threadId,
          input.draftId,
          input.clientId,
          input.providerUpdatedAt,
        ]),
      );
      return recordProviderDraft.immediate({
        draftId: input.draftId,
        kind: "reply",
        sourceMessageId: input.sourceMessageId,
        threadId: input.threadId,
        operationId: input.clientId,
        clientId: input.clientId,
        providerRevision: `updated-at:${input.providerUpdatedAt}`,
        providerUpdatedAt: input.providerUpdatedAt,
        materialHash,
      });
    },
    getDraftByMessage(messageId) {
      const row = findDraft.get(inboxId, messageId);
      return row ? draftFromRow(row) : undefined;
    },
    getDraftById(draftId) {
      assertBoundedIdentifier(draftId, "draftId");
      const row = findDraftById.get(inboxId, draftId);
      return row?.source_message_id && row.thread_id ? draftFromRow(row) : undefined;
    },
    listDrafts(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("agentMail store: draft limit must be between 1 and 1000");
      }
      return db
        .query<DraftRow, [string, number]>(
          `SELECT ${DRAFT_COLUMNS} FROM agentmail_drafts
            WHERE inbox_id = ? AND source_message_id IS NOT NULL AND thread_id IS NOT NULL
             ORDER BY updated_at DESC, draft_id ASC LIMIT ?`,
        )
        .all(inboxId, limit)
        .map(draftFromRow);
    },
    updateDraftReference(input) {
      if (
        !Number.isSafeInteger(input.expectedUpdatedAt) ||
        input.expectedUpdatedAt < 0 ||
        !Number.isSafeInteger(input.providerUpdatedAt) ||
        input.providerUpdatedAt < input.expectedUpdatedAt
      ) {
        throw new Error("agentMail store: provider draft timestamps are invalid");
      }
      db.transaction(() => {
        const current = findDraft.get(inboxId, input.sourceMessageId);
        if (
          !current ||
          current.provider_updated_at !== input.expectedUpdatedAt ||
          !["ready", "stale", "failed"].includes(current.state)
        ) {
          throw new Error("agentMail store: draft changed or cannot return to review");
        }
        const providerRevision = `updated-at:${input.providerUpdatedAt}`;
        const materialHash = hashAgentMailOrchestrationValue(
          JSON.stringify([
            "agentmail-legacy-draft-refresh/v1",
            current.material_hash,
            providerRevision,
          ]),
        );
        const result = db.run(
          `UPDATE agentmail_drafts
              SET provider_revision = ?, provider_updated_at = ?, material_hash = ?,
                  state = 'ready', approval_manifest_hash = NULL, approved_at = NULL,
                  send_operation_kind = NULL, send_operation_id = NULL,
                  send_key = NULL, send_started_at = NULL, outcome_code = NULL,
                  reconciliation_state = 'none', reconciliation_hash = NULL,
                  reconciled_at = NULL, updated_at = ?
            WHERE inbox_id = ? AND draft_id = ? AND provider_updated_at = ?
              AND state IN ('ready', 'stale', 'failed')`,
          [
            providerRevision,
            input.providerUpdatedAt,
            materialHash,
            clock(),
            inboxId,
            current.draft_id,
            input.expectedUpdatedAt,
          ],
        );
        if (result.changes !== 1) {
          throw new Error("agentMail store: draft changed or cannot return to review");
        }
      }).immediate();
    },
    markThreadDraftsStale(threadId, exceptSourceMessageId) {
      assertBoundedIdentifier(threadId, "threadId");
      assertBoundedIdentifier(exceptSourceMessageId, "exceptSourceMessageId");
      return db
        .transaction(() => {
          const drafts = db
            .query<{ draft_id: string }, [string, string, string]>(
              `SELECT draft_id FROM agentmail_drafts
                WHERE inbox_id = ? AND thread_id = ? AND source_message_id <> ?
                  AND state IN ('ready', 'approved')`,
            )
            .all(inboxId, threadId, exceptSourceMessageId);
          const result = db.run(
            `UPDATE agentmail_drafts
                SET state = 'stale', approval_manifest_hash = NULL,
                    approved_at = NULL, updated_at = ?
              WHERE inbox_id = ? AND thread_id = ? AND source_message_id <> ?
                AND state IN ('ready', 'approved')`,
            [clock(), inboxId, threadId, exceptSourceMessageId],
          );
          if (drafts.length > 0) {
            supersedePendingDraftAttention(
              drafts.map(() => "?").join(", "),
              drafts.map((draft) => draft.draft_id),
            );
          }
          return result.changes;
        })
        .immediate();
    },
    markDraftStale(sourceMessageId) {
      assertBoundedIdentifier(sourceMessageId, "sourceMessageId");
      db.transaction(() => {
        const draft = findDraft.get(inboxId, sourceMessageId);
        const result = db.run(
          `UPDATE agentmail_drafts
              SET state = 'stale', approval_manifest_hash = NULL,
                  approved_at = NULL, updated_at = ?
            WHERE inbox_id = ? AND source_message_id = ? AND state IN ('ready', 'approved')`,
          [clock(), inboxId, sourceMessageId],
        );
        if (result.changes === 1 && draft) {
          supersedePendingDraftAttention("?", [draft.draft_id]);
        }
      }).immediate();
    },
    approveDraft(input) {
      if (
        input.approvalEvidence.trim().length === 0 ||
        Buffer.byteLength(input.approvalEvidence, "utf8") > 4_096
      ) {
        throw new Error("agentMail store: approval evidence is invalid");
      }
      const current = findDraft.get(inboxId, input.sourceMessageId);
      if (!current) throw new Error("agentMail store: draft changed or is not awaiting review");
      const at = clock();
      const result = db.run(
        `UPDATE agentmail_drafts
            SET state = 'approved', approval_generation = approval_generation + 1,
                approval_manifest_hash = ?, approved_at = ?, updated_at = ?
          WHERE inbox_id = ? AND draft_id = ? AND state = 'ready'
            AND provider_updated_at = ?`,
        [
          hashAgentMailOrchestrationValue(input.approvalEvidence),
          at,
          at,
          inboxId,
          current.draft_id,
          input.expectedUpdatedAt,
        ],
      );
      if (result.changes !== 1) {
        throw new Error("agentMail store: draft changed or is not awaiting review");
      }
    },
    reserveDraftSend(sourceMessageId) {
      return db
        .transaction(() => {
          const row = findDraft.get(inboxId, sourceMessageId);
          if (!row) throw new Error("agentMail store: draft reference not found");
          if (row.state !== "approved")
            return { status: "replay" as const, draft: draftFromRow(row) };
          const sendKey = createSendKey();
          if (!/^[A-Za-z0-9._~-]{1,256}$/.test(sendKey)) {
            throw new Error("agentMail store: generated send key is invalid");
          }
          const at = clock();
          const operationId = `legacy-send:${row.draft_id}:${row.approval_generation}`;
          const result = db.run(
            `UPDATE agentmail_drafts
                SET state = 'sending', send_operation_kind = 'send', send_operation_id = ?,
                    send_key = ?, send_started_at = ?, outcome_code = NULL,
                    reconciliation_state = 'none', reconciliation_hash = NULL,
                    reconciled_at = NULL, updated_at = ?
              WHERE inbox_id = ? AND draft_id = ? AND state = 'approved'`,
            [operationId, sendKey, at, at, inboxId, row.draft_id],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: draft changed during send reservation");
          }
          return { status: "reserved" as const, sendKey };
        })
        .immediate();
    },
    settleDraftSend(sourceMessageId, outcome) {
      assertBoundedIdentifier(sourceMessageId, "sourceMessageId");
      if (outcome.status === "sent") assertBoundedIdentifier(outcome.messageId, "messageId");
      const state = outcome.status;
      db.transaction(() => {
        const draft = findDraft.get(inboxId, sourceMessageId);
        const result = db.run(
          `UPDATE agentmail_drafts
              SET state = ?, sent_message_id = ?,
                  send_key = CASE WHEN ? = 'ready' THEN NULL ELSE send_key END,
                  send_started_at = CASE WHEN ? = 'ready' THEN NULL ELSE send_started_at END,
                  send_operation_kind = CASE WHEN ? = 'ready' THEN NULL ELSE send_operation_kind END,
                  send_operation_id = CASE WHEN ? = 'ready' THEN NULL ELSE send_operation_id END,
                  outcome_code = CASE
                    WHEN ? = 'ambiguous' THEN 'legacy_outcome_unknown'
                    WHEN ? = 'failed' THEN 'legacy_send_failed'
                    ELSE NULL
                  END,
                  reconciliation_state = CASE WHEN ? = 'ambiguous' THEN 'required' ELSE 'none' END,
                  updated_at = ?
            WHERE inbox_id = ? AND draft_id = ? AND state = 'sending'`,
          [
            state,
            outcome.status === "sent" ? outcome.messageId : null,
            state,
            state,
            state,
            state,
            state,
            state,
            state,
            clock(),
            inboxId,
            draft?.draft_id ?? "",
          ],
        );
        if (result.changes !== 1) throw new Error("agentMail store: no reserved send to settle");
        if (outcome.status === "sent" && draft) {
          supersedePendingDraftAttention("?", [draft.draft_id]);
          enqueueRecordedDeliveryFailures(outcome.messageId);
        }
      }).immediate();
    },
    reserveInboundRate(input) {
      assertBoundedIdentifier(input.messageId, "messageId");
      if (!validHash(input.senderHash) || !validHash(input.payloadHash)) {
        throw new Error("agentMail store: inbound rate hashes are invalid");
      }
      if (
        !Number.isSafeInteger(input.globalMaxPerHour) ||
        input.globalMaxPerHour < 1 ||
        !Number.isSafeInteger(input.perSenderMaxPerHour) ||
        input.perSenderMaxPerHour < 1
      ) {
        throw new Error("agentMail store: inbound rate policy is invalid");
      }
      return db
        .transaction((): AgentMailRateReservation => {
          const existing = db
            .query<{ payload_hash: string }, [string, string, string]>(
              `SELECT payload_hash FROM agentmail_rate_reservations
                WHERE inbox_id = ? AND direction = 'inbound'
                  AND operation_id = ? AND actor_hash = ?`,
            )
            .get(inboxId, input.messageId, input.senderHash);
          if (existing) {
            return existing.payload_hash === input.payloadHash
              ? { status: "replay" }
              : { status: "conflict" };
          }
          const at = clock();
          const cutoff = at - 3_600_000;
          const globalCount =
            db
              .query<{ count: number }, [string, number]>(
                `SELECT COUNT(*) AS count FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'inbound' AND occurred_at > ?`,
              )
              .get(inboxId, cutoff)?.count ?? 0;
          if (globalCount >= input.globalMaxPerHour) {
            return { status: "rate_limited", reason: "global", retryAfterMs: 3_600_000 };
          }
          const actorCount =
            db
              .query<{ count: number }, [string, string, number]>(
                `SELECT COUNT(*) AS count FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'inbound'
                    AND actor_hash = ? AND occurred_at > ?`,
              )
              .get(inboxId, input.senderHash, cutoff)?.count ?? 0;
          if (actorCount >= input.perSenderMaxPerHour) {
            return { status: "rate_limited", reason: "actor", retryAfterMs: 3_600_000 };
          }
          db.run(
            `INSERT INTO agentmail_rate_reservations(
               inbox_id, direction, operation_id, actor_hash, payload_hash, occurred_at
             ) VALUES (?, 'inbound', ?, ?, ?, ?)`,
            [inboxId, input.messageId, input.senderHash, input.payloadHash, at],
          );
          return { status: "reserved" };
        })
        .immediate();
    },
    reserveOutboundRate(input) {
      assertBoundedIdentifier(input.operationId, "operationId");
      if (!validHash(input.payloadHash) || input.recipientHashes.some((hash) => !validHash(hash))) {
        throw new Error("agentMail store: outbound rate hashes are invalid");
      }
      if (
        input.recipientHashes.length === 0 ||
        new Set(input.recipientHashes).size !== input.recipientHashes.length ||
        !Number.isSafeInteger(input.globalMaxPerHour) ||
        input.globalMaxPerHour < 1 ||
        !Number.isSafeInteger(input.perRecipientCooldownMs) ||
        input.perRecipientCooldownMs < 0 ||
        !Number.isSafeInteger(input.dedupWindowMs) ||
        input.dedupWindowMs < 0
      ) {
        throw new Error("agentMail store: outbound rate policy is invalid");
      }
      return db
        .transaction((): AgentMailRateReservation => {
          const existing = db
            .query<{ actor_hash: string; payload_hash: string }, [string, string]>(
              `SELECT actor_hash, payload_hash FROM agentmail_rate_reservations
                WHERE inbox_id = ? AND direction = 'outbound' AND operation_id = ?`,
            )
            .all(inboxId, input.operationId);
          if (existing.length > 0) {
            const expectedActors = [...input.recipientHashes].sort();
            const actualActors = existing.map((row) => row.actor_hash).sort();
            return existing.every((row) => row.payload_hash === input.payloadHash) &&
              JSON.stringify(actualActors) === JSON.stringify(expectedActors)
              ? { status: "replay" }
              : { status: "conflict" };
          }
          const at = clock();
          const hourCutoff = at - 3_600_000;
          const globalCount =
            db
              .query<{ count: number }, [string, number]>(
                `SELECT COUNT(DISTINCT operation_id) AS count
                   FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'outbound' AND occurred_at > ?`,
              )
              .get(inboxId, hourCutoff)?.count ?? 0;
          if (globalCount >= input.globalMaxPerHour) {
            return { status: "rate_limited", reason: "global", retryAfterMs: 3_600_000 };
          }
          if (input.dedupWindowMs > 0) {
            const duplicate = db
              .query<{ present: number }, [string, string, number]>(
                `SELECT 1 AS present FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'outbound'
                    AND payload_hash = ? AND occurred_at > ? LIMIT 1`,
              )
              .get(inboxId, input.payloadHash, at - input.dedupWindowMs);
            if (duplicate) {
              return {
                status: "rate_limited",
                reason: "duplicate",
                retryAfterMs: input.dedupWindowMs,
              };
            }
          }
          for (const recipientHash of input.recipientHashes) {
            const latest = db
              .query<{ occurred_at: number }, [string, string]>(
                `SELECT occurred_at FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'outbound' AND actor_hash = ?
                  ORDER BY occurred_at DESC LIMIT 1`,
              )
              .get(inboxId, recipientHash);
            if (latest && at - latest.occurred_at < input.perRecipientCooldownMs) {
              return {
                status: "rate_limited",
                reason: "actor",
                retryAfterMs: input.perRecipientCooldownMs - (at - latest.occurred_at),
              };
            }
          }
          for (const recipientHash of input.recipientHashes) {
            db.run(
              `INSERT INTO agentmail_rate_reservations(
                 inbox_id, direction, operation_id, actor_hash, payload_hash, occurred_at
               ) VALUES (?, 'outbound', ?, ?, ?, ?)`,
              [inboxId, input.operationId, recipientHash, input.payloadHash, at],
            );
          }
          return { status: "reserved" };
        })
        .immediate();
    },
    reserveOutboundOperation(input) {
      assertBoundedIdentifier(input.operationId, "operationId");
      if (!validHash(input.payloadHash)) {
        throw new Error("agentMail store: outbound operation hash is invalid");
      }
      return db
        .transaction(() => {
          const find = () =>
            db
              .query<OutboundOperationRow, [string, string]>(
                `SELECT operation_id, payload_hash, send_key, state,
                        sent_message_id, sent_thread_id
                   FROM agentmail_outbound_operations
                  WHERE inbox_id = ? AND operation_id = ?`,
              )
              .get(inboxId, input.operationId);
          const existing = find();
          if (existing) {
            return {
              status: existing.payload_hash === input.payloadHash ? "replay" : "conflict",
              operation: outboundOperationFromRow(existing),
            } as const;
          }
          const sendKey = createSendKey();
          if (!/^[A-Za-z0-9._~-]{1,256}$/.test(sendKey)) {
            throw new Error("agentMail store: generated send key is invalid");
          }
          const at = clock();
          db.run(
            `INSERT INTO agentmail_outbound_operations(
               inbox_id, operation_id, payload_hash, send_key, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)`,
            [inboxId, input.operationId, input.payloadHash, sendKey, at, at],
          );
          const created = find();
          if (!created) throw new Error("agentMail store: outbound reservation was not persisted");
          return { status: "reserved", operation: outboundOperationFromRow(created) } as const;
        })
        .immediate();
    },
    settleOutboundOperation(operationId, outcome) {
      assertBoundedIdentifier(operationId, "operationId");
      if (outcome.status === "sent") {
        assertBoundedIdentifier(outcome.messageId, "messageId");
        assertBoundedIdentifier(outcome.threadId, "threadId");
      }
      db.transaction(() => {
        const result = db.run(
          `UPDATE agentmail_outbound_operations
              SET state = ?, sent_message_id = ?, sent_thread_id = ?, updated_at = ?
            WHERE inbox_id = ? AND operation_id = ? AND state = 'reserved'`,
          [
            outcome.status,
            outcome.status === "sent" ? outcome.messageId : null,
            outcome.status === "sent" ? outcome.threadId : null,
            clock(),
            inboxId,
            operationId,
          ],
        );
        if (result.changes !== 1) {
          throw new Error("agentMail store: no reserved outbound operation to settle");
        }
        if (outcome.status === "sent") enqueueRecordedDeliveryFailures(outcome.messageId);
      }).immediate();
    },
    recordProviderEvent(input) {
      if (!validHash(input.payloadHash)) throw new Error("agentMail store: event hash is invalid");
      assertBoundedIdentifier(input.eventId, "eventId");
      assertBoundedIdentifier(input.eventType, "eventType");
      if (input.messageId !== undefined) assertBoundedIdentifier(input.messageId, "messageId");
      if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
        throw new Error("agentMail store: event timestamp is invalid");
      }
      return db
        .transaction(() => {
          const existing = db
            .query<
              { payload_hash: string; event_type: string; message_id: string | null },
              [string, string]
            >(
              `SELECT payload_hash, event_type, message_id FROM agentmail_provider_events
                WHERE inbox_id = ? AND event_id = ?`,
            )
            .get(inboxId, input.eventId);
          if (existing) {
            return existing.payload_hash === input.payloadHash &&
              existing.event_type === input.eventType &&
              existing.message_id === (input.messageId ?? null)
              ? "duplicate"
              : "conflict";
          }
          db.run(
            `INSERT INTO agentmail_provider_events(
               inbox_id, event_id, event_type, message_id, payload_hash, observed_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              inboxId,
              input.eventId,
              input.eventType,
              input.messageId ?? null,
              input.payloadHash,
              input.observedAt,
            ],
          );
          if (
            input.messageId !== undefined &&
            (input.eventType === "message.bounced" ||
              input.eventType === "message.complained" ||
              input.eventType === "message.rejected")
          ) {
            const managed = db
              .query<{ present: number }, [string, string, string, string]>(
                `SELECT 1 AS present FROM agentmail_drafts
                  WHERE inbox_id = ? AND sent_message_id = ? AND state = 'sent'
                UNION ALL
                SELECT 1 AS present FROM agentmail_outbound_operations
                  WHERE inbox_id = ? AND sent_message_id = ? AND state = 'sent'
                LIMIT 1`,
              )
              .get(inboxId, input.messageId, inboxId, input.messageId);
            if (managed) {
              enqueueCreatorAttention({
                kind: "delivery_failure",
                subjectId: input.eventId,
                relatedMessageId: input.messageId,
              });
            }
          }
          return "recorded";
        })
        .immediate();
    },
    getCreatorAttention(attentionId) {
      assertBoundedIdentifier(attentionId, "attentionId");
      const row = findCreatorAttention.get(inboxId, attentionId);
      return row ? creatorAttentionFromRow(row) : undefined;
    },
    listCreatorAttention(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("agentMail store: creator attention limit must be between 1 and 1000");
      }
      const states = input.states;
      if (
        states !== undefined &&
        (states.length === 0 ||
          new Set(states).size !== states.length ||
          states.some((state) => !AGENTMAIL_CREATOR_ATTENTION_STATES.has(state)))
      ) {
        throw new Error("agentMail store: creator attention states are invalid");
      }
      if (
        input.acknowledgementPending !== undefined &&
        typeof input.acknowledgementPending !== "boolean"
      ) {
        throw new Error("agentMail store: acknowledgementPending must be a boolean");
      }
      const stateClause = states ? ` AND state IN (${states.map(() => "?").join(", ")})` : "";
      const acknowledgementClause = input.acknowledgementPending
        ? " AND destination IS NOT NULL AND settlement_hash IS NOT NULL AND notify_acknowledged_at IS NULL"
        : "";
      const bindings: Array<string | number> = [inboxId, ...(states ?? []), limit];
      return db
        .query<CreatorAttentionRow, Array<string | number>>(
          `SELECT * FROM agentmail_creator_attention
            WHERE inbox_id = ?${stateClause}${acknowledgementClause}
            ORDER BY created_at ASC, attention_id ASC LIMIT ?`,
        )
        .all(...bindings)
        .map(creatorAttentionFromRow);
    },
    bindCreatorAttention(input) {
      assertBoundedIdentifier(input.attentionId, "attentionId");
      assertBoundedIdentifier(input.destination, "attention destination");
      if (!validHash(input.destinationBindingHash) || !validHash(input.payloadHash)) {
        throw new Error("agentMail store: creator attention binding hashes are invalid");
      }
      if (
        !Number.isSafeInteger(input.maxAttempts) ||
        input.maxAttempts < 1 ||
        input.maxAttempts > 20
      ) {
        throw new Error("agentMail store: creator attention maxAttempts must be between 1 and 20");
      }
      return db
        .transaction(() => {
          const existing = findCreatorAttention.get(inboxId, input.attentionId);
          if (!existing) throw new Error("agentMail store: creator attention not found");
          const exact =
            existing.destination === input.destination &&
            existing.destination_binding_hash === input.destinationBindingHash &&
            existing.payload_hash === input.payloadHash &&
            existing.max_attempts === input.maxAttempts;
          const terminal =
            existing.state === "presented" ||
            existing.state === "failed" ||
            existing.state === "superseded" ||
            existing.state === "dismissed";
          if (
            existing.notify_acknowledged_at !== null ||
            (terminal && existing.destination === null)
          ) {
            return {
              status: "duplicate",
              record: creatorAttentionFromRow(existing),
            } as const;
          }
          if (existing.destination !== null || existing.state !== "pending") {
            return {
              status: exact ? "duplicate" : "conflict",
              record: creatorAttentionFromRow(existing),
            } as const;
          }
          const at = clock();
          const result = db.run(
            `UPDATE agentmail_creator_attention
                SET destination = ?, destination_binding_hash = ?, payload_hash = ?,
                    max_attempts = ?, record_version = record_version + 1, updated_at = ?
              WHERE inbox_id = ? AND attention_id = ? AND state = 'pending'
                AND destination IS NULL AND destination_binding_hash IS NULL
                AND payload_hash IS NULL AND max_attempts IS NULL`,
            [
              input.destination,
              input.destinationBindingHash,
              input.payloadHash,
              input.maxAttempts,
              at,
              inboxId,
              input.attentionId,
            ],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: creator attention changed while binding target");
          }
          return {
            status: "bound",
            record: creatorAttentionFromRow(findCreatorAttention.get(inboxId, input.attentionId)!),
          } as const;
        })
        .immediate();
    },
    claimCreatorAttention(attentionId) {
      assertBoundedIdentifier(attentionId, "attentionId");
      return db
        .transaction(() => {
          const current = findCreatorAttention.get(inboxId, attentionId);
          if (
            current?.state !== "pending" ||
            current.destination === null ||
            current.destination_binding_hash === null ||
            current.payload_hash === null ||
            current.max_attempts === null
          ) {
            return undefined;
          }
          const result = db.run(
            `UPDATE agentmail_creator_attention
                SET state = 'dispatching', record_version = record_version + 1, updated_at = ?
              WHERE inbox_id = ? AND attention_id = ? AND state = 'pending'
                AND destination IS NOT NULL AND destination_binding_hash IS NOT NULL
                AND payload_hash IS NOT NULL AND max_attempts IS NOT NULL`,
            [clock(), inboxId, attentionId],
          );
          if (result.changes !== 1) return undefined;
          return creatorAttentionFromRow(findCreatorAttention.get(inboxId, attentionId)!);
        })
        .immediate();
    },
    settleCreatorAttention(input) {
      assertBoundedIdentifier(input.attentionId, "attentionId");
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error("agentMail store: creator attention expectedVersion is invalid");
      }
      if (
        !Number.isSafeInteger(input.outcome.attemptCount) ||
        input.outcome.attemptCount < 0 ||
        input.outcome.attemptCount > 20 ||
        !/^[a-z0-9_-]{1,64}$/.test(input.outcome.resultCode)
      ) {
        throw new Error("agentMail store: creator attention result is invalid");
      }
      return db
        .transaction(() => {
          const currentRow = findCreatorAttention.get(inboxId, input.attentionId);
          if (
            currentRow?.state !== "dispatching" ||
            currentRow.record_version !== input.expectedVersion
          ) {
            throw new Error("agentMail store: creator attention changed before settlement");
          }
          if (
            currentRow.max_attempts === null ||
            input.outcome.attemptCount < currentRow.attempt_count ||
            (input.outcome.status === "retry" &&
              input.outcome.attemptCount >= currentRow.max_attempts)
          ) {
            throw new Error("agentMail store: creator attention attempt count is inconsistent");
          }
          const nextState = input.outcome.status === "retry" ? "pending" : input.outcome.status;
          const at = clock();
          const terminal =
            nextState === "presented" || nextState === "failed" || nextState === "dismissed";
          const nextRecord = creatorAttentionFromRow({
            ...currentRow,
            state: nextState,
            record_version: currentRow.record_version + 1,
            attempt_count: input.outcome.attemptCount,
            last_result_code: input.outcome.resultCode,
            settlement_hash: null,
            updated_at: at,
            settled_at: terminal ? at : null,
          });
          const settlementHash = terminal ? creatorAttentionSettlementHash(nextRecord) : null;
          const result = db.run(
            `UPDATE agentmail_creator_attention
                SET state = ?, record_version = record_version + 1, attempt_count = ?,
                    last_result_code = ?, settlement_hash = ?, updated_at = ?, settled_at = ?
              WHERE inbox_id = ? AND attention_id = ? AND state = 'dispatching'
                AND record_version = ?`,
            [
              nextState,
              input.outcome.attemptCount,
              input.outcome.resultCode,
              settlementHash,
              at,
              terminal ? at : null,
              inboxId,
              input.attentionId,
              input.expectedVersion,
            ],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: creator attention changed before settlement");
          }
          return creatorAttentionFromRow(findCreatorAttention.get(inboxId, input.attentionId)!);
        })
        .immediate();
    },
    acknowledgeCreatorAttention(input) {
      assertBoundedIdentifier(input.attentionId, "attentionId");
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        !validHash(input.settlementHash)
      ) {
        throw new Error("agentMail store: creator attention acknowledgement is invalid");
      }
      return db
        .transaction(() => {
          const current = findCreatorAttention.get(inboxId, input.attentionId);
          if (!current) throw new Error("agentMail store: creator attention not found");
          if (
            current.notify_acknowledged_at !== null &&
            current.settlement_hash === input.settlementHash
          ) {
            return creatorAttentionFromRow(current);
          }
          if (
            current.record_version !== input.expectedVersion ||
            current.settlement_hash !== input.settlementHash ||
            (current.state !== "presented" &&
              current.state !== "failed" &&
              current.state !== "superseded" &&
              current.state !== "dismissed")
          ) {
            throw new Error("agentMail store: creator attention cannot be acknowledged");
          }
          const at = clock();
          const result = db.run(
            `UPDATE agentmail_creator_attention
                SET notify_acknowledged_at = ?, record_version = record_version + 1, updated_at = ?
              WHERE inbox_id = ? AND attention_id = ? AND record_version = ?
                AND notify_acknowledged_at IS NULL`,
            [at, at, inboxId, input.attentionId, input.expectedVersion],
          );
          if (result.changes !== 1) {
            throw new Error("agentMail store: creator attention changed before acknowledgement");
          }
          return creatorAttentionFromRow(findCreatorAttention.get(inboxId, input.attentionId)!);
        })
        .immediate();
    },
    close() {
      try {
        hardened.checkpoint("TRUNCATE");
      } finally {
        hardened.close();
      }
    },
  };
}

import { createHash } from "node:crypto";
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
  `CREATE TABLE IF NOT EXISTS agentmail_draft_mutations (
    inbox_id                    TEXT NOT NULL,
    operation_id               TEXT NOT NULL,
    draft_id                   TEXT,
    kind                       TEXT NOT NULL CHECK (kind IN ('create', 'revise', 'schedule', 'unschedule', 'delete')),
    draft_kind                 TEXT NOT NULL CHECK (draft_kind IN ('new', 'reply', 'reply_all', 'forward')),
    source_message_id          TEXT,
    thread_id                  TEXT,
    client_id                  TEXT NOT NULL,
    expected_provider_revision TEXT,
    expected_material_hash     TEXT CHECK (expected_material_hash IS NULL OR length(expected_material_hash) = 64),
    manifest_hash              TEXT NOT NULL CHECK (length(manifest_hash) = 64),
    send_at                    INTEGER,
    prior_draft_state          TEXT CHECK (prior_draft_state IS NULL OR prior_draft_state IN ('ready', 'stale', 'approved', 'scheduled', 'failed')),
    state                      TEXT NOT NULL CHECK (state IN ('prepared', 'dispatching', 'updated', 'deleted', 'outcome_unknown', 'failed', 'reconciled_not_applied')),
    result_draft_id            TEXT,
    result_provider_revision   TEXT,
    result_provider_updated_at INTEGER,
    result_material_hash       TEXT CHECK (result_material_hash IS NULL OR length(result_material_hash) = 64),
    result_send_at             INTEGER,
    outcome_code               TEXT,
    reconciliation_hash        TEXT CHECK (reconciliation_hash IS NULL OR length(reconciliation_hash) = 64),
    reconciled_at              INTEGER,
    created_at                 INTEGER NOT NULL,
    dispatch_started_at        INTEGER,
    updated_at                 INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, operation_id),
    CHECK (
      (draft_kind = 'new' AND source_message_id IS NULL) OR
      (draft_kind IN ('reply', 'reply_all', 'forward') AND source_message_id IS NOT NULL)
    ),
    CHECK (
      (kind = 'create' AND draft_id IS NULL AND expected_provider_revision IS NULL AND expected_material_hash IS NULL AND prior_draft_state IS NULL) OR
      (kind <> 'create' AND draft_id IS NOT NULL AND expected_provider_revision IS NOT NULL AND expected_material_hash IS NOT NULL AND prior_draft_state IS NOT NULL)
    ),
    CHECK ((kind = 'schedule' AND send_at IS NOT NULL) OR (kind <> 'schedule' AND send_at IS NULL)),
    CHECK ((state = 'deleted' AND kind = 'delete') OR state <> 'deleted'),
    CHECK ((state = 'updated' AND result_draft_id IS NOT NULL AND result_provider_revision IS NOT NULL AND result_provider_updated_at IS NOT NULL AND result_material_hash IS NOT NULL) OR state <> 'updated'),
    CHECK ((state = 'deleted' AND result_draft_id IS NOT NULL) OR state <> 'deleted')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_draft_mutation_create_client
     ON agentmail_draft_mutations(inbox_id, client_id)
     WHERE kind = 'create'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_draft_mutation_active
     ON agentmail_draft_mutations(inbox_id, draft_id)
     WHERE draft_id IS NOT NULL AND state IN ('prepared', 'dispatching', 'outcome_unknown')`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_draft_mutation_state
     ON agentmail_draft_mutations(inbox_id, state, updated_at)`,
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
  `CREATE TABLE IF NOT EXISTS agentmail_delivery_operations (
    inbox_id                  TEXT NOT NULL,
    operation_id              TEXT NOT NULL,
    action                    TEXT NOT NULL CHECK (action IN ('send_draft', 'send_message', 'reply', 'forward')),
    endpoint                  TEXT NOT NULL CHECK (endpoint IN ('drafts.send', 'messages.send', 'messages.reply', 'messages.forward')),
    draft_id                  TEXT,
    source_message_id         TEXT,
    thread_id                 TEXT,
    draft_kind                TEXT CHECK (draft_kind IS NULL OR draft_kind IN ('new', 'reply', 'reply_all', 'forward')),
    approval_generation       INTEGER NOT NULL CHECK (approval_generation >= 1),
    approval_manifest_hash    TEXT NOT NULL CHECK (length(approval_manifest_hash) = 64),
    provider_revision         TEXT,
    material_hash             TEXT CHECK (material_hash IS NULL OR length(material_hash) = 64),
    request_hash              TEXT NOT NULL CHECK (length(request_hash) = 64),
    idempotency_key           TEXT NOT NULL,
    state                     TEXT NOT NULL CHECK (state IN ('prepared', 'dispatching', 'retryable', 'sent', 'outcome_unknown', 'failed', 'reconciled_not_sent')),
    first_dispatch_at         INTEGER,
    attempt_count             INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    retry_after               INTEGER,
    sent_message_id           TEXT,
    sent_thread_id            TEXT,
    outcome_code              TEXT,
    reconciliation_hash       TEXT CHECK (reconciliation_hash IS NULL OR length(reconciliation_hash) = 64),
    reconciled_at             INTEGER,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, operation_id),
    UNIQUE (inbox_id, idempotency_key),
    CHECK (
      (action = 'send_draft' AND endpoint = 'drafts.send' AND draft_id IS NOT NULL AND draft_kind IS NOT NULL AND provider_revision IS NOT NULL AND material_hash IS NOT NULL) OR
      (action = 'send_message' AND endpoint = 'messages.send' AND draft_id IS NULL AND source_message_id IS NULL AND thread_id IS NULL AND draft_kind IS NULL AND provider_revision IS NULL AND material_hash IS NULL) OR
      (action = 'reply' AND endpoint = 'messages.reply' AND draft_id IS NULL AND source_message_id IS NOT NULL AND thread_id IS NOT NULL AND draft_kind IS NULL AND provider_revision IS NULL AND material_hash IS NULL) OR
      (action = 'forward' AND endpoint = 'messages.forward' AND draft_id IS NULL AND source_message_id IS NOT NULL AND thread_id IS NOT NULL AND draft_kind IS NULL AND provider_revision IS NULL AND material_hash IS NULL)
    ),
    CHECK (
      action <> 'send_draft' OR
      (draft_kind = 'new' AND source_message_id IS NULL) OR
      (draft_kind IN ('reply', 'reply_all', 'forward') AND source_message_id IS NOT NULL AND thread_id IS NOT NULL)
    ),
    CHECK ((state = 'prepared' AND first_dispatch_at IS NULL AND attempt_count = 0) OR state <> 'prepared'),
    CHECK ((state = 'retryable' AND retry_after IS NOT NULL) OR (state <> 'retryable' AND retry_after IS NULL)),
    CHECK ((state = 'sent' AND sent_message_id IS NOT NULL AND sent_thread_id IS NOT NULL) OR state <> 'sent'),
    CHECK ((state = 'outcome_unknown' AND reconciliation_hash IS NULL) OR state <> 'outcome_unknown')
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmail_delivery_active_draft
     ON agentmail_delivery_operations(inbox_id, draft_id)
     WHERE draft_id IS NOT NULL AND state IN ('prepared', 'dispatching', 'retryable', 'outcome_unknown')`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_delivery_state
     ON agentmail_delivery_operations(inbox_id, state, updated_at)`,
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
export type AgentMailProviderDraftMutationKind =
  | "create"
  | "revise"
  | "schedule"
  | "unschedule"
  | "delete";
export type AgentMailProviderDraftMutationState =
  | "prepared"
  | "dispatching"
  | "updated"
  | "deleted"
  | "outcome_unknown"
  | "failed"
  | "reconciled_not_applied";

export interface AgentMailProviderDraftMutationOperation {
  inboxId: string;
  operationId: string;
  draftId?: string;
  kind: AgentMailProviderDraftMutationKind;
  draftKind: AgentMailProviderDraftKind;
  sourceMessageId?: string;
  threadId?: string;
  clientId: string;
  expectedProviderRevision?: string;
  expectedMaterialHash?: string;
  manifestHash: string;
  sendAt?: number;
  priorDraftState?: "ready" | "stale" | "approved" | "scheduled" | "failed";
  state: AgentMailProviderDraftMutationState;
  resultDraftId?: string;
  resultProviderRevision?: string;
  resultProviderUpdatedAt?: number;
  resultMaterialHash?: string;
  resultSendAt?: number;
  outcomeCode?: string;
  reconciliationHash?: string;
  reconciledAt?: number;
  createdAt: number;
  dispatchStartedAt?: number;
  updatedAt: number;
}

export type AgentMailProviderDraftMutationReservation =
  | {
      kind: "create";
      operationId: string;
      draftKind: AgentMailProviderDraftKind;
      sourceMessageId?: string;
      threadId?: string;
      clientId: string;
      manifestHash: string;
    }
  | {
      kind: "revise" | "schedule" | "unschedule" | "delete";
      operationId: string;
      draftId: string;
      expectedProviderRevision: string;
      expectedMaterialHash: string;
      manifestHash: string;
      sendAt?: number;
    };

export type AgentMailProviderDraftMutationOutcome =
  | {
      status: "updated";
      draftId: string;
      providerRevision: string;
      providerUpdatedAt: number;
      materialHash: string;
      sendAt?: number;
    }
  | { status: "deleted" }
  | { status: "outcome_unknown"; code: string }
  | { status: "failed"; code: string };

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
  sendOperationKind?: "send";
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

export type AgentMailRateReservation =
  | { status: "reserved" | "replay" }
  | {
      status: "rate_limited";
      reason: "global" | "actor" | "duplicate";
      retryAfterMs: number;
    }
  | { status: "conflict" };

export type AgentMailDeliveryAction = "send_draft" | "send_message" | "reply" | "forward";
export type AgentMailDeliveryEndpoint =
  | "drafts.send"
  | "messages.send"
  | "messages.reply"
  | "messages.forward";
export type AgentMailDeliveryState =
  | "prepared"
  | "dispatching"
  | "retryable"
  | "sent"
  | "outcome_unknown"
  | "failed"
  | "reconciled_not_sent";

export interface AgentMailDeliveryOperation {
  inboxId: string;
  operationId: string;
  action: AgentMailDeliveryAction;
  endpoint: AgentMailDeliveryEndpoint;
  draftId?: string;
  sourceMessageId?: string;
  threadId?: string;
  draftKind?: AgentMailProviderDraftKind;
  approvalGeneration: number;
  approvalManifestHash: string;
  providerRevision?: string;
  materialHash?: string;
  requestHash: string;
  idempotencyKey: string;
  state: AgentMailDeliveryState;
  firstDispatchAt?: number;
  attemptCount: number;
  retryAfter?: number;
  sentMessageId?: string;
  sentThreadId?: string;
  outcomeCode?: string;
  reconciliationHash?: string;
  reconciledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailDeliveryReservation {
  operationId: string;
  action: AgentMailDeliveryAction;
  endpoint: AgentMailDeliveryEndpoint;
  draftId?: string;
  sourceMessageId?: string;
  threadId?: string;
  draftKind?: AgentMailProviderDraftKind;
  approvalGeneration: number;
  approvalManifestHash: string;
  providerRevision?: string;
  materialHash?: string;
  requestHash: string;
  idempotencyKey: string;
  recipientHashes: string[];
  rateLimit: {
    globalMaxPerHour: number;
    perRecipientCooldownMs: number;
    dedupWindowMs: number;
  };
}

export type AgentMailDeliveryReservationResult =
  | { status: "reserved" | "replay" | "conflict"; operation: AgentMailDeliveryOperation }
  | {
      status: "rate_limited";
      reason: "global" | "actor" | "duplicate";
      retryAfterMs: number;
    };

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
  recoverAmbiguousMutations(): {
    drafts: number;
    draftMutations: number;
    deliveryOperations: number;
  };
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
  reserveProviderDraftMutation(
    input: AgentMailProviderDraftMutationReservation,
  ):
    | { status: "reserved"; operation: AgentMailProviderDraftMutationOperation }
    | { status: "replay" | "conflict"; operation: AgentMailProviderDraftMutationOperation };
  markProviderDraftMutationDispatching(
    operationId: string,
  ):
    | { status: "dispatch"; operation: AgentMailProviderDraftMutationOperation }
    | { status: "replay"; operation: AgentMailProviderDraftMutationOperation };
  getProviderDraftMutation(
    operationId: string,
  ): AgentMailProviderDraftMutationOperation | undefined;
  listUnresolvedProviderDraftMutations(limit?: number): AgentMailProviderDraftMutationOperation[];
  settleProviderDraftMutation(
    operationId: string,
    outcome: AgentMailProviderDraftMutationOutcome,
  ): AgentMailProviderDraftMutationOperation;
  reconcileProviderDraftMutation(input: {
    operationId: string;
    evidenceHash: string;
    resolution:
      | Extract<AgentMailProviderDraftMutationOutcome, { status: "updated" | "deleted" }>
      | { status: "not_applied" };
  }): AgentMailProviderDraftMutationOperation;
  approveProviderDraft(input: {
    draftId: string;
    expectedProviderRevision: string;
    expectedMaterialHash: string;
    approvalGeneration: number;
    manifestHash: string;
  }): AgentMailProviderDraftRecord;
  compact(input: { terminalBefore: number; maxRows: number }): {
    drafts: number;
    draftMutations: number;
    deliveryOperations: number;
    messages: number;
    providerEvents: number;
    rateReservations: number;
    creatorAttention: number;
  };
  markThreadDraftsStale(threadId: string, exceptSourceMessageId: string): number;
  reserveInboundRate(input: {
    messageId: string;
    senderHash: string;
    payloadHash: string;
    globalMaxPerHour: number;
    perSenderMaxPerHour: number;
  }): AgentMailRateReservation;
  reserveDeliveryOperation(input: AgentMailDeliveryReservation): AgentMailDeliveryReservationResult;
  beginDeliveryDispatch(operationId: string): {
    status: "dispatch" | "replay" | "manual_reconciliation_required";
    operation: AgentMailDeliveryOperation;
  };
  beginDeliveryRetry(
    operationId: string,
  ):
    | { status: "dispatch" | "replay"; operation: AgentMailDeliveryOperation }
    | { status: "wait"; retryAfterMs: number; operation: AgentMailDeliveryOperation };
  getDeliveryOperation(operationId: string): AgentMailDeliveryOperation | undefined;
  listUnresolvedDeliveryOperations(limit?: number): AgentMailDeliveryOperation[];
  settleDeliveryOperation(
    operationId: string,
    outcome:
      | { status: "sent"; messageId: string; threadId: string }
      | { status: "retryable"; code: string; retryAfter: number }
      | { status: "outcome_unknown"; code: string }
      | { status: "failed"; code: string },
  ): AgentMailDeliveryOperation;
  reconcileDeliveryOperation(input: {
    operationId: string;
    evidenceHash: string;
    resolution: { status: "sent"; messageId: string; threadId: string } | { status: "not_sent" };
  }): AgentMailDeliveryOperation;
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
  send_operation_kind: "send" | null;
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

interface DraftMutationRow {
  inbox_id: string;
  operation_id: string;
  draft_id: string | null;
  kind: AgentMailProviderDraftMutationKind;
  draft_kind: AgentMailProviderDraftKind;
  source_message_id: string | null;
  thread_id: string | null;
  client_id: string;
  expected_provider_revision: string | null;
  expected_material_hash: string | null;
  manifest_hash: string;
  send_at: number | null;
  prior_draft_state: AgentMailProviderDraftMutationOperation["priorDraftState"] | null;
  state: AgentMailProviderDraftMutationState;
  result_draft_id: string | null;
  result_provider_revision: string | null;
  result_provider_updated_at: number | null;
  result_material_hash: string | null;
  result_send_at: number | null;
  outcome_code: string | null;
  reconciliation_hash: string | null;
  reconciled_at: number | null;
  created_at: number;
  dispatch_started_at: number | null;
  updated_at: number;
}

const DRAFT_MUTATION_COLUMNS = `inbox_id, operation_id, draft_id, kind, draft_kind,
  source_message_id, thread_id, client_id, expected_provider_revision, expected_material_hash,
  manifest_hash, send_at, prior_draft_state, state, result_draft_id,
  result_provider_revision, result_provider_updated_at, result_material_hash, result_send_at,
  outcome_code, reconciliation_hash, reconciled_at, created_at, dispatch_started_at, updated_at`;

function draftMutationFromRow(row: DraftMutationRow): AgentMailProviderDraftMutationOperation {
  return {
    inboxId: row.inbox_id,
    operationId: row.operation_id,
    ...(row.draft_id === null ? {} : { draftId: row.draft_id }),
    kind: row.kind,
    draftKind: row.draft_kind,
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    clientId: row.client_id,
    ...(row.expected_provider_revision === null
      ? {}
      : { expectedProviderRevision: row.expected_provider_revision }),
    ...(row.expected_material_hash === null
      ? {}
      : { expectedMaterialHash: row.expected_material_hash }),
    manifestHash: row.manifest_hash,
    ...(row.send_at === null ? {} : { sendAt: row.send_at }),
    ...(row.prior_draft_state === null ? {} : { priorDraftState: row.prior_draft_state }),
    state: row.state,
    ...(row.result_draft_id === null ? {} : { resultDraftId: row.result_draft_id }),
    ...(row.result_provider_revision === null
      ? {}
      : { resultProviderRevision: row.result_provider_revision }),
    ...(row.result_provider_updated_at === null
      ? {}
      : { resultProviderUpdatedAt: row.result_provider_updated_at }),
    ...(row.result_material_hash === null ? {} : { resultMaterialHash: row.result_material_hash }),
    ...(row.result_send_at === null ? {} : { resultSendAt: row.result_send_at }),
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code }),
    ...(row.reconciliation_hash === null ? {} : { reconciliationHash: row.reconciliation_hash }),
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
    createdAt: row.created_at,
    ...(row.dispatch_started_at === null ? {} : { dispatchStartedAt: row.dispatch_started_at }),
    updatedAt: row.updated_at,
  };
}

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

interface DeliveryOperationRow {
  inbox_id: string;
  operation_id: string;
  action: AgentMailDeliveryAction;
  endpoint: AgentMailDeliveryEndpoint;
  draft_id: string | null;
  source_message_id: string | null;
  thread_id: string | null;
  draft_kind: AgentMailProviderDraftKind | null;
  approval_generation: number;
  approval_manifest_hash: string;
  provider_revision: string | null;
  material_hash: string | null;
  request_hash: string;
  idempotency_key: string;
  state: AgentMailDeliveryState;
  first_dispatch_at: number | null;
  attempt_count: number;
  retry_after: number | null;
  sent_message_id: string | null;
  sent_thread_id: string | null;
  outcome_code: string | null;
  reconciliation_hash: string | null;
  reconciled_at: number | null;
  created_at: number;
  updated_at: number;
}

const DELIVERY_OPERATION_COLUMNS = `inbox_id, operation_id, action, endpoint, draft_id,
  source_message_id, thread_id, draft_kind, approval_generation, approval_manifest_hash,
  provider_revision, material_hash, request_hash, idempotency_key, state, first_dispatch_at,
  attempt_count, retry_after, sent_message_id, sent_thread_id, outcome_code,
  reconciliation_hash, reconciled_at, created_at, updated_at`;

function deliveryOperationFromRow(row: DeliveryOperationRow): AgentMailDeliveryOperation {
  return {
    inboxId: row.inbox_id,
    operationId: row.operation_id,
    action: row.action,
    endpoint: row.endpoint,
    ...(row.draft_id === null ? {} : { draftId: row.draft_id }),
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.draft_kind === null ? {} : { draftKind: row.draft_kind }),
    approvalGeneration: row.approval_generation,
    approvalManifestHash: row.approval_manifest_hash,
    ...(row.provider_revision === null ? {} : { providerRevision: row.provider_revision }),
    ...(row.material_hash === null ? {} : { materialHash: row.material_hash }),
    requestHash: row.request_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    ...(row.first_dispatch_at === null ? {} : { firstDispatchAt: row.first_dispatch_at }),
    attemptCount: row.attempt_count,
    ...(row.retry_after === null ? {} : { retryAfter: row.retry_after }),
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
    ...(row.sent_thread_id === null ? {} : { sentThreadId: row.sent_thread_id }),
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code }),
    ...(row.reconciliation_hash === null ? {} : { reconciliationHash: row.reconciliation_hash }),
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  const findDraftById = db.query<DraftRow, [string, string]>(
    `SELECT ${DRAFT_COLUMNS}
       FROM agentmail_drafts WHERE inbox_id = ? AND draft_id = ?`,
  );
  const findDraftMutation = db.query<DraftMutationRow, [string, string]>(
    `SELECT ${DRAFT_MUTATION_COLUMNS}
       FROM agentmail_draft_mutations
      WHERE inbox_id = ? AND operation_id = ?`,
  );
  const findDeliveryOperation = db.query<DeliveryOperationRow, [string, string]>(
    `SELECT ${DELIVERY_OPERATION_COLUMNS}
       FROM agentmail_delivery_operations
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
      let initialState: AgentMailProviderDraftState =
        input.sendAt === undefined ? "ready" : "scheduled";
      if (
        initialState !== "scheduled" &&
        source &&
        (input.kind === "reply" || input.kind === "reply_all")
      ) {
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

  function validateDraftMutationOutcome(
    operation: DraftMutationRow,
    outcome: AgentMailProviderDraftMutationOutcome,
  ): void {
    if (outcome.status === "deleted") {
      if (operation.kind !== "delete") {
        throw new Error("agentMail store: only delete mutations can settle as deleted");
      }
      return;
    }
    if (outcome.status === "outcome_unknown" || outcome.status === "failed") {
      assertBoundedIdentifier(outcome.code, "draft mutation outcomeCode");
      return;
    }
    if (operation.kind === "delete") {
      throw new Error("agentMail store: delete mutation cannot settle as updated");
    }
    assertBoundedIdentifier(outcome.draftId, "draft mutation result draftId");
    assertBoundedIdentifier(outcome.providerRevision, "draft mutation result providerRevision");
    assertTimestamp(outcome.providerUpdatedAt, "draft mutation result providerUpdatedAt");
    assertOptionalTimestamp(outcome.sendAt, "draft mutation result sendAt");
    if (!validHash(outcome.materialHash)) {
      throw new Error("agentMail store: draft mutation result material hash is invalid");
    }
    if (operation.kind !== "create" && outcome.draftId !== operation.draft_id) {
      throw new Error("agentMail store: draft mutation result changed immutable draft identity");
    }
    if (operation.kind === "schedule" && outcome.sendAt !== operation.send_at) {
      throw new Error("agentMail store: scheduled draft result does not match the requested time");
    }
    if (operation.kind === "unschedule" && outcome.sendAt !== undefined) {
      throw new Error("agentMail store: unscheduled draft result still has a send time");
    }
  }

  function settleDraftMutationInTransaction(
    operationId: string,
    outcome: AgentMailProviderDraftMutationOutcome,
    reconciliation?: { evidenceHash: string },
  ): AgentMailProviderDraftMutationOperation {
    const operation = findDraftMutation.get(inboxId, operationId);
    if (!operation) throw new Error("agentMail store: provider draft mutation not found");
    validateDraftMutationOutcome(operation, outcome);

    const targetState = outcome.status;
    const reconcilingUnknown =
      reconciliation !== undefined && operation.state === "outcome_unknown";
    if (
      operation.state !== "prepared" &&
      operation.state !== "dispatching" &&
      !reconcilingUnknown
    ) {
      const exact =
        operation.state === targetState &&
        (outcome.status === "updated"
          ? operation.result_draft_id === outcome.draftId &&
            operation.result_provider_revision === outcome.providerRevision &&
            operation.result_provider_updated_at === outcome.providerUpdatedAt &&
            operation.result_material_hash === outcome.materialHash &&
            operation.result_send_at === (outcome.sendAt ?? null)
          : outcome.status === "deleted"
            ? operation.result_draft_id === operation.draft_id
            : operation.outcome_code === outcome.code);
      if (exact) return draftMutationFromRow(operation);
      throw new Error("agentMail store: provider draft mutation was already settled differently");
    }
    if (outcome.status !== "failed" && operation.state !== "dispatching" && !reconcilingUnknown) {
      throw new Error("agentMail store: provider draft mutation was not marked dispatching");
    }

    const at = clock();
    if (outcome.status === "updated") {
      if (operation.kind === "create") {
        const source = operation.source_message_id
          ? findMessage.get(inboxId, operation.source_message_id)
          : undefined;
        if (source && operation.thread_id && source.thread_id !== operation.thread_id) {
          throw new Error("agentMail store: created draft source thread changed before settlement");
        }
        let initialState: AgentMailProviderDraftState =
          outcome.sendAt === undefined ? "ready" : "scheduled";
        if (source && (operation.draft_kind === "reply" || operation.draft_kind === "reply_all")) {
          const newer = db
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
          if (newer) initialState = "stale";
        }
        db.run(
          `INSERT INTO agentmail_drafts(
             inbox_id, draft_id, kind, source_message_id, thread_id, operation_id, client_id,
             provider_revision, provider_updated_at, material_hash, send_at, state,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inboxId,
            outcome.draftId,
            operation.draft_kind,
            operation.source_message_id,
            operation.thread_id ?? source?.thread_id ?? null,
            operation.operation_id,
            operation.client_id,
            outcome.providerRevision,
            outcome.providerUpdatedAt,
            outcome.materialHash,
            outcome.sendAt ?? null,
            initialState,
            at,
            at,
          ],
        );
        enqueueCreatorAttention({
          kind: "draft_ready",
          subjectId: outcome.draftId,
          ...(operation.source_message_id === null
            ? {}
            : { relatedMessageId: operation.source_message_id }),
          ...(initialState === "stale" || initialState === "scheduled"
            ? { state: "superseded" as const }
            : {}),
        });
      } else {
        const current = findDraftById.get(inboxId, operation.draft_id!);
        if (
          !current ||
          current.provider_revision !== operation.expected_provider_revision ||
          current.material_hash !== operation.expected_material_hash
        ) {
          throw new Error("agentMail store: provider draft changed before mutation settlement");
        }
        if (
          outcome.providerRevision === operation.expected_provider_revision ||
          outcome.providerUpdatedAt < current.provider_updated_at
        ) {
          throw new Error("agentMail store: provider draft mutation did not advance its revision");
        }
        const nextState: AgentMailProviderDraftState =
          operation.kind === "schedule"
            ? "scheduled"
            : operation.kind === "unschedule"
              ? "ready"
              : operation.prior_draft_state === "stale"
                ? "stale"
                : outcome.sendAt === undefined
                  ? "ready"
                  : "scheduled";
        const changed = db.run(
          `UPDATE agentmail_drafts
              SET provider_revision = ?, provider_updated_at = ?, material_hash = ?, send_at = ?,
                  state = ?, approval_manifest_hash = NULL, approved_at = NULL,
                  send_operation_kind = NULL, send_operation_id = NULL, send_key = NULL,
                  send_started_at = NULL, outcome_code = NULL, reconciliation_state = 'none',
                  reconciliation_hash = NULL, reconciled_at = NULL, updated_at = ?
            WHERE inbox_id = ? AND draft_id = ?
              AND provider_revision = ? AND material_hash = ?`,
          [
            outcome.providerRevision,
            outcome.providerUpdatedAt,
            outcome.materialHash,
            outcome.sendAt ?? null,
            nextState,
            at,
            inboxId,
            operation.draft_id!,
            operation.expected_provider_revision!,
            operation.expected_material_hash!,
          ],
        );
        if (changed.changes !== 1) {
          throw new Error("agentMail store: provider draft changed during mutation settlement");
        }
        if (nextState === "scheduled") {
          supersedePendingDraftAttention("?", [operation.draft_id!]);
        }
      }
    } else if (outcome.status === "deleted") {
      const deleted = db.run(
        `UPDATE agentmail_drafts
            SET state = 'deleted', approval_manifest_hash = NULL, approved_at = NULL,
                send_operation_kind = NULL, send_operation_id = NULL, send_key = NULL,
                send_started_at = NULL, sent_message_id = NULL, sent_thread_id = NULL,
                outcome_code = NULL, reconciliation_state = 'none', reconciliation_hash = NULL,
                reconciled_at = NULL, updated_at = ?
          WHERE inbox_id = ? AND draft_id = ?
            AND provider_revision = ? AND material_hash = ?`,
        [
          at,
          inboxId,
          operation.draft_id!,
          operation.expected_provider_revision!,
          operation.expected_material_hash!,
        ],
      );
      if (deleted.changes !== 1) {
        throw new Error("agentMail store: provider draft changed during delete settlement");
      }
      supersedePendingDraftAttention("?", [operation.draft_id!]);
    } else if (outcome.status === "outcome_unknown" && operation.draft_id !== null) {
      db.run(
        `UPDATE agentmail_drafts
            SET state = 'ambiguous', approval_manifest_hash = NULL, approved_at = NULL,
                outcome_code = ?, reconciliation_state = 'required', updated_at = ?
          WHERE inbox_id = ? AND draft_id = ?`,
        [outcome.code, at, inboxId, operation.draft_id],
      );
    }

    const resultDraftId =
      outcome.status === "updated"
        ? outcome.draftId
        : outcome.status === "deleted"
          ? operation.draft_id
          : null;
    const changed = db.run(
      `UPDATE agentmail_draft_mutations
          SET state = ?, result_draft_id = ?, result_provider_revision = ?,
              result_provider_updated_at = ?, result_material_hash = ?, result_send_at = ?,
              outcome_code = ?, reconciliation_hash = ?, reconciled_at = ?, updated_at = ?
        WHERE inbox_id = ? AND operation_id = ? AND state = ?`,
      [
        targetState,
        resultDraftId,
        outcome.status === "updated" ? outcome.providerRevision : null,
        outcome.status === "updated" ? outcome.providerUpdatedAt : null,
        outcome.status === "updated" ? outcome.materialHash : null,
        outcome.status === "updated" ? (outcome.sendAt ?? null) : null,
        outcome.status === "outcome_unknown" || outcome.status === "failed" ? outcome.code : null,
        reconciliation?.evidenceHash ?? null,
        reconciliation ? at : null,
        at,
        inboxId,
        operationId,
        operation.state,
      ],
    );
    if (changed.changes !== 1) {
      throw new Error("agentMail store: provider draft mutation changed during settlement");
    }
    return draftMutationFromRow(findDraftMutation.get(inboxId, operationId)!);
  }

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
          const deliveryDrafts = db.run(
            `UPDATE agentmail_drafts
                SET state = 'ambiguous', outcome_code = 'interrupted_before_settlement',
                    reconciliation_state = 'required', updated_at = ?
              WHERE inbox_id = ? AND state = 'sending'
                AND NOT EXISTS (
                  SELECT 1 FROM agentmail_delivery_operations AS operation
                   WHERE operation.inbox_id = agentmail_drafts.inbox_id
                     AND operation.draft_id = agentmail_drafts.draft_id
                     AND operation.state IN ('prepared', 'retryable')
                )`,
            [at, inboxId],
          ).changes;
          const deliveryOperations = db.run(
            `UPDATE agentmail_delivery_operations
                SET state = 'outcome_unknown', outcome_code = 'interrupted_during_dispatch',
                    updated_at = ?
              WHERE inbox_id = ? AND state = 'dispatching'`,
            [at, inboxId],
          ).changes;
          const draftMutations = db.run(
            `UPDATE agentmail_draft_mutations
                SET state = 'outcome_unknown', outcome_code = 'interrupted_during_dispatch',
                    updated_at = ?
              WHERE inbox_id = ? AND state = 'dispatching'`,
            [at, inboxId],
          ).changes;
          const mutationDrafts = db.run(
            `UPDATE agentmail_drafts
                SET state = 'ambiguous', approval_manifest_hash = NULL, approved_at = NULL,
                    outcome_code = 'interrupted_during_mutation_dispatch',
                    reconciliation_state = 'required', updated_at = ?
              WHERE inbox_id = ? AND draft_id IN (
                SELECT draft_id FROM agentmail_draft_mutations
                 WHERE inbox_id = ? AND state = 'outcome_unknown'
                   AND outcome_code = 'interrupted_during_dispatch' AND draft_id IS NOT NULL
              ) AND state <> 'ambiguous'`,
            [at, inboxId, inboxId],
          ).changes;
          return {
            drafts: deliveryDrafts + mutationDrafts,
            draftMutations,
            deliveryOperations,
          };
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
            current.state === "sent" ||
            current.state === "ambiguous" ||
            current.state === "deleted"
          ) {
            throw new Error(
              "agentMail store: provider draft cannot be refreshed in its current state",
            );
          }
          const state: AgentMailProviderDraftState =
            input.sendAt !== undefined
              ? "scheduled"
              : current.state === "stale"
                ? "stale"
                : "ready";
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
    reserveProviderDraftMutation(input) {
      assertBoundedIdentifier(input.operationId, "draft mutation operationId");
      if (!validHash(input.manifestHash)) {
        throw new Error("agentMail store: draft mutation manifest hash is invalid");
      }
      if (input.kind === "create") {
        assertBoundedIdentifier(input.clientId, "draft mutation clientId");
        if (input.sourceMessageId !== undefined) {
          assertBoundedIdentifier(input.sourceMessageId, "draft mutation sourceMessageId");
        }
        if (input.threadId !== undefined) {
          assertBoundedIdentifier(input.threadId, "draft mutation threadId");
        }
        if (
          (input.draftKind === "new" && input.sourceMessageId !== undefined) ||
          (input.draftKind !== "new" && input.sourceMessageId === undefined)
        ) {
          throw new Error("agentMail store: draft mutation kind and source are inconsistent");
        }
      } else {
        assertBoundedIdentifier(input.draftId, "draft mutation draftId");
        assertBoundedIdentifier(
          input.expectedProviderRevision,
          "draft mutation expectedProviderRevision",
        );
        if (!validHash(input.expectedMaterialHash)) {
          throw new Error("agentMail store: draft mutation expected material hash is invalid");
        }
        if (
          (input.kind === "schedule" && input.sendAt === undefined) ||
          (input.kind !== "schedule" && input.sendAt !== undefined)
        ) {
          throw new Error("agentMail store: draft mutation kind and schedule are inconsistent");
        }
        assertOptionalTimestamp(input.sendAt, "draft mutation sendAt");
      }
      return db
        .transaction(() => {
          const currentDraft =
            input.kind === "create" ? undefined : findDraftById.get(inboxId, input.draftId);
          const existing = findDraftMutation.get(inboxId, input.operationId);
          if (existing) {
            const exact =
              existing.kind === input.kind &&
              existing.manifest_hash === input.manifestHash &&
              (input.kind === "create"
                ? existing.draft_id === null &&
                  existing.draft_kind === input.draftKind &&
                  existing.source_message_id === (input.sourceMessageId ?? null) &&
                  existing.thread_id === (input.threadId ?? null) &&
                  existing.client_id === input.clientId
                : existing.draft_id === input.draftId &&
                  existing.expected_provider_revision === input.expectedProviderRevision &&
                  existing.expected_material_hash === input.expectedMaterialHash &&
                  existing.send_at === (input.sendAt ?? null));
            return {
              status: exact ? "replay" : "conflict",
              operation: draftMutationFromRow(existing),
            } as const;
          }
          if (input.kind !== "create") {
            if (!currentDraft) throw new Error("agentMail store: provider draft not found");
            if (
              currentDraft.provider_revision !== input.expectedProviderRevision ||
              currentDraft.material_hash !== input.expectedMaterialHash
            ) {
              throw new Error(
                "agentMail store: provider draft changed before mutation reservation",
              );
            }
            if (
              currentDraft.state === "sending" ||
              currentDraft.state === "sent" ||
              currentDraft.state === "ambiguous" ||
              currentDraft.state === "deleted"
            ) {
              throw new Error(
                "agentMail store: provider draft cannot be mutated in its current state",
              );
            }
            if (
              input.kind === "schedule" &&
              (currentDraft.send_at !== null || currentDraft.state === "scheduled")
            ) {
              throw new Error("agentMail store: provider draft is already scheduled");
            }
            if (
              input.kind === "unschedule" &&
              (currentDraft.send_at === null || currentDraft.state !== "scheduled")
            ) {
              throw new Error("agentMail store: provider draft is not scheduled");
            }
          }

          const at = clock();
          try {
            db.run(
              `INSERT INTO agentmail_draft_mutations(
                 inbox_id, operation_id, draft_id, kind, draft_kind, source_message_id,
                 thread_id, client_id, expected_provider_revision, expected_material_hash,
                 manifest_hash, send_at, prior_draft_state, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
              [
                inboxId,
                input.operationId,
                input.kind === "create" ? null : input.draftId,
                input.kind,
                input.kind === "create" ? input.draftKind : currentDraft!.kind,
                input.kind === "create"
                  ? (input.sourceMessageId ?? null)
                  : currentDraft!.source_message_id,
                input.kind === "create" ? (input.threadId ?? null) : currentDraft!.thread_id,
                input.kind === "create" ? input.clientId : currentDraft!.client_id,
                input.kind === "create" ? null : input.expectedProviderRevision,
                input.kind === "create" ? null : input.expectedMaterialHash,
                input.manifestHash,
                input.kind === "schedule" ? (input.sendAt ?? null) : null,
                input.kind === "create" ? null : currentDraft!.state,
                at,
                at,
              ],
            );
          } catch (error) {
            if (!String(error).includes("UNIQUE")) throw error;
            const conflict =
              input.kind === "create"
                ? db
                    .query<DraftMutationRow, [string, string]>(
                      `SELECT ${DRAFT_MUTATION_COLUMNS} FROM agentmail_draft_mutations
                        WHERE inbox_id = ? AND kind = 'create' AND client_id = ?`,
                    )
                    .get(inboxId, input.clientId)
                : db
                    .query<DraftMutationRow, [string, string]>(
                      `SELECT ${DRAFT_MUTATION_COLUMNS} FROM agentmail_draft_mutations
                        WHERE inbox_id = ? AND draft_id = ?
                          AND state IN ('prepared', 'dispatching', 'outcome_unknown')
                        ORDER BY created_at ASC LIMIT 1`,
                    )
                    .get(inboxId, input.draftId);
            if (!conflict) throw error;
            return { status: "conflict", operation: draftMutationFromRow(conflict) } as const;
          }

          if (input.kind !== "create") {
            const normalizedState =
              currentDraft!.state === "approved" ? "ready" : currentDraft!.state;
            const invalidated = db.run(
              `UPDATE agentmail_drafts
                  SET state = ?, approval_manifest_hash = NULL, approved_at = NULL, updated_at = ?
                WHERE inbox_id = ? AND draft_id = ?
                  AND provider_revision = ? AND material_hash = ?`,
              [
                normalizedState,
                at,
                inboxId,
                input.draftId,
                input.expectedProviderRevision,
                input.expectedMaterialHash,
              ],
            );
            if (invalidated.changes !== 1) {
              throw new Error(
                "agentMail store: provider draft changed during mutation reservation",
              );
            }
          }
          return {
            status: "reserved",
            operation: draftMutationFromRow(findDraftMutation.get(inboxId, input.operationId)!),
          } as const;
        })
        .immediate();
    },
    markProviderDraftMutationDispatching(operationId) {
      assertBoundedIdentifier(operationId, "draft mutation operationId");
      return db
        .transaction(() => {
          const current = findDraftMutation.get(inboxId, operationId);
          if (!current) throw new Error("agentMail store: provider draft mutation not found");
          if (current.state !== "prepared") {
            return { status: "replay", operation: draftMutationFromRow(current) } as const;
          }
          const at = clock();
          const changed = db.run(
            `UPDATE agentmail_draft_mutations
                SET state = 'dispatching', dispatch_started_at = ?, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = 'prepared'`,
            [at, at, inboxId, operationId],
          );
          if (changed.changes !== 1) {
            throw new Error("agentMail store: provider draft mutation changed before dispatch");
          }
          return {
            status: "dispatch",
            operation: draftMutationFromRow(findDraftMutation.get(inboxId, operationId)!),
          } as const;
        })
        .immediate();
    },
    getProviderDraftMutation(operationId) {
      assertBoundedIdentifier(operationId, "draft mutation operationId");
      const row = findDraftMutation.get(inboxId, operationId);
      return row ? draftMutationFromRow(row) : undefined;
    },
    listUnresolvedProviderDraftMutations(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error(
          "agentMail store: provider draft mutation limit must be between 1 and 1000",
        );
      }
      return db
        .query<DraftMutationRow, [string, number]>(
          `SELECT ${DRAFT_MUTATION_COLUMNS} FROM agentmail_draft_mutations
            WHERE inbox_id = ? AND state IN ('prepared', 'dispatching', 'outcome_unknown')
            ORDER BY created_at ASC, operation_id ASC LIMIT ?`,
        )
        .all(inboxId, limit)
        .map(draftMutationFromRow);
    },
    settleProviderDraftMutation(operationId, outcome) {
      assertBoundedIdentifier(operationId, "draft mutation operationId");
      return db
        .transaction(() => settleDraftMutationInTransaction(operationId, outcome))
        .immediate();
    },
    reconcileProviderDraftMutation(input) {
      assertBoundedIdentifier(input.operationId, "draft mutation operationId");
      if (!validHash(input.evidenceHash)) {
        throw new Error("agentMail store: draft mutation reconciliation hash is invalid");
      }
      return db
        .transaction(() => {
          const operation = findDraftMutation.get(inboxId, input.operationId);
          if (!operation) throw new Error("agentMail store: provider draft mutation not found");
          if (operation.state !== "outcome_unknown") {
            const expectedState =
              input.resolution.status === "not_applied"
                ? "reconciled_not_applied"
                : input.resolution.status;
            if (
              operation.state === expectedState &&
              operation.reconciliation_hash === input.evidenceHash
            ) {
              return draftMutationFromRow(operation);
            }
            throw new Error(
              "agentMail store: provider draft mutation is not awaiting reconciliation",
            );
          }
          const at = clock();
          if (input.resolution.status === "not_applied") {
            if (operation.draft_id !== null) {
              const restoredState =
                operation.prior_draft_state === "approved"
                  ? "ready"
                  : (operation.prior_draft_state ?? "ready");
              db.run(
                `UPDATE agentmail_drafts
                    SET state = ?, outcome_code = NULL, reconciliation_state = 'none',
                        reconciliation_hash = ?, reconciled_at = ?, updated_at = ?
                  WHERE inbox_id = ? AND draft_id = ? AND state = 'ambiguous'`,
                [restoredState, input.evidenceHash, at, at, inboxId, operation.draft_id],
              );
            }
            db.run(
              `UPDATE agentmail_draft_mutations
                  SET state = 'reconciled_not_applied', reconciliation_hash = ?,
                      reconciled_at = ?, updated_at = ?
                WHERE inbox_id = ? AND operation_id = ? AND state = 'outcome_unknown'`,
              [input.evidenceHash, at, at, inboxId, input.operationId],
            );
            return draftMutationFromRow(findDraftMutation.get(inboxId, input.operationId)!);
          }
          return settleDraftMutationInTransaction(input.operationId, input.resolution, {
            evidenceHash: input.evidenceHash,
          });
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
          const genericDeliveryOperations = remove(
            `DELETE FROM agentmail_delivery_operations WHERE rowid IN (
               SELECT operation.rowid FROM agentmail_delivery_operations AS operation
                WHERE operation.inbox_id = ? AND operation.updated_at < ?
                  AND operation.state IN ('sent', 'failed', 'reconciled_not_sent')
                ORDER BY operation.updated_at ASC, operation.operation_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          const draftMutations = remove(
            `DELETE FROM agentmail_draft_mutations WHERE rowid IN (
               SELECT mutation.rowid FROM agentmail_draft_mutations AS mutation
                WHERE mutation.inbox_id = ? AND mutation.updated_at < ?
                  AND mutation.state IN ('updated', 'deleted', 'failed', 'reconciled_not_applied')
                  AND (
                    mutation.kind <> 'create' OR NOT EXISTS (
                      SELECT 1 FROM agentmail_drafts AS draft
                       WHERE draft.inbox_id = mutation.inbox_id
                         AND draft.draft_id = mutation.result_draft_id
                         AND draft.state NOT IN ('stale', 'sent', 'deleted')
                    )
                  )
                ORDER BY mutation.updated_at ASC, mutation.operation_id ASC LIMIT ?
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
                    SELECT 1 FROM agentmail_draft_mutations AS mutation
                     WHERE mutation.inbox_id = draft.inbox_id
                       AND (mutation.draft_id = draft.draft_id OR mutation.result_draft_id = draft.draft_id)
                       AND mutation.state IN ('prepared', 'dispatching', 'outcome_unknown')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_delivery_operations AS operation
                     WHERE operation.inbox_id = draft.inbox_id
                       AND operation.draft_id = draft.draft_id
                       AND operation.state IN ('prepared', 'dispatching', 'retryable', 'outcome_unknown')
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
                  AND NOT EXISTS (
                    SELECT 1 FROM agentmail_delivery_operations AS operation
                     WHERE operation.inbox_id = agentmail_rate_reservations.inbox_id
                       AND operation.operation_id = agentmail_rate_reservations.operation_id
                       AND operation.state IN ('prepared', 'dispatching', 'retryable', 'outcome_unknown')
                  )
                ORDER BY occurred_at ASC, operation_id ASC LIMIT ?
             )`,
            [inboxId, input.terminalBefore],
          );
          return {
            drafts,
            draftMutations,
            deliveryOperations: genericDeliveryOperations,
            messages,
            providerEvents,
            rateReservations,
            creatorAttention,
          };
        })
        .immediate();
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
    reserveDeliveryOperation(input) {
      assertBoundedIdentifier(input.operationId, "delivery operationId");
      assertBoundedIdentifier(input.idempotencyKey, "delivery idempotencyKey");
      if (!/^[A-Za-z0-9._~-]{1,256}$/.test(input.idempotencyKey)) {
        throw new Error("agentMail store: delivery idempotency key is invalid");
      }
      if (
        !validHash(input.approvalManifestHash) ||
        !validHash(input.requestHash) ||
        !Number.isSafeInteger(input.approvalGeneration) ||
        input.approvalGeneration < 1
      ) {
        throw new Error("agentMail store: delivery approval or request manifest is invalid");
      }
      if (
        input.recipientHashes.length === 0 ||
        new Set(input.recipientHashes).size !== input.recipientHashes.length ||
        input.recipientHashes.some((hash) => !validHash(hash))
      ) {
        throw new Error("agentMail store: delivery recipient hashes are invalid");
      }
      const rateLimit = input.rateLimit;
      if (
        !Number.isSafeInteger(rateLimit.globalMaxPerHour) ||
        rateLimit.globalMaxPerHour < 1 ||
        !Number.isSafeInteger(rateLimit.perRecipientCooldownMs) ||
        rateLimit.perRecipientCooldownMs < 0 ||
        !Number.isSafeInteger(rateLimit.dedupWindowMs) ||
        rateLimit.dedupWindowMs < 0
      ) {
        throw new Error("agentMail store: delivery rate policy is invalid");
      }
      const expectedEndpoint: Record<AgentMailDeliveryAction, AgentMailDeliveryEndpoint> = {
        send_draft: "drafts.send",
        send_message: "messages.send",
        reply: "messages.reply",
        forward: "messages.forward",
      };
      if (input.endpoint !== expectedEndpoint[input.action]) {
        throw new Error("agentMail store: delivery action and endpoint are inconsistent");
      }
      if (input.action === "send_draft") {
        if (
          !input.draftId ||
          !input.draftKind ||
          !input.providerRevision ||
          !input.materialHash ||
          !validHash(input.materialHash)
        ) {
          throw new Error("agentMail store: draft delivery identity is incomplete");
        }
        assertBoundedIdentifier(input.draftId, "delivery draftId");
        assertBoundedIdentifier(input.providerRevision, "delivery providerRevision");
        if (input.sourceMessageId !== undefined) {
          assertBoundedIdentifier(input.sourceMessageId, "delivery sourceMessageId");
        }
        if (input.threadId !== undefined) {
          assertBoundedIdentifier(input.threadId, "delivery threadId");
        }
        if (
          (input.draftKind === "new" && input.sourceMessageId !== undefined) ||
          (input.draftKind !== "new" &&
            (input.sourceMessageId === undefined || input.threadId === undefined))
        ) {
          throw new Error("agentMail store: delivery draft kind and source are inconsistent");
        }
      } else {
        if (
          input.draftId !== undefined ||
          input.draftKind !== undefined ||
          input.providerRevision !== undefined ||
          input.materialHash !== undefined
        ) {
          throw new Error("agentMail store: direct delivery cannot carry draft identity");
        }
        const isThreadAction = input.action === "reply" || input.action === "forward";
        if (
          (isThreadAction && (!input.sourceMessageId || !input.threadId)) ||
          (!isThreadAction && (input.sourceMessageId !== undefined || input.threadId !== undefined))
        ) {
          throw new Error("agentMail store: direct delivery source identity is inconsistent");
        }
        if (input.sourceMessageId) {
          assertBoundedIdentifier(input.sourceMessageId, "delivery sourceMessageId");
        }
        if (input.threadId) assertBoundedIdentifier(input.threadId, "delivery threadId");
      }

      return db
        .transaction((): AgentMailDeliveryReservationResult => {
          const existing = findDeliveryOperation.get(inboxId, input.operationId);
          if (existing) {
            const rateRows = db
              .query<{ actor_hash: string; payload_hash: string }, [string, string]>(
                `SELECT actor_hash, payload_hash FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'outbound' AND operation_id = ?`,
              )
              .all(inboxId, input.operationId);
            const expectedRecipients = [...input.recipientHashes].sort();
            const actualRecipients = rateRows.map((row) => row.actor_hash).sort();
            const exact =
              existing.action === input.action &&
              existing.endpoint === input.endpoint &&
              existing.draft_id === (input.draftId ?? null) &&
              existing.source_message_id === (input.sourceMessageId ?? null) &&
              existing.thread_id === (input.threadId ?? null) &&
              existing.draft_kind === (input.draftKind ?? null) &&
              existing.approval_generation === input.approvalGeneration &&
              existing.approval_manifest_hash === input.approvalManifestHash &&
              existing.provider_revision === (input.providerRevision ?? null) &&
              existing.material_hash === (input.materialHash ?? null) &&
              existing.request_hash === input.requestHash &&
              existing.idempotency_key === input.idempotencyKey &&
              rateRows.every((row) => row.payload_hash === input.requestHash) &&
              JSON.stringify(actualRecipients) === JSON.stringify(expectedRecipients);
            return {
              status: exact ? "replay" : "conflict",
              operation: deliveryOperationFromRow(existing),
            };
          }

          if (input.action === "send_draft") {
            const draft = findDraftById.get(inboxId, input.draftId!);
            if (
              draft?.state !== "ready" ||
              draft.kind !== input.draftKind ||
              draft.source_message_id !== (input.sourceMessageId ?? null) ||
              draft.thread_id !== (input.threadId ?? null) ||
              draft.approval_generation + 1 !== input.approvalGeneration ||
              draft.approval_manifest_hash !== null ||
              draft.approved_at !== null ||
              draft.provider_revision !== input.providerRevision ||
              draft.material_hash !== input.materialHash
            ) {
              throw new Error(
                "agentMail store: draft snapshot or approval generation changed before delivery reservation",
              );
            }
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
          if (globalCount >= rateLimit.globalMaxPerHour) {
            return { status: "rate_limited", reason: "global", retryAfterMs: 3_600_000 };
          }
          if (rateLimit.dedupWindowMs > 0) {
            const duplicate = db
              .query<{ present: number }, [string, string, number]>(
                `SELECT 1 AS present FROM agentmail_rate_reservations
                  WHERE inbox_id = ? AND direction = 'outbound'
                    AND payload_hash = ? AND occurred_at > ? LIMIT 1`,
              )
              .get(inboxId, input.requestHash, at - rateLimit.dedupWindowMs);
            if (duplicate) {
              return {
                status: "rate_limited",
                reason: "duplicate",
                retryAfterMs: rateLimit.dedupWindowMs,
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
            if (latest && at - latest.occurred_at < rateLimit.perRecipientCooldownMs) {
              return {
                status: "rate_limited",
                reason: "actor",
                retryAfterMs: rateLimit.perRecipientCooldownMs - (at - latest.occurred_at),
              };
            }
          }

          try {
            db.run(
              `INSERT INTO agentmail_delivery_operations(
                 inbox_id, operation_id, action, endpoint, draft_id, source_message_id,
                 thread_id, draft_kind, approval_generation, approval_manifest_hash,
                 provider_revision, material_hash, request_hash, idempotency_key, state,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
              [
                inboxId,
                input.operationId,
                input.action,
                input.endpoint,
                input.draftId ?? null,
                input.sourceMessageId ?? null,
                input.threadId ?? null,
                input.draftKind ?? null,
                input.approvalGeneration,
                input.approvalManifestHash,
                input.providerRevision ?? null,
                input.materialHash ?? null,
                input.requestHash,
                input.idempotencyKey,
                at,
                at,
              ],
            );
          } catch (error) {
            if (!String(error).includes("UNIQUE")) throw error;
            throw new Error("agentMail store: another delivery operation is already active");
          }
          for (const recipientHash of input.recipientHashes) {
            db.run(
              `INSERT INTO agentmail_rate_reservations(
                 inbox_id, direction, operation_id, actor_hash, payload_hash, occurred_at
               ) VALUES (?, 'outbound', ?, ?, ?, ?)`,
              [inboxId, input.operationId, recipientHash, input.requestHash, at],
            );
          }
          if (input.action === "send_draft") {
            const changed = db.run(
              `UPDATE agentmail_drafts
                  SET state = 'sending', approval_generation = ?, approval_manifest_hash = ?,
                      approved_at = ?, send_operation_kind = 'send', send_operation_id = ?,
                      send_key = ?, send_started_at = NULL, outcome_code = NULL,
                      reconciliation_state = 'none', reconciliation_hash = NULL,
                      reconciled_at = NULL, updated_at = ?
                WHERE inbox_id = ? AND draft_id = ? AND state = 'ready'
                  AND approval_generation = ? AND approval_manifest_hash IS NULL
                  AND approved_at IS NULL
                  AND provider_revision = ? AND material_hash = ?`,
              [
                input.approvalGeneration,
                input.approvalManifestHash,
                at,
                input.operationId,
                input.idempotencyKey,
                at,
                inboxId,
                input.draftId!,
                input.approvalGeneration - 1,
                input.providerRevision!,
                input.materialHash!,
              ],
            );
            if (changed.changes !== 1) {
              throw new Error("agentMail store: draft changed during delivery reservation");
            }
          }
          return {
            status: "reserved",
            operation: deliveryOperationFromRow(
              findDeliveryOperation.get(inboxId, input.operationId)!,
            ),
          };
        })
        .immediate();
    },
    beginDeliveryDispatch(operationId) {
      assertBoundedIdentifier(operationId, "delivery operationId");
      return db
        .transaction(() => {
          const operation = findDeliveryOperation.get(inboxId, operationId);
          if (!operation) throw new Error("agentMail store: delivery operation not found");
          const at = clock();
          if (operation.state === "outcome_unknown") {
            return {
              status: "manual_reconciliation_required",
              operation: deliveryOperationFromRow(operation),
            } as const;
          }
          if (operation.state !== "prepared") {
            return { status: "replay", operation: deliveryOperationFromRow(operation) } as const;
          }
          const firstDispatchAt = operation.first_dispatch_at ?? at;
          const changed = db.run(
            `UPDATE agentmail_delivery_operations
                SET state = 'dispatching', first_dispatch_at = ?,
                    attempt_count = attempt_count + 1, retry_after = NULL,
                    outcome_code = NULL, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = ?`,
            [firstDispatchAt, at, inboxId, operationId, operation.state],
          );
          if (changed.changes !== 1) {
            throw new Error("agentMail store: delivery operation changed before dispatch");
          }
          if (operation.draft_id !== null) {
            db.run(
              `UPDATE agentmail_drafts
                  SET state = 'sending', send_started_at = ?, outcome_code = NULL,
                      reconciliation_state = 'none', updated_at = ?
                WHERE inbox_id = ? AND draft_id = ? AND send_operation_id = ?`,
              [at, at, inboxId, operation.draft_id, operationId],
            );
          }
          return {
            status: "dispatch",
            operation: deliveryOperationFromRow(findDeliveryOperation.get(inboxId, operationId)!),
          } as const;
        })
        .immediate();
    },
    beginDeliveryRetry(operationId) {
      assertBoundedIdentifier(operationId, "delivery operationId");
      return db
        .transaction(() => {
          const operation = findDeliveryOperation.get(inboxId, operationId);
          if (!operation) throw new Error("agentMail store: delivery operation not found");
          const at = clock();
          if (operation.state !== "retryable") {
            return { status: "replay", operation: deliveryOperationFromRow(operation) } as const;
          }
          if (operation.retry_after! > at) {
            return {
              status: "wait",
              retryAfterMs: operation.retry_after! - at,
              operation: deliveryOperationFromRow(operation),
            } as const;
          }
          const changed = db.run(
            `UPDATE agentmail_delivery_operations
                SET state = 'dispatching', attempt_count = attempt_count + 1,
                    retry_after = NULL, outcome_code = NULL, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = 'retryable'`,
            [at, inboxId, operationId],
          );
          if (changed.changes !== 1) {
            throw new Error("agentMail store: delivery operation changed before retry dispatch");
          }
          if (operation.draft_id !== null) {
            db.run(
              `UPDATE agentmail_drafts
                  SET state = 'sending', send_started_at = ?, outcome_code = NULL,
                      reconciliation_state = 'none', updated_at = ?
                WHERE inbox_id = ? AND draft_id = ? AND send_operation_id = ?`,
              [at, at, inboxId, operation.draft_id, operationId],
            );
          }
          return {
            status: "dispatch",
            operation: deliveryOperationFromRow(findDeliveryOperation.get(inboxId, operationId)!),
          } as const;
        })
        .immediate();
    },
    getDeliveryOperation(operationId) {
      assertBoundedIdentifier(operationId, "delivery operationId");
      const operation = findDeliveryOperation.get(inboxId, operationId);
      return operation ? deliveryOperationFromRow(operation) : undefined;
    },
    listUnresolvedDeliveryOperations(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("agentMail store: delivery operation limit must be between 1 and 1000");
      }
      return db
        .query<DeliveryOperationRow, [string, number]>(
          `SELECT ${DELIVERY_OPERATION_COLUMNS} FROM agentmail_delivery_operations
            WHERE inbox_id = ? AND state IN ('prepared', 'dispatching', 'retryable', 'outcome_unknown')
            ORDER BY created_at ASC, operation_id ASC LIMIT ?`,
        )
        .all(inboxId, limit)
        .map(deliveryOperationFromRow);
    },
    settleDeliveryOperation(operationId, outcome) {
      assertBoundedIdentifier(operationId, "delivery operationId");
      if (outcome.status === "sent") {
        assertBoundedIdentifier(outcome.messageId, "delivery messageId");
        assertBoundedIdentifier(outcome.threadId, "delivery threadId");
      } else {
        assertBoundedIdentifier(outcome.code, "delivery outcomeCode");
      }
      if (outcome.status === "retryable") {
        assertTimestamp(outcome.retryAfter, "delivery retryAfter");
      }
      return db
        .transaction(() => {
          const operation = findDeliveryOperation.get(inboxId, operationId);
          if (!operation) throw new Error("agentMail store: delivery operation not found");
          if (operation.state !== "dispatching") {
            const exact =
              operation.state === outcome.status &&
              (outcome.status === "sent"
                ? operation.sent_message_id === outcome.messageId &&
                  operation.sent_thread_id === outcome.threadId
                : operation.outcome_code === outcome.code &&
                  (outcome.status !== "retryable" || operation.retry_after === outcome.retryAfter));
            if (exact) return deliveryOperationFromRow(operation);
            throw new Error("agentMail store: delivery operation was already settled differently");
          }
          const at = clock();
          if (outcome.status === "retryable" && outcome.retryAfter <= at) {
            throw new Error("agentMail store: delivery retryAfter must be in the future");
          }
          db.run(
            `UPDATE agentmail_delivery_operations
                SET state = ?, retry_after = ?, sent_message_id = ?, sent_thread_id = ?,
                    outcome_code = ?, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = 'dispatching'`,
            [
              outcome.status,
              outcome.status === "retryable" ? outcome.retryAfter : null,
              outcome.status === "sent" ? outcome.messageId : null,
              outcome.status === "sent" ? outcome.threadId : null,
              outcome.status === "sent" ? null : outcome.code,
              at,
              inboxId,
              operationId,
            ],
          );
          if (operation.draft_id !== null) {
            const draftState: AgentMailProviderDraftState =
              outcome.status === "sent"
                ? "sent"
                : outcome.status === "outcome_unknown"
                  ? "ambiguous"
                  : outcome.status === "retryable"
                    ? "sending"
                    : "ready";
            db.run(
              `UPDATE agentmail_drafts
                  SET state = ?, sent_message_id = ?, sent_thread_id = ?, outcome_code = ?,
                      approval_manifest_hash = CASE WHEN ? = 'failed' THEN NULL ELSE approval_manifest_hash END,
                      approved_at = CASE WHEN ? = 'failed' THEN NULL ELSE approved_at END,
                      reconciliation_state = CASE WHEN ? = 'outcome_unknown' THEN 'required' ELSE 'none' END,
                      updated_at = ?
                WHERE inbox_id = ? AND draft_id = ? AND send_operation_id = ?`,
              [
                draftState,
                outcome.status === "sent" ? outcome.messageId : null,
                outcome.status === "sent" ? outcome.threadId : null,
                outcome.status === "sent" ? null : outcome.code,
                outcome.status,
                outcome.status,
                outcome.status,
                at,
                inboxId,
                operation.draft_id,
                operationId,
              ],
            );
            if (outcome.status === "sent") {
              supersedePendingDraftAttention("?", [operation.draft_id]);
            }
          }
          if (outcome.status === "sent") enqueueRecordedDeliveryFailures(outcome.messageId);
          return deliveryOperationFromRow(findDeliveryOperation.get(inboxId, operationId)!);
        })
        .immediate();
    },
    reconcileDeliveryOperation(input) {
      assertBoundedIdentifier(input.operationId, "delivery operationId");
      if (!validHash(input.evidenceHash)) {
        throw new Error("agentMail store: delivery reconciliation evidence hash is invalid");
      }
      if (input.resolution.status === "sent") {
        assertBoundedIdentifier(input.resolution.messageId, "delivery messageId");
        assertBoundedIdentifier(input.resolution.threadId, "delivery threadId");
      }
      return db
        .transaction(() => {
          const operation = findDeliveryOperation.get(inboxId, input.operationId);
          if (!operation) throw new Error("agentMail store: delivery operation not found");
          const targetState = input.resolution.status === "sent" ? "sent" : "reconciled_not_sent";
          if (operation.state !== "outcome_unknown") {
            const exact =
              operation.state === targetState &&
              operation.reconciliation_hash === input.evidenceHash &&
              (input.resolution.status !== "sent" ||
                (operation.sent_message_id === input.resolution.messageId &&
                  operation.sent_thread_id === input.resolution.threadId));
            if (exact) return deliveryOperationFromRow(operation);
            throw new Error("agentMail store: delivery operation is not awaiting reconciliation");
          }
          const at = clock();
          db.run(
            `UPDATE agentmail_delivery_operations
                SET state = ?, sent_message_id = ?, sent_thread_id = ?, reconciliation_hash = ?,
                    reconciled_at = ?, updated_at = ?
              WHERE inbox_id = ? AND operation_id = ? AND state = 'outcome_unknown'`,
            [
              targetState,
              input.resolution.status === "sent" ? input.resolution.messageId : null,
              input.resolution.status === "sent" ? input.resolution.threadId : null,
              input.evidenceHash,
              at,
              at,
              inboxId,
              input.operationId,
            ],
          );
          if (operation.draft_id !== null) {
            db.run(
              `UPDATE agentmail_drafts
                  SET state = ?, sent_message_id = ?, sent_thread_id = ?,
                      approval_manifest_hash = CASE WHEN ? = 'reconciled_not_sent' THEN NULL ELSE approval_manifest_hash END,
                      approved_at = CASE WHEN ? = 'reconciled_not_sent' THEN NULL ELSE approved_at END,
                      outcome_code = NULL, reconciliation_state = ?, reconciliation_hash = ?,
                      reconciled_at = ?, updated_at = ?
                WHERE inbox_id = ? AND draft_id = ? AND send_operation_id = ?
                  AND state = 'ambiguous'`,
              [
                input.resolution.status === "sent" ? "sent" : "ready",
                input.resolution.status === "sent" ? input.resolution.messageId : null,
                input.resolution.status === "sent" ? input.resolution.threadId : null,
                targetState,
                targetState,
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
            }
          }
          if (input.resolution.status === "sent") {
            enqueueRecordedDeliveryFailures(input.resolution.messageId);
          }
          return deliveryOperationFromRow(findDeliveryOperation.get(inboxId, input.operationId)!);
        })
        .immediate();
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
              .query<{ present: number }, [string, string]>(
                `SELECT 1 AS present FROM agentmail_delivery_operations
                  WHERE inbox_id = ? AND sent_message_id = ? AND state = 'sent'
                LIMIT 1`,
              )
              .get(inboxId, input.messageId);
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

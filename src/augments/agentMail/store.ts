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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agentmail_mailboxes (
    inbox_id             TEXT PRIMARY KEY,
    checkpoint_timestamp INTEGER NOT NULL DEFAULT 0,
    checkpoint_message_id TEXT,
    updated_at           INTEGER NOT NULL
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
    inbox_id           TEXT NOT NULL,
    source_message_id  TEXT NOT NULL,
    thread_id          TEXT NOT NULL,
    draft_id           TEXT NOT NULL,
    client_id          TEXT NOT NULL,
    provider_updated_at INTEGER NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('ready', 'stale', 'approved', 'sending', 'sent', 'ambiguous', 'failed')),
    approval_hash      TEXT,
    approved_at        INTEGER,
    send_key           TEXT,
    send_started_at    INTEGER,
    sent_message_id    TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, source_message_id),
    UNIQUE (inbox_id, draft_id),
    UNIQUE (inbox_id, client_id),
    FOREIGN KEY (inbox_id, source_message_id)
      REFERENCES agentmail_messages(inbox_id, message_id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_draft_state
     ON agentmail_drafts(inbox_id, state, updated_at)`,
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

function validateSchema(_db: Database, objects: readonly SqliteSchemaObject[]): void {
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
  getMessage(messageId: string): AgentMailWorkItem | undefined;
  hasPendingWork(): boolean;
  listPendingMessageIds(limit?: number): string[];
  advanceCheckpoint(timestamp: number, messageId: string): void;
  getCheckpoint(): { timestamp: number; messageId?: string };
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
  source_message_id: string;
  thread_id: string;
  draft_id: string;
  client_id: string;
  provider_updated_at: number;
  state: AgentMailDraftReference["state"];
  send_key: string | null;
  send_started_at: number | null;
  sent_message_id: string | null;
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
  return {
    inboxId: row.inbox_id,
    sourceMessageId: row.source_message_id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    clientId: row.client_id,
    providerUpdatedAt: row.provider_updated_at,
    state: row.state,
    ...(row.send_key === null ? {} : { sendKey: row.send_key }),
    ...(row.send_started_at === null ? {} : { sendStartedAt: row.send_started_at }),
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
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

export function hashAgentMailOrchestrationValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
          for (const sql of SCHEMA) database.run(sql);
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
    `SELECT inbox_id, source_message_id, thread_id, draft_id, client_id,
            provider_updated_at, state, send_key, send_started_at, sent_message_id
       FROM agentmail_drafts WHERE inbox_id = ? AND source_message_id = ?`,
  );
  const findDraftById = db.query<DraftRow, [string, string]>(
    `SELECT inbox_id, source_message_id, thread_id, draft_id, client_id,
            provider_updated_at, state, send_key, send_started_at, sent_message_id
       FROM agentmail_drafts WHERE inbox_id = ? AND draft_id = ?`,
  );

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
      const at = clock();
      const drafts = db.run(
        `UPDATE agentmail_drafts SET state = 'ambiguous', updated_at = ?
          WHERE inbox_id = ? AND state = 'sending'`,
        [at, inboxId],
      ).changes;
      const outbound = db.run(
        `UPDATE agentmail_outbound_operations SET state = 'ambiguous', updated_at = ?
          WHERE inbox_id = ? AND state = 'reserved'`,
        [at, inboxId],
      ).changes;
      return { drafts, outbound };
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
    recordDraft(input) {
      for (const [field, value] of Object.entries(input)) {
        if (field !== "providerUpdatedAt") assertBoundedIdentifier(String(value), field);
      }
      if (!Number.isSafeInteger(input.providerUpdatedAt) || input.providerUpdatedAt < 0) {
        throw new Error("agentMail store: provider draft timestamp is invalid");
      }
      const existing = findDraft.get(inboxId, input.sourceMessageId);
      if (existing) {
        return {
          status:
            existing.draft_id === input.draftId && existing.client_id === input.clientId
              ? "duplicate"
              : "conflict",
        };
      }
      try {
        const at = clock();
        const source = findMessage.get(inboxId, input.sourceMessageId);
        if (!source || source.thread_id !== input.threadId) {
          throw new Error("agentMail store: draft source does not match a claimed message");
        }
        const newerMessage = db
          .query<{ present: number }, [string, string, number, number, string]>(
            `SELECT 1 AS present FROM agentmail_messages
              WHERE inbox_id = ? AND thread_id = ?
                AND (received_at > ? OR (received_at = ? AND message_id > ?))
              LIMIT 1`,
          )
          .get(
            inboxId,
            input.threadId,
            source.received_at,
            source.received_at,
            input.sourceMessageId,
          );
        const initialState = newerMessage ? "stale" : "ready";
        db.run(
          `INSERT INTO agentmail_drafts(
             inbox_id, source_message_id, thread_id, draft_id, client_id,
             provider_updated_at, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            inboxId,
            input.sourceMessageId,
            input.threadId,
            input.draftId,
            input.clientId,
            input.providerUpdatedAt,
            initialState,
            at,
            at,
          ],
        );
        return { status: "recorded" };
      } catch (error) {
        if (String(error).includes("UNIQUE")) return { status: "conflict" };
        throw error;
      }
    },
    getDraftByMessage(messageId) {
      const row = findDraft.get(inboxId, messageId);
      return row ? draftFromRow(row) : undefined;
    },
    getDraftById(draftId) {
      assertBoundedIdentifier(draftId, "draftId");
      const row = findDraftById.get(inboxId, draftId);
      return row ? draftFromRow(row) : undefined;
    },
    listDrafts(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("agentMail store: draft limit must be between 1 and 1000");
      }
      return db
        .query<DraftRow, [string, number]>(
          `SELECT inbox_id, source_message_id, thread_id, draft_id, client_id,
                  provider_updated_at, state, send_key, send_started_at, sent_message_id
             FROM agentmail_drafts WHERE inbox_id = ?
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
      const result = db.run(
        `UPDATE agentmail_drafts
            SET provider_updated_at = ?, state = 'ready', approval_hash = NULL,
                approved_at = NULL, send_key = NULL, send_started_at = NULL, updated_at = ?
          WHERE inbox_id = ? AND source_message_id = ? AND provider_updated_at = ?
            AND state IN ('ready', 'stale', 'failed')`,
        [input.providerUpdatedAt, clock(), inboxId, input.sourceMessageId, input.expectedUpdatedAt],
      );
      if (result.changes !== 1) {
        throw new Error("agentMail store: draft changed or cannot return to review");
      }
    },
    markThreadDraftsStale(threadId, exceptSourceMessageId) {
      assertBoundedIdentifier(threadId, "threadId");
      assertBoundedIdentifier(exceptSourceMessageId, "exceptSourceMessageId");
      return db.run(
        `UPDATE agentmail_drafts SET state = 'stale', approval_hash = NULL,
                approved_at = NULL, updated_at = ?
          WHERE inbox_id = ? AND thread_id = ? AND source_message_id <> ?
            AND state IN ('ready', 'approved')`,
        [clock(), inboxId, threadId, exceptSourceMessageId],
      ).changes;
    },
    markDraftStale(sourceMessageId) {
      db.run(
        `UPDATE agentmail_drafts SET state = 'stale', updated_at = ?
          WHERE inbox_id = ? AND source_message_id = ? AND state IN ('ready', 'approved')`,
        [clock(), inboxId, sourceMessageId],
      );
    },
    approveDraft(input) {
      if (
        input.approvalEvidence.trim().length === 0 ||
        Buffer.byteLength(input.approvalEvidence, "utf8") > 4_096
      ) {
        throw new Error("agentMail store: approval evidence is invalid");
      }
      const result = db.run(
        `UPDATE agentmail_drafts
            SET state = 'approved', approval_hash = ?, approved_at = ?, updated_at = ?
          WHERE inbox_id = ? AND source_message_id = ? AND state = 'ready'
            AND provider_updated_at = ?`,
        [
          hashAgentMailOrchestrationValue(input.approvalEvidence),
          clock(),
          clock(),
          inboxId,
          input.sourceMessageId,
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
          db.run(
            `UPDATE agentmail_drafts SET state = 'sending', send_key = ?,
                    send_started_at = ?, updated_at = ?
              WHERE inbox_id = ? AND source_message_id = ? AND state = 'approved'`,
            [sendKey, clock(), clock(), inboxId, sourceMessageId],
          );
          return { status: "reserved" as const, sendKey };
        })
        .immediate();
    },
    settleDraftSend(sourceMessageId, outcome) {
      const state = outcome.status;
      const result = db.run(
        `UPDATE agentmail_drafts
            SET state = ?, sent_message_id = ?,
                send_key = CASE WHEN ? = 'ready' THEN NULL ELSE send_key END,
                send_started_at = CASE WHEN ? = 'ready' THEN NULL ELSE send_started_at END,
                updated_at = ?
          WHERE inbox_id = ? AND source_message_id = ? AND state = 'sending'`,
        [
          state,
          outcome.status === "sent" ? outcome.messageId : null,
          state,
          state,
          clock(),
          inboxId,
          sourceMessageId,
        ],
      );
      if (result.changes !== 1) throw new Error("agentMail store: no reserved send to settle");
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
    },
    recordProviderEvent(input) {
      if (!validHash(input.payloadHash)) throw new Error("agentMail store: event hash is invalid");
      assertBoundedIdentifier(input.eventId, "eventId");
      assertBoundedIdentifier(input.eventType, "eventType");
      if (input.messageId !== undefined) assertBoundedIdentifier(input.messageId, "messageId");
      if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
        throw new Error("agentMail store: event timestamp is invalid");
      }
      const existing = db
        .query<{ payload_hash: string; event_type: string }, [string, string]>(
          `SELECT payload_hash, event_type FROM agentmail_provider_events
            WHERE inbox_id = ? AND event_id = ?`,
        )
        .get(inboxId, input.eventId);
      if (existing) {
        return existing.payload_hash === input.payloadHash &&
          existing.event_type === input.eventType
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
      return "recorded";
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

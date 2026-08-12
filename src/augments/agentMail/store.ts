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
  sentMessageId?: string;
}

export interface AgentMailOrchestrationStore {
  claimMessage(input: {
    messageId: string;
    threadId: string;
    eventId?: string;
    classification: AgentMailMessageClassification;
    senderHash: string;
    payloadHash: string;
    receivedAt: number;
    policyVersion: number;
  }): { status: "claimed" | "duplicate" | "conflict" };
  claimNext(): AgentMailWorkItem | undefined;
  settleMessage(
    messageId: string,
    outcome: "no_reply" | "draft_ready" | "quarantined" | "completed",
    errorCode?: string,
  ): void;
  recoverInterrupted(staleBefore: number): number;
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
    outcome: { status: "sent"; messageId: string } | { status: "ambiguous" | "failed" },
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
    ...(row.sent_message_id === null ? {} : { sentMessageId: row.sent_message_id }),
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
    `SELECT inbox_id, message_id, thread_id, event_id, classification, sender_hash,
            payload_hash, received_at, state, attempt_count, policy_version
       FROM agentmail_messages WHERE inbox_id = ? AND message_id = ?`,
  );
  const findDraft = db.query<DraftRow, [string, string]>(
    `SELECT inbox_id, source_message_id, thread_id, draft_id, client_id,
            provider_updated_at, state, send_key, sent_message_id
       FROM agentmail_drafts WHERE inbox_id = ? AND source_message_id = ?`,
  );

  const claimMessage = db.transaction(
    (input: Parameters<AgentMailOrchestrationStore["claimMessage"]>[0]) => {
      assertBoundedIdentifier(input.messageId, "messageId");
      assertBoundedIdentifier(input.threadId, "threadId");
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
             inbox_id, message_id, thread_id, event_id, classification, sender_hash,
             payload_hash, received_at, state, policy_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            inboxId,
            input.messageId,
            input.threadId,
            input.eventId ?? null,
            input.classification,
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
        `SELECT inbox_id, message_id, thread_id, event_id, classification, sender_hash,
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

  return {
    claimMessage(input) {
      return claimMessage.immediate(input);
    },
    claimNext() {
      return claimNext.immediate();
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
        db.run(
          `INSERT INTO agentmail_drafts(
             inbox_id, source_message_id, thread_id, draft_id, client_id,
             provider_updated_at, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
          [
            inboxId,
            input.sourceMessageId,
            input.threadId,
            input.draftId,
            input.clientId,
            input.providerUpdatedAt,
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
            `UPDATE agentmail_drafts SET state = 'sending', send_key = ?, updated_at = ?
              WHERE inbox_id = ? AND source_message_id = ? AND state = 'approved'`,
            [sendKey, clock(), inboxId, sourceMessageId],
          );
          return { status: "reserved" as const, sendKey };
        })
        .immediate();
    },
    settleDraftSend(sourceMessageId, outcome) {
      const state = outcome.status;
      const result = db.run(
        `UPDATE agentmail_drafts
            SET state = ?, sent_message_id = ?, updated_at = ?
          WHERE inbox_id = ? AND source_message_id = ? AND state = 'sending'`,
        [
          state,
          outcome.status === "sent" ? outcome.messageId : null,
          clock(),
          inboxId,
          sourceMessageId,
        ],
      );
      if (result.changes !== 1) throw new Error("agentMail store: no reserved send to settle");
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

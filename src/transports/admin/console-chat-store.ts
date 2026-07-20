import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteDiagnostics,
  type SqliteSchemaObject,
} from "../../lib/sqlite";
import type {
  Message as KernelMessage,
  PeerIdentity,
  PeerKind,
  ThreadHistoryPersistence,
  ThreadHistorySnapshot,
  TrustLevel,
} from "../../types";

export const CONSOLE_CHAT_APPLICATION_ID = 0x43434854; // "CCHT"
export const CONSOLE_CHAT_SCHEMA_VERSION = 1;

const STORE_LABEL = "console chat store";
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 80;
const MAX_MODEL_FIELD_LENGTH = 512;
const MAX_PEER_ID_LENGTH = 1_024;
const MAX_MESSAGE_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_TOOL_JSON_LENGTH = 16 * 1024 * 1024;
const MAX_KERNEL_HISTORY_JSON_LENGTH = 64 * 1024 * 1024;

export type ConsoleChatPreviewMode = "creator" | "anonymous" | "visitor";
export type ConsoleChatRunStatus = "idle" | "streaming" | "complete" | "error" | "interrupted";
export type ConsoleChatMessageRole = "user" | "assistant";

export interface ConsoleChatModelSnapshot {
  id: string;
  displayName: string;
  provider: string | null;
}

/** Identity fields produced by transport identify(); never credentials or visitor PII. */
export interface ConsoleChatOwnerIdentity {
  peerId: string;
  kind: PeerKind;
  trustLevel: TrustLevel;
  publicSubstate: "anonymous" | "recognized" | null;
}

export function consoleChatOwnerFromPeer(peer: PeerIdentity): ConsoleChatOwnerIdentity {
  return {
    peerId: peer.id,
    kind: peer.kind,
    trustLevel: peer.trustLevel,
    publicSubstate: peer.publicSubstate ?? null,
  };
}

export function consoleChatOwnerMatchesPeer(
  owner: ConsoleChatOwnerIdentity,
  peer: PeerIdentity,
): boolean {
  return sameOwner(owner, consoleChatOwnerFromPeer(peer));
}

export interface ConsoleChatToolCall {
  id: string;
  name: string;
  args?: string;
  result?: string;
  status: "running" | "completed" | "error";
}

export interface ConsoleChatMessage {
  id: string;
  sequence: number;
  role: ConsoleChatMessageRole;
  content: string;
  toolCalls: ConsoleChatToolCall[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConsoleChatThreadSummary {
  id: string;
  title: string;
  previewMode: ConsoleChatPreviewMode;
  owner: ConsoleChatOwnerIdentity | null;
  model: ConsoleChatModelSnapshot | null;
  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  unread: boolean;
  runStatus: ConsoleChatRunStatus;
}

export interface ConsoleChatThread extends ConsoleChatThreadSummary {
  messages: ConsoleChatMessage[];
}

export interface CreateConsoleChatThreadInput {
  id: string;
  title: string;
  previewMode: ConsoleChatPreviewMode;
  owner?: ConsoleChatOwnerIdentity | null;
  model?: ConsoleChatModelSnapshot | null;
  createdAt: number;
  updatedAt?: number;
  lastReadAt?: number | null;
  unread?: boolean;
  runStatus?: ConsoleChatRunStatus;
}

export interface AppendConsoleChatMessageInput {
  id: string;
  role: ConsoleChatMessageRole;
  content: string;
  toolCalls?: ConsoleChatToolCall[] | null;
  error?: string | null;
  createdAt: number;
  updatedAt?: number;
}

export interface UpdateConsoleChatMessageInput {
  content?: string;
  toolCalls?: ConsoleChatToolCall[] | null;
  error?: string | null;
  updatedAt: number;
}

export interface UpdateConsoleChatThreadInput {
  owner?: ConsoleChatOwnerIdentity | null;
  model?: ConsoleChatModelSnapshot | null;
  updatedAt: number;
  runStatus?: ConsoleChatRunStatus;
  unread?: boolean;
  lastReadAt?: number | null;
}

export interface ConsoleChatStore {
  listThreads(): ConsoleChatThreadSummary[];
  getThread(threadId: string): ConsoleChatThread | null;
  createThread(input: CreateConsoleChatThreadInput): ConsoleChatThread;
  createThreadWithMessages(
    input: CreateConsoleChatThreadInput,
    messages: readonly AppendConsoleChatMessageInput[],
  ): ConsoleChatThread;
  upsertThread(input: CreateConsoleChatThreadInput): ConsoleChatThread;
  updateThread(
    threadId: string,
    input: UpdateConsoleChatThreadInput,
  ): ConsoleChatThreadSummary | null;
  appendMessage(threadId: string, input: AppendConsoleChatMessageInput): ConsoleChatMessage;
  updateMessage(
    threadId: string,
    messageId: string,
    input: UpdateConsoleChatMessageInput,
  ): ConsoleChatMessage | null;
  renameThread(threadId: string, title: string, updatedAt: number): ConsoleChatThreadSummary | null;
  setThreadReadState(
    threadId: string,
    unread: boolean,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null;
  deleteThread(threadId: string): boolean;
  loadKernelHistory(threadId: string): KernelMessage[] | null;
  saveKernelHistory(threadId: string, messages: readonly KernelMessage[], updatedAt: number): void;
  clearKernelHistory(threadId: string): boolean;
  /**
   * Atomically claim an unbound thread for this peer, or verify that its
   * existing owner is an exact identity match. This is the authorization
   * boundary used by kernel history persistence.
   */
  assertKernelHistoryAccess(threadId: string, peer: PeerIdentity): void;
  /** Claim/check access and return only the last committed history row. */
  loadKernelHistoryForPeer(threadId: string, peer: PeerIdentity): KernelMessage[] | null;
  /** Check access and atomically replace the committed history row. */
  commitKernelHistoryForPeer(
    threadId: string,
    peer: PeerIdentity,
    messages: readonly KernelMessage[],
  ): void;
  diagnostics(): SqliteDiagnostics;
  close(): void;
}

/**
 * Adapt the console transcript store to the kernel's transport-scoped history
 * contract. The store deliberately retains only the stable authorization
 * tuple from PeerIdentity; credentials and cosmetic/PII fields never cross
 * this boundary.
 */
export function createConsoleThreadHistoryPersistence(
  store: ConsoleChatStore,
): ThreadHistoryPersistence {
  return {
    async load(threadId, peer) {
      const messages = store.loadKernelHistoryForPeer(threadId, peer);
      return messages === null ? null : ({ version: 1, messages } satisfies ThreadHistorySnapshot);
    },
    async assertAccess(threadId, peer) {
      store.assertKernelHistoryAccess(threadId, peer);
    },
    async commit(threadId, peer, snapshot) {
      if (!isPlainObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.messages)) {
        throw new Error(`${STORE_LABEL}: invalid kernel history snapshot`);
      }
      store.commitKernelHistoryForPeer(threadId, peer, snapshot.messages);
    },
  };
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS console_chat_threads (
    id                TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256),
    title             TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    preview_mode      TEXT NOT NULL CHECK(preview_mode IN ('creator', 'anonymous', 'visitor')),
    bound_peer_id     TEXT CHECK(bound_peer_id IS NULL OR length(bound_peer_id) BETWEEN 1 AND 1024),
    owner_peer_kind   TEXT CHECK(owner_peer_kind IS NULL OR owner_peer_kind IN ('human', 'agent', 'system', 'anonymous')),
    owner_trust_level TEXT CHECK(owner_trust_level IS NULL OR owner_trust_level IN ('creator', 'agent', 'public')),
    owner_public_substate TEXT CHECK(owner_public_substate IS NULL OR owner_public_substate IN ('anonymous', 'recognized')),
    model_provider    TEXT CHECK(model_provider IS NULL OR length(model_provider) BETWEEN 1 AND 512),
    model_id          TEXT CHECK(model_id IS NULL OR length(model_id) BETWEEN 1 AND 512),
    model_display     TEXT CHECK(model_display IS NULL OR length(model_display) BETWEEN 1 AND 512),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK(updated_at >= created_at),
    last_read_at      INTEGER CHECK(last_read_at IS NULL OR last_read_at >= 0),
    unread            INTEGER NOT NULL CHECK(unread IN (0, 1)),
    run_status        TEXT NOT NULL CHECK(run_status IN ('idle', 'streaming', 'complete', 'error', 'interrupted')),
    CHECK((bound_peer_id IS NULL AND owner_peer_kind IS NULL AND owner_trust_level IS NULL AND owner_public_substate IS NULL) OR
          (bound_peer_id IS NOT NULL AND owner_peer_kind IS NOT NULL AND owner_trust_level IS NOT NULL AND
           ((owner_trust_level = 'public' AND owner_public_substate IS NOT NULL) OR
            (owner_trust_level != 'public' AND owner_public_substate IS NULL)))),
    CHECK((model_id IS NULL AND model_display IS NULL AND model_provider IS NULL) OR
          (model_id IS NOT NULL AND model_display IS NOT NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_console_chat_threads_updated
    ON console_chat_threads(updated_at DESC, id ASC)`,
  `CREATE TABLE IF NOT EXISTS console_chat_messages (
    thread_id         TEXT NOT NULL,
    sequence          INTEGER NOT NULL CHECK(sequence >= 0),
    id                TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 256),
    role              TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content           TEXT NOT NULL CHECK(length(content) <= 16777216),
    tool_calls_json   TEXT CHECK(tool_calls_json IS NULL OR length(tool_calls_json) <= 16777216),
    error             TEXT CHECK(error IS NULL OR length(error) <= 16777216),
    created_at        INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK(updated_at >= created_at),
    PRIMARY KEY(thread_id, sequence),
    UNIQUE(thread_id, id),
    FOREIGN KEY(thread_id) REFERENCES console_chat_threads(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_console_chat_messages_thread
    ON console_chat_messages(thread_id, sequence ASC)`,
  `CREATE TABLE IF NOT EXISTS console_chat_kernel_history (
    thread_id         TEXT PRIMARY KEY,
    history_json      TEXT NOT NULL CHECK(length(history_json) <= 67108864),
    updated_at        INTEGER NOT NULL CHECK(updated_at >= 0),
    FOREIGN KEY(thread_id) REFERENCES console_chat_threads(id) ON DELETE CASCADE
  )`,
] as const;

const EXPECTED_SCHEMA = new Map(
  SCHEMA_STATEMENTS.map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error(`${STORE_LABEL}: invalid schema declaration`);
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

function assertExactSchema(objects: readonly SqliteSchemaObject[]): void {
  if (!hasExactSchema(objects)) {
    throw new Error(
      `${STORE_LABEL}: database schema contains missing, incompatible, or unexpected objects`,
    );
  }
}

interface ThreadRow {
  id: unknown;
  title: unknown;
  preview_mode: unknown;
  bound_peer_id: unknown;
  owner_peer_kind: unknown;
  owner_trust_level: unknown;
  owner_public_substate: unknown;
  model_provider: unknown;
  model_id: unknown;
  model_display: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_read_at: unknown;
  unread: unknown;
  run_status: unknown;
}

interface MessageRow {
  id: unknown;
  sequence: unknown;
  role: unknown;
  content: unknown;
  tool_calls_json: unknown;
  error: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface HistoryRow {
  history_json: unknown;
  updated_at: unknown;
}

export function createConsoleChatStore(options: {
  dbPath: string;
  now?: () => number;
}): ConsoleChatStore {
  const now = options.now ?? Date.now;
  const database = openHardenedSqlite({
    path: options.dbPath,
    label: STORE_LABEL,
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: STORE_LABEL,
        applicationId: CONSOLE_CHAT_APPLICATION_ID,
        schemaVersion: CONSOLE_CHAT_SCHEMA_VERSION,
        initialize(db) {
          for (const statement of SCHEMA_STATEMENTS) db.run(statement);
        },
        isLegacy() {
          return false;
        },
        validate(_db, objects) {
          assertExactSchema(objects);
        },
      });
    },
  });
  const db = database.db;

  // A process exit cannot leave an attached stream. Preserve its transcript,
  // but make the terminal state truthful before serving any reads.
  const openedAt = assertTimestamp(now(), "now()");
  db.run(
    `UPDATE console_chat_threads
       SET run_status = 'interrupted', updated_at = MAX(updated_at, ?)
     WHERE run_status = 'streaming'`,
    [openedAt],
  );

  const listThreadsStatement = db.prepare(
    `SELECT * FROM console_chat_threads ORDER BY updated_at DESC, id ASC`,
  );
  const getThreadStatement = db.prepare(`SELECT * FROM console_chat_threads WHERE id = ?`);
  const getMessagesStatement = db.prepare(
    `SELECT id, sequence, role, content, tool_calls_json, error, created_at, updated_at
       FROM console_chat_messages WHERE thread_id = ? ORDER BY sequence ASC`,
  );
  const getMessageStatement = db.prepare(
    `SELECT id, sequence, role, content, tool_calls_json, error, created_at, updated_at
       FROM console_chat_messages WHERE thread_id = ? AND id = ?`,
  );
  const getNextSequenceStatement = db.prepare(
    `SELECT COALESCE(MAX(sequence) + 1, 0) AS sequence
       FROM console_chat_messages WHERE thread_id = ?`,
  );
  const countMessagesStatement = db.prepare(
    `SELECT COUNT(*) AS count FROM console_chat_messages WHERE thread_id = ?`,
  );
  const getHistoryStatement = db.prepare(
    `SELECT history_json, updated_at FROM console_chat_kernel_history WHERE thread_id = ?`,
  );

  function listThreads(): ConsoleChatThreadSummary[] {
    return (listThreadsStatement.all() as ThreadRow[]).map(rowToThread);
  }

  function getThread(threadId: string): ConsoleChatThread | null {
    const id = assertIdentifier(threadId, "threadId");
    const row = getThreadStatement.get(id) as ThreadRow | null;
    if (!row) return null;
    return {
      ...rowToThread(row),
      messages: (getMessagesStatement.all(id) as MessageRow[]).map(rowToMessage),
    };
  }

  function insertThread(input: CreateConsoleChatThreadInput): void {
    const value = normalizeThreadInput(input);
    db.run(
      `INSERT INTO console_chat_threads
        (id, title, preview_mode, bound_peer_id, owner_peer_kind, owner_trust_level,
         owner_public_substate, model_provider, model_id, model_display, created_at, updated_at,
         last_read_at, unread, run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      threadBindings(value),
    );
  }

  function createThread(input: CreateConsoleChatThreadInput): ConsoleChatThread {
    insertThread(input);
    return requiredThread(input.id);
  }

  function createThreadWithMessages(
    input: CreateConsoleChatThreadInput,
    messages: readonly AppendConsoleChatMessageInput[],
  ): ConsoleChatThread {
    const thread = normalizeThreadInput(input);
    if (messages.length > 0 && thread.owner === null) {
      throw new Error(`${STORE_LABEL}: populated thread requires an identified owner`);
    }
    const normalizedMessages = messages.map(normalizeMessageInput);
    if (normalizedMessages.some((message) => message.createdAt < thread.createdAt)) {
      throw new Error(`${STORE_LABEL}: message timestamp predates thread`);
    }
    const transaction = db.transaction(() => {
      insertThread(input);
      normalizedMessages.forEach((message, sequence) => {
        insertMessage(assertIdentifier(input.id, "thread.id"), sequence, message);
      });
      const latestActivityAt = normalizedMessages.reduce(
        (latest, message) => Math.max(latest, message.updatedAt),
        thread.updatedAt,
      );
      db.run(`UPDATE console_chat_threads SET updated_at = ? WHERE id = ?`, [
        latestActivityAt,
        thread.id,
      ]);
    });
    transaction();
    return requiredThread(input.id);
  }

  function upsertThread(input: CreateConsoleChatThreadInput): ConsoleChatThread {
    const value = normalizeThreadInput(input);
    const existingRow = getThreadStatement.get(value.id) as ThreadRow | null;
    if (existingRow) {
      const existing = rowToThread(existingRow);
      assertTimestampNotBefore(value.updatedAt, existing.updatedAt, "thread.updatedAt");
      if (hasMessages(value.id)) {
        if (
          value.previewMode !== existing.previewMode ||
          !sameOwner(value.owner, existing.owner) ||
          !sameModel(value.model, existing.model)
        ) {
          throw new Error(`${STORE_LABEL}: populated thread identity and model are immutable`);
        }
      }
    }
    db.run(
      `INSERT INTO console_chat_threads
        (id, title, preview_mode, bound_peer_id, owner_peer_kind, owner_trust_level,
         owner_public_substate, model_provider, model_id, model_display, created_at, updated_at,
         last_read_at, unread, run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         preview_mode = excluded.preview_mode,
         bound_peer_id = excluded.bound_peer_id,
         owner_peer_kind = excluded.owner_peer_kind,
         owner_trust_level = excluded.owner_trust_level,
         owner_public_substate = excluded.owner_public_substate,
         model_provider = excluded.model_provider,
         model_id = excluded.model_id,
         model_display = excluded.model_display,
         updated_at = excluded.updated_at,
         last_read_at = excluded.last_read_at,
         unread = excluded.unread,
         run_status = excluded.run_status
       WHERE excluded.updated_at >= console_chat_threads.updated_at`,
      threadBindings(value),
    );
    return requiredThread(value.id);
  }

  function updateThread(
    threadId: string,
    input: UpdateConsoleChatThreadInput,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    const existingRow = getThreadStatement.get(id) as ThreadRow | null;
    if (!existingRow) return null;
    const existing = rowToThread(existingRow);
    const updatedAt = assertTimestamp(input.updatedAt, "thread.updatedAt");
    if (updatedAt < existing.createdAt)
      throw new Error(`${STORE_LABEL}: updatedAt predates thread`);
    assertTimestampNotBefore(updatedAt, existing.updatedAt, "thread.updatedAt");
    const model = input.model === undefined ? existing.model : normalizeModel(input.model);
    const owner =
      input.owner === undefined
        ? existing.owner
        : normalizeOwner(input.owner, id, existing.previewMode);
    const runStatus = input.runStatus ?? existing.runStatus;
    assertRunStatus(runStatus);
    const unread = input.unread ?? existing.unread;
    const lastReadAt =
      input.lastReadAt === undefined
        ? existing.lastReadAt
        : nullableTimestamp(input.lastReadAt, "thread.lastReadAt");
    if (
      hasMessages(id) &&
      (!sameOwner(owner, existing.owner) || !sameModel(model, existing.model))
    ) {
      throw new Error(`${STORE_LABEL}: populated thread identity and model are immutable`);
    }

    db.run(
      `UPDATE console_chat_threads SET
         bound_peer_id = ?, owner_peer_kind = ?, owner_trust_level = ?, owner_public_substate = ?,
         model_provider = ?, model_id = ?, model_display = ?,
         updated_at = ?, run_status = ?, unread = ?, last_read_at = ?
       WHERE id = ?`,
      [
        owner?.peerId ?? null,
        owner?.kind ?? null,
        owner?.trustLevel ?? null,
        owner?.publicSubstate ?? null,
        model?.provider ?? null,
        model?.id ?? null,
        model?.displayName ?? null,
        updatedAt,
        runStatus,
        unread ? 1 : 0,
        lastReadAt,
        id,
      ],
    );
    return requiredThreadSummary(id);
  }

  function insertMessage(
    threadId: string,
    sequence: number,
    input: ReturnType<typeof normalizeMessageInput>,
  ): void {
    db.run(
      `INSERT INTO console_chat_messages
        (thread_id, sequence, id, role, content, tool_calls_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        threadId,
        sequence,
        input.id,
        input.role,
        input.content,
        serializeToolCalls(input.toolCalls),
        input.error,
        input.createdAt,
        input.updatedAt,
      ],
    );
  }

  function appendMessage(
    threadId: string,
    input: AppendConsoleChatMessageInput,
  ): ConsoleChatMessage {
    const id = assertIdentifier(threadId, "threadId");
    const message = normalizeMessageInput(input);
    const transaction = db.transaction(() => {
      const threadRow = getThreadStatement.get(id) as ThreadRow | null;
      if (!threadRow) throw new Error(`${STORE_LABEL}: thread not found: ${id}`);
      const storedThread = rowToThread(threadRow);
      if (storedThread.owner === null) {
        throw new Error(`${STORE_LABEL}: populated thread requires an identified owner`);
      }
      if (message.createdAt < storedThread.createdAt) {
        throw new Error(`${STORE_LABEL}: message timestamp predates thread`);
      }
      const next = getNextSequenceStatement.get(id) as { sequence?: unknown } | null;
      if (!Number.isSafeInteger(next?.sequence) || (next?.sequence as number) < 0) {
        throw new Error(`${STORE_LABEL}: invalid message sequence`);
      }
      insertMessage(id, next!.sequence as number, message);
      db.run(`UPDATE console_chat_threads SET updated_at = MAX(updated_at, ?) WHERE id = ?`, [
        message.updatedAt,
        id,
      ]);
    });
    transaction();
    return requiredMessage(id, message.id);
  }

  function updateMessage(
    threadId: string,
    messageId: string,
    input: UpdateConsoleChatMessageInput,
  ): ConsoleChatMessage | null {
    const thread = assertIdentifier(threadId, "threadId");
    const message = assertIdentifier(messageId, "messageId");
    const existingRow = getMessageStatement.get(thread, message) as MessageRow | null;
    if (!existingRow) return null;
    const existing = rowToMessage(existingRow);
    const updatedAt = assertTimestamp(input.updatedAt, "message.updatedAt");
    if (updatedAt < existing.createdAt)
      throw new Error(`${STORE_LABEL}: updatedAt predates message`);
    assertTimestampNotBefore(updatedAt, existing.updatedAt, "message.updatedAt");
    const content =
      input.content === undefined
        ? existing.content
        : boundedString(input.content, MAX_MESSAGE_CONTENT_LENGTH, "message.content", true);
    const toolCalls =
      input.toolCalls === undefined ? existing.toolCalls : normalizeToolCalls(input.toolCalls);
    const error =
      input.error === undefined
        ? existing.error
        : nullableBoundedString(input.error, MAX_MESSAGE_CONTENT_LENGTH, "message.error", true);

    const transaction = db.transaction(() => {
      db.run(
        `UPDATE console_chat_messages
           SET content = ?, tool_calls_json = ?, error = ?, updated_at = ?
         WHERE thread_id = ? AND id = ?`,
        [content, serializeToolCalls(toolCalls), error, updatedAt, thread, message],
      );
      db.run(`UPDATE console_chat_threads SET updated_at = MAX(updated_at, ?) WHERE id = ?`, [
        updatedAt,
        thread,
      ]);
    });
    transaction();
    return requiredMessage(thread, message);
  }

  function renameThread(
    threadId: string,
    title: string,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    const normalizedTitle = boundedString(title.trim(), MAX_TITLE_LENGTH, "thread.title");
    const timestamp = assertTimestamp(updatedAt, "thread.updatedAt");
    const existingRow = getThreadStatement.get(id) as ThreadRow | null;
    if (!existingRow) return null;
    const existing = rowToThread(existingRow);
    assertTimestampNotBefore(timestamp, existing.updatedAt, "thread.updatedAt");
    const result = db.run(
      `UPDATE console_chat_threads SET title = ?, updated_at = ?
       WHERE id = ? AND created_at <= ?`,
      [normalizedTitle, timestamp, id, timestamp],
    );
    return result.changes === 0 ? null : requiredThreadSummary(id);
  }

  function setThreadReadState(
    threadId: string,
    unread: boolean,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    const timestamp = assertTimestamp(updatedAt, "thread.updatedAt");
    if (typeof unread !== "boolean") throw new Error(`${STORE_LABEL}: unread must be a boolean`);
    const result = db.run(
      `UPDATE console_chat_threads
       SET unread = ?,
           last_read_at = CASE
             WHEN ? = 0 THEN MAX(COALESCE(last_read_at, 0), ?)
             ELSE last_read_at
           END
       WHERE id = ?`,
      [unread ? 1 : 0, unread ? 1 : 0, timestamp, id],
    );
    return result.changes === 0 ? null : requiredThreadSummary(id);
  }

  function deleteThread(threadId: string): boolean {
    const id = assertIdentifier(threadId, "threadId");
    // Bun/SQLite includes rows removed by FK cascades in `changes` on some
    // versions, so this is deliberately a positive check rather than `=== 1`.
    return db.run(`DELETE FROM console_chat_threads WHERE id = ?`, [id]).changes > 0;
  }

  function loadKernelHistory(threadId: string): KernelMessage[] | null {
    const id = assertIdentifier(threadId, "threadId");
    const row = getHistoryStatement.get(id) as HistoryRow | null;
    if (!row) return null;
    if (typeof row.history_json !== "string") {
      throw new Error(`${STORE_LABEL}: invalid kernel history row`);
    }
    return parseKernelHistory(row.history_json);
  }

  function saveKernelHistory(
    threadId: string,
    messages: readonly KernelMessage[],
    updatedAt: number,
  ): void {
    const id = assertIdentifier(threadId, "threadId");
    const timestamp = assertTimestamp(updatedAt, "kernelHistory.updatedAt");
    const historyJson = serializeKernelHistory(messages);
    const existing = getHistoryStatement.get(id) as HistoryRow | null;
    if (existing) {
      assertTimestampNotBefore(
        timestamp,
        assertTimestamp(existing.updated_at, "stored kernelHistory.updatedAt"),
        "kernelHistory.updatedAt",
      );
    }
    const result = db.run(
      `INSERT INTO console_chat_kernel_history (thread_id, history_json, updated_at)
       SELECT id, ?, ? FROM console_chat_threads WHERE id = ?
       ON CONFLICT(thread_id) DO UPDATE SET
         history_json = excluded.history_json, updated_at = excluded.updated_at`,
      [historyJson, timestamp, id],
    );
    if (result.changes !== 1) throw new Error(`${STORE_LABEL}: thread not found: ${id}`);
  }

  function clearKernelHistory(threadId: string): boolean {
    const id = assertIdentifier(threadId, "threadId");
    return (
      db.run(`DELETE FROM console_chat_kernel_history WHERE thread_id = ?`, [id]).changes === 1
    );
  }

  function claimOrAssertKernelHistoryOwner(
    threadId: string,
    peer: PeerIdentity,
  ): { id: string; owner: ConsoleChatOwnerIdentity } {
    const id = assertIdentifier(threadId, "threadId");
    const previewMode = previewModeForPeer(peer, id);
    const owner = normalizeOwner(consoleChatOwnerFromPeer(peer), id, previewMode);
    if (owner === null) throw new Error(`${STORE_LABEL}: kernel history access denied`);

    // A conditional UPDATE is the claim operation. It takes SQLite's write
    // lock before the verification SELECT, so two processes cannot both claim
    // the same unbound row with different identities. The deployment contract
    // still requires one application replica because in-memory kernel state is
    // process-local.
    db.run(
      `UPDATE console_chat_threads
          SET bound_peer_id = ?, owner_peer_kind = ?, owner_trust_level = ?,
              owner_public_substate = ?
        WHERE id = ? AND preview_mode = ?
          AND bound_peer_id IS NULL AND owner_peer_kind IS NULL
          AND owner_trust_level IS NULL AND owner_public_substate IS NULL`,
      [owner.peerId, owner.kind, owner.trustLevel, owner.publicSubstate, id, previewMode],
    );

    const row = getThreadStatement.get(id) as ThreadRow | null;
    if (!row) throw new Error(`${STORE_LABEL}: kernel history access denied`);
    const thread = rowToThread(row);
    if (
      thread.previewMode !== previewMode ||
      thread.owner === null ||
      !sameOwner(thread.owner, owner)
    ) {
      throw new Error(`${STORE_LABEL}: kernel history access denied`);
    }
    return { id, owner };
  }

  function assertKernelHistoryAccess(threadId: string, peer: PeerIdentity): void {
    db.transaction(() => {
      claimOrAssertKernelHistoryOwner(threadId, peer);
    })();
  }

  function loadKernelHistoryForPeer(threadId: string, peer: PeerIdentity): KernelMessage[] | null {
    return db.transaction(() => {
      const { id } = claimOrAssertKernelHistoryOwner(threadId, peer);
      const row = getHistoryStatement.get(id) as HistoryRow | null;
      if (!row) return null;
      if (typeof row.history_json !== "string") {
        throw new Error(`${STORE_LABEL}: invalid kernel history row`);
      }
      return parseKernelHistory(row.history_json);
    })();
  }

  function commitKernelHistoryForPeer(
    threadId: string,
    peer: PeerIdentity,
    messages: readonly KernelMessage[],
  ): void {
    // Validate and bound the entire snapshot before opening the transaction.
    // saveKernelHistory repeats serialization inside the transaction so no
    // unchecked value can reach SQLite if this implementation changes later.
    serializeKernelHistory(messages);
    db.transaction(() => {
      const { id } = claimOrAssertKernelHistoryOwner(threadId, peer);
      saveKernelHistory(id, messages, assertTimestamp(now(), "now()"));
    })();
  }

  function requiredThread(threadId: string): ConsoleChatThread {
    const thread = getThread(threadId);
    if (!thread) throw new Error(`${STORE_LABEL}: thread disappeared: ${threadId}`);
    return thread;
  }

  function requiredThreadSummary(threadId: string): ConsoleChatThreadSummary {
    const row = getThreadStatement.get(threadId) as ThreadRow | null;
    if (!row) throw new Error(`${STORE_LABEL}: thread disappeared: ${threadId}`);
    return rowToThread(row);
  }

  function requiredMessage(threadId: string, messageId: string): ConsoleChatMessage {
    const row = getMessageStatement.get(threadId, messageId) as MessageRow | null;
    if (!row) throw new Error(`${STORE_LABEL}: message disappeared: ${messageId}`);
    return rowToMessage(row);
  }

  function hasMessages(threadId: string): boolean {
    const row = countMessagesStatement.get(threadId) as { count?: unknown } | null;
    if (!Number.isSafeInteger(row?.count) || (row!.count as number) < 0) {
      throw new Error(`${STORE_LABEL}: invalid message count`);
    }
    return (row!.count as number) > 0;
  }

  return {
    listThreads,
    getThread,
    createThread,
    createThreadWithMessages,
    upsertThread,
    updateThread,
    appendMessage,
    updateMessage,
    renameThread,
    setThreadReadState,
    deleteThread,
    loadKernelHistory,
    saveKernelHistory,
    clearKernelHistory,
    assertKernelHistoryAccess,
    loadKernelHistoryForPeer,
    commitKernelHistoryForPeer,
    diagnostics: database.diagnostics,
    close: database.close,
  };
}

function normalizeThreadInput(input: CreateConsoleChatThreadInput) {
  const id = assertIdentifier(input.id, "thread.id");
  const createdAt = assertTimestamp(input.createdAt, "thread.createdAt");
  const updatedAt = assertTimestamp(input.updatedAt ?? createdAt, "thread.updatedAt");
  if (updatedAt < createdAt) throw new Error(`${STORE_LABEL}: updatedAt predates thread`);
  assertPreviewMode(input.previewMode);
  const runStatus = input.runStatus ?? "idle";
  assertRunStatus(runStatus);
  const unread = input.unread ?? false;
  if (typeof unread !== "boolean") throw new Error(`${STORE_LABEL}: unread must be a boolean`);
  return {
    id,
    title: boundedString(input.title.trim(), MAX_TITLE_LENGTH, "thread.title"),
    previewMode: input.previewMode,
    owner: normalizeOwner(input.owner ?? null, id, input.previewMode),
    model: normalizeModel(input.model ?? null),
    createdAt,
    updatedAt,
    lastReadAt: nullableTimestamp(input.lastReadAt ?? null, "thread.lastReadAt"),
    unread,
    runStatus,
  };
}

function threadBindings(input: ReturnType<typeof normalizeThreadInput>) {
  return [
    input.id,
    input.title,
    input.previewMode,
    input.owner?.peerId ?? null,
    input.owner?.kind ?? null,
    input.owner?.trustLevel ?? null,
    input.owner?.publicSubstate ?? null,
    input.model?.provider ?? null,
    input.model?.id ?? null,
    input.model?.displayName ?? null,
    input.createdAt,
    input.updatedAt,
    input.lastReadAt,
    input.unread ? 1 : 0,
    input.runStatus,
  ];
}

function normalizeMessageInput(input: AppendConsoleChatMessageInput) {
  const createdAt = assertTimestamp(input.createdAt, "message.createdAt");
  const updatedAt = assertTimestamp(input.updatedAt ?? createdAt, "message.updatedAt");
  if (updatedAt < createdAt) throw new Error(`${STORE_LABEL}: updatedAt predates message`);
  assertMessageRole(input.role);
  return {
    id: assertIdentifier(input.id, "message.id"),
    role: input.role,
    content: boundedString(input.content, MAX_MESSAGE_CONTENT_LENGTH, "message.content", true),
    toolCalls: normalizeToolCalls(input.toolCalls ?? null),
    error: nullableBoundedString(
      input.error ?? null,
      MAX_MESSAGE_CONTENT_LENGTH,
      "message.error",
      true,
    ),
    createdAt,
    updatedAt,
  };
}

function rowToThread(row: ThreadRow): ConsoleChatThreadSummary {
  const id = assertIdentifier(row.id, "stored thread.id");
  const title = boundedString(row.title, MAX_TITLE_LENGTH, "stored thread.title");
  assertPreviewMode(row.preview_mode);
  assertRunStatus(row.run_status);
  const createdAt = assertTimestamp(row.created_at, "stored thread.createdAt");
  const updatedAt = assertTimestamp(row.updated_at, "stored thread.updatedAt");
  if (updatedAt < createdAt)
    throw new Error(`${STORE_LABEL}: stored thread timestamps are invalid`);
  if (row.unread !== 0 && row.unread !== 1) throw new Error(`${STORE_LABEL}: invalid unread value`);

  const modelId = nullableBoundedString(row.model_id, MAX_MODEL_FIELD_LENGTH, "stored model.id");
  const modelDisplay = nullableBoundedString(
    row.model_display,
    MAX_MODEL_FIELD_LENGTH,
    "stored model.displayName",
  );
  const modelProvider = nullableBoundedString(
    row.model_provider,
    MAX_MODEL_FIELD_LENGTH,
    "stored model.provider",
  );
  if ((modelId === null) !== (modelDisplay === null)) {
    throw new Error(`${STORE_LABEL}: incomplete stored model snapshot`);
  }
  return {
    id,
    title,
    previewMode: row.preview_mode,
    owner: rowToOwner(row, id, row.preview_mode),
    model:
      modelId === null
        ? null
        : { id: modelId, displayName: modelDisplay!, provider: modelProvider },
    createdAt,
    updatedAt,
    lastReadAt: nullableTimestamp(row.last_read_at, "stored thread.lastReadAt"),
    unread: row.unread === 1,
    runStatus: row.run_status,
  };
}

function rowToMessage(row: MessageRow): ConsoleChatMessage {
  const createdAt = assertTimestamp(row.created_at, "stored message.createdAt");
  const updatedAt = assertTimestamp(row.updated_at, "stored message.updatedAt");
  if (updatedAt < createdAt)
    throw new Error(`${STORE_LABEL}: stored message timestamps are invalid`);
  assertMessageRole(row.role);
  if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0) {
    throw new Error(`${STORE_LABEL}: invalid stored message sequence`);
  }
  return {
    id: assertIdentifier(row.id, "stored message.id"),
    sequence: row.sequence as number,
    role: row.role,
    content: boundedString(row.content, MAX_MESSAGE_CONTENT_LENGTH, "stored message.content", true),
    toolCalls:
      row.tool_calls_json === null
        ? null
        : parseToolCalls(
            boundedString(
              row.tool_calls_json,
              MAX_TOOL_JSON_LENGTH,
              "stored message.toolCalls",
              true,
            ),
          ),
    error: nullableBoundedString(
      row.error,
      MAX_MESSAGE_CONTENT_LENGTH,
      "stored message.error",
      true,
    ),
    createdAt,
    updatedAt,
  };
}

function normalizeOwner(
  owner: ConsoleChatOwnerIdentity | null,
  threadId: string,
  previewMode: ConsoleChatPreviewMode,
): ConsoleChatOwnerIdentity | null {
  if (owner === null) return null;
  if (!isPlainObject(owner)) throw new Error(`${STORE_LABEL}: invalid thread owner`);
  const peerId = boundedString(owner.peerId, MAX_PEER_ID_LENGTH, "thread.owner.peerId");
  assertPeerKind(owner.kind);
  assertTrustLevel(owner.trustLevel);
  const publicSubstate = owner.publicSubstate;
  if (
    publicSubstate !== null &&
    publicSubstate !== "anonymous" &&
    publicSubstate !== "recognized"
  ) {
    throw new Error(`${STORE_LABEL}: invalid thread owner public substate`);
  }
  if (
    (owner.trustLevel === "public" && publicSubstate === null) ||
    (owner.trustLevel !== "public" && publicSubstate !== null)
  ) {
    throw new Error(`${STORE_LABEL}: thread owner trust and public substate disagree`);
  }

  const normalized = { peerId, kind: owner.kind, trustLevel: owner.trustLevel, publicSubstate };
  assertOwnerMatchesPreviewMode(normalized, threadId, previewMode);
  return normalized;
}

function rowToOwner(
  row: ThreadRow,
  threadId: string,
  previewMode: ConsoleChatPreviewMode,
): ConsoleChatOwnerIdentity | null {
  if (
    row.bound_peer_id === null &&
    row.owner_peer_kind === null &&
    row.owner_trust_level === null &&
    row.owner_public_substate === null
  ) {
    return null;
  }
  return normalizeOwner(
    {
      peerId: boundedString(row.bound_peer_id, MAX_PEER_ID_LENGTH, "stored owner.peerId"),
      kind: row.owner_peer_kind as PeerKind,
      trustLevel: row.owner_trust_level as TrustLevel,
      publicSubstate: row.owner_public_substate as "anonymous" | "recognized" | null,
    },
    threadId,
    previewMode,
  );
}

function assertOwnerMatchesPreviewMode(
  owner: ConsoleChatOwnerIdentity,
  threadId: string,
  previewMode: ConsoleChatPreviewMode,
): void {
  const expected =
    previewMode === "creator"
      ? owner.peerId === "creator" &&
        owner.kind === "human" &&
        owner.trustLevel === "creator" &&
        owner.publicSubstate === null
      : previewMode === "anonymous"
        ? owner.peerId === `anon-${threadId}` &&
          owner.kind === "human" &&
          owner.trustLevel === "public" &&
          owner.publicSubstate === "anonymous"
        : owner.kind === "human" &&
          owner.trustLevel === "public" &&
          owner.publicSubstate === "recognized";
  if (!expected) {
    throw new Error(`${STORE_LABEL}: thread owner does not match preview mode`);
  }
}

function previewModeForPeer(peer: PeerIdentity, threadId: string): ConsoleChatPreviewMode {
  const owner = consoleChatOwnerFromPeer(peer);
  if (
    owner.peerId === "creator" &&
    owner.kind === "human" &&
    owner.trustLevel === "creator" &&
    owner.publicSubstate === null
  ) {
    return "creator";
  }
  if (
    owner.peerId === `anon-${threadId}` &&
    owner.kind === "human" &&
    owner.trustLevel === "public" &&
    owner.publicSubstate === "anonymous"
  ) {
    return "anonymous";
  }
  if (
    owner.kind === "human" &&
    owner.trustLevel === "public" &&
    owner.publicSubstate === "recognized"
  ) {
    return "visitor";
  }
  throw new Error(`${STORE_LABEL}: kernel history access denied`);
}

function normalizeModel(model: ConsoleChatModelSnapshot | null): ConsoleChatModelSnapshot | null {
  if (model === null) return null;
  if (!isPlainObject(model)) throw new Error(`${STORE_LABEL}: invalid model snapshot`);
  return {
    id: boundedString(model.id, MAX_MODEL_FIELD_LENGTH, "model.id"),
    displayName: boundedString(model.displayName, MAX_MODEL_FIELD_LENGTH, "model.displayName"),
    provider: nullableBoundedString(model.provider, MAX_MODEL_FIELD_LENGTH, "model.provider"),
  };
}

function normalizeToolCalls(value: ConsoleChatToolCall[] | null): ConsoleChatToolCall[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${STORE_LABEL}: toolCalls must be an array or null`);
  return value.map((call, index) => {
    if (!isPlainObject(call)) throw new Error(`${STORE_LABEL}: invalid tool call at ${index}`);
    if (call.status !== "running" && call.status !== "completed" && call.status !== "error") {
      throw new Error(`${STORE_LABEL}: invalid tool call status at ${index}`);
    }
    return {
      id: assertIdentifier(call.id, `toolCalls[${index}].id`),
      name: boundedString(call.name, MAX_MODEL_FIELD_LENGTH, `toolCalls[${index}].name`),
      ...(call.args === undefined
        ? {}
        : {
            args: boundedString(
              call.args,
              MAX_MESSAGE_CONTENT_LENGTH,
              `toolCalls[${index}].args`,
              true,
            ),
          }),
      ...(call.result === undefined
        ? {}
        : {
            result: boundedString(
              call.result,
              MAX_MESSAGE_CONTENT_LENGTH,
              `toolCalls[${index}].result`,
              true,
            ),
          }),
      status: call.status,
    };
  });
}

function serializeToolCalls(toolCalls: ConsoleChatToolCall[] | null): string | null {
  if (toolCalls === null) return null;
  const json = JSON.stringify(normalizeToolCalls(toolCalls));
  if (json.length > MAX_TOOL_JSON_LENGTH)
    throw new Error(`${STORE_LABEL}: toolCalls are too large`);
  return json;
}

function parseToolCalls(json: string): ConsoleChatToolCall[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`${STORE_LABEL}: invalid stored tool call JSON`, { cause: error });
  }
  return normalizeToolCalls(value as ConsoleChatToolCall[]) ?? [];
}

function serializeKernelHistory(messages: readonly KernelMessage[]): string {
  const normalized = messages.map(normalizeKernelMessage);
  const json = JSON.stringify(normalized);
  if (json.length > MAX_KERNEL_HISTORY_JSON_LENGTH) {
    throw new Error(`${STORE_LABEL}: kernel history is too large`);
  }
  return json;
}

function parseKernelHistory(json: string): KernelMessage[] {
  if (json.length > MAX_KERNEL_HISTORY_JSON_LENGTH) {
    throw new Error(`${STORE_LABEL}: stored kernel history is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`${STORE_LABEL}: invalid stored kernel history JSON`, { cause: error });
  }
  if (!Array.isArray(value)) throw new Error(`${STORE_LABEL}: kernel history must be an array`);
  return value.map(normalizeKernelMessage);
}

function normalizeKernelMessage(message: KernelMessage): KernelMessage {
  if (!isPlainObject(message)) throw new Error(`${STORE_LABEL}: invalid kernel history message`);
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool_use" &&
    message.role !== "tool_result"
  ) {
    throw new Error(`${STORE_LABEL}: invalid kernel history role`);
  }
  const tokenCount = message.tokenCount;
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new Error(`${STORE_LABEL}: invalid kernel history token count`);
  }
  const normalized: KernelMessage = {
    id: assertIdentifier(message.id, "kernelHistory.message.id"),
    role: message.role,
    content: boundedString(
      message.content,
      MAX_MESSAGE_CONTENT_LENGTH,
      "kernelHistory.message.content",
      true,
    ),
    timestamp: assertTimestamp(message.timestamp, "kernelHistory.message.timestamp"),
    tokenCount,
  };
  if (message.peerId !== undefined) {
    normalized.peerId = boundedString(
      message.peerId,
      MAX_PEER_ID_LENGTH,
      "kernelHistory.message.peerId",
    );
  }
  if (message.toolCallId !== undefined) {
    normalized.toolCallId = assertIdentifier(
      message.toolCallId,
      "kernelHistory.message.toolCallId",
    );
  }
  return normalized;
}

function assertIdentifier(value: unknown, field: string): string {
  return boundedString(value, MAX_ID_LENGTH, field);
}

function boundedString(
  value: unknown,
  maxLength: number,
  field: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${STORE_LABEL}: ${field} must be a string`);
  if ((!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`${STORE_LABEL}: ${field} has an invalid length`);
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  maxLength: number,
  field: string,
  allowEmpty = false,
): string | null {
  if (value === null) return null;
  return boundedString(value, maxLength, field, allowEmpty);
}

function assertTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${STORE_LABEL}: ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableTimestamp(value: unknown, field: string): number | null {
  return value === null ? null : assertTimestamp(value, field);
}

function assertPreviewMode(value: unknown): asserts value is ConsoleChatPreviewMode {
  if (value !== "creator" && value !== "anonymous" && value !== "visitor") {
    throw new Error(`${STORE_LABEL}: invalid preview mode`);
  }
}

function assertRunStatus(value: unknown): asserts value is ConsoleChatRunStatus {
  if (
    value !== "idle" &&
    value !== "streaming" &&
    value !== "complete" &&
    value !== "error" &&
    value !== "interrupted"
  ) {
    throw new Error(`${STORE_LABEL}: invalid run status`);
  }
}

function assertMessageRole(value: unknown): asserts value is ConsoleChatMessageRole {
  if (value !== "user" && value !== "assistant") {
    throw new Error(`${STORE_LABEL}: invalid message role`);
  }
}

function assertPeerKind(value: unknown): asserts value is PeerKind {
  if (value !== "human" && value !== "agent" && value !== "system" && value !== "anonymous") {
    throw new Error(`${STORE_LABEL}: invalid thread owner kind`);
  }
}

function assertTrustLevel(value: unknown): asserts value is TrustLevel {
  if (value !== "creator" && value !== "agent" && value !== "public") {
    throw new Error(`${STORE_LABEL}: invalid thread owner trust level`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameModel(
  left: ConsoleChatModelSnapshot | null,
  right: ConsoleChatModelSnapshot | null,
): boolean {
  return (
    left?.id === right?.id &&
    left?.displayName === right?.displayName &&
    left?.provider === right?.provider
  );
}

function sameOwner(
  left: ConsoleChatOwnerIdentity | null,
  right: ConsoleChatOwnerIdentity | null,
): boolean {
  return (
    left?.peerId === right?.peerId &&
    left?.kind === right?.kind &&
    left?.trustLevel === right?.trustLevel &&
    left?.publicSubstate === right?.publicSubstate
  );
}

function assertTimestampNotBefore(value: number, minimum: number, field: string): void {
  if (value < minimum) throw new Error(`${STORE_LABEL}: ${field} cannot move backwards`);
}

// Kept module-local so schema mutation tests can inspect through SQLite without
// exposing a raw handle from the production store.
export function validateConsoleChatSchemaForTest(db: Database): void {
  const objects = db
    .query<SqliteSchemaObject, []>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
  assertExactSchema(objects);
}

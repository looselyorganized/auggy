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
export const CONSOLE_CHAT_SCHEMA_VERSION = 4;

export const CONSOLE_CHAT_RESTART_INTERRUPTION =
  "Response interrupted because the console server restarted.";

const STORE_LABEL = "console chat store";
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 80;
const MAX_MODEL_FIELD_LENGTH = 512;
const MAX_PEER_ID_LENGTH = 1_024;
const MAX_RUN_ERROR_LENGTH = 4_096;
const MAX_MESSAGE_CONTENT_LENGTH = 16 * 1024 * 1024;
const MAX_TOOL_JSON_LENGTH = 16 * 1024 * 1024;
const MAX_KERNEL_HISTORY_JSON_LENGTH = 64 * 1024 * 1024;

export class ConsoleChatThreadDeletedError extends Error {
  readonly code = "thread-deleted";
  readonly threadId: string;

  constructor(threadId: string) {
    super(`${STORE_LABEL}: thread was deleted: ${threadId}`);
    this.name = "ConsoleChatThreadDeletedError";
    this.threadId = threadId;
  }
}

export function isConsoleChatThreadDeletedError(
  error: unknown,
): error is ConsoleChatThreadDeletedError {
  return error instanceof ConsoleChatThreadDeletedError;
}

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
  orgId?: string;
}

export function consoleChatOwnerFromPeer(peer: PeerIdentity): ConsoleChatOwnerIdentity {
  return {
    peerId: peer.id,
    kind: peer.kind,
    trustLevel: peer.trustLevel,
    publicSubstate: peer.publicSubstate ?? null,
    ...(peer.orgId !== undefined ? { orgId: peer.orgId } : {}),
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

export interface BeginConsoleChatRunInput {
  thread: CreateConsoleChatThreadInput;
  peer: PeerIdentity;
  runId: string;
  userMessage: AppendConsoleChatMessageInput;
  assistantMessage: AppendConsoleChatMessageInput;
}

export interface FinishConsoleChatRunInput {
  status: "complete" | "error" | "interrupted";
  content?: string;
  toolCalls?: ConsoleChatToolCall[] | null;
  error?: string | null;
  unread: boolean;
  updatedAt: number;
}

export interface AbandonConsoleChatRunInput {
  status: "error" | "interrupted";
  error: string;
  unread: boolean;
  updatedAt: number;
}

export interface ConsoleChatStore {
  hasThread(threadId: string): boolean;
  isThreadDeleted(threadId: string): boolean;
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
  /** One-way, caller-authorized transition that preserves the existing transcript. */
  promoteAnonymousThread(
    threadId: string,
    peer: PeerIdentity,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null;
  appendMessage(threadId: string, input: AppendConsoleChatMessageInput): ConsoleChatMessage;
  updateMessage(
    threadId: string,
    messageId: string,
    input: UpdateConsoleChatMessageInput,
  ): ConsoleChatMessage | null;
  beginRun(input: BeginConsoleChatRunInput): ConsoleChatThread;
  updateRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: UpdateConsoleChatMessageInput,
  ): ConsoleChatMessage | null;
  finishRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: FinishConsoleChatRunInput,
  ): ConsoleChatThread | null;
  finishRunWithKernelHistory(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    peer: PeerIdentity,
    snapshot: ThreadHistorySnapshot,
    input: FinishConsoleChatRunInput,
  ): ConsoleChatThread | null;
  abandonRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: AbandonConsoleChatRunInput,
  ): ConsoleChatThread | null;
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

export interface DeferredConsoleThreadHistoryPersistence extends ThreadHistoryPersistence {
  pendingSnapshot(threadId: string, peer: PeerIdentity): ThreadHistorySnapshot | null;
  discardPending(threadId: string): void;
  discardAllPending(): void;
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

/**
 * Console runs cannot publish kernel history before their visible transcript
 * reaches the same durable terminal state. This adapter keeps the kernel's
 * validated replacement snapshot in process memory; webTransport commits it
 * together with finishRun in one SQLite transaction.
 */
export function createDeferredConsoleThreadHistoryPersistence(
  store: ConsoleChatStore,
): DeferredConsoleThreadHistoryPersistence {
  const pending = new Map<
    string,
    { owner: ConsoleChatOwnerIdentity; snapshot: ThreadHistorySnapshot }
  >();

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
      store.assertKernelHistoryAccess(threadId, peer);
      const normalized = parseKernelHistory(serializeKernelHistory(snapshot.messages));
      const thread = store.getThread(threadId);
      if (!thread) throw new Error(`${STORE_LABEL}: thread not found: ${threadId}`);
      if (thread.runStatus !== "streaming") {
        store.commitKernelHistoryForPeer(threadId, peer, normalized);
        pending.delete(threadId);
        return;
      }
      pending.set(threadId, {
        owner: consoleChatOwnerFromPeer(peer),
        snapshot: { version: 1, messages: normalized },
      });
    },
    pendingSnapshot(threadId, peer) {
      const id = assertIdentifier(threadId, "threadId");
      const value = pending.get(id);
      if (!value) return null;
      if (!sameOwner(value.owner, consoleChatOwnerFromPeer(peer))) {
        throw new Error(`${STORE_LABEL}: kernel history access denied`);
      }
      return {
        version: 1,
        messages: value.snapshot.messages.map((message) => ({ ...message })),
      };
    },
    discardPending(threadId) {
      pending.delete(assertIdentifier(threadId, "threadId"));
    },
    discardAllPending() {
      pending.clear();
    },
  };
}

const VERSION_2_SCHEMA_STATEMENTS = [
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
    active_run_id     TEXT CHECK(active_run_id IS NULL OR length(active_run_id) BETWEEN 1 AND 256),
    active_assistant_message_id TEXT CHECK(active_assistant_message_id IS NULL OR length(active_assistant_message_id) BETWEEN 1 AND 256),
    CHECK((bound_peer_id IS NULL AND owner_peer_kind IS NULL AND owner_trust_level IS NULL AND owner_public_substate IS NULL) OR
          (bound_peer_id IS NOT NULL AND owner_peer_kind IS NOT NULL AND owner_trust_level IS NOT NULL AND
           ((owner_trust_level = 'public' AND owner_public_substate IS NOT NULL) OR
            (owner_trust_level != 'public' AND owner_public_substate IS NULL)))),
    CHECK((model_id IS NULL AND model_display IS NULL AND model_provider IS NULL) OR
          (model_id IS NOT NULL AND model_display IS NOT NULL)),
    CHECK((run_status = 'streaming' AND active_run_id IS NOT NULL AND active_assistant_message_id IS NOT NULL) OR
          (run_status != 'streaming' AND active_run_id IS NULL AND active_assistant_message_id IS NULL))
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

const TOMBSTONE_SCHEMA_STATEMENT = `CREATE TABLE IF NOT EXISTS console_chat_tombstones (
  thread_id         TEXT PRIMARY KEY CHECK(length(thread_id) BETWEEN 1 AND 256),
  deleted_at        INTEGER NOT NULL CHECK(deleted_at >= 0)
)`;

const TOMBSTONE_GUARD_TRIGGER_STATEMENT = `CREATE TRIGGER IF NOT EXISTS trg_console_chat_threads_reject_tombstone
  BEFORE INSERT ON console_chat_threads
  FOR EACH ROW
  WHEN EXISTS (
    SELECT 1 FROM console_chat_tombstones WHERE thread_id = NEW.id
  )
  BEGIN
    SELECT RAISE(ABORT, 'console chat thread id is tombstoned');
  END`;

const VERSION_3_SCHEMA_STATEMENTS = [
  ...VERSION_2_SCHEMA_STATEMENTS,
  TOMBSTONE_SCHEMA_STATEMENT,
  TOMBSTONE_GUARD_TRIGGER_STATEMENT,
] as const;

const OWNER_ORG_COLUMN_DEFINITION =
  "owner_org_id TEXT CHECK(owner_org_id IS NULL OR length(owner_org_id) BETWEEN 1 AND 256)";

const CURRENT_THREAD_SCHEMA_STATEMENT = VERSION_2_SCHEMA_STATEMENTS[0].replace(
  "    CHECK((bound_peer_id IS NULL",
  `    ${OWNER_ORG_COLUMN_DEFINITION},
    CHECK((bound_peer_id IS NULL`,
);

const SCHEMA_STATEMENTS = [
  CURRENT_THREAD_SCHEMA_STATEMENT,
  ...VERSION_2_SCHEMA_STATEMENTS.slice(1),
  TOMBSTONE_SCHEMA_STATEMENT,
  TOMBSTONE_GUARD_TRIGGER_STATEMENT,
] as const;

function expectedSchema(statements: readonly string[]): Map<string, string> {
  return new Map(
    statements.map((sql) => {
      const match = sql.match(/(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
      if (!match?.[1]) throw new Error(`${STORE_LABEL}: invalid schema declaration`);
      return [match[1], canonicalSqliteSchemaSql(sql)] as const;
    }),
  );
}

const VERSION_2_EXPECTED_SCHEMA = expectedSchema(VERSION_2_SCHEMA_STATEMENTS);
const VERSION_3_EXPECTED_SCHEMA = expectedSchema(VERSION_3_SCHEMA_STATEMENTS);
const EXPECTED_SCHEMA = expectedSchema(SCHEMA_STATEMENTS);

function hasExactSchema(
  objects: readonly SqliteSchemaObject[],
  expected = EXPECTED_SCHEMA,
): boolean {
  return (
    objects.length === expected.size &&
    objects.every((object) => expected.get(object.name) === canonicalSqliteSchemaSql(object.sql))
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
  owner_org_id: unknown;
  model_provider: unknown;
  model_id: unknown;
  model_display: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_read_at: unknown;
  unread: unknown;
  run_status: unknown;
  active_run_id: unknown;
  active_assistant_message_id: unknown;
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
        migrateOwned(db, fromVersion, objects) {
          if (fromVersion === 2 && hasExactSchema(objects, VERSION_2_EXPECTED_SCHEMA)) {
            db.run(TOMBSTONE_SCHEMA_STATEMENT);
            db.run(TOMBSTONE_GUARD_TRIGGER_STATEMENT);
          } else if (fromVersion !== 3 || !hasExactSchema(objects, VERSION_3_EXPECTED_SCHEMA)) {
            throw new Error(`${STORE_LABEL}: only exact version 2 or 3 schemas can be migrated`);
          }
          db.run(`ALTER TABLE console_chat_threads ADD COLUMN ${OWNER_ORG_COLUMN_DEFINITION}`);
        },
        validate(_db, objects) {
          assertExactSchema(objects);
        },
      });
    },
  });
  const db = database.db;

  // A process exit cannot leave an attached stream. Preserve and annotate its
  // partial transcript, then make the terminal state truthful before serving
  // any reads. Both updates commit together so no reader can observe a
  // terminal thread without its interrupted assistant placeholder.
  const openedAt = assertTimestamp(now(), "now()");
  db.transaction(() => {
    db.run(
      `UPDATE console_chat_messages
          SET error = COALESCE(error, ?), updated_at = MAX(updated_at, ?)
        WHERE role = 'assistant' AND EXISTS (
          SELECT 1 FROM console_chat_threads AS thread
           WHERE thread.id = console_chat_messages.thread_id
             AND thread.run_status = 'streaming'
             AND thread.active_assistant_message_id = console_chat_messages.id
        )`,
      [CONSOLE_CHAT_RESTART_INTERRUPTION, openedAt],
    );
    db.run(
      `UPDATE console_chat_threads
          SET run_status = 'interrupted', updated_at = MAX(updated_at, ?),
              active_run_id = NULL, active_assistant_message_id = NULL
        WHERE run_status = 'streaming'`,
      [openedAt],
    );
  })();

  const listThreadsStatement = db.prepare(
    `SELECT * FROM console_chat_threads ORDER BY updated_at DESC, id ASC`,
  );
  const hasThreadStatement = db.prepare(`SELECT 1 AS found FROM console_chat_threads WHERE id = ?`);
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
  const getTombstoneStatement = db.prepare(
    `SELECT deleted_at FROM console_chat_tombstones WHERE thread_id = ?`,
  );

  function assertThreadNotDeleted(threadId: string): void {
    if (getTombstoneStatement.get(threadId) !== null) {
      throw new ConsoleChatThreadDeletedError(threadId);
    }
  }

  function hasThread(threadId: string): boolean {
    const id = assertIdentifier(threadId, "threadId");
    return hasThreadStatement.get(id) !== null;
  }

  function isThreadDeleted(threadId: string): boolean {
    const id = assertIdentifier(threadId, "threadId");
    return getTombstoneStatement.get(id) !== null;
  }

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
    assertThreadNotDeleted(value.id);
    db.run(
      `INSERT INTO console_chat_threads
        (id, title, preview_mode, bound_peer_id, owner_peer_kind, owner_trust_level,
         owner_public_substate, owner_org_id, model_provider, model_id, model_display, created_at,
         updated_at, last_read_at, unread, run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      threadBindings(value),
    );
  }

  function createThread(input: CreateConsoleChatThreadInput): ConsoleChatThread {
    db.transaction(() => insertThread(input))();
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
    return db.transaction(() => {
      assertThreadNotDeleted(value.id);
      const existingRow = getThreadStatement.get(value.id) as ThreadRow | null;
      if (existingRow) {
        const existing = rowToThread(existingRow);
        if (existing.runStatus === "streaming") {
          throw new Error(
            `${STORE_LABEL}: streaming thread must be changed through its active run`,
          );
        }
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
         owner_public_substate, owner_org_id, model_provider, model_id, model_display, created_at,
         updated_at, last_read_at, unread, run_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         preview_mode = excluded.preview_mode,
         bound_peer_id = excluded.bound_peer_id,
         owner_peer_kind = excluded.owner_peer_kind,
         owner_trust_level = excluded.owner_trust_level,
         owner_public_substate = excluded.owner_public_substate,
         owner_org_id = excluded.owner_org_id,
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
    })();
  }

  function updateThread(
    threadId: string,
    input: UpdateConsoleChatThreadInput,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    const existingRow = getThreadStatement.get(id) as ThreadRow | null;
    if (!existingRow) return null;
    const existing = rowToThread(existingRow);
    if (existing.runStatus === "streaming") {
      throw new Error(`${STORE_LABEL}: streaming thread must be changed through its active run`);
    }
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
    if (runStatus === "streaming") {
      throw new Error(`${STORE_LABEL}: streaming state must be started with beginRun`);
    }
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
         owner_org_id = ?, model_provider = ?, model_id = ?, model_display = ?,
         updated_at = ?, run_status = ?, unread = ?, last_read_at = ?
       WHERE id = ?`,
      [
        owner?.peerId ?? null,
        owner?.kind ?? null,
        owner?.trustLevel ?? null,
        owner?.publicSubstate ?? null,
        owner?.orgId ?? null,
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

  function promoteAnonymousThread(
    threadId: string,
    peer: PeerIdentity,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    if (previewModeForPeer(peer, id) !== "visitor") {
      throw new Error(`${STORE_LABEL}: thread promotion requires recognized visitor identity`);
    }
    const owner = normalizeOwner(consoleChatOwnerFromPeer(peer), id, "visitor");
    if (owner === null) throw new Error(`${STORE_LABEL}: kernel history access denied`);
    const at = assertTimestamp(updatedAt, "thread.updatedAt");

    return db.transaction(() => {
      const row = getThreadStatement.get(id) as ThreadRow | null;
      if (!row) return null;
      const existing = rowToThread(row);
      if (existing.runStatus === "streaming") {
        throw new Error(`${STORE_LABEL}: streaming thread cannot be promoted`);
      }
      if (
        existing.previewMode !== "anonymous" ||
        existing.owner?.peerId !== `anon-${id}` ||
        existing.owner.kind !== "human" ||
        existing.owner.trustLevel !== "public" ||
        existing.owner.publicSubstate !== "anonymous"
      ) {
        throw new Error(`${STORE_LABEL}: only its bound anonymous thread can be promoted`);
      }

      const result = db.run(
        `UPDATE console_chat_threads
            SET preview_mode = 'visitor', bound_peer_id = ?, owner_peer_kind = ?,
                owner_trust_level = ?, owner_public_substate = ?, owner_org_id = ?,
                updated_at = MAX(updated_at, ?)
          WHERE id = ? AND preview_mode = 'anonymous'
            AND bound_peer_id = ? AND owner_peer_kind = 'human'
            AND owner_trust_level = 'public' AND owner_public_substate = 'anonymous'`,
        [
          owner.peerId,
          owner.kind,
          owner.trustLevel,
          owner.publicSubstate,
          owner.orgId ?? null,
          at,
          id,
          `anon-${id}`,
        ],
      );
      if (result.changes !== 1) {
        throw new Error(`${STORE_LABEL}: anonymous thread promotion lost its ownership claim`);
      }
      return requiredThreadSummary(id);
    })();
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
      if (storedThread.runStatus === "streaming") {
        throw new Error(`${STORE_LABEL}: streaming thread must be changed through its active run`);
      }
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
    const threadRow = getThreadStatement.get(thread) as ThreadRow | null;
    if (threadRow && rowToThread(threadRow).runStatus === "streaming") {
      throw new Error(`${STORE_LABEL}: streaming thread must be changed through its active run`);
    }
    const existingRow = getMessageStatement.get(thread, message) as MessageRow | null;
    if (!existingRow) return null;
    const existing = rowToMessage(existingRow);
    const update = normalizeMessageUpdate(existing, input);

    const transaction = db.transaction(() => {
      db.run(
        `UPDATE console_chat_messages
           SET content = ?, tool_calls_json = ?, error = ?, updated_at = ?
         WHERE thread_id = ? AND id = ?`,
        [
          update.content,
          serializeToolCalls(update.toolCalls),
          update.error,
          update.updatedAt,
          thread,
          message,
        ],
      );
      db.run(`UPDATE console_chat_threads SET updated_at = MAX(updated_at, ?) WHERE id = ?`, [
        update.updatedAt,
        thread,
      ]);
    });
    transaction();
    return requiredMessage(thread, message);
  }

  function beginRun(input: BeginConsoleChatRunInput): ConsoleChatThread {
    const runId = assertIdentifier(input.runId, "run.id");
    const expectedMode = previewModeForPeer(input.peer, input.thread.id);
    if (input.thread.previewMode !== expectedMode) {
      throw new Error(`${STORE_LABEL}: kernel history access denied`);
    }
    const owner = normalizeOwner(
      consoleChatOwnerFromPeer(input.peer),
      input.thread.id,
      expectedMode,
    );
    if (owner === null) throw new Error(`${STORE_LABEL}: kernel history access denied`);
    const thread = normalizeThreadInput({
      ...input.thread,
      owner,
      // A streaming state is installed only after both messages exist.
      runStatus: "idle",
    });
    const userMessage = normalizeMessageInput(input.userMessage);
    const assistantMessage = normalizeMessageInput(input.assistantMessage);
    if (userMessage.role !== "user") {
      throw new Error(`${STORE_LABEL}: run user message must have role user`);
    }
    if (assistantMessage.role !== "assistant") {
      throw new Error(`${STORE_LABEL}: run assistant message must have role assistant`);
    }
    if (userMessage.id === assistantMessage.id) {
      throw new Error(`${STORE_LABEL}: run message ids must be unique`);
    }
    if (assistantMessage.createdAt < userMessage.createdAt) {
      throw new Error(`${STORE_LABEL}: assistant message predates user message`);
    }

    db.transaction(() => {
      assertThreadNotDeleted(thread.id);
      const initialRow = getThreadStatement.get(thread.id) as ThreadRow | null;
      if (!initialRow) {
        insertThread({
          ...input.thread,
          owner,
          runStatus: "idle",
        });
      } else {
        claimOrAssertKernelHistoryOwner(thread.id, input.peer);
      }

      const storedRow = getThreadStatement.get(thread.id) as ThreadRow | null;
      if (!storedRow) throw new Error(`${STORE_LABEL}: thread disappeared: ${thread.id}`);
      const stored = rowToThread(storedRow);
      if (stored.runStatus === "streaming") {
        throw new Error(`${STORE_LABEL}: thread already has a streaming run`);
      }
      if (userMessage.createdAt < stored.createdAt) {
        throw new Error(`${STORE_LABEL}: message timestamp predates thread`);
      }

      // The runtime model can change between process lifetimes. A supplied
      // snapshot describes the model handling this run and replaces stale
      // metadata; null means the current runtime could not identify itself, so
      // retain the last known snapshot rather than erasing it.
      const model = thread.model ?? stored.model;
      const next = getNextSequenceStatement.get(thread.id) as { sequence?: unknown } | null;
      if (!Number.isSafeInteger(next?.sequence) || (next?.sequence as number) < 0) {
        throw new Error(`${STORE_LABEL}: invalid message sequence`);
      }
      const sequence = next!.sequence as number;
      insertMessage(thread.id, sequence, userMessage);
      insertMessage(thread.id, sequence + 1, assistantMessage);
      const activityAt = Math.max(
        stored.updatedAt,
        userMessage.updatedAt,
        assistantMessage.updatedAt,
      );
      db.run(
        `UPDATE console_chat_threads
            SET model_provider = ?, model_id = ?, model_display = ?,
                updated_at = ?, unread = ?, run_status = 'streaming',
                active_run_id = ?, active_assistant_message_id = ?
          WHERE id = ?`,
        [
          model?.provider ?? null,
          model?.id ?? null,
          model?.displayName ?? null,
          activityAt,
          thread.unread ? 1 : 0,
          runId,
          assistantMessage.id,
          thread.id,
        ],
      );
    })();

    return requiredThread(thread.id);
  }

  function lockActiveRun(threadId: string, runId: string, assistantMessageId: string): boolean {
    return (
      db.run(
        `UPDATE console_chat_threads SET active_run_id = active_run_id
          WHERE id = ? AND run_status = 'streaming'
            AND active_run_id = ? AND active_assistant_message_id = ?`,
        [threadId, runId, assistantMessageId],
      ).changes === 1
    );
  }

  function writeMessageUpdate(
    threadId: string,
    messageId: string,
    update: ReturnType<typeof normalizeMessageUpdate>,
  ): void {
    const result = db.run(
      `UPDATE console_chat_messages
          SET content = ?, tool_calls_json = ?, error = ?, updated_at = ?
        WHERE thread_id = ? AND id = ? AND role = 'assistant'`,
      [
        update.content,
        serializeToolCalls(update.toolCalls),
        update.error,
        update.updatedAt,
        threadId,
        messageId,
      ],
    );
    if (result.changes !== 1) {
      throw new Error(`${STORE_LABEL}: active assistant message is missing`);
    }
  }

  function updateRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: UpdateConsoleChatMessageInput,
  ): ConsoleChatMessage | null {
    const thread = assertIdentifier(threadId, "threadId");
    const run = assertIdentifier(runId, "run.id");
    const assistant = assertIdentifier(assistantMessageId, "assistantMessageId");
    return db.transaction(() => {
      if (!lockActiveRun(thread, run, assistant)) return null;
      const row = getMessageStatement.get(thread, assistant) as MessageRow | null;
      if (!row) throw new Error(`${STORE_LABEL}: active assistant message is missing`);
      const update = normalizeMessageUpdate(rowToMessage(row), input);
      writeMessageUpdate(thread, assistant, update);
      db.run(`UPDATE console_chat_threads SET updated_at = MAX(updated_at, ?) WHERE id = ?`, [
        update.updatedAt,
        thread,
      ]);
      return requiredMessage(thread, assistant);
    })();
  }

  function finishRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: FinishConsoleChatRunInput,
  ): ConsoleChatThread | null {
    return finishRunTransaction(threadId, runId, assistantMessageId, input, null);
  }

  function finishRunWithKernelHistory(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    peer: PeerIdentity,
    snapshot: ThreadHistorySnapshot,
    input: FinishConsoleChatRunInput,
  ): ConsoleChatThread | null {
    if (!isPlainObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.messages)) {
      throw new Error(`${STORE_LABEL}: invalid kernel history snapshot`);
    }
    // Bound and normalize before taking SQLite's write lock. The transaction
    // repeats serialization through saveKernelHistory so unchecked data can
    // never reach the database if this code changes later.
    const normalizedHistory = parseKernelHistory(serializeKernelHistory(snapshot.messages));
    return finishRunTransaction(threadId, runId, assistantMessageId, input, {
      peer,
      messages: normalizedHistory,
    });
  }

  function finishRunTransaction(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: FinishConsoleChatRunInput,
    history: { peer: PeerIdentity; messages: readonly KernelMessage[] } | null,
  ): ConsoleChatThread | null {
    const thread = assertIdentifier(threadId, "threadId");
    const run = assertIdentifier(runId, "run.id");
    const assistant = assertIdentifier(assistantMessageId, "assistantMessageId");
    assertTerminalRunStatus(input.status);
    if (typeof input.unread !== "boolean") {
      throw new Error(`${STORE_LABEL}: unread must be a boolean`);
    }
    return db.transaction(() => {
      if (!lockActiveRun(thread, run, assistant)) return null;
      const row = getMessageStatement.get(thread, assistant) as MessageRow | null;
      if (!row) throw new Error(`${STORE_LABEL}: active assistant message is missing`);
      const update = normalizeMessageUpdate(rowToMessage(row), input);
      if (history) {
        claimOrAssertKernelHistoryOwner(thread, history.peer);
        saveKernelHistory(thread, history.messages, update.updatedAt);
      }
      writeMessageUpdate(thread, assistant, update);
      db.run(
        `UPDATE console_chat_threads
            SET updated_at = MAX(updated_at, ?), unread = ?,
                last_read_at = CASE
                  WHEN ? = 0 THEN MAX(COALESCE(last_read_at, 0), ?)
                  ELSE last_read_at
                END,
                run_status = ?, active_run_id = NULL, active_assistant_message_id = NULL
          WHERE id = ?`,
        [
          update.updatedAt,
          input.unread ? 1 : 0,
          input.unread ? 1 : 0,
          update.updatedAt,
          input.status,
          thread,
        ],
      );
      return requiredThread(thread);
    })();
  }

  function abandonRun(
    threadId: string,
    runId: string,
    assistantMessageId: string,
    input: AbandonConsoleChatRunInput,
  ): ConsoleChatThread | null {
    const thread = assertIdentifier(threadId, "threadId");
    const run = assertIdentifier(runId, "run.id");
    const assistant = assertIdentifier(assistantMessageId, "assistantMessageId");
    if (input.status !== "error" && input.status !== "interrupted") {
      throw new Error(`${STORE_LABEL}: invalid abandoned run status`);
    }
    if (typeof input.unread !== "boolean") {
      throw new Error(`${STORE_LABEL}: unread must be a boolean`);
    }
    const error = boundedString(input.error, MAX_RUN_ERROR_LENGTH, "run.error");
    const updatedAt = assertTimestamp(input.updatedAt, "run.updatedAt");

    return db.transaction(() => {
      if (!lockActiveRun(thread, run, assistant)) return null;
      const row = getMessageStatement.get(thread, assistant) as MessageRow | null;
      if (!row) throw new Error(`${STORE_LABEL}: active assistant message is missing`);
      const existing = rowToMessage(row);
      if (updatedAt < existing.createdAt) {
        throw new Error(`${STORE_LABEL}: updatedAt predates message`);
      }
      assertTimestampNotBefore(updatedAt, existing.updatedAt, "run.updatedAt");

      const messageResult = db.run(
        `UPDATE console_chat_messages SET error = ?, updated_at = ?
          WHERE thread_id = ? AND id = ? AND role = 'assistant'`,
        [error, updatedAt, thread, assistant],
      );
      if (messageResult.changes !== 1) {
        throw new Error(`${STORE_LABEL}: active assistant message is missing`);
      }
      db.run(
        `UPDATE console_chat_threads
            SET updated_at = MAX(updated_at, ?), unread = ?,
                last_read_at = CASE
                  WHEN ? = 0 THEN MAX(COALESCE(last_read_at, 0), ?)
                  ELSE last_read_at
                END,
                run_status = ?, active_run_id = NULL, active_assistant_message_id = NULL
          WHERE id = ?`,
        [updatedAt, input.unread ? 1 : 0, input.unread ? 1 : 0, updatedAt, input.status, thread],
      );
      return requiredThread(thread);
    })();
  }

  function renameThread(
    threadId: string,
    title: string,
    updatedAt: number,
  ): ConsoleChatThreadSummary | null {
    const id = assertIdentifier(threadId, "threadId");
    const normalizedTitle = boundedCodePointString(title.trim(), MAX_TITLE_LENGTH, "thread.title");
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
    return db.transaction(() => {
      if (getTombstoneStatement.get(id) !== null) return false;
      const row = getThreadStatement.get(id) as ThreadRow | null;
      const existing = row ? rowToThread(row) : null;
      if (existing?.runStatus === "streaming") {
        throw new Error(`${STORE_LABEL}: cannot delete a streaming thread`);
      }
      const requestedDeletedAt = assertTimestamp(now(), "now()");
      const deletedAt = existing
        ? Math.max(requestedDeletedAt, existing.updatedAt)
        : requestedDeletedAt;
      db.run(
        `INSERT INTO console_chat_tombstones (thread_id, deleted_at)
         VALUES (?, ?) ON CONFLICT(thread_id) DO NOTHING`,
        [id, deletedAt],
      );
      if (!row) return false;
      // Bun/SQLite includes rows removed by FK cascades in `changes` on some
      // versions, so this is deliberately a positive check rather than `=== 1`.
      return db.run(`DELETE FROM console_chat_threads WHERE id = ?`, [id]).changes > 0;
    })();
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
              owner_public_substate = ?, owner_org_id = ?
        WHERE id = ? AND preview_mode = ?
          AND bound_peer_id IS NULL AND owner_peer_kind IS NULL
          AND owner_trust_level IS NULL AND owner_public_substate IS NULL
          AND owner_org_id IS NULL`,
      [
        owner.peerId,
        owner.kind,
        owner.trustLevel,
        owner.publicSubstate,
        owner.orgId ?? null,
        id,
        previewMode,
      ],
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
    hasThread,
    isThreadDeleted,
    listThreads,
    getThread,
    createThread,
    createThreadWithMessages,
    upsertThread,
    updateThread,
    promoteAnonymousThread,
    appendMessage,
    updateMessage,
    beginRun,
    updateRun,
    finishRun,
    finishRunWithKernelHistory,
    abandonRun,
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
  if (runStatus === "streaming") {
    throw new Error(`${STORE_LABEL}: streaming state must be started with beginRun`);
  }
  const unread = input.unread ?? false;
  if (typeof unread !== "boolean") throw new Error(`${STORE_LABEL}: unread must be a boolean`);
  return {
    id,
    title: boundedCodePointString(input.title.trim(), MAX_TITLE_LENGTH, "thread.title"),
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
    input.owner?.orgId ?? null,
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

function normalizeMessageUpdate(
  existing: ConsoleChatMessage,
  input: UpdateConsoleChatMessageInput,
) {
  const updatedAt = assertTimestamp(input.updatedAt, "message.updatedAt");
  if (updatedAt < existing.createdAt) {
    throw new Error(`${STORE_LABEL}: updatedAt predates message`);
  }
  assertTimestampNotBefore(updatedAt, existing.updatedAt, "message.updatedAt");
  return {
    content:
      input.content === undefined
        ? existing.content
        : boundedString(input.content, MAX_MESSAGE_CONTENT_LENGTH, "message.content", true),
    toolCalls:
      input.toolCalls === undefined ? existing.toolCalls : normalizeToolCalls(input.toolCalls),
    error:
      input.error === undefined
        ? existing.error
        : nullableBoundedString(input.error, MAX_MESSAGE_CONTENT_LENGTH, "message.error", true),
    updatedAt,
  };
}

function rowToThread(row: ThreadRow): ConsoleChatThreadSummary {
  const id = assertIdentifier(row.id, "stored thread.id");
  const title = boundedCodePointString(row.title, MAX_TITLE_LENGTH, "stored thread.title");
  assertPreviewMode(row.preview_mode);
  assertRunStatus(row.run_status);
  const activeRunId =
    row.active_run_id === null ? null : assertIdentifier(row.active_run_id, "stored active run id");
  const activeAssistantMessageId =
    row.active_assistant_message_id === null
      ? null
      : assertIdentifier(row.active_assistant_message_id, "stored active assistant message id");
  if (
    (row.run_status === "streaming" &&
      (activeRunId === null || activeAssistantMessageId === null)) ||
    (row.run_status !== "streaming" && (activeRunId !== null || activeAssistantMessageId !== null))
  ) {
    throw new Error(`${STORE_LABEL}: invalid stored active run state`);
  }
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

  const orgId =
    owner.orgId === undefined ? undefined : boundedString(owner.orgId, 256, "thread.owner.orgId");
  if (orgId !== undefined && hasControlCharacter(orgId)) {
    throw new Error(`${STORE_LABEL}: thread.owner.orgId contains control characters`);
  }
  const normalized = {
    peerId,
    kind: owner.kind,
    trustLevel: owner.trustLevel,
    publicSubstate,
    ...(orgId !== undefined ? { orgId } : {}),
  };
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
    row.owner_public_substate === null &&
    row.owner_org_id === null
  ) {
    return null;
  }
  return normalizeOwner(
    {
      peerId: boundedString(row.bound_peer_id, MAX_PEER_ID_LENGTH, "stored owner.peerId"),
      kind: row.owner_peer_kind as PeerKind,
      trustLevel: row.owner_trust_level as TrustLevel,
      publicSubstate: row.owner_public_substate as "anonymous" | "recognized" | null,
      ...(row.owner_org_id !== null
        ? {
            orgId: boundedString(row.owner_org_id, 256, "stored owner.orgId"),
          }
        : {}),
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

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedCodePointString(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string") throw new Error(`${STORE_LABEL}: ${field} must be a string`);
  const length = Array.from(value).length;
  if (length === 0 || length > maxLength) {
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

function assertTerminalRunStatus(
  value: unknown,
): asserts value is FinishConsoleChatRunInput["status"] {
  if (value !== "complete" && value !== "error" && value !== "interrupted") {
    throw new Error(`${STORE_LABEL}: invalid terminal run status`);
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
    left?.publicSubstate === right?.publicSubstate &&
    left?.orgId === right?.orgId
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

import { afterEach, describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createTempDir } from "@tests/fixtures/temp-dir";
import {
  CONSOLE_CHAT_APPLICATION_ID,
  CONSOLE_CHAT_SCHEMA_VERSION,
  consoleChatOwnerMatchesPeer,
  createConsoleChatStore,
  type AppendConsoleChatMessageInput,
  type ConsoleChatStore,
} from "@/transports/admin/console-chat-store";
import type { Message as KernelMessage } from "@/types";

const THREAD = {
  id: "thread-1",
  title: "Debug auth",
  previewMode: "creator" as const,
  owner: {
    peerId: "creator",
    kind: "human" as const,
    trustLevel: "creator" as const,
    publicSubstate: null,
  },
  model: { provider: "anthropic", id: "claude-test", displayName: "Claude Test" },
  createdAt: 1_000,
  updatedAt: 1_000,
  lastReadAt: 1_000,
  unread: false,
  runStatus: "idle" as const,
};

const USER_MESSAGE: AppendConsoleChatMessageInput = {
  id: "message-user",
  role: "user",
  content: "Can an anonymous visitor do this?",
  createdAt: 1_100,
};

const ASSISTANT_MESSAGE: AppendConsoleChatMessageInput = {
  id: "message-assistant",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call-1",
      name: "lookup",
      args: '{"id":"safe"}',
      status: "running",
    },
  ],
  createdAt: 1_101,
};

const KERNEL_HISTORY: KernelMessage[] = [
  {
    id: "kernel-user",
    role: "user",
    peerId: "creator",
    content: "Can an anonymous visitor do this?",
    timestamp: 1_100,
    tokenCount: 8,
  },
  {
    id: "kernel-assistant",
    role: "assistant",
    content: "Yes.",
    timestamp: 1_200,
    tokenCount: 2,
  },
];

describe("console chat SQLite store", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const stores: ConsoleChatStore[] = [];

  afterEach(async () => {
    while (stores.length > 0) stores.pop()!.close();
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function openStore(now = 2_000): Promise<{ dbPath: string; store: ConsoleChatStore }> {
    const directory = await createTempDir();
    cleanups.push(directory.cleanup);
    const dbPath = join(directory.path, "console-chat.db");
    const store = createConsoleChatStore({ dbPath, now: () => now });
    stores.push(store);
    return { dbPath, store };
  }

  it("creates a branded hardened database with the exact owned schema", async () => {
    const { dbPath, store } = await openStore();

    expect(store.diagnostics()).toMatchObject({
      persistent: true,
      journalMode: "wal",
      synchronous: "full",
      foreignKeys: true,
      trustedSchema: false,
      quickCheck: "ok",
    });
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);

    const probe = new Database(dbPath, { readonly: true });
    try {
      expect(probe.query("PRAGMA application_id").get()).toEqual({
        application_id: CONSOLE_CHAT_APPLICATION_ID,
      });
      expect(probe.query("PRAGMA user_version").get()).toEqual({
        user_version: CONSOLE_CHAT_SCHEMA_VERSION,
      });
      const columns = probe
        .query<{ name: string }, []>("PRAGMA table_info(console_chat_threads)")
        .all()
        .map((row) => row.name);
      expect(columns).not.toContain("visitor_token");
      expect(columns).not.toContain("email");
      expect(columns).not.toContain("csrf");
    } finally {
      probe.close();
    }
  });

  it("supports in-memory databases", () => {
    const store = createConsoleChatStore({ dbPath: ":memory:", now: () => 10 });
    stores.push(store);
    expect(store.diagnostics()).toMatchObject({ persistent: false, foreignKeys: true });
    expect(store.createThread(THREAD).id).toBe(THREAD.id);
  });

  it("rejects unrelated and schema-lookalike databases without stamping ownership", async () => {
    const directory = await createTempDir();
    cleanups.push(directory.cleanup);
    const unrelatedPath = join(directory.path, "unrelated.db");
    const unrelated = new Database(unrelatedPath);
    unrelated.run("CREATE TABLE console_chat_threads (id TEXT PRIMARY KEY)");
    unrelated.close();

    expect(() => createConsoleChatStore({ dbPath: unrelatedPath })).toThrow(
      /not a recognized legacy schema/,
    );

    const probe = new Database(unrelatedPath, { readonly: true });
    try {
      expect(probe.query("PRAGMA application_id").get()).toEqual({ application_id: 0 });
      expect(probe.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(
        probe
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["console_chat_threads"]);
    } finally {
      probe.close();
    }
  });

  it("creates, lists, updates, renames, marks, and upserts thread metadata", async () => {
    const { store } = await openStore();
    const created = store.createThread(THREAD);
    expect(created).toMatchObject({ ...THREAD, messages: [] });

    store.createThread({
      ...THREAD,
      id: "thread-2",
      title: "Second",
      createdAt: 1_500,
      updatedAt: 1_500,
    });
    expect(store.listThreads().map((thread) => thread.id)).toEqual(["thread-2", "thread-1"]);

    expect(
      store.updateThread("thread-1", {
        runStatus: "streaming",
        unread: true,
        updatedAt: 1_600,
      }),
    ).toMatchObject({ owner: THREAD.owner, runStatus: "streaming", unread: true });
    expect(store.setThreadReadState("thread-1", false, 1_700)).toMatchObject({
      unread: false,
      lastReadAt: 1_700,
    });
    expect(store.renameThread("thread-1", "Renamed", 1_800)).toMatchObject({ title: "Renamed" });

    expect(
      store.upsertThread({
        ...THREAD,
        title: "Upserted",
        previewMode: "visitor",
        owner: {
          peerId: "vis_123",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "recognized",
        },
        updatedAt: 1_900,
      }),
    ).toMatchObject({
      title: "Upserted",
      previewMode: "visitor",
      createdAt: THREAD.createdAt,
      updatedAt: 1_900,
    });
    expect(store.getThread("missing")).toBeNull();
    expect(store.renameThread("missing", "Nope", 2_000)).toBeNull();
  });

  it("orders appended messages and safely round-trips tool and error state", async () => {
    const { store } = await openStore();
    store.createThread(THREAD);
    expect(store.appendMessage(THREAD.id, USER_MESSAGE)).toMatchObject({
      ...USER_MESSAGE,
      sequence: 0,
      toolCalls: null,
      error: null,
      updatedAt: USER_MESSAGE.createdAt,
    });
    expect(store.appendMessage(THREAD.id, ASSISTANT_MESSAGE).sequence).toBe(1);

    const completed = store.updateMessage(THREAD.id, ASSISTANT_MESSAGE.id, {
      content: "You can inspect public behavior.",
      toolCalls: [
        {
          id: "call-1",
          name: "lookup",
          args: '{"id":"safe"}',
          result: "allowed",
          status: "completed",
        },
      ],
      error: null,
      updatedAt: 1_200,
    });
    expect(completed).toMatchObject({
      sequence: 1,
      content: "You can inspect public behavior.",
      toolCalls: [{ status: "completed", result: "allowed" }],
      error: null,
    });
    expect(store.getThread(THREAD.id)?.messages.map((message) => message.id)).toEqual([
      USER_MESSAGE.id,
      ASSISTANT_MESSAGE.id,
    ]);
    expect(store.updateMessage(THREAD.id, "missing", { updatedAt: 1_300 })).toBeNull();
    expect(() => store.appendMessage("missing", USER_MESSAGE)).toThrow(/thread not found/);
  });

  it("creates a thread and initial messages atomically", async () => {
    const { store } = await openStore();
    const created = store.createThreadWithMessages(THREAD, [USER_MESSAGE, ASSISTANT_MESSAGE]);
    expect(created.messages.map((message) => message.sequence)).toEqual([0, 1]);
    expect(created.updatedAt).toBe(ASSISTANT_MESSAGE.createdAt);

    expect(() =>
      store.createThreadWithMessages({ ...THREAD, id: "rollback-thread", title: "Rollback" }, [
        USER_MESSAGE,
        { ...ASSISTANT_MESSAGE, id: USER_MESSAGE.id },
      ]),
    ).toThrow();
    expect(store.getThread("rollback-thread")).toBeNull();
    expect(() =>
      store.createThreadWithMessages(
        { ...THREAD, id: "future-thread", createdAt: 10_000, updatedAt: 10_000 },
        [USER_MESSAGE],
      ),
    ).toThrow(/predates thread/);
  });

  it("persists validated kernel history and cascades all thread-owned state on deletion", async () => {
    const { dbPath, store } = await openStore();
    store.createThreadWithMessages(THREAD, [USER_MESSAGE, ASSISTANT_MESSAGE]);
    store.saveKernelHistory(THREAD.id, KERNEL_HISTORY, 1_300);
    expect(store.loadKernelHistory(THREAD.id)).toEqual(KERNEL_HISTORY);

    expect(store.deleteThread(THREAD.id)).toBe(true);
    expect(store.deleteThread(THREAD.id)).toBe(false);
    expect(store.getThread(THREAD.id)).toBeNull();
    expect(store.loadKernelHistory(THREAD.id)).toBeNull();

    const probe = new Database(dbPath, { readonly: true });
    try {
      expect(probe.query("SELECT COUNT(*) AS count FROM console_chat_messages").get()).toEqual({
        count: 0,
      });
      expect(
        probe.query("SELECT COUNT(*) AS count FROM console_chat_kernel_history").get(),
      ).toEqual({ count: 0 });
    } finally {
      probe.close();
    }
  });

  it("supports explicit kernel-history clearing and rejects invalid histories", async () => {
    const { store } = await openStore();
    store.createThread(THREAD);
    expect(() =>
      store.saveKernelHistory(THREAD.id, [{ ...KERNEL_HISTORY[0]!, tokenCount: -1 }], 1_300),
    ).toThrow(/token count/);
    expect(() => store.saveKernelHistory("missing", [], 1_300)).toThrow(/thread not found/);

    store.saveKernelHistory(THREAD.id, [], 1_300);
    expect(store.clearKernelHistory(THREAD.id)).toBe(true);
    expect(store.clearKernelHistory(THREAD.id)).toBe(false);
  });

  it("converts stale streaming threads to interrupted when reopened", async () => {
    const { dbPath, store } = await openStore(2_000);
    store.createThread({ ...THREAD, runStatus: "streaming" });
    store.close();
    stores.pop();

    const reopened = createConsoleChatStore({ dbPath, now: () => 5_000 });
    stores.push(reopened);
    expect(reopened.getThread(THREAD.id)).toMatchObject({
      runStatus: "interrupted",
      updatedAt: 5_000,
    });
  });

  it("rejects malformed persisted JSON on read", async () => {
    const { dbPath, store } = await openStore();
    store.createThreadWithMessages(THREAD, [ASSISTANT_MESSAGE]);
    store.saveKernelHistory(THREAD.id, KERNEL_HISTORY, 1_300);
    store.close();
    stores.pop();

    const tamper = new Database(dbPath);
    tamper.run("PRAGMA ignore_check_constraints = ON");
    tamper.run(
      "UPDATE console_chat_messages SET tool_calls_json = ? WHERE thread_id = ? AND id = ?",
      ["not-json", THREAD.id, ASSISTANT_MESSAGE.id],
    );
    tamper.run("UPDATE console_chat_kernel_history SET history_json = ? WHERE thread_id = ?", [
      "{}",
      THREAD.id,
    ]);
    tamper.close();

    const reopened = createConsoleChatStore({ dbPath });
    stores.push(reopened);
    expect(() => reopened.getThread(THREAD.id)).toThrow(/tool call JSON/);
    expect(() => reopened.loadKernelHistory(THREAD.id)).toThrow(/must be an array/);
  });

  it("validates identifiers, titles, timestamps, and message shapes before writing", async () => {
    const { store } = await openStore();
    expect(() => store.createThread({ ...THREAD, id: "" })).toThrow(/invalid length/);
    expect(() => store.createThread({ ...THREAD, title: " ".repeat(5) })).toThrow(/invalid length/);
    expect(() => store.createThread({ ...THREAD, createdAt: -1 })).toThrow(/non-negative/);

    store.createThread(THREAD);
    expect(() =>
      store.appendMessage(THREAD.id, {
        ...ASSISTANT_MESSAGE,
        toolCalls: [{ id: "call", name: "tool", status: "unknown" as "error" }],
      }),
    ).toThrow(/tool call status/);
    expect(() =>
      store.updateThread(THREAD.id, {
        model: { id: "", displayName: "Model", provider: null },
        updatedAt: 2_000,
      }),
    ).toThrow(/model.id/);
  });

  it("binds populated threads to the exact identified authorization context", async () => {
    const { store } = await openStore();
    const anonymousThread = {
      ...THREAD,
      id: "anon-thread",
      previewMode: "anonymous" as const,
      owner: {
        peerId: "anon-anon-thread",
        kind: "human" as const,
        trustLevel: "public" as const,
        publicSubstate: "anonymous" as const,
      },
    };
    store.createThreadWithMessages(anonymousThread, [USER_MESSAGE]);

    expect(store.getThread(anonymousThread.id)?.owner).toEqual(anonymousThread.owner);
    expect(
      consoleChatOwnerMatchesPeer(anonymousThread.owner, {
        id: "anon-anon-thread",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      }),
    ).toBe(true);
    expect(() =>
      store.updateThread(anonymousThread.id, {
        owner: { ...anonymousThread.owner, publicSubstate: "recognized" },
        updatedAt: 2_000,
      }),
    ).toThrow(/does not match preview mode|immutable/);
    expect(() =>
      store.upsertThread({
        ...anonymousThread,
        owner: { ...anonymousThread.owner, peerId: "anon-another-thread" },
        updatedAt: 2_000,
      }),
    ).toThrow(/does not match preview mode|immutable/);
    expect(() =>
      store.createThreadWithMessages({ ...THREAD, id: "unbound-thread", owner: null }, [
        USER_MESSAGE,
      ]),
    ).toThrow(/requires an identified owner/);
  });

  it("rejects cross-mode owners and non-thread-derived anonymous identities", async () => {
    const { store } = await openStore();
    expect(() =>
      store.createThread({
        ...THREAD,
        id: "anonymous-thread",
        previewMode: "anonymous",
        owner: {
          peerId: "anon-wrong-thread",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "anonymous",
        },
      }),
    ).toThrow(/does not match preview mode/);
    expect(() =>
      store.createThread({
        ...THREAD,
        id: "visitor-thread",
        previewMode: "visitor",
        owner: {
          peerId: "vis_123",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "anonymous",
        },
      }),
    ).toThrow(/does not match preview mode/);
  });
});

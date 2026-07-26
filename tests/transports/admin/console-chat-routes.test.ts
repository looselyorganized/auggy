import { afterEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import {
  createConsoleChatStore,
  type ConsoleChatStore,
} from "@/transports/admin/console-chat-store";
import {
  buildAdminActionRegistry,
  handleAdminRoute,
  type AdminRouteContext,
} from "@/transports/admin/index";
import type { AgentCard, TransportKernel, TurnResult } from "@/types";
import { createTempDir } from "@tests/fixtures/temp-dir";

const openedStores: ConsoleChatStore[] = [];

afterEach(() => {
  for (const store of openedStores.splice(0)) store.close();
});

async function makeContext(
  overrides: Partial<AdminRouteContext> = {},
  onForget?: (threadId: string) => void,
): Promise<AdminRouteContext> {
  const card: AgentCard = {
    provider: { name: "zip" },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
  const kernel: TransportKernel = {
    handleInbound: async () => ({}) as TurnResult,
    forgetThreadHistory: onForget,
    onOutbound: () => {},
    quarantineThread: () => true,
    recoverThread: () => false,
    getAgentCard: () => card,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
  return {
    kernel,
    bearer: "test-bearer",
    agentDir: undefined,
    callerIp: "127.0.0.1",
    actionRegistry: await buildAdminActionRegistry([]),
    ...overrides,
  };
}

function createStore(): ConsoleChatStore {
  const store = createConsoleChatStore({ dbPath: ":memory:", now: () => 1_000 });
  openedStores.push(store);
  return store;
}

function createThread(
  store: ConsoleChatStore,
  overrides: { id?: string; runStatus?: "idle" | "streaming" } = {},
) {
  return store.createThreadWithMessages(
    {
      id: overrides.id ?? "thread-1",
      title: "Persistent chat",
      previewMode: "creator",
      owner: {
        peerId: "creator",
        kind: "human",
        trustLevel: "creator",
        publicSubstate: null,
      },
      model: { id: "model-1", displayName: "Model One", provider: "demo" },
      createdAt: 1_000,
      lastReadAt: 1_000,
      unread: false,
      runStatus: overrides.runStatus ?? "idle",
    },
    [
      {
        id: "message-1",
        role: "user",
        content: "hello",
        createdAt: 1_001,
      },
    ],
  );
}

function basicHeader(): string {
  return `Basic ${Buffer.from(":test-bearer").toString("base64")}`;
}

function get(path: string): Request {
  return new Request(`http://127.0.0.1:8080${path}`, {
    headers: { authorization: basicHeader() },
  });
}

async function csrf(): Promise<string> {
  return generateCsrfToken({
    bearer: "test-bearer",
    agentName: "zip",
    actionId: "console-chat",
  });
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1:8080${path}`, {
    method: "POST",
    headers: {
      authorization: basicHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function postRaw(path: string, body: string): Request {
  return new Request(`http://127.0.0.1:8080${path}`, {
    method: "POST",
    headers: {
      authorization: basicHeader(),
      "content-type": "application/json",
    },
    body,
  });
}

describe("persisted console chat routes", () => {
  it("lists summaries and returns message detail without persisted owner identity", async () => {
    const store = createStore();
    createThread(store);
    const ctx = await makeContext({ consoleChat: store });

    const list = await handleAdminRoute(get("/console/api/chat/threads"), ctx);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toContain("no-store");
    const listBody = (await list.json()) as { threads: Array<Record<string, unknown>> };
    expect(listBody.threads).toHaveLength(1);
    expect(listBody.threads[0]).toMatchObject({
      id: "thread-1",
      title: "Persistent chat",
      previewMode: "creator",
      createdAt: new Date(1_000).toISOString(),
      unread: false,
    });
    expect(listBody.threads[0]).not.toHaveProperty("messages");
    expect(listBody.threads[0]).not.toHaveProperty("owner");

    const detail = await handleAdminRoute(get("/console/api/chat/threads/thread-1"), ctx);
    expect(detail.status).toBe(200);
    const detailText = await detail.text();
    expect(detailText).not.toContain("peerId");
    const detailBody = JSON.parse(detailText) as { thread: Record<string, unknown> };
    expect(detailBody.thread).not.toHaveProperty("owner");
    expect(detailBody.thread.messages).toEqual([
      {
        id: "message-1",
        role: "user",
        content: "hello",
        createdAt: new Date(1_001).toISOString(),
        updatedAt: new Date(1_001).toISOString(),
      },
    ]);
  });

  it("renames and updates unread state with the console-chat CSRF token", async () => {
    const store = createStore();
    createThread(store);
    const ctx = await makeContext({ consoleChat: store });
    const token = await csrf();

    const renamed = await handleAdminRoute(
      post("/console/api/chat/threads/thread-1/rename", { csrf: token, title: "  New name  " }),
      ctx,
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { thread: { title: string } }).thread.title).toBe("New name");

    const unread = await handleAdminRoute(
      post("/console/api/chat/threads/thread-1/read-state", { csrf: token, unread: true }),
      ctx,
    );
    expect(unread.status).toBe(200);
    expect(((await unread.json()) as { thread: { unread: boolean } }).thread.unread).toBe(true);
  });

  it("deletes storage before evicting kernel history", async () => {
    const store = createStore();
    createThread(store);
    const order: string[] = [];
    const deleteThread = store.deleteThread.bind(store);
    store.deleteThread = (threadId) => {
      order.push("store");
      return deleteThread(threadId);
    };
    const ctx = await makeContext({ consoleChat: store }, () => order.push("kernel"));

    const response = await handleAdminRoute(
      post("/console/api/chat/threads/thread-1/delete", { csrf: await csrf() }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["store", "kernel"]);
    expect(store.getThread("thread-1")).toBeNull();
  });

  it("refuses to delete a streaming thread or evict its kernel history", async () => {
    const store = createStore();
    createThread(store);
    const forgotten: string[] = [];
    const streamingStore: ConsoleChatStore = {
      ...store,
      getThread(threadId) {
        const thread = store.getThread(threadId);
        return thread ? { ...thread, runStatus: "streaming" } : null;
      },
      deleteThread() {
        throw new Error("streaming delete conflict");
      },
    };
    const ctx = await makeContext({ consoleChat: streamingStore }, (id) => forgotten.push(id));

    const response = await handleAdminRoute(
      post("/console/api/chat/threads/thread-1/delete", { csrf: await csrf() }),
      ctx,
    );
    expect(response.status).toBe(409);
    expect(store.getThread("thread-1")).not.toBeNull();
    expect(forgotten).toEqual([]);
  });

  it("classifies a transactional streaming conflict without inspecting error text", async () => {
    const store = createStore();
    createThread(store);
    const forgotten: string[] = [];
    const racingStore: ConsoleChatStore = {
      ...store,
      getThread(threadId) {
        const thread = store.getThread(threadId);
        return thread ? { ...thread, runStatus: "streaming" } : null;
      },
      deleteThread() {
        throw new Error("opaque storage conflict");
      },
    };
    const ctx = await makeContext({ consoleChat: racingStore }, (id) => forgotten.push(id));

    const response = await handleAdminRoute(
      post("/console/api/chat/threads/thread-1/delete", { csrf: await csrf() }),
      ctx,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Cannot delete a chat while it is streaming.",
    });
    expect(forgotten).toEqual([]);
  });

  it("deletes absent and already-deleted identifiers idempotently through storage first", async () => {
    const store = createStore();
    createThread(store);
    const order: string[] = [];
    const deleteThread = store.deleteThread.bind(store);
    store.deleteThread = (threadId) => {
      order.push(`store:${threadId}`);
      return deleteThread(threadId);
    };
    const ctx = await makeContext({ consoleChat: store }, (threadId) =>
      order.push(`kernel:${threadId}`),
    );
    const token = await csrf();

    for (const threadId of ["thread-1", "thread-1", "never-created", "never-created"]) {
      const response = await handleAdminRoute(
        post(`/console/api/chat/threads/${threadId}/delete`, { csrf: token }),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }

    expect(order).toEqual([
      "store:thread-1",
      "kernel:thread-1",
      "store:thread-1",
      "kernel:thread-1",
      "store:never-created",
      "kernel:never-created",
      "store:never-created",
      "kernel:never-created",
    ]);
    expect(store.isThreadDeleted("thread-1")).toBeTrue();
    expect(store.isThreadDeleted("never-created")).toBeTrue();
  });

  it("distinguishes tombstoned threads from identifiers that were never seen", async () => {
    const store = createStore();
    createThread(store);
    expect(store.deleteThread("thread-1")).toBeTrue();
    expect(store.deleteThread("absent-tombstone")).toBeFalse();
    const ctx = await makeContext({ consoleChat: store });
    const token = await csrf();

    for (const threadId of ["thread-1", "absent-tombstone"]) {
      const requests = [
        get(`/console/api/chat/threads/${threadId}`),
        post(`/console/api/chat/threads/${threadId}/rename`, {
          csrf: token,
          title: "Still gone",
        }),
        post(`/console/api/chat/threads/${threadId}/read-state`, {
          csrf: token,
          unread: true,
        }),
      ];
      for (const request of requests) {
        const response = await handleAdminRoute(request, ctx);
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ error: "thread was deleted" });
      }
    }

    const neverSeenRequests = [
      get("/console/api/chat/threads/never-seen"),
      post("/console/api/chat/threads/never-seen/rename", {
        csrf: token,
        title: "Missing",
      }),
      post("/console/api/chat/threads/never-seen/read-state", {
        csrf: token,
        unread: true,
      }),
    ];
    for (const request of neverSeenRequests) {
      const response = await handleAdminRoute(request, ctx);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "thread not found" });
    }
  });

  it("strictly validates route ids, request bodies, titles, methods, and CSRF", async () => {
    const store = createStore();
    createThread(store);
    const ctx = await makeContext({ consoleChat: store });
    const token = await csrf();

    const cases: Array<[Request, number]> = [
      [get("/console/api/chat/threads/%2Fetc%2Fpasswd"), 400],
      [post("/console/api/chat/threads/thread-1/rename", { title: "missing csrf" }), 400],
      [post("/console/api/chat/threads/thread-1/rename", { csrf: "bad", title: "x" }), 403],
      [post("/console/api/chat/threads/thread-1/rename", { csrf: token, title: "   " }), 400],
      [post("/console/api/chat/threads/thread-1/rename", { csrf: token, title: "x\ny" }), 400],
      [
        post("/console/api/chat/threads/thread-1/rename", { csrf: token, title: "x", extra: true }),
        400,
      ],
      [post("/console/api/chat/threads/thread-1/read-state", { csrf: token, unread: "yes" }), 400],
      [get("/console/api/chat/threads/thread-1/delete"), 405],
      [get("/console/api/chat/threads/missing"), 404],
    ];
    for (const [request, status] of cases) {
      const response = await handleAdminRoute(request, ctx);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("returns 503 instead of silently presenting ephemeral history when storage is absent", async () => {
    const response = await handleAdminRoute(get("/console/api/chat/threads"), await makeContext());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("injects validated persistence metadata and the process marker only on the self-fetch", async () => {
    const store = createStore();
    const originalFetch = globalThis.fetch;
    let forwardedHeaders: Headers | undefined;
    let forwardedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      forwardedHeaders = new Headers(init?.headers);
      forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"error":"owner mismatch"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const ctx = await makeContext({
        consoleChat: store,
        consoleChatInternalMarker: "private-process-marker",
        selfPort: 9999,
      });
      const response = await handleAdminRoute(
        post("/console/api/chat", {
          csrf: await csrf(),
          message: "hello",
          threadId: "thread-1",
          chatMode: "visitor",
          visitorToken: "visitor.payload.signature",
          title: "First prompt",
          model: { id: "model-1", displayName: "Model One", provider: "demo" },
          runId: "run-1",
          userMessageId: "message-user",
          assistantMessageId: "message-assistant",
        }),
        ctx,
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-auggy-console-internal")).toBeNull();
      expect(forwardedHeaders?.get("x-auggy-console-internal")).toBe("private-process-marker");
      expect(forwardedHeaders?.get("x-visitor-token")).toBe("visitor.payload.signature");
      expect(forwardedBody).toMatchObject({
        threadId: "thread-1",
        __console: {
          previewMode: "visitor",
          title: "First prompt",
          model: { id: "model-1", displayName: "Model One", provider: "demo" },
          unreadOnFinish: true,
          runId: "run-1",
          userMessageId: "message-user",
          assistantMessageId: "message-assistant",
        },
      });
      expect(JSON.stringify(forwardedBody)).not.toContain("visitor.payload.signature");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the currently configured engine for persisted run metadata", async () => {
    const store = createStore();
    const directory = await createTempDir();
    const originalFetch = globalThis.fetch;
    let forwardedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"error":"owner mismatch"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await writeFile(
        join(directory.path, "agent.yaml"),
        "name: zip\nengine:\n  provider: anthropic\n  model: claude-current\n",
      );
      const ctx = await makeContext({
        agentDir: directory.path,
        consoleChat: store,
        consoleChatInternalMarker: "private-process-marker",
        selfPort: 9999,
      });
      const response = await handleAdminRoute(
        post("/console/api/chat", {
          csrf: await csrf(),
          message: "continue after rotation",
          threadId: "thread-1",
          chatMode: "creator",
          model: { id: "claude-old", displayName: "Claude Old", provider: "anthropic" },
        }),
        ctx,
      );

      expect(response.status).toBe(403);
      expect(forwardedBody).toMatchObject({
        __console: {
          model: {
            id: "claude-current",
            displayName: "claude-current",
            provider: "anthropic",
          },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await directory.cleanup();
    }
  });

  it("rejects malformed persistence metadata before self-fetch", async () => {
    const store = createStore();
    const ctx = await makeContext({
      consoleChat: store,
      consoleChatInternalMarker: "private-process-marker",
      selfPort: 9999,
    });
    const token = await csrf();
    const invalidModel = await handleAdminRoute(
      post("/console/api/chat", {
        csrf: token,
        message: "hello",
        threadId: "thread-1",
        chatMode: "creator",
        model: { id: "model-1", displayName: "Model One", secret: "must not pass" },
      }),
      ctx,
    );
    expect(invalidModel.status).toBe(400);

    const missingMarker = await handleAdminRoute(
      post("/console/api/chat", {
        csrf: token,
        message: "hello",
        threadId: "thread-1",
        chatMode: "creator",
      }),
      await makeContext({ consoleChat: store, selfPort: 9999 }),
    );
    expect(missingMarker.status).toBe(503);
  });

  it("rejects null and array chat JSON bodies as invalid objects", async () => {
    const ctx = await makeContext({ selfPort: 9999 });
    for (const raw of ["null", "[]"]) {
      const response = await handleAdminRoute(postRaw("/console/api/chat", raw), ctx);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid JSON body" });
    }
  });
});

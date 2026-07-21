import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DashboardProvider } from "@/components/admin/DashboardContext";
import {
  ChatWorkspaceProvider,
  shouldDeferDetailReconciliation,
  shouldRetryChatHydration,
  useChatWorkspace,
  type ChatWorkspaceContextValue,
} from "@/components/admin/ChatWorkspaceProvider";
import { ConsoleChatApiError } from "@/lib/console-chat-api";
import {
  createChatThread,
  createChatWorkspace,
  type ChatMessage,
  type ChatThread,
  type ChatWorkspaceState,
} from "@/lib/chat-workspace";
import type { DashboardData } from "@/lib/types";

const T0 = "2026-07-20T10:00:00.000Z";
const T1 = "2026-07-20T10:01:00.000Z";
const MODEL = { id: "claude-sonnet", displayName: "Claude Sonnet", provider: "anthropic" };

const dashboardData = {
  card: { provider: { name: "test-agent" } },
  auggyVersion: "test",
  agentMeta: { engine: { provider: MODEL.provider, model: MODEL.id } },
  augments: [],
  tools: { totalTools: 0, entries: [] },
  routes: { summary: {}, entries: [] },
  web: {
    allowAnonymous: { value: true },
    publicIntegration: { value: false },
    trustedProxies: [],
    corsOrigins: [],
    visitorTokensEnabled: true,
    externalAuthEnabled: false,
  },
  blocks: [],
  csrfTokens: [{ actionId: "console-chat", token: "csrf-token" }],
  skills: { installed: [], available: [], skillsDir: null },
} as unknown as DashboardData;

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "http://localhost:8080/console/chat" },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem() {},
    },
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("ChatWorkspaceProvider persistence", () => {
  it("retries only transient startup hydration failures", () => {
    expect(
      shouldRetryChatHydration(
        new ConsoleChatApiError("Unavailable", { status: 503, code: "unavailable" }),
      ),
    ).toBe(true);
    expect(
      shouldRetryChatHydration(
        new ConsoleChatApiError("Network failure", { status: 0, code: "request-failed" }),
      ),
    ).toBe(true);
    expect(
      shouldRetryChatHydration(
        new ConsoleChatApiError("Unauthorized", { status: 401, code: "request-failed" }),
      ),
    ).toBe(false);
    expect(
      shouldRetryChatHydration(
        new ConsoleChatApiError("Malformed response", {
          status: 200,
          code: "invalid-response",
        }),
      ),
    ).toBe(false);
  });

  it("backs off only the unchanged terminal revision that failed to reconcile", () => {
    const retry = {
      failures: 4,
      retryAt: 10_000,
      failedUpdatedAt: T1,
      failedRunStatus: "error" as const,
    };

    expect(
      shouldDeferDetailReconciliation(retry, { updatedAt: T1, runStatus: "error" }, 1_000),
    ).toBe(true);
    expect(
      shouldDeferDetailReconciliation(retry, { updatedAt: T0, runStatus: "error" }, 1_000),
    ).toBe(false);
    expect(
      shouldDeferDetailReconciliation(retry, { updatedAt: T1, runStatus: "streaming" }, 1_000),
    ).toBe(false);
    expect(
      shouldDeferDetailReconciliation(retry, { updatedAt: T1, runStatus: "error" }, 10_000),
    ).toBe(false);
  });

  it("hydrates summaries and lazily loads the selected transcript", async () => {
    const saved = populatedThread("saved", "Saved chat");
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(saved)] });
      }
      if (path === "/console/api/chat/threads/saved") return json({ thread: saved });
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(saved), unread: false, lastReadAt: T1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    expect(harness.value.hydrationStatus).toBe("ready");
    expect(harness.value.state.threads.map(({ id }) => id)).toEqual(["saved", "id-1"]);
    expect(harness.value.activeThread.messages).toEqual([]);
    await act(async () => {
      expect(await harness.value.loadThread("saved")).toBe(true);
    });
    expect(harness.value.activeThread.messages.map(({ content }) => content)).toEqual([
      "Earlier question",
      "Earlier answer",
    ]);
  });

  it("automatically restores saved chats when the backend becomes available", async () => {
    const saved = populatedThread("saved-after-restart", "Saved before restart");
    let listCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path !== "/console/api/chat/threads") {
        throw new Error(`Unexpected request: ${path}`);
      }
      listCalls++;
      if (listCalls === 1) {
        return json({ error: "Console chat is starting." }, 503);
      }
      return json({ threads: [summary(saved)] });
    });
    const harness = await mountProvider({ fetchImpl });

    expect(harness.value.hydrationStatus).toBe("error");
    expect(harness.value.hydrationError).toMatch(/reconnecting automatically/i);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(harness.value.hydrationStatus).toBe("ready");
    expect(harness.value.hydrationError).toBeNull();
    expect(harness.value.state.threads.map(({ id }) => id)).toEqual([
      "saved-after-restart",
      "id-1",
    ]);
    expect(harness.value.state.activeThreadId).toBe("saved-after-restart");
  });

  it("does not retry a permanently invalid hydration response", async () => {
    let listCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path !== "/console/api/chat/threads") {
        throw new Error(`Unexpected request: ${path}`);
      }
      listCalls++;
      return json({ threads: "not-an-array" });
    });
    const harness = await mountProvider({ fetchImpl });

    expect(harness.value.hydrationStatus).toBe("error");
    expect(harness.value.hydrationError).not.toMatch(/reconnecting automatically/i);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });

    expect(listCalls).toBe(1);
  });

  it("sends stable run/message IDs, generated title, and model, then durably marks an active visible completion read", async () => {
    const initial = createChatWorkspace(
      createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
    );
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let sendReceiver: unknown = "not-called";
    const fetchImpl = mockFetch(
      async (path, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ path, body });
        if (path === "/console/api/chat") return completedSse("draft");
        if (path.endsWith("/read-state")) {
          return json({
            thread: {
              ...summary(populatedThread("draft", "Review auth behavior")),
              unread: false,
              lastReadAt: T1,
            },
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      (receiver, path) => {
        if (path === "/console/api/chat") sendReceiver = receiver;
      },
    );
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      expect(await harness.value.send("  Review   auth behavior  ")).toEqual({ ok: true });
    });

    expect(requests[0]).toEqual({
      path: "/console/api/chat",
      body: {
        csrf: "csrf-token",
        message: "Review   auth behavior",
        threadId: "draft",
        chatMode: "creator",
        title: "Review auth behavior",
        model: { ...MODEL, displayName: MODEL.id },
        runId: "id-1",
        userMessageId: "id-3",
        assistantMessageId: "id-2",
      },
    });
    expect(requests[1]).toMatchObject({
      path: "/console/api/chat/threads/draft/read-state",
      body: { csrf: "csrf-token", unread: false },
    });
    expect(sendReceiver).toBeUndefined();
  });

  it("rolls back optimistic messages and preserves the draft when the server rejects a run", async () => {
    const initial = createChatWorkspace(
      createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
    );
    let accepted = false;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat") {
        return json({ error: "console thread access denied or already running" }, 409);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      const result = await harness.value.send("Keep this draft", undefined, () => {
        accepted = true;
      });
      expect(result.ok).toBe(false);
    });

    expect(accepted).toBe(false);
    expect(harness.value.activeThread.messages).toEqual([]);
    expect(harness.value.activeThread.runStatus).toBe("idle");
    expect(harness.value.activeThread.title).toBe("New chat");
  });

  it("separates assistant text emitted by multiple tool-loop inference segments", async () => {
    const initial = createChatWorkspace(
      createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
    );
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat") return segmentedSse("draft");
      if (path.endsWith("/read-state")) {
        return json({
          thread: {
            ...summary(populatedThread("draft", "Check an order")),
            unread: false,
            lastReadAt: T1,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      expect(await harness.value.send("Check an order")).toEqual({ ok: true });
    });

    expect(harness.value.activeThread.messages.at(-1)?.content).toBe(
      "I'll check the order.\n\nThe address is current.",
    );
  });

  it("preserves an explicit empty-draft rename as the first persisted title", async () => {
    const initial = createChatWorkspace(
      createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
    );
    const sentBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = mockFetch(async (path, init) => {
      if (path === "/console/api/chat") {
        sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return completedSse("draft");
      }
      if (path.endsWith("/read-state")) {
        return json({
          thread: {
            ...summary(populatedThread("draft", "My investigation")),
            unread: false,
            lastReadAt: T1,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      await harness.value.rename("draft", "My investigation");
      expect(await harness.value.send("First prompt")).toEqual({ ok: true });
    });

    expect(sentBodies[0]?.title).toBe("My investigation");
    expect(harness.value.activeThread.title).toBe("My investigation");
  });

  it("persists rename, unread, and delete mutations without changing state on failure", async () => {
    const saved = populatedThread("saved", "Original");
    const initial: ChatWorkspaceState = {
      ...createChatWorkspace(saved),
      threads: [saved],
    };
    const calls: string[] = [];
    let rejectRename = true;
    const fetchImpl = mockFetch(async (path, init) => {
      calls.push(path);
      if (path.endsWith("/rename")) {
        if (rejectRename) {
          rejectRename = false;
          return json({ error: "rename failed" }, 500);
        }
        return json({ thread: { ...summary(saved), title: "Renamed", updatedAt: T1 } });
      }
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(saved), unread: true } });
      }
      if (path.endsWith("/delete")) {
        expect(JSON.parse(String(init?.body))).toEqual({ csrf: "csrf-token" });
        return json({ ok: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await expect(harness.value.rename("saved", "Does not stick")).rejects.toThrow(
      "rename failed",
    );
    expect(harness.value.activeThread.title).toBe("Original");
    await act(async () => {
      await harness.value.rename("saved", "Renamed");
      await harness.value.markUnread("saved");
      expect(await harness.value.deleteThread("saved")).toBe(true);
    });
    expect(calls).toEqual([
      "/console/api/chat/threads/saved/rename",
      "/console/api/chat/threads/saved/rename",
      "/console/api/chat/threads/saved/read-state",
      "/console/api/chat/threads/saved/delete",
    ]);
    expect(harness.value.activeThread.id).not.toBe("saved");
    const fallbackId = harness.value.activeThread.id;
    await act(async () => {
      expect(harness.value.create()).toBe(fallbackId);
    });
  });

  it("prevents a send from claiming a thread while deletion is in flight", async () => {
    const saved = populatedThread("saved", "Saved");
    const deletion = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path.endsWith("/delete")) return deletion.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(saved),
    });

    let deleting!: Promise<boolean>;
    await act(async () => {
      deleting = harness.value.deleteThread("saved");
      await Promise.resolve();
      expect(await harness.value.send("Do not send", "saved")).toEqual({
        ok: false,
        error: "This chat is being deleted.",
      });
    });
    await act(async () => deletion.resolve(json({ ok: true })));
    await act(async () => expect(await deleting).toBe(true));
    expect(harness.value.state.threads.some(({ id }) => id === "saved")).toBe(false);
  });

  it("retains server unread semantics for a background completion", async () => {
    const owner = populatedThread("owner", "Owner");
    const active = populatedThread("active", "Active");
    const initial: ChatWorkspaceState = {
      threads: [owner, active],
      activeThreadId: "active",
      chatVisible: true,
      activeRun: null,
    };
    const calls: string[] = [];
    const fetchImpl = mockFetch(async (path) => {
      calls.push(path);
      if (path === "/console/api/chat") return completedSse("owner");
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      expect(await harness.value.send("Background check", "owner")).toEqual({ ok: true });
    });
    expect(harness.value.state.threads.find(({ id }) => id === "owner")?.unread).toBe(true);
    expect(calls).toEqual(["/console/api/chat"]);
  });

  it("reconciles an externally owned terminal run with detail before leaving streaming state", async () => {
    const partial = {
      ...populatedThread("external", "External run"),
      runStatus: "streaming" as const,
      messages: [
        ...populatedThread("external", "External run").messages,
        {
          id: "external-live-assistant",
          role: "assistant" as const,
          content: "Part",
          createdAt: T0,
          updatedAt: T0,
        },
      ],
    };
    const terminal = {
      ...partial,
      updatedAt: T1,
      runStatus: "complete" as const,
      unread: true,
      messages: partial.messages.map((message) =>
        message.id === "external-live-assistant"
          ? { ...message, content: "Part and final", updatedAt: T1 }
          : message,
      ),
    };
    const terminalDetail = deferred<Response>();
    const calls: string[] = [];
    const fetchImpl = mockFetch(async (path) => {
      calls.push(path);
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(terminal)] });
      }
      if (path === "/console/api/chat/threads/external") return terminalDetail.promise;
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(terminal), unread: false, lastReadAt: T1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(partial),
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(harness.value.activeThread.runStatus).toBe("streaming");
    expect(harness.value.activeThread.messages.at(-1)?.content).toBe("Part");

    await act(async () => terminalDetail.resolve(json({ thread: terminal })));
    expect(harness.value.activeThread.runStatus).toBe("complete");
    expect(harness.value.activeThread.messages.at(-1)?.content).toBe("Part and final");
    expect(harness.value.activeThread.unread).toBe(false);
    expect(calls).toContain("/console/api/chat/threads/external/read-state");
  });

  it("retries terminal error detail after a transient reconciliation failure", async () => {
    const partial = {
      ...populatedThread("failed-external", "Failed external run"),
      runStatus: "streaming" as const,
      messages: [
        ...populatedThread("failed-external", "Failed external run").messages,
        {
          id: "failed-external-live-assistant",
          role: "assistant" as const,
          content: "Partial",
          createdAt: T0,
          updatedAt: T0,
        },
      ],
    };
    const terminal = {
      ...partial,
      updatedAt: T1,
      runStatus: "error" as const,
      unread: true,
      messages: partial.messages.map((message) =>
        message.id === "failed-external-live-assistant"
          ? { ...message, content: "Saved failure detail", error: "Provider failed", updatedAt: T1 }
          : message,
      ),
    };
    let detailCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(terminal)] });
      }
      if (path === "/console/api/chat/threads/failed-external") {
        detailCalls++;
        return detailCalls <= 2
          ? json({ error: "temporary read failure" }, 500)
          : json({ thread: terminal });
      }
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(terminal), unread: false, lastReadAt: T1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(partial),
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(detailCalls).toBe(1);
    expect(harness.value.activeThread.runStatus).toBe("error");
    expect(harness.value.activeThread.messages.at(-1)?.error).toContain("could not be refreshed");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(detailCalls).toBe(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(detailCalls).toBe(2);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(detailCalls).toBeGreaterThanOrEqual(3);
    expect(harness.value.activeThread.messages.at(-1)).toMatchObject({
      content: "Saved failure detail",
      error: "Provider failed",
    });
  });

  it("reconciles cross-tab additions and deletions instead of polling stale navigation", async () => {
    const missing = {
      ...populatedThread("missing", "Deleted elsewhere"),
      runStatus: "streaming" as const,
    };
    const added = populatedThread("added", "Created elsewhere");
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(added)] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(missing),
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(harness.value.activeThread.id).not.toBe("missing");
    expect(harness.value.state.threads.map(({ id }) => id)).toContain("added");
  });

  it("does not let a slow detail response steal selection from a newer deep link", async () => {
    const first = populatedThread("first", "First");
    const second = populatedThread("second", "Second");
    const slow = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(first), summary(second)] });
      }
      if (path === "/console/api/chat/threads/first") return slow.promise;
      if (path === "/console/api/chat/threads/second") return json({ thread: second });
      if (path.endsWith("/read-state")) {
        const source = path.includes("/first/") ? first : second;
        return json({ thread: { ...summary(source), unread: false } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let firstLoad!: Promise<boolean>;
    await act(async () => {
      firstLoad = harness.value.loadThread("first");
      expect(await harness.value.loadThread("second")).toBe(true);
    });
    await act(async () => slow.resolve(json({ thread: first })));
    await act(async () => expect(await firstLoad).toBe(true));
    expect(harness.value.activeThread.id).toBe("second");
  });

  it("does not resurrect a thread deleted while its detail request is in flight", async () => {
    const removed = {
      ...populatedThread("removed", "Deleted elsewhere"),
      runStatus: "streaming" as const,
    };
    const slow = deferred<Response>();
    let listCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        listCalls++;
        return json({ threads: listCalls === 1 ? [summary(removed)] : [] });
      }
      if (path === "/console/api/chat/threads/removed") return slow.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let load!: Promise<boolean>;
    await act(async () => {
      load = harness.value.loadThread("removed");
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(harness.value.state.threads.some(({ id }) => id === "removed")).toBe(false);

    await act(async () => slow.resolve(json({ thread: removed })));
    await act(async () => expect(await load).toBe(false));
    expect(harness.value.state.threads.some(({ id }) => id === "removed")).toBe(false);
  });
});

async function mountProvider(options: {
  fetchImpl: typeof fetch;
  initialState?: ChatWorkspaceState;
}) {
  let value: ChatWorkspaceContextValue | null = null;
  let nextId = 0;
  function Probe() {
    value = useChatWorkspace();
    return null;
  }
  await act(async () => {
    renderer = create(
      <DashboardProvider
        value={{
          data: dashboardData,
          error: null,
          loading: false,
          refresh: async () => {},
          updateData: () => {},
        }}
      >
        <ChatWorkspaceProvider
          initialState={options.initialState}
          fetchImpl={options.fetchImpl}
          createId={() => `id-${++nextId}`}
          now={() => new Date(T1)}
        >
          <Probe />
        </ChatWorkspaceProvider>
      </DashboardProvider>,
    );
  });
  if (!value) throw new Error("Provider did not render");
  return {
    get value(): ChatWorkspaceContextValue {
      if (!value) throw new Error("Provider unmounted");
      return value;
    },
  };
}

function populatedThread(id: string, title: string): ChatThread {
  const user: ChatMessage = {
    id: `${id}-user`,
    role: "user",
    content: "Earlier question",
    createdAt: T0,
    updatedAt: T0,
  };
  const assistant: ChatMessage = {
    id: `${id}-assistant`,
    role: "assistant",
    content: "Earlier answer",
    createdAt: T0,
    updatedAt: T0,
  };
  return {
    ...createChatThread({ id, title, previewMode: "creator", model: MODEL, now: T0 }),
    messages: [user, assistant],
    runStatus: "complete",
  };
}

function summary(thread: ChatThread): Omit<ChatThread, "messages"> {
  const { messages: _messages, ...rest } = thread;
  return rest;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completedSse(threadId: string): Response {
  const body = [
    { type: "TEXT_MESSAGE_CONTENT", messageId: "server", delta: "Done" },
    { type: "RUN_FINISHED", threadId, result: { status: "completed" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function segmentedSse(threadId: string): Response {
  const body = [
    { type: "TEXT_MESSAGE_START", messageId: "segment-one", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "segment-one", delta: "I'll check the order." },
    { type: "TEXT_MESSAGE_END", messageId: "segment-one" },
    { type: "TEXT_MESSAGE_START", messageId: "segment-two", role: "assistant" },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "segment-two",
      delta: "The address is current.",
    },
    { type: "TEXT_MESSAGE_END", messageId: "segment-two" },
    { type: "RUN_FINISHED", threadId, result: { status: "completed" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function mockFetch(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response>,
  observeReceiver?: (receiver: unknown, path: string) => void,
): typeof fetch {
  return (async function (this: unknown, input: URL | RequestInfo, init?: RequestInit) {
    const raw = input instanceof Request ? input.url : String(input);
    const path = new URL(raw, "http://localhost:8080").pathname;
    observeReceiver?.(this, path);
    return handler(path, init);
  }) as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const EXTERNAL_POLL_TEST_WAIT_MS = 850;

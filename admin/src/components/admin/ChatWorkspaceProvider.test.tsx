import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DashboardProvider } from "@/components/admin/DashboardContext";
import {
  ChatWorkspaceProvider,
  shouldDeferDetailReconciliation,
  shouldRetryChatHydration,
  useChatWorkspace,
  type ChatWorkspaceCommandResult,
  type ChatWorkspaceContextValue,
} from "@/components/admin/ChatWorkspaceProvider";
import { ConsoleChatApiError } from "@/lib/console-chat-api";
import {
  createChatThread,
  type ChatMessage,
  type ChatThread,
} from "@/lib/chat-workspace";
import {
  createChatWorkspaceLifecycleState,
  createLocalChatDraft,
  type ChatWorkspaceLifecycleState,
  type DurableChatThreadDetail,
} from "@/lib/chat-workspace-state";
import type { DashboardData } from "@/lib/types";

const T0 = "2026-07-20T10:00:00.000Z";
const T1 = "2026-07-20T10:01:00.000Z";
const MODEL = { id: "claude-sonnet", displayName: "Claude Sonnet", provider: "anthropic" };
const VISITOR_TOKEN_KEY = "auggy-visitor-token";
const VISITOR_PROMOTION_INTENT_KEY = "auggy-visitor-promotion-intent";

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
    expect(harness.value.state.durableThreads.map(({ id }) => id)).toEqual(["saved"]);
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.activeThread).toBeNull();
    await act(async () => {
      expect(await harness.value.loadThread("saved")).toBe(true);
    });
    expect(harness.value.activeThread?.messages.map(({ content }) => content)).toEqual([
      "Earlier question",
      "Earlier answer",
    ]);
  });

  it("creates, reuses, and deletes a pristine draft without a server request", async () => {
    const requests: string[] = [];
    const fetchImpl = mockFetch(async (path) => {
      requests.push(path);
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspaceLifecycleState(),
    });

    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
    let first = "";
    let second = "";
    await act(async () => {
      first = harness.value.create("anonymous");
      second = harness.value.create("creator");
    });
    expect(second).toBe(first);
    expect(harness.value.state.draft).toMatchObject({
      id: first,
      lifecycle: "draft",
      previewMode: "creator",
    });
    expect(harness.value.state.durableThreads).toEqual([]);
    const draftBeforeLoad = harness.value.state.draft;

    await act(async () => {
      expect(await harness.value.loadThread(first)).toBe(false);
    });
    expect(harness.value.state.draft).toBe(draftBeforeLoad);
    expect(harness.value.state.selection).toEqual({ kind: "draft", draftId: first });

    act(() => harness.value.selectWelcome());
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    act(() => expect(harness.value.select(first)).toBe(true));
    expect(harness.value.state.selection).toEqual({ kind: "draft", draftId: first });

    await act(async () => {
      expect(await harness.value.markUnread(first)).toBe(false);
      expect(await harness.value.deleteThread(first)).toEqual({ ok: true });
      expect(await harness.value.deleteThread(first)).toEqual({
        ok: false,
        error: "This chat no longer exists.",
      });
    });
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
    expect(requests).toEqual([]);
  });

  it("deletes an ambiguously durable first-send draft on the server before clearing it", async () => {
    const initial = createDraftWorkspace(
      createChatThread({ id: "ambiguous", previewMode: "creator", model: MODEL, now: T0 }),
    );
    initial.unconfirmedDraftRun = {
      threadId: "ambiguous",
      clientRunId: "run-unknown",
      userMessageId: "user-unknown",
      assistantMessageId: "assistant-unknown",
    };
    const requests: Array<{ path: string; body: unknown }> = [];
    const harness = await mountProvider({
      initialState: initial,
      fetchImpl: mockFetch(async (path, init) => {
        requests.push({
          path,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        if (path === "/console/api/chat/threads/ambiguous/delete") {
          return json({ ok: true });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await act(async () => {
      expect(await harness.value.deleteThread("ambiguous")).toEqual({ ok: true });
    });

    expect(requests).toEqual([
      {
        path: "/console/api/chat/threads/ambiguous/delete",
        body: { csrf: "csrf-token" },
      },
    ]);
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.state.unconfirmedDraftRun).toBeNull();
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
  });

  it("preserves an ambiguously durable draft when its server deletion fails", async () => {
    const initial = createDraftWorkspace(
      createChatThread({ id: "ambiguous", previewMode: "creator", model: MODEL, now: T0 }),
    );
    initial.unconfirmedDraftRun = {
      threadId: "ambiguous",
      clientRunId: "run-unknown",
      userMessageId: "user-unknown",
      assistantMessageId: "assistant-unknown",
    };
    const harness = await mountProvider({
      initialState: initial,
      fetchImpl: mockFetch(async (path, init) => {
        expect(path).toBe("/console/api/chat/threads/ambiguous/delete");
        expect(JSON.parse(String(init?.body))).toEqual({ csrf: "csrf-token" });
        return json({ error: "storage unavailable" }, 503);
      }),
    });
    const draftBeforeDelete = harness.value.state.draft;
    const unconfirmedBeforeDelete = harness.value.state.unconfirmedDraftRun;

    await act(async () => {
      expect(await harness.value.deleteThread("ambiguous")).toEqual({
        ok: false,
        error: "storage unavailable",
      });
    });

    expect(harness.value.state.draft).toBe(draftBeforeDelete);
    expect(harness.value.state.unconfirmedDraftRun).toEqual(unconfirmedBeforeDelete);
    expect(harness.value.state.selection).toEqual({
      kind: "draft",
      draftId: "ambiguous",
    });
  });

  it("removes a recovered first-send identity when detail lands during deletion", async () => {
    const initial = createDraftWorkspace(
      createChatThread({ id: "ambiguous", previewMode: "creator", model: MODEL, now: T0 }),
    );
    initial.unconfirmedDraftRun = {
      threadId: "ambiguous",
      clientRunId: "run-unknown",
      userMessageId: "user-unknown",
      assistantMessageId: "assistant-unknown",
    };
    const persisted = populatedThread("ambiguous", "Recovered first send");
    const recoveredDetail = { ...persisted, updatedAt: T1 };
    const detail = deferred<Response>();
    const deletion = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(persisted)] });
      }
      if (path === "/console/api/chat/threads/ambiguous") return detail.promise;
      if (path === "/console/api/chat/threads/ambiguous/delete") return deletion.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.state.durableThreads).toEqual([
      { ...summary(persisted), lifecycle: "summary" },
    ]);

    let loading!: Promise<boolean>;
    let deleting!: Promise<ChatWorkspaceCommandResult>;
    await act(async () => {
      loading = harness.value.loadThread("ambiguous");
      await Promise.resolve();
      deleting = harness.value.deleteThread("ambiguous");
      await Promise.resolve();
      detail.resolve(json({ thread: recoveredDetail }));
    });
    await act(async () => expect(await loading).toBe(true));
    expect(harness.value.activeThread?.id).toBe("ambiguous");

    await act(async () => deletion.resolve(json({ ok: true })));
    await act(async () => expect(await deleting).toEqual({ ok: true }));
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.state.unconfirmedDraftRun).toBeNull();
    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
  });

  it("returns deterministic refusal reasons for local and external active runs", async () => {
    const external = {
      ...populatedThread("external", "External run"),
      runStatus: "streaming" as const,
    };
    const response = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat") return response.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: workspaceWithDurables([
        populatedThread("local", "Local run"),
        external,
      ], "local"),
    });

    await act(async () => {
      expect(await harness.value.deleteThread("external")).toEqual({
        ok: false,
        error:
          "This response is still running. Wait for it to finish before deleting this chat.",
      });
    });

    let sending!: Promise<ChatWorkspaceCommandResult>;
    await act(async () => {
      sending = harness.value.send("Keep running", "local");
      await Promise.resolve();
      expect(await harness.value.deleteThread("local")).toEqual({
        ok: false,
        error: "Wait for this response to finish or stop it before deleting this chat.",
      });
    });
    await act(async () => response.resolve(completedSse("local")));
    await act(async () => expect(await sending).toEqual({ ok: true }));
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
    expect(harness.value.state.durableThreads.map(({ id }) => id)).toEqual([
      "saved-after-restart",
    ]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
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
    const initial = createDraftWorkspace(
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
      expect(
        await harness.value.send("  Review   auth behavior  ", undefined, () => {
          harness.value.setChatVisible({ kind: "thread", threadId: "draft" });
        }),
      ).toEqual({ ok: true });
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

  it("continues the originating anonymous thread as verified after its token arrives", async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const anonymous = {
      ...populatedThread("verified-origin", "Manage order"),
      previewMode: "anonymous" as const,
    };
    const initial = createChatWorkspace(anonymous);
    let submitted: Record<string, unknown> | undefined;
    let callbackDraftId: string | undefined;
    const fetchImpl = mockFetch(async (path, init) => {
      if (path === "/console/api/chat") {
        submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completedSse(anonymous.id);
      }
      if (path.endsWith("/read-state")) {
        return json({
          thread: { ...summary(anonymous), previewMode: "visitor", lastReadAt: T1 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    storage.set(VISITOR_TOKEN_KEY, "verified.payload.signature");
    storage.set(
      VISITOR_PROMOTION_INTENT_KEY,
      promotionIntent(anonymous.id, "verified.payload.signature"),
    );
    await act(async () => {
      expect(harness.value.refreshVisitorToken()).toBe(true);
      expect(
        await harness.value.send("Done", undefined, () => {
          // Creating from the callback inherits the promoted durable identity.
          // If promotion ran later, this would reuse the anonymous run draft.
          callbackDraftId = harness.value.create();
        }),
      ).toEqual({ ok: true });
    });

    expect(submitted).toMatchObject({
      threadId: anonymous.id,
      chatMode: "visitor",
      visitorToken: "verified.payload.signature",
    });
    expect(callbackDraftId).toBeDefined();
    expect(callbackDraftId).not.toBe(anonymous.id);
    expect(harness.value.state.draft).toMatchObject({
      id: callbackDraftId,
      previewMode: "visitor",
      lifecycle: "draft",
    });
    expect(
      harness.value.state.durableThreads.find(({ id }) => id === anonymous.id),
    ).toMatchObject({ previewMode: "visitor", lifecycle: "detail" });
    expect(harness.value.activeThread?.previewMode).toBe("visitor");
    expect(storage.get(VISITOR_TOKEN_KEY)).toBe("verified.payload.signature");
    expect(storage.has(VISITOR_PROMOTION_INTENT_KEY)).toBe(false);
  });

  it("continues the originating anonymous thread as verified when its token exists at startup", async () => {
    const storage = new Map<string, string>([
      [VISITOR_TOKEN_KEY, "verified.payload.signature"],
      [
        VISITOR_PROMOTION_INTENT_KEY,
        promotionIntent("verified-origin", "verified.payload.signature"),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const anonymous = {
      ...populatedThread("verified-origin", "Manage order"),
      previewMode: "anonymous" as const,
    };
    const initial = createChatWorkspace(anonymous);
    let submitted: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch(async (path, init) => {
      if (path === "/console/api/chat") {
        submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completedSse(anonymous.id);
      }
      if (path.endsWith("/read-state")) {
        return json({
          thread: { ...summary(anonymous), previewMode: "visitor", lastReadAt: T1 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await act(async () => {
      expect(await harness.value.send("Done")).toEqual({ ok: true });
    });

    expect(submitted).toMatchObject({
      threadId: anonymous.id,
      chatMode: "visitor",
      visitorToken: "verified.payload.signature",
    });
    expect(harness.value.activeThread?.previewMode).toBe("visitor");
    expect(storage.has(VISITOR_PROMOTION_INTENT_KEY)).toBe(false);
  });

  it("never promotes a selected anonymous thread that is not the intent origin", async () => {
    const storage = new Map<string, string>([
      [VISITOR_TOKEN_KEY, "verified.payload.signature"],
      [
        VISITOR_PROMOTION_INTENT_KEY,
        promotionIntent("different-origin", "verified.payload.signature"),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const anonymous = {
      ...populatedThread("selected-anonymous", "Unrelated test"),
      previewMode: "anonymous" as const,
    };
    let submitted: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch(async (path, init) => {
      if (path === "/console/api/chat") {
        submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completedSse(anonymous.id);
      }
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(anonymous), lastReadAt: T1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(anonymous),
    });

    await act(async () => {
      expect(await harness.value.send("Keep this anonymous")).toEqual({ ok: true });
    });

    expect(submitted).toMatchObject({
      threadId: anonymous.id,
      chatMode: "anonymous",
    });
    expect(submitted).not.toHaveProperty("visitorToken");
    expect(harness.value.activeThread?.previewMode).toBe("anonymous");
    expect(storage.has(VISITOR_PROMOTION_INTENT_KEY)).toBe(true);
  });

  it("never pairs a stale promotion intent with a newer visitor token", async () => {
    const storage = new Map<string, string>([
      [VISITOR_TOKEN_KEY, "new.payload.signature"],
      [
        VISITOR_PROMOTION_INTENT_KEY,
        promotionIntent("verified-origin", "old.payload.signature"),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const anonymous = {
      ...populatedThread("verified-origin", "Manage order"),
      previewMode: "anonymous" as const,
    };
    let submitted: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch(async (path, init) => {
      if (path === "/console/api/chat") {
        submitted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completedSse(anonymous.id);
      }
      if (path.endsWith("/read-state")) {
        return json({ thread: { ...summary(anonymous), lastReadAt: T1 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(anonymous),
    });

    await act(async () => {
      expect(await harness.value.send("Keep this anonymous")).toEqual({ ok: true });
    });

    expect(submitted).toMatchObject({ chatMode: "anonymous" });
    expect(submitted).not.toHaveProperty("visitorToken");
    expect(harness.value.activeThread?.previewMode).toBe("anonymous");
  });

  it("quarantines an exact promotion intent when the server rejects its proof", async () => {
    const storage = new Map<string, string>([
      [VISITOR_TOKEN_KEY, "verified.payload.signature"],
      [
        VISITOR_PROMOTION_INTENT_KEY,
        promotionIntent("verified-origin", "verified.payload.signature"),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const anonymous = {
      ...populatedThread("verified-origin", "Manage order"),
      previewMode: "anonymous" as const,
    };
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/visitor-identity") {
        return identityResponse("visitor@example.com");
      }
      if (path === "/console/api/chat") {
        return json({ error: "console thread verification does not match" }, 403);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(anonymous),
    });

    await act(async () => {
      expect(await harness.value.send("Done")).toMatchObject({ ok: false });
    });

    expect(storage.has(VISITOR_PROMOTION_INTENT_KEY)).toBe(false);
    expect(harness.value.activeThread?.previewMode).toBe("anonymous");
  });

  it("clears both the compatible visitor token and pending intent on signout", async () => {
    const storage = new Map<string, string>([
      [VISITOR_TOKEN_KEY, "verified.payload.signature"],
      [
        VISITOR_PROMOTION_INTENT_KEY,
        promotionIntent("origin", "verified.payload.signature"),
      ],
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const harness = await mountProvider({
      fetchImpl: mockFetch(async (path) => {
        throw new Error(`Unexpected request: ${path}`);
      }),
      initialState: createDraftWorkspace(
        createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
      ),
    });

    act(() => harness.value.clearVisitor());

    expect(storage.has(VISITOR_TOKEN_KEY)).toBe(false);
    expect(storage.has(VISITOR_PROMOTION_INTENT_KEY)).toBe(false);
    expect(harness.value.hasVisitorToken).toBe(false);
  });

  it("ignores stale identity responses after token rotation and signout", async () => {
    const storage = new Map<string, string>([[VISITOR_TOKEN_KEY, "token-a"]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>();
    const fetchImpl = mockFetch(async (path, init) => {
      if (path !== "/console/api/visitor-identity") {
        throw new Error(`Unexpected request: ${path}`);
      }
      const body = JSON.parse(String(init?.body)) as { visitorToken: string };
      const request = deferred<Response>();
      requests.set(body.visitorToken, request);
      return request.promise;
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createDraftWorkspace(
        createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
      ),
    });

    storage.set(VISITOR_TOKEN_KEY, "token-b");
    await act(async () => {
      harness.value.refreshVisitorToken();
      requests.get("token-b")?.resolve(identityResponse("b@example.com"));
    });
    expect(harness.value.visitorIdentity).toMatchObject({
      status: "verified",
      email: "b@example.com",
    });

    await act(async () => {
      requests.get("token-a")?.resolve(identityResponse("a@example.com"));
    });
    expect(harness.value.visitorIdentity).toMatchObject({
      status: "verified",
      email: "b@example.com",
    });

    storage.set(VISITOR_TOKEN_KEY, "token-c");
    act(() => {
      harness.value.refreshVisitorToken();
      harness.value.clearVisitor();
    });
    await act(async () => {
      requests.get("token-c")?.resolve(identityResponse("c@example.com"));
    });
    expect(harness.value.visitorIdentity).toEqual({ status: "absent" });
  });

  it("validates a stored visitor token when dashboard CSRF arrives after mount", async () => {
    const storage = new Map<string, string>([[VISITOR_TOKEN_KEY, "stored-token"]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    let identityRequests = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/visitor-identity") {
        identityRequests++;
        return identityResponse("stored@example.com");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      dashboard: null,
      initialState: createDraftWorkspace(
        createChatThread({ id: "draft", previewMode: "creator", model: MODEL, now: T0 }),
      ),
    });

    expect(identityRequests).toBe(0);
    expect(harness.value.visitorIdentity).toMatchObject({ status: "unavailable" });

    await act(async () => harness.setDashboard(dashboardData));

    expect(identityRequests).toBe(1);
    expect(harness.value.visitorIdentity).toMatchObject({
      status: "verified",
      email: "stored@example.com",
    });
  });

  it("rolls back optimistic messages and preserves the draft when the server rejects a run", async () => {
    const initial = createDraftWorkspace(
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
    expect(harness.value.activeThread?.messages).toEqual([]);
    expect(harness.value.activeThread?.runStatus).toBe("idle");
    expect(harness.value.activeThread?.title).toBe("New chat");
  });

  it("recovers a first send committed before its HTTP response was lost", async () => {
    const draft = createChatThread({
      id: "uncertain-draft",
      previewMode: "creator",
      model: MODEL,
      now: T0,
    });
    const persisted = populatedThread(draft.id, "Persisted first send");
    let committed = false;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat") {
        committed = true;
        throw new TypeError("connection reset after commit");
      }
      if (path === "/console/api/chat/threads") {
        return json({ threads: committed ? [summary(persisted)] : [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createDraftWorkspace(draft),
    });

    await act(async () => {
      expect(await harness.value.send("Persist this", draft.id)).toEqual({
        ok: false,
        error: "connection reset after commit",
      });
    });
    expect(harness.value.state.draft?.id).toBe(draft.id);
    expect(harness.value.state.unconfirmedDraftRun?.threadId).toBe(draft.id);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });
    expect(harness.value.state.draft).toBeNull();
    expect(harness.value.state.unconfirmedDraftRun).toBeNull();
    expect(harness.value.state.selection).toEqual({
      kind: "thread",
      threadId: draft.id,
    });
    expect(harness.value.state.durableThreads).toEqual([
      { ...summary(persisted), lifecycle: "summary" },
    ]);
  });

  it("separates assistant text emitted by multiple tool-loop inference segments", async () => {
    const initial = createDraftWorkspace(
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

    expect(harness.value.activeThread?.messages.at(-1)?.content).toBe(
      "I'll check the order.\n\nThe address is current.",
    );
  });

  it("preserves an explicit empty-draft rename as the first persisted title", async () => {
    const initial = createDraftWorkspace(
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
    expect(harness.value.activeThread?.title).toBe("My investigation");
  });

  it("persists rename, unread, and delete mutations without changing state on failure", async () => {
    const saved = populatedThread("saved", "Original");
    const initial = createChatWorkspace(saved);
    const calls: string[] = [];
    let rejectRename = true;
    let rejectDelete = true;
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
        if (rejectDelete) {
          rejectDelete = false;
          return json({ error: "delete failed" }, 503);
        }
        return json({ ok: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl, initialState: initial });

    await expect(harness.value.rename("saved", "Does not stick")).rejects.toThrow(
      "rename failed",
    );
    expect(harness.value.activeThread?.title).toBe("Original");
    await act(async () => {
      await harness.value.rename("saved", "Renamed");
      await harness.value.markUnread("saved");
      expect(await harness.value.deleteThread("saved")).toEqual({
        ok: false,
        error: "delete failed",
      });
      expect(harness.value.activeThread?.id).toBe("saved");
      expect(await harness.value.deleteThread("saved")).toEqual({ ok: true });
    });
    expect(calls).toEqual([
      "/console/api/chat/threads/saved/rename",
      "/console/api/chat/threads/saved/rename",
      "/console/api/chat/threads/saved/read-state",
      "/console/api/chat/threads/saved/delete",
      "/console/api/chat/threads/saved/delete",
    ]);
    expect(harness.value.activeThread).toBeNull();
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    let draftId = "";
    await act(async () => {
      draftId = harness.value.create();
    });
    expect(harness.value.activeThread?.id).toBe(draftId);
  });

  it("forgets a tombstoned summary during explicit load and ignores an older detail response", async () => {
    const saved = populatedThread("gone-detail", "Gone detail");
    const staleDetail = deferred<Response>();
    let detailCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(saved)] });
      }
      if (path === "/console/api/chat/threads/gone-detail") {
        detailCalls += 1;
        return detailCalls === 1
          ? staleDetail.promise
          : json({ error: "console thread was deleted" }, 410);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let staleLoad!: Promise<boolean>;
    await act(async () => {
      staleLoad = harness.value.loadThread("gone-detail");
      await Promise.resolve();
      expect(await harness.value.loadThread("gone-detail")).toBe(false);
    });
    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });

    await act(async () => staleDetail.resolve(json({ thread: saved })));
    await act(async () => expect(await staleLoad).toBe(false));
    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.activeThread).toBeNull();
  });

  it("forgets a loaded thread when polling detail reports its tombstone", async () => {
    const local = {
      ...populatedThread("gone-poll", "Gone while polling"),
      runStatus: "streaming" as const,
    };
    const terminalSummary = {
      ...summary(local),
      updatedAt: T1,
      runStatus: "complete" as const,
    };
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [terminalSummary] });
      }
      if (path === "/console/api/chat/threads/gone-poll") {
        return json({ error: "console thread was deleted" }, 410);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(local),
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_TEST_WAIT_MS));
    });

    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
  });

  it("cleans durable identities when rename and read-state report tombstones", async () => {
    const renameTarget = populatedThread("gone-rename", "Rename target");
    const unreadTarget = populatedThread("gone-unread", "Unread target");
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = mockFetch(async (path, init) => {
      requests.push({
        path,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      if (path.endsWith("/rename") || path.endsWith("/read-state")) {
        return json({ error: "console thread was deleted" }, 410);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: workspaceWithDurables([renameTarget, unreadTarget], renameTarget.id),
    });

    await act(async () => {
      await expect(harness.value.rename(renameTarget.id, "Never applied")).rejects.toThrow(
        "console thread was deleted",
      );
      await expect(harness.value.markUnread(unreadTarget.id)).rejects.toThrow(
        "console thread was deleted",
      );
    });

    expect(requests).toEqual([
      {
        path: "/console/api/chat/threads/gone-rename/rename",
        body: { csrf: "csrf-token", title: "Never applied" },
      },
      {
        path: "/console/api/chat/threads/gone-unread/read-state",
        body: { csrf: "csrf-token", unread: true },
      },
    ]);
    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(await harness.value.send("Cannot reuse", renameTarget.id)).toEqual({
      ok: false,
      error: "This chat no longer exists.",
    });
    expect(await harness.value.send("Cannot reuse", unreadTarget.id)).toEqual({
      ok: false,
      error: "This chat no longer exists.",
    });
    expect(requests).toHaveLength(2);
  });

  it("rolls back a tombstoned send without resurrecting its durable identity", async () => {
    const saved = populatedThread("gone-send", "Gone send");
    let sendCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat") {
        sendCalls += 1;
        return json({ error: "console thread was deleted" }, 410);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({
      fetchImpl,
      initialState: createChatWorkspace(saved),
    });

    await act(async () => {
      expect(await harness.value.send("Do not restore me", saved.id)).toMatchObject({
        ok: false,
      });
    });

    expect(sendCalls).toBe(1);
    expect(harness.value.state.activeRun).toBeNull();
    expect(harness.value.state.durableThreads).toEqual([]);
    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
    expect(await harness.value.send("Try again", saved.id)).toEqual({
      ok: false,
      error: "This chat no longer exists.",
    });
    expect(sendCalls).toBe(1);
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

    let deleting!: Promise<ChatWorkspaceCommandResult>;
    await act(async () => {
      deleting = harness.value.deleteThread("saved");
      await Promise.resolve();
      expect(await harness.value.send("Do not send", "saved")).toEqual({
        ok: false,
        error: "This chat is being deleted.",
      });
      expect(await harness.value.deleteThread("saved")).toEqual({
        ok: false,
        error: "This chat is already being deleted.",
      });
    });
    await act(async () => deletion.resolve(json({ ok: true })));
    await act(async () => expect(await deleting).toEqual({ ok: true }));
    expect(harness.value.state.durableThreads.some(({ id }) => id === "saved")).toBe(false);
  });

  it("retains server unread semantics for a background completion", async () => {
    const owner = populatedThread("owner", "Owner");
    const active = populatedThread("active", "Active");
    const initial = workspaceWithDurables([owner, active], "active");
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
    expect(harness.value.state.durableThreads.find(({ id }) => id === "owner")?.unread).toBe(
      true,
    );
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
    expect(harness.value.activeThread?.runStatus).toBe("streaming");
    expect(harness.value.activeThread?.messages.at(-1)?.content).toBe("Part");

    await act(async () => terminalDetail.resolve(json({ thread: terminal })));
    expect(harness.value.activeThread?.runStatus).toBe("complete");
    expect(harness.value.activeThread?.messages.at(-1)?.content).toBe("Part and final");
    expect(harness.value.activeThread?.unread).toBe(false);
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
    expect(harness.value.activeThread?.runStatus).toBe("error");
    expect(
      harness.value.activeThread && "detailError" in harness.value.activeThread
        ? harness.value.activeThread.detailError
        : null,
    ).toContain("could not be refreshed");

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
    expect(harness.value.activeThread?.messages.at(-1)).toMatchObject({
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
    expect(harness.value.activeThread?.id).not.toBe("missing");
    expect(harness.value.state.durableThreads.map(({ id }) => id)).toContain("added");
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
    expect(harness.value.activeThread?.id).toBe("second");
  });

  it("does not let a slow durable detail steal selection from a new draft route", async () => {
    const saved = populatedThread("saved", "Saved");
    const slow = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(saved)] });
      }
      if (path === "/console/api/chat/threads/saved") return slow.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let load!: Promise<boolean>;
    let draftId = "";
    await act(async () => {
      load = harness.value.loadThread("saved");
      draftId = harness.value.create();
    });
    await act(async () => slow.resolve(json({ thread: saved })));
    await act(async () => expect(await load).toBe(true));

    expect(harness.value.state.selection).toEqual({ kind: "draft", draftId });
    expect(harness.value.activeThread?.id).toBe(draftId);
  });

  it("keeps the welcome route authoritative over a delayed detail load", async () => {
    const saved = populatedThread("saved", "Saved");
    const slow = deferred<Response>();
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(saved)] });
      }
      if (path === "/console/api/chat/threads/saved") return slow.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let load!: Promise<boolean>;
    await act(async () => {
      load = harness.value.loadThread("saved");
      harness.value.selectWelcome();
    });
    await act(async () => slow.resolve(json({ thread: saved })));
    await act(async () => expect(await load).toBe(true));

    expect(harness.value.state.selection).toEqual({ kind: "welcome" });
    expect(harness.value.activeThread).toBeNull();
  });

  it("refetches detail instead of masking a newer revision with a delayed transcript", async () => {
    const saved = populatedThread("saved", "Original");
    const staleDetail = deferred<Response>();
    const fresh = {
      ...saved,
      title: "Renamed",
      updatedAt: T1,
      messages: saved.messages.map((message) =>
        message.role === "assistant"
          ? { ...message, content: "Fresh answer", updatedAt: T1 }
          : message,
      ),
    };
    let detailCalls = 0;
    const fetchImpl = mockFetch(async (path) => {
      if (path === "/console/api/chat/threads") {
        return json({ threads: [summary(saved)] });
      }
      if (path === "/console/api/chat/threads/saved") {
        detailCalls++;
        return detailCalls === 1 ? staleDetail.promise : json({ thread: fresh });
      }
      if (path.endsWith("/rename")) {
        return json({ thread: summary(fresh) });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const harness = await mountProvider({ fetchImpl });

    let load!: Promise<boolean>;
    await act(async () => {
      load = harness.value.loadThread("saved");
      await Promise.resolve();
      await harness.value.rename("saved", "Renamed");
    });
    await act(async () => staleDetail.resolve(json({ thread: saved })));
    await act(async () => expect(await load).toBe(true));

    expect(detailCalls).toBe(2);
    expect(harness.value.activeThread).toMatchObject({
      id: "saved",
      title: "Renamed",
      updatedAt: T1,
    });
    expect(harness.value.activeThread?.messages.at(-1)?.content).toBe("Fresh answer");
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
    expect(harness.value.state.durableThreads.some(({ id }) => id === "removed")).toBe(false);

    await act(async () => slow.resolve(json({ thread: removed })));
    await act(async () => expect(await load).toBe(false));
    expect(harness.value.state.durableThreads.some(({ id }) => id === "removed")).toBe(false);
  });
});

async function mountProvider(options: {
  fetchImpl: typeof fetch;
  initialState?: ChatWorkspaceLifecycleState;
  dashboard?: DashboardData | null;
}) {
  let value: ChatWorkspaceContextValue | null = null;
  let setDashboard!: (data: DashboardData | null) => void;
  let nextId = 0;
  function Probe() {
    value = useChatWorkspace();
    return null;
  }
  function DashboardHarness({ children }: { children: ReactNode }) {
    const [data, setData] = useState<DashboardData | null>(
      options.dashboard === undefined ? dashboardData : options.dashboard,
    );
    setDashboard = setData;
    return (
      <DashboardProvider
        value={{
          data,
          error: null,
          loading: data === null,
          refresh: async () => {},
          updateData: () => {},
        }}
      >
        {children}
      </DashboardProvider>
    );
  }
  await act(async () => {
    renderer = create(
      <DashboardHarness>
        <ChatWorkspaceProvider
          initialState={options.initialState}
          fetchImpl={options.fetchImpl}
          createId={() => `id-${++nextId}`}
          now={() => new Date(T1)}
        >
          <Probe />
        </ChatWorkspaceProvider>
      </DashboardHarness>,
    );
  });
  if (!value) throw new Error("Provider did not render");
  return {
    get value(): ChatWorkspaceContextValue {
      if (!value) throw new Error("Provider unmounted");
      return value;
    },
    setDashboard,
  };
}

function createDraftWorkspace(thread: ChatThread): ChatWorkspaceLifecycleState {
  const initial = createChatWorkspaceLifecycleState();
  const draft = {
    ...createLocalChatDraft({
      id: thread.id,
      previewMode: thread.previewMode,
      model: thread.model,
      now: thread.createdAt,
      ...(thread.title === "New chat" ? {} : { title: thread.title }),
    }),
    ...thread,
    lifecycle: "draft" as const,
    titleSource: thread.title === "New chat" ? ("default" as const) : ("explicit" as const),
  };
  return {
    ...initial,
    draft,
    selection: { kind: "draft", draftId: draft.id },
    chatVisible: true,
    visibleTarget: { kind: "draft", draftId: draft.id },
  };
}

function createChatWorkspace(thread: ChatThread): ChatWorkspaceLifecycleState {
  return workspaceWithDurables([thread], thread.id);
}

function workspaceWithDurables(
  threads: readonly ChatThread[],
  selectedThreadId?: string,
): ChatWorkspaceLifecycleState {
  const initial = createChatWorkspaceLifecycleState();
  const durableThreads: DurableChatThreadDetail[] = threads.map((thread) => ({
    ...thread,
    lifecycle: "detail",
    detailError: null,
  }));
  return {
    ...initial,
    durableThreads,
    ...(selectedThreadId
      ? {
          selection: { kind: "thread" as const, threadId: selectedThreadId },
          chatVisible: true,
          visibleTarget: { kind: "thread" as const, threadId: selectedThreadId },
        }
      : {}),
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

function identityResponse(email: string): Response {
  return json({
    identity: {
      status: "verified",
      email,
      expiresAt: Date.now() + 60_000,
    },
  });
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

function promotionIntent(threadId: string, visitorToken: string): string {
  return JSON.stringify({
    type: "visitor-auth.verified",
    version: 1,
    threadId,
    tokenTag: testVisitorTokenTag(visitorToken),
  });
}

function testVisitorTokenTag(token: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const EXTERNAL_POLL_TEST_WAIT_MS = 850;

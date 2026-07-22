import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { StrictMode, Suspense } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  createMemoryRouter,
  RouterProvider,
  type RouterState,
} from "react-router-dom";

import { ChatComposer } from "@/components/admin/ChatComposer";
import { DashboardProvider } from "@/components/admin/DashboardContext";
import { ChatThreadHeader } from "@/components/admin/ChatThreadHeader";
import {
  ChatWorkspaceProvider,
  type ChatWorkspaceContextValue,
  useChatWorkspace,
} from "@/components/admin/ChatWorkspaceProvider";
import { CHAT_WELCOME_PATH, chatThreadPath } from "@/lib/chat-route";
import { createChatThread, type ChatThread } from "@/lib/chat-workspace";
import { ToastProvider } from "@/lib/toast";
import type { DashboardData } from "@/lib/types";
import { ChatRoute } from "./ChatRoute";

const NOW = "2026-07-22T10:00:00.000Z";
const MODEL = {
  id: "claude-sonnet",
  displayName: "Claude Sonnet",
  provider: "anthropic",
};

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

interface LocationTransition {
  action: RouterState["historyAction"];
  key: string;
  pathname: string;
}

const mountedRenderers = new Set<ReactTestRenderer>();
const disposers = new Set<() => void>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class TestElement {}
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: TestElement,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "http://localhost:8080/console/chat/new",
        reload() {},
      },
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
      getComputedStyle: () => ({ direction: "ltr" }),
      Element: TestElement,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: null,
      hidden: false,
      documentElement: { getAttribute: () => null },
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
  const pendingDisposers = [...disposers];
  disposers.clear();
  const renderers = [...mountedRenderers];
  mountedRenderers.clear();
  if (renderers.length > 0) {
    await act(async () => {
      for (const renderer of renderers) renderer.unmount();
    });
  }
  for (const dispose of pendingDisposers) dispose();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "Element");
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("ChatRoute lifecycle acceptance", () => {
  it("creates one Strict Mode draft and replaces it with welcome once after deletion", async () => {
    const requests: string[] = [];
    const harness = await mountChatRoute({
      createIds: ["draft-one"],
      fetchImpl: mockFetch(async (path) => {
        requests.push(path);
        if (path === "/console/api/chat/threads") return json({ threads: [] });
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await waitForCondition(
      () => harness.renderer.root.findAllByType(ChatThreadHeader).length === 1,
      "the draft route to render",
    );
    expect(harness.workspace.activeThread?.id).toBe("draft-one");
    expect(harness.idAllocations()).toBe(1);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((path) => path === "/console/api/chat/threads")).toBe(true);
    const requestsBeforeDelete = requests.length;
    harness.transitions.length = 0;

    const header = harness.renderer.root.findByType(ChatThreadHeader);
    await act(async () => {
      await header.props.onDelete();
    });
    await waitForCondition(
      () => harness.router.state.location.pathname === CHAT_WELCOME_PATH,
      "the deleted draft route to settle at welcome",
    );
    await act(async () => Promise.resolve());

    expect(harness.workspace.state.draft).toBeNull();
    expect(harness.workspace.state.selection).toEqual({ kind: "welcome" });
    expect(harness.idAllocations()).toBe(1);
    expect(requests).toHaveLength(requestsBeforeDelete);
    expect(uniqueTransitions(harness.transitions)).toEqual([
      expect.objectContaining({ action: "REPLACE", pathname: CHAT_WELCOME_PATH }),
    ]);
    expect(harness.workspace.state.draft).toBeNull();
  });

  it("promotes the exact draft and replaces its route once after acceptance", async () => {
    const draftId = "draft/with spaces";
    const harness = await mountChatRoute({
      createIds: [draftId, "run-one", "assistant-one", "user-one"],
      fetchImpl: mockFetch(async (path) => {
        if (path === "/console/api/chat/threads") return json({ threads: [] });
        if (path === "/console/api/chat") return completedSse(draftId);
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await waitForCondition(
      () => harness.renderer.root.findAllByType(ChatComposer).length === 1,
      "the exact draft to render",
    );
    harness.transitions.length = 0;
    const composer = harness.renderer.root.findByType(ChatComposer);
    act(() => composer.props.onChange("Investigate this conversation"));
    act(() => composer.props.onSend());

    const durablePath = chatThreadPath(draftId);
    await waitForCondition(
      () => harness.router.state.location.pathname === durablePath,
      "the accepted draft to receive its durable route",
    );
    await waitForCondition(
      () => harness.workspace.state.activeRun === null,
      "the accepted stream to finish",
    );
    await act(async () => Promise.resolve());

    expect(harness.workspace.state.draft).toBeNull();
    expect(harness.workspace.state.selection).toEqual({
      kind: "thread",
      threadId: draftId,
    });
    expect(harness.workspace.state.durableThreads).toHaveLength(1);
    expect(harness.workspace.state.durableThreads[0]).toMatchObject({
      id: draftId,
      lifecycle: "detail",
      runStatus: "complete",
    });
    expect(uniqueTransitions(harness.transitions)).toEqual([
      expect.objectContaining({ action: "REPLACE", pathname: durablePath }),
    ]);
  });

  it("never lets a late accepted send replace a newer route entry", async () => {
    const draftId = "draft-stale";
    const response = deferred<Response>();
    let sendStarted = false;
    const harness = await mountChatRoute({
      createIds: [draftId, "run-stale", "assistant-stale", "user-stale"],
      fetchImpl: mockFetch(async (path) => {
        if (path === "/console/api/chat/threads") return json({ threads: [] });
        if (path === "/console/api/chat") {
          sendStarted = true;
          return response.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await waitForCondition(
      () => harness.renderer.root.findAllByType(ChatComposer).length === 1,
      "the stale-send draft to render",
    );
    const composer = harness.renderer.root.findByType(ChatComposer);
    act(() => composer.props.onChange("Finish after I leave"));
    act(() => composer.props.onSend());
    await waitForCondition(() => sendStarted, "the deferred send to start");

    await act(async () => {
      await harness.router.navigate("/elsewhere");
    });
    const newerLocation = harness.router.state.location;
    harness.transitions.length = 0;
    await act(async () => {
      response.resolve(completedSse(draftId));
      await response.promise;
    });
    await waitForCondition(
      () =>
        harness.workspace.state.draft === null &&
        harness.workspace.state.activeRun === null &&
        harness.workspace.state.durableThreads.some(({ id }) => id === draftId),
      "the background send to become durable",
    );
    await act(async () => Promise.resolve());

    expect(harness.router.state.location).toMatchObject({
      key: newerLocation.key,
      pathname: "/elsewhere",
    });
    expect(harness.workspace.state.durableThreads[0]).toMatchObject({
      id: draftId,
      runStatus: "complete",
    });
    expect(uniqueTransitions(harness.transitions)).toEqual([]);
  });

  it("keeps a newer draft route authoritative when an older delete finishes", async () => {
    const saved = createChatThread({
      id: "saved",
      title: "Saved conversation",
      previewMode: "creator",
      model: MODEL,
      now: NOW,
    });
    const deletion = deferred<Response>();
    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    let deleteStarted = false;
    const harness = await mountChatRoute({
      initialEntry: chatThreadPath(saved.id),
      createIds: ["newer-draft"],
      fetchImpl: mockFetch(async (path, init) => {
        const method = init?.method ?? "GET";
        requests.push({
          path,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (path === "/console/api/chat/threads") {
          return json({ threads: [summary(saved)] });
        }
        if (path === "/console/api/chat/threads/saved") {
          return json({ thread: saved });
        }
        if (path === "/console/api/chat/threads/saved/delete") {
          deleteStarted = true;
          return deletion.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await waitForCondition(
      () =>
        harness.workspace.activeThread?.id === saved.id &&
        harness.renderer.root.findAllByType(ChatThreadHeader).length === 1,
      "the saved detail route to render",
    );
    expect(requests.some(({ path }) => path === "/console/api/chat/threads")).toBe(true);
    expect(
      requests.some(({ path }) => path === "/console/api/chat/threads/saved"),
    ).toBe(true);

    const savedHeader = harness.renderer.root.findByType(ChatThreadHeader);
    let deleting!: Promise<void>;
    act(() => {
      deleting = Promise.resolve(savedHeader.props.onDelete());
    });
    await waitForCondition(() => deleteStarted, "the saved deletion to start");

    await act(async () => {
      await harness.router.navigate("/chat/new");
    });
    await waitForCondition(
      () =>
        harness.workspace.state.draft?.id === "newer-draft" &&
        harness.workspace.state.selection.kind === "draft" &&
        harness.renderer.root.findAllByType(ChatThreadHeader).length === 1,
      "the newer draft route to take ownership",
    );
    const newerLocation = harness.router.state.location;
    harness.transitions.length = 0;

    await act(async () => {
      deletion.resolve(json({ ok: true }));
      await deleting;
    });
    await waitForCondition(
      () =>
        !harness.workspace.state.durableThreads.some(({ id }) => id === saved.id),
      "the saved identity to be removed",
    );
    await act(async () => Promise.resolve());

    expect(
      requests.filter(({ path }) => path === "/console/api/chat/threads/saved/delete"),
    ).toEqual([
      {
        path: "/console/api/chat/threads/saved/delete",
        method: "POST",
        body: { csrf: "csrf-token" },
      },
    ]);
    expect(harness.router.state.location).toMatchObject({
      key: newerLocation.key,
      pathname: "/chat/new",
    });
    expect(harness.workspace.state.draft?.id).toBe("newer-draft");
    expect(harness.workspace.state.selection).toEqual({
      kind: "draft",
      draftId: "newer-draft",
    });
    expect(harness.workspace.activeThread?.id).toBe("newer-draft");
    expect(harness.transitions).toEqual([]);
  });

  it("replaces a tombstoned deep link with welcome exactly once", async () => {
    const gone = createChatThread({
      id: "gone",
      title: "Deleted elsewhere",
      previewMode: "creator",
      model: MODEL,
      now: NOW,
    });
    const releaseDetail = deferred<void>();
    let detailCalls = 0;
    const harness = await mountChatRoute({
      initialEntry: chatThreadPath(gone.id),
      createIds: [],
      fetchImpl: mockFetch(async (path) => {
        if (path === "/console/api/chat/threads") {
          return json({ threads: [summary(gone)] });
        }
        if (path === "/console/api/chat/threads/gone") {
          detailCalls++;
          await releaseDetail.promise;
          return json({ error: "thread was deleted" }, 410);
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    });

    await waitForCondition(() => detailCalls > 0, "the tombstoned detail load to start");
    expect(harness.workspace.state.durableThreads.map(({ id }) => id)).toContain(gone.id);
    expect(harness.idAllocations()).toBe(0);
    expect(harness.renderer.root.findAllByType(ChatThreadHeader)).toHaveLength(0);
    harness.transitions.length = 0;

    await act(async () => {
      releaseDetail.resolve();
      await releaseDetail.promise;
    });
    await waitForCondition(
      () =>
        harness.router.state.location.pathname === CHAT_WELCOME_PATH &&
        !harness.workspace.state.durableThreads.some(({ id }) => id === gone.id),
      "the tombstoned route to recover to welcome",
    );
    await act(async () => Promise.resolve());

    expect(detailCalls).toBeGreaterThanOrEqual(1);
    expect(harness.workspace.state.selection).toEqual({ kind: "welcome" });
    expect(harness.workspace.state.draft).toBeNull();
    expect(harness.workspace.activeThread).toBeNull();
    expect(harness.idAllocations()).toBe(0);
    expect(harness.renderer.root.findAllByType(ChatThreadHeader)).toHaveLength(0);
    expect(uniqueTransitions(harness.transitions)).toEqual([
      expect.objectContaining({ action: "REPLACE", pathname: CHAT_WELCOME_PATH }),
    ]);
  });
});

async function mountChatRoute(options: {
  createIds: readonly string[];
  fetchImpl: typeof fetch;
  initialEntry?: string;
}) {
  let workspace: ChatWorkspaceContextValue | null = null;
  let idAllocationCount = 0;
  function WorkspaceProbe() {
    workspace = useChatWorkspace();
    return null;
  }
  const router = createMemoryRouter(
    [
      {
        path: "/chat",
        element: (
          <Suspense fallback={null}>
            <ChatRoute />
          </Suspense>
        ),
      },
      {
        path: "/chat/new",
        element: (
          <Suspense fallback={null}>
            <ChatRoute />
          </Suspense>
        ),
      },
      {
        path: "/chat/:threadId",
        element: (
          <Suspense fallback={null}>
            <ChatRoute />
          </Suspense>
        ),
      },
      { path: "/elsewhere", element: <div>Elsewhere</div> },
    ],
    { initialEntries: [options.initialEntry ?? "/chat/new"] },
  );
  const transitions: LocationTransition[] = [];
  const unsubscribe = router.subscribe((state) => {
    transitions.push({
      action: state.historyAction,
      key: state.location.key,
      pathname: state.location.pathname,
    });
  });
  disposers.add(() => {
    unsubscribe();
    router.dispose();
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <DashboardProvider
          value={{
            data: dashboardData,
            error: null,
            loading: false,
            refresh: async () => {},
            updateData: () => {},
          }}
        >
          <ToastProvider>
            <ChatWorkspaceProvider
              fetchImpl={options.fetchImpl}
              createId={() => {
                const id = options.createIds[idAllocationCount];
                idAllocationCount++;
                if (!id) throw new Error(`Unexpected ID allocation ${idAllocationCount}`);
                return id;
              }}
              now={() => new Date(NOW)}
            >
              <WorkspaceProbe />
              <RouterProvider router={router} />
            </ChatWorkspaceProvider>
          </ToastProvider>
        </DashboardProvider>
      </StrictMode>,
    );
    mountedRenderers.add(renderer);
  });
  if (!workspace) throw new Error("Workspace provider did not render");
  return {
    renderer,
    router,
    transitions,
    idAllocations: () => idAllocationCount,
    get workspace(): ChatWorkspaceContextValue {
      if (!workspace) throw new Error("Workspace provider unmounted");
      return workspace;
    },
  };
}

function uniqueTransitions(transitions: readonly LocationTransition[]): LocationTransition[] {
  const seen = new Set<string>();
  return transitions.filter(({ key, pathname }) => {
    const identity = `${key}\u0000${pathname}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
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

function summary(thread: ChatThread): Omit<ChatThread, "messages"> {
  const { messages: _messages, ...value } = thread;
  return value;
}

function mockFetch(
  handler: (path: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    return handler(new URL(raw, "http://localhost:8080").pathname, init);
  }) as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

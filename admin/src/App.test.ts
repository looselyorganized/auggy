import { describe, expect, it } from "bun:test";

import {
  CHAT_DRAFT_PATH,
  CHAT_WELCOME_PATH,
  chatThreadPath,
  decodeChatThreadRouteParam,
  getChatNavigationState,
  getVisibleChatWorkspaceTarget,
  parseChatRouteTarget,
} from "@/lib/chat-route";
import { createChatThread } from "@/lib/chat-workspace";
import type { DurableChatThreadSummary } from "@/lib/chat-workspace-state";
import {
  getMissingOwnedDraftNavigationPath,
  shouldReplaceSidebarDeletedChatWithWelcome,
} from "./App";

function thread(
  id: string,
  title: string,
  patch: Partial<DurableChatThreadSummary> = {},
): DurableChatThreadSummary {
  const { messages: _messages, ...summary } = createChatThread({
    id,
    title,
    previewMode: "creator",
    now: "2026-07-20T10:00:00.000Z",
  });
  return { ...summary, lifecycle: "summary", ...patch };
}

describe("console chat route parsing", () => {
  it("assigns distinct authority to welcome and the one local draft", () => {
    expect(parseChatRouteTarget(CHAT_WELCOME_PATH)).toEqual({ kind: "welcome" });
    expect(parseChatRouteTarget(`${CHAT_WELCOME_PATH}/`)).toEqual({ kind: "welcome" });
    expect(parseChatRouteTarget(CHAT_DRAFT_PATH)).toEqual({ kind: "draft" });
    expect(parseChatRouteTarget(`${CHAT_DRAFT_PATH}/`)).toEqual({ kind: "draft" });
  });

  it("round-trips a durable ID that matches the reserved draft segment", () => {
    expect(chatThreadPath("new")).toBe("/chat/%6Eew");
    expect(parseChatRouteTarget(chatThreadPath("new"))).toEqual({
      kind: "thread",
      threadId: "new",
    });
  });

  it("keeps an encoded durable identifier inside one route segment", () => {
    const path = chatThreadPath("owner:debug/chat?one");
    expect(path).toBe("/chat/owner%3Adebug%2Fchat%3Fone");
    expect(parseChatRouteTarget(path)).toEqual({
      kind: "thread",
      threadId: "owner:debug/chat?one",
    });
    expect(decodeChatThreadRouteParam("owner%3Adebug%2Fchat%3Fone")).toBe(
      "owner:debug/chat?one",
    );
  });

  it("fails closed outside exact chat paths", () => {
    for (const pathname of [
      "/",
      "/integrations",
      "/chats",
      "/chatty",
      "/chat//",
      "/chat/new/extra",
      "/chat/thread/extra",
    ]) {
      expect(parseChatRouteTarget(pathname)).toEqual({ kind: "outside" });
    }
  });

  it("preserves a malformed durable encoding without throwing", () => {
    expect(parseChatRouteTarget("/chat/bad%thread")).toEqual({
      kind: "thread",
      threadId: "bad%thread",
    });
  });
});

describe("console chat route visibility", () => {
  it("proves visibility only for the exact durable route selection", () => {
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "thread", threadId: "requested" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "thread", threadId: "fallback" },
      }),
    ).toBeNull();
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "thread", threadId: "requested" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "thread", threadId: "requested" },
      }),
    ).toEqual({ kind: "thread", threadId: "requested" });
  });

  it("proves draft visibility against the exact locally-owned draft", () => {
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "draft" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "draft", draftId: "stale-draft" },
      }),
    ).toBeNull();
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "draft" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "draft", draftId: "draft" },
      }),
    ).toEqual({ kind: "draft", draftId: "draft" });
  });

  it("never proves visibility for welcome, outside paths, or a background tab", () => {
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "welcome" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "thread", threadId: "saved" },
      }),
    ).toBeNull();
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "outside" },
        documentVisible: true,
        localDraftId: "draft",
        selection: { kind: "draft", draftId: "draft" },
      }),
    ).toBeNull();
    expect(
      getVisibleChatWorkspaceTarget({
        route: { kind: "thread", threadId: "saved" },
        documentVisible: false,
        localDraftId: null,
        selection: { kind: "thread", threadId: "saved" },
      }),
    ).toBeNull();
  });
});

describe("console chat navigation", () => {
  it("never activates a durable row on welcome or draft routes", () => {
    const saved = thread("saved", "Saved investigation");
    expect(
      getChatNavigationState({
        threads: [saved],
        route: { kind: "welcome" },
        selection: { kind: "welcome" },
      }).activeId,
    ).toBe("");
    expect(
      getChatNavigationState({
        threads: [saved],
        route: { kind: "draft" },
        selection: { kind: "draft", draftId: "draft" },
      }).activeId,
    ).toBe("");
  });

  it("activates only the exact routed durable chat and sorts canonical summaries", () => {
    const first = thread("first", "First", {
      updatedAt: "2026-07-20T10:01:00.000Z",
    });
    const second = thread("second", "Second", {
      updatedAt: "2026-07-20T10:02:00.000Z",
    });

    expect(
      getChatNavigationState({
        threads: [first, second],
        route: { kind: "thread", threadId: second.id },
        selection: { kind: "thread", threadId: second.id },
      }),
    ).toMatchObject({ activeId: second.id, threads: [second, first] });
    expect(
      getChatNavigationState({
        threads: [first, second],
        route: { kind: "thread", threadId: second.id },
        selection: { kind: "thread", threadId: first.id },
      }).activeId,
    ).toBe("");
    expect(
      getChatNavigationState({
        threads: [first, second],
        route: { kind: "outside" },
        selection: { kind: "thread", threadId: second.id },
      }).activeId,
    ).toBe("");
  });
});

describe("sidebar delete navigation", () => {
  const current = {
    deletedThreadId: "selected",
    routeAtStart: { kind: "thread", threadId: "selected" } as const,
    startedLocationKey: "route-1",
    currentLocationKey: "route-1",
    startedPathname: "/chat/selected",
    currentPathname: "/chat/selected",
  };

  it("replaces the unchanged selected durable route with welcome", () => {
    expect(shouldReplaceSidebarDeletedChatWithWelcome(current)).toBe(true);
  });

  it("preserves the current route when deleting a background durable row", () => {
    expect(
      shouldReplaceSidebarDeletedChatWithWelcome({
        ...current,
        deletedThreadId: "background",
      }),
    ).toBe(false);
    expect(
      shouldReplaceSidebarDeletedChatWithWelcome({
        ...current,
        routeAtStart: { kind: "draft" },
        deletedThreadId: "background",
        startedPathname: "/chat/new",
        currentPathname: "/chat/new",
      }),
    ).toBe(false);
  });

  it("does not redirect a late completion after navigation", () => {
    expect(
      shouldReplaceSidebarDeletedChatWithWelcome({
        ...current,
        currentLocationKey: "route-2",
        currentPathname: "/capabilities",
      }),
    ).toBe(false);
    expect(
      shouldReplaceSidebarDeletedChatWithWelcome({
        ...current,
        currentLocationKey: "route-3",
      }),
    ).toBe(false);
  });
});

describe("owned draft route transitions", () => {
  it("moves an accepted draft to its exact durable route", () => {
    expect(
      getMissingOwnedDraftNavigationPath("draft/one", {
        kind: "thread",
        threadId: "draft/one",
      }),
    ).toBe("/chat/draft%2Fone");
  });

  it("moves a deleted draft to welcome", () => {
    expect(
      getMissingOwnedDraftNavigationPath("draft", { kind: "welcome" }),
    ).toBe(CHAT_WELCOME_PATH);
  });

  it("never transfers ownership to a mismatched or stale selection", () => {
    expect(
      getMissingOwnedDraftNavigationPath("draft", {
        kind: "thread",
        threadId: "other",
      }),
    ).toBeNull();
    expect(
      getMissingOwnedDraftNavigationPath("draft", {
        kind: "draft",
        draftId: "draft",
      }),
    ).toBeNull();
  });
});

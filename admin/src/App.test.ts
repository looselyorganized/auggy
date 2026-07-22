import { describe, expect, it } from "bun:test";

import {
  chatThreadPath,
  decodeChatThreadRouteParam,
  getChatNavigationState,
  getVisibleChatWorkspaceTarget,
} from "@/lib/chat-route";
import { createChatThread } from "@/lib/chat-workspace";
import type { DurableChatThreadSummary } from "@/lib/chat-workspace-state";

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

describe("console chat routes", () => {
  it("creates an exact deep link for a thread", () => {
    expect(chatThreadPath("thread-123")).toBe("/chat/thread-123");
  });

  it("keeps a thread identifier inside one encoded path segment", () => {
    expect(chatThreadPath("owner:debug/chat?one")).toBe(
      "/chat/owner%3Adebug%2Fchat%3Fone",
    );
    expect(decodeChatThreadRouteParam("owner%3Adebug%2Fchat%3Fone")).toBe(
      "owner:debug/chat?one",
    );
  });

  it("fails closed without crashing on a malformed route encoding", () => {
    expect(decodeChatThreadRouteParam("bad%thread")).toBe("bad%thread");
  });

  it("proves visibility only for the exact selected route identity", () => {
    expect(
      getVisibleChatWorkspaceTarget({
        chatRouteActive: true,
        documentVisible: true,
        routedThreadId: "requested",
        selection: { kind: "thread", threadId: "fallback" },
      }),
    ).toBeNull();
    expect(
      getVisibleChatWorkspaceTarget({
        chatRouteActive: true,
        documentVisible: true,
        routedThreadId: "requested",
        selection: { kind: "thread", threadId: "requested" },
      }),
    ).toEqual({ kind: "thread", threadId: "requested" });
    expect(
      getVisibleChatWorkspaceTarget({
        chatRouteActive: true,
        documentVisible: true,
        routedThreadId: "draft",
        selection: { kind: "draft", draftId: "draft" },
      }),
    ).toEqual({ kind: "draft", draftId: "draft" });
  });

  it("does not mark a selected chat visible in a background tab", () => {
    expect(
      getVisibleChatWorkspaceTarget({
        chatRouteActive: true,
        documentVisible: false,
        routedThreadId: "requested",
        selection: { kind: "thread", threadId: "requested" },
      }),
    ).toBeNull();
  });

  it("shows the welcome route with durable navigation and no active row", () => {
    const saved = thread("saved", "Saved investigation");
    const navigation = getChatNavigationState({
      threads: [saved],
      chatRouteActive: true,
      routedThreadId: undefined,
      selection: { kind: "welcome" },
    });

    expect(navigation.activeId).toBe("");
    expect(navigation.threads).toEqual([saved]);
  });

  it("never activates a durable nav row for the separately-owned draft", () => {
    const saved = thread("saved", "Saved investigation");
    const navigation = getChatNavigationState({
      threads: [saved],
      chatRouteActive: true,
      routedThreadId: "draft",
      selection: { kind: "draft", draftId: "draft" },
    });

    expect(navigation.activeId).toBe("");
    expect(navigation.threads).toEqual([saved]);
  });

  it("selects only an exact routed durable chat and sorts canonical summaries", () => {
    const first = thread("first", "First", {
      updatedAt: "2026-07-20T10:01:00.000Z",
    });
    const second = thread("second", "Second", {
      updatedAt: "2026-07-20T10:02:00.000Z",
    });

    expect(
      getChatNavigationState({
        threads: [first, second],
        chatRouteActive: true,
        routedThreadId: second.id,
        selection: { kind: "thread", threadId: second.id },
      }),
    ).toMatchObject({ activeId: second.id, threads: [second, first] });
    expect(
      getChatNavigationState({
        threads: [first, second],
        chatRouteActive: false,
        routedThreadId: undefined,
        selection: { kind: "thread", threadId: second.id },
      }).activeId,
    ).toBe("");
  });
});

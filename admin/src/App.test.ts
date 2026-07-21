import { describe, expect, it } from "bun:test";

import {
  chatThreadPath,
  decodeChatThreadRouteParam,
  getChatNavigationState,
  isChatThreadActuallyVisible,
} from "@/lib/chat-route";
import { createChatThread, type ChatThread } from "@/lib/chat-workspace";

function thread(
  id: string,
  title: string,
  patch: Partial<ChatThread> = {},
): ChatThread {
  return {
    ...createChatThread({
      id,
      title,
      previewMode: "creator",
      now: "2026-07-20T10:00:00.000Z",
    }),
    ...patch,
  };
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

  it("only treats the exact active thread as visible", () => {
    expect(
      isChatThreadActuallyVisible({
        chatRouteActive: true,
        documentVisible: true,
        routedThreadId: "requested",
        activeThreadId: "fallback",
      }),
    ).toBe(false);
    expect(
      isChatThreadActuallyVisible({
        chatRouteActive: true,
        documentVisible: true,
        routedThreadId: "requested",
        activeThreadId: "requested",
      }),
    ).toBe(true);
  });

  it("does not mark a thread visible in a background tab", () => {
    expect(
      isChatThreadActuallyVisible({
        chatRouteActive: true,
        documentVisible: false,
        routedThreadId: "requested",
        activeThreadId: "requested",
      }),
    ).toBe(false);
  });

  it("shows the welcome route without selecting or listing its untouched draft", () => {
    const saved = thread("saved", "Saved investigation", {
      messages: [
        {
          id: "message",
          role: "user",
          content: "Hello",
          createdAt: "2026-07-20T10:01:00.000Z",
          updatedAt: "2026-07-20T10:01:00.000Z",
        },
      ],
    });
    const draft = thread("draft", "New chat");

    const navigation = getChatNavigationState({
      threads: [draft, saved],
      chatRouteActive: true,
      routedThreadId: undefined,
      activeThreadId: draft.id,
    });

    expect(navigation.activeId).toBe("");
    expect(navigation.threads.map((candidate) => candidate.id)).toEqual([
      saved.id,
    ]);
  });

  it("selects an exact routed chat and clears selection outside chat routes", () => {
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
        activeThreadId: second.id,
      }),
    ).toMatchObject({ activeId: second.id, threads: [second, first] });
    expect(
      getChatNavigationState({
        threads: [first, second],
        chatRouteActive: false,
        routedThreadId: undefined,
        activeThreadId: second.id,
      }).activeId,
    ).toBe("");
  });
});

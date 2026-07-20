import { describe, expect, it } from "bun:test";

import { createChatThread, type ChatThread } from "@/lib/chat-workspace";
import {
  getChatRunPresentation,
  getMobileChatNavigationState,
} from "@/lib/chat-run-state";

function thread(id: string, runStatus: ChatThread["runStatus"]): ChatThread {
  return {
    ...createChatThread({
      id,
      previewMode: "creator",
      now: "2026-07-20T10:00:00.000Z",
    }),
    runStatus,
  };
}

describe("chat run presentation", () => {
  it("does not expose local Stop for a hydrated stream owned by another session", () => {
    expect(getChatRunPresentation([thread("one", "streaming")], "one", null)).toEqual({
      ownsLocalStream: false,
      activeThreadStreaming: true,
      anotherThreadStreaming: false,
    });
  });

  it("detects a background stream from persisted thread state", () => {
    expect(
      getChatRunPresentation(
        [thread("one", "idle"), thread("two", "streaming")],
        "one",
        null,
      ),
    ).toEqual({
      ownsLocalStream: false,
      activeThreadStreaming: false,
      anotherThreadStreaming: true,
    });
  });

  it("identifies a stream controlled by this page", () => {
    expect(
      getChatRunPresentation([thread("one", "streaming")], "one", {
        clientRunId: "run-one",
        threadId: "one",
        assistantMessageId: "assistant-one",
      }),
    ).toEqual({
      ownsLocalStream: true,
      activeThreadStreaming: true,
      anotherThreadStreaming: false,
    });
  });
});

describe("mobile chat navigation state", () => {
  it("aggregates unread and running conversations while the chat list is off-screen", () => {
    const unread = { ...thread("one", "complete"), unread: true };
    const running = { ...thread("two", "streaming"), unread: true };

    expect(getMobileChatNavigationState([unread, running], false)).toEqual({
      unreadCount: 2,
      streamingCount: 1,
      showIndicator: true,
      accessibleLabel: "Chat, 2 unread conversations, 1 response running",
      statusMessage: "2 unread conversations, 1 response running",
    });
  });

  it("suppresses the aggregate indicator when the thread navigation is visible", () => {
    const unread = { ...thread("one", "complete"), unread: true };

    expect(getMobileChatNavigationState([unread], true)).toEqual({
      unreadCount: 1,
      streamingCount: 0,
      showIndicator: false,
      accessibleLabel: "Chat",
      statusMessage: null,
    });
  });
});

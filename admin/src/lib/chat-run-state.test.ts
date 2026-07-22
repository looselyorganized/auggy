import { describe, expect, it } from "bun:test";

import { createChatThread, type ChatRunStatus } from "@/lib/chat-workspace";
import type { DurableChatThreadSummary } from "@/lib/chat-workspace-state";
import {
  getChatRunPresentation,
  getMobileChatNavigationState,
} from "@/lib/chat-run-state";

function thread(id: string, runStatus: ChatRunStatus): DurableChatThreadSummary {
  const { messages: _messages, ...summary } = createChatThread({
    id,
    previewMode: "creator",
    now: "2026-07-20T10:00:00.000Z",
  });
  return { ...summary, lifecycle: "summary", runStatus };
}

describe("chat run presentation", () => {
  it("does not expose local Stop for a hydrated stream owned by another session", () => {
    const selected = thread("one", "streaming");
    expect(getChatRunPresentation([selected], selected, null)).toEqual({
      ownsLocalStream: false,
      activeThreadStreaming: true,
      anotherThreadStreaming: false,
    });
  });

  it("detects a background stream from persisted thread state", () => {
    expect(
      getChatRunPresentation(
        [thread("one", "idle"), thread("two", "streaming")],
        thread("one", "idle"),
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
      getChatRunPresentation([thread("one", "streaming")], thread("one", "streaming"), {
        threadId: "one",
      }),
    ).toEqual({
      ownsLocalStream: true,
      activeThreadStreaming: true,
      anotherThreadStreaming: false,
    });
  });

  it("supports welcome and a selected local draft without adding the draft to aggregates", () => {
    const background = thread("saved", "streaming");
    expect(getChatRunPresentation([background], null, null)).toEqual({
      ownsLocalStream: false,
      activeThreadStreaming: false,
      anotherThreadStreaming: true,
    });
    expect(
      getChatRunPresentation(
        [background],
        { id: "draft", runStatus: "streaming" },
        { threadId: "draft" },
      ),
    ).toEqual({
      ownsLocalStream: true,
      activeThreadStreaming: true,
      anotherThreadStreaming: true,
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

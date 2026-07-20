import { describe, expect, it } from "bun:test";

import { createChatThread, type ChatThread } from "@/lib/chat-workspace";
import { getChatRunPresentation } from "@/lib/chat-run-state";

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

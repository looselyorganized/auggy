import { describe, expect, it } from "bun:test";

import {
  chatThreadPath,
  decodeChatThreadRouteParam,
  isChatThreadActuallyVisible,
} from "@/lib/chat-route";

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
});

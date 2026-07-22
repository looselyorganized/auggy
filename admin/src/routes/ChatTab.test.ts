import { describe, expect, it } from "bun:test";
import { getAcceptedChatNavigationPath } from "./ChatTab";

describe("getAcceptedChatNavigationPath", () => {
  it("replaces the local draft route with its durable URL after acceptance", () => {
    expect(
      getAcceptedChatNavigationPath({
        mounted: true,
        sentTargetKind: "draft",
        sentThreadId: "draft/with spaces",
        activeThreadId: "draft/with spaces",
        pathname: "/chat/new",
      }),
    ).toBe("/chat/draft%2Fwith%20spaces");
  });

  it("does not navigate after an accepted send from a durable thread", () => {
    expect(
      getAcceptedChatNavigationPath({
        mounted: true,
        sentTargetKind: "thread",
        sentThreadId: "saved",
        activeThreadId: "saved",
        pathname: "/chat/saved",
      }),
    ).toBeNull();
  });

  it("ignores a stale draft callback after selection moves to another owner", () => {
    expect(
      getAcceptedChatNavigationPath({
        mounted: true,
        sentTargetKind: "draft",
        sentThreadId: "draft",
        activeThreadId: "other",
        pathname: "/chat/new",
      }),
    ).toBeNull();
  });

  it("does not pull the user back after they leave the new-chat route", () => {
    expect(
      getAcceptedChatNavigationPath({
        mounted: true,
        sentTargetKind: "draft",
        sentThreadId: "draft",
        activeThreadId: "draft",
        pathname: "/capabilities",
      }),
    ).toBeNull();
  });

  it("ignores acceptance after the sending chat surface unmounts", () => {
    expect(
      getAcceptedChatNavigationPath({
        mounted: false,
        sentTargetKind: "draft",
        sentThreadId: "draft",
        activeThreadId: "draft",
        pathname: "/chat/new",
      }),
    ).toBeNull();
  });
});

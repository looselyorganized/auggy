import { describe, expect, it } from "bun:test";
import {
  getAcceptedChatNavigationPath,
  shouldReplaceDeletedChatWithWelcome,
} from "./ChatTab";

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

describe("shouldReplaceDeletedChatWithWelcome", () => {
  const current = {
    mounted: true,
    deletedThreadId: "selected",
    activeThreadId: "selected",
    startedLocationKey: "route-1",
    currentLocationKey: "route-1",
    startedPathname: "/chat/selected",
    currentPathname: "/chat/selected",
  };

  it("replaces the unchanged selected chat route after deletion", () => {
    expect(shouldReplaceDeletedChatWithWelcome(current)).toBe(true);
    expect(
      shouldReplaceDeletedChatWithWelcome({
        ...current,
        deletedThreadId: "draft",
        activeThreadId: "draft",
        startedPathname: "/chat/new",
        currentPathname: "/chat/new",
      }),
    ).toBe(true);
  });

  it("does not navigate after selection moves to another chat", () => {
    expect(
      shouldReplaceDeletedChatWithWelcome({
        ...current,
        activeThreadId: "other",
        currentLocationKey: "route-2",
        currentPathname: "/chat/other",
      }),
    ).toBe(false);
  });

  it("does not navigate after leaving and returning to the same URL", () => {
    expect(
      shouldReplaceDeletedChatWithWelcome({
        ...current,
        currentLocationKey: "route-3",
      }),
    ).toBe(false);
  });

  it("does not navigate after the chat surface unmounts", () => {
    expect(
      shouldReplaceDeletedChatWithWelcome({
        ...current,
        mounted: false,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";

import type { ChatThreadSummary } from "./chat-workspace";
import { reconcileChatSummarySnapshot } from "./chat-request-snapshot";

function summary(id: string, title = id): ChatThreadSummary {
  return {
    id,
    title,
    previewMode: "creator",
    model: null,
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
    lastReadAt: "2026-07-22T10:00:00.000Z",
    unread: false,
    runStatus: "idle",
  };
}

describe("chat request snapshot reconciliation", () => {
  it("preserves a locally added identity when the older server snapshot omits it", () => {
    const existing = summary("existing", "Server existing");
    const added = summary("added", "Locally added");

    const result = reconcileChatSummarySnapshot(
      [existing],
      [existing, added],
      new Map([["added", 0]]),
      new Map([["added", 1]]),
    );

    expect(result).toEqual([existing, added]);
    expect(result[1]).toBe(added);
  });

  it("preserves a local update over a stale server value at the server position", () => {
    const first = summary("first");
    const stale = summary("updated", "Stale server title");
    const current = summary("updated", "Current local title");
    const last = summary("last");

    const result = reconcileChatSummarySnapshot(
      [first, stale, last],
      [current, first, last],
      new Map([["updated", 2]]),
      new Map([["updated", 3]]),
    );

    expect(result).toEqual([first, current, last]);
    expect(result[1]).toBe(current);
  });

  it("preserves a local deletion over a stale server identity", () => {
    const staleDeleted = summary("deleted");
    const kept = summary("kept");

    const result = reconcileChatSummarySnapshot(
      [staleDeleted, kept],
      [kept],
      new Map([["deleted", 4]]),
      new Map([["deleted", 5]]),
    );

    expect(result).toEqual([kept]);
  });

  it("accepts server additions, updates, and deletions for unchanged identities", () => {
    const serverAdded = summary("added", "Server added");
    const serverUpdated = summary("updated", "Server updated");
    const currentUpdated = summary("updated", "Current old value");
    const currentDeleted = summary("deleted", "Deleted by server");

    const result = reconcileChatSummarySnapshot(
      [serverAdded, serverUpdated],
      [currentUpdated, currentDeleted],
      new Map([
        ["added", 1],
        ["updated", 2],
        ["deleted", 3],
      ]),
      new Map([
        ["added", 1],
        ["updated", 2],
        ["deleted", 3],
      ]),
    );

    expect(result).toEqual([serverAdded, serverUpdated]);
    expect(result[0]).toBe(serverAdded);
    expect(result[1]).toBe(serverUpdated);
  });

  it("keeps server order and appends changed current-only identities in current order", () => {
    const serverUpdated = summary("updated", "Stale");
    const currentUpdated = summary("updated", "Current");
    const unchanged = summary("unchanged", "Server value");
    const staleDeleted = summary("deleted");
    const serverAdded = summary("server-added");
    const currentOnlySecond = summary("current-only-second");
    const currentOnlyFirst = summary("current-only-first");
    const unchangedCurrentOnly = summary("server-deleted");

    const result = reconcileChatSummarySnapshot(
      [serverUpdated, unchanged, staleDeleted, serverAdded],
      [
        currentOnlySecond,
        unchangedCurrentOnly,
        currentUpdated,
        currentOnlyFirst,
        unchanged,
      ],
      new Map(),
      new Map([
        ["updated", 1],
        ["deleted", 1],
        ["current-only-second", 1],
        ["current-only-first", 1],
      ]),
    );

    expect(result).toEqual([
      currentUpdated,
      unchanged,
      serverAdded,
      currentOnlySecond,
      currentOnlyFirst,
    ]);
  });

  it("rejects duplicate IDs and never mutates either summary input", () => {
    const server = Object.freeze([summary("server")]);
    const current = Object.freeze([summary("current")]);
    const serverBefore = [...server];
    const currentBefore = [...current];

    const result = reconcileChatSummarySnapshot(server, current, new Map(), new Map());

    expect(result).not.toBe(server);
    expect(server).toEqual(serverBefore);
    expect(current).toEqual(currentBefore);
    expect(() =>
      reconcileChatSummarySnapshot(
        [summary("duplicate"), summary("duplicate")],
        [],
        new Map(),
        new Map(),
      ),
    ).toThrow(/Duplicate chat thread summary ID in serverSummaries: duplicate/);
    expect(() =>
      reconcileChatSummarySnapshot(
        [],
        [summary("duplicate"), summary("duplicate")],
        new Map(),
        new Map(),
      ),
    ).toThrow(/Duplicate chat thread summary ID in currentSummaries: duplicate/);
  });
});

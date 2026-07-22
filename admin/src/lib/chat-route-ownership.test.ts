import { describe, expect, it } from "bun:test";

import {
  advanceChatDraftRouteOwnership,
  createChatDraftRouteOwnership,
  type ChatDraftRouteObservation,
  type ChatDraftRouteOwnership,
} from "./chat-route-ownership";

const welcome = { kind: "welcome" } as const;

describe("chat draft route ownership", () => {
  it("creates one draft, adopts it, and navigates welcome after deletion", () => {
    let ownership = createChatDraftRouteOwnership();

    ({ ownership } = expectStep(ownership, draft("entry-1"), { type: "create-draft" }));
    ({ ownership } = expectStep(ownership, draft("entry-1"), null));
    ({ ownership } = expectStep(ownership, draft("entry-1", "draft-1"), {
      type: "select-draft",
      draftId: "draft-1",
    }));
    ({ ownership } = expectStep(
      ownership,
      draft("entry-1", "draft-1", [], { kind: "draft", draftId: "draft-1" }),
      null,
    ));
    ({ ownership } = expectStep(ownership, draft("entry-1"), {
      type: "navigate-welcome",
    }));

    expect(ownership).toEqual({
      status: "resolved",
      locationKey: "entry-1",
      ownedDraftId: "draft-1",
      destination: "welcome",
    });
    expectStep(ownership, draft("entry-1"), null);
  });

  it("navigates to the durable URL when the owned draft is promoted", () => {
    let ownership = createChatDraftRouteOwnership();

    ({ ownership } = expectStep(ownership, draft("entry-1", "draft-1"), {
      type: "select-draft",
      draftId: "draft-1",
    }));
    ({ ownership } = expectStep(
      ownership,
      draft("entry-1", null, ["draft-1"], { kind: "thread", threadId: "other" }),
      { type: "navigate-durable", threadId: "draft-1" },
    ));

    expect(ownership).toMatchObject({
      status: "resolved",
      ownedDraftId: "draft-1",
      destination: "durable",
    });
    expectStep(ownership, draft("entry-1", null, ["draft-1"]), null);
  });

  it("resets ownership after leaving or entering a new location key", () => {
    let ownership = createChatDraftRouteOwnership();

    ({ ownership } = expectStep(ownership, draft("entry-1"), { type: "create-draft" }));
    ({ ownership } = expectStep(ownership, { route: "outside" }, null));
    expect(ownership).toEqual({ status: "inactive" });
    ({ ownership } = expectStep(ownership, draft("entry-2"), { type: "create-draft" }));
    ({ ownership } = expectStep(ownership, draft("entry-3", "existing"), {
      type: "select-draft",
      draftId: "existing",
    }));

    expect(ownership).toMatchObject({
      status: "active",
      locationKey: "entry-3",
      ownedDraftId: "existing",
    });
  });

  it("repairs stale selection without adopting a mismatched replacement draft", () => {
    let ownership = createChatDraftRouteOwnership();

    ({ ownership } = expectStep(
      ownership,
      draft("entry-1", "owned", [], { kind: "thread", threadId: "stale" }),
      { type: "select-draft", draftId: "owned" },
    ));
    ({ ownership } = expectStep(
      ownership,
      draft("entry-1", "owned", [], { kind: "draft", draftId: "other" }),
      { type: "select-draft", draftId: "owned" },
    ));
    ({ ownership } = expectStep(
      ownership,
      draft("entry-1", "replacement", [], { kind: "draft", draftId: "replacement" }),
      { type: "navigate-welcome" },
    ));

    expect(ownership).toMatchObject({ status: "resolved", ownedDraftId: "owned" });
  });

  it("never recreates a missing draft for the same route entry", () => {
    let ownership = createChatDraftRouteOwnership();

    ({ ownership } = expectStep(ownership, draft("entry-1"), { type: "create-draft" }));
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ ownership } = expectStep(ownership, draft("entry-1"), null));
    }
    ({ ownership } = expectStep(ownership, draft("entry-1", "draft-1"), {
      type: "select-draft",
      draftId: "draft-1",
    }));
    ({ ownership } = expectStep(ownership, draft("entry-1"), {
      type: "navigate-welcome",
    }));
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ ownership } = expectStep(ownership, draft("entry-1"), null));
    }
  });
});

function expectStep(
  ownership: ChatDraftRouteOwnership,
  observation: ChatDraftRouteObservation,
  command: ReturnType<typeof advanceChatDraftRouteOwnership>["command"],
) {
  const transition = advanceChatDraftRouteOwnership(ownership, observation);
  expect(transition.command).toEqual(command);
  return transition;
}

function draft(
  locationKey: string,
  localDraftId: string | null = null,
  durableThreadIds: readonly string[] = [],
  selection: Extract<ChatDraftRouteObservation, { route: "draft" }>["selection"] = welcome,
): ChatDraftRouteObservation {
  return {
    route: "draft",
    locationKey,
    localDraftId,
    durableThreadIds,
    selection,
  };
}

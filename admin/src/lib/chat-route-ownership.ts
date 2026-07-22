import type { ChatWorkspaceSelection } from "./chat-workspace-state";

export type ChatDraftRouteOwnership =
  | { status: "inactive" }
  | {
      status: "active";
      locationKey: string;
      ownedDraftId: string | null;
      createRequested: boolean;
    }
  | {
      status: "resolved";
      locationKey: string;
      ownedDraftId: string;
      destination: "welcome" | "durable";
    };

export type ChatDraftRouteObservation =
  | { route: "outside" }
  | {
      route: "draft";
      locationKey: string;
      localDraftId: string | null;
      durableThreadIds: readonly string[];
      selection: ChatWorkspaceSelection;
    };

export type ChatDraftRouteCommand =
  | { type: "create-draft" }
  | { type: "select-draft"; draftId: string }
  | { type: "navigate-welcome" }
  | { type: "navigate-durable"; threadId: string };

export interface ChatDraftRouteTransition {
  ownership: ChatDraftRouteOwnership;
  command: ChatDraftRouteCommand | null;
}

export function createChatDraftRouteOwnership(): ChatDraftRouteOwnership {
  return { status: "inactive" };
}

/**
 * Advances ownership for one `/chat/new` history entry. Once that entry owns a
 * draft, disappearance resolves to navigation and can never request a second
 * draft. Leaving the route or entering with a different location key starts a
 * new ownership session.
 */
export function advanceChatDraftRouteOwnership(
  ownership: ChatDraftRouteOwnership,
  observation: ChatDraftRouteObservation,
): ChatDraftRouteTransition {
  if (observation.route === "outside") {
    return {
      ownership: ownership.status === "inactive" ? ownership : { status: "inactive" },
      command: null,
    };
  }

  if (
    ownership.status === "resolved" &&
    ownership.locationKey === observation.locationKey
  ) {
    return { ownership, command: null };
  }

  const active =
    ownership.status === "active" && ownership.locationKey === observation.locationKey
      ? ownership
      : {
          status: "active" as const,
          locationKey: observation.locationKey,
          ownedDraftId: null,
          createRequested: false,
        };

  if (active.ownedDraftId !== null) {
    if (observation.localDraftId !== active.ownedDraftId) {
      const promoted = observation.durableThreadIds.includes(active.ownedDraftId);
      return {
        ownership: {
          status: "resolved",
          locationKey: active.locationKey,
          ownedDraftId: active.ownedDraftId,
          destination: promoted ? "durable" : "welcome",
        },
        command: promoted
          ? { type: "navigate-durable", threadId: active.ownedDraftId }
          : { type: "navigate-welcome" },
      };
    }

    return {
      ownership: active,
      command: selectionOwnsDraft(observation.selection, active.ownedDraftId)
        ? null
        : { type: "select-draft", draftId: active.ownedDraftId },
    };
  }

  if (observation.localDraftId !== null) {
    const adopted: ChatDraftRouteOwnership = {
      ...active,
      ownedDraftId: observation.localDraftId,
    };
    return {
      ownership: adopted,
      command: selectionOwnsDraft(observation.selection, observation.localDraftId)
        ? null
        : { type: "select-draft", draftId: observation.localDraftId },
    };
  }

  if (active.createRequested) return { ownership: active, command: null };
  return {
    ownership: { ...active, createRequested: true },
    command: { type: "create-draft" },
  };
}

function selectionOwnsDraft(selection: ChatWorkspaceSelection, draftId: string): boolean {
  return selection.kind === "draft" && selection.draftId === draftId;
}

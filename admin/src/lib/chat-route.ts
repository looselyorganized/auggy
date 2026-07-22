import type {
  ChatWorkspaceSelection,
  ChatWorkspaceVisibleTarget,
  DurableChatThread,
} from "@/lib/chat-workspace-state";

export const CHAT_WELCOME_PATH = "/chat";
export const CHAT_DRAFT_PATH = "/chat/new";

export type ChatRouteTarget =
  | { kind: "outside" }
  | { kind: "welcome" }
  | { kind: "draft" }
  | { kind: "thread"; threadId: string };

/** Build a console-relative URL for a durable chat identifier. */
export function chatThreadPath(threadId: string): string {
  if (!threadId) throw new Error("A durable chat route requires a thread ID.");
  // Keep the static draft segment collision-free while preserving a round trip
  // for a durable server thread whose (legacy/external) ID is literally `new`.
  const encodedThreadId = threadId === "new" ? "%6Eew" : encodeURIComponent(threadId);
  return `${CHAT_WELCOME_PATH}/${encodedThreadId}`;
}

/** React Router's low-level path matching leaves path parameters encoded. */
export function decodeChatThreadRouteParam(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse the URL's authoritative chat target. `new` is a reserved route segment
 * for the one local draft and is never interpreted as a durable thread ID.
 */
export function parseChatRouteTarget(pathname: string): ChatRouteTarget {
  const match = /^\/chat(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return { kind: "outside" };
  const encodedSegment = match[1];
  if (encodedSegment === undefined) return { kind: "welcome" };
  return encodedSegment === "new"
    ? { kind: "draft" }
    : {
        kind: "thread",
        threadId: decodeChatThreadRouteParam(encodedSegment) ?? "",
      };
}

export function getVisibleChatWorkspaceTarget(options: {
  route: ChatRouteTarget;
  documentVisible: boolean;
  localDraftId: string | null;
  selection: ChatWorkspaceSelection;
}): ChatWorkspaceVisibleTarget | null {
  if (!options.documentVisible) return null;
  if (
    options.route.kind === "draft" &&
    options.localDraftId !== null &&
    options.selection.kind === "draft" &&
    options.selection.draftId === options.localDraftId
  ) {
    return options.selection;
  }
  if (
    options.route.kind === "thread" &&
    options.selection.kind === "thread" &&
    options.selection.threadId === options.route.threadId
  ) {
    return options.selection;
  }
  return null;
}

export function getChatNavigationState(options: {
  threads: readonly DurableChatThread[];
  route: ChatRouteTarget;
  selection: ChatWorkspaceSelection;
}): { activeId: string; threads: DurableChatThread[] } {
  const { threads, route, selection } = options;
  const activeId =
    route.kind === "thread" &&
    selection.kind === "thread" &&
    selection.threadId === route.threadId
      ? route.threadId
      : "";

  return {
    activeId,
    threads: [...threads].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt)
        return b.updatedAt.localeCompare(a.updatedAt);
      if (a.createdAt !== b.createdAt)
        return b.createdAt.localeCompare(a.createdAt);
      return a.id.localeCompare(b.id);
    }),
  };
}

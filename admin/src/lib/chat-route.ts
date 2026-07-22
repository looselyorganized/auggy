import type {
  ChatWorkspaceSelection,
  ChatWorkspaceVisibleTarget,
  DurableChatThread,
} from "@/lib/chat-workspace-state";

/** Build a console-relative URL for a durable chat identifier. */
export function chatThreadPath(threadId: string): string {
  return `/chat/${encodeURIComponent(threadId)}`;
}

/** React Router's low-level matchPath helper leaves path parameters encoded. */
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

export function getVisibleChatWorkspaceTarget(options: {
  chatRouteActive: boolean;
  documentVisible: boolean;
  routedThreadId: string | undefined;
  selection: ChatWorkspaceSelection;
}): ChatWorkspaceVisibleTarget | null {
  if (
    !options.chatRouteActive ||
    !options.documentVisible ||
    options.routedThreadId === undefined
  ) {
    return null;
  }
  if (
    options.selection.kind === "draft" &&
    options.selection.draftId === options.routedThreadId
  ) {
    return options.selection;
  }
  if (
    options.selection.kind === "thread" &&
    options.selection.threadId === options.routedThreadId
  ) {
    return options.selection;
  }
  return null;
}

export function getChatNavigationState(options: {
  threads: readonly DurableChatThread[];
  chatRouteActive: boolean;
  routedThreadId: string | undefined;
  selection: ChatWorkspaceSelection;
}): { activeId: string; threads: DurableChatThread[] } {
  const { threads, chatRouteActive, routedThreadId, selection } = options;
  const selectedDurableId = selection.kind === "thread" ? selection.threadId : null;

  return {
    activeId:
      chatRouteActive && routedThreadId === selectedDurableId
        ? selectedDurableId
        : "",
    threads: [...threads].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt)
        return b.updatedAt.localeCompare(a.updatedAt);
      if (a.createdAt !== b.createdAt)
        return b.createdAt.localeCompare(a.createdAt);
      return a.id.localeCompare(b.id);
    }),
  };
}

import { isEmptyChatThread, type ChatThread } from "@/lib/chat-workspace";

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

export function isChatThreadActuallyVisible(options: {
  chatRouteActive: boolean;
  documentVisible: boolean;
  routedThreadId: string | undefined;
  activeThreadId: string;
}): boolean {
  return (
    options.chatRouteActive &&
    options.documentVisible &&
    options.routedThreadId !== undefined &&
    options.routedThreadId === options.activeThreadId
  );
}

export function getChatNavigationState(options: {
  threads: readonly ChatThread[];
  chatRouteActive: boolean;
  routedThreadId: string | undefined;
  activeThreadId: string;
}): { activeId: string; threads: ChatThread[] } {
  const { threads, chatRouteActive, routedThreadId, activeThreadId } = options;
  const landingDraftId =
    chatRouteActive && routedThreadId === undefined
      ? threads.find(
          (thread) => thread.id === activeThreadId && isEmptyChatThread(thread),
        )?.id
      : undefined;

  return {
    activeId:
      chatRouteActive && routedThreadId === activeThreadId
        ? activeThreadId
        : "",
    threads: threads
      .filter((thread) => thread.id !== landingDraftId)
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt)
          return b.updatedAt.localeCompare(a.updatedAt);
        if (a.createdAt !== b.createdAt)
          return b.createdAt.localeCompare(a.createdAt);
        return a.id.localeCompare(b.id);
      }),
  };
}

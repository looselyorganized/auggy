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
  ephemeralDraftId?: string;
}): { activeId: string; threads: ChatThread[] } {
  const {
    threads,
    chatRouteActive,
    routedThreadId,
    activeThreadId,
    ephemeralDraftId,
  } = options;

  return {
    activeId:
      chatRouteActive && routedThreadId === activeThreadId
        ? activeThreadId
        : "",
    threads: threads
      // The workspace keeps one reusable local draft ready for the composer.
      // It is not a conversation yet and must never appear beside durable chats.
      .filter(
        (thread) =>
          thread.id !== ephemeralDraftId || !isEmptyChatThread(thread),
      )
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt)
          return b.updatedAt.localeCompare(a.updatedAt);
        if (a.createdAt !== b.createdAt)
          return b.createdAt.localeCompare(a.createdAt);
        return a.id.localeCompare(b.id);
      }),
  };
}

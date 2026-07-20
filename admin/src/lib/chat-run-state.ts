import type { ActiveChatRun, ChatThread } from "@/lib/chat-workspace";

export interface ChatRunPresentation {
  /** A request owned by this browser page; only this state may expose Stop. */
  ownsLocalStream: boolean;
  /** The selected thread is running locally or in another console session. */
  activeThreadStreaming: boolean;
  /** A different thread is running locally or in another console session. */
  anotherThreadStreaming: boolean;
}

export interface MobileChatNavigationState {
  unreadCount: number;
  streamingCount: number;
  showIndicator: boolean;
  accessibleLabel: string;
  statusMessage: string | null;
}

export function getChatRunPresentation(
  threads: ChatThread[],
  activeThreadId: string,
  activeRun: ActiveChatRun | null,
): ChatRunPresentation {
  return {
    ownsLocalStream: activeRun?.threadId === activeThreadId,
    activeThreadStreaming:
      threads.find((thread) => thread.id === activeThreadId)?.runStatus === "streaming",
    anotherThreadStreaming: threads.some(
      (thread) => thread.id !== activeThreadId && thread.runStatus === "streaming",
    ),
  };
}

/** Aggregate state for the compact mobile nav while its thread list is off-screen. */
export function getMobileChatNavigationState(
  threads: readonly ChatThread[],
  chatRouteActive: boolean,
): MobileChatNavigationState {
  const unreadCount = threads.filter((thread) => thread.unread).length;
  const streamingCount = threads.filter((thread) => thread.runStatus === "streaming").length;
  const showIndicator = !chatRouteActive && (unreadCount > 0 || streamingCount > 0);
  const parts = [
    unreadCount > 0
      ? `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}`
      : null,
    streamingCount > 0
      ? `${streamingCount} response${streamingCount === 1 ? "" : "s"} running`
      : null,
  ].filter((part): part is string => part !== null);
  const statusMessage = showIndicator ? parts.join(", ") : null;
  return {
    unreadCount,
    streamingCount,
    showIndicator,
    accessibleLabel: statusMessage ? `Chat, ${statusMessage}` : "Chat",
    statusMessage,
  };
}

import type { ActiveChatRun, ChatThread } from "@/lib/chat-workspace";

export interface ChatRunPresentation {
  /** A request owned by this browser page; only this state may expose Stop. */
  ownsLocalStream: boolean;
  /** The selected thread is running locally or in another console session. */
  activeThreadStreaming: boolean;
  /** A different thread is running locally or in another console session. */
  anotherThreadStreaming: boolean;
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

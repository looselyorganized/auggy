export const DEFAULT_CHAT_THREAD_TITLE = "New chat";
export const GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH = 60;
export const RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH = 80;

export type ChatPreviewMode = "creator" | "anonymous" | "visitor";
export type ChatRunStatus = "idle" | "streaming" | "complete" | "error" | "interrupted";

export interface ChatModelSnapshot {
  id: string;
  displayName: string;
  provider?: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args?: string;
  result?: string;
  status: "running" | "completed" | "error";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  previewMode: ChatPreviewMode;
  model: ChatModelSnapshot | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  unread: boolean;
  runStatus: ChatRunStatus;
}

export interface ChatWorkspaceState {
  threads: ChatThread[];
  activeThreadId: string;
  /** The only run allowed to own a live stream. Its client ID rejects stale SSE callbacks. */
  activeRun: ActiveChatRun | null;
}

export interface ActiveChatRun {
  clientRunId: string;
  threadId: string;
  assistantMessageId: string;
}

export interface CreateChatThreadOptions {
  id: string;
  previewMode: ChatPreviewMode;
  model?: ChatModelSnapshot | null;
  now: string;
  title?: string;
}

export type ChatThreadTitleValidation =
  | { valid: true; title: string }
  | { valid: false; reason: "empty" | "too-long"; message: string };

export type ChatWorkspaceAction =
  | { type: "draft.activate"; draft: ChatThread }
  | { type: "thread.select"; threadId: string; at: string }
  | { type: "thread.rename"; threadId: string; title: string; at: string }
  | { type: "thread.delete"; threadId: string; fallbackDraft: ChatThread; at: string }
  | { type: "thread.preview-mode-set"; threadId: string; previewMode: ChatPreviewMode; at: string }
  | { type: "thread.model-set"; threadId: string; model: ChatModelSnapshot | null; at: string }
  | { type: "thread.read-state-set"; threadId: string; unread: boolean; at: string }
  | {
      type: "run.message-update";
      clientRunId: string;
      threadId: string;
      messageId: string;
      patch: Partial<Pick<ChatMessage, "content" | "toolCalls" | "error">>;
      at: string;
    }
  | {
      type: "run.start";
      clientRunId: string;
      threadId: string;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
      model: ChatModelSnapshot | null;
      at: string;
    }
  | {
      type: "run.finish";
      clientRunId: string;
      threadId: string;
      outcome: Exclude<ChatRunStatus, "idle" | "streaming">;
      error?: string;
      at: string;
    };

export function createChatThread(options: CreateChatThreadOptions): ChatThread {
  return {
    id: options.id,
    title: options.title?.trim() || DEFAULT_CHAT_THREAD_TITLE,
    previewMode: options.previewMode,
    model: options.model ?? null,
    messages: [],
    createdAt: options.now,
    updatedAt: options.now,
    lastReadAt: options.now,
    unread: false,
    runStatus: "idle",
  };
}

export function createChatWorkspace(initialThread: ChatThread): ChatWorkspaceState {
  return {
    threads: [initialThread],
    activeThreadId: initialThread.id,
    activeRun: null,
  };
}

export function getChatThread(
  state: ChatWorkspaceState,
  threadId: string,
): ChatThread | undefined {
  return state.threads.find((thread) => thread.id === threadId);
}

export function getActiveChatThread(state: ChatWorkspaceState): ChatThread | undefined {
  return getChatThread(state, state.activeThreadId);
}

export function isEmptyChatThread(thread: ChatThread): boolean {
  return thread.messages.length === 0 && thread.runStatus !== "streaming";
}

export function canStartChatRun(state: ChatWorkspaceState, threadId: string): boolean {
  return state.activeRun === null && getChatThread(state, threadId) !== undefined;
}

export function deriveChatThreadTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return DEFAULT_CHAT_THREAD_TITLE;

  const characters = Array.from(normalized);
  if (characters.length <= GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH) return normalized;
  return `${characters.slice(0, GENERATED_CHAT_THREAD_TITLE_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

export function validateRenamedChatThreadTitle(value: string): ChatThreadTitleValidation {
  const title = value.trim();
  if (!title) {
    return { valid: false, reason: "empty", message: "Chat title cannot be empty." };
  }
  if (Array.from(title).length > RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH) {
    return {
      valid: false,
      reason: "too-long",
      message: `Chat title must be ${RENAMED_CHAT_THREAD_TITLE_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { valid: true, title };
}

export function chatWorkspaceReducer(
  state: ChatWorkspaceState,
  action: ChatWorkspaceAction,
): ChatWorkspaceState {
  switch (action.type) {
    case "draft.activate": {
      const reusable = state.threads.find(isEmptyChatThread);
      if (!reusable) {
        return {
          ...state,
          threads: [...state.threads, action.draft],
          activeThreadId: action.draft.id,
        };
      }

      const refreshed: ChatThread = {
        ...reusable,
        title: DEFAULT_CHAT_THREAD_TITLE,
        previewMode: action.draft.previewMode,
        model: action.draft.model,
        updatedAt: action.draft.updatedAt,
        lastReadAt: action.draft.updatedAt,
        unread: false,
        runStatus: "idle",
      };
      return {
        ...state,
        threads: replaceThread(state.threads, refreshed),
        activeThreadId: refreshed.id,
      };
    }

    case "thread.select": {
      const thread = getChatThread(state, action.threadId);
      if (!thread) return state;
      return {
        ...state,
        activeThreadId: thread.id,
        threads: replaceThread(state.threads, {
          ...thread,
          unread: false,
          lastReadAt: action.at,
        }),
      };
    }

    case "thread.rename": {
      const validation = validateRenamedChatThreadTitle(action.title);
      if (!validation.valid) return state;
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        title: validation.title,
        updatedAt: action.at,
      }));
    }

    case "thread.delete": {
      if (state.activeRun?.threadId === action.threadId) return state;
      if (!getChatThread(state, action.threadId)) return state;

      const remaining = state.threads.filter((thread) => thread.id !== action.threadId);
      if (remaining.length === 0) {
        return createChatWorkspace(action.fallbackDraft);
      }
      if (state.activeThreadId !== action.threadId) {
        return { ...state, threads: remaining };
      }

      const fallback = mostRecentlyUpdated(remaining);
      return {
        ...state,
        threads: replaceThread(remaining, {
          ...fallback,
          unread: false,
          lastReadAt: action.at,
        }),
        activeThreadId: fallback.id,
      };
    }

    case "thread.preview-mode-set":
      return updateThread(state, action.threadId, (thread) => {
        if (!isEmptyChatThread(thread)) return thread;
        return { ...thread, previewMode: action.previewMode, updatedAt: action.at };
      });

    case "thread.model-set":
      return updateThread(state, action.threadId, (thread) => {
        if (!isEmptyChatThread(thread)) return thread;
        return { ...thread, model: action.model, updatedAt: action.at };
      });

    case "thread.read-state-set":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        unread: action.unread,
        lastReadAt: action.unread ? thread.lastReadAt : action.at,
      }));

    case "run.message-update": {
      if (!matchesActiveRun(state, action)) return state;
      return updateThreadWithActivity(state, action.threadId, action.at, (thread) => {
        if (action.messageId !== state.activeRun?.assistantMessageId) return thread;
        return {
          ...thread,
          messages: thread.messages.map((message) =>
            message.id === action.messageId
              ? { ...message, ...action.patch, updatedAt: action.at }
              : message,
          ),
        };
      });
    }

    case "run.start": {
      if (!canStartChatRun(state, action.threadId)) return state;
      if (
        !action.userMessage.content.trim() ||
        action.userMessage.role !== "user" ||
        action.assistantMessage.role !== "assistant" ||
        action.userMessage.id === action.assistantMessage.id ||
        getChatThread(state, action.threadId)?.messages.some(
          (message) =>
            message.id === action.userMessage.id || message.id === action.assistantMessage.id,
        )
      ) {
        return state;
      }
      const next = updateThread(state, action.threadId, (thread) => ({
        ...thread,
        title:
          thread.messages.some((message) => message.role === "user")
            ? thread.title
            : deriveChatThreadTitle(action.userMessage.content),
        model: thread.messages.length === 0 ? action.model : thread.model,
        messages: [...thread.messages, action.userMessage, action.assistantMessage],
        runStatus: "streaming",
        updatedAt: action.at,
      }));
      return {
        ...next,
        activeRun: {
          clientRunId: action.clientRunId,
          threadId: action.threadId,
          assistantMessageId: action.assistantMessage.id,
        },
      };
    }

    case "run.finish": {
      if (!matchesActiveRun(state, action)) return state;
      const next = updateThreadWithActivity(state, action.threadId, action.at, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === state.activeRun?.assistantMessageId
            ? finalizeAssistantMessage(message, action.outcome, action.error, action.at)
            : message,
        ),
        runStatus: action.outcome,
      }));
      return { ...next, activeRun: null };
    }
  }
}

function updateThread(
  state: ChatWorkspaceState,
  threadId: string,
  update: (thread: ChatThread) => ChatThread,
): ChatWorkspaceState {
  const thread = getChatThread(state, threadId);
  if (!thread) return state;
  const nextThread = update(thread);
  if (nextThread === thread) return state;
  return { ...state, threads: replaceThread(state.threads, nextThread) };
}

function updateThreadWithActivity(
  state: ChatWorkspaceState,
  threadId: string,
  at: string,
  update: (thread: ChatThread) => ChatThread,
): ChatWorkspaceState {
  return updateThread(state, threadId, (thread) => {
    const nextThread = update(thread);
    if (nextThread === thread) return thread;
    return {
      ...nextThread,
      updatedAt: at,
      unread: threadId === state.activeThreadId ? false : true,
      lastReadAt: threadId === state.activeThreadId ? at : thread.lastReadAt,
    };
  });
}

function replaceThread(threads: ChatThread[], nextThread: ChatThread): ChatThread[] {
  return threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread));
}

function mostRecentlyUpdated(threads: ChatThread[]): ChatThread {
  return threads.reduce((latest, thread) =>
    thread.updatedAt > latest.updatedAt ? thread : latest,
  );
}

function matchesActiveRun(
  state: ChatWorkspaceState,
  action: { clientRunId: string; threadId: string },
): boolean {
  return (
    state.activeRun?.clientRunId === action.clientRunId &&
    state.activeRun.threadId === action.threadId
  );
}

function finalizeAssistantMessage(
  message: ChatMessage,
  outcome: Exclude<ChatRunStatus, "idle" | "streaming">,
  error: string | undefined,
  at: string,
): ChatMessage {
  const toolStatus = outcome === "complete" ? "completed" : "error";
  const fallbackError =
    outcome === "interrupted"
      ? "Response stopped before completion."
      : outcome === "error"
        ? "The response failed before completion."
        : undefined;
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) =>
      toolCall.status === "running" ? { ...toolCall, status: toolStatus } : toolCall,
    ),
    error: error ?? message.error ?? fallbackError,
    updatedAt: at,
  };
}

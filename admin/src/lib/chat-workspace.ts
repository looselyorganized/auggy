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

export type ChatThreadSummary = Omit<ChatThread, "messages">;

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

const SCHEMA_VERSION = 1;
const KEY_PREFIX = "aug1-chat:";
const DEFAULT_MAX_MESSAGES = 200;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: { id: string; name: string; args?: string; result?: string; status: "running" | "completed" | "error" }[];
  error?: string;
}

export interface AgentHistory {
  threadId: string;
  messages: ChatMessage[];
  lastUpdated: string;
  agentMetadata: {
    name: string;
    description?: string;
    capabilities?: string[];
  };
}

interface StoredHistory extends AgentHistory {
  schema: typeof SCHEMA_VERSION;
}

export interface SaveOptions {
  maxMessages?: number;
}

function key(agentId: string, sourceName: string): string {
  return `${KEY_PREFIX}${agentId}@${sourceName}`;
}

export function loadAgentHistory(agentId: string, sourceName: string): AgentHistory | null {
  try {
    const raw = localStorage.getItem(key(agentId, sourceName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredHistory;
    if (parsed.schema !== SCHEMA_VERSION) return null;
    return {
      threadId: parsed.threadId,
      messages: parsed.messages,
      lastUpdated: parsed.lastUpdated,
      agentMetadata: parsed.agentMetadata,
    };
  } catch {
    return null;
  }
}

export function saveAgentHistory(
  agentId: string,
  sourceName: string,
  history: AgentHistory,
  opts: SaveOptions = {},
): void {
  const max = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const messages = history.messages.length > max
    ? history.messages.slice(history.messages.length - max)
    : history.messages;

  const stored: StoredHistory = {
    schema: SCHEMA_VERSION,
    threadId: history.threadId,
    messages,
    lastUpdated: history.lastUpdated || new Date().toISOString(),
    agentMetadata: history.agentMetadata,
  };
  localStorage.setItem(key(agentId, sourceName), JSON.stringify(stored));
}

export function clearAgentHistory(agentId: string, sourceName: string): void {
  localStorage.removeItem(key(agentId, sourceName));
}

export function clearAllHistory(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) toRemove.push(k);
  }
  toRemove.forEach(k => localStorage.removeItem(k));
}

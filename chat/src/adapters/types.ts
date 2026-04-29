import type { AGUIEvent } from "../lib/ag-ui-parse";

/**
 * A discovered agent — what the picker renders.
 *
 * `id` is unique within a source. For `localPidSource` it's the agent name
 * (matches the PID manifest filename). For future `spineRegistrySource` it's
 * the spine participant_id.
 */
export interface AgentRef {
  id: string;
  name: string;
  description?: string;
  capabilities?: string[];
  status: "online" | "offline" | "unknown";
  /** Source-specific opaque payload. Local: { port, agentDir, pid }. Network: { participant_id, ... }. */
  metadata: Record<string, unknown>;
}

/**
 * A source of agents. Picker calls `list()` to populate; optional `subscribe()`
 * notifies the picker when the source changes (e.g., a new aug1 booted, or a
 * spine participant came online).
 */
export interface AgentSource {
  /** UI label shown as a section header in the picker. */
  readonly label: string;
  /** Section ordering — lower = rendered earlier. Local source = 0; networks alphabetically after. */
  readonly order: number;
  /** Synchronously discover the current set of agents. Async to allow remote calls. */
  list(): Promise<AgentRef[]>;
  /** Optional: subscribe to source changes. Returns an unsubscribe function. */
  subscribe?(onChange: () => void): () => void;
}

/**
 * Options for streaming a chat message.
 */
export interface ChatStreamOptions {
  agent: AgentRef;
  message: string;
  threadId?: string;
  signal?: AbortSignal;
}

/**
 * A way to send a message and receive AG-UI events back.
 *
 * v1 ships `httpProxyConnection` which posts to the GUI server's own
 * `/api/chat/<id>` endpoint; the server attaches the bearer and proxies to
 * the agent's `/agent/run`.
 */
export interface AgentConnection {
  stream(opts: ChatStreamOptions): AsyncIterable<AGUIEvent>;
  /** Optional: declare which agents this connection serves. Used by future
   *  ConnectionRouter when multiple connections coexist. */
  supports?(agent: AgentRef): boolean;
}

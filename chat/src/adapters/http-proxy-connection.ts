import type { AgentConnection, ChatStreamOptions } from "./types";
import { parseSSEStream, type AGUIEvent } from "../lib/ag-ui-parse";

/**
 * Browser-side AgentConnection. Posts to `/api/chat/<agent-id>` on the chat
 * package's own GUI server (same-origin), which proxies to the agent's
 * `/agent/run` with bearer attached server-side.
 *
 * The browser never holds a bearer token.
 */
export const httpProxyConnection: AgentConnection = {
  async *stream(opts: ChatStreamOptions): AsyncIterable<AGUIEvent> {
    const res = await fetch(`/api/chat/${encodeURIComponent(opts.agent.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: opts.message, threadId: opts.threadId }),
      signal: opts.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        try {
          detail = (await res.text()).slice(0, 500);
        } catch {
          /* both attempts failed — body unreadable, fall through with empty detail */
        }
      }
      throw new Error(`Chat request failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    if (!res.body) throw new Error("Empty response body");
    yield* parseSSEStream(res.body, { signal: opts.signal });
  },
};

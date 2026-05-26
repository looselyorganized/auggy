import { useMemo } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { ChatWidget } from "@chat/components/ChatWidget";
import type {
  AgentConnection,
  AgentRef,
  ChatStreamOptions,
} from "@chat/adapters/types";
import { parseSSEStream } from "@chat/lib/ag-ui-parse";
// Pull in the chat widget's stylesheet so its CSS classes apply.
// This is the only place admin/ imports chat/'s styles; if/when the
// widget extracts into packages/chat-ui (task #29), the stylesheet moves
// with it.
import "@chat/index.css";

/**
 * Browser-side AgentConnection that POSTs to `/admin/api/chat` on this same
 * origin. The admin SSE proxy attaches the bearer server-side; the browser
 * never holds a token. Mirrors `chat/src/adapters/http-proxy-connection.ts`
 * but uses /admin's single-agent path shape.
 */
const adminChatConnection: AgentConnection = {
  async *stream(opts: ChatStreamOptions) {
    // Strip any URL-embedded userinfo so fetch() doesn't throw when the
    // operator authenticated via `http://:token@host/...`. Mirrors
    // admin/src/lib/api.ts's adminFetch.
    const base = new URL(window.location.href);
    base.username = "";
    base.password = "";
    const url = new URL("/admin/api/chat", base).toString();
    const res = await fetch(url, {
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
          /* unreadable body */
        }
      }
      throw new Error(
        `Chat request failed: ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
    if (!res.body) throw new Error("Empty response body");
    yield* parseSSEStream(res.body, { signal: opts.signal });
  },
};

/**
 * Chat tab — the live-state surface. Operator types; tool calls + memory
 * operations render as they happen via the AG-UI event stream.
 *
 * v1 path-imports the standalone ChatWidget from chat/src/components/.
 * v1.1 extracts the widget into packages/chat-ui (task #29) so this
 * cross-package import goes away.
 */
export function ChatTab() {
  const { data, loading, error } = useDashboardContext();

  const agentRef = useMemo<AgentRef | null>(() => {
    if (!data) return null;
    const name = data.agentMeta?.name ?? data.card.provider.name;
    return {
      id: data.agentMeta?.id ?? name,
      name,
      description: data.agentMeta?.purpose ?? data.card.provider.description,
      capabilities: undefined,
      status: "online",
      metadata: {},
    };
  }, [data]);

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Chat load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!agentRef) return null;

  // sourceName is the second half of the chat-store's persistence key
  // (`<agentId>@<sourceName>`). Use a stable string so the operator's
  // chat history survives reloads.
  const sourceName = "admin";

  return (
    <div className="flex h-full min-h-[600px] flex-col overflow-hidden rounded-md border bg-background">
      <ChatWidget
        agent={agentRef}
        sourceName={sourceName}
        connection={adminChatConnection}
      />
    </div>
  );
}

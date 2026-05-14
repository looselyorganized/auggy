# 20 — Embedding Auggy in your frontend

> A copy-paste recipe for wiring a Next.js (or any server-rendered) chat surface to a running Auggy agent. Three small files, two env vars, and you have a visitor-facing chat that streams AG-UI events from `/agent/run` without exposing your bearer token to the browser.

## When you'd use this

You're building a public-facing site — boutique store, HVAC dispatcher's customer portal, support page — and you want visitors to chat with an Auggy agent embedded in your site. The agent runs as a separate process (local launchd, Railway, etc.), and your site speaks to it over HTTP.

This is the pattern Zip used. Three files, all server-side; the browser only ever talks to your own origin.

## Architecture

```
   Browser                Your site                 Auggy agent
   ┌──────┐  POST          ┌─────────────┐  POST    ┌────────────┐
   │ chat │  /api/chat ───▶│ Next.js API │ ───────▶ │ /agent/run │
   │widget│ ◀──────────────│ proxy route │  ◀────── │ (port 8080)│
   └──────┘  SSE stream    └─────────────┘  SSE     └────────────┘
                              │
                              │ holds:
                              │   AUGGY_AGENT_URL
                              │   AUGGY_AGENT_TOKEN  ← bearer; never reaches browser
```

The browser POSTs JSON to your own `/api/chat` endpoint. That endpoint:
1. Adds your bearer (`Authorization: Bearer <token>`) before forwarding to the agent.
2. Streams the agent's SSE response back to the browser unchanged.

The bearer never leaves the server. The browser sees a same-origin endpoint and a clean SSE event stream.

## The three files

### 1. Server-side proxy: `app/api/chat/route.ts`

```ts
/**
 * Chat API proxy — forwards browser requests to an Auggy agent's AG-UI
 * endpoint and streams the SSE response back. The bearer token lives in
 * server-side env vars and never reaches the browser.
 */

const AGENT_URL = process.env.AUGGY_AGENT_URL; // e.g. "http://localhost:8080"
const AGENT_TOKEN = process.env.AUGGY_AGENT_TOKEN; // bearer token from agent .env

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!AGENT_URL || !AGENT_TOKEN) {
    return errorResponse(
      503,
      "Chat is not configured. AUGGY_AGENT_URL and AUGGY_AGENT_TOKEN must be set.",
    );
  }

  let body: { messages?: unknown; threadId?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON in request body.");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "Request must include a non-empty messages array.");
  }

  // Validate message shape. Browsers should only POST `user`-role messages —
  // restrict to that so a hostile client can't smuggle synthetic assistant or
  // system content into the conversation history.
  for (const msg of body.messages) {
    if (
      typeof msg !== "object" ||
      msg === null ||
      typeof (msg as Record<string, unknown>).role !== "string" ||
      typeof (msg as Record<string, unknown>).content !== "string"
    ) {
      return errorResponse(400, "Each message must have a string role and content.");
    }
    if ((msg as Record<string, unknown>).role !== "user") {
      return errorResponse(400, "Only 'user' role messages are allowed.");
    }
  }

  const agentRunUrl = `${AGENT_URL}/agent/run`;

  let agentResponse: Response;
  try {
    agentResponse = await fetch(agentRunUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AGENT_TOKEN}`,
        // Mint a per-request visitor identifier. The agent uses this for
        // memory scoping (anonymous visitors get peer.id = anon-<thread>).
        // If you have a stable visitor id (e.g. a session cookie), use it
        // here instead of crypto.randomUUID().
        "x-peer-id": `visitor-${crypto.randomUUID()}`,
        "x-peer-kind": "human",
        "x-peer-name": "visitor",
      },
      body: JSON.stringify({
        messages: body.messages,
        threadId: body.threadId,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("abort") || message.includes("timeout")) {
      return errorResponse(504, "Agent did not respond within 120 seconds.");
    }
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      return errorResponse(
        502,
        "Agent is not reachable. Check that it is running with `auggy status`.",
      );
    }
    return errorResponse(502, `Failed to connect to agent: ${message}`);
  }

  if (!agentResponse.ok) {
    const errorMessages: Record<number, string> = {
      401: "Authentication failed. Check AUGGY_AGENT_TOKEN.",
      413: "Message is too long. The agent rejected it.",
      429: "Rate limited. Too many messages — wait a moment and try again.",
      503: "Agent is busy. Try again in a moment.",
    };
    const message =
      errorMessages[agentResponse.status] ??
      `Agent returned ${agentResponse.status} ${agentResponse.statusText}. Check agent logs.`;
    return errorResponse(agentResponse.status >= 500 ? 502 : agentResponse.status, message);
  }

  if (!agentResponse.body) {
    return errorResponse(502, "Agent returned an empty response.");
  }

  return new Response(agentResponse.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
```

This is the *entire* server-side surface. Everything else is client UI.

### 2. Client widget: `components/chat/ChatWidget.tsx`

```tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: string;
  streaming?: boolean;
}

interface AGUIEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Parses one SSE `data:` line into an AG-UI event. Returns null for the
 * `[DONE]` sentinel and for malformed JSON (logged + skipped).
 */
function parseSSELine(line: string): AGUIEvent | null {
  if (!line.startsWith("data: ")) return null;
  const json = line.slice(6);
  if (json === "[DONE]") return null;
  try {
    return JSON.parse(json) as AGUIEvent;
  } catch {
    console.warn("[chat] malformed AG-UI event:", json);
    return null;
  }
}

export function ChatWidget() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);
  useEffect(() => scrollToBottom(), [messages, scrollToBottom]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
          threadId: threadIdRef.current,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as { error?: string };
        const errorMessage = errBody.error ?? `Request failed (${response.status})`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, error: errorMessage, streaming: false } : m,
          ),
        );
        return;
      }

      if (!response.body) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, error: "Empty response.", streaming: false } : m,
          ),
        );
        return;
      }

      // Read the SSE stream, parse AG-UI events, update message state as
      // text chunks arrive. The minimum subset of AG-UI events you need to
      // handle is shown below; the full set (TOOL_CALL_*, STATE_*, etc.) is
      // in docs/06-transports.md.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseSSELine(line.trim());
          if (!event) continue;
          switch (event.type) {
            case "RUN_STARTED":
              if (typeof event.threadId === "string") threadIdRef.current = event.threadId;
              break;
            case "TEXT_MESSAGE_CONTENT":
            case "TEXT_MESSAGE_DELTA": {
              const delta = typeof event.delta === "string" ? event.delta : "";
              if (delta) {
                assistantContent += delta;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: assistantContent } : m,
                  ),
                );
              }
              break;
            }
            case "TEXT_MESSAGE_END":
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
              );
              break;
            case "RUN_ERROR": {
              const errMsg = typeof event.message === "string" ? event.message : "Run error";
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, error: errMsg, streaming: false } : m,
                ),
              );
              break;
            }
            case "RUN_FINISHED":
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
              );
              break;
            // TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END / TOOL_CALL_RESULT
            // are also emitted by the agent when it uses tools. The full
            // shape is in docs/06-transports.md. A minimal widget can ignore
            // them (the agent's final TEXT_MESSAGE_* is the user-visible reply).
            default:
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, error: (err as Error).message, streaming: false }
              : m,
          ),
        );
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div>
        {messages.map((m) => (
          <div key={m.id}>
            <strong>{m.role}:</strong> {m.content}
            {m.error && <span style={{ color: "red" }}> ({m.error})</span>}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
```

Style it however you like — this is the bare structural component. Reference: the production Zip widget at `platform/src/components/chat/ChatWidget.tsx` in the LORF repo, which adds tool-call rendering, scroll-to-bottom polish, and Tailwind styling on top of the same parsing logic.

### 3. Page hosting the widget: `app/chat/page.tsx`

```tsx
import { ChatWidget } from "@/components/chat/ChatWidget";

export default function ChatPage() {
  return (
    <main>
      <h1>Chat</h1>
      <ChatWidget />
    </main>
  );
}
```

That's it.

## Environment setup

### Frontend (your site)

Two env vars in your frontend's `.env`:

```
AUGGY_AGENT_URL=http://localhost:8080            # local dev
# or
AUGGY_AGENT_URL=https://<your-agent>.up.railway.app   # cloud

AUGGY_AGENT_TOKEN=<the bearer from your agent's .env>
```

`AUGGY_AGENT_TOKEN` MUST match the agent's `AUGGY_WEB_TOKEN` env var (set when you scaffolded the agent with `auggy create`). Get it from `<agent-dir>/.env`.

### Agent (the Auggy side)

In `agent.yaml`, the `webTransport` augment must be configured with the same token:

```yaml
- name: web
  type: webTransport
  options:
    port: 8080
    auth:
      type: bearer
      token: ${AUGGY_WEB_TOKEN}      # ← matches frontend's AUGGY_AGENT_TOKEN
```

That field is already in the scaffold default. Nothing extra to do unless you're customizing.

## Trust posture & visitorAuth

The proxy mints `x-peer-id: visitor-<random-uuid>` on every request, which the agent resolves to `trustLevel: "public"` with `publicSubstate: "anonymous"`. That's the default visitor experience — the agent can chat, recall anonymous-scope memory for the current threadId, and call low-trust tools.

To let visitors upgrade to recognized identity (email-verified, persistent memory across sessions), mount the `visitorAuth` augment on the agent side and tell your widget to forward the `x-visitor-token` header it receives back:

```ts
// In your /api/chat route, after the SSE response is built:
const issuedToken = agentResponse.headers.get("x-visitor-token");
const responseHeaders: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};
if (issuedToken) responseHeaders["x-visitor-token"] = issuedToken;
return new Response(agentResponse.body, { status: 200, headers: responseHeaders });
```

And on the client side, persist that token (e.g., `localStorage`) and send it on subsequent requests. See `docs/19-visitor-auth.md` for the full flow.

## Security notes

- **Bearer stays on the server.** The browser only POSTs to your own `/api/chat`. If you ever find yourself putting `AUGGY_AGENT_TOKEN` in client code, you've leaked the bearer to anyone who views source.
- **`user`-role messages only.** The proxy validates that every message has `role: "user"`. A malicious client cannot smuggle synthetic `assistant` or `system` messages into the conversation.
- **CORS / origin checks.** If you serve your frontend and your agent on different origins, configure `webTransport.cors.origins` to your frontend's origin only. Wildcard origins on a bearer-protected endpoint are dangerous — anyone can host a page that forwards their visitors' requests through your bearer.
- **Visitor auth on public deploys.** If you deploy to Railway/Fly with anonymous chat (`webTransport.allowAnonymous: true` or default-allow in non-production), expect drive-by traffic. The budgets augment caps cost ($5/day default, 30 anonymous turns/day); visitorAuth gives genuine visitors an upgrade path.
- **Don't expose the agent port directly.** The whole point of this proxy pattern is that the agent's `/agent/run` is reached *through* your bearer-attaching server. Exposing port 8080 publicly without a proxy in front would defeat the purpose (anyone with the bearer chats; anyone without sees the bearer requirement).

## Non-Next.js stacks

The pattern is the same in any server-rendered framework. The shape of the proxy:

- **Express / Hono / Fastify**: a `POST /api/chat` route that adds the `Authorization` + `x-peer-*` headers and streams the upstream response body unchanged.
- **Cloudflare Workers / Vercel Edge**: same pattern; just rewrite the Next.js `Response` handling to your runtime's equivalent.
- **Pure browser (no server)**: not viable without leaking the bearer. The minimal alternative is to mount `webTransport.allowAnonymous: true` AND `visitorAuth` on the agent and skip the bearer entirely — visitors authenticate via the visitor-auth magic-link flow before sending messages.

## Troubleshooting

- **`401 Authentication failed`** — `AUGGY_AGENT_TOKEN` doesn't match `<agent-dir>/.env`'s `AUGGY_WEB_TOKEN`. Confirm both files.
- **`502 Agent is not reachable`** — agent isn't running. Run `auggy status`; if empty, `auggy dev <name>` or `auggy start <name>`.
- **`504 Agent did not respond within 120 seconds`** — the agent's first turn is taking too long (cold model start, very long tool execution). Increase the proxy's `AbortSignal.timeout(...)` and the agent's `webTransport.idleTimeout` (default 120s).
- **`429 Rate limited`** — you've hit a budget cap. Check `webTransport.rateLimitPerPeer` and the `budgets` augment's `maxTurnsPerThread` / `dailyBudgetUsd`.
- **Browser fetch hangs without ever responding** — usually a proxy buffering issue. Confirm your hosting platform doesn't buffer SSE (Vercel/Cloudflare are fine; some corporate proxies break SSE).

## Cross-references

- **Wire protocol details**: [`docs/06-transports.md`](./06-transports.md) — full AG-UI event shape, all four identity paths, the bearer policy.
- **Visitor recognition flow**: [`docs/19-visitor-auth.md`](./19-visitor-auth.md) — magic-link verification, console-adapter for OSS testing.
- **Operator-side chat** (not visitor-side): [`docs/15-chat.md`](./15-chat.md) — `auggy chat` Local GUI, which is the *creator's* chat surface, not for production embedding.

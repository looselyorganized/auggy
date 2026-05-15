# 20 — Embedding Auggy in your frontend

> The copy-paste recipe for wiring a Next.js (or any server-rendered) chat surface to a running Auggy agent so **public visitors** can chat. Visitors resolve to `public/anonymous` → `public/recognized` on the agent; the operator's bearer never leaves the agent host. This is the boutique store / dispatcher / front-door use case.

## This doc covers visitor chat. For operator chat, see the matrix.

Auggy's auth model is single-credential: the bearer in `<agent-dir>/.env` (`AUGGY_WEB_TOKEN`) is the operator credential. There is no separate operator account or framework integration. The channels operators use to chat with their own agent are:

| Operator wants to… | Today | Post-G36 |
|---|---|---|
| Chat from the agent's host machine | `auggy chat` (Local GUI) | `auggy chat` (unchanged) |
| Chat from anywhere on a phone | Telegram (`telegramTransport`) | Telegram OR `/admin` basic-auth |
| Chat from anywhere in a browser | (gap) | `/admin` route + native basic-auth prompt |
| Let public visitors chat | **This doc's recipe** | Same |

If you came here looking for "how do I chat with my own agent" — use `auggy chat` or `telegramTransport`. The recipe below is specifically for exposing chat to anonymous visitors.

---

# The recipe

## Agent-side configuration

In `agent.yaml`:

```yaml
augments:
  - name: web
    type: webTransport
    options:
      port: 8080
      auth:
        type: bearer
        token: ${AUGGY_WEB_TOKEN}      # still required, but never reaches the browser
      allowAnonymous: true             # G3 — explicit opt-in to anonymous traffic
      visitorTokens:
        agentBinding: ${AUGGY_AGENT_ID}
        # signingKey injected at boot by visitorAuth — don't set here

  - name: visitor-auth
    type: visitorAuth
    options:
      publicUrl: ${AUGGY_PUBLIC_URL}   # MUST be the URL visitors actually hit
      dbPath: ./visitor-auth.db
      signingKey: ${VISITOR_SIGNING_KEY}
      agentBinding: ${AUGGY_AGENT_ID}
      layeredMemoryDbPath: ./memory.db
      agentMail:
        # For local development without an AgentMail account, use console mode (G34).
        # The verify URL prints to the agent's stdout; copy it into your browser.
        transport: "console"
        # Production: replace with apiKey + inboxId, see docs/19-visitor-auth.md
```

**Note on `allowAnonymous`**: G3's default rule is `NODE_ENV !== "production"`, so this works out of the box in local dev. For cloud deployment, set `allowAnonymous: true` explicitly in yaml (because cloud platforms set `NODE_ENV=production`), AND set `AUGGY_PUBLIC_URL` to your operator-facing URL. visitorAuth's production safeguard refuses the console adapter on a public host — set `allowConsoleInProduction: true` to acknowledge or (recommended) switch to AgentMail credentials for production.

## Frontend proxy code (NO bearer, server-minted threadId, idempotency)

`app/api/chat/route.ts`:

```ts
/**
 * Visitor chat proxy — public traffic.
 *
 * Does NOT attach `Authorization: Bearer …`. Visitor traffic resolves to
 * `public/anonymous` (or `public/recognized` after token rotation) on the agent.
 *
 * Hardening (codex-reviewed):
 *  - `threadId` is server-minted and bound via an HttpOnly signed cookie. The
 *    browser cannot pick its own threadId, so it cannot collide-with / hijack
 *    another anonymous visitor's identity namespace.
 *  - `Idempotency-Key` is forwarded so retries don't double-count budget.
 *  - `x-visitor-token` is forwarded both ways for returning-visitor continuity.
 */

import { createHmac } from "node:crypto";

const AGENT_URL = process.env.AUGGY_AGENT_URL; // e.g. "http://localhost:8080"
const SESSION_SECRET = process.env.AUGGY_SESSION_SECRET; // openssl rand -hex 32

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

/**
 * Signed-cookie helpers. Cookie value format: `<threadId>.<HMAC>`.
 * Stateless — no server-side session store. Rotating SESSION_SECRET
 * invalidates all existing threads (visitors get fresh anonymous identities;
 * no security issue because anonymous identity is ephemeral by design).
 */
function signThread(threadId: string): string {
  const sig = createHmac("sha256", SESSION_SECRET!).update(threadId).digest("base64url");
  return `${threadId}.${sig}`;
}

function verifyThread(cookieValue: string | null): string | null {
  if (!cookieValue) return null;
  const lastDot = cookieValue.lastIndexOf(".");
  if (lastDot < 0) return null;
  const threadId = cookieValue.slice(0, lastDot);
  const presented = cookieValue.slice(lastDot + 1);
  const expected = createHmac("sha256", SESSION_SECRET!).update(threadId).digest("base64url");
  if (presented.length !== expected.length) return null;
  // Timing-safe compare so attackers can't probe the HMAC byte-by-byte.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? threadId : null;
}

function readThreadCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)auggy-thread=([^;]+)/);
  if (!m) return null;
  // Malformed percent-encoded cookies (e.g. `%ZZ`) make decodeURIComponent
  // throw URIError. Treat them as "no cookie" so the proxy mints a fresh
  // threadId instead of returning 500 to the visitor.
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!AGENT_URL || !SESSION_SECRET) {
    return errorResponse(
      503,
      "This recipe requires AUGGY_AGENT_URL and AUGGY_SESSION_SECRET. " +
        "Generate the secret with `openssl rand -hex 32` and set it on the frontend.",
    );
  }

  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON in request body.");
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "Request must include a non-empty messages array.");
  }

  // Restrict to user-role messages — a hostile client cannot smuggle
  // synthetic assistant or system messages into the conversation history.
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

  // Resolve threadId: existing signed cookie wins, else mint one.
  // Browser-supplied `body.threadId` is IGNORED — letting the browser pick
  // threadId is a memory-namespace collision attack (one anonymous visitor
  // joins another's transcript / scoped memory).
  const existing = verifyThread(readThreadCookie(request.headers.get("cookie")));
  const threadId = existing ?? crypto.randomUUID();
  const setCookie = existing
    ? null
    : `auggy-thread=${encodeURIComponent(signThread(threadId))};` +
      ` HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` +
      (request.url.startsWith("https:") ? "; Secure" : "");

  // Forward visitor token (continuity) + idempotency key (cost dedup).
  // Idempotency-Key origin is the CLIENT (per user-send). Stable across the
  // widget's retries; the proxy just relays it.
  const visitorToken = request.headers.get("x-visitor-token") || "bootstrap";
  const idempotencyKey = request.headers.get("idempotency-key");

  let agentResponse: Response;
  try {
    const upstreamHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-visitor-token": visitorToken,
    };
    if (idempotencyKey) upstreamHeaders["idempotency-key"] = idempotencyKey;

    agentResponse = await fetch(`${AGENT_URL}/agent/run`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({ messages: body.messages, threadId }), // ← server-minted
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("abort") || message.includes("timeout")) {
      return errorResponse(504, "Agent did not respond within 120 seconds.");
    }
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      return errorResponse(502, "Agent is not reachable. Check `auggy status`.");
    }
    return errorResponse(502, "Failed to connect to agent.");
  }

  if (!agentResponse.ok) {
    const errorMessages: Record<number, string> = {
      401: "Unauthorized. Check that allowAnonymous is enabled on the agent.",
      413: "Message is too long.",
      429: "Rate limited. Try again in a moment.",
      503: "Agent is busy. Try again in a moment.",
    };
    const message =
      errorMessages[agentResponse.status] ?? `Agent returned ${agentResponse.status}.`;
    return errorResponse(agentResponse.status >= 500 ? 502 : agentResponse.status, message);
  }

  if (!agentResponse.body) {
    return errorResponse(502, "Agent returned an empty response.");
  }

  const responseHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  const issuedToken = agentResponse.headers.get("x-visitor-token");
  if (issuedToken) responseHeaders["x-visitor-token"] = issuedToken;
  if (setCookie) responseHeaders["set-cookie"] = setCookie;
  return new Response(agentResponse.body, { status: 200, headers: responseHeaders });
}
```

## Cross-origin: reverse-proxy the visitor-auth verify route

When your frontend and your agent are on different origins (e.g., `myshop.com` and `myshop-agent.up.railway.app`), the visitorAuth verify-page writes the upgraded `vis_<uuid>` token to `localStorage` **on the page's origin** — which is the AGENT's origin. Your chat widget on the frontend origin cannot read that token (browser Same-Origin Policy).

**You must reverse-proxy `/visitor-auth/verify` through your frontend** so the verify page is served from the frontend origin. Then `localStorage` is shared with the chat widget.

`app/visitor-auth/verify/route.ts` (Next.js App Router):

```ts
/**
 * Reverse-proxy visitorAuth's verify route to the agent. Streams the agent's
 * HTML response back. Critical for cross-origin deploys — the verify success
 * page writes localStorage on the page's origin, so it must be served from
 * THIS origin (the frontend's), not the agent's.
 *
 * Header hardening (codex-reviewed):
 *  - Request: ALLOWLIST forwarded headers. Do NOT pass `request.headers` through
 *    wholesale — that leaks the frontend origin's cookies and any ambient auth
 *    headers to the agent service, where they land in the agent's runtime logs.
 *  - Response: STRIP `set-cookie` and `authorization`. The agent must not be
 *    able to set cookies on the frontend origin or influence its auth surface.
 */
const AGENT_URL = process.env.AUGGY_AGENT_URL;

async function forward(request: Request): Promise<Response> {
  if (!AGENT_URL) return new Response("AUGGY_AGENT_URL not configured", { status: 503 });
  const url = new URL(request.url);
  const upstream = `${AGENT_URL}/visitor-auth/verify${url.search}`;

  // Allowlist: only `content-type` is needed for the form-POST flow. Strip
  // everything else — cookies, authorization, host, x-forwarded-*, etc.
  const forwardHeaders: Record<string, string> = {};
  const ct = request.headers.get("content-type");
  if (ct) forwardHeaders["content-type"] = ct;

  const init: RequestInit = { method: request.method, headers: forwardHeaders };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const resp = await fetch(upstream, init);

  // Strip set-cookie / authorization on the response. Agent should not set
  // cookies on the frontend origin or echo auth material back.
  const respHeaders = new Headers();
  const ctOut = resp.headers.get("content-type");
  if (ctOut) respHeaders.set("content-type", ctOut);
  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}

export const GET = forward;
export const POST = forward;
```

The agent's email-template URL must use YOUR frontend's hostname (not the agent's). Set this via `visitorAuth.publicUrl` in `agent.yaml`:

```yaml
- name: visitor-auth
  type: visitorAuth
  options:
    publicUrl: https://myshop.com    # NOT the agent's URL
    # …
```

The agent will mint magic links like `https://myshop.com/visitor-auth/verify?token=…`. The visitor clicks → lands on YOUR origin → reverse-proxy forwards to the agent → agent returns success page → success page writes `localStorage['auggy-visitor-token']` on YOUR origin. The chat widget reads it on the next message.

## Client widget (with visitor-token continuity)

`components/chat/ChatWidget.tsx`:

```tsx
"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const VISITOR_TOKEN_KEY = "auggy-visitor-token";

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

function parseSSELine(line: string): AGUIEvent | null {
  if (!line.startsWith("data: ")) return null;
  const json = line.slice(6);
  if (json === "[DONE]") return null;
  try {
    return JSON.parse(json) as AGUIEvent;
  } catch {
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

    // Read the current visitor token from localStorage. On first contact this
    // is null; the proxy sends "bootstrap" and the agent mints a fresh token,
    // which arrives in the response `x-visitor-token` header.
    const currentToken = localStorage.getItem(VISITOR_TOKEN_KEY);

    // Mint an Idempotency-Key for THIS user-send, stable across any retries
    // of this send (per-send, not per-fetch). The runtime uses this to dedup
    // BUDGET RESERVATIONS on retry. NOTE: it does NOT cache turn results — the
    // model is re-called on retry, tools re-execute, fresh tokens billed
    // (just not against caps). See doc's "Idempotency" section for the truth.
    const idempotencyKey = crypto.randomUUID();

    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    };
    if (currentToken) requestHeaders["x-visitor-token"] = currentToken;

    // NOTE: we no longer send `threadId` in the body — the proxy mints it
    // server-side and binds via signed cookie. Letting the browser pick its
    // own threadId would be a memory-namespace collision attack surface.
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
        }),
        signal: controller.signal,
      });

      // Persist freshly-issued visitor token so subsequent requests carry it.
      const newToken = response.headers.get("x-visitor-token");
      if (newToken) localStorage.setItem(VISITOR_TOKEN_KEY, newToken);

      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as { error?: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, error: errBody.error ?? `Request failed (${response.status})`, streaming: false }
              : m,
          ),
        );
        return;
      }

      if (!response.body) return;

      // Parse the AG-UI SSE stream. The minimum subset of events you need
      // to handle for a basic chat UI is shown below; the full set is
      // documented in docs/06-transports.md.
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
            case "RUN_FINISHED":
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
            // TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END / TOOL_CALL_RESULT
            // are also emitted by the agent during tool use. A minimal widget
            // can ignore them (the agent's final TEXT_MESSAGE_* is the reply).
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

## What the agent sees (identity flow)

| Request | trustLevel | publicSubstate | peer.id |
|---|---|---|---|
| First contact: `x-visitor-token: bootstrap`; proxy mints threadId server-side | `public` | `anonymous` | `anon-<server-minted-threadId>` |
| Second request: client sends the rotated token from previous response | `public` | `recognized` | `vis_<uuid>` (stable, from token payload) |
| After visitor-auth email verification + reverse-proxied verify route | `public` | `recognized` | `vis_<uuid>` from the visitorAuth-minted token |

The agent **never** mints `creator` trust for traffic that comes through this recipe, because the proxy never attaches the bearer. The `visitor-auth` upgrade preserves anonymous history under the peer-id migration that visitorAuth runs at verify time (see `docs/19-visitor-auth.md`).

## Idempotency (what `Idempotency-Key` actually does)

The widget sends an `Idempotency-Key` header per user-send (stable across retries of THAT send). The proxy forwards it; the agent runtime threads it through as `turnId`. **What this gets you, precisely:**

| | Behavior |
|---|---|
| **Duplicate `Idempotency-Key` arrives on a retry** | The budgets store detects the existing reservation row keyed by this turnId and returns the cached admit/deny decision **without re-debiting caps**. Cost reservations are not double-counted. |
| **Model still re-called on retry?** | **Yes.** The kernel does not cache turn results. The second request runs the full turn loop — fresh inference, fresh tokens, fresh tool execution. |
| **Tool calls re-executed?** | **Yes.** If your tools have irreversible side effects (Shopify order modification, payment capture, Telegram alert), retries CAN duplicate them. |
| **What does this mitigate?** | Budget double-counting only. Useful but not full retry-safety. |

**Operator guidance:** treat `Idempotency-Key` as a cost-safety mechanism, not a side-effect-safety mechanism. If your tool surface includes irreversible operations, design those tools idempotently themselves (e.g., natural deduplication via your own request IDs) — don't lean on `Idempotency-Key` alone.

The full kernel-level result cache is on the v1.x roadmap. v1.0 ships budget-only dedup.

## Frontend environment

```
AUGGY_AGENT_URL=http://localhost:8080
AUGGY_SESSION_SECRET=<openssl rand -hex 32>
```

`AUGGY_SESSION_SECRET` signs the HttpOnly `auggy-thread` cookie that binds each visitor to a server-minted threadId. Generate once with `openssl rand -hex 32`; keep it stable. Rotating it invalidates all existing anonymous threads (visitors silently get fresh anonymous identities; no security issue because anonymous identity is ephemeral by design). **No bearer token** is needed — this recipe relies on `allowAnonymous` on the agent + the budgets + visitor-token machinery.

---

# The identity model (corrected from earlier docs)

`webTransport.identify()` has four mutually-exclusive paths. **Header `x-peer-id` is IGNORED** by identity resolution (it's accepted by CORS allow-list for compatibility but the runtime does not read it for identity).

| Path | Trigger | trustLevel | peer.id |
|---|---|---|---|
| **1 Creator** | Valid bearer (`Authorization: Bearer …`) matches `webTransport.auth.token`, AND no `x-visitor-token`, AND no `x-agent-*` headers | `creator` | hardcoded `"creator"` |
| **2 Agent** | `x-agent-id` + matching `x-agent-secret` (timing-safe) | `agent` | `"agent:" + x-agent-id` |
| **3 Public/recognized** | Valid HMAC-signed `x-visitor-token` (not revoked, `agentBinding` matches) | `public` + `recognized` | `payload.visitorId` from the token (stable across requests) |
| **4 Public/anonymous** | Default — fallback when above don't match. Includes (a) admitted-by-`allowAnonymous` with no bearer, and (b) bearer-validated with present-but-invalid visitor token | `public` + `anonymous` | `"anon-" + threadId` |

What other headers do:
- `x-peer-name` — cosmetic `displayName`, all paths. Does NOT affect trust.
- `x-peer-kind` — `kind` field (`"human"` / `"agent"` / etc.). Path 2 overrides to `"agent"`. Does NOT affect trust.
- `x-org-id` — cosmetic `orgId`, all paths.
- **`x-peer-id` — accepted but unused.** Do NOT rely on this for identity scoping; use `threadId` for anonymous continuity or `x-visitor-token` for durable identity.

## CORS clarification

`webTransport.cors.origins: [...]` sets `Access-Control-Allow-Origin` response headers. **It does NOT gate or reject requests by Origin.** It's a browser hint signaling whether cross-origin clients are permitted to read the response. The real auth gates are:

1. Bearer match (`webTransport.auth.token`)
2. Visitor-token HMAC validity (`webTransport.visitorTokens.signingKey`)
3. Anonymous-budget caps (`budgets.dailyBudgetUsd`, `budgets.anonymousGlobalLimit`)
4. Per-route rate limits (`webTransport.rateLimitPerPeer`)

CORS doesn't appear on that list. If you need server-side origin enforcement, add it explicitly at your proxy layer; the transport doesn't do it for you.

---

# Hardening checklist

## Credential-leak vectors

- **Bearer stays on the agent host:** the recipe proxy never attaches `Authorization: Bearer …`. Verify by opening browser devtools → network tab → confirm `Authorization` header is absent on `/api/chat` requests. The operator's bearer lives in `<agent-dir>/.env` and is only used for operator surfaces (`auggy chat`, `telegramTransport`, future `/admin`).
- **Visitor token in localStorage is XSS-exfiltratable:** an XSS bug in your widget gives the attacker the visitor's token, redeemable for the token's TTL. Mitigate by (a) shortening `visitorTokens.ttlSeconds` from the 30-day default, (b) keeping a strict CSP on the chat page, (c) using `auggy visitors --revoke <email>` if you detect compromise. The `revocationCheck` callback (already wired) ensures revoked tokens are inert without waiting for TTL expiry.
- **Verify-route reverse-proxy header tunneling:** the verify reverse-proxy MUST allowlist forwarded headers. NEVER pass `headers: request.headers` wholesale — that forwards the frontend origin's cookies and any ambient auth headers to the agent service, where they land in the agent's runtime logs and log-shipping pipelines. The recipe code above strips everything except `content-type`; mirror that allowlist in any framework variant.
- **Error message forwarding:** the proxy maps upstream HTTP statuses to canned messages. Never forward raw `error.detail` strings — those may contain operator-side context (file paths, DB error messages) that should stay server-side.
- **Referrer leakage:** visitor tokens MUST live in localStorage, never in URL fragments or query strings. URLs leak via `Referer` headers; localStorage does not.
- **Logs:** the agent does not log token values to stdout (validated). If you add custom logging, never log the contents of `x-visitor-token` or `Authorization`.
- **`AUGGY_SESSION_SECRET` rotation:** rotating the secret invalidates all existing anonymous threads. Visitors silently get fresh anonymous identities. No security issue (anonymous identity is ephemeral by design), but it does mean visitors lose conversation continuity until they re-verify via visitor-auth.

## Auth-workaround vectors

- **Replay attacks on stolen visitor tokens:** default 30-day TTL; consider shortening for higher-value deployments. visitorAuth supports revocation via `auggy visitors --revoke <email>`; the `revocationCheck` is consulted on every request.
- **CSRF (cross-site request forgery):** the recipe is CSRF-resistant — visitor tokens live in localStorage (not cookies, so a malicious site cannot read them) and the bearer never reaches the browser. If you change the storage mechanism, re-evaluate: cookie-backed tokens would need `SameSite=Strict` + CSRF tokens.
- **Origin spoofing:** CORS does NOT gate requests by origin. The recipe relies on anonymous-budget caps + visitor-token rotation, not origin checks. If you want origin enforcement, add it explicitly at the proxy.
- **Forged `x-peer-name` / `x-peer-kind`:** cosmetic only. Do NOT use them as rate-limit keys or identity proxies.
- **Browser-chosen `threadId` is NOT allowed:** the proxy server-mints threadIds and binds via signed cookie. Browser-supplied `body.threadId` is IGNORED. Without this safeguard, a malicious visitor can craft a colliding threadId → join another anonymous visitor's identity / memory namespace / per-thread limits. The recipe code enforces this; do not "simplify" it by trusting browser-supplied threadId.
- **Anonymous-budget evasion:** a visitor can attempt to bypass per-thread limits by clearing cookies to get a fresh threadId on each request. `anonymousGlobalLimit` (default 30 turns/day across ALL anonymous traffic) caps the total; `dailyBudgetUsd` (default $5) is the hard wall.
- **Idempotency is cost-safe, NOT side-effect-safe:** `Idempotency-Key` dedups budget reservations only. The model is re-called on retry, tools re-execute, fresh tokens billed (against future cap window, not the current one). Design irreversible tools (payments, order modifications) with their own idempotency keys — do not lean on `Idempotency-Key` alone.

## Coherence with shipped Tier 1 features

- The recipe REQUIRES `allowAnonymous: true` (G3). For local dev `NODE_ENV` unset → defaults to `true`. For cloud deploy (`NODE_ENV=production`) → must be set explicitly in yaml.
- The visitor-auth flow runs **fine in local dev with the console adapter** (G34): `agentMail.transport: "console"` prints the verify URL to stdout instead of sending email. The reverse-proxied verify route still applies in this case.
- The `/visitor-auth/verify` localStorage handoff REQUIRES reverse-proxying through the frontend origin (see "Cross-origin" section above).

---

# Tested reference

The end-to-end flow described here is verified by `tests/integration/embedding-recipe.test.ts`, which boots a real agent + a small inline HTTP proxy and asserts that:

- A request without bearer + placeholder `x-visitor-token` → `public/anonymous`, fresh token in response
- Subsequent request with rotated token → `public/recognized`, stable `peer.id`
- visitorAuth flow (using G34's console adapter) → upgraded `vis_<uuid>` token
- `x-peer-id` is ignored for identity regardless of the request shape
- A malformed `auggy-thread` cookie (e.g. `auggy-thread=%ZZ`) → fresh threadId minted, NOT 500

If you change the recipe, run the integration test to confirm the documented claims still hold.

---

# Non-Next.js stacks

Same pattern in any server-rendered framework:

- **Express / Hono / Fastify**: a `POST /api/chat` route that mimics the proxy code above. The shape is identical.
- **Cloudflare Workers / Vercel Edge**: same pattern. Both support streaming `Response.body` pass-through.
- **Pure browser, no server**: you can technically run a browser-only chat that talks directly to the agent's `/agent/run` if the agent has `cors.origins` set and `allowAnonymous: true`. The reverse-proxy requirement for `/visitor-auth/verify` is mooted (same origin from the browser's perspective). This is an OK pattern for a self-hosted internal tool; less safe for public traffic because per-origin enforcement is absent and the proxy's server-minted threadId / signed-cookie binding goes away.

---

# Troubleshooting

- **`401 Unauthorized`** — agent doesn't have `allowAnonymous: true`. Either set it in yaml or `AUGGY_ALLOW_ANONYMOUS=true` env var.
- **`502 Agent is not reachable`** — agent isn't running. Run `auggy status`; if empty, `auggy dev <name>` or `auggy start <name>`.
- **`504 Agent did not respond within 120 seconds`** — turn taking too long. Increase `AbortSignal.timeout(...)` in proxy and `webTransport.idleTimeout` (default 120s).
- **`429 Rate limited`** — budget cap hit. Check `webTransport.rateLimitPerPeer`, `budgets.maxTurnsPerThread`, `budgets.dailyBudgetUsd`.
- **Visitor email verification "works" but next message loses identity** — almost certainly the cross-origin localStorage problem. Confirm you've reverse-proxied `/visitor-auth/verify` through your frontend origin AND that `visitorAuth.publicUrl` in yaml is your frontend URL (NOT the agent's URL).
- **Browser fetch hangs without ever responding** — usually a proxy buffering issue. Vercel/Cloudflare are fine for SSE; some corporate proxies break it.

# Cross-references

- **Wire protocol details**: [`docs/06-transports.md`](./06-transports.md) — full AG-UI event shape, all four identity paths in depth.
- **Visitor recognition flow**: [`docs/19-visitor-auth.md`](./19-visitor-auth.md) — magic-link verification, console-adapter for OSS testing, the production safeguard.
- **Operator-side chat (not visitor-side)**: [`docs/15-chat.md`](./15-chat.md) — `auggy chat` Local GUI for the creator's own chat surface, separate from production embedding.
- **G3 `allowAnonymous` posture**: [`docs/06-transports.md#anonymous-posture`](./06-transports.md#anonymous-posture) — the env-based default rule and the override precedence.
- **G34 console-mail-client**: [`docs/19-visitor-auth.md#console-mode-for-local-testing`](./19-visitor-auth.md#console-mode-for-local-testing) — visitorAuth setup in local dev.
- **Operator chat surfaces**: [`docs/15-chat.md`](./15-chat.md) (Local GUI, `auggy chat`) and [`docs/14-telegram-transport.md`](./14-telegram-transport.md) (Telegram). Future: G36 `/admin` route with HTTP basic auth.

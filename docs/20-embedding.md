# 20 — Embedding Auggy in your frontend

> Two patterns for wiring a Next.js (or any server-rendered) chat surface to a running Auggy agent. **Pattern A** is for public visitor chat (the boutique store / dispatcher / front-door use case). **Pattern B** is for operator-only chat (admin dashboard, internal-only surface). The runtime resolves these to different trust levels, and the wrong pattern in the wrong place is a privilege escalation — pick deliberately.

## Pick a pattern

| | Pattern A — Public visitor chat | Pattern B — Operator-only chat |
|---|---|---|
| **Audience** | Anyone on the internet (boutique store customers, dispatcher inbound, support visitors) | Operator only (admin dashboard, internal "talk to my agent" surface) |
| **Agent trust level** | `public/anonymous` → `public/recognized` after visitor-token rotation; `public/recognized` with verified email after visitorAuth | `creator` |
| **Bearer in proxy?** | **NO** — anonymous traffic flows in unauthenticated (agent gates with `webTransport.allowAnonymous: true` + budgets + visitor-token rotation) | **YES** — server-side proxy attaches `Authorization: Bearer ${AUGGY_WEB_TOKEN}` |
| **Cost-safety** | Budgets cap anonymous spend ($5/day global default, 30 anon turns/day default) | Operator pays full cost on every turn; bearer = no caps |
| **Risk of misuse** | Low — public is by design | **High if exposed publicly** — every visitor through this proxy becomes the creator. Must gate behind operator auth (login wall, IP allowlist, VPN) before exposing |

**Pick Pattern A** unless you specifically want an operator-only surface AND you have your own auth gate in front of it. If in doubt, Pattern A.

---

# Pattern A — Public visitor chat (recommended)

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

## Frontend proxy code (NO bearer)

`app/api/chat/route.ts`:

```ts
/**
 * Pattern A chat proxy — public visitor chat.
 *
 * Does NOT attach `Authorization: Bearer …`. Visitor traffic resolves to
 * `public/anonymous` (or `public/recognized` after token rotation) on the agent.
 *
 * Forwards `x-visitor-token` in BOTH directions — this is what gives returning
 * visitors continuity (a stable `peer.id` for memory scoping). On first contact
 * we send `x-visitor-token: bootstrap` so the agent mints a fresh token for us;
 * we relay the token back to the browser via `x-visitor-token` response header.
 */

const AGENT_URL = process.env.AUGGY_AGENT_URL; // e.g. "http://localhost:8080"

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!AGENT_URL) {
    return errorResponse(503, "AUGGY_AGENT_URL is not configured.");
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

  // Forward the visitor's current token (if any) so the agent can validate it.
  // First-contact requests send `bootstrap` as a placeholder — webTransport
  // mints a real token only when an `x-visitor-token` header is PRESENT but
  // invalid (sending no header at all → no token issued).
  const visitorToken = request.headers.get("x-visitor-token") || "bootstrap";

  let agentResponse: Response;
  try {
    agentResponse = await fetch(`${AGENT_URL}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-visitor-token": visitorToken,
        // NO Authorization header — Pattern A relies on allowAnonymous + budgets,
        // not bearer auth. (Adding the bearer here elevates the visitor to
        // creator trust, which is Pattern B's threat model, not this one.)
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
      return errorResponse(502, "Agent is not reachable. Check `auggy status`.");
    }
    return errorResponse(502, "Failed to connect to agent.");
  }

  if (!agentResponse.ok) {
    // Map upstream statuses to canned messages — never forward raw error
    // detail to the browser (the agent's error responses may include
    // operator-side context that should stay server-side).
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

  // Relay the freshly-issued visitor token (if any) back to the browser so it
  // can include it on the next request. Without this header, anonymous-recognized
  // continuity is lost on every page load.
  const responseHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
  const issuedToken = agentResponse.headers.get("x-visitor-token");
  if (issuedToken) {
    responseHeaders["x-visitor-token"] = issuedToken;
  }
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
 * HTML/redirect response back unchanged. Critical for cross-origin deploys —
 * the verify success page writes localStorage on the page's origin, so it
 * must be served from THIS origin (the frontend's), not the agent's.
 */
const AGENT_URL = process.env.AUGGY_AGENT_URL;

async function forward(request: Request): Promise<Response> {
  if (!AGENT_URL) return new Response("AUGGY_AGENT_URL not configured", { status: 503 });
  const url = new URL(request.url);
  const upstream = `${AGENT_URL}/visitor-auth/verify${url.search}`;
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const resp = await fetch(upstream, init);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
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
    const requestHeaders: Record<string, string> = { "content-type": "application/json" };
    if (currentToken) requestHeaders["x-visitor-token"] = currentToken;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
          threadId: threadIdRef.current,
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

## What the agent sees (Pattern A identity flow)

| Request | trustLevel | publicSubstate | peer.id |
|---|---|---|---|
| First contact: `x-visitor-token: bootstrap` (or anything that fails validation) | `public` | `anonymous` | `anon-<threadId>` |
| Second request: client sends the rotated token from previous response | `public` | `recognized` | `vis_<uuid>` (stable, from token payload) |
| After visitor-auth email verification + reverse-proxied verify route | `public` | `recognized` | `vis_<uuid>` from the visitorAuth-minted token |

The agent **never** mints `creator` trust for Pattern A traffic, because the proxy never attaches the bearer. The `visitor-auth` upgrade preserves anonymous history under the peer-id migration that visitorAuth runs at verify time (see `docs/19-visitor-auth.md`).

## Frontend environment

```
AUGGY_AGENT_URL=http://localhost:8080
```

That's the only env var Pattern A needs on the frontend. **No bearer token.**

---

# Pattern B — Operator-only chat (creator trust)

> ⚠ **Every request through this proxy resolves to `creator` trust on the agent**, meaning unlimited budget, full tool access, and creator-scoped memory. **Never** expose this surface to public traffic. If you do, every visitor effectively IS the operator.
>
> Acceptable uses: internal admin dashboard behind a login wall, IP-restricted operator surface, VPN-gated console. Anything where the only people reaching the proxy are people you would let chat as yourself.

## Agent-side configuration

Standard scaffold defaults are fine. The agent's `webTransport` requires a bearer (the default) and `allowAnonymous` stays unset / `false`.

## Frontend proxy code (bearer forwarded)

`app/api/chat/route.ts`:

```ts
/**
 * Pattern B chat proxy — operator-only.
 * Every request through this proxy is authenticated as the creator. Gate
 * the page that uses this proxy behind your own operator-auth layer.
 */

const AGENT_URL = process.env.AUGGY_AGENT_URL;
const AGENT_TOKEN = process.env.AUGGY_AGENT_TOKEN; // matches the agent's AUGGY_WEB_TOKEN

function errorResponse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!AGENT_URL || !AGENT_TOKEN) {
    return errorResponse(503, "AUGGY_AGENT_URL and AUGGY_AGENT_TOKEN must be set.");
  }

  // [… same body validation as Pattern A …]
  let body: { messages?: unknown; threadId?: string };
  try { body = await request.json(); } catch { return errorResponse(400, "Invalid JSON."); }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(400, "Request must include a non-empty messages array.");
  }
  for (const msg of body.messages) {
    if (
      typeof msg !== "object" || msg === null ||
      typeof (msg as Record<string, unknown>).role !== "string" ||
      typeof (msg as Record<string, unknown>).content !== "string" ||
      (msg as Record<string, unknown>).role !== "user"
    ) {
      return errorResponse(400, "Each message must have role: 'user' and a string content.");
    }
  }

  const agentResponse = await fetch(`${AGENT_URL}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AGENT_TOKEN}`,  // ← elevates to creator trust
    },
    body: JSON.stringify({ messages: body.messages, threadId: body.threadId }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!agentResponse.ok || !agentResponse.body) {
    return errorResponse(502, "Agent error.");
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

## What the agent sees (Pattern B)

Every request: `trustLevel: "creator"`, `peer.id: "creator"`. Anonymous-budget caps do NOT apply. Creator-only memory tools (`memory_forget`, etc.) are accessible. **Treat the proxy URL as a creator credential.**

## Frontend environment

```
AUGGY_AGENT_URL=http://localhost:8080
AUGGY_AGENT_TOKEN=<value from the agent's .env: AUGGY_WEB_TOKEN>
```

`AUGGY_AGENT_TOKEN` MUST match the agent's `AUGGY_WEB_TOKEN`. The bearer never reaches the browser.

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

- **Bearer never reaches browser (Pattern B):** never use `NEXT_PUBLIC_*` prefixes for `AUGGY_AGENT_TOKEN`. Verify by opening browser devtools → network tab → confirm `Authorization` header is absent on `/api/chat` requests. The proxy attaches the bearer server-to-server only.
- **Visitor token in localStorage is XSS-exfiltratable:** an XSS bug in your widget gives the attacker the visitor's token, redeemable for the token's TTL. Mitigate by (a) shortening `visitorTokens.ttlSeconds` from the 30-day default, (b) keeping a strict CSP on the chat page, (c) using `auggy visitors --revoke <email>` if you detect compromise. The `revocationCheck` callback (already wired) ensures revoked tokens are inert without waiting for TTL expiry.
- **Error message forwarding:** the proxy maps upstream HTTP statuses to canned messages. Never forward raw `error.detail` strings — those may contain operator-side context (file paths, DB error messages) that should stay server-side.
- **Referrer leakage:** visitor tokens MUST live in localStorage, never in URL fragments or query strings. URLs leak via `Referer` headers; localStorage does not.
- **Logs:** the agent does not log token values to stdout (validated). If you add custom logging, never log the contents of `x-visitor-token` or `Authorization`.

## Auth-workaround vectors

- **Replay attacks on stolen visitor tokens:** default 30-day TTL; consider shortening for higher-value deployments. visitorAuth supports revocation via `auggy visitors --revoke <email>`; the `revocationCheck` is consulted on every request.
- **CSRF (cross-site request forgery):** Pattern B is CSRF-immune as written — the bearer never reaches the browser, so a malicious site cannot forge requests with it. Pattern A with localStorage-backed visitor tokens is also CSRF-resistant (the malicious site cannot read the token), but the threat model deserves explicit verification if you change the storage mechanism (cookie-backed tokens would need `SameSite=Strict` + CSRF tokens).
- **Origin spoofing:** CORS does NOT gate requests by origin. Pattern B relies on the bearer (which a malicious origin cannot get); Pattern A relies on anonymous-budget caps + visitor-token rotation.
- **Forged `x-peer-name` / `x-peer-kind`:** cosmetic only. Do NOT use them as rate-limit keys or identity proxies.
- **ThreadId-collision:** Pattern A's anonymous identity is per-thread. A malicious visitor can craft a `threadId` that collides with another anonymous visitor's identity. Mitigate by either: (a) server-generating threadIds on first contact (your proxy can mint a UUID and bind it to a session cookie before forwarding); or (b) accepting per-thread identity is best-effort and relying on visitor-auth verification for durable identity.
- **Anonymous-budget evasion:** a malicious visitor can churn threadIds to reset per-thread limits. The `anonymousGlobalLimit` (default 30 turns/day across all anonymous traffic) caps the total damage; `dailyBudgetUsd` (default $5) is the hard wall.

## Coherence with shipped Tier 1 features

- Pattern A REQUIRES `allowAnonymous: true` (G3). For local dev `NODE_ENV` unset → defaults to `true`. For cloud deploy (`NODE_ENV=production`) → must be set explicitly in yaml.
- Pattern A's visitor-auth flow runs **fine in local dev with the console adapter** (G34): `agentMail.transport: "console"` prints the verify URL to stdout instead of sending email. The reverse-proxied verify route still applies in this case.
- Pattern A's `/visitor-auth/verify` localStorage handoff REQUIRES reverse-proxying through the frontend origin (see "Cross-origin" section above).

---

# Tested reference

The end-to-end flow described here is verified by `tests/integration/embedding-recipe.test.ts`, which boots a real agent + a small inline HTTP proxy and asserts that:

- Pattern A request without bearer + placeholder `x-visitor-token` → `public/anonymous`, fresh token in response
- Subsequent request with rotated token → `public/recognized`, stable `peer.id`
- visitorAuth flow (using G34's console adapter) → upgraded `vis_<uuid>` token
- Pattern B request with bearer → `creator` trust
- Pattern B without bearer (with `allowAnonymous: false`) → 401
- `x-peer-id` is ignored for identity regardless of the request shape

If you change the recipe, run the integration test to confirm the documented claims still hold.

---

# Non-Next.js stacks

Same pattern in any server-rendered framework:

- **Express / Hono / Fastify**: a `POST /api/chat` route that mimics the Pattern A or Pattern B proxy code above. The shape is identical.
- **Cloudflare Workers / Vercel Edge**: same pattern. Both support streaming `Response.body` pass-through.
- **Pure browser, no server**: not viable for Pattern B (would leak the bearer). For Pattern A, you can technically run a browser-only chat that talks directly to the agent's `/agent/run` if the agent has `cors.origins` set and `allowAnonymous: true`. The reverse-proxy requirement for `/visitor-auth/verify` is mooted (same origin from the browser's perspective). This is an OK pattern for a self-hosted internal tool; less safe for public traffic because per-origin enforcement is absent.

---

# Troubleshooting

- **`401 Unauthorized` (Pattern A)** — agent doesn't have `allowAnonymous: true`. Either set it in yaml or `AUGGY_ALLOW_ANONYMOUS=true` env var.
- **`401 Unauthorized` (Pattern B)** — `AUGGY_AGENT_TOKEN` doesn't match `<agent-dir>/.env`'s `AUGGY_WEB_TOKEN`. Confirm both files.
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
- **G34 console-mail-client**: [`docs/19-visitor-auth.md#console-mode-for-local-testing`](./19-visitor-auth.md#console-mode-for-local-testing) — Pattern A's visitorAuth setup in local dev.

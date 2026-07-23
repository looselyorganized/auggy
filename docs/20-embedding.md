# 20 — Embedding Auggy in your frontend

> **Primitives reference.** Auggy ships the runtime primitives needed to wire a chat surface (your own widget, your own framework, your own deployment topology) to a running agent. This doc documents the wire contract — identity resolution, the AG-UI event shape on the response, visitor-token rotation, and the visitorAuth verify endpoint. It deliberately does **not** ship a copy-paste recipe.

**Why no recipe?** A copy-paste integration recipe is a security-sensitive artifact at the adopter's application layer (origin policy, CSRF gates, cookie domain, token storage, framework idioms). The right shape for those decisions depends on the adopter's stack and topology. Auggy ships clean primitives; you compose them.

**Creator-side chat (skip this doc):** if you want to chat with your own agent, use `auggy run <name>` and open `/console/chat`, or use `telegramTransport` for mobile. See `docs/21-console.md` and `docs/14-telegram-transport.md`.

**Visitor-side chat (this doc):** the contract a visitor-facing frontend must satisfy to talk to a running Auggy agent.

---

## The wire

A visitor turn is one HTTP POST:

```
POST <agent-url>/agent/run
Content-Type: application/json
Authorization: <optional — see "Identity resolution" below>
x-visitor-token: <optional — see "Identity resolution">
x-auggy-anonymous-session: <send the capability returned on first anonymous contact>
x-agent-id, x-agent-secret: <optional — agent-to-agent only>
Idempotency-Key: <recommended — durable execution replay on retry>

{ "messages": [{ "role": "user", "content": "..." }], "threadId": "<logical-client-id>" }
```

For public callers, `threadId` is a logical identifier. The server derives the
kernel thread ID from the security namespace, authenticated peer scope, and
logical value; clients must use the `RUN_STARTED.threadId` returned by the
server as the canonical execution identifier. This prevents predictable
client-chosen values from claiming another peer's history.

The response is a Server-Sent Events stream of AG-UI events:

```
data: {"type":"RUN_STARTED","threadId":"...","runId":"..."}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":" there"}
...
data: {"type":"TEXT_MESSAGE_END"}
data: {"type":"RUN_FINISHED"}
```

Full event taxonomy (TEXT_MESSAGE_*, TOOL_CALL_*, RUN_ERROR, etc.) lives in `docs/06-transports.md`. The minimum a chat widget handles is `TEXT_MESSAGE_CONTENT` (delta accumulation) and `RUN_FINISHED` / `RUN_ERROR` (terminal states).

---

## Identity resolution

`webTransport.identify()` (`src/transports/web-transport.ts`) resolves each request to one of four mutually-exclusive identity paths:

| Path | Trigger | trustLevel | peer.id |
|---|---|---|---|
| **1 Creator** | Valid bearer matching `webTransport.auth.token`, AND no valid `x-agent-id`+`x-agent-secret` pair (Path 2 wins for agent credentials), AND no VALID `x-visitor-token` (Path 3 wins for `public` + `recognized` callers). **Bearer wins over an invalid `x-visitor-token`** — a stale or malformed visitor-token alongside a valid bearer is ignored and the request resolves as creator. | `creator` | hardcoded `"creator"` |
| **2 Agent** | `x-agent-id` + matching `x-agent-secret` (timing-safe compare) | `agent` | `"agent:" + x-agent-id` |
| **3 Public / recognized** | Valid HMAC-signed `x-visitor-token` (not revoked, `agentBinding` matches). Fires even when a valid bearer is also present — explicit operator-as-visitor opt-in. | `public` + `recognized` | `payload.visitorId` from the token (stable across requests) |
| **4 Public / anonymous** | Default — fallback when no path above matched. Admitted by `allowAnonymous` with no bearer. | `public` + `anonymous` | Server-minted subject authenticated by `x-auggy-anonymous-session`; never derived from `threadId` |

What other headers do:

- `x-peer-name` — cosmetic `displayName`. Does NOT affect trust.
- `x-peer-kind` and `x-org-id` are not identity proof and must not be used for authorization.
- **`x-peer-id` — accepted but UNUSED by identity resolution.** Do not rely on it for identity scoping; use the server-issued anonymous-session capability or a verified visitor token.

`allowAnonymous` is the operator's gate (`webTransport.allowAnonymous: true` in yaml, or `AUGGY_ALLOW_ANONYMOUS=true` env var). Default rule: `NODE_ENV !== "production"`. See `docs/06-transports.md#anonymous-posture` for the resolution precedence.

---

## Visitor-token rotation

When `webTransport.visitorTokens.enabled: true`, **a visitor's first request MUST include a non-empty `x-visitor-token` header** (`x-visitor-token: bootstrap` is the documented sentinel value). The runtime mints a fresh `vis_<uuid>` HMAC-signed token only when an `x-visitor-token` header is present — if the header is absent entirely, no token is issued and the visitor has no continuity into future requests.

Every admitted anonymous response also returns an authenticated
`x-auggy-anonymous-session` capability. The client must retain and resend it
until a verified visitor token is available. Responses carrying these
capabilities use `Cache-Control: private, no-store`.

Anonymous-session capabilities last 24 hours and are invalidated when the
agent's bearer secret or security namespace rotates. An expired or invalid
capability returns 401 plus
`x-auggy-anonymous-session-status: invalid` before the request is claimed or
executed. A client may remove that stored capability and retry once with the
same idempotency key. If the retry returns 428 with a fresh
anonymous-session, retain it and retry once more. Never treat an arbitrary 401
as a bootstrap signal and never build an unbounded retry loop.

When the runtime mints a visitor token, it returns it in the response's
`x-visitor-token` header. The current request stays at `public/anonymous`; the
newly-issued token is for **future** requests. The credentials carry distinct
anonymous and recognized peer IDs. The signed visitor token records the prior
anonymous peer/thread scope, so the next verified request can perform a
one-way promotion of the already-bound thread. The reverse transition is
denied, including after token revocation.

The next request from the same visitor includes that minted token, which
resolves to `public/recognized` with a stable `peer.id` (the `visitorId`
embedded in the token's payload). Promotion moves eligible anonymous memory to
that stable peer; subsequent memory remains scoped to it.

A correctly-implemented widget MUST: (1) send the bootstrap sentinel on first
contact when visitor tokens are enabled, (2) retain any
`x-auggy-anonymous-session` response capability and resend it on anonymous
requests, (3) retain the rotated `x-visitor-token`, and (4) send the rotated
visitor token on subsequent requests. Store browser credentials according to
the application’s XSS and session threat model; `localStorage` is only one
possible topology.

If the first anonymous request also carries `Idempotency-Key`, the runtime
returns `428 anonymous_session_required` without executing. Retain the returned
anonymous-session (and visitor token, when present), then retry the identical
request with the same key. This prevents an idempotency key from becoming an
identity credential while preserving exactly-once execution.

The signing key (`visitorTokens.signingKey`) is injected at boot by visitorAuth when present (so visitor-tokens and verify-flow tokens share trust). Operators who run with `visitorTokens` but no `visitorAuth` set their own signing key directly.

Token TTL defaults to 30 days (`visitorTokens.ttlSeconds`). **Expired tokens are rejected** — `verifyVisitorToken` returns null when `payload.expiresAt <= Date.now()`. The visitor falls back to a new anonymous session on the next request and cannot reclaim the recognized thread without a newly verified token. Tokens are also checked against the revocation list on every request — a revoked token is treated as invalid regardless of TTL.

---

## visitorAuth verify endpoint

If the `visitorAuth` augment is mounted, the agent exposes `GET / POST /visitor-auth/verify`. The flow:

1. Inside chat, the agent calls the `request_auth({email})` tool.
2. AgentMail (real or console — see `docs/19-visitor-auth.md`) sends the visitor a magic link to `<agent>/visitor-auth/verify?token=<single-use-jwt>`.
3. Visitor clicks → GET renders a confirm page (no consumption).
4. Visitor confirms → POST consumes the token, mints a long-lived `vis_<uuid>`, returns success page.
5. **Token handoff back to your widget** depends on your topology — see "Token handoff" below.

The single-use POST is mail-scanner-prefetch safe (scanners do GET, not POST).

---

## Token handoff (the deployment-topology question)

After verify, the upgraded `vis_<uuid>` lives in the verify page's response. How does your chat widget receive it?

The answer depends on whether your widget shares an origin (or eTLD) with the agent. Today the verify-page implementation stores the token in `localStorage` on the agent's origin — works for same-origin widgets, requires a handoff mechanism for cross-origin ones. We're shipping `successHandoff` config (`localStorage` / `postMessage` / `redirect` / shared-cookie via subdomain) as a separate runtime change.

Until that lands, your options:

| Widget topology | Handoff |
|---|---|
| Widget served from `<agent>/` (same-origin, e.g., bundled `GET /chat` page — G2) | Current localStorage handoff works as-is. |
| Widget on a subdomain of the same eTLD as the agent (e.g., `app.example.com` ↔ `chat.example.com`) | Shared-cookie via `Domain=.example.com` (requires the upcoming `successHandoff: shared-cookie` config). |
| Widget cross-origin (different eTLD or no shared parent) | Fragment redirect, popup + postMessage, or device-code polling — your call, your code. |

This doc deliberately doesn't pick one — the right choice depends on your stack.

---

## Operator-side / creator surfaces (NOT this doc)

For creator-side chat (the operator chatting with their own agent), Auggy ships two surfaces today:

- **`/console/chat`** — per-agent browser chat opened by `auggy run <name>`. See `docs/21-console.md`.
- **`telegramTransport`** — Telegram bot, polling or webhook mode. See `docs/14-telegram-transport.md`.

---

## Tested reference

`tests/integration/embedding-primitives.test.ts` boots a real agent + makes direct HTTP requests to assert these identity-path behaviors:

- Valid bearer → `creator` trust, `peer.id === "creator"` (Path 1)
- Present-but-invalid bearer → 401 (no silent downgrade to anonymous; security claim)
- No bearer + bootstrap `x-visitor-token` → `public/anonymous`, fresh `vis_<uuid>` returned in response header (Path 4)
- Subsequent request with the rotated token → `public/recognized`, stable `peer.id` (Path 3)
- visitorAuth flow with console adapter → upgraded `vis_<uuid>` token, exact
  canonical thread continuity, and prior anonymous history (Path 3 via verify)
- Independent anonymous sessions using the same logical thread ID receive
  different canonical thread IDs and cannot read one another's history
- Revoked recognized credentials cannot downgrade into their former thread
- `x-peer-id` header is ignored for identity regardless of request shape (regression guard)

Eight tests. **Out of scope for this test file:** agent-path identity (Path 2,
covered in `tests/transports/web-transport.test.ts`), full AG-UI event taxonomy
(`docs/06-transports.md` + transport unit tests), visitorAuth verify-page
GET/POST mechanics (`tests/augments/visitorAuth/`), and detailed idempotency
ledger behavior (`tests/transports/web-idempotency.test.ts` and
`tests/transports/idempotency-store.test.ts`).

If you change webTransport identity resolution or visitorAuth's upgrade flow, run this test to verify the documented identity-path contract still holds.

---

## Cross-references

- **Wire protocol details**: [`docs/06-transports.md`](./06-transports.md) — full AG-UI event shape, all four identity paths in depth, allowAnonymous resolution.
- **Visitor recognition flow**: [`docs/19-visitor-auth.md`](./19-visitor-auth.md) — magic-link verification, console-adapter for OSS testing, production safeguards.
- **Operator-side chat**: [`docs/21-console.md`](./21-console.md) (browser console) and [`docs/14-telegram-transport.md`](./14-telegram-transport.md) (Telegram).
- **G3 `allowAnonymous` posture**: [`docs/06-transports.md#anonymous-posture`](./06-transports.md#anonymous-posture).
- **G34 console-mail-client**: [`docs/19-visitor-auth.md#console-mode-for-local-testing`](./19-visitor-auth.md#console-mode-for-local-testing).

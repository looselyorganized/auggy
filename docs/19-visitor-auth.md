# `visitorAuth` — operator reference

`visitorAuth` is the email magic-link verification augment. It lets a public-anonymous visitor verify ownership of an email address and become public-recognized — same `vis_<uuid>` identity returns across sessions, memory continuity, etc. First member of the auth-augment family.

## What it adds to the agent

- Tool: `request_auth({method: "email", email})` — model-callable; sends the verification email.
- HTTP route: `POST /visitor-auth/request` — public visitor-aware; deterministic app-backend request for a verification email.
- HTTP route: `GET /visitor-auth/verify?token=<uuid>` — public-unauthenticated; mounts on the agent's webTransport.
- HTTP route: `POST /visitor-auth/verify` — public-unauthenticated; consumes the magic-link token and writes the browser visitor token.
- Context block: per-turn summary of the active peer's verification state.
- SQLite store: `<agent-dir>/data/visitor-auth.db` in CLI-created agents — token + verified-visitor tables.

Pair `visitorAuth` with `layeredMemory` when you want repeat visitors to feel
continuous. `visitorAuth` gives the browser a stable `vis_<uuid>` identity after
email verification; `layeredMemory` stores and retrieves memory under that peer
id.

## Recommended v1 setup

For a production visitor-auth experience:

```bash
auggy augment add layeredMemory
auggy augment add visitorAuth
auggy agentmail setup visitorAuth
auggy doctor --cloud
```

This gives the agent:

- repeat-visitor memory in `data/memory.db`
- magic-link verification stored in `data/visitor-auth.db`
- AgentMail delivery for production email
- cloud preflight that rejects unsafe console magic links before deploy

Local development can use `visitorAuth` without AgentMail; the console adapter
prints magic links to the running agent's terminal. Do not use console magic
links on public Railway deploys unless you explicitly accept that verification
links will be visible in service logs.

## App-backend magic link request

Use the deterministic route when a frontend owns the sign-in form and should not
ask the model to call `request_auth`:

```http
POST /visitor-auth/request
content-type: application/json

{
  "email": "visitor@example.com"
}
```

Response:

```json
{
  "status": "sent",
  "message": "Verification email sent to visitor@example.com. The link expires in 15 minutes.",
  "expiresInSec": 900
}
```

- This public route intentionally does **not** accept a caller-supplied
  `threadId`. Public callers cannot prove they own an anonymous chat thread, so
  binding arbitrary `anon-${threadId}` state here would let one visitor claim
  another visitor's anonymous memory.
- Route-initiated verification uses an internal `auth:<uuid>` peer id and does
  not migrate existing anonymous chat memory. If you need anonymous memory
  migration today, use the model-tool path (`request_auth`) from the active
  visitor turn. A future signed anonymous-session binding can make app-route
  migration safe.
- The route is still protected by body validation, route rate limiting, and
  visitorAuth's per-email send limit.

## App-backend route auth

When `visitorAuth` is mounted, augment HTTP routes can use visitor-token auth in
addition to the existing `none` and `bearer` modes:

```ts
defineRoute.get("/catalog", {
  auth: "visitor.optional",
  handler: async ({ auth }) => {
    // auth.state is "anonymous" or "recognized"
  },
});

defineRoute.get("/orders/:id", {
  auth: "visitor.required",
  handler: async ({ auth }) => {
    // auth.state is "recognized"; auth.visitorId is available
    // auth.email is available when visitorAuth / identityLookup is wired
  },
});
```

- `visitor.optional` accepts anonymous callers and passes `{ mode: "visitor", state: "anonymous" }` when no valid `x-visitor-token` is present.
- `visitor.required` requires a valid `x-visitor-token`; missing, invalid, expired, wrong-agent, or revoked tokens return `401 { "error": "visitor-auth-required" }`.
- Recognized route context always includes `visitorId` and token timestamps.
  When visitorAuth is mounted through the Auggy CLI, route context also includes
  visitorAuth metadata (`email`, `verifiedAt`, `reverifyDueAt`). Email is
  looked up from the visitorAuth store; it is not embedded in the browser
  token. Programmatic `webTransport` users who configure visitor tokens without
  `identityLookup` will receive token identity only.

This is the app-backend path: deterministic frontend routes can require a valid
visitor token without routing every request through the model.

## Configuration

Enable both augments in `agent.yaml`, then configure them in their augment
folders:

```yaml
# agent.yaml
augments:
  - webTransport
  - visitorAuth

# augments/webTransport/augment.yaml
type: webTransport
config:
  port: 8080
  auth: { type: bearer, token: ${AUGGY_WEB_TOKEN} }
  visitorTokens:
    ttlSeconds: 7776000                       # 90 days
    # signingKey is auto-injected from visitorAuth by the resolver —
    # do NOT set it here. Duplicate keys trigger a warning and visitorAuth
    # wins. enabled is also forced to true automatically.

# augments/visitorAuth/augment.yaml
type: visitorAuth
config:
  publicUrl: ${AUGGY_PUBLIC_URL}              # e.g. https://zip.example.com
  dbPath: ./data/visitor-auth.db
  agentMail:
    transport: agentmail
    apiKey: ${AGENTMAIL_API_KEY}
    inboxId: ${AGENTMAIL_INBOX_ID}
    subjectPrefix: "[Verify] "
  signingKey: ${VISITOR_SIGNING_KEY}          # also auto-wired into webTransport's visitorTokens
  rateLimit: { perHour: 1, perDay: 3 }        # per anonymous peer
  reverifyAfterDays: 90
  tokenTtlMinutes: 15
  layeredMemoryDbPath: ./data/memory.db       # null to disable peer-id migration
  # Optional: notify operator on first verify per email
  notifyOnFirstVerify:
    to: ops@example.com
    subjectPrefix: "[New verified visitor] "
```

## AgentMail setup

For production email delivery, prefer the setup command over hand-editing secrets:

```bash
auggy augment add visitorAuth
auggy agentmail setup visitorAuth
```

The setup command has three modes:

- `signup` — first AgentMail inbox, with a human email OTP.
- `existing` — create a new inbox in an existing AgentMail account.
- `manual` — use an existing inbox ID and runtime key.

The command writes `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` to `.env`, switches
`augments/visitorAuth/augment.yaml` to `agentMail.transport: agentmail`, and creates
an inbox-scoped runtime key with only `inbox_read` and `message_send`.

After a visitor clicks the verification link, the success page stores the signed
visitor token in browser localStorage. `/console/chat` and public frontends should
send that token as `x-visitor-token` on the next `/agent/run` request so the turn
arrives as a recognized visitor with verified-email context.

If `layeredMemory` is installed, future turns also receive the visitor's recent
peer-scoped memory automatically. A generic returning message like "hey" can
still include useful context such as prior preferences, open commitments, or
the visitor's name.

## Console mode for local testing

OSS adopters who haven't configured AgentMail can still exercise the full magic-link flow by switching the delivery transport to the console adapter. The verify URL prints to the agent's stdout instead of being sent via email — the operator copies the link from their terminal and opens it in a browser to complete verification.

Switch via `agentMail.transport: "console"` in
`augments/visitorAuth/augment.yaml`:

```yaml
type: visitorAuth
config:
  publicUrl: http://localhost:8080
  dbPath: ./data/visitor-auth.db
  agentMail:
    transport: "console"
  signingKey: ${VISITOR_SIGNING_KEY}
  agentBinding: ${AUGGY_AGENT_ID}
```

When console mode is active, `request_auth` prints a line like:

```
[visitor-auth:console] would-send to=dave@example.com subject="[Verify] Confirm your email"
Click to verify: http://localhost:8080/visitor-auth/verify?token=550e8400-e29b-41d4-a716-446655440000
Expires in 15 minutes.
```

Apart from the delivery path, behavior is identical: token TTL, single-use consumption, peer-id migration, revocation, and `auggy visitors` CLI all work the same way.

### Admission gate

Console mode is **rejected at boot** if EITHER of these is true:

1. `NODE_ENV === "production"` — Railway / Fly / similar cloud platforms set this by default. Magic links would end up in runtime logs (dashboards, log-shipping services), exfiltratable by anyone with log access.
2. `publicUrl` resolves to a publicly-reachable host — i.e. NOT localhost, NOT a `127.x.x.x` / `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x` / IPv6 loopback or link-local / `*.local` mDNS. Catches the "internet-facing staging deploy with `NODE_ENV` unset" case.

Either gate triggers the same rejection. Operator can explicitly acknowledge the risk via:

```yaml
config:
  publicUrl: https://demo.example.com
  agentMail:
    transport: "console"
  allowConsoleInProduction: true   # acknowledge: I know magic links land in logs
```

Local-only flows are always admitted without ceremony:

| publicUrl | Behavior |
|---|---|
| `http://localhost:8080` | console mode allowed (no override needed) |
| `http://127.0.0.1:8080` | console mode allowed |
| `http://192.168.1.42:8080` (LAN) | console mode allowed |
| `https://my-app.local` (mDNS) | console mode allowed |
| `https://demo.example.com` | console mode **rejected** unless `allowConsoleInProduction: true` |

For production-grade deployments serving external visitors, use the AgentMail transport.
AgentMail recommends sending both plain-text and HTML email bodies for deliverability; visitorAuth does this for verification emails.

### `notifyOnFirstVerify` is incompatible with console mode

The `notifyOnFirstVerify` option (operator-alert email on each new visitor) cannot be combined with `agentMail.transport: "console"`. The console adapter would print the alert to stdout, return `status: "sent"`, and burn the first-verify ledger entry — silently suppressing the real alert even after a later switch to AgentMail. The factory rejects this combination at boot with a clear error message; configure AgentMail or remove `notifyOnFirstVerify`.

## Required environment variables

| Variable | Why |
|---|---|
| `AGENTMAIL_API_KEY` | AgentMail bearer token (`am_*`). Prefer an inbox-scoped, permission-whitelisted key with `inbox_read` and `message_send`. |
| `AGENTMAIL_INBOX_ID` | Inbox the verify email is sent FROM |
| `AUGGY_PUBLIC_URL` | Base URL operators reach the agent at; embedded in the magic link |
| `VISITOR_SIGNING_KEY` | HMAC key for visitor tokens; set only in `visitorAuth` — auto-injected into webTransport |
| `AUGGY_AGENT_ID` | Stable per-agent identifier; binds visitor tokens to this agent. MUST match between visitorAuth and webTransport. Default unset (no binding check). |

## Key constraints

- Set `signingKey` only in `visitorAuth`. The augment-resolver auto-injects it into `webTransport.visitorTokens` at boot. Setting it in both places triggers a warning and `visitorAuth`'s value takes precedence. If they differ, visitor tokens minted by visitorAuth will fail webTransport's verification.
- AgentMail keys should be least-privilege. visitorAuth uses `inbox_read` during boot healthcheck and `message_send` for verification delivery, so a permission-whitelisted key needs both.
- `publicUrl` MUST point to a host where the agent's `/visitor-auth/verify` route is reachable from the public internet. If you're running behind a tunnel (ngrok, Cloudflare), use the tunnel URL; if you're running on Railway, use the Railway domain.
- Per-anonymous-peer rate limits are **in-memory only** — restart resets state. The verified_visitors UNIQUE-on-email constraint catches accidental double-verification.

## Operator commands

```bash
# List verified visitors
auggy visitors zip

# Hard-revoke a verified visitor (deletes verified_visitors row + cascades memory_forget)
auggy visitors zip --revoke alice@example.com
auggy visitors zip --revoke alice@example.com --yes      # non-interactive
```

If a revoke is interrupted (e.g., Ctrl-C between the visitor-auth UPDATE and the memory.db DELETE), simply re-run `auggy visitors <agent> --revoke <email>` — the command detects the already-revoked row and finishes the memory cascade idempotently.

## How verification works (operational view)

1. Visitor types email in chat (e.g., "I'm alice@example.com").
2. Agent decides to verify, calls `request_auth({method: "email", email: "alice@example.com"})`.
3. visitorAuth validates: email format, email-must-appear-in-recent-messages (defense against confused-deputy), per-peer rate limit (1/hr, 3/day).
4. Generates a UUID token. Writes a row to `visitor_auth_tokens` with 15-minute TTL. Sends email via `agentmail-client.ts` (direct, not through `notify`).
5. Visitor clicks link in email. GET hits `/visitor-auth/verify?token=<uuid>`.
6. Atomic `UPDATE visitor_auth_tokens SET consumed=1, consumed_at=? WHERE token=? AND consumed=0 AND expires_at > ?` — `changes()` decides single-use.
7. On consumed=1: mints HMAC-signed `vis_<uuid>` (same key webTransport uses; reuses an existing visitorId on re-verify so memory continuity survives), writes verified_visitors row, runs anonymous→recognized peer-id migration on memory.db, returns success HTML.
8. Success HTML stashes the token in localStorage + replaces URL via `history.replaceState`.
9. Chat tab listens for `storage` events, picks up new token, includes it as `x-visitor-token` on next request.
10. webTransport's identity Path 3 verifies the token, peer.id is now `vis_<uuid>`, peer.publicSubstate is `recognized`.

## Security posture

- **Confused-deputy defense (fix #4):** the augment refuses to send to an email that did not appear verbatim in one of the visitor's last 4 messages.
- **Rate-limit defense (fix #1):** 1 send per anonymous peer per hour, 3 per day. Per-IP per-route limit (60/min) layered above by webTransport.
- **Token leakage defense (fix #5):** verify-success page has `<meta name="referrer" content="no-referrer">`, zero external assets, runs `history.replaceState` on load to drop the token from the URL bar.
- **Token replay defense (fix #8):** atomic SQL consume; one row update returns success, all others return 410.
- **Long-term key compromise (fix #9):** 90-day reverification TTL on `verified_visitors`. Operator can revoke at any time.

## Out of scope at v1

- Other auth methods (SMS, OAuth, OIDC) — `request_auth.method` shape leaves room.
- Strong identity (KYC). Email-bound is durable, not strong.
- Cookie-based cross-tab handoff (only localStorage, same-origin).
- Operator-customizable verify-success HTML.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "VISITOR_SIGNING_KEY is unresolved" at boot | `${VISITOR_SIGNING_KEY}` env var not set in `.env` | Set it; restart |
| Verify link returns 404 | Token isn't in the DB — most often visitorAuth wasn't running when the token was issued, or DB was deleted | Re-issue with a fresh `request_auth` |
| Verify link returns 410 "expired" | More than 15 minutes between send and click | Re-issue |
| Verify link returns 410 "consumed" | Token was already used (visitor double-clicked, or someone with the link beat them) | Re-issue |
| Visitor verifies but agent doesn't recognize them next visit | Cleared localStorage, or `VISITOR_SIGNING_KEY` rotated | Re-verify |
| AgentMail healthcheck returns 403 | API key lacks access to the configured inbox, or a permission whitelist omitted `inbox_read` | Use an inbox-scoped key for `AGENTMAIL_INBOX_ID` with `inbox_read` and `message_send` |
| `auggy visitors --revoke` errors "memory.db not found" | layeredMemory hasn't created its DB yet, or path mismatch | Check `layeredMemoryDbPath` in `augments/visitorAuth/augment.yaml`; CLI-installed agents use `./data/memory.db` |

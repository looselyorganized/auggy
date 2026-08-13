# `visitorAuth` — operator reference

`visitorAuth` is the email magic-link verification augment. It lets a
`public` + `anonymous` visitor verify ownership of an email address and become
`public` + `recognized` — same `vis_<uuid>` identity returns across sessions,
memory continuity, etc. First member of the auth-augment family.

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
auggy agentmail setup visitorAuth --mode connect
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

If the same agent also needs model-callable email, install both canonical
consumers together in an interactive terminal:

```bash
auggy augment add agentMail visitorAuth
```

The post-add flow uses one setup confirmation, connects `agentMail` to an
existing inbox and exact API key, and attaches `visitorAuth` to the same
environment values without asking again. `--yes` skips this optional setup
flow; use the explicit shared sequence below for automation or recovery.

## App-backend magic link request

Use the deterministic route when a frontend owns the sign-in form and should not
ask the model to call `request_auth`:

```http
POST /visitor-auth/request
content-type: application/json

{
  "email": "visitor@example.com",
  "meta": {
    "messageId": "msg_123",
    "source": "console",
    "returnTo": "/account"
  }
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
- `meta` is optional, non-authoritative request context for UI correlation and
  audit trails. `meta.messageId` may be recorded with the issued token, but
  `meta` never controls visitor identity, trust, or memory migration. Identity
  is bound by Auggy runtime context and signed visitor/anonymous-session
  capabilities.
- Route-initiated verification uses an internal `auth:<uuid>` peer id and does
  not migrate existing anonymous chat memory. If you need anonymous memory
  migration, use the model-tool path (`request_auth`) from the active visitor
  turn. That path records the authenticated anonymous peer in the single-use
  verification record and mints a visitor token with a signed one-way
  transition proof. The next recognized turn may promote only that peer's
  bound thread and memory. The public app route intentionally does not accept
  an arbitrary anonymous subject or thread claim.
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

Existing apps can also bridge Clerk, Supabase, or custom app sessions into
`visitor.required` routes with short-lived external auth assertions. See
[`26-delegated-authorization.md`](./26-delegated-authorization.md) for the
developer guide, including route and tool `requires` examples.

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
  rateLimit: { perHour: 1, perDay: 3 }        # per email; AgentMail default
  reverifyAfterDays: 90
  tokenTtlMinutes: 15
  layeredMemoryDbPath: ./data/memory.db       # null to disable peer-id migration
  # Optional: notify operator on first verify per email
  notifyOnFirstVerify:
    to: ops@example.com
    subjectPrefix: "[New verified visitor] "
```

When `visitorAuth` and a SQLite `layeredMemory` augment point at the same
database, the CLI derives the exact layered-memory namespace and prefixes it
with the immutable agent ID. Verification migration and `auggy visitors
--revoke` update/delete only rows in that namespace, even if another agent was
misconfigured to share the file. The store persists an exact `namespace_key`;
label prefixes are display/routing metadata and are never authorization
evidence. Nested namespaces such as `Foo` and `Foo:bar` therefore remain
isolated even in one database.

Programmatic `visitorAuth(...)` construction is deliberately more explicit:
peer migration is disabled when `layeredMemoryDbPath` is omitted or `null`. If
a direct caller supplies a migration path, it must also supply the exact
non-empty `layeredMemoryNamespace`. This prevents two embedded agents sharing a
database from silently falling back to the same `ep` namespace.

## AgentMail setup

For production email delivery, create an inbox and API key in AgentMail, then
connect those exact values:

```bash
auggy augment add visitorAuth
auggy agentmail setup visitorAuth --mode connect
```

`auggy augment setup visitorAuth` is the generic equivalent. The direct
`agentmail` command may omit its target only when exactly one canonical,
referenced `augments/agentMail` or `augments/visitorAuth` mount is installed:

```bash
auggy agentmail setup
```

Always name the target in scripts. If both canonical consumers are installed,
omission fails closed and prints the safe shared-credential sequence below. A
custom-named, inline, or additional same-type mount is never selected or
rewritten automatically.

Setup has two modes:

| Mode | Use it when | Effect |
|---|---|---|
| `connect` | Connecting an existing inbox for the first time | Prompts securely for its inbox ID and API key, verifies `inbox_read`, stores the exact values in `.env`, and switches visitorAuth to AgentMail delivery |
| `env` | The same values are already complete in the agent's `.env` | Revalidates and reuses them without asking again |

Auggy never creates an AgentMail account, inbox, or API key. It also never
narrows, rotates, replaces, or revokes the supplied key. Create and manage those
resources in AgentMail. If you intentionally change either credential, update
the exact `.env` values and rerun `--mode connect`.

For non-interactive use, name the mode and supply `AGENTMAIL_API_KEY` plus
`AGENTMAIL_INBOX_ID` in the process environment, or pass `--api-key` and
`--inbox-id`. Prefer environment variables because command-line secrets can be
recorded in shell history or process listings.

On success, setup writes `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`, switches
`augments/visitorAuth/augment.yaml` to `agentMail.transport: agentmail`, and
reports that `inbox_read` was verified. Sending the first magic link exercises
`message_send`; setup cannot prove a write permission without sending mail.
The local `.env` and augment YAML update is transactional on supported POSIX
systems and fails closed if their inputs change during setup.

### Sharing credentials with the `agentMail` augment

The canonical `agentMail` and `visitorAuth` mounts currently reference the same
global `AGENTMAIL_*` variables. When both are installed, configure the
mailbox augment first, then make visitor auth reuse that inbox and API key:

```bash
auggy agentmail setup agentMail --mode connect
auggy agentmail setup visitorAuth --mode env
```

An interactive add containing both augments performs this sequence after one
shared confirmation. Automatic setup refuses custom, inline, renamed, or
additional AgentMail consumers because changing shared globals could silently
retarget another augment. Give those consumers distinct environment references
or isolate them in separate agents, then run `auggy doctor`.

The runtime responsibilities remain independent. `visitorAuth` sends a magic
link through AgentMail; the visitor's click returns directly to Auggy's public
verification route. It does not require the `agentMail` augment, inbound mail,
WebSockets, or draft processing. The `agentMail` augment separately owns
mailbox wake-up, catch-up, provider-native drafts, and creator review. See
[AgentMail](./22-agent-mail.md) for that workflow.

Removing either augment does not revoke the remote inbox/key or delete
`AGENTMAIL_*`. Auggy retains them while another shared consumer is installed
because removal alone cannot prove that they are unused. After checking the
remaining topology—or removing the last consumer—verify that nothing else uses
the inbox, revoke its key in AgentMail if appropriate, and only then remove the
local values. Auggy never revokes it automatically.

### Failure recovery

Setup is read-only against AgentMail, so a failed attempt cannot leave a newly
created remote resource behind. It writes local configuration only after the
inbox identity is validated for the supplied key.

- For `401` or `403`, confirm the key is active, scoped to the selected inbox,
  and grants `inbox_read` plus `message_send`. Change permissions in AgentMail,
  then retry.
- For `404`, copy the exact inbox ID from AgentMail and retry.
- For an unknown network outcome, it is safe to rerun: setup performs provider
  reads only. No message is sent during validation.
- If local values are already correct, use `--mode env`; if you intend to
  change them, update the exact values and use `--mode connect`.

After a visitor clicks the verification link, the success page stores the signed
visitor token in browser localStorage. `/console/chat` and public frontends should
send that token as `x-visitor-token` on the next `/agent/run` request so the turn
arrives as `public` + `recognized` with verified-email context.

If `layeredMemory` is installed, future turns also receive the visitor's recent
peer-scoped memory automatically. A generic returning message like "hey" can
still include useful context such as prior preferences, open commitments, or
the visitor's name.

## Console mode for local testing

Preview adopters who haven't configured AgentMail can still exercise the full magic-link flow by switching the delivery transport to the console adapter. The verify URL prints to the agent's stdout instead of being sent via email — the operator copies the link from their terminal and opens it in a browser to complete verification.

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

`agentBinding` is a security audience, not a display name. Configure the same
stable, unique value on `visitorAuth.agentBinding`. The CLI resolver injects
that value into `webTransport.visitorTokens.agentBinding`; if you also set it
there or set `webTransport.securityNamespace`, use the same value. The web
transport always validates the embedded audience; in direct programmatic use,
an omitted token binding defaults to `securityNamespace`, then the registered
agent name. The historical
`visitorAuth` factory fallback `"auggy"` remains for standalone compatibility
but does not authenticate to a differently named web transport. Set the
binding explicitly before deployment or renaming an agent. CLI-managed agents
that mount both augments fail boot unless visitorAuth supplies an explicit
binding and the effective web binding matches.
Existing tokens
minted for a former binding stop authenticating and visitors must reverify;
this fail-closed invalidation prevents replay between agents that share a
signing key.

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
| `AGENTMAIL_API_KEY` | AgentMail bearer token (`am_*`), used unchanged. It needs `inbox_read` and `message_send` for visitorAuth. |
| `AGENTMAIL_INBOX_ID` | Inbox the verify email is sent FROM |
| `AUGGY_PUBLIC_URL` | Base URL operators reach the agent at; embedded in the magic link |
| `VISITOR_SIGNING_KEY` | HMAC key for visitor tokens; set only in `visitorAuth` — auto-injected into webTransport |
| `AUGGY_AGENT_ID` | Stable per-agent security audience; required by CLI-managed agents that combine visitorAuth and webTransport. Direct web transports default their binding to `securityNamespace`, then the registered agent name, and always enforce it. |

## Key constraints

- Set `signingKey` only in `visitorAuth`. The augment-resolver auto-injects it into `webTransport.visitorTokens` at boot. Setting it in both places triggers a warning and `visitorAuth`'s value takes precedence. If they differ, visitor tokens minted by visitorAuth will fail webTransport's verification.
- AgentMail keys should be least-privilege. visitorAuth uses `inbox_read` during
  setup and boot healthchecks and `message_send` for verification delivery.
  Setup proves only inbox access; the first delivery exercises `message_send`.
  An over-privileged key remains over-privileged because Auggy uses the exact
  key supplied by the operator.
- `publicUrl` MUST point to a host where the agent's `/visitor-auth/verify` route is reachable from the public internet. If you're running behind a tunnel (ngrok, Cloudflare), use the tunnel URL; if you're running on Railway, use the Railway domain.
- Per-email rate limits are **in-memory only** — restart resets state.
  Verification tokens and visitors live in the schema-branded SQLite store;
  the unique email constraint and atomic token update prevent duplicate
  verification commits.

## Operator commands

```bash
# List verified visitors
auggy visitors zip

# Hard-revoke a verified visitor (deny identity + cascade memory erasure)
auggy visitors zip --revoke alice@example.com
auggy visitors zip --revoke alice@example.com --yes      # non-interactive
```

Revocation atomically invalidates every outstanding magic link for the email;
a link issued before `revoked_at` cannot reactivate the identity even if its
consume raced the operator action. Concurrent links issued after revocation
converge on one canonical replacement identity.

If the authentication decision commits but memory erasure fails, the command
exits nonzero and names the retired identity whose erasure is incomplete. Fix
the store and re-run the same revoke command. The denylist retains every prior
identity for the email, so retries erase all retired IDs even if the visitor
reverified and rotated between attempts. Successful retries are idempotent.

Revocation and anonymous-to-recognized migration also write a durable
per-namespace peer tombstone in `memory.db`. Every explicit and auto-save write
checks that tombstone inside its SQLite transaction. A turn already in flight
therefore cannot recreate revoked memory or write under the retired anonymous
identity after the migration completes. Reverification rotates to a new
`vis_` identity; it does not clear the retired identity's tombstone. CLI email
lookups trim and lowercase operator input just like enrollment.

## How verification works (operational view)

1. Visitor types email in chat (e.g., "I'm alice@example.com").
2. Agent decides to verify, calls `request_auth({method: "email", email: "alice@example.com"})`.
3. visitorAuth validates: email format, email-must-appear-in-recent-messages (defense against confused-deputy), and the configured per-email rate limit. AgentMail delivery defaults to 1/hour and 3/day; local console delivery defaults to a 10-second minimum interval.
4. Generates a UUID token. Writes a row to `visitor_auth_tokens` with 15-minute TTL. Sends email via `agentmail-client.ts` (direct, not through `notify`).
5. Visitor clicks link in email. GET hits `/visitor-auth/verify?token=<uuid>`.
6. One atomic `UPDATE ... RETURNING` both consumes the unexpired token and
   returns the row needed for verification. Concurrent clicks cannot both win.
7. On consumed=1: mints HMAC-signed `vis_<uuid>` (same key webTransport uses; reuses an existing visitorId on re-verify so memory continuity survives), writes verified_visitors row, runs anonymous→recognized peer-id migration only inside the matching immutable-agent layered-memory namespace, and returns success HTML.
8. Success HTML stashes the token in localStorage + replaces URL via `history.replaceState`.
9. Chat tab listens for `storage` events, picks up new token, includes it as `x-visitor-token` on next request.
10. webTransport's identity Path 3 verifies the token, peer.id is now `vis_<uuid>`, peer.publicSubstate is `recognized`.

## Security posture

- **Confused-deputy defense (fix #4):** the augment refuses to send to an email that did not appear verbatim in one of the visitor's last 4 messages.
- **Rate-limit defense (fix #1):** 1 send per anonymous peer per hour, 3 per day. Per-IP per-route limit (60/min) layered above by webTransport.
- **Token leakage defense (fix #5):** verify-success page has `<meta name="referrer" content="no-referrer">`, zero external assets, runs `history.replaceState` on load to drop the token from the URL bar.
- **Token replay defense (fix #8):** atomic `UPDATE ... RETURNING`; one caller
  receives the consumed token row and all later/concurrent callers return 410.
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
| AgentMail healthcheck returns 403 | API key lacks access to the configured inbox, or a permission whitelist omitted `inbox_read` | Update the key in AgentMail, or intentionally connect a different exact key with `--mode connect`; restart |
| `auggy visitors --revoke` reports `memory.db` missing | layeredMemory has not created its DB yet, or a local custom path differs | Check `layeredMemoryDbPath` in `augments/visitorAuth/augment.yaml`. Portable catalog defaults use `./memory.db`; Railway resolves it directly under `/app/data`. |

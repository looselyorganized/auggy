# `agentMail` augment

**Status:** Outbound is stable. Policy-gated polling, WebSocket, and
Svix-verified webhook inbound are available on the unreleased integration line.

Post-v1 inbound requirement: when inbound is enabled, `agentMail` must not rely
only on a live connection. It needs an arrival path (WebSocket/polling/webhook)
and a restart catch-up/checkpoint pass so an agent that was offline can discover
mail it missed and inject it into the turn loop deliberately.

The Phase B foundation uses a structural provider boundary: REST catch-up,
WebSocket, and verified-webhook adapters implement concrete reader/listener
interfaces and produce the same validated inbound envelope. There is no
provider `capabilities` or `supports` metadata bag. Runtime behavior is derived
from the concrete adapter supplied for the configured mode. List responses are
treated as metadata only; catch-up fetches each full message before it can enter
the ledger or turn loop. Received, spam, blocked, and unauthenticated variants
remain distinct until inbound policy makes an explicit decision.

Inbound durability is ledger-first. A validated live event is written to
SQLite before it can trigger a turn. Catch-up lists oldest-first, fetches every
full message in a page, then commits the whole page and its high-water
checkpoint in one transaction. Restart queries overlap that checkpoint by one
minute; replayed results are harmless because inbox ID plus message ID is the
durable identity. Pending work is claimed with a renewable lease and reaches a
terminal state only after explicit `processed` or policy-driven `discarded`
acknowledgement. Expired leases become claimable again, while a stale lease
token cannot complete the replacement claim. The database and its WAL/SHM
companions are created with owner-only permissions because message bodies may
contain sensitive data.

The REST/WebSocket adapter uses AgentMail TypeScript SDK 0.5.14.
Every REST scan requests ascending order and explicitly includes spam, blocked,
and unauthenticated mail; sent/outbound list entries advance the scanned
watermark but never become inbound ledger work. Because list entries are
metadata-only, each received entry is fetched through the full-message endpoint
before the page commits. The WebSocket subscribes to all four received event
types, waits for the server to confirm the inbox and event filters, and
re-subscribes on every automatic reconnect. Reconnect confirmation runs a REST
catch-up before new live events are released, closing the disconnect gap.

Webhook admission uses the official Svix verifier against the exact raw HTTP
body plus `svix-id`, `svix-timestamp`, and `svix-signature`. Startup fails when
the secret is missing or malformed, replay tolerance cannot exceed five
minutes, and the route acknowledges a received event only after the canonical
envelope is in the durable ledger. Retries are deduplicated by inbox/message
identity and provider event ID. The route factory is present as an ingestion
primitive and feeds the same durable turn worker as REST and WebSocket input.

Inbound activation is fail-closed. Enabling any inbound mode requires a
non-empty sender allowlist using exact addresses or `*@domain` patterns.
Ordinary `message.received` mail is processed by default; spam, blocked, and
unauthenticated variants are durably discarded unless the operator explicitly
changes the matching classification action. Even allowlisted senders remain
`public/anonymous`: an email `From:` address never establishes creator or agent
identity. Accepted bodies are JSON-escaped, marked as untrusted external data,
and capped before normal kernel admission. The normal transport queue, turn
budgets, tool visibility, lifecycle hooks, and public-peer preamble all apply.

Sends email through AgentMail with per-peer trust gating, recipient allowlist, rate limits, dedup, sensitive-content auditing, and console API status blocks. Exposes three model-facing tools whose names align with AgentMail's MCP standard: `send_message`, `reply_to_message`, `forward_message`.

## When to use

Add `agentMail` when you want your agent to be able to:

- Compose and send transactional or proactive email from a dedicated inbox
- Reply to inbound mail (Phase B — when a WebSocket / webhook delivers an inbound message into the turn loop)
- Forward inbound mail to teammates or escalate to the operator

If you only need email for `visitorAuth` magic links, you don't need this augment — `visitorAuth` continues to use the shared `agentmail-client.ts` directly. Run `auggy augment setup visitorAuth` to provision or configure the AgentMail inbox used for magic links. If you only need outbound notifications to a fixed destination (e.g. "ping the operator"), `notify` with the `agentmail` adapter is simpler.

After installing the `agentMail` augment, configure its inbox with:

```bash
auggy augment setup agentMail
```

## Why an augment and not the MCP server

AgentMail also runs a hosted MCP server at `https://mcp.agentmail.to/mcp` with the same tool surface. Use this augment instead when you need either:

1. **Inbound delivery into turns** (Phase B+). MCP is pull-only — it cannot push a `message.received` event into the agent's turn loop. A scheduler-driven "check inbox" loop via MCP runs a full LLM turn for every empty poll, which costs roughly $30/day per agent at 60s polling. The augment runs the polling/listening at the REST/WS layer and only invokes the LLM when there's actually mail.
2. **Per-peer policy.** MCP can't see who's currently talking to the agent. The augment applies trust-level gating, recipient allowlist, rate limiting, and audit logging on every outbound call.

If you don't need either, mounting the MCP server is fine and arguably simpler.

## Configuration

```yaml
# agent.yaml
augments:
  - agentMail

# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  # apiBaseUrl: https://api.agentmail.to/v0  # override for sandbox

  outbound:
    # Default ["creator"] — agent and public peers cannot send unless added.
    allowedTrustLevels: [creator]

    # Public-originated actions are queued by default. The persisted queue is
    # reviewed through the authenticated admin action API. An empty list opts
    # into autonomous public sending and should be used deliberately.
    humanReview:
      requiredForTrustLevels: [public]
      expiresAfterMs: 86400000  # 24 hours

    # When set, only these recipients may receive mail. Lowercased compare.
    # Glob form: "*@example.com" matches any address at that domain.
    # allowedRecipients:
    #   - operator@acme.com
    #   - "*@trusted.com"

    # Hard cap on recipients per send. AgentMail's absolute ceiling is 50;
    # we default to 10 to make accidental list-blast impossible.
    maxRecipients: 10

    bodyMaxBytes: 102400  # 100KB
    allowHtml: false       # default; opt in if you specifically need HTML

    # Prepended to every outbound subject so recipients can identify
    # agent-sent mail. Cannot be empty.
    subjectPrefix: "[Auggy] "

    rateLimit:
      enabled: true
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000  # 5 min between sends to same address
      dedupWindowMs: 300000           # 5 min subject-hash dedup

  inbound:
    # none | polling | websocket | webhook
    mode: websocket

    # Required whenever mode is not none. This is an admission allowlist,
    # never an identity or trust-level promotion.
    allowedSenders:
      - customer@example.com
      - "*@trusted.example"

    # Secure defaults shown explicitly. Opting a classification into process
    # still leaves that sender at public/anonymous trust.
    classifications:
      received: process
      spam: discard
      blocked: discard
      unauthenticated: discard

    pollIntervalMs: 60000
    maxPromptBytes: 102400
    maxAttempts: 5

    # Required block for mode: webhook. Values below are defaults.
    # webhook:
    #   path: /webhooks/agentmail
    #   secretEnv: AGENTMAIL_WEBHOOK_SECRET
    #   timestampToleranceSeconds: 300
```

## Environment variables

| Var | What |
|-----|------|
| `AGENTMAIL_API_KEY` | Your AgentMail API key (starts with `am_`). |
| `AGENTMAIL_INBOX_ID` | Inbox ID to send from / receive at (e.g. `support-agent@agentmail.to`). |
| `AGENTMAIL_WEBHOOK_SECRET` | Added with Phase C — the `whsec_…` from AgentMail's webhook dashboard. |

## Tools exposed to the model

| Tool | Inputs | Returns |
|------|--------|---------|
| `send_message` | `{ to[], subject, text, html?, labels?, threadKey? }` | `{ status: "sent" \| "pending_review" \| "rate_limited" \| "failed", messageId?, threadId?, reviewId?, message?, retryAfterSec? }` |
| `reply_to_message` | `{ messageId, text, html?, replyAll?, labels? }` | same envelope |
| `forward_message` | `{ messageId, to[], text?, html?, subject?, labels? }` | same envelope |

`messageId` for reply/forward must be one the agent saw in that exact inbound
turn. The runtime removes the message scope when the turn settles, preventing a
different web or email turn from replaying an old message ID.

## Guards (every outbound tool)

| Layer | Behavior |
|-------|----------|
| **Trust-level gate** | Default `creator` only. `agent` and `public` peers rejected unless added to `outbound.allowedTrustLevels`. |
| **Human review** | Valid actions from `public` peers enter a durable review queue by default. The authenticated inspect action returns exact content plus a fingerprint that approval must echo, binding consent to what was reviewed. Approval rechecks current rate limits; rejection and expiry are terminal. Configure `humanReview.requiredForTrustLevels: []` only for deliberate autonomous public mail. |
| **Recipient allowlist** | If `outbound.allowedRecipients` is set, every recipient must match (exact or `*@domain` glob, lowercased). |
| **Recipient cap** | `outbound.maxRecipients` (default 10, hard ceiling 50). |
| **Body cap** | `outbound.bodyMaxBytes` (default 100KB). |
| **HTML opt-in** | `outbound.allowHtml: false` by default. |
| **Subject prefix** | `outbound.subjectPrefix` (default `"[Auggy] "`) is applied automatically. Cannot be empty. |
| **Sanitization** | Control characters (CR/tab/etc.) stripped from subject. Bodies containing the SMTP `CRLF.CRLF` envelope-end sequence are rejected. |
| **Rate limits** | Global cap per hour + per-recipient cooldown + subject-hash dedup. Creator (and null/system peer) bypass. |
| **Sensitive scan** | Bodies containing token shapes (`am_`/`sk-`/`xoxb-`/`eyJ`/`gh[ousr]_`/`AKIA…`) are flagged in the admin ring buffer but the send proceeds. The model is taught (via the bundled skill) what to omit. |

## Console/API info

AgentMail exposes admin-info blocks to the authenticated console dashboard API:

- Runtime status, inbound mode/readiness, durable ledger counts, catch-up checkpoint and latest catch-up summary
- Last inbound event and worker outcome, plus sanitized provider errors
- Masked API key, inbox ID, current global cap (yaml vs override), allowed trust levels, recipient allowlist size
- Last 50 dispatches with timestamp / tool / status / **redacted** recipients / subject
- Actions: "Send test email", "Adjust globalMaxPerHour", and inspect/approve/reject a queued outbound review

Recipients in the audit table are redacted (`al***@example.com (+2)`) so the admin view never leaks full address lists.

## Operations and rollout

Choose one arrival mode per process:

- `websocket` is the default when the agent can make outbound connections but
  has no stable public URL. Every confirmed subscription runs REST catch-up
  before live events are released.
- `webhook` is appropriate behind an HTTPS-capable `webTransport`. Configure
  the exact Svix signing secret and keep the default five-minute replay window
  unless a smaller value is operationally safe.
- `polling` is the simplest fallback. Polling and webhook startup both finish
  REST catch-up before the inbound transport reports ready.

Production state is sensitive and must move together during backup/restore:

- `agent-mail.db`, `agent-mail.db-wal`, and `agent-mail.db-shm` hold inbound
  bodies, checkpoints, leases, and terminal decisions. Stop the agent or use a
  SQLite-consistent backup mechanism; do not copy only the main file while it
  is running.
- `agent-mail-reviews.json` holds exact queued outbound actions. It is written
  atomically with owner-only permissions. A record left in `sending` after a
  crash is intentionally ambiguous and is never auto-retried; reconcile it
  against AgentMail before composing a replacement.
- `agent-mail-state.json` holds outbound cooldown and dedup state. Losing it
  weakens duplicate protection after restart.

Run only one agent process per `agentDir`. SQLite safely serializes its ledger,
but the review queue and outbound rate state are process-local writers backed
by atomic JSON replacement, not a distributed coordination protocol.

Rollout checklist:

1. Start with `inbound.mode: none`; verify inbox credentials and a creator-only
   test send.
2. Configure an exact/domain sender allowlist and keep risky classifications
   on `discard`.
3. Enable one inbound mode and confirm the admin status is `ok`, the catch-up
   checkpoint advances, and a test message reaches `processed` or an expected
   durable discard state.
4. If public mail may propose replies, add `public` to
   `outbound.allowedTrustLevels` but keep default human review. Inspect the
   exact action, then approve with its fingerprint.
5. Alert on provider warnings, a growing pending/processing ledger, ambiguous
   `sending` reviews, repeated discarded work, or a stale catch-up timestamp.

## Common operator pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Boot error: `AGENTMAIL_API_KEY is unresolved` | `.env` missing the var | Set `AGENTMAIL_API_KEY=am_…` in `.env`, restart |
| Boot error: `healthcheck failed with HTTP 401` | Wrong API key | Verify the key in [console.agentmail.to](https://console.agentmail.to) |
| Tool returns `failed: trust level "public" is not permitted` | Anonymous visitor asked the agent to send | Either ignore (correct) or add `public` to `outbound.allowedTrustLevels`; its action will still require human review by default |
| Tool returns `pending_review` | A configured trust level proposed outbound mail | Inspect the exact action through the authenticated admin API, then approve with its returned fingerprint or reject it before expiry |
| Tool returns `rate_limited` on every send | Global cap or dedup window misconfigured | Set `outbound.rateLimit.globalMaxPerHour` |
| Admin status warns `inbound not ready` | Listener/catch-up never completed | Inspect the sanitized provider error, credentials, and network path; startup remains fail-closed for inbound |
| Review remains `sending` after restart | Process stopped after dispatch began but before acknowledgement was persisted | Reconcile the provider message/thread before creating any replacement; the runtime will not auto-retry |
| Audit table shows `⚠` marker | Body contained a token-shaped string | Read the dispatch detail — operator's job to nudge the model toward better behavior |

## What this augment does NOT do (yet)

- **Automatic free-form response delivery** — a plain assistant response is
  never mailed. Use `reply_to_message`; public-originated replies enter human
  review by default.
- **Attachments** — AgentMail supports base64; not yet implemented in the augment.
- **Drafts** — AgentMail's `/drafts` endpoints are not exposed; defer.
- **WebSocket transport for outbound events** — `message.sent` / `message.delivered` / `message.bounced` lands in the audit ring buffer once Phase B's inbound channel exists.

## Related

- `src/agentmail-client.ts` — the shared REST client used by this augment, `notify`'s `agentmail` adapter, and `visitorAuth`'s magic-link flow.
- [`07-built-in-augments.md`](./07-built-in-augments.md) — augment-catalog overview.
- AgentMail docs: [welcome](https://docs.agentmail.to/welcome) · [API reference](https://docs.agentmail.to/api-reference) · [WebSockets](https://docs.agentmail.to/websockets/quickstart) · [Webhook verification](https://docs.agentmail.to/webhook-verification).

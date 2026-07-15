# `agentMail` augment

**Status:** Phase A (outbound) — shipping. Phase B (WebSocket / polling inbound) and Phase C (Svix-verified webhook inbound) tracked separately.

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
    mode: none  # Phase A only. Phase B will add "websocket"/"polling"; Phase C "webhook".
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
| `send_message` | `{ to[], subject, text, html?, labels?, threadKey? }` | `{ status: "sent" \| "rate_limited" \| "failed", messageId?, threadId?, message?, retryAfterSec? }` |
| `reply_to_message` | `{ messageId, text, html?, replyAll?, labels? }` | same envelope |
| `forward_message` | `{ messageId, to[], text?, html?, subject?, labels? }` | same envelope |

`messageId` for reply/forward must be one the agent saw via its inbound trigger this turn. Phase A has no inbound delivery, so these two tools always fail in Phase A unless a test seam pre-populates the seen-set.

## Guards (every outbound tool)

| Layer | Behavior |
|-------|----------|
| **Trust-level gate** | Default `creator` only. `agent` and `public` peers rejected unless added to `outbound.allowedTrustLevels`. |
| **Recipient allowlist** | If `outbound.allowedRecipients` is set, every recipient must match (exact or `*@domain` glob, lowercased). |
| **Recipient cap** | `outbound.maxRecipients` (default 10, hard ceiling 50). |
| **Body cap** | `outbound.bodyMaxBytes` (default 100KB). |
| **HTML opt-in** | `outbound.allowHtml: false` by default. |
| **Subject prefix** | `outbound.subjectPrefix` (default `"[Auggy] "`) is applied automatically. Cannot be empty. |
| **Sanitization** | Control characters (CR/tab/etc.) stripped from subject. Bodies containing the SMTP `CRLF.CRLF` envelope-end sequence are rejected. |
| **Rate limits** | Global cap per hour + per-recipient cooldown + subject-hash dedup. Creator (and null/system peer) bypass. |
| **Sensitive scan** | Bodies containing token shapes (`am_`/`sk-`/`xoxb-`/`eyJ`/`gh[ousr]_`/`AKIA…`) are flagged in the admin ring buffer but the send proceeds. The model is taught (via the bundled skill) what to omit. |

## Console/API info

AgentMail exposes admin-info blocks to the console dashboard API. The v1
chat-first console does not render these as top-level controls by default.
Future developer surfaces can show:

- Masked API key, inbox ID, current global cap (yaml vs override), allowed trust levels, recipient allowlist size
- Last 50 dispatches with timestamp / tool / status / **redacted** recipients / subject
- Actions: "Send test email" and "Adjust globalMaxPerHour" (persists via `admin-overrides.json`)

Recipients in the audit table are redacted (`al***@example.com (+2)`) so the admin view never leaks full address lists.

## Common operator pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Boot error: `AGENTMAIL_API_KEY is unresolved` | `.env` missing the var | Set `AGENTMAIL_API_KEY=am_…` in `.env`, restart |
| Boot error: `healthcheck failed with HTTP 401` | Wrong API key | Verify the key in [console.agentmail.to](https://console.agentmail.to) |
| Tool returns `failed: trust level "public" is not permitted` | Anonymous visitor asked the agent to send | Either ignore (correct) or add `agent`/`public` to `outbound.allowedTrustLevels` if you really want broader access |
| Tool returns `rate_limited` on every send | Global cap or dedup window misconfigured | Set `outbound.rateLimit.globalMaxPerHour` |
| Audit table shows `⚠` marker | Body contained a token-shaped string | Read the dispatch detail — operator's job to nudge the model toward better behavior |

## What this augment does NOT do (yet)

- **Inbound delivery** — Phase B (WebSocket + polling) and Phase C (Svix webhook) ship separately.
- **Attachments** — AgentMail supports base64; not yet implemented in the augment.
- **Drafts** — AgentMail's `/drafts` endpoints are not exposed; defer.
- **WebSocket transport for outbound events** — `message.sent` / `message.delivered` / `message.bounced` lands in the audit ring buffer once Phase B's inbound channel exists.

## Related

- `src/agentmail-client.ts` — the shared REST client used by this augment, `notify`'s `agentmail` adapter, and `visitorAuth`'s magic-link flow.
- [`07-built-in-augments.md`](./07-built-in-augments.md) — augment-catalog overview.
- AgentMail docs: [welcome](https://docs.agentmail.to/welcome) · [API reference](https://docs.agentmail.to/api-reference) · [WebSockets](https://docs.agentmail.to/websockets/quickstart) · [Webhook verification](https://docs.agentmail.to/webhook-verification).

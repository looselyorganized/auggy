# 13 — Notify Augment Reference

> Operator reference for the `notify` augment — outbound messaging to
> operator-defined destinations via log-to-file, webhook, Telegram, and
> AgentMail adapters, with destination authority, rate limiting, and dedup.
> Source: `src/augments/notify/`, `src/types.ts`.

## 1. Overview

The `notify` augment gives an agent a `notify` tool for pushing messages to operator-defined destinations outside the current conversation. Unlike transport replies — where the agent sends text back to the peer who triggered the current turn — `notify` pushes to destinations that are **not** the active peer. Use it when the agent needs to alert an operator, escalate a situation, share a status update, or hand off to a human mid-conversation.

Destinations are declared in config, not in the agent prompt. The agent always refers to a destination by its operator-assigned name (`"creator"`, `"ops"`, `"alerts"`, etc.). This keeps Telegram chat IDs and webhook URLs out of the model's context entirely.

By default, a destination is available only to `creator` and `agent` trust. Add `public` to `allowedTrustLevels` only for destinations intended to receive public-originated escalation notifications.

What it does:

- **Named destinations** — operator declares webhook and/or Telegram targets in
  `augments/notify/augment.yaml`; the agent calls
  `notify({ to: "<name>", ... })`.
- **Four adapters** — `log-to-file`, `webhook`, `telegram`, and `agentmail`.
- **Destination authority** — each destination can restrict which v1 trust
  levels may use it, and can require public peers to provide an escalation
  reason.
- **Rate limiting** — cooldown, dedup, global hourly cap, per-peer cooldown. Creator-class senders bypass all limits.

What it does **not** do:

- No inbound handling — `notify` is outbound only. Use `telegramTransport` for bidirectional Telegram.
- No delivery receipts beyond `sent` / `failed` — no retry queue.
- No batching — each `notify` call is a single delivery attempt.

## 2. Configuration

### Minimal CLI project config

```yaml
# agent.yaml
augments:
  - notify

# augments/notify/augment.yaml
type: notify
config:
  destinations:
    - name: creator
      transport: log-to-file
      path: ./notifications.jsonl
```

### Full example — webhook + telegram destinations with rate limiting

```yaml
# augments/notify/augment.yaml
type: notify
config:
  destinations:
    - name: creator
      transport: webhook
      url: ${ORG_NOTIFY_URL}
      headers:
        X-Api-Key: ${NOTIFY_API_KEY}
      allowedTrustLevels: [creator, agent]
    - name: alerts
      transport: telegram
      botToken: ${TELEGRAM_BOT_TOKEN}
      chatId: ${TELEGRAM_CHAT_ID}
      parseMode: Markdown
      allowedTrustLevels: [creator, agent, public]
      publicPolicy: escalation-only
  rateLimit:
    enabled: true
    cooldownMs: 120000
    globalMaxPerHour: 5
    dedupWindowMs: 300000
    dedupThreshold: 0.6
    perPeerCooldownMs: 30000
```

The `notify` id must also be enabled in `agent.yaml`:

```yaml
augments:
  - notify
```

### Programmatic setup

```ts
import { notify } from "auggy";

const notifyAugment = notify({
  destinations: [
    {
      name: "creator",
      transport: "webhook",
      url: process.env.ORG_NOTIFY_URL!,
      allowedTrustLevels: ["creator", "agent"],
    },
    {
      name: "alerts",
      transport: "telegram",
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      chatId: Number(process.env.TELEGRAM_CHAT_ID),
      parseMode: "Markdown",
      allowedTrustLevels: ["creator", "agent", "public"],
      publicPolicy: "escalation-only",
    },
  ],
  rateLimit: {
    cooldownMs: 120_000,
    globalMaxPerHour: 5,
    perPeerCooldownMs: 30_000,
  },
});
```

### Top-level configuration fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `destinations` | `NotifyDestination[]` | yes | — | One or more named delivery targets. |
| `rateLimit` | `NotifyRateLimitOptions` | no | See §5 | Rate limit configuration. |

### Common destination authority fields

All destination types accept these optional authority fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `allowedTrustLevels` | `("creator" \| "agent" \| "public")[]` | `["creator", "agent"]` | Trust levels allowed to use this destination. Add `public` explicitly for public escalation destinations. |
| `publicPolicy` | `"allowed" \| "escalation-only"` | `"allowed"` | When set to `"escalation-only"`, public peers must include a non-empty `reason` in the `notify` call. Creator and agent peers are unaffected. |

Authority is enforced before rate limits and delivery. A denied destination
returns `status: "failed"` and does not consume rate-limit quota.

### `NotifyDestination` — webhook

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Logical name the agent uses in `to:`. Must be unique across all destinations. |
| `transport` | `"webhook"` | yes | Selects the HTTP POST adapter. |
| `url` | `string` | yes | Full URL to POST to. Env interpolation supported via the CLI. |
| `headers` | `Record<string, string>` | no | Additional HTTP headers (e.g. auth tokens). |

### `NotifyDestination` — telegram

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Logical name the agent uses in `to:`. |
| `transport` | `"telegram"` | yes | Selects the Telegram `sendMessage` adapter. |
| `botToken` | `string` | yes | Bot token from @BotFather. |
| `chatId` | `number \| string` | yes | Target chat (user chat, group, or channel). Numeric preferred. |
| `parseMode` | `"Markdown" \| "HTML" \| "MarkdownV2"` | no | `"Markdown"` | Telegram parse mode. |

### `NotifyRateLimitOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Set to `false` to disable all rate limiting globally. |
| `cooldownMs` | `number` | `120000` | Global cooldown in ms before a second notification is allowed (2 minutes). |
| `globalMaxPerHour` | `number` | `5` | Maximum notifications per rolling 60-minute window. |
| `dedupWindowMs` | `number` | `300000` | Window in ms during which similar summaries are considered duplicates (5 minutes). |
| `dedupThreshold` | `number` | `0.6` | Fraction of word overlap required to suppress as a duplicate. `0` disables dedup. |
| `perPeerCooldownMs` | `number` | same as `cooldownMs` | Per-peer cooldown in ms. Defaults to the global `cooldownMs` if not set explicitly. |

## 3. Tool surface

The `notify` augment exposes one tool to the agent model:

```
notify({
  to: string,         // required — destination name from config (e.g. "creator")
  summary: string,    // required — brief description of what needs attention
  reason?: string,    // optional — why this notification is being sent
  visitor?: string,   // optional — visitor name or identifier if relevant
})
```

### Return shape

```json
{ "status": "sent" }
{ "status": "rate_limited", "message": "Notification suppressed — per-peer cooldown active. Next available in 85 seconds." }
{ "status": "failed",       "message": "Unknown destination 'ops'. Configured destinations: creator." }
{ "status": "failed",       "detail": "webhook https://... returned 404: Not Found" }
```

The model sees the `status` field and an optional `message` or `detail` field. On `rate_limited`, the reason message includes the remaining cooldown in seconds (per-peer) so the agent can report it accurately to the visitor if relevant.

### Category

The tool is registered with `category: "communication"` and is visible to all
trust levels by default. Destination-level authority decides whether the active
peer may use the selected destination. Creator-class senders bypass rate
limits, but they still must use a configured destination.

## 4. Adapters

### Log-to-file adapter

The log-to-file adapter appends one JSON object per notification to a local
JSONL file. This is the zero-secret default installed by
`auggy augment add notify`, so local agents can exercise the tool before the
operator configures real delivery.

### Webhook adapter

The webhook adapter POSTs a JSON body to the configured URL using the shared `src/http.ts` client (10-second timeout, `User-Agent: auggy-notify-webhook/0.1`).

**Request body:**

```json
{
  "summary": "Visitor wants partnership discussion",
  "reason": "Outside my scope",
  "visitor": "Alice",
  "channel": "notify"
}
```

`reason` and `visitor` are omitted from the body when not provided by the caller. The `channel` field is always `"notify"` — it lets the receiving endpoint distinguish `notify` POSTs from other augment traffic if the endpoint is shared.

**Response:** Any `2xx` status is treated as success. Any other status code is a `failed` delivery with the status code and up to 200 characters of the response body in `detail`.

**Custom headers:** The `headers` field is merged into the request. Use it for API keys, HMAC tokens, or any other per-destination auth that the receiving server requires.

> **Why a shared HTTP client?** The webhook adapter reuses `src/http.ts` rather than a raw `fetch()` call so it inherits redirect security (auth-header stripping on cross-origin redirects) and the body size cap. Both matter when the URL is operator-supplied.

### Telegram adapter

The Telegram adapter calls `sendMessage` via the shared `src/telegram-client.ts`. It builds a Markdown-formatted message from the payload fields:

```
*<summary>*
_Reason:_ <reason>
_Visitor:_ <visitor>
```

Fields are only included when present. `reason` and `visitor` lines are omitted if the caller did not supply them.

**Parse mode:** Defaults to `"Markdown"`. Change to `"HTML"` or `"MarkdownV2"` in the destination config if the receiving chat renders those modes better. Note that `"MarkdownV2"` requires escaping of reserved characters — if summary text is operator-free-form, `"Markdown"` is the safer choice.

**Client reuse:** The adapter caches a `TelegramBotClient` per `botToken` string. Multiple telegram destinations sharing the same bot token share one client instance.

> **Why not cross-augment coupling?** The Telegram adapter does not import from `telegramTransport`. Both share `src/telegram-client.ts` as a utility. This means `notify` can use a Telegram destination independently of whether `telegramTransport` is installed, and adding `notify` to an agent with no Telegram transport is safe.

### AgentMail adapter

Sends outbound email via [AgentMail](https://www.agentmail.to/docs/welcome). Each destination carries the API key, source inbox, and recipient — multiple `agentmail` destinations may share an API key (the adapter caches the http client per key implicitly via the shared `createHttpClient`).

````yaml
# augments/notify/augment.yaml
type: notify
config:
  destinations:
    - name: creator-mail
      transport: agentmail
      apiKey: ${AGENTMAIL_API_KEY}
      inboxId: ${AGENTMAIL_INBOX_ID}
      to: operator@example.com
      subjectPrefix: "[Zip] "
      labels: ["alert"]
````

Required env vars:

- `AGENTMAIL_API_KEY` — bearer token from AgentMail (prefix `am_`). Use a per-inbox key with the minimum permission set: `message_send`. Org-scoped keys are over-broad — see [security note](#agentmail-key-scoping).
- `AGENTMAIL_INBOX_ID` — the AgentMail inbox the message is sent **from**.

Optional fields on the destination:

- `to` — recipient email. String or array. The adapter normalizes both to an array on the wire.
- `subjectPrefix` — prepended to `payload.summary` to form the subject line.
- `labels` — applied to the sent message in AgentMail (visible in `messages.list`).
- `apiBaseUrl` — overrides the AgentMail API base URL (default `https://api.agentmail.to/v0`).

#### Delivery result mapping

| AgentMail response | `notify` result |
|---|---|
| 2xx with `{message_id, thread_id}` | `{status: "sent"}` |
| Definitive 4xx (auth, validation, invalid recipient) | `{status: "failed", detail: "agentmail ... returned 4xx: <body excerpt>"}` |
| 408 or 5xx after dispatch | Outcome-unknown. The quota reservation is retained and the turn terminates without a model retry. |
| Network exception or malformed success response | Outcome-unknown. Provider details remain internal and the turn terminates without a model retry. |
| 429 (rate-limited at AgentMail tier) | Surfaced as `failed` with the 429 body. The notify augment's own rate-limit machinery is the primary defense; AgentMail's quota is the second layer. |

#### AgentMail-specific gotchas {#agentmail-key-scoping}

- **Suppression list is permanent.** A bounced or complained address is suppressed by AgentMail with no documented removal API. Test with a real recipient before pinning a destination in production.
- **Key scoping.** The OTP-issued key from `agent.sign_up` is org-scoped (full access). Mint an inbox-scoped key with whitelist permissions (`message_send` only) and use that in `.env`. The org-scoped key should be rotated or kept for console use only.
- **Recipient cap.** AgentMail supports at most 50 recipients across an email send/reply/forward. Auggy rejects explicit recipient arrays over that cap before making the network request; `replyAll` can still expand server-side and may be rejected by AgentMail.
- **No provider idempotency on send.** AgentMail's `messages.send` does not
  accept an idempotency key as of this writing. Auggy reserves its local dedup
  slot before dispatch and terminates the turn when delivery becomes
  outcome-unknown, so the model is not invited to retry. An operator can still
  reconcile ambiguous provider outcomes, and a manual retry can still create a
  duplicate if the first send actually landed.
- **Free tier hard cap.** 100 emails/day. The runtime's `dailyBudgetUsd` does not model AgentMail tier limits — the operator should be aware that AgentMail can refuse delivery independently of runtime budgets.
- **Inbound delivery is not part of this adapter.** `notify` remains
  outbound-only. For bidirectional email, add the separate `agentMail` augment;
  it owns sender admission, durable polling/WebSocket/Svix ingestion, and email
  turns.

## 5. Rate limiting

Rate limiting is stateful and in-memory. State resets on agent restart. All checks apply only when `rateLimit.enabled !== false`.

After validation and destination authority succeed, the augment synchronously
reserves every applicable cooldown, cap, and dedup slot before adapter
dispatch. Concurrent calls in one process therefore cannot all pass a stale
check. A started attempt retains its reservation on success, failure, abort, or
timeout because remote delivery may already have occurred. Only failures before
dispatch avoid consuming quota.

### Rate limit checks (in order)

Before rate limits run, destination authority checks allowed trust levels and
public escalation policy. Denied sends return `failed`, not `rate_limited`, and
no rate-limit state is read or written.

1. **Per-peer cooldown** — checked against a `Map<peerId, lastNotifyTimestamp>`. If the peer that triggered the current turn sent a notification within `perPeerCooldownMs`, the tool returns `rate_limited`. The error message includes how many seconds remain.

2. **Global hourly cap** — a rolling window counter. If `globalCountThisHour >= globalMaxPerHour`, returns `rate_limited`. The window resets 60 minutes after it opened (not at the top of the clock hour).

3. **Dedup** — compares the new `summary` against summaries sent within `dedupWindowMs` using word overlap. If overlap of words longer than two characters between the new summary and any recent summary is ≥ `dedupThreshold`, returns `rate_limited`. Set `dedupThreshold: 0` to disable dedup. Set `dedupWindowMs: 0` to effectively disable by expiring the window immediately.

### Creator bypass

Peers with `trustLevel === "creator"` and null peers (internal/scheduled triggers) bypass all rate limit checks entirely. No rate limit state is recorded for them. This ensures operator-injected turns can always escalate regardless of what public-tier peers may have triggered recently.

### Defaults summary

| Check | Default |
|---|---|
| Per-peer cooldown | 120 seconds (same as `cooldownMs`) |
| Global hourly cap | 5 notifications per hour |
| Dedup window | 5 minutes |
| Dedup threshold | 60% word overlap |

## 6. Migration from `org_escalate`

The `org_escalate` tool was removed in v0.2.0 and replaced by `notify`. For agents using the old tool, the migration is a rename with one structural change: the destination is now declared in config rather than the tool call.

**Example migration (operator-supplied `augments/notify/augment.yaml`):**

```yaml
type: notify
config:
  destinations:
    - name: creator
      transport: webhook
      url: ${ORG_CONTEXT_URL}/notify
  rateLimit:
    cooldownMs: 120000
    dedupWindowMs: 300000
    dedupThreshold: 0.6
    globalMaxPerHour: 5
    perPeerCooldownMs: 30000
```

The receiving endpoint (`${ORG_CONTEXT_URL}/notify`) is unchanged — the webhook adapter sends the same `summary`, `reason`, and `visitor` fields the old tool sent. The only change is that the URL is now in config rather than the tool definition, and the tool call becomes:

```
notify({ to: "creator", summary: "...", reason: "...", visitor: "..." })
```

instead of the old:

```
org_escalate({ summary: "...", reason: "...", visitor: "..." })
```

The `org_escalate` skill file in agent skills directories can be replaced with
the `notify` skill scaffolded by `auggy augment add notify`.

## 7. Common operator mistakes

| Mistake | What happens | Fix |
|---|---|---|
| Destination `name` typo in agent prompt or skill | Tool returns `{ status: "failed", message: "Unknown destination 'ops'. Configured destinations: creator." }` | Use the exact name string from config; check spelling |
| Missing `summary` field | Zod validation fails before the tool executes; tool call returns an error | `summary` is required — ensure the skill teaches this |
| Putting `chatId` or raw Telegram user IDs in the agent identity file | Agent may try to pass raw IDs as `to:` argument | Named destinations only; IDs stay in `augments/notify/augment.yaml` |
| Letting public visitors notify an operator-only destination | Tool returns `failed` with an allowed-trust message | Add `public` to `allowedTrustLevels` only for destinations intended for public escalation |
| Setting `publicPolicy: escalation-only` and omitting `reason` | Tool returns `failed` and no delivery is attempted | Include a concise escalation reason, or answer in-thread if no escalation is warranted |
| Setting `globalMaxPerHour: 0` expecting unlimited | `0` means the cap is always exceeded — all notifications are blocked | Omit `rateLimit` entirely or set `enabled: false` for uncapped |
| Sharing a `cooldownMs` value that is much larger than `perPeerCooldownMs` | Per-peer cooldown is defaulted to `cooldownMs` when not set; if you set a large global cooldown and leave `perPeerCooldownMs` unset, all peers share the large cooldown | Set `perPeerCooldownMs` explicitly when the two should differ |
| Using the same bot token for both `notify` (telegram destination) and `telegramTransport` inbound | Fine — they are independent; sending and receiving are concurrent-safe | No fix needed; this is intentional design |

## 8. Troubleshooting

**Notifications stop firing without error**

- The agent returns `rate_limited`. Check the `message` field in the tool result — it includes which check triggered and how long to wait.
- The global hourly cap may have been reached. Rate limit state is in-memory: restart the agent to reset it.
- `dedupThreshold` may be suppressing near-duplicate summaries. Reduce `dedupThreshold` or increase `dedupWindowMs` to make the window shorter.

**Tool returns `status: "failed"` with a destination error**

- Check that the destination `name` in the tool call exactly matches the name in `augments/notify/augment.yaml`. The lookup is case-sensitive.
- If using env interpolation (`${ORG_NOTIFY_URL}`), verify the env var is set at agent start time. Unresolved env vars produce a literal `${...}` string in the URL.

**Webhook returns non-2xx**

- Definitive 4xx responses include the status and a bounded body excerpt in the
  failed result. A 408 or 5xx after POST dispatch is outcome-unknown because
  the receiver may have committed the notification before returning the error;
  check the receiving endpoint before any manual retry.
- The `X-Api-Key` header (or whichever auth header you configured) may be wrong or missing from the `headers` map.

**Telegram delivery fails**

- Confirm the `botToken` is correct and the bot has not been revoked via @BotFather.
- Confirm the `chatId` is a number (not a string username) for direct chats. Group chat IDs are negative numbers.
- If the bot has not exchanged a message with the target chat first, Telegram will reject the `sendMessage` call. Start a conversation with the bot before expecting proactive delivery to succeed.

**Notifications work in dev but not in production**

- Rate limit state is in-memory and resets on restart. A restarted agent starts fresh — the first notification after restart always passes rate limits.
- If running multiple agent instances (not recommended for a single config), each has independent state. Rate limits are not coordinated across instances.
- Tool/request cancellation is forwarded through webhook, Telegram, and
  AgentMail adapters. A deadline after dispatch remains outcome-unknown and is
  not safe to retry automatically.

## Cross-references

- [03-types.md](./03-types.md) — `NotifyAugmentOptions`, `NotifyDestination`, `NotifyRateLimitOptions`, `NotifyDeliveryResult`
- [07-built-in-augments.md](./07-built-in-augments.md) — quick summary of all built-in augments
- [14-telegram-transport.md](./14-telegram-transport.md) — bidirectional Telegram transport; coexistence notes
- `src/augments/notify.ts` — rate limit logic, tool definition
- `src/augments/notify/adapters/webhook.ts` — webhook delivery
- `src/augments/notify/adapters/telegram.ts` — telegram delivery + Markdown formatting

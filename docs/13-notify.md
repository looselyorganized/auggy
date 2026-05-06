# 13 — Notify Augment Reference

> Operator reference for the `notify` augment — outbound messaging to operator-defined destinations via webhook or Telegram adapters, with rate limiting, dedup, and trust-level bypass. Source: `src/augments/notify.ts`, `src/augments/notify/adapters/`, `src/types.ts`.

## 1. Overview

The `notify` augment gives an agent a `notify` tool for pushing messages to operator-defined destinations outside the current conversation. Unlike transport replies — where the agent sends text back to the peer who triggered the current turn — `notify` pushes to destinations that are **not** the active peer. Use it when the agent needs to alert an operator, escalate a situation, share a status update, or hand off to a human mid-conversation.

Destinations are declared in config, not in the agent prompt. The agent always refers to a destination by its operator-assigned name (`"creator"`, `"ops"`, `"alerts"`, etc.). This keeps Telegram chat IDs and webhook URLs out of the model's context entirely.

What it does:

- **Named destinations** — operator declares webhook and/or Telegram targets in `agent.yaml`; the agent calls `notify({ to: "<name>", ... })`.
- **Two adapters** — `webhook` (HTTP POST) and `telegram` (sendMessage via `src/telegram-client.ts`).
- **Rate limiting** — cooldown, dedup, global hourly cap, per-peer cooldown. Creator-class senders bypass all limits.

What it does **not** do:

- No inbound handling — `notify` is outbound only. Use `telegramTransport` for bidirectional Telegram.
- No delivery receipts beyond `sent` / `failed` — no retry queue.
- No batching — each `notify` call is a single delivery attempt.

## 2. Configuration

### Minimal `agent.yaml` excerpt

```yaml
augments:
  - name: notify
    type: notify
    options:
      destinations:
        - name: creator
          transport: webhook
          url: ${ORG_NOTIFY_URL}
```

### Full example — webhook + telegram destinations with rate limiting

```yaml
augments:
  - name: notify
    type: notify
    options:
      destinations:
        - name: creator
          transport: webhook
          url: ${ORG_NOTIFY_URL}
          headers:
            X-Api-Key: ${NOTIFY_API_KEY}
        - name: alerts
          transport: telegram
          botToken: ${TELEGRAM_BOT_TOKEN}
          chatId: ${TELEGRAM_CHAT_ID}
          parseMode: Markdown
      rateLimit:
        enabled: true
        cooldownMs: 120000
        globalMaxPerHour: 5
        dedupWindowMs: 300000
        dedupThreshold: 0.6
        perPeerCooldownMs: 30000
```

### Programmatic setup

```ts
import { notify } from "augment-1";

const notifyAugment = notify({
  destinations: [
    {
      name: "creator",
      transport: "webhook",
      url: process.env.ORG_NOTIFY_URL!,
    },
    {
      name: "alerts",
      transport: "telegram",
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      chatId: Number(process.env.TELEGRAM_CHAT_ID),
      parseMode: "Markdown",
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

The tool is registered with `category: "communication"` and is visible to all trust levels by default. Creator-class senders bypass rate limits; no other behavioral difference by trust level.

## 4. Adapters

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

## 5. Rate limiting

Rate limiting is stateful and in-memory. State resets on agent restart. All checks apply only when `rateLimit.enabled !== false`.

### Rate limit checks (in order)

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

**Example migration (operator-supplied `agent.yaml`):**

```yaml
- name: notify
  type: notify
  options:
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

The `org_escalate` skill file in agent skills directories can be replaced with the `notify` skill scaffolded by `auggy add notify`.

## 7. Common operator mistakes

| Mistake | What happens | Fix |
|---|---|---|
| Destination `name` typo in agent prompt or skill | Tool returns `{ status: "failed", message: "Unknown destination 'ops'. Configured destinations: creator." }` | Use the exact name string from config; check spelling |
| Missing `summary` field | Zod validation fails before the tool executes; tool call returns an error | `summary` is required — ensure the skill teaches this |
| Putting `chatId` or raw Telegram user IDs in the agent identity file | Agent may try to pass raw IDs as `to:` argument | Named destinations only; IDs stay in `agent.yaml` |
| Setting `globalMaxPerHour: 0` expecting unlimited | `0` means the cap is always exceeded — all notifications are blocked | Omit `rateLimit` entirely or set `enabled: false` for uncapped |
| Sharing a `cooldownMs` value that is much larger than `perPeerCooldownMs` | Per-peer cooldown is defaulted to `cooldownMs` when not set; if you set a large global cooldown and leave `perPeerCooldownMs` unset, all peers share the large cooldown | Set `perPeerCooldownMs` explicitly when the two should differ |
| Using the same bot token for both `notify` (telegram destination) and `telegramTransport` inbound | Fine — they are independent; sending and receiving are concurrent-safe | No fix needed; this is intentional design |

## 8. Troubleshooting

**Notifications stop firing without error**

- The agent returns `rate_limited`. Check the `message` field in the tool result — it includes which check triggered and how long to wait.
- The global hourly cap may have been reached. Rate limit state is in-memory: restart the agent to reset it.
- `dedupThreshold` may be suppressing near-duplicate summaries. Reduce `dedupThreshold` or increase `dedupWindowMs` to make the window shorter.

**Tool returns `status: "failed"` with a destination error**

- Check that the destination `name` in the tool call exactly matches the name in `agent.yaml`. The lookup is case-sensitive.
- If using env interpolation (`${ORG_NOTIFY_URL}`), verify the env var is set at agent start time. Unresolved env vars produce a literal `${...}` string in the URL.

**Webhook returns non-2xx**

- The `detail` field in the failed result contains the HTTP status code and the first 200 characters of the response body. Check the receiving endpoint logs.
- The `X-Api-Key` header (or whichever auth header you configured) may be wrong or missing from the `headers` map.

**Telegram delivery fails**

- Confirm the `botToken` is correct and the bot has not been revoked via @BotFather.
- Confirm the `chatId` is a number (not a string username) for direct chats. Group chat IDs are negative numbers.
- If the bot has not exchanged a message with the target chat first, Telegram will reject the `sendMessage` call. Start a conversation with the bot before expecting proactive delivery to succeed.

**Notifications work in dev but not in production**

- Rate limit state is in-memory and resets on restart. A restarted agent starts fresh — the first notification after restart always passes rate limits.
- If running multiple agent instances (not recommended for a single config), each has independent state. Rate limits are not coordinated across instances.

## Cross-references

- [03-types.md](./03-types.md) — `NotifyAugmentOptions`, `NotifyDestination`, `NotifyRateLimitOptions`, `NotifyDeliveryResult`
- [07-built-in-augments.md](./07-built-in-augments.md) — quick summary of all built-in augments
- [14-telegram-transport.md](./14-telegram-transport.md) — bidirectional Telegram transport; coexistence notes
- `src/augments/notify.ts` — rate limit logic, tool definition
- `src/augments/notify/adapters/webhook.ts` — webhook delivery
- `src/augments/notify/adapters/telegram.ts` — telegram delivery + Markdown formatting

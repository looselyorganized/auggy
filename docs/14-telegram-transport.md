# 14 — Telegram Transport Augment Reference

> Operator reference for the `telegramTransport` augment — bidirectional Telegram I/O with long-poll or webhook inbound, four-path identity resolution, and coexistence with `notify`. Source: `src/augments/telegram-transport.ts`, `src/augments/telegram-transport/polling.ts`, `src/augments/telegram-transport/webhook.ts`, `src/types.ts`.

## 1. Overview

The `telegramTransport` augment wires a Telegram bot as a bidirectional peer transport. Inbound messages from Telegram users become turn triggers; the agent's replies are delivered back via `sendMessage`. It is a full `TransportSpec` implementation — the kernel manages concurrency, queuing, and rate limiting the same way it does for `webTransport`.

Multiple `telegramTransport` augments can run in the same agent (with distinct names and bot tokens) alongside other transports. Each transport instance has its own queue, its own identity resolver, and its own bot.

The transport handles **inbound** only. Proactive outbound messages to Telegram users (i.e. not in response to their current turn) are `notify`'s job. Both can share the same bot token — they do not interfere with each other.

## 2. Bot setup prerequisites

1. **Create a bot.** Open a conversation with @BotFather on Telegram and send `/newbot`. Follow the prompts. At the end, BotFather gives you a bot token in the format `123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi`.

2. **Find your Telegram user ID.** Send any message to @userinfobot. It replies with your numeric `id`. Alternatively, temporarily start the bot with no `creatorUserIds` configured and call `https://api.telegram.org/bot<token>/getUpdates` after sending the bot a message — your `message.from.id` appears in the response.

3. **Set the bot token as an env var.** The CLI scaffold generates `TELEGRAM_BOT_TOKEN` as the expected variable name:

   ```bash
   export TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi
   ```

4. **Start a conversation with the bot.** Telegram bots can only message users who have sent the bot at least one message. Open your bot in Telegram and press Start (or send any text). This primes the chat for both inbound polling and outbound `sendMessage`.

## 3. Configuration

### Polling mode (minimal)

```yaml
augments:
  - name: telegram
    type: telegramTransport
    options:
      botToken: ${TELEGRAM_BOT_TOKEN}
      inbound:
        mode: polling
        polling:
          timeoutSec: 30
      auth:
        creatorUserIds:
          - 123456789
        anonymousIdentityMode: ephemeral
```

### Webhook mode

```yaml
augments:
  - name: telegram
    type: telegramTransport
    options:
      botToken: ${TELEGRAM_BOT_TOKEN}
      inbound:
        mode: webhook
        webhook:
          publicUrl: https://agent.example.com/telegram
          port: 8081
          secretToken: ${TELEGRAM_WEBHOOK_SECRET}
          allowedUpdates:
            - message
      auth:
        creatorUserIds:
          - 123456789
        admittedAgents:
          - id: research-agent
            telegramUserId: 987654321
        recognizedUserIds:
          - 111222333
        anonymousIdentityMode: ephemeral
```

### Top-level configuration fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `botToken` | `string` | yes | — | Telegram bot token from @BotFather. |
| `inbound.mode` | `"polling" \| "webhook"` | yes | — | Inbound transport mode. Choose one; see §4 for guidance. |
| `inbound.polling` | `TelegramPollingOptions` | no | — | Required when `mode: polling`. |
| `inbound.polling.timeoutSec` | `number` | no | `30` | Long-poll timeout in seconds passed to `getUpdates`. |
| `inbound.webhook` | `TelegramWebhookOptions` | no | — | Required when `mode: webhook`. |
| `inbound.webhook.publicUrl` | `string` | yes (webhook) | — | Publicly reachable HTTPS URL Telegram will POST updates to. |
| `inbound.webhook.port` | `number` | no | `8081` | Local port the webhook HTTP server listens on. |
| `inbound.webhook.secretToken` | `string` | yes (webhook) | — | Secret token sent by Telegram in `X-Telegram-Bot-Api-Secret-Token`. Must match server-side. |
| `inbound.webhook.allowedUpdates` | `string[]` | no | Telegram default | Update types to receive (e.g. `["message"]`). |
| `auth` | `TelegramAuthOptions` | yes | — | Identity resolution configuration. |

### `TelegramAuthOptions` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `creatorUserIds` | `number[]` | `[]` | Telegram user IDs that receive `trustLevel: "creator"`. |
| `admittedAgents` | `TelegramAdmittedAgent[]` | `[]` | Agent peers with their Telegram user IDs. Each receives `trustLevel: "agent"`. |
| `recognizedUserIds` | `number[]` | `[]` | Known public users. Each receives `trustLevel: "public"`, `publicSubstate: "recognized"`. |
| `anonymousIdentityMode` | `"ephemeral" \| "durable"` | `"ephemeral"` | `peer.id` shape for anonymous public users. See §6. |

### `TelegramAdmittedAgent` fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Logical agent identifier used as `peer.id` in the kernel. |
| `telegramUserId` | `number` | Telegram numeric user ID for this agent. |

## 4. Choosing a mode

| | Polling | Webhook |
|---|---|---|
| **How it works** | Agent calls `getUpdates` in a long-poll loop (one request at a time, up to `timeoutSec`). | Telegram POSTs each update to your `publicUrl`. Agent runs a local HTTP server on `port`. |
| **Public HTTPS required** | No | Yes — valid TLS certificate, publicly roachable domain |
| **Latency** | One `timeoutSec` cycle (≤30 s) to receive a message after bot restart | Near-immediate delivery |
| **Best for** | Self-hosted / home lab / development; no reverse proxy required | Cloud deployments with a public domain |
| **Limitation** | Higher API polling load during idle periods | Telegram's delivery guarantee requires your server to be reachable at all times |

> **Telegram enforces one active mode per bot.** Calling `setWebhook` disables `getUpdates` polling on Telegram's side. Calling `deleteWebhook` (or letting the webhook lapse) re-enables polling. If you switch modes, Telegram may continue delivering to the old webhook endpoint for a short window. The augment calls `setWebhook` at boot in webhook mode and `deleteWebhook` at shutdown — mode transitions are handled automatically if you restart the agent cleanly.

## 5. Identity resolution

Every inbound Telegram update is resolved to a `PeerIdentity` before the kernel sees it. The resolver checks four paths in order:

| Priority | Mechanism | Trust level | `peer.id` | `peer.kind` |
|---|---|---|---|---|
| 1 | `creatorUserIds` contains `update.message.from.id` | `"creator"` | `tg_user_<userId>` | `"human"` |
| 2 | `admittedAgents` entry has matching `telegramUserId` | `"agent"` | The `id` field from `admittedAgents` | `"agent"` |
| 3 | `recognizedUserIds` contains `update.message.from.id` | `"public"` / `"recognized"` | `tg_user_<userId>` | `"human"` |
| 4 | None of the above | `"public"` / `"anonymous"` | See §6 | `"human"` |

The `peer.id` produced here is the identity the kernel uses for budgets, layered memory, and capability decisions throughout the turn.

**Thread ID:** All updates within the same Telegram chat share `threadId = tg-chat-<chatId>`. This maps one Telegram chat to one conversation thread in Auggy — history, memory context, and budget counters are all scoped to this threadId.

## 6. `anonymousIdentityMode` — ephemeral vs durable

Anonymous public users (those not in `creatorUserIds`, `admittedAgents`, or `recognizedUserIds`) get a `peer.id` whose shape depends on `anonymousIdentityMode`:

| Mode | `peer.id` | Memory behavior |
|---|---|---|
| `"ephemeral"` (default) | `tg_anon_<threadId>` i.e. `tg_anon_tg-chat-<chatId>` | Identity tied to the chat thread. Memory written for this peer is retained as long as the same chat is used, but the peer ID does not follow the user across different chats or after the threadId changes. |
| `"durable"` | `tg_user_<userId>` | Identity tied to the Telegram user ID. Memory is cross-session and cross-chat. If the user opens a new chat with the bot they are recognized by the same `peer.id`. |

> **Privacy tradeoff:** Ephemeral mode (the default) matches the behavior of anonymous web visitors — the peer is recognized within a session/thread but not globally. Durable mode enables cross-session recall at the cost of linking a Telegram user ID to a persistent identity in the agent's memory store. If you enable `"durable"`, ensure your data retention posture and any applicable privacy regulations are addressed. Consider whether the `layeredMemory` retention classes are set appropriately for anonymous public data.

## 7. `admittedAgents` boot-time validation

At boot (`onBoot`), the augment calls `getChat` for each entry in `admittedAgents`. This verifies that the configured `telegramUserId` is reachable by the bot:

- **Success:** Logs `[telegram-transport] admittedAgent "<id>" (telegramUserId=<n>) resolved successfully`.
- **Failure:** Logs a warning: `[telegram-transport] admittedAgent "<id>" (telegramUserId=<n>) failed boot-time validation: <error>. Real agent traffic from this user_id will be silently demoted to public-anonymous.`

The augment does **not** abort boot on validation failure. This is intentional — a misconfigured `admittedAgents` entry should not take down the whole agent. However, the consequence is silent trust demotion: if an agent peer sends a message with a `telegramUserId` that failed validation, it will be treated as `public-anonymous`. This can cause the agent to apply public-tier budgets and deny tools the agent peer expects to have access to.

> **Operator action on validation warning:** Check that `telegramUserId` is the numeric ID (not a username), that the bot has had at least one message exchange with that user, and that the bot token is correct. Mistyped IDs are the most common cause.

## 8. Coexistence with `notify`

`notify` and `telegramTransport` can use the same bot token and operate concurrently. Their responsibilities are entirely separate:

- `telegramTransport` handles **inbound** messages and **replies** to the current turn's peer.
- `notify` (with a telegram destination) handles **proactive outbound** to any configured `chatId`.

Sending via `notify` while `telegramTransport` is running is concurrent-safe — they share `src/telegram-client.ts` as a utility, not state. The `telegramTransport` augment does not know about or communicate with the `notify` augment.

A typical LORF pattern: `telegramTransport` receives messages from the operator's personal Telegram account (the creator), and a `notify` telegram destination targets the same chat for proactive alerts. The operator gets a unified experience — both channels appear in the same conversation.

## 9. Webhook deployment notes

When running in webhook mode, the augment starts a local HTTP server (`Bun.serve`) on the configured `port` (default `8081`). You need a reverse proxy that forwards Telegram's HTTPS POST requests to this local port.

**Requirements:**

- **Public HTTPS URL** with a valid TLS certificate. Telegram does not support self-signed certificates for webhook mode (it does support some specific CA roots — check Telegram bot API docs for the current list).
- **Header passthrough.** The reverse proxy must forward the `X-Telegram-Bot-Api-Secret-Token` header unchanged. The webhook server validates it with a timing-safe comparison and returns `401` if it is missing or does not match `secretToken`.
- **POST only.** Any method other than `POST` returns `405`.

**nginx example:**

```nginx
location /telegram {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Telegram-Bot-Api-Secret-Token $http_x_telegram_bot_api_secret_token;
}
```

**Caddy example:**

```
handle /telegram {
    reverse_proxy localhost:8081
}
```

Caddy forwards headers by default, so no explicit header passthrough directive is needed.

**Shutdown behavior:** On `onShutdown`, the augment calls `deleteWebhook` (via the Telegram API) after stopping the local server. This prevents Telegram from continuing to POST to a URL that is no longer listening. If `deleteWebhook` fails (e.g. network issue at shutdown), the warning is logged but shutdown continues.

## 10. Troubleshooting

**Bot does not respond to messages**

- Verify `TELEGRAM_BOT_TOKEN` is set and correct (`aug1 status` shows whether the agent is running).
- In polling mode, check agent logs for `[telegram-transport.polling] getUpdates error` — this indicates the token is invalid or the Telegram API is unreachable.
- Confirm your Telegram user ID is in `creatorUserIds` (or the appropriate list). If the ID is wrong, your messages are resolved as `public-anonymous` and may be budget-capped or capability-restricted.
- Confirm the bot has not been blocked or deleted via @BotFather.

**Messages arrive but the agent doesn't reply**

- The turn may have been rejected by the `budgets` augment (cap-denied). Check agent logs for `cap-denied` or `admission-state-failed` entries.
- The turn may have completed without producing a `text_message` event (e.g. the model only called tools). Replies are sent via `onOutbound` when `text_message` events fire.
- If the `threadChatIds` map entry is missing for the thread, the outbound callback will silently drop the reply. This should only happen if the update was processed before `register()` was called — check that the augment is booting before messages arrive.

**Webhook mode: bot registers but updates never arrive**

- Verify the `publicUrl` is HTTPS and publicly reachable from the internet (not just localhost).
- Verify the TLS certificate is valid (not self-signed unless it's one of Telegram's accepted CAs).
- Verify the reverse proxy passes `X-Telegram-Bot-Api-Secret-Token` unchanged. Check the webhook server logs for `401` responses.
- Use `https://api.telegram.org/bot<token>/getWebhookInfo` to inspect what URL Telegram has registered and whether there are pending error messages.

**Mode-switch issues (switching between polling and webhook)**

- Telegram only allows one active mode per bot at a time. Setting a webhook (`setWebhook`) disables polling (`getUpdates`). Removing the webhook (`deleteWebhook`) re-enables polling.
- The augment calls `setWebhook` at boot (webhook mode) and `deleteWebhook` at shutdown (webhook mode). If a previous run crashed without calling `deleteWebhook`, Telegram may still be posting to the old URL. Call `https://api.telegram.org/bot<token>/deleteWebhook` manually to clear it.
- Do not run two agent instances for the same bot with different modes simultaneously — they will conflict.

**`admittedAgents` validation failures at boot**

- The warning log names the `id` and `telegramUserId` that failed. Check the numeric user ID against what `getUpdates` reports for that agent's messages.
- Ensure the bot has exchanged at least one message with the agent's Telegram account (required for `getChat` to succeed).
- If the `telegramUserId` is correct but validation still fails, verify the bot token — a wrong token will fail all API calls at boot.

## Cross-references

- [03-types.md](./03-types.md) — `TelegramTransportOptions`, `TelegramAuthOptions`, `TelegramAdmittedAgent`, `TelegramAnonymousIdentityMode`
- [06-transports.md](./06-transports.md) — transport contract, AG-UI protocol, queue mechanics
- [12-budgets.md](./12-budgets.md) — trust-level budget caps that apply to Telegram peers
- [13-notify.md](./13-notify.md) — proactive outbound via the `notify` augment; coexistence with this transport
- `src/augments/telegram-transport.ts` — augment factory, identity resolver, lifecycle
- `src/augments/telegram-transport/polling.ts` — long-poll loop
- `src/augments/telegram-transport/webhook.ts` — webhook HTTP server

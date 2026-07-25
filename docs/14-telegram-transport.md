# 14 — Telegram Transport Augment Reference

> Operator reference for the `telegramTransport` augment — bidirectional Telegram I/O with long-poll or webhook inbound, four-path identity resolution, and coexistence with `notify`. Source: `src/augments/telegramTransport/index.ts`, `src/augments/telegramTransport/polling.ts`, `src/augments/telegramTransport/webhook.ts`, `src/types.ts`.

## 1. Overview

The `telegramTransport` augment wires a Telegram bot as a bidirectional peer transport. Inbound messages from Telegram users become turn triggers; the agent's replies are delivered back via `sendMessage`. It is a full `TransportSpec` implementation — the kernel manages concurrency, queuing, and rate limiting the same way it does for `webTransport`.

Multiple `telegramTransport` augments can run in the same agent (with distinct names and bot tokens) alongside other transports. Each transport instance has its own queue, its own identity resolver, and its own bot.

The transport handles **inbound** only. Proactive outbound messages to Telegram users (i.e. not in response to their current turn) are `notify`'s job. Both can share the same bot token — they do not interfere with each other.

## 2. Bot setup prerequisites

1. **Create a bot.** Open a conversation with @BotFather on Telegram and send `/newbot`. Follow the prompts. At the end, BotFather gives you a bot token in the format `123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi`.

2. **Find your Telegram user ID.** Send any message to @userinfobot. It replies with your numeric `id`. Alternatively, temporarily start the bot with no `creatorUserIds` configured and call `https://api.telegram.org/bot<token>/getUpdates` after sending the bot a message — your `message.from.id` appears in the response.

3. **Set Telegram env vars.** The CLI scaffold generates `TELEGRAM_BOT_TOKEN` for the bot and `TELEGRAM_CREATOR_USER_IDS` for comma-separated creator user IDs:

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi
   TELEGRAM_CREATOR_USER_IDS=123456789
   ```

4. **Start a conversation with the bot.** Telegram bots can only message users who have sent the bot at least one message. Open your bot in Telegram and press Start (or send any text). This primes the chat for both inbound polling and outbound `sendMessage`.

## 3. Configuration

### Polling mode (minimal)

```yaml
# agent.yaml
augments:
  - telegramTransport

# augments/telegramTransport/augment.yaml
type: telegramTransport
config:
  botToken: ${TELEGRAM_BOT_TOKEN}
  inbound:
    mode: polling
    polling:
      timeoutSec: 30
  auth:
    creatorUserIds: []
    creatorUserIdsEnv: TELEGRAM_CREATOR_USER_IDS
    anonymousIdentityMode: ephemeral
```

### Webhook mode

```yaml
# agent.yaml
augments:
  - telegramTransport

# augments/telegramTransport/augment.yaml
type: telegramTransport
config:
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
| `inbound.webhook.maxBodyBytes` | `number` | no | `262144` | Encoded request cap enforced before JSON parsing, including chunked requests. |
| `auth` | `TelegramAuthOptions` | yes | — | Identity resolution configuration. |
| `replay.dbPath` | `string` | no | `./data/telegram-replay.db` | Hardened SQLite update-claim ledger. CLI/cloud resolution places this under the runtime data root. |
| `replay.namespace` | `string` | no | `telegram:bot-<botId>` | Stable, non-secret bot scope. Set explicitly when a token has no numeric bot prefix. |
| `replay.retentionMs` | `number` | no | `2592000000` | Claim retention horizon (30 days). |
| `replay.maxEntries` | `number` | no | `1000000` | Maximum retained claims before oldest claims are pruned transactionally. |
| `replay.claimTimeoutMs` | `number` | no | `5000` | Maximum time to await an async shared-store claim, conflict inspection, or recovery before failing closed. |
| `replay.store` | `TelegramReplayStore \| TelegramAsyncReplayStore` | no | SQLite store | Programmatic shared transactional store. Distributed replicas should use an async store backed by one atomic Redis, Postgres, or equivalent claim domain. |

The default SQLite ledger provides durable replay protection across restarts and
processes that open the same database file on storage with reliable SQLite
locking. It does not coordinate replicas with independent container volumes.
Horizontally scaled deployments must route Telegram updates through one writer
or construct `telegramTransport()` programmatically with a shared transactional
`TelegramAsyncReplayStore`; executable stores cannot be declared in YAML. Its
`claimAsync()` operation must atomically bind `(namespace, updateId)` to the
payload hash and honor the supplied abort signal. It must also atomically
quarantine the namespace on a hash mismatch. `getConflictAsync()` exposes only
the opaque incident ID, update ID, and detection time.
`resolveConflictAsync()` must compare-and-set the exact active incident, retain
the canonical claim, persist an exact conflicting-hash discard tombstone, and
only then clear quarantine. Claims and recovery are intentionally at-most-once:
a timeout, shutdown, or failure after an operation has begun is
outcome-unknown. Any delivery retry must use the identical namespace, update
ID, and payload hash through the same atomic store; it must never bypass the
claim.

When moving from SQLite to a shared store, preserve the replay namespace and
either seed every unexpired `(namespace, updateId, payloadHash)` claim or drain
Telegram's retry horizon before cutover. Starting with an empty shared ledger
can admit an old delivery that the SQLite ledger had already consumed.

```ts
import { telegramTransport, type TelegramAsyncReplayStore } from "auggy";

const replayStore: TelegramAsyncReplayStore = {
  async claimAsync(namespace, updateId, payloadHash, { signal }) {
    // Atomically insert/read or quarantine in one shared database.
    return claimTelegramUpdate(namespace, updateId, payloadHash, signal);
  },
  async getConflictAsync(namespace, { signal }) {
    return inspectTelegramConflict(namespace, signal);
  },
  async resolveConflictAsync(namespace, conflictId, { signal }) {
    // CAS the incident and persist its discard tombstone before returning true.
    return discardTelegramConflict(namespace, conflictId, signal);
  },
};

const telegram = telegramTransport({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  inbound: { mode: "polling" },
  auth: {},
  replay: { namespace: "support-bot", store: replayStore },
});
```

The application owns a supplied store's lifecycle; the transport does not call
its optional `close()` method. This lets one shared client serve multiple
transport instances safely.

### `TelegramAuthOptions` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `creatorUserIds` | `number[]` | `[]` | Telegram user IDs that receive `trustLevel: "creator"`. |
| `creatorUserIdsEnv` | `string` | — | Env var containing comma-separated creator user IDs. The CLI scaffold uses `TELEGRAM_CREATOR_USER_IDS`. |
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
| **Public HTTPS required** | No | Yes — valid TLS certificate, publicly reachable domain |
| **Latency** | One `timeoutSec` cycle (≤30 s) to receive a message after bot restart | Near-immediate delivery |
| **Best for** | Self-hosted / home lab / development; no reverse proxy required | Cloud deployments with a public domain |
| **Limitation** | Higher API polling load during idle periods | Telegram's delivery guarantee requires your server to be reachable at all times |

> **Telegram enforces one active mode per bot.** Calling `setWebhook` disables `getUpdates` polling on Telegram's side. Calling `deleteWebhook` (or letting the webhook lapse) re-enables polling. If you switch modes, Telegram may continue delivering to the old webhook endpoint for a short window. The augment calls `setWebhook` at boot in webhook mode and `deleteWebhook` at shutdown — mode transitions are handled automatically if you restart the agent cleanly.

### Durable update replay boundary

Both polling and webhook modes claim each non-negative integer `update_id` in
the same transactional replay ledger before dispatching it to the kernel.
Concurrent or post-restart duplicates return without another model/tool
execution. Reuse of one ID with different update content fails closed as a
conflict and atomically quarantines that bot's complete replay namespace. The
ledger stores canonical and conflicting SHA-256 payload hashes, never the bot
token or message content. Quarantine and recovery survive restart.

This is intentionally at-most-once processing. If the process or kernel fails
after the durable claim, Auggy does not blindly retry an update whose tools may
already have produced side effects. Webhook processing failures return `503`
only when no stable duplicate/conflict response applies; polling advances past
a durably claimed duplicate on the next attempt. Operators should alert on
processing failures and reconcile outcome-unknown side effects manually.

The console reports a quarantined Telegram transport and always registers a
confirm-required recovery action. Recovery accepts only the current opaque
conflict ID. It retains the canonical claim and permanently acknowledges only
the exact conflicting delivery as discarded; it cannot execute the conflicting
payload or accept an operator-supplied offset. A third distinct payload for the
same ID creates a new incident.

Polling also pauses on Telegram Bot API `getUpdates` status `409`, which
indicates a competing poller or webhook owner, and on a malformed/non-monotonic
update batch. Stop the competing deployment or reconcile the source first,
then use the same console action and current incident ID. Ownership recovery
does not modify replay state or advance the polling offset. Auggy never
automatically deletes a webhook in response to this condition.

SQLite coordinates restarts and concurrent processes only when every replica
opens the same database file on storage with working SQLite locks. Independent
container volumes are independent replay domains. Use a single writer/sticky
bot route or provide `replay.store` backed by a shared transactional service
for horizontally scaled deployments. Claims older than `retentionMs` can be
accepted again after pruning, so configure that horizon for Telegram's retry
and operator replay window. Capacity eviction at `maxEntries` also shortens the
deduplication horizon, so size it for the maximum per-bot update volume expected
during `retentionMs`.

## 5. Identity resolution

Every inbound Telegram update is resolved to a `PeerIdentity` before the kernel sees it. The resolver checks four paths in order:

| Priority | Mechanism | Trust level | `peer.id` | `peer.kind` |
|---|---|---|---|---|
| 1 | `creatorUserIds` contains `update.message.from.id` **and the chat is private** | `"creator"` | `creator` | `"human"` |
| 2 | `admittedAgents` entry has matching `telegramUserId` | `"agent"` | The `id` field from `admittedAgents` | `"agent"` |
| 3 | `recognizedUserIds` contains `update.message.from.id` | `"public"` / `"recognized"` | `tg_user_<userId>` | `"human"` |
| 4 | None of the above | `"public"` / `"anonymous"` | See §6 | `"human"` |

The `peer.id` produced here is the identity the kernel uses for budgets, layered memory, and capability decisions throughout the turn.

For v1, the creator has one canonical runtime identity across creator surfaces:
`peer.id = "creator"`. The Telegram user ID proves the credential in private
chat; it is not used as the creator's memory/budget key. Group, supergroup, and
channel messages are not promoted to creator trust by default even when the
sender's user ID appears in `creatorUserIds`.

**Thread ID:** All updates within the same Telegram bot and chat share
`threadId = tg-bot-<botId>-chat-<chatId>` (tokens without a standard numeric
bot prefix use a digest of the explicit non-secret replay namespace; test-only
clients fall back to the registered augment name). The bot scope is mandatory because
Telegram private-chat IDs are stable across bots; it prevents two configured
bots from sharing kernel history, memory context, or budget counters.

This changes the legacy `tg-chat-<chatId>` identifiers. On first deployment,
existing Telegram conversations begin new histories. Do not copy legacy
history into the new identifiers unless ownership is independently verified
for the exact bot and peer.

## 6. `anonymousIdentityMode` — ephemeral vs durable

Anonymous public users (those not in `creatorUserIds`, `admittedAgents`, or `recognizedUserIds`) get a `peer.id` whose shape depends on `anonymousIdentityMode`:

| Mode | `peer.id` | Memory behavior |
|---|---|---|
| `"ephemeral"` (default) | `tg_anon_<threadId>` i.e. `tg_anon_tg-bot-<botId>-chat-<chatId>` | Identity tied to the bot-scoped chat thread. Memory written for this peer is retained as long as the same bot and chat are used, but the peer ID does not follow the user across different chats or after the threadId changes. |
| `"durable"` | `tg_user_<userId>` | Identity tied to the Telegram user ID. Memory is cross-session and cross-chat. If the user opens a new chat with the bot they are recognized by the same `peer.id`. |

> **Privacy tradeoff:** Ephemeral mode (the default) matches the behavior of anonymous web visitors — the peer is recognized within a session/thread but not globally. Durable mode enables cross-session recall at the cost of linking a Telegram user ID to a persistent identity in the agent's memory store. If you enable `"durable"`, ensure your data retention posture and any applicable privacy regulations are addressed. Consider whether the `layeredMemory` retention classes are set appropriately for anonymous public data.

## 7. `admittedAgents` boot-time validation

At boot (`onBoot`), the augment calls `getChat` for each entry in `admittedAgents`. This verifies that the configured `telegramUserId` is reachable by the bot:

- **Success:** Logs `[telegram-transport] admittedAgent "<id>" (telegramUserId=<n>) resolved successfully`.
- **Failure:** Logs a warning without the raw upstream exception and removes
  that entry from the active mapping for the current boot. Traffic from this
  user ID is public-anonymous until validation succeeds on a later restart.

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

- Verify `TELEGRAM_BOT_TOKEN` is set and correct (`auggy status` shows whether the agent is running).
- In polling mode, check agent logs for `[telegram-transport.polling] getUpdates error` — this indicates the token is invalid or the Telegram API is unreachable.
- Confirm your Telegram user ID is in `creatorUserIds` (or the appropriate list). Creator trust is granted only in private chats by default. If the ID is wrong, or the message arrives from a group/supergroup/channel, your messages are resolved as public and may be budget-capped or capability-restricted.
- Confirm the bot has not been blocked or deleted via @BotFather.

**Messages arrive but the agent doesn't reply**

- The turn may have been rejected by the `budgets` augment (cap-denied). Check agent logs for `cap-denied` or `admission-state-failed` entries.
- The turn may have completed without producing a `text_message` event (e.g. the model only called tools). Replies are sent via `onOutbound` when `text_message` events fire.
- If the `threadChatIds` map entry is missing for the thread, the outbound
  callback silently drops the reply. Routing exists only while the inbound turn
  is active; late or unrelated outbound messages must use `notify`.

**Console reports `Transport quarantined`**

- For `replay-payload`, investigate why one authenticated `update_id` arrived
  with different content. Back up the replay database and reconcile any
  already-started side effects before recovery.
- For `polling-ownership`, stop the other `getUpdates` consumer or remove the
  stale webhook outside Auggy. Do not recover while another owner is active.
- For `invalid-update-sequence`, correct the proxy/provider response before
  recovery. The entire batch was rejected before partial dispatch.
- Copy the current conflict ID into the confirm-required Telegram recovery
  action. Stale, malformed, already-resolved, and cross-bot IDs fail closed.
- All replicas sharing a namespace/store must observe the same durable replay
  state. A process-local or per-volume store is not sufficient for one bot
  served by multiple replicas.

While replay-quarantined, each polling replica checks the shared conflict state
once per second. A successful compare-and-set recovery on any replica therefore
wakes the others without another operator action. Size and monitor the shared
store for this low-rate reconciliation traffic.

**Webhook mode: bot registers but updates never arrive**

- Verify the `publicUrl` is HTTPS and publicly reachable from the internet (not just localhost).
- Verify the TLS certificate is valid (not self-signed unless it's one of Telegram's accepted CAs).
- Verify the reverse proxy passes `X-Telegram-Bot-Api-Secret-Token` unchanged. Check the webhook server logs for `401` responses.
- Use `https://api.telegram.org/bot<token>/getWebhookInfo` to inspect what URL Telegram has registered and whether there are pending error messages.

**Mode-switch issues (switching between polling and webhook)**

- Telegram only allows one active mode per bot at a time. Setting a webhook (`setWebhook`) disables polling (`getUpdates`). Removing the webhook (`deleteWebhook`) re-enables polling.
- The augment calls `setWebhook` at boot (webhook mode) and `deleteWebhook` at shutdown (webhook mode). If a previous run crashed without calling `deleteWebhook`, Telegram may still be posting to the old URL. Call `https://api.telegram.org/bot<token>/deleteWebhook` manually to clear it.
- Do not run two agent instances for the same bot with different modes
  simultaneously. Polling detects Telegram's ownership `409`, pauses without
  retry churn, and requires explicit recovery after the deployment is fixed.

**`admittedAgents` validation failures at boot**

- The warning log names the `id` and `telegramUserId` that failed. Check the numeric user ID against what `getUpdates` reports for that agent's messages.
- Ensure the bot has exchanged at least one message with the agent's Telegram account (required for `getChat` to succeed).
- If the `telegramUserId` is correct but validation still fails, verify the bot token — a wrong token will fail all API calls at boot.

## Cross-references

- [03-types.md](./03-types.md) — `TelegramTransportOptions`, `TelegramAuthOptions`, `TelegramAdmittedAgent`, `TelegramAnonymousIdentityMode`
- [06-transports.md](./06-transports.md) — transport contract, AG-UI protocol, queue mechanics
- [12-budgets.md](./12-budgets.md) — trust-level budget caps that apply to Telegram peers
- [13-notify.md](./13-notify.md) — proactive outbound via the `notify` augment; coexistence with this transport
- `src/augments/telegramTransport/index.ts` — augment factory, identity resolver, lifecycle
- `src/augments/telegramTransport/polling.ts` — long-poll loop
- `src/augments/telegramTransport/webhook.ts` — webhook HTTP server

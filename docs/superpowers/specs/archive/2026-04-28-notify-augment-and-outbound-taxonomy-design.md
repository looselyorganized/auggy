---
title: "Notify Augment, Telegram Transport, and orgContext Strip — Design Spec"
type: decision
category: agent-design
date: 2026-04-28
status: proposed
domain:
  - augments
  - outbound
  - transports
  - notifications
relates_to:
  - 2026-04-27-visitor-economics-and-trust-design
  - adr-018-layered-memory-augment
  - three-layer-trust-architecture-20260414
roadmap_phase: pre-v0
roadmap_item: 6
---

> **Status: proposed (2026-04-28).** This spec replaces the original framing of roadmap item 6 ("static org config in agent.yaml + pluggable escalation transport"). The design conversation surfaced that the original framing conflated three distinct architectural concerns and over-built the routing surface for hypothetical needs. This revision reflects an internal adversarial review (recommended simpler shape) and an external user check on capability coverage. Awaiting plan-phase before implementation.

## One-sentence description

Outbound messaging splits into two augments along **addressing model**: `notify` for operator-defined destinations unrelated to the current turn (proactive pushes), and per-protocol transports (e.g., `telegramTransport`) for peer-bound I/O during a turn — and `orgContext` shrinks to read-only by losing its escalation tool.

## Origin and reframing

The roadmap-item-6 prompt asked for two things bundled together: an inline `org:` block in agent.yaml (so a solo developer doesn't have to deploy `agent-context-api` for org identity) and a "pluggable escalation transport" with telegram/webhook/slack/email implementations.

Walking the design surface adversarially produced four reframings:

1. **Inline `org:` config is YAGNI.** Operators who have an org already host its docs somewhere reachable. Operators who don't have an org don't mount `orgContext`. The friction of "deploy a 30-line Hono server" is overstated relative to introducing a parallel inline schema in agent.yaml. **Inline org config is dropped.**

2. **"Escalation" is the wrong word.** The agent isn't only escalating; it might also send daily summaries, "your report is done," scheduled check-ins, or proactive observations. The capability is *outbound messaging*, not *escalation*. **The augment is renamed `notify`.**

3. **`notify` is not a transport.** Telegram-as-front-door (peers DM the bot) is a full bidirectional transport, peer to `webTransport` — owns peer identity resolution, message lifecycle, turn dispatch. `notify` has none of those properties. Conflating them with a `direction` knob would have been naming sleight-of-hand. **`notify` is its own architectural role.**

4. **OrgContext shouldn't host `org_escalate`.** Knowledge fetch (read manifest, `org_fetch`) and outbound messaging (`org_escalate`) are different capabilities. They share an HTTP base URL today only by deployment convenience. **Strip `org_escalate` and its rate-limit code from `orgContext`.**

## Augment roles after item 6

Auggy gains two new augments and one strip:

| Augment | Role | Who calls it | Status |
|---|---|---|---|
| `notify` | Outbound messaging to operator-defined destinations. Owns rate limits, dedup. Internal adapters per protocol (webhook, telegram). | Agent calls `notify({to, summary, ...})` | New |
| `telegramTransport` | Bidirectional Telegram I/O. Inbound via long-polling. Replies to the current peer. Resolves Telegram user identity into the trust model. | Kernel routes inbound → turn; agent reply → kernel → transport | New |
| `orgContext` | Manifest-driven read-only knowledge registry. (Was: read + escalation. Becomes: read only.) | Agent calls `org_fetch({endpoint})`; manifest auto-injects context block | Modified (strip) |

The two new augments are **independent** — neither depends on the other; either can be mounted alone. They compose without cross-augment dependencies.

## Notify augment

### Purpose

`notify` is the **outbound messaging primitive** for pushes to operator-defined destinations that are not the current turn's peer. Examples: alert the creator on Telegram while serving a customer turn; send a daily summary to a webhook; notify an ops channel when a job finishes.

Three load-bearing features distinguish it from "the agent calls outbound tools directly":

1. **Named destinations.** Operator declares `creator` once; agent addresses by semantic name, never by raw chat IDs.
2. **Internal adapter map.** Per-protocol delivery (webhook, telegram) lives inside the augment as ~50 LOC adapter modules. Adding a new adapter (slack, email, discord) is one new file inside `src/augments/notify/adapters/`.
3. **Rate limits.** Cooldown, dedup, global hourly cap, per-peer cooldown. Lifted from today's `org-context.ts` (lines 89–165) — already-tested logic that has to live somewhere after the strip.

### Configuration shape

```yaml
- name: notify
  type: notify
  options:
    destinations:
      - name: creator
        transport: webhook
        url: ${ORG_CONTEXT_URL}/notify
      # OR direct telegram (alternative shape):
      - name: creator-direct
        transport: telegram
        botToken: ${TG_BOT_TOKEN}
        chatId: ${OPERATOR_CHAT_ID}
    rateLimit:
      cooldownMs: 120000
      dedupWindowMs: 300000
      dedupThreshold: 0.6
      globalMaxPerHour: 5
      perPeerCooldownMs: 30000
```

### Tool surface

```typescript
notify({
  to: string;            // destination name; required (no fan-out at v1)
  summary: string;       // required
  reason?: string;
  visitor?: string;      // optional context — visitor name/identifier
})
```

Returns:

```typescript
{
  status: "sent" | "rate_limited" | "failed";
  message?: string;       // on rate_limited or failed
  hint?: string;          // guidance for the agent (e.g., "operator already aware")
}
```

### Adapter interface (internal)

Each adapter is a small module exporting a single function:

```typescript
interface NotifyAdapter {
  deliver(opts: AdapterOptions, payload: NotifyPayload): Promise<DeliveryResult>;
}

// Built-in adapters at v1:
//   webhook — POST JSON to a configured URL. Subsumes "delegated mode" — calling
//             agent-context-api/notify is just a webhook adapter.
//   telegram — POST to api.telegram.org/bot{token}/sendMessage. No long-polling
//              required; outbound-only is independent of any inbound consumer.
```

Adapters live at `src/augments/notify/adapters/{webhook,telegram}.ts`. Each ~50 LOC. Future adapters (slack, email, discord) added as new files in the same directory.

### Trust-level behavior

- **Creator-class senders bypass rate limits.** Carried over from current `org_escalate` semantics.
- **Public/agent-class senders go through full rate-limit checks.**

### What's NOT in v1

- **Multi-destination fan-out.** Single `to:` field. Calling `notify` twice for two destinations is the agent's responsibility. (Roadmapped — see "Roadmap updates" below.)
- **Severity-based routing rules.** No `routing:` block; no `severity:` matcher. Agent picks destination by name.
- **Per-destination trust caps.** All destinations share the global rate-limit policy.

## Telegram transport augment

### Purpose

`telegramTransport` is a full bidirectional transport, peer to `webTransport`. Inbound messages from Telegram users dispatch turns; agent replies stream back through the bot API. Multiple transports per agent are supported by the kernel — an operator can mount `webTransport` and `telegramTransport` simultaneously.

### Configuration shape

```yaml
- name: telegram
  type: telegramTransport
  options:
    botToken: ${TG_BOT_TOKEN}

    # Inbound mode — exactly one must be enabled. Telegram only allows one
    # active reception mode per bot (setting a webhook disables getUpdates).
    inbound:
      mode: polling                   # "polling" | "webhook"

      # Polling mode options (used when mode: polling)
      polling:
        timeoutSec: 30                # long-poll timeout

      # Webhook mode options (used when mode: webhook)
      webhook:
        publicUrl: https://example.com/tg-webhook
        port: 8081                    # local port for the HTTP server
        secretToken: ${TG_WEBHOOK_SECRET}   # validated against X-Telegram-Bot-Api-Secret-Token header

    # Identity resolution — all four paths supported at v1.
    auth:
      creatorUserIds: [12345678]
      admittedAgents:
        - id: scheduler-bot
          telegramUserId: 555444333
      recognizedUserIds: [987654321]
      # Anyone else → public-anonymous (default)

      # peer.id durability for anonymous peers. Default is "ephemeral" to match
      # web's anonymous-ephemeral semantics (item 5). Operators who want
      # cross-session memory recall for repeat anonymous DMs opt into "durable".
      anonymousIdentityMode: ephemeral   # "ephemeral" | "durable"
```

### Inbound flow

The augment supports two reception modes; operator picks via `inbound.mode`. Telegram only permits one active mode per bot, so config-validation rejects configs with both enabled.

**Polling mode (`mode: polling`)**

1. On boot, the augment starts a background loop calling `getUpdates(offset, timeoutSec)` against the Telegram bot API.
2. Each update is processed through the same pipeline as webhook mode (step 3 below).
3. Loop continues until shutdown.

**Webhook mode (`mode: webhook`)**

1. On boot, the augment calls `setWebhook(publicUrl, secret_token)` to register the operator-provided URL with Telegram.
2. Augment starts a `Bun.serve()` HTTP server on `port`. Telegram POSTs `Update` payloads to the URL.
3. Each POST is validated: `X-Telegram-Bot-Api-Secret-Token` header must match `secretToken` via `timingSafeEqual` (constant-time compare — `===` is forbidden, mirrors `web-transport.ts:79-90`'s agent-secret pattern). Mismatched or missing header returns 401 with no body so Telegram doesn't retry.
4. On shutdown, augment calls `deleteWebhook` to clean up.

**Common pipeline (both modes)**

3. Each update with a text `message` is converted to an A2A-shaped turn input.
4. Peer identity resolved per the table below.
5. Turn dispatched via the kernel's transport interface (the same interface `webTransport` uses).
6. Agent's reply text sent via `sendMessage` to the original chat (`editMessageText` streaming-edit deferred — one `sendMessage` per reply at v1).

### Identity resolution — all four paths at v1

| Path | v1 status | Mechanism | peer.id |
|---|---|---|---|
| Creator | ✓ | `message.from.id ∈ creatorUserIds` | `tg_user_<userId>` (durable) |
| Agent | ✓ | `message.from.id` matches `admittedAgents[].telegramUserId` | configured agent `id` (durable) |
| Public-recognized | ✓ | `message.from.id ∈ recognizedUserIds` | `tg_user_<userId>` (durable) |
| Public-anonymous | ✓ | Default fallback for any other user_id | `tg_anon_<threadId>` if `anonymousIdentityMode: ephemeral` (default); `tg_user_<userId>` if `durable` |

This achieves parity with `webTransport`'s four-path identity model. The mapping differs from web because Telegram authenticates user_ids server-side — there's no need for cryptographic visitor tokens or shared-secret HTTP challenges. The four trust populations are expressed via operator-configured allowlists keyed off the user_id Telegram itself authenticates.

**Boot-time validation of `admittedAgents`.** A typo in `admittedAgents[].telegramUserId` would silently demote a real admitted-agent to public-anonymous (web's shared-secret model fails loudly with 401; Telegram's user_id model can fail silently). On boot the augment SHOULD call `getChat(userId)` for each configured agent user_id. If the call fails (user not found, bot doesn't have access), the augment logs an explicit warning naming the configured `id` and `telegramUserId` so the operator catches the typo before traffic arrives. This is advisory, not blocking — boot continues.

### Threading and peer.id semantics

Each Telegram chat → one persistent thread per peer. Thread doesn't close on idle (Telegram has no connection-close signal). Memory augments handle long-term context retention.

**`peer.id` shape depends on trust level AND on `anonymousIdentityMode`:**

| Trust level | peer.id | Durability |
|---|---|---|
| Creator | `tg_user_<userId>` | Durable |
| Agent | configured agent `id` | Durable |
| Public-recognized | `tg_user_<userId>` | Durable |
| Public-anonymous, `anonymousIdentityMode: ephemeral` (default) | `tg_anon_<threadId>` | Ephemeral — dies with thread (matches web's anon pattern) |
| Public-anonymous, `anonymousIdentityMode: durable` (opt-in) | `tg_user_<userId>` | Durable |

**Why ephemeral is the default for anonymous.** Item 5's visitor-economics spec deliberately designed anonymous-peer memory to be ephemeral so peer-derived memory dies with the thread. That decision was driven by privacy posture, attack-surface containment (memory-injection attacks via planted anonymous content are bounded to a single thread), and least-surprise defaults. Telegram authenticates *who someone is*; that doesn't grant the operator a license to retain their data indefinitely. The conservative default treats authentication-of-identity and consent-to-durable-storage as separate axes — Telegram gives us the first, the operator must consciously opt into the second.

**When to opt into `durable`.** Customer-service-style bots that genuinely benefit from cross-session recall ("Hi, last time we discussed X — did that work out?"). Operators who choose `durable` are making a retention choice that surfaces in their config — they can document it for users, set retention TTLs accordingly, and reason about its legal posture under their jurisdiction's privacy regime.

**Migration is asymmetric.** Starting ephemeral and operators flipping to durable is additive (future memory writes start being durable; existing ephemeral threads stay ephemeral until they end). Starting durable and flipping to ephemeral would be breaking — existing memory rows are durable and can't retroactively unwind. Picking ephemeral as the default avoids painting Auggy into a corner.

Trust-level differences therefore live in **budget caps, audit specificity, and (now) anonymous identity durability** — all configurable, none conflated.

### What `telegramTransport` does NOT expose

- **No tools.** Reply to the current peer is automatic via the kernel's transport-reply mechanism (same as `webTransport`). Outbound to non-current-peer destinations is `notify`'s job, not the transport's.
- **No streaming-edit replies at v1.** The transport sends one `sendMessage` per agent reply. Incremental `editMessageText` for streaming output is a follow-on.
- **No dynamic agent-driven recognition at v1.** Recognition is operator-configured (`recognizedUserIds`). The agent cannot promote a user to recognized at runtime without an operator config change. Dynamic recognition would mirror web's token-issuance flow and is deferred until a concrete need arrives.

### Coexistence with `notify`

If an operator mounts both `notify` (with telegram adapter using bot token X) and `telegramTransport` (also using bot token X) for the same bot:

- **No conflict on outbound.** Sending via the Telegram bot API is concurrent-safe; both can call `sendMessage` against the same bot.
- **No conflict on inbound.** `notify` doesn't poll or run a webhook server — it only sends. `telegramTransport` is the sole inbound consumer.
- **Configuration duplication.** Bot token configured in both augments. Acceptable cost; no functional issue. Operators who want strict separation can use distinct bots (separate tokens).

### Shared Telegram bot API client utility

Both `notify`'s telegram adapter and `telegramTransport` need to call the Telegram bot API. To avoid implementation duplication and a maintenance smell, the bot API client lives as a **shared utility module** at `src/telegram-client.ts` (precedented by `src/http.ts`, which is shared across multiple augments and the `web-transport`).

**Critical: this is a shared library module, NOT a cross-augment dependency.** Both augments import from the same peer file. Neither augment imports the other. The pattern matches:
- `src/http.ts` — shared HTTP client (used by `web-fetch`, `org-context`, etc.)
- `src/engines/_shared/cost.ts` — shared cost/pricing types (used by anthropic/openai/openrouter engine adapters)
- `src/engines/_shared/schema-normalize.ts` — shared schema utilities

Augments stay independently mountable; replaceability is preserved; boot ordering is unaffected; the kernel needs no awareness of cross-augment composition.

**Client surface (v1):**

```typescript
export interface TelegramBotClient {
  sendMessage(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<SendMessageResult>;
  getUpdates(opts: GetUpdatesOptions): Promise<Update[]>;
  setWebhook(url: string, secretToken: string, opts?: SetWebhookOptions): Promise<void>;
  deleteWebhook(): Promise<void>;
  getChat(chatId: number | string): Promise<Chat>;   // for admittedAgents boot-time validation
}

export function createTelegramBotClient(opts: { botToken: string; httpClient?: HttpClient }): TelegramBotClient;
```

`notify`'s telegram adapter imports `createTelegramBotClient` and uses only `sendMessage`. `telegramTransport` imports it and uses the full surface.

**Maintenance commitment.** Future bot-API surface additions (file uploads, `editMessageText` for streaming-edit replies, reactions, inline keyboards, media replies, message-thread support) MUST land in `src/telegram-client.ts`. They MUST NOT be duplicated across the two augments. If a new augment ever needs Telegram bot API access, it imports from the same shared module.

## OrgContext changes

**Removal only.** `orgContext` loses its `org_escalate` tool and the rate-limit code that supported it (cooldown, dedup, global counter, `wordOverlap` helper). The `org_fetch` tool, manifest fetch, cache, and context-block injection are unchanged. The `EscalationLimits` type is deleted.

**No write-route generalization.** Generalizing the manifest schema to support OpenAPI-shaped write routes (with input/output schemas, risk labels, operator allowlists, multi-org namespacing) is a separate roadmap item. It needs its own design pass — schema validation, evolution, confused-deputy mitigation, naming collisions — none of which are trivial.

**Name retained.** Considered renaming `orgContext` to be more generic (e.g., `orgManifest` or `manifestRegistry`). Rejected on the grounds that the "org" framing is a social model that fits any organization (including a single-developer "self-org"), the current name's slight imprecision doesn't justify breaking every agent.yaml in the wild, and the natural moment for a rename is *if and when* write-route generalization ships (bundled as one breaking change).

## OrgContext API and `agent-context-api`: no change to the deployed model

`agent-context-api` retains its `/notify` POST endpoint and its `TELEGRAM_BOT_TOKEN_ZIP` env var. It remains the LORF-side delegated outbound endpoint — simply called via `notify`'s webhook adapter rather than `org_escalate` directly.

This is deliberate. Moving Zip's bot token from `agent-context-api` into Zip's process would be a secret-hygiene regression: the bot token would land in Zip's `.env`, Zip's launchd plist, and any logs Zip emits. The current "org owns the keys, agent calls /notify" pattern is more secure for multi-agent orgs, where a single service holds credentials shared across agents.

## Zip migration

```yaml
# was
- name: org
  type: orgContext
  options:
    baseUrl: ${ORG_CONTEXT_URL}
    # (escalation rate-limit defaults)

# becomes
- name: org
  type: orgContext
  options:
    baseUrl: ${ORG_CONTEXT_URL}
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
```

Optional addition (if the operator wants direct Telegram inbound for Zip):

```yaml
- name: telegram
  type: telegramTransport
  options:
    botToken: ${TELEGRAM_BOT_TOKEN_ZIP}
    polling: { enabled: true, timeoutSec: 30 }
    auth:
      creatorUserIds: [${OPERATOR_TELEGRAM_USER_ID}]
```

Agent surface change: existing `org_escalate({ summary, reason, visitor })` calls become `notify({ to: "creator", summary, reason, visitor })`. Zip's identity skill updated to reflect the new tool name.

`agent-context-api` is unchanged.

## Rejected alternatives

### Alternative 1 — Inline `org:` block in agent.yaml

Originally requested in the roadmap prompt. Rejected because:
- Operators with an org already host docs somewhere reachable; `orgContext` already supports any HTTP source.
- Operators without an org don't mount `orgContext` at all.
- Inline schema in YAML duplicates the manifest schema with no compelling use case.

### Alternative 2 — Generalize `orgContext` to write routes

The "orgContext = ContextAugment + NotifyAugment" collapse. Rejected because:
- Write routes need OpenAPI-shaped manifest evolution (input/output schemas), a multi-week framework subsystem.
- Confused-deputy security risk (a remote manifest declaring `/wire-money` and the augment auto-registering it as a tool).
- LORF's single current write endpoint (`/notify`) doesn't justify a registry-wide schema change.
- This is the right direction for a future item, when a second concrete write-endpoint use case exists.

### Alternative 3 — `notify` as a degenerate transport (`direction: outbound`)

Briefly entertained. Rejected because outbound-only Telegram has none of the structural properties of a transport: no server, no port, no peer identity resolution, no turn dispatch. The right home for outbound-only protocol clients is a *tool augment*, not a transport.

### Alternative 4 — Skip notify; agent reasons over outbound tools

Considered. Rejected because:
- LLM reliability for "always remember to call the second tool" is shaky; rate-limit coordination across tools is impossible.
- The rate-limit code from `org-context.ts` has to live somewhere after the strip.
- Named aliases (`creator` vs raw chat ID) reduce skill-file fragility.

### Alternative 5 — Three augments (notify + telegramOut + webhookOut + cross-augment composition)

The first iteration of this spec proposed splitting per-protocol clients into separate tool augments (`telegramOut`, `webhookOut`) referenced by `notify` via a kernel `getAugment(name)` primitive. Rejected after adversarial review because:
- Three new augments + one new kernel primitive for one current user is over-built.
- The cross-augment composition's stated benefit (avoid client duplication when both `telegramTransport` and `notify` exist for the same bot) doesn't bind: outbound and inbound on the same Telegram bot are concurrent-safe; two clients on the same bot is acceptable cost.
- Internal adapters inside `notify` are ~50 LOC each; separating them gains nothing today and re-separating later is mechanical.

### Alternative 6 — Multi-destination fan-out and severity-based routing in v1

Considered as part of `notify`. Rejected for v1 because no current call site exercises either feature. Both are roadmapped as follow-on items.

## Implementation surface

### What ships in item 6

1. **`notify` augment** — new files `src/augments/notify.ts` + `src/augments/notify/adapters/{webhook,telegram}.ts`. Carries forward the rate-limit logic (cooldown, dedup, global cap, peer cooldown, `wordOverlap`) from `org-context.ts`, refactored into the new home.
2. **`telegramTransport` augment** — new files `src/augments/telegram-transport.ts` + `src/augments/telegram-transport/{polling,webhook}.ts`. Both inbound modes (polling and webhook), four-path identity resolution (creator + agent + public-recognized + public-anonymous), `anonymousIdentityMode` knob, boot-time `admittedAgents` validation via `getChat`, reply via `sendMessage`, mode-mutual-exclusion validated at config time, webhook secret validated via `timingSafeEqual`.
3. **Shared Telegram bot API client** — new file `src/telegram-client.ts`. Used by `notify`'s telegram adapter and by `telegramTransport`. Mirrors the shared-utility pattern of `src/http.ts` and `src/engines/_shared/cost.ts`. NOT a cross-augment dependency — peer library import only.
4. **Strip from `orgContext`** — remove `org_escalate` tool, remove `EscalationLimits` type, remove cooldown/dedup/global-counter/`wordOverlap` code paths. Keep `org_fetch`, manifest fetch, cache, context-block injection.
5. **CLI wiring**: BUILTIN_TYPES, augment-resolver, augment-catalog (with default scaffold options), config-parser validation. Mirror the `budgets` integration from item 5.
6. **Skill template for `notify`** — replaces the `org-context`-shipped escalation guidance.
7. **Update Zip's `agent.yaml`** — see Migration section.
8. **Operator-reference docs** — new `augment-1/docs/13-notify.md` and `augment-1/docs/14-telegram-transport.md`, mirroring `12-budgets.md` style.
9. **Update reference docs** — `docs/06-transports.md` extended to cover multi-transport composition; `docs/07-built-in-augments.md` revised for new augments.

### What's deferred (separate roadmap items)

- **Multi-destination fan-out for `notify`** — atomic best-effort delivery to N destinations, with per-destination result aggregation.
- **Severity-based routing rules** — declarative `routing: [{if: {severity, topic}, to: [...]}]` schema.
- **`slackOut`, `emailOut`, `discordOut` adapters** — same internal-adapter pattern as `webhook` and `telegram`. Add when first operator asks.
- **`telegramTransport` streaming-edit replies** — `editMessageText` incremental updates as the model streams. Operator opt-in.
- **`telegramTransport` dynamic agent-driven recognition** — agent decides at runtime to "recognize" a user without operator config change. Requires a persistent recognition store. Defer until needed.
- **`whatsappTransport`** — same shape as `telegramTransport`, different protocol. Separate item.
- **`orgContext` write-route generalization** — manifest schema evolution to register write routes as typed tools. Separate item.

### Plan-phase decomposition (advisory)

Item 6 is larger than item 5 (which shipped 7 commits and ~650 net LOC). Two options for shipping:

- **(a) One PR.** `notify` + `telegramTransport` + strip + Zip migration land together. Atomic but large.
- **(b) Two PRs.** First PR: `notify` + strip + Zip migration. Second PR: `telegramTransport`. Independent, each leaves the system in a coherent state.

Plan phase to decide. Recommend (b) — smaller PRs are easier to review and revert. The first PR delivers the LORF/Zip migration cleanly; the second adds Telegram inbound capability orthogonally.

## Test plan

Mirror the testing rigor from item 5 (visitor economics): existing 871 tests must stay green; new tests cover all spec'd behaviors.

### Notify augment tests

- Single destination via webhook adapter — sent.
- Single destination via telegram adapter — sent (mocked Telegram API).
- Webhook adapter — 4xx response surfaces as `failed`.
- Webhook adapter — 5xx response surfaces as `failed`.
- Telegram adapter — Telegram API error response surfaces as `failed`.
- Per-peer cooldown blocks second call within window from same peer.
- Per-peer cooldown allows different peers during window.
- Dedup blocks similar-summary call within window.
- Dedup allows different-summary call.
- Global hourly cap blocks Nth call within hour.
- Creator-class peer bypasses all rate limits.
- Public-class peer always rate-limited.
- Missing destination name in `to:` — error response.
- Missing context (no peer) — error response (preserves current `org_escalate` behavior).
- Disabled rate limiting allows unlimited calls.

### Telegram transport tests

**Inbound — identity resolution (mode-agnostic)**
- Inbound from configured `creatorUserIds` → `trustLevel: "creator"`, `peer.id: tg_user_<userId>`.
- Inbound from `admittedAgents[].telegramUserId` → `trustLevel: "agent"`, `peer.id: <configured-agent-id>`.
- Inbound from `recognizedUserIds` → `trustLevel: "public"`, `publicSubstate: "recognized"`, `peer.id: tg_user_<userId>`.
- Inbound from unknown user_id with `anonymousIdentityMode: ephemeral` (default) → `trustLevel: "public"`, `publicSubstate: "anonymous"`, `peer.id: tg_anon_<threadId>`.
- Inbound from unknown user_id with `anonymousIdentityMode: durable` → `trustLevel: "public"`, `publicSubstate: "anonymous"`, `peer.id: tg_user_<userId>`.
- Same anonymous user DMing twice with `ephemeral` → distinct `peer.id` per thread (no cross-session memory).
- Same anonymous user DMing twice with `durable` → same `peer.id` (cross-session memory).
- Inbound with no text — ignored (no turn dispatched).
- Reply path — agent reply text triggers `sendMessage` to original chat_id.

**Boot-time admittedAgents validation**
- Each configured `admittedAgents[].telegramUserId` triggers `getChat(userId)` on boot.
- Successful resolution logs at info; agent path is fully wired.
- Failed resolution (404, "chat not found", bot lacks access) logs an explicit warning naming the configured `id` and `telegramUserId`. Boot continues — validation is advisory, not blocking.

**Inbound — polling mode**
- Long-poll loop respects `offset` to avoid re-processing updates.
- Long-poll error (4xx/5xx) logged and retried with backoff.
- Boot starts the long-poll loop; shutdown stops it cleanly.

**Inbound — webhook mode**
- On boot, `setWebhook` is called with configured URL and secret_token.
- HTTP server accepts POST with valid `X-Telegram-Bot-Api-Secret-Token` header → update processed.
- HTTP server rejects POST with missing/wrong secret-token header → 401, no body, no turn dispatched.
- **Secret-token compare uses `timingSafeEqual`** (not `===`) — verified via timing-attack regression test (mirrors `web-transport.test.ts` agent-secret pattern).
- HTTP server rejects non-POST methods.
- On shutdown, `deleteWebhook` is called; HTTP server stops cleanly.

**Mode mutual exclusion**
- Config with both `mode: polling` AND webhook config block → config-parser error at validation time.
- Config with `mode: webhook` but missing `webhook.publicUrl` or `webhook.secretToken` → config-parser error.

### Shared Telegram client tests

- `createTelegramBotClient` returns an object with the documented surface.
- `sendMessage` succeeds (mocked Telegram API).
- `sendMessage` 4xx/5xx surfaces as a structured error.
- `getUpdates` parses an empty response.
- `getUpdates` parses a multi-update response with mixed content (text, no text).
- `setWebhook` posts the URL and secret to the bot API; `deleteWebhook` clears it.
- `getChat` returns `{id, type, title?}` for a valid chat; throws structured error for invalid id.

### OrgContext regression tests

- All existing `org_fetch` tests pass unchanged.
- Manifest fetch + cache tests pass unchanged.
- Context-block injection tests pass unchanged.
- Existing `org_escalate` tests are deleted (behavior moves to notify).

### Integration tests

- Full agent boot with `notify` + `orgContext` mounted (mirroring Zip's revised config). Notify call lands at mocked webhook target.
- Full agent boot with `notify` + `telegramTransport` + `orgContext` mounted. Inbound Telegram message dispatches turn; agent's reply reaches `sendMessage`; agent calls `notify` mid-turn and webhook target receives it.
- Multi-transport composition: `webTransport` + `telegramTransport` mounted simultaneously; turns from both dispatch into shared agent state.

### Verification gate

- `bun test` — must stay green. Current: 871. Estimated delta: **+110 to +140 new** (notify + telegramTransport with both modes, four identity paths, ephemeral/durable peer.id modes, admittedAgents boot-validation, shared Telegram client unit tests, integration); **−12 to −18 removed** (org-context escalation tests).
- `bunx tsc --noEmit` — clean.

## Roadmap updates

This spec triggers the following roadmap changes:

- **Item 6 retitled** from "Static org config in agent.yaml" to "Notify augment + Telegram transport + orgContext strip."
- **New roadmap items added** (no specific order; drop into priority queue when item 6 lands):
  - Multi-destination fan-out for `notify` (atomic best-effort, per-destination results)
  - Severity-based routing rules for `notify`
  - `slackOut`, `emailOut`, `discordOut` adapters for `notify`
  - `telegramTransport` streaming-edit replies (`editMessageText` incremental updates)
  - `telegramTransport` dynamic agent-driven recognition (agent-issued recognition without operator config change)
  - `whatsappTransport` (full bidirectional, same shape as `telegramTransport`)
  - `orgContext` write-route generalization (manifest schema evolution; potentially with `orgContext` rename)

## Reference docs

- **Spec for prior item (item 5):** `docs/superpowers/specs/2026-04-27-visitor-economics-and-trust-design.md`
- **Operator reference style template:** `augment-1/docs/12-budgets.md`
- **Augment under modification:** `augment-1/src/augments/org-context.ts`
- **CLI wiring patterns:** `augment-1/src/cli/{config-parser,augment-catalog,augment-resolver}.ts`
- **Existing transport reference:** `augment-1/src/transports/web-transport.ts`
- **Codebase rules:** `augment-1/CLAUDE.md`
- **Roadmap:** `docs/ROADMAP.md`

## Open questions

1. **Plan-phase decomposition.** Ship item 6 as one PR or two (notify+strip first, telegramTransport second)? Recommend two; plan phase to confirm. Webhook mode adds enough scope that a finer-grained split (notify+strip; telegramTransport polling+identity; telegramTransport webhook) may also be considered.

2. **Telegram client library choice.** Build the shared `src/telegram-client.ts` thinly over `fetch` against the bot API directly, or pull in a third-party library (e.g., `grammy`, `node-telegram-bot-api`)? Adds dependency surface vs. maintenance cost. Plan-phase decision; recommendation is to build thinly to keep the surface minimal and dependency footprint zero (matches Auggy's preference for `src/http.ts` over a node fetch wrapper library).

3. **Webhook server port allocation.** Spec defaults to `port: 8081` (avoiding likely collisions with `webTransport`'s `port: 8080`). If multiple `telegramTransport` augments are mounted (multiple bots), each needs a distinct port. Operator's responsibility, but the catalog defaults should pick non-colliding values for the common scaffold.

4. **Webhook mode behind a reverse proxy.** Operators running a reverse proxy in front of the webhook server can't validate `X-Telegram-Bot-Api-Secret-Token` at the proxy layer (Telegram's specific header). Proxy must pass it through unchanged. Documentation note in the operator reference.

5. **Rate-limit state durability.** Currently in-process (closure variables). Restart loses cooldowns and dedup history. Acceptable for v1 (matches today's `org-context.ts`) but worth noting as a future hardening item, especially for the multi-destination fan-out work.

6. **Trust-level interaction with rate limits in notify.** Creator bypasses today. Should there be an operator override (`bypassTrustLevels: ["creator", "agent"]`)? Out of scope here; flag as a small follow-on.

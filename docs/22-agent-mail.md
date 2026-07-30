# `agentMail` augment

**Availability:** outbound email and the durable inbound/review foundation are
implemented in the unpublished `0.5.0` candidate. The latest npm release,
`0.4.4`, does not include them.

`agentMail` gives an agent a policy-gated AgentMail inbox. It exposes
`send_message`, `reply_to_message`, and `forward_message`, and can turn admitted
inbound email into normal Auggy turns through polling, WebSocket, or verified
webhook delivery. Every enabled inbound mode also uses REST catch-up and a
durable SQLite ledger, so a live connection is never the only record of mail.

## When to use

Add `agentMail` when the agent itself needs to send or receive email. It is a
good fit for support inboxes, operational follow-up, and workflows where a
person replies by email and the reply should wake the agent.

Two related features have narrower jobs:

- `notify` sends outbound alerts to operator-configured destinations. Its
  AgentMail adapter is outbound-only and does not make email a conversation.
- `visitorAuth` sends magic links through its own AgentMail configuration. You
  do not need the `agentMail` augment just to recognize returning visitors.

Install and configure the augment with:

```bash
auggy augment add agentMail
auggy augment setup agentMail
```

## Why an augment instead of AgentMail MCP

AgentMail's hosted MCP server is useful for on-demand mail operations. The
augment is the stronger fit when email must live inside the agent runtime:

- inbound events wake the model only when admitted mail exists; an external
  scheduler does not spend full model turns polling an empty inbox;
- sender, recipient, trust, rate, review, and classification policy are
  enforced next to the turn kernel;
- checkpoints, retries, deduplication, and ambiguous-send reconciliation are
  durable runtime state.

If you need only occasional operator-driven mail actions, the MCP server may be
simpler.

## Configuration

Inbound is disabled by default. Enabling it requires a non-empty sender
allowlist. Exact addresses and `*@domain` patterns are compared case
insensitively.

```yaml
# agent.yaml
augments:
  - webTransport
  - agentMail

# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  # creator | public. Setup uses public for a model-facing AgentMail inbox.
  addressVisibility: public
  # apiBaseUrl: https://api.agentmail.to/v0
  # dbPath: ./agent-mail.db

  outbound:
    # Default: [creator]
    allowedTrustLevels: [creator]

    # Optional. If present, every recipient must match.
    allowedRecipients:
      - operator@example.com
      - "*@trusted.example"

    maxRecipients: 10
    bodyMaxBytes: 102400
    allowHtml: false
    subjectPrefix: "[Auggy] "

    rateLimit:
      enabled: true
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000

    humanReview:
      # Default: [public]. A reviewed trust level must also be allowed above
      # before it can propose an outbound action.
      requiredForTrustLevels: [public]
      expiresAfterMs: 86400000

  inbound:
    # none | polling | websocket | webhook
    mode: websocket
    allowedSenders:
      - support@example.com
      - "*@customer.example"
    pollIntervalMs: 60000
    maxPromptBytes: 102400
    maxAttempts: 5
    classifications:
      received: process
      spam: discard
      blocked: discard
      unauthenticated: discard
    # websocketBaseUrl: wss://api.agentmail.to/v0
    # webhook:
    #   path: /webhooks/agentmail
    #   secretEnv: AGENTMAIL_WEBHOOK_SECRET
    #   timestampToleranceSeconds: 300
```

Credential-bearing AgentMail endpoints require HTTPS/WSS. Plaintext HTTP/WS is
accepted only for loopback development. A remote sandbox that cannot use TLS
requires both `allowInsecureHttpWithCredentials: true` and
`NODE_ENV=development`; never enable that override in a deployed agent.

`webTransport` is required for `inbound.mode: webhook`. It is also required
with `adminRoute` enabled whenever an executable trust level requires outbound
human review, because review decisions are creator-authenticated admin actions.

`emailAddress` is the last setup-verified canonical address for the inbox.
At boot, a reachable provider response must agree with it before Auggy exposes
the address. A transient provider failure may use the configured address with
degraded status; an authoritative mismatch fails startup so the agent cannot
publish the wrong contact address. When `addressVisibility` is `public`, the
model may provide the address when email is contextually appropriate. It must
still say when inbound monitoring is disabled or degraded.

Only one enabled inbound `agentMail` augment may own a given inbox. Multiple
outbound-only instances can coexist, but two workers must not compete for the
same inbound stream.

## Choosing an inbound mode

| Mode | Arrival path | Recovery behavior | Use it when |
| --- | --- | --- | --- |
| `none` | No inbound turns | No ledger worker | The agent only sends mail |
| `polling` | Periodic AgentMail REST reads | The same reads advance a durable checkpoint | Simplicity is more important than immediate delivery |
| `websocket` | AgentMail live subscription | REST catch-up runs after subscription and the SDK reconnects | You want low latency without a public callback URL |
| `webhook` | Svix-verified HTTP callback | REST catch-up runs at boot; webhook deliveries are deduplicated in the ledger | The agent has a stable public URL |

All enabled modes drain the same SQLite ledger. The ledger records provider
delivery IDs and message IDs, checkpoints catch-up reads with overlap, leases a
message to one worker, retries failed turns with bounded backoff, and durably
marks processed or discarded mail. The default first-run lookback is 24 hours;
checkpoint reads overlap by one minute to avoid boundary loss, with duplicates
removed by the ledger.

## Inbound trust and prompt shape

Email is untrusted input, even when its sender matches `allowedSenders`.
Admitted senders become deterministic `public` + `anonymous` peer identities
scoped to the inbox, sender, and thread. `visitorAuth` does not silently promote
an email sender.

The runtime renders the provider envelope as bounded, explicitly untrusted JSON
inside the turn. It never promotes email headers or body text into system
instructions. Ordinary `message.received` events are processed by default;
spam, blocked, and unauthenticated classifications are discarded unless the
operator deliberately overrides that posture.

Definitively failed turns are retried. After `maxAttempts` (default 5), the
message is durably discarded rather than looping forever. A turn whose effects
are outcome-unknown is never retried: `AMIL/v2` creates a server-minted
incident, blocks every later message in that provider thread, and restores the
kernel thread quarantine after process restart. `maxPromptBytes` defaults to
100 KiB and must be at least 512 bytes.

A processing lease is a liveness heartbeat, not permission to replay after
expiry. Runtime startup fences every retained processing claim as ambiguous;
live workers atomically fence expired claims before seeking pending work. An
old worker cannot complete, retry, discard, or renew a fenced claim. Recovery
is explicit even when a process stopped before the operator can tell whether
model or tool execution began.

## Model-facing tools

| Tool | Important inputs | Result statuses |
| --- | --- | --- |
| `send_message` | `to[]`, `subject`, `text`, optional `html`, `labels` | `sent`, `pending_review`, `rate_limited`, `failed` |
| `reply_to_message` | `messageId`, `text`, optional `html`, `replyAll`, `labels` | same |
| `forward_message` | `messageId`, `to[]`, optional `text`, `html`, `subject`, `labels` | same |

`reply_to_message` and `forward_message` accept only a message ID delivered to
the agent in the current inbound turn. This prevents a prompt from guessing or
supplying an arbitrary provider message ID. The turn-scoped record also gives a
reply enough trusted envelope metadata to re-run recipient policy.

## Outbound guards and human review

Every outbound action passes these checks before AgentMail is called:

| Layer | Behavior |
| --- | --- |
| Trust | Only `outbound.allowedTrustLevels`; creator/system calls remain the strict default |
| Recipients | Optional exact/domain allowlist, valid email syntax, 10-recipient default, 50 hard maximum |
| Content | 100 KiB default body cap, HTML opt-in, mandatory subject prefix, control-character and SMTP envelope checks |
| Rate and dedup | Global hourly cap, per-recipient cooldown, and subject-hash duplicate window |
| Sensitive scan | Token-shaped strings are flagged in the operator audit surface; the send is not silently rewritten |
| Human review | Configured trust levels receive `pending_review` instead of immediate delivery |

A pending action is stored durably with an immutable content fingerprint and a
24-hour default expiry. The admin list redacts recipients; the exact request is
available only from the creator-authenticated, `no-store` review detail route.
Approval requires that inspection fingerprint, rechecks current rate limits,
and sends the exact queued request. Rejection records an operator reason.

Because AgentMail does not expose an idempotency key for sends, a connection
failure after the provider may have accepted a request is treated as
**ambiguous**. Auggy tells the model not to retry. The operator must inspect the
provider and reconcile the attempt as sent or not sent; automatic retry could
duplicate real email.

## Webhook verification

Webhook mode mounts `POST /webhooks/agentmail` by default. The shared route
policy verifies the Svix signature against the raw request body before JSON
parsing, uses `AGENTMAIL_WEBHOOK_SECRET` unless configured otherwise, and
defaults to a 300-second timestamp tolerance. Generated browser clients omit
webhook-policy routes.

## Environment variables

| Variable | Required when | Purpose |
| --- | --- | --- |
| `AGENTMAIL_API_KEY` | Always | AgentMail bearer key (`am_...`) |
| `AGENTMAIL_INBOX_ID` | Always | Inbox used for send and receive |
| `AGENTMAIL_INBOX_EMAIL` | Model-facing `agentMail` setup | Setup-verified canonical inbox address |
| `AGENTMAIL_WEBHOOK_SECRET` | Webhook mode, unless `secretEnv` changes | Svix signing secret (`whsec_...`) |

Prefer an inbox-scoped, least-privilege key. The exact AgentMail permissions
depend on the enabled send, receive, and live-subscription paths.

## State and Railway durability

Locally, a relative `dbPath` is resolved from the agent project. On Railway,
AgentMail state is always rooted under:

```text
/app/data/agent-mail/<augment-name>/
```

The deploy runtime fails closed unless `/app/data` is the advertised real
volume mount. It creates the AgentMail state leaf with mode `0700` and proves
create, fsync, atomic rename, directory fsync, and delete durability before the
agent starts. A relative `dbPath` cannot escape its per-augment namespace.

Other core SQLite stores also resolve directly onto the volume. Do not rely on
root-level compatibility symlinks for AgentMail, memory, budgets, or
visitor-auth state; only Link retains its legacy symlink path.

## Operator visibility

The creator-authenticated admin surface reports:

- the canonical inbox email, its source, and model-context visibility;
- inbound mode and live state;
- pending, processing, processed, discarded, and outcome-unknown ledger counts;
- catch-up checkpoint, last catch-up summary, last inbound event, and last
  worker outcome;
- last provider error;
- outbound sent, blocked, rate-limited, pending-review, and ambiguous attempts;
- redacted recent dispatches and review rows;
- test-send, cap adjustment, approve/reject, ambiguous-send reconciliation,
  and versioned inbound-incident reconciliation actions. Inbound evidence is
  stored only as SHA-256; raw evidence is never written to the ledger.

## Common failures

| Symptom | Likely cause and fix |
| --- | --- |
| `AGENTMAIL_API_KEY is unresolved` | Set the variable in `.env` and restart |
| Inbox healthcheck returns 401/403 | Check the key, inbox ID, and provider permissions |
| Inbound config rejects an empty allowlist | Add at least one exact sender or `*@domain`; enabled inbound is deny-by-default |
| Webhook mode says `webTransport` is required | Mount `webTransport` so the verified route can be served |
| Human review says the admin route is required | Enable `webTransport.adminRoute` or change review/allowed trust levels |
| A reply says the message was not delivered this turn | Reply only from the turn triggered by that inbound message |
| A send outcome is ambiguous | Do not retry; verify with AgentMail and use the admin reconciliation action |
| An inbound turn is outcome-unknown | Verify downstream effects, then reconcile the exact incident/version as handled or no-effect; the runtime thread remains blocked until every AgentMail, Notify, or other durable incident authority is clear |
| Mail vanishes after Railway redeploy | Confirm the volume is mounted at exactly `/app/data`; admission should fail before boot if it is not durable |

## Current limits

- Outbound attachments are not exposed.
- Draft endpoints, read receipts, retraction, and delivery-event turns are not
  exposed.
- An inbound email turn sees the triggering message, not an automatically
  fetched full thread transcript.

## Related

- [`13-notify.md`](./13-notify.md) — outbound alerts, including the separate
  outbound-only AgentMail destination adapter.
- [`18-deploy.md`](./18-deploy.md) — Railway volume admission and recovery.
- [`19-visitor-auth.md`](./19-visitor-auth.md) — magic-link visitor recognition.
- [`25-generated-route-clients.md`](./25-generated-route-clients.md) — route
  policy and generated-client behavior.
- AgentMail documentation: [API](https://docs.agentmail.to/api-reference),
  [WebSockets](https://docs.agentmail.to/websockets/quickstart), and
  [webhook verification](https://docs.agentmail.to/webhook-verification).

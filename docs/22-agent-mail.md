# `agentMail` augment

**Availability:** outbound email shipped before RC.5; the current hardened
inbound, reviewed-reply, digest, and multi-inbox action-center contract is in
the published `0.5.0-rc.8` candidate. Inbound remains an explicit opt-in.

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

## Install and setup

Built-in augment names are case-insensitive at the CLI boundary. Both of these
install the canonical `agentMail` augment and mount its skill:

```bash
auggy augment add agentmail
auggy augment add agentMail
```

The dedicated AgentMail command is the concise setup entry point:

```bash
auggy agentmail setup agentMail
```

The generic augment command runs the same setup workflow:

```bash
auggy augment setup agentMail
```

`auggy agentmail setup` may omit its target only when exactly one canonical
`agentMail` or `visitorAuth` augment is installed. If both are installed, name
the target. If neither is installed, setup tells you which augment to add.
Non-interactive use must also pass an explicit `--mode`.

If both canonical augments are new, the shortest safe path is one interactive
add:

```bash
auggy augment add agentMail visitorAuth
```

The post-add flow uses one shared setup confirmation and one provider-credential
and provisioning flow. It provisions `agentMail` first, then attaches `visitorAuth`
with `--mode env` without asking for credentials again. This is true regardless
of argument or picker order. It prints start/restart guidance only after both
steps succeed. If an accepted setup fails, the command exits nonzero, leaves
the installed files in place, and tells you to finish setup or remove the
unresolved augment before restarting. `--yes` skips optional post-add setup
rather than provisioning non-interactively.

Automatic setup deliberately supports only one canonical referenced mount at
`augments/agentMail/augment.yaml` or `augments/visitorAuth/augment.yaml`. It
fails closed for inline mounts, custom names, custom AgentMail-compatible
augments, or multiple mounts of the same type. Configure those instances
manually; setup will not guess which file or credentials it owns.

Automatic credential mutation is supported on macOS and Linux. It uses one
cross-process agent-directory lease and compares the exact `agent.yaml` and
`.env` and augment sources again before commit, so Console edits, `augment add`, or direct
operator edits cannot be silently overwritten during a provider request. On
Windows, configure `.env` and the referenced `augment.yaml` with ordinary
project tooling; automatic setup fails closed without changing files because
the required POSIX descriptor lock is unavailable.

### Setup modes

| Mode | Provider ownership and effects | Credential input |
| --- | --- | --- |
| `signup` | For a person new to AgentMail. Creates the account and first inbox, verifies the human owner, and mints an inbox-scoped runtime key. Interactive only. | Human email and inbox username, followed by an interactive OTP prompt after AgentMail sends the challenge |
| `existing` | For an existing AgentMail account. Creates or resolves this agent's deterministic inbox, then mints an inbox-scoped runtime key. | Account API key from the masked prompt or `AGENTMAIL_ACCOUNT_API_KEY` |
| `manual` | Connects an existing inbox and existing scoped runtime key. It does not create or widen provider resources. | Inbox ID and runtime key from masked prompts or `AGENTMAIL_INBOX_ID` and `AGENTMAIL_API_KEY` |
| `env` | Reuses the runtime inbox ID and key already stored in the agent's `.env`; `agentMail` also verifies and records the canonical inbox email. | Existing local `AGENTMAIL_INBOX_ID` and `AGENTMAIL_API_KEY` |

Interactive setup presents those four choices with the same ownership
language. Signup asks for the OTP only after the signup request has created the
challenge; there is intentionally no pre-supplied OTP or non-interactive signup
path. For automation, use `existing`, `manual`, or `env`.

Setup never silently replaces runtime credentials already assigned to the
agent. Use `--mode env` to reuse the values in `.env`. To deliberately
reprovision or attach a different inbox, first revoke the old inbox-scoped key
in AgentMail, then remove the old `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, and
`AGENTMAIL_INBOX_EMAIL` entries from the agent's `.env` and unset any exported
variables with those names before running `signup`, `existing`, or `manual`.
Revoke before deleting local credentials so the retired provider key is not
orphaned.

The account API key is provisioning authority. Auggy uses it only to create the
inbox and its least-privilege runtime key; it never writes that account key to
the agent's `.env`. Prefer the masked prompt. For non-interactive existing
account setup, inject `AGENTMAIL_ACCOUNT_API_KEY` through the operator's secret
manager or a genuinely process-scoped environment, not a project `.env`,
`.env.local`, or environment-specific dotenv file. Because Bun may load those
files into `process.env`, setup checks the agent and invocation directories and
fails before contacting AgentMail when it finds the provisioning key there.

The inbox-scoped key is runtime authority. Setup writes only that key as
`AGENTMAIL_API_KEY`, together with `AGENTMAIL_INBOX_ID` and, for `agentMail`,
the verified `AGENTMAIL_INBOX_EMAIL`. Avoid `--api-key` for either kind of key:
although supported for controlled automation, command-line arguments can be
retained in shell history or exposed through process inspection. Use the
masked prompt or the matching environment variable instead.

Existing-account inbox creation carries a deterministic, provider-valid
idempotency identity derived from the immutable agent ID and setup target. An
explicit retry therefore addresses the same logical inbox rather than asking
AgentMail to create another one. Auggy never adopts, overwrites, or deletes an
inbox merely because a username or account already exists.

If signup says the human email already has an AgentMail account, interactive
setup can continue into `existing` mode. An explicit or non-interactive signup
stops without changing local credentials; rerun with:

```bash
auggy agentmail setup agentMail --mode existing
```

Use an AgentMail account key when prompted. Do not use an inbox runtime key for
this mode. On a definitive `403 resource_taken`, Auggy lists the account's
inboxes and may offer reuse only when exactly one inbox has both the requested
address and this agent's compatible Auggy `client_id`. That interactive reuse
still requires confirmation. If ownership cannot be proved, interactive setup
asks for another username with at most three create attempts total; cancellation
or exhaustion leaves local credentials unchanged. Non-interactive setup does
not choose another name or adopt the collision: retry with a different
`--username`, or connect a known inbox and scoped runtime key with
`--mode manual`. Confirmed reuse mints a new scoped runtime key because the old
key is not available locally; setup does not revoke earlier keys, so review the
inbox in AgentMail and revoke obsolete scoped keys after the new key is saved.

Provisioning mutations are never retried automatically when the provider
outcome is unknown. For an interrupted inbox-create request, an operator may
explicitly retry after checking AgentMail; the deterministic identity targets
the same logical inbox. Scoped API-key creation has no equivalent idempotency
guarantee. If that request times out or returns an ambiguous server failure,
inspect the inbox's keys in AgentMail and revoke any orphan with the setup key
name before retrying. Provider failures leave the local `.env` and augment
configuration unchanged.

### Sharing one inbox with `visitorAuth`

The canonical `agentMail` and `visitorAuth` setups intentionally share one
AgentMail inbox and runtime key. Configure `agentMail` first so setup mints the
permissions required by its complete inbound/outbound policy, then attach
`visitorAuth` to those local credentials:

```bash
auggy augment add agentmail
auggy augment add visitorAuth
auggy agentmail setup agentMail
auggy agentmail setup visitorAuth --mode env
```

Reversing this order fails closed instead of replacing shared credentials with
a key that may be too narrow for `agentMail`. Custom, inline, additional, or
multiple AgentMail consumers must be assigned credentials manually rather than
passing through this shared singleton setup path.

An interactive `auggy augment add agentMail visitorAuth` performs that exact
sequence through one setup confirmation and credential flow. The two-command
sequence above remains the recovery path for standalone adds, skipped setup,
automation, or a partial post-add failure.

### Removal and provider cleanup

`auggy augment remove agentMail` and `auggy augment remove visitorAuth` remove
the local augment mount and its copied skill, not provider resources. If the
other shared consumer remains, Auggy retains the `AGENTMAIL_*` values and
remote inbox/key because removal alone cannot prove that they are unused.
Removing the final canonical consumer also retains them and prints a warning:
confirm that no other local configuration uses the inbox, revoke the scoped
key in AgentMail first, and only then remove the local runtime values. Auggy
never auto-revokes or deletes an AgentMail inbox.

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

## Provider inbox and Auggy review

AgentMail remains the source of truth for inbox messages, threads, sent history,
and provider-native drafts. The Auggy Console intentionally does not reproduce
that mailbox UI. Its Mail action center owns a narrower operational surface:
Auggy's durable reply proposals, creator approvals, policy posture, quota
evidence, and ambiguous-outcome reconciliation.

**Open in AgentMail** appears for the selected mounted mailbox in both the Mail
action center and its Capabilities identity card. It opens AgentMail's official
Console root in a new tab. AgentMail does not document a stable inbox-specific
Console URL, so Auggy does not guess one; the selected inbox address and ID stay
visible for identification. The link contains no API key, Auggy Console token,
message data, or review data.

An Auggy `pending_review` record is not an AgentMail draft. Keeping the proposal
inside Auggy preserves the exact authorization, fingerprint, quota, and
reconciliation boundary until the creator approves or rejects it. AgentMail is
called only after that decision.

## Configuration

Inbound is disabled by default. Enabling it requires exactly one sender policy:
a non-empty `allowedSenders` list, or the explicit public-inbox switch
`allowAnySender: true`. Configuring both is rejected. Exact addresses and
`*@domain` patterns are compared case insensitively. Patterns must be canonical
email/domain forms; broad or partial wildcards such as `*` and `foo*` remain
invalid. Use `allowAnySender: true` when every well-formed sender should be
eligible. A domain pattern matches that exact domain, not its subdomains.

```yaml
# agent.yaml
augments:
  - webTransport
  - agentMail
  - notify

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
    # Optional for an allowlisted inbox. The window is a rolling local hour.
    rateLimit:
      globalMaxPerHour: 100
      perSenderMaxPerHour: 5
    pollIntervalMs: 60000
    maxPromptBytes: 102400
    maxAttempts: 5
    replies:
      # disabled | review | automatic. Enabled inbound defaults to review.
      mode: review
      # Default false. Applies only to the exact message in the current email turn.
      allowReplyAll: false
    creatorDigest:
      # Explicit opt-in. Omit this block to keep creator push disabled.
      enabled: true
      # Must uniquely match a creator-authorized, rate-limited Notify destination.
      destination: creator
      intervalMs: 900000
      maxItems: 20
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

For a deliberately public inbox, replace `allowedSenders` with
`allowAnySender: true`. Public admission must always have both finite limits:

```yaml
inbound:
  mode: websocket
  allowAnySender: true
  rateLimit:
    globalMaxPerHour: 100
    perSenderMaxPerHour: 5
```

`100` globally and `5` per sender is the recommended starting posture for a
public inbox. `globalMaxPerHour` accepts 1–10,000,
`perSenderMaxPerHour` accepts 1–1,000, and the per-sender limit cannot exceed
the global limit. Allowlisted inboxes may omit `rateLimit` to preserve their
existing behavior, or configure the same bounded fields for defense in depth.
Changing inbound admission or limit settings requires editing YAML and
restarting the agent; there is no live Console override.

These limits protect Auggy's local admission and model-processing boundary.
They do not reject mail at SMTP time or prevent AgentMail from accepting and
storing it upstream. Usage is counted over a rolling hour using local admission
time. Provider duplicates, reconnects, and retries do not create another
charge for the same message.

After the local worker evaluates any pre-model policy rejection, it atomically
replaces the stored sender, recipients, subject, body, attachment metadata, and
provider label list with a fixed-shape content-free tombstone. Each inbox
retains at most 1,000 such tombstones; lifetime quota counters and a fixed-size
probabilistic rejection filter live in a separate bounded aggregate. The
filter has no false negatives, so an evicted rejected message cannot re-enter
after the rolling window advances. Under extreme rejection volume a hash
collision may reject additional new mail, which is the fail-closed outcome.
This bounds terminal rejection evidence, not transient full messages already
accepted upstream or waiting for local evaluation.

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
instances with different inboxes can coexist, including inbound workers. The
runtime binds routes, review decisions, creator-attention state, rate state,
admin overrides, dashboard actions, and durable storage to the configured
augment name. Every instance must resolve to a distinct SQLite database;
startup rejects duplicate database ownership. Two workers must also never
compete for the same inbound stream, so duplicate enabled inbox ownership is a
startup error.

With one mounted instance, the model tools retain the canonical names
`send_message`, `reply_to_message`, and `forward_message`. With multiple
instances they become `send_message__<augment-name>`,
`reply_to_message__<augment-name>`, and
`forward_message__<augment-name>` so the model and kernel cannot silently
dispatch through the wrong mailbox. Runtime context names the exact tools and
inbox. In a multi-instance configuration, each augment name is limited to 46
characters so every namespaced tool name stays within the common 64-character
provider limit.

`inbound.creatorDigest` is independently disabled by default. When enabled,
Auggy requires exactly one matching `notify` destination that allows creator
trust and retains a positive durable quota. Every interval, a synthetic bridge
batches only durable creator-attention metadata: counts of open,
pending-review, ambiguous, or quarantined mail. It never places sender,
recipient, subject, body, draft, message/review identifiers, visitor identity,
or provider errors in the notification. The creator opens the authenticated
console to inspect the underlying review or attention records.

Digest delivery uses Notify's normal durable quota and replay ledger; creator
origin does not bypass those controls. A crash after provider acceptance
replays as already sent rather than sending twice. An unknown outcome remains
fenced for operator reconciliation, and definitive failures retry only up to
`maxAttempts`. After exhaustion, the creator may authorize one CAS-bound
attempt or dismiss only that digest generation. Dismissal does not change the
email, reply review, or creator-attention state. Changing the Notify augment or
destination while a batch is pending fails closed until that batch is
reconciled.

Settled digest batches use compact retirement ranges, so one still-current
presented item cannot pin every later generation or exhaust batch capacity.
Exact current presented/dismissed snapshots remain until their source state
changes. On boot, the bridge scans the bounded live settlement set and
idempotently acknowledges each matching Notify operation before preparing new
work; this closes a crash between provider delivery and the two durable
settlements without weakening replay protection.

Setup reads this inbound block before it creates an inbox-scoped runtime key.
`visitorAuth` and outbound-only `agentMail` receive exactly `inbox_read` and
`message_send`. Enabled `agentMail` inbound adds `message_read`; setup adds
`label_spam_read` or `label_blocked_read` only when the matching classification
is explicitly set to `process`. Manual or `.env` credentials are not widened by
Auggy, so the supplied key must already have the same permissions.

## Choosing an inbound mode

| Mode | Arrival path | Recovery behavior | Use it when |
| --- | --- | --- | --- |
| `none` | No inbound turns | No ledger worker | The agent only sends mail |
| `polling` | Periodic AgentMail REST reads | Single-flight reads advance a durable checkpoint | Simplicity is more important than immediate delivery |
| `websocket` | AgentMail live subscription | REST catch-up runs after subscription/reconnect and periodically repairs silent gaps | You want low latency without a public callback URL |
| `webhook` | Svix-verified HTTP callback | Periodic REST catch-up repairs missed callbacks; all arrivals deduplicate in the ledger | The agent has a stable public URL |

All enabled modes run one managed REST reconciliation loop and drain the same
SQLite ledger. Catch-up is single-flight even when a provider request exceeds
the configured interval, and shutdown stops scheduling and quiesces active
catch-up before closing the ledger. The ledger records provider
delivery IDs and message IDs, checkpoints catch-up reads with overlap, leases a
message to one worker, retries failed turns with bounded backoff, and durably
marks processed or discarded mail. The default first-run lookback is 24 hours;
checkpoint reads overlap by one minute to avoid boundary loss, with duplicates
removed by the ledger.

## Inbound trust and prompt shape

Email is untrusted input, whether its sender matches `allowedSenders` or the
inbox deliberately uses `allowAnySender`.
The allowlist accepts at most 1,000 exact-address or exact-domain patterns;
use a domain pattern for a large company inbox instead of enumerating every
employee address.
Admitted senders become deterministic `public` + `anonymous` peer identities
scoped to the inbox, sender, and thread. `visitorAuth` does not silently promote
an email sender.

The runtime renders the provider envelope as bounded, explicitly untrusted JSON
inside the turn. It never promotes email headers or body text into system
instructions. Ordinary `message.received` events are processed by default;
spam, blocked, and unauthenticated classifications are discarded unless the
operator deliberately overrides that posture. WebSocket subscribes only to
classifications configured as `process`; REST opts into only the selected
restricted spam/blocked/unauthenticated buckets and filters ordinary results
locally. This keeps scoped keys least privileged. A verified webhook may still deliver another received
classification; that event is durably discarded before kernel admission.

A malformed `From` address is rejected before model admission. Sender quota
keys are case-insensitive, but plus-address aliases remain distinct addresses;
the global cap is therefore the authoritative bound against sender rotation.
When either quota is exhausted, the message is durably rate-limited and
content-compacted without a model turn, automatic reply, pending review,
creator-attention record, or creator notification. Rate-limited mail is not
deferred into a backlog that could wake the agent after the window advances.

Definitively failed turns are retried. After `maxAttempts` (default 5), the
message is durably discarded rather than looping forever. A turn whose effects
are outcome-unknown is never retried: `AMIL/v5` creates a server-minted
incident, blocks every later message in that provider thread, and restores the
kernel thread quarantine after process restart. `pollIntervalMs` ranges from
one second to 24 hours, `maxPromptBytes` ranges from 512 bytes to 1 MiB, and
`maxAttempts` ranges from 1 to 20.

Inbound delivery does not imply automatic replies or creator push. A plain
assistant response produced by an inbound turn is not sent as email. The agent
must call `reply_to_message`. Enabled inbound defaults `inbound.replies.mode` to
`review`, which lets the exact admitted AgentMail turn propose one reply even
when general public outbound is disabled. The proposal is durably queued for
creator approval; this narrow authority never enables a new `send_message`,
`forward_message`, another message ID, another turn, or another source augment.
Any enabled reply mode requires durable review storage; runtime construction
fails closed instead of silently keeping approvals in memory.

`automatic` is an explicit opt-in and requires the durable outbound rate limit
to remain enabled with an effective global cap of 1–100 per hour, including
persisted and live admin overrides. It sends only the exact current reply;
sensitive/token-shaped content and a Reply-To address that differs from From
fall back to review. New inbound replies pin an explicit, policy-validated
recipient list rather than asking the provider to derive it again. `replyAll`
is independently disabled by default; when enabled it deduplicates recipients
and removes the verified canonical inbox email. If that identity is
unavailable, reply-all fails closed. `disabled` prevents even a review
proposal. `notify` remains a separate augment; no external creator alert is
sent merely because inbound is enabled unless
`inbound.creatorDigest.enabled` is explicitly true.

Every newly queued reply, including creator-originated replies, stores its
explicit recipients. A legacy pending reply review without that binding is
cancelled rather than approved with provider-derived recipients. A legacy
`sending` record remains ambiguous and requires operator reconciliation.

Before an admitted model turn starts, the runtime reserves a bounded durable
creator-attention metadata record. It tracks open, pending-review, sent,
rejected, failed, ambiguous, and dismissed states across restart. The generic
admin table shows only message ID, state, version, review link, and timestamp;
no model response or provider error text is persisted there. Dismissal is
creator-only and requires the current record version so a stale console cannot
overwrite a concurrent send or review transition. Startup and admin reads
reconcile linked review state after expiry or a crash between durable writes.
Each exact inbound reply review carries the creator-attention version that
authorized it; restart repair links only that generation, independent of record
timestamps. Legacy and non-inbound reviews without a generation never
auto-link.
The default capacity is 1,000 active plus retained records; exhaustion stops
before model or tool effects. The exact inbound claim returns to pending with
its attempt count unchanged, and is never discarded for attention pressure.
Periodic capacity rechecks wait five seconds; resolving or dismissing attention
wakes the drain immediately. Terminal surrounding rows may then be pruned and
the same message continues. Terminal rows become eligible for pruning after 30
days.

A processing lease is a liveness heartbeat, not permission to replay after
expiry. Runtime startup fences every retained processing claim as ambiguous;
live workers atomically fence expired claims before seeking pending work. An
old worker cannot complete, retry, discard, or renew a fenced claim. Recovery
is explicit even when a process stopped before the operator can tell whether
model or tool execution began. “Confirmed no effect” retry cancels a still
pending reply review and reopens only failed or dismissed attention. This check
independently scans durable reply reviews for the incident message even if its
attention metadata is absent: sent/approved, sending/ambiguous, and rejected
evidence blocks retry; failed and expired reviews may be safe. Those outcomes
must be explicitly reconciled and cannot be silently replayed.

## Model-facing tools

| Tool | Important inputs | Result statuses |
| --- | --- | --- |
| `send_message` | `to[]`, `subject`, `text`, optional `html`, `labels` | `sent`, `pending_review`, `rate_limited`, `failed` |
| `reply_to_message` | `messageId`, `text`, optional `html`, `replyAll`, `labels` | same |
| `forward_message` | `messageId`, `to[]`, optional `text`, `html`, `subject`, `labels` | same |

`reply_to_message` and `forward_message` accept only a message ID delivered to
the agent in the current inbound turn. This prevents a prompt from guessing or
supplying an arbitrary provider message ID. The turn-scoped record also gives a
reply enough trusted envelope metadata to honor Reply-To, remove the verified
inbox from reply-all, and re-run recipient policy against the exact list sent
to AgentMail.

## Outbound guards and human review

Every outbound action passes these checks before AgentMail is called:

| Layer | Behavior |
| --- | --- |
| Trust | Only `outbound.allowedTrustLevels`; creator/system calls remain the strict default |
| Recipients | Optional exact/domain allowlist, valid email syntax, 10-recipient default, 50 hard maximum |
| Content | 100 KiB default body cap (configurable to 1 MiB), HTML opt-in, mandatory subject prefix, control-character and SMTP envelope checks |
| Rate and dedup | Global hourly cap, per-recipient cooldown, and subject-hash duplicate window |
| Sensitive scan | Token-shaped strings are flagged; automatic inbound replies fall back to review rather than sending |
| Human review | Configured trust levels receive `pending_review` instead of immediate delivery |

A pending action is stored durably with an immutable content fingerprint and a
24-hour default expiry. The admin list redacts recipients; the exact request is
available only from the creator-authenticated, `no-store` review detail route.
Approval requires that inspection fingerprint, rechecks current rate limits,
and sends the exact queued request. A revise-and-send decision may replace the
body while preserving the reviewed operation kind, provider message binding,
and policy-validated recipients; it creates and checks a new exact fingerprint
before dispatch. Rejection records an operator reason and cannot send mail.
Every mutation is bound to the augment instance and row identity. Send-capable
review mutations additionally require the current inspection fingerprint, and
versioned attention/incident mutations require the current generation, so a
stale browser or another mailbox's token cannot act on it.

Because AgentMail does not expose an idempotency key for sends, a connection
failure after the provider may have accepted a request is treated as
**ambiguous**. Auggy tells the model not to retry. The operator must inspect the
provider and reconcile the attempt as sent or not sent; automatic retry could
duplicate real email.

## Webhook verification

Webhook mode mounts `POST /webhooks/agentmail` by default for one mailbox and
`POST /webhooks/agentmail/<augment-name>` when multiple instances are mounted.
The shared route policy verifies the Svix signature against the raw request body before JSON
parsing, uses `AGENTMAIL_WEBHOOK_SECRET` unless configured otherwise, and
defaults to a 300-second timestamp tolerance. Generated browser clients omit
webhook-policy routes. This secret is required only when inbound delivery uses
Svix webhook mode; default outbound use, polling, and WebSocket delivery do not
need it, so a normal `auggy augment add agentMail` does not scaffold the value.

## Environment variables

| Variable | Required when | Purpose |
| --- | --- | --- |
| `AGENTMAIL_ACCOUNT_API_KEY` | Optional secure input for `--mode existing` | Provisioning-only account key; use a masked prompt or genuinely process-scoped secret, never a project dotenv file |
| `AGENTMAIL_API_KEY` | Always | AgentMail bearer key (`am_...`) |
| `AGENTMAIL_INBOX_ID` | Always | Inbox used for send and receive |
| `AGENTMAIL_INBOX_EMAIL` | Model-facing `agentMail` setup | Setup-verified canonical inbox address |
| `AGENTMAIL_WEBHOOK_SECRET` | Webhook mode, unless `secretEnv` changes | Svix signing secret (`whsec_...`) |

Prefer an inbox-scoped, least-privilege key. The exact AgentMail permissions
depend on the enabled send, receive, and live-subscription paths.

## State and Railway durability

Locally, one AgentMail instance retains the historical project-root layout. If
multiple instances are mounted, each instance's default ledger and JSON
sidecars are rooted under `data/agent-mail/<augment-name>/`. An explicit local
`dbPath` keeps its configured location, but it must remain unique to that
instance; sharing one AgentMail database across mounted instances is rejected.

Legacy singleton review and rate files cannot be assigned safely when a local
configuration expands to multiple mailboxes: review records do not contain
enough inbox ownership evidence. Startup fails closed with an explicit
migration error instead of guessing which mailbox owns an unsent or ambiguous
action. Reconcile or archive that state while running the prior single-instance
configuration before enabling multiple instances.

On Railway, AgentMail state is always rooted under:

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
- sender policy, configured rolling global/per-sender caps, rolling global
  usage, aggregate rejection counts, and the last rejection time;
- creator-digest state, pending metadata item count, bounded attempts, and last
  successful presentation;
- catch-up checkpoint, last catch-up summary, last inbound event, and last
  worker outcome;
- last provider error;
- outbound sent, blocked, rate-limited, pending-review, and ambiguous attempts;
- redacted recent dispatches and review rows;
- a conditional `/console/mail` action center with an explicit instance
  selector, metadata-only queues, and on-demand creator-authenticated details;
- test-send, cap adjustment, approve/revise/reject, ambiguous-send
  reconciliation, and versioned inbound-incident reconciliation actions.
  Inbound evidence is stored only as SHA-256; raw evidence is never written to
  the ledger.

The Console marks unrestricted sender admission explicitly. Its quota
diagnostics are metadata-only: they do not expose sender addresses, sender
hashes, subjects, or bodies. They are observational; change the YAML and
restart to adjust inbound limits.

## Common failures

| Symptom | Likely cause and fix |
| --- | --- |
| `AGENTMAIL_API_KEY is unresolved` | Set the variable in `.env` and restart |
| Inbox healthcheck returns 401/403 | Check the key, inbox ID, and provider permissions |
| Inbound config rejects its sender policy | Configure either a non-empty exact/domain `allowedSenders` list or `allowAnySender: true`, never both; use `allowAnySender` instead of `"*"` |
| Public inbound says rate limits are required | Set both `inbound.rateLimit.globalMaxPerHour` and `perSenderMaxPerHour`, with the per-sender value no greater than the global value, then restart |
| Inbound setup/runtime returns 403 | Rotate or replace the scoped key with `message_read`; processing spam/blocked also needs its matching label-read permission |
| Webhook mode says `webTransport` is required | Mount `webTransport` so the verified route can be served |
| Human review says the admin route is required | Enable `webTransport.adminRoute` or change review/allowed trust levels |
| A reply says the message was not delivered this turn | Reply only from the turn triggered by that inbound message |
| Inbound attention is at capacity | Resolve or dismiss creator-attention items; the exact message remains pending without consuming delivery attempts and resumes after capacity is available |
| Creator digest says outcome unknown | Do not retry or dismiss it; reconcile the exact Notify incident after independently verifying provider delivery |
| Creator digest attempts are exhausted | Inspect the destination, then authorize one evidence-bound retry or dismiss only the failed digest generation |
| Creator digest target changed | Restore the prior Notify binding or reconcile the pending digest before moving it; Auggy will not re-key and resend it blindly |
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
  [Console](https://console.agentmail.to),
  [permissions](https://docs.agentmail.to/permissions),
  [WebSockets](https://docs.agentmail.to/websockets), and
  [webhook verification](https://docs.agentmail.to/webhook-verification).

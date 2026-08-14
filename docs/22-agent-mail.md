# `agentMail` augment

`agentMail` connects one Auggy agent to one AgentMail inbox. AgentMail
stores the inbox, messages, threads, attachments, and drafts. Auggy adds
WebSocket wake-up, offline catch-up, authorization, limits, creator review, and
crash-safe delivery records.

Incoming email is always untrusted. A sender address—even an allowlisted or
provider-authenticated address—does not make that sender the creator.

## Set up the connection

Install the augment, then start its interactive setup:

```bash
auggy augment add agentMail
auggy augment setup agentMail
```

Choose one path:

| Setup choice | What Auggy does | Runtime key |
| --- | --- | --- |
| Create an AgentMail account | Creates the first account and inbox, then verifies the email OTP. | Saves the initial key returned by AgentMail. |
| Create a new inbox in an existing account | Creates an inbox with the account key you enter. | Saves that exact same key. |
| Manually connect an existing AgentMail inbox | Verifies the inbox ID and key you enter. | Saves that exact same key. |

Setup verifies the resulting connection and writes these values to the agent's
`.env`:

```dotenv
AGENTMAIL_API_KEY=am_your_existing_key
AGENTMAIL_INBOX_ID=store@agentmail.to
AGENTMAIL_INBOX_EMAIL=store@agentmail.to
```

Auggy never exchanges your selected key for a second, narrower runtime key and
never rotates or revokes it. If the values already exist, verify them with
`auggy augment setup agentMail --mode env`. Manual connection is also available
as `--mode manual`; the older `--mode connect` spelling remains an alias during
the `0.5.x` line. Setup performs read-only runtime checks; a missing
write permission is reported when the corresponding action is first used.

The generated baseline needs `inbox_read`, `message_read`, `draft_read`,
`message_send`, `draft_create`, `draft_update`, and `draft_send`. Add permissions
only when you enable their controls:

| Enabled control | Additional permission |
| --- | --- |
| Label mutation | `message_update` |
| Trash/restore | `message_update`, `label_trash_read` |
| Permanent deletion | `message_delete`, `draft_delete` |

An AgentMail key without a `permissions` object has full access inside its
scope. A key with a `permissions` object denies every omitted permission.

## Base configuration

This is the generated baseline. The verified creator can inspect mail and use
direct new-message, reply, and forward tools. Incoming wake-up and automatic
reply-draft creation remain off.

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: creator
  dbPath: ./data/agent-mail/agentMail/orchestration.db
  inbound:
    mode: none
  replies:
    mode: disabled
    allowReplyAll: false
  drafts:
    allowNew: false
    allowReply: false
    allowReplyAll: false
    allowForward: true
  outbound:
    allowedTrustLevels:
      - creator
    subjectPrefix: "[Auggy] "
    maxRecipients: 10
    bodyMaxBytes: 102400
    allowDirectDelivery: true
    rateLimit:
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000
```

| Key | Values | Description |
| --- | --- | --- |
| `apiKey` | Non-empty string; required | Exact runtime key. Keep it in `.env` and reference `${AGENTMAIL_API_KEY}`. |
| `inboxId` | AgentMail inbox ID; required | The one inbox Auggy reads and sends from. |
| `emailAddress` | Email address; optional | Expected canonical address. Auggy fails boot if AgentMail reports a different address. |
| `addressVisibility` | `creator` (default), `public` | Who may learn the address in model context. This does not enable inbound mail or trust senders. |
| `dbPath` | Non-empty path; default `./data/agent-mail/agentMail/orchestration.db` | SQLite orchestration ledger. Email and draft bodies remain in AgentMail. |
| `apiBaseUrl` | Absolute HTTPS URL; optional | Development/sandbox override for the AgentMail HTTP API. Normal use should omit it. Loopback HTTP is allowed for tests. |
| `websocketBaseUrl` | Absolute WSS URL; optional | Development/sandbox override for AgentMail WebSockets. Normal use should omit it. Loopback WS is allowed for tests. |
| `allowInsecureHttpWithCredentials` | `false` (default), `true` | Development-only override for credentialed, non-loopback HTTP/WS. It works only when `NODE_ENV=development`; production remains fail-closed. |
| `inbound.mode` | `none` (default), `websocket` | Whether incoming mail wakes Auggy. `websocket` also enables REST catch-up. |
| `replies.mode` | `disabled` (default), `review` | Whether an admitted email may produce a reply draft. It never authorizes sending. |
| `replies.allowReplyAll` | `false` (default), `true` | Whether an inbound reply draft may address the full thread. Requires `replies.mode: review`. |
| `drafts.allowNew` | `false` (default), `true` | Whether the creator may create or adopt new-message drafts. |
| `drafts.allowReply` | `false` (default), `true` | Whether the creator may create or adopt reply drafts outside inbound triage. |
| `drafts.allowReplyAll` | `false` (default), `true` | Whether creator-created drafts may reply-all. Requires `allowReply: true`. |
| `drafts.allowForward` | `true` in generated config | Enables forward drafts and direct forward when direct delivery is enabled. Validator default is `false` when omitted. |
| `outbound.allowDirectDelivery` | `true` in generated config | Enables direct new-message, reply, and forward tools. Validator default is `false` when omitted. |

## Receive email and review replies

Add these blocks to the base configuration to receive from any well-formed
sender and create provider-native reply drafts for review:

```yaml
config:
  inbound:
    mode: websocket
    allowAnySender: true
    rateLimit:
      globalMaxPerHour: 100
      perSenderMaxPerHour: 5
  replies:
    mode: review
    allowReplyAll: false
```

| New key | Values | Description |
| --- | --- | --- |
| `inbound.allowAnySender` | `false` (default), `true` | `true` admits any well-formed sender as public and anonymous. It cannot coexist with `allowedSenders`; `false` requires an allowlist when WebSocket inbound is enabled. |
| `inbound.allowedSenders` | 1–1000 exact emails or `*@domain` patterns | Alternative to `allowAnySender`. `*@example.com` matches that domain, not subdomains. Admission is not authentication. |
| `inbound.rateLimit.globalMaxPerHour` | Integer `1`–`100000`; default `100` | Maximum unique messages admitted across all senders in a rolling hour. |
| `inbound.rateLimit.perSenderMaxPerHour` | Integer `1`–`10000`; default `5` | Maximum unique messages admitted from one normalized sender in a rolling hour. |

At boot, reconnect, and once per minute, Auggy lists messages after its durable
checkpoint. Mail received while Auggy was offline is therefore processed after
startup. WebSocket and catch-up overlap is deduplicated before a turn runs.
Spam, blocked, and unauthenticated classifications are rejected. An inbound
turn receives bounded plain text and attachment metadata, never attachment
bytes, and cannot authorize a send.

When a reply is appropriate, Auggy creates the draft in AgentMail and waits:

```text
List my mail drafts.
Show draft <draft-id>.
Revise draft <draft-id> to say: Thanks — I will check and reply tomorrow.
Show draft <draft-id>.
Send draft <draft-id>.
```

You can instead use **Console → Mail → Open in AgentMail** to inspect, edit, and
send the same draft. Auggy stores only provider IDs, hashes, timestamps, and
recovery state—not the editable draft body. A new creator command is required
to send through Auggy.

## Adjust outbound sending

The generated baseline already allows creator-requested direct sends. Replace
its `outbound` block to change recipient scope, branding, or limits:

```yaml
config:
  outbound:
    allowedTrustLevels:
      - creator
    allowDirectDelivery: true
    allowedRecipients:
      - owner@example.com
      - "*@customers.example"
    subjectPrefix: "[Mikes Store] "
    maxRecipients: 10
    bodyMaxBytes: 102400
    rateLimit:
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000
```

Omit `allowedRecipients` to permit any well-formed address. Natural requests
such as `Send email to owner@example.com` work; the creator's wording is not an
authorization token. Runtime authorization uses verified creator identity, the
structured tool action and arguments, and this policy. The direct-send tool
accepts `to`, subject, and plain text. Direct reply and forward use exact source
message IDs:

```text
Reply to message <message-id>.
Forward message <message-id> to owner@example.com.
```

| New key | Values | Description |
| --- | --- | --- |
| `outbound.allowedTrustLevels` | Non-empty subset of `creator`, `agent`, `public`; default `[creator]` | Delivery policy must include `creator` for current creator-only tools to send. Other values validate for future/host policy but do not expose tools to those peers. Inbound email never satisfies this setting. |
| `outbound.allowDirectDelivery` | `true` in generated config; validator default `false` when omitted | Enables immediate new-message, reply, and forward tools. Set `false` for draft-only operation. |
| `outbound.allowedRecipients` | 1–1000 exact emails or `*@domain` patterns; optional | Recipient allowlist for new sends, direct replies/forwards, and draft sends. |
| `outbound.subjectPrefix` | 1–200 characters; default `[Auggy] ` | Prefix added to composed subjects. CR, LF, and NUL are rejected. |
| `outbound.maxRecipients` | Integer `1`–`50`; default `10` | Combined `to`, `cc`, and `bcc` cap where those fields are available. |
| `outbound.bodyMaxBytes` | Integer `1`–`1048576`; default `102400` | Combined UTF-8 text-plus-HTML body limit for sends and managed drafts. |
| `outbound.rateLimit.globalMaxPerHour` | Integer `1`–`10000`; default `10` | Combined direct and managed-draft sends per rolling hour. |
| `outbound.rateLimit.perRecipientCooldownMs` | Integer `0`–`2592000000`; default `300000` | Delay before another send to the same recipient. `0` disables it. |
| `outbound.rateLimit.dedupWindowMs` | Integer `0`–`2592000000`; default `300000` | Window that rejects an identical delivery payload. `0` disables it. |

## Use the inbox for visitor magic links

`visitorAuth` can use the same key and inbox for outbound magic links:

```yaml
# augments/visitorAuth/augment.yaml
type: visitorAuth
config:
  publicUrl: ${AUGGY_PUBLIC_URL}
  signingKey: ${VISITOR_SIGNING_KEY}
  agentMail:
    transport: agentmail
    apiKey: ${AGENTMAIL_API_KEY}
    inboxId: ${AGENTMAIL_INBOX_ID}
```

| Key | Values | Description |
| --- | --- | --- |
| `publicUrl` | Public HTTPS origin | Base URL placed in the magic link. The click returns to Auggy's verification route. |
| `signingKey` | Secret string | Signs visitor tokens. Keep it in `.env`. |
| `agentMail.transport` | `agentmail` | Sends the link through AgentMail. `console` is local-only. |
| `agentMail.apiKey` | Non-empty string | The exact key visitorAuth uses to send. It may reference the same environment value as `agentMail`. |
| `agentMail.inboxId` | AgentMail inbox ID | Inbox that sends the magic link. |

Run `auggy augment setup visitorAuth --mode env`, then restart. Magic-link
verification does not require inbound email: the visitor clicks an HTTP link
back to Auggy.

## Optional mailbox controls

Reads are bounded and creator-only. Mutations remain off until explicitly
enabled:

```yaml
config:
  mailbox:
    maxListResults: 50
    maxSearchQueryBytes: 1024
    allowLabelMutation: true
    allowedLabels:
      - needs-review
      - customer
    allowTrashRestore: true
    allowAttachmentAccess: true
    maxAttachmentBytes: 1048576
    allowedAttachmentTypes:
      - text/plain
      - text/csv
      - application/json
```

| Key | Values | Description |
| --- | --- | --- |
| `mailbox.maxListResults` | Integer `1`–`100`; default `50` | Maximum results returned by one mailbox tool call. |
| `mailbox.maxSearchQueryBytes` | Integer `1`–`8192`; default `1024` | Maximum UTF-8 search-query size. |
| `mailbox.allowLabelMutation` | `false` (default), `true` | Enables add/remove label tools. |
| `mailbox.allowedLabels` | 1–1000 non-system labels, each 1–128 characters | Required when label mutation is enabled. Each starts with a letter or number and then uses letters, numbers, `.`, `_`, `:`, `/`, or `-`. |
| `mailbox.allowTrashRestore` | `false` (default), `true` | Enables adding or removing AgentMail's `trash` label. |
| `mailbox.allowAttachmentAccess` | `false` (default), `true` | Enables bounded, just-in-time attachment reads. Bytes and signed URLs are not retained. |
| `mailbox.maxAttachmentBytes` | Integer `1`–`1048576`; default `1048576` | Maximum downloaded attachment size. |
| `mailbox.allowedAttachmentTypes` | Exact MIME types or bounded `type/*` patterns | Defaults to safe text, CSV, JSON, and XML types when access is enabled. `*/*` is rejected. |

## Optional draft and composition controls

Inbound reply drafts are controlled by `replies`. Creator-created or adopted
drafts use the separate `drafts` controls:

```yaml
config:
  drafts:
    allowNew: true
    allowReply: true
    allowReplyAll: false
    allowForward: true
  outbound:
    allowHtml: false
    maxAttachments: 2
    maxAttachmentBytes: 10485760
    maxTotalAttachmentBytes: 26214400
    allowedAttachmentTypes:
      - text/plain
      - application/pdf
```

| Key | Values | Description |
| --- | --- | --- |
| `drafts.allowNew` | `false` (default), `true` | Allows creator-created new provider drafts. |
| `drafts.allowReply` | `false` (default), `true` | Allows creator-created reply drafts and adoption of reply drafts. |
| `drafts.allowReplyAll` | `false` (default), `true` | Allows creator-created reply-all drafts. Requires `allowReply: true`. Direct reply-all is not exposed. |
| `drafts.allowForward` | `true` in generated config; validator default `false` when omitted | Allows forward drafts and direct forwarding when direct delivery is also enabled. |
| `outbound.allowHtml` | `false` (default), `true` | Permits HTML in managed draft creation/revision. Direct new-message tools remain plain-text. |
| `outbound.maxAttachments` | Integer `0`–`50`; default `0` | Maximum newly supplied draft attachments. Values above zero require an attachment-type allowlist. |
| `outbound.maxAttachmentBytes` | Integer `1`–`25165824`; default `10485760` | Maximum decoded size of one supplied attachment. |
| `outbound.maxTotalAttachmentBytes` | Integer `1`–`52428800`; default `26214400` | Maximum decoded size across supplied attachments. Must be at least the per-attachment limit. |
| `outbound.allowedAttachmentTypes` | Exact MIME types or bounded `type/*` patterns | Allowlist for supplied attachments. `*/*` is rejected. |

Auggy can create, adopt, show, revise, delete, and send allowed provider drafts.
It re-fetches the draft before mutations. If the provider revision or material
changes, review it again. Auggy cannot re-attest existing provider attachment
bytes before send, so drafts containing attachments must be sent in AgentMail.

Permanent message, thread, and draft deletion is a separate destructive gate:

```yaml
config:
  destructive:
    allowPermanentDelete: true
```

`allowPermanentDelete` defaults to `false`. Trash/restore is safer because it
changes a label instead of permanently deleting the provider object.

| Key | Values | Description |
| --- | --- | --- |
| `destructive.allowPermanentDelete` | `false` (default), `true` | Enables permanent message, thread, and managed-draft deletion for the verified creator. Tools must identify the exact object, and draft deletion requires its current provider revision. |

## Optional creator notifications

After configuring a named `notify` destination, add:

```yaml
config:
  notifications:
    destination: creator
    maxAttempts: 3
```

| Key | Values | Description |
| --- | --- | --- |
| `notifications.destination` | Existing Notify destination name, 1–128 characters | Receives content-free draft-ready and live delivery-failure notices. Surrounding whitespace and control characters are rejected. |
| `notifications.maxAttempts` | Integer `1`–`20`; default `3` | Maximum definitive Notify attempts. Ambiguous notification delivery is not retried blindly. |

Notifications require `inbound.mode: websocket`. A destination that sends back
into the monitored inbox is rejected to prevent a loop.

## Apply changes

After every YAML policy edit:

```bash
auggy doctor
auggy restart <agent-name>
```

Do not rerun setup unless the inbox or key changed. For a foreground process,
press Ctrl-C and run `auggy run` again.

## Recovery and limits

| Situation | Safe action |
| --- | --- |
| Provider returns `429` | Wait until the returned retry time, then ask Auggy to retry that operation ID. No magic wording is required. Auggy reuses the original request, operation, and idempotency key. |
| Send is `outcome_unknown` | Inspect AgentMail. Never retry blindly or create a fresh send. Use `reconcile delivery <operation-id> as sent` with provider IDs, or `... as not sent` only with explicit evidence. |
| Draft changed in AgentMail | Show it again. Prior review is invalidated. |
| Agent was offline | Start it. REST catch-up processes messages after the durable checkpoint. |
| Mail is present but no turn runs | Check `inbound.mode`, sender policy, limits, permissions, and **Console → Mail**, then restart. |
| Draft is scheduled in AgentMail | Inspect it in Auggy or AgentMail. Auggy does not create, change, cancel, or send scheduled drafts. |

Current boundaries:

- one live Auggy replica per logical inbox;
- WebSocket inbound plus REST catch-up; no webhook or polling mode;
- one inbound turn at a time with queue depth `100`;
- inbound body prompt capped at `64 KiB` and `25` attachment metadata items;
- no automatic reply sending;
- no Auggy scheduling or unscheduling; AgentMail remains authoritative for
  provider-scheduled drafts; and
- provider delivery failures missed while Auggy is offline cannot currently be
  replayed per message.

See [AgentMail permissions](https://www.agentmail.to/docs/permissions),
[WebSockets](https://www.agentmail.to/docs/websockets/quickstart),
[Drafts](https://www.agentmail.to/docs/drafts), and
[Idempotency](https://docs.agentmail.to/idempotency).

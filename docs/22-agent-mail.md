# `agentMail` augment

`agentMail` connects one Auggy agent to an existing AgentMail inbox.

Use it to:

- send new plain-text email;
- receive email over AgentMail WebSockets;
- wake the agent for admitted messages;
- create provider-native reply drafts; and
- review, revise, and send those drafts as the verified creator.

AgentMail remains the system of record for inboxes, messages, threads, and
draft bodies. Auggy owns admission, authorization, rate limits, wake-up,
review state, and crash recovery.

Inbound mail is off by default. A sender address never proves identity: every
admitted email starts as a public, anonymous peer.

## Quick start

This example sends email, receives from any well-formed sender, applies finite
rate limits, and requires creator review before an inbound reply is sent.

### 1. Create the AgentMail resources

In the [AgentMail Console](https://console.agentmail.to):

1. Create or choose an inbox.
2. Create an API key scoped to that inbox, pod, or organization.
3. Grant the permissions required by the policy below.

| Capability | Required AgentMail permissions |
| --- | --- |
| Send new email only | `inbox_read`, `message_send` |
| Receive email | add `message_read` |
| Create and review reply drafts | add `draft_read`, `draft_create`, `draft_update`, `draft_send` |

AgentMail keys without a `permissions` object have full access within their
scope. When a `permissions` object is present, it is a whitelist: omitted
permissions are denied. Prefer the narrowest scope and permissions that cover
the enabled features. See [AgentMail permissions](https://www.agentmail.to/docs/permissions).

### 2. Add and connect the augment

```bash
auggy augment add agentMail
auggy augment setup agentMail --mode connect
```

`connect` asks for the existing inbox ID and the exact API key Auggy should use
at runtime. Auggy verifies read access and the canonical inbox address, then
writes these values to the agent's `.env`:

```dotenv
AGENTMAIL_API_KEY=am_your_existing_key
AGENTMAIL_INBOX_ID=store@agentmail.to
AGENTMAIL_INBOX_EMAIL=store@agentmail.to
```

Auggy does not create an account, inbox, or another key. It does not
rotate, narrow, or revoke the supplied key.

If those values are already in the agent's `.env`, verify and reuse them:

```bash
auggy augment setup agentMail --mode env
```

Setup verifies configured read permissions without sending mail or creating a
draft. Required write permissions are exercised only when the corresponding
operation runs.

### 3. Use this complete configuration

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
    mode: websocket
    allowAnySender: true
    rateLimit:
      globalMaxPerHour: 100
      perSenderMaxPerHour: 5

  replies:
    mode: review
    allowReplyAll: false

  outbound:
    allowedTrustLevels:
      - creator
    subjectPrefix: "[Mikes Store] "
    maxRecipients: 10
    bodyMaxBytes: 102400
    rateLimit:
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000
```

Then validate and restart:

```bash
auggy doctor
auggy restart <agent-name>
```

Edit YAML and restart when policy changes. Setup does not need to run again
unless the inbox or key changes. `--mode env` is available as an optional,
read-only preflight after adding inbound or draft permissions.

## Base configuration

The generated outbound-only configuration is:

```yaml
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
  outbound:
    allowedTrustLevels:
      - creator
    subjectPrefix: "[Auggy] "
    maxRecipients: 10
    bodyMaxBytes: 102400
    rateLimit:
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000
```

All configuration changes below require an agent restart.

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | Non-empty string | Required | Exact AgentMail API key used by setup and runtime. Use `${AGENTMAIL_API_KEY}`. |
| `inboxId` | AgentMail inbox ID | Required | Inbox used for all reads, drafts, and sends. Use `${AGENTMAIL_INBOX_ID}`. |
| `emailAddress` | Email address | Omitted | Setup-verified canonical inbox address. On boot, a mismatch with AgentMail fails closed. Use `${AGENTMAIL_INBOX_EMAIL}`. |
| `addressVisibility` | `creator`, `public` | `creator` | Controls who may learn the inbox address through model context. It does not enable inbound mail or trust senders. |
| `dbPath` | Non-empty path | `./data/agent-mail/agentMail/orchestration.db` | SQLite ledger for checkpoints, operation identity, rates, and managed-draft references. Message and draft bodies stay in AgentMail. |
| `apiBaseUrl` | HTTPS URL, or loopback HTTP in development | AgentMail production API | Testing or sandbox override. Do not set for normal use. |
| `websocketBaseUrl` | WSS URL, or loopback WS in development | AgentMail production WebSocket endpoint | Testing or sandbox override. Do not set for normal use. |
| `allowInsecureHttpWithCredentials` | `true`, `false` | `false` | Development-only escape hatch for credentialed non-loopback HTTP/WS. Production remains fail-closed. |

## Receive email and review replies

Choose exactly one sender policy: `allowedSenders` or `allowAnySender: true`.

Open inbox with explicit limits:

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

Allowlisted inbox:

```yaml
config:
  inbound:
    mode: websocket
    allowedSenders:
      - owner@example.com
      - "*@customers.example"
    rateLimit:
      globalMaxPerHour: 100
      perSenderMaxPerHour: 5
  replies:
    mode: review
    allowReplyAll: false
```

`*@customers.example` matches that exact domain, not its subdomains.

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `inbound.mode` | `none`, `websocket` | `none` | `none` leaves incoming mail in AgentMail without Auggy processing. `websocket` enables live events plus REST catch-up. |
| `inbound.allowedSenders` | 1–1000 exact emails or `*@domain` patterns | Omitted | Admits matching senders. Mutually exclusive with `allowAnySender: true`. Admission does not raise sender trust. |
| `inbound.allowAnySender` | `true`, `false` | `false` | `true` admits any well-formed sender as public and anonymous. Use explicit finite rate limits. |
| `inbound.rateLimit.globalMaxPerHour` | Integer `1`–`100000` | `100` | Maximum unique messages admitted across all senders per rolling hour. |
| `inbound.rateLimit.perSenderMaxPerHour` | Integer `1`–`10000` | `5` | Maximum unique messages admitted from one normalized sender per rolling hour. |
| `replies.mode` | `disabled`, `review` | `disabled` | `review` lets an inbound turn create an AgentMail reply draft. It never sends automatically. |
| `replies.allowReplyAll` | `true`, `false` | `false` | Allows a reviewed reply draft to include the thread's other recipients. Requires `replies.mode: review`. |

When `websocket` is enabled, Auggy catches up from AgentMail at startup, after
reconnects, and during periodic repair. This covers messages received while the
agent was offline. WebSocket delivery is the wake-up path; the durable ledger
and AgentMail REST API provide deduplication and recovery.

Spam, blocked, and unauthenticated classifications are not admitted. Email
body content is untrusted input. Auggy loads bounded plain text and attachment
metadata, not attachment contents.

## Send new email

```yaml
config:
  outbound:
    allowedTrustLevels:
      - creator
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

Omit `allowedRecipients` to allow any well-formed recipient. The agent uses
`send_message` to send a new message immediately. `replies.mode: review`
applies only to replies created from inbound mail; it is not a review gate for
new outbound messages.

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `outbound.allowedTrustLevels` | Non-empty subset of `creator`, `agent`, `public` | `[creator]` | Trust levels allowed to request a new outbound message. Inbound email cannot authorize a new outbound send. |
| `outbound.allowedRecipients` | 1–1000 exact emails or `*@domain` patterns | Omitted | Optional recipient allowlist for both new messages and reviewed replies. |
| `outbound.subjectPrefix` | String, 1–200 characters; no CR, LF, or NUL | `[Auggy] ` | Prefix added to new outbound subjects and generated reply-draft subjects. |
| `outbound.maxRecipients` | Integer `1`–`50` | `10` | Maximum recipients for a send. The direct `send_message` tool currently accepts `to` recipients only. |
| `outbound.bodyMaxBytes` | Integer `1`–`1048576` | `102400` | Maximum UTF-8 plain-text body size for new messages and reviewed drafts. |
| `outbound.rateLimit.globalMaxPerHour` | Integer `1`–`10000` | `10` | Maximum combined new-message and reviewed-reply sends per rolling hour. |
| `outbound.rateLimit.perRecipientCooldownMs` | Integer `0`–`2592000000` | `300000` | Minimum time between new-message or reviewed-reply sends to the same normalized recipient. `0` disables the cooldown. |
| `outbound.rateLimit.dedupWindowMs` | Integer `0`–`2592000000` | `300000` | Window that rejects a duplicate new-message or reviewed-reply payload. `0` disables deduplication. |

Auggy sends plain text only. HTML composition, arbitrary attachments, forward
drafts, scheduled drafts, and recipient editing are not exposed by this
augment. Use AgentMail directly when those capabilities are needed.

## Notify the creator

Notifications are optional. They tell the creator that a reply draft is ready
or that an Auggy-managed delivery failure was observed. They do not contain the
email or draft body.

First install `notify` and configure a named destination. Then reference that
name from AgentMail:

Add this block under the `config` object from the complete example:

```yaml
config:
  notifications:
    destination: creator
    maxAttempts: 3
```

| Key | Values | Default | Description |
| --- | --- | --- | --- |
| `notifications.destination` | Existing Notify destination name, 1–128 characters | Required when `notifications` exists | Routes draft-ready and delivery-failure attention through that destination. The name must match `augments/notify/augment.yaml`. |
| `notifications.maxAttempts` | Integer `1`–`20` | `3` | Maximum definitive Notify delivery attempts. An ambiguous delivery is not retried automatically. |

Notifications require `inbound.mode: websocket`, because live provider events
drive draft-ready and delivery-failure attention. A Notify destination that
sends back into the monitored inbox is rejected to prevent a mail loop.
Startup catch-up recovers inbound messages and draft work. AgentMail does not
currently expose message-addressable replay for delivery lifecycle failures,
so creator delivery-failure alerts cover live observed events only.

## Review provider-native drafts

When an admitted message arrives:

1. Auggy wakes one untrusted inbound turn.
2. The agent triages the message.
3. If no reply is appropriate, it produces no draft.
4. Otherwise, Auggy creates a reply draft in AgentMail.
5. The draft waits for a new, explicit creator action.

The draft body lives in AgentMail. Auggy stores only the provider IDs, state,
timestamps, authorization evidence, and recovery metadata needed to manage it.
AgentMail deletes a provider draft after it is sent.

### Review with Auggy

Open **Console → Mail** to see inbox health and managed draft metadata. Then
open Chat and use direct language:

```text
List my mail drafts.
Show draft <draft-id>.
Revise draft <draft-id> to say: Thanks — I will check and reply tomorrow.
Show draft <draft-id>.
Send draft <draft-id>.
```

After showing a draft, `Send it` also works for that selected draft. Sending
always requires a fresh creator command. Public visitors, other agents, and
inbound email turns cannot list, inspect, revise, or send managed drafts.

Auggy re-reads the provider draft before revision and send. If it changed in
AgentMail, show it again before continuing. HTML drafts must be edited and sent
in AgentMail because Auggy revises plain text only.

### Review in AgentMail

From **Console → Mail**, select **Open in AgentMail**. Inspect, edit, and send
the same provider-native draft there. AgentMail remains authoritative.

## Use the inbox with `visitorAuth`

`visitorAuth` may share the same inbox and API key for outbound magic links:

```bash
auggy augment add visitorAuth
auggy augment setup visitorAuth --mode env
auggy restart <agent-name>
```

Magic-link verification returns through Auggy's public HTTP route, not inbound
email. `agentMail.inbound.mode` may remain `none` when the inbox is used only
for magic-link delivery. See [`visitorAuth`](./19-visitor-auth.md).

## Identity and security boundaries

- An email `From` address is data, not authentication. Allowlisted senders
  remain public and anonymous.
- `allowedSenders` and `allowAnySender` control admission only.
- `addressVisibility` controls address disclosure only.
- Inbound content cannot authorize a new outbound message.
- Reply drafts never send automatically. A verified creator must issue the
  send command.
- Outbound recipient, body-size, rate, cooldown, and dedup policies are checked
  again immediately before a managed draft is sent.
- One inbox may have only one inbound AgentMail ledger in an agent.
- The supported SQLite deployment is one process/replica per logical agent.
- Keep `AGENTMAIL_API_KEY` in `.env`; never place the literal key in YAML.

## Operational limits

| Area | Current behavior |
| --- | --- |
| Inbound mode | `none` or AgentMail WebSocket with REST catch-up; no webhook or polling mode |
| Inbound concurrency | One message turn at a time; transport queue depth `100` |
| Inbound prompt | Up to `64 KiB` of bounded plain text; at most `25` attachment metadata entries; attachment bodies are not loaded |
| Sender classes | Normal received mail only; spam, blocked, and unauthenticated classifications are rejected |
| New outbound mail | Plain text, `to` recipients only; no HTML or attachments |
| Managed replies | Provider-native reply drafts; optional reply-all; no automatic sending |
| Draft editing | Plain-text body only; edit recipients, HTML, attachments, forwards, or schedules in AgentMail |
| Persistence | SQLite stores orchestration metadata; AgentMail stores messages, threads, drafts, and bodies |

## Recovery and errors

Start with:

```bash
auggy doctor
```

Then inspect **Console → Mail** and AgentMail itself.

| Symptom | Meaning | Action |
| --- | --- | --- |
| Setup cannot verify `inbox_read` | The key is invalid, out of scope, or lacks inbox read access. | Check the key's scope, inbox ID, and permissions. Retry setup. |
| Setup fails on `message_read` or `draft_read` | The current YAML enables inbound or review but the key cannot perform the read-only preflight. | Grant the named permission to the same key, then retry `--mode env`. |
| Sending fails with `permission_missing` | Setup does not probe mutating permissions. | Grant `message_send`, or the required draft write/send permissions, to the configured key. |
| Mail is in AgentMail but Auggy does not react | Inbound is disabled, the sender was rejected, the rate limit was reached, or the WebSocket is degraded. | Confirm `inbound.mode: websocket`, sender policy, rate limits, key permissions, and **Console → Mail** status; then restart. |
| The agent was offline | Live wake-up could not run. | Start the agent. Startup catch-up reads messages after the durable checkpoint and schedules pending work. |
| No reply draft appears | Reply mode is disabled, the agent chose no reply, the message was rejected, or draft permission failed. | Check `replies.mode: review`, Console status, and AgentMail key permissions. |
| A draft changed | AgentMail's copy no longer matches Auggy's last observed timestamp. | Show the draft again before revising or sending. |
| Send outcome is unknown | The provider may have accepted the send before the connection failed. | Inspect AgentMail. Do not retry automatically. |
| Provider returns `429` | AgentMail's provider limit was reached. | Wait for the provider retry window; do not loosen Auggy's own limits reflexively. |
| Notification setup fails | The destination is missing, mismatched, or would send into the monitored inbox. | Fix the named Notify destination or remove `notifications`. |
| `agent.yaml` or YAML validation fails | A key is unknown, has the wrong type, or conflicts with another field. | Use the tables above, fix the config, rerun `auggy doctor`, and restart. |

Provider-side details are documented in [AgentMail WebSockets](https://www.agentmail.to/docs/websockets/quickstart),
[Drafts](https://www.agentmail.to/docs/drafts), and
[Permissions](https://www.agentmail.to/docs/permissions).

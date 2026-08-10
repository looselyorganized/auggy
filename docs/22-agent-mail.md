# `agentMail` augment

**Availability:** outbound email shipped before RC.5; the current hardened
inbound, reviewed-reply, digest, and multi-inbox action-center contract is in
the published `0.5.0-rc.8` candidate. Inbound remains an explicit opt-in.

`agentMail` gives an agent a policy-gated AgentMail inbox.

**What works by default:** after setup, the agent can send outbound email.
`visitorAuth` can use the same outbound connection to send magic links; magic
link verification does not require inbound email processing. AgentMail still
stores incoming messages in its own inbox, but Auggy does not read them, wake
the agent, propose replies, or let the agent use reply/forward successfully while
`inbound.mode: none` remains configured.

Receiving email is a separate, explicit opt-in. Configure the inbound policy
**before** provisioning credentials so setup can mint a runtime key with the
required permissions. Once enabled, admitted email can become normal Auggy
turns through polling, WebSocket, or verified webhook delivery. Every enabled
inbound mode also uses REST catch-up and a durable SQLite ledger, so a live
connection is never the only record of mail.

## When to use

Add `agentMail` when the agent itself needs to send or receive email. It is a
good fit for support inboxes, operational follow-up, and workflows where a
person replies by email and the reply should wake the agent.

Two related features have narrower jobs:

- `notify` sends outbound alerts to operator-configured destinations. Its
  AgentMail adapter is outbound-only and does not make email a conversation.
- `visitorAuth` sends magic links using outbound AgentMail access. It does not
  need inbound processing, and you do not need the `agentMail` augment just to
  send or redeem magic links. When both augments are installed, they can share
  one inbox and runtime key.

## Goal recipes

Choose the smallest recipe that matches what this agent should do. Setup scopes
the runtime key from the policy already stored in
`augments/agentMail/augment.yaml`; it does not automatically widen that key
afterward. In every recipe, save the YAML **before** running setup.

### Send email only

**Use this when:** the agent should compose new outbound messages but should
not read incoming mail.

**Prerequisite:** an AgentMail account, or an email address that can create one
through interactive `signup`.

```bash
auggy augment add agentMail --yes
```

Keep the generated file at this minimal policy:

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: none
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** the agent can use `send_message`. AgentMail stores incoming
mail, but Auggy does not read it; reply and forward tools cannot use it. Setup
mints `inbox_read` and `message_send` permissions.

**Restart and reprovision:** restart after setup. Changing policy while inbound
remains `none` needs only a restart. Enabling inbound later requires a new
runtime key; follow
[Replace runtime credentials safely](#replace-runtime-credentials-safely).

### Send `visitorAuth` magic links through the shared inbox

**Use this when:** one agent needs both ordinary outbound AgentMail and
production `visitorAuth` magic links. Receiving and redeeming a magic link does
not require inbound email processing.

**Prerequisites:** `webTransport` is configured with the agent's public URL,
and `AUGGY_PUBLIC_URL` points at that reachable HTTPS deployment.

```bash
auggy augment add agentMail visitorAuth --yes
```

Keep `agentMail` outbound-only and configure `visitorAuth` to reuse its local
credentials:

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: none
```

```yaml
# augments/visitorAuth/augment.yaml
type: visitorAuth
config:
  publicUrl: ${AUGGY_PUBLIC_URL}
  dbPath: ./visitor-auth.db
  agentMail:
    transport: agentmail
    apiKey: ${AGENTMAIL_API_KEY}
    inboxId: ${AGENTMAIL_INBOX_ID}
    subjectPrefix: "[Verify] "
  signingKey: ${VISITOR_SIGNING_KEY}
  agentBinding: ${AUGGY_AGENT_ID}
```

```bash
auggy agentmail setup agentMail
auggy agentmail setup visitorAuth --mode env
auggy restart <agent-name>
```

**Expected result:** both augments use one inbox-scoped runtime key.
`visitorAuth` sends magic links; clicking a link reaches Auggy over HTTPS and
does not create an inbound AgentMail turn.

**Restart and reprovision:** restart after both setup steps succeed. Attaching
`visitorAuth` with `--mode env` does not require a new key. If `agentMail` will
also receive mail, start from an inbound recipe below before the first setup.

### Receive allowlisted email over WebSocket, with replies disabled

**Use this when:** known people or exact trusted domains should be able to wake
the agent, but the agent must not send a reply from an inbound turn.

**Prerequisite:** decide the exact sender addresses or domains. A pattern such
as `*@trusted.example` matches only that domain, not its subdomains.

```bash
auggy augment add agentMail --yes
```

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: websocket
    allowedSenders:
      - operator@example.com
      - "*@trusted.example"
    replies:
      mode: disabled
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** admitted messages become Auggy turns. Other senders are
discarded before a model turn. The agent cannot propose, approve, or send a
reply from those turns. Setup adds `message_read` to the runtime key.

**Restart and reprovision:** restart after setup and after later policy edits.
Changing sender patterns does not need a new key. Enabling this recipe after
outbound-only setup does; use the credential-replacement procedure.

### Receive email from anyone, with bounded admission

**Use this when:** the inbox address is intentionally open to any well-formed
sender. The limits bound Auggy's model-processing load; AgentMail may still
accept and store mail above them.

**Prerequisite:** choose finite global and per-sender hourly limits. The
per-sender limit cannot exceed the global limit.

```bash
auggy augment add agentMail --yes
```

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: websocket
    allowAnySender: true
    rateLimit:
      globalMaxPerHour: 100
      perSenderMaxPerHour: 5
    replies:
      mode: disabled
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** any well-formed sender may create a turn until either
rolling hourly limit is reached. Rate-limited mail remains in AgentMail but
does not create an Auggy turn.

**Restart and reprovision:** restart after setup and policy edits. The initial
inbound setup needs `message_read`; changing only the limits does not require a
new runtime key.

### Receive email through a verified webhook

**Use this when:** the agent has a stable public HTTPS URL and should receive
low-latency callbacks. Auggy also runs REST catch-up, so the callback is not the
only recovery path.

**Prerequisites:** install `webTransport`, expose it over HTTPS, and generate a
strong secret in `AGENTMAIL_WEBHOOK_SECRET`. Configure the same callback path
and signing secret in AgentMail.

```bash
auggy augment add webTransport agentMail --yes
```

```yaml
# agent.yaml (relevant mounts)
augments:
  - webTransport
  - agentMail
```

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: webhook
    allowedSenders:
      - operator@example.com
    replies:
      mode: disabled
    webhook:
      path: /webhooks/agentmail
      secretEnv: AGENTMAIL_WEBHOOK_SECRET
      timestampToleranceSeconds: 300
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** a correctly signed callback at
`/webhooks/agentmail` is admitted once; invalid signatures and disallowed
senders do not create turns.

**Restart and reprovision:** restart after setup, route, secret, or policy
changes. Switching from another enabled inbound mode does not need a new key.
Switching from `none` does.

### Require creator review before replying

**Use this when:** admitted email should wake the agent and let it draft one
reply, but a creator must approve that proposal in Auggy Console before it is
sent.

**Prerequisites:** `webTransport` must be installed with its Console/admin route
enabled. The AgentMail provider inbox and Auggy's reply-review queue are
different surfaces.

```bash
auggy augment add webTransport agentMail --yes
```

```yaml
# agent.yaml (relevant mounts)
augments:
  - webTransport
  - agentMail
```

```yaml
# augments/webTransport/augment.yaml (relevant option)
type: webTransport
config:
  port: 8080
  adminRoute: true
  auth:
    type: bearer
    token: ${AUGGY_WEB_TOKEN}
```

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: websocket
    allowedSenders:
      - operator@example.com
    replies:
      mode: review
      allowReplyAll: false
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** `reply_to_message` creates a durable Auggy reply proposal.
The creator approves or rejects it in Console → Mail; the proposal is not a
provider-native AgentMail draft.

**Restart and reprovision:** restart after setup or reply-policy changes.
Changing `disabled` to `review` while inbound is already enabled does not need
a new key.

### Send automatic replies within a hard hourly cap

**Use this when:** trusted admitted senders may receive an immediate reply
without creator approval. Sensitive output or a Reply-To address that differs
from From still falls back to review.

**Prerequisites:** `webTransport` with its Console/admin route enabled is still
required for fallback review and reconciliation. Choose an outbound global cap
between 1 and 100 per hour.

```bash
auggy augment add webTransport agentMail --yes
```

Keep the generated `webTransport` file with `adminRoute: true`, as shown in the
reviewed-reply recipe above.

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  outbound:
    rateLimit:
      enabled: true
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
      dedupWindowMs: 300000
  inbound:
    mode: websocket
    allowedSenders:
      - operator@example.com
    replies:
      mode: automatic
      allowReplyAll: false
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** the exact admitted inbound turn may send one reply within
the durable cap. Token-shaped content or a different Reply-To address falls
back to creator review instead of sending automatically.

**Restart and reprovision:** restart after setup and reply/rate-limit edits.
Changing from reviewed to automatic replies does not require a new key while
inbound remains enabled.

### Send a creator digest for outstanding mail work

**Use this when:** the creator should receive a periodic metadata-only summary
of open, pending-review, ambiguous, or quarantined mail. This does not include
message content and does not enable inbound by itself.

**Prerequisites:** install `notify` and configure exactly one matching
creator-authorized destination with a positive durable quota. This example
uses Notify's generated local JSONL destination.

```bash
auggy augment add agentMail notify --yes
```

```yaml
# agent.yaml (relevant mounts)
augments:
  - agentMail
  - notify
```

```yaml
# augments/notify/augment.yaml
type: notify
config:
  destinations:
    - name: creator
      transport: log-to-file
      path: ./notifications.jsonl
      allowedTrustLevels: [creator]
  rateLimit:
    globalMaxPerHour: 5
```

```yaml
# augments/agentMail/augment.yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
  addressVisibility: public
  inbound:
    mode: websocket
    allowedSenders:
      - operator@example.com
    replies:
      mode: disabled
    creatorDigest:
      enabled: true
      destination: creator
      intervalMs: 900000
      maxItems: 20
      maxAttempts: 5
```

```bash
auggy agentmail setup agentMail
auggy restart <agent-name>
```

**Expected result:** every 15 minutes, outstanding mail state may produce one
bounded summary in `notifications.jsonl`. The digest contains counts and state,
not sender, subject, body, message IDs, or provider errors.

**Restart and reprovision:** restart after setup or digest/Notify policy
changes. Enabling a digest does not change AgentMail key permissions, but its
inbound mode does.

### Command names

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

If both canonical augments are new and outbound-only behavior is sufficient,
the shortest safe path is one interactive add:

```bash
auggy augment add agentMail visitorAuth
```

The post-add flow uses one shared setup confirmation and one provider-credential
and provisioning flow. It provisions `agentMail` first, then attaches
`visitorAuth` with `--mode env` without asking for credentials again. This is
true regardless of argument or picker order. It prints start/restart guidance
only after both steps succeed. If an accepted setup fails, the command exits
nonzero, leaves the installed files in place, and tells you to finish setup or
remove the unresolved augment before restarting. `--yes` skips optional
post-add setup rather than provisioning non-interactively.

That combined interactive flow provisions from the generated outbound-only
policy. If `agentMail` should receive email, instead run the combined add with
`--yes`, configure `augments/agentMail/augment.yaml`, then set up `agentMail`
before attaching `visitorAuth` with `--mode env`.

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
agent. Use `--mode env` to reuse the values in `.env`; Auggy verifies the inbox
identity and reachability, not the key's permission scope, and does not add
permissions. `manual` likewise stores the runtime key supplied by the operator
without widening or verifying its permission scope.

### Replace runtime credentials safely

Use this procedure when enabling inbound after outbound-only setup, enabling
spam/blocked processing, moving to another inbox, or otherwise replacing the
runtime key:

1. Stop the agent so the old key cannot remain active during replacement.
2. Save the intended policy in `augments/agentMail/augment.yaml`. Setup reads
   this file to determine the least-privilege permission set.
3. In AgentMail, revoke the old inbox-scoped runtime key. Do not delete the
   inbox.
4. Remove every `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, and
   `AGENTMAIL_INBOX_EMAIL` entry from the agent's `.env`.
5. Remove exported copies from the current shell:

   ```bash
   unset AGENTMAIL_API_KEY AGENTMAIL_INBOX_ID AGENTMAIL_INBOX_EMAIL
   ```

6. Run `auggy agentmail setup agentMail` and choose `existing` to mint a
   correctly scoped replacement key in an existing AgentMail account. Use
   `signup` only when creating the person's first AgentMail account and inbox.
   Choose `manual` only if you already created a replacement key with every
   permission required by the saved policy.
7. Confirm setup reports the expected permissions, then restart the agent.

Revoke before deleting local credentials so the retired provider key is not
orphaned. If `AGENTMAIL_*` values remain in either `.env` or the process
environment, automatic setup fails closed rather than replacing them.

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
AgentMail inbox and runtime key. Configure the complete `agentMail` policy
first, then set up `agentMail` so the minted key includes every permission that
policy requires. Finally, attach `visitorAuth` to those local credentials:

```bash
auggy augment add agentMail visitorAuth --yes
# For inbound use, edit augments/agentMail/augment.yaml now.
auggy agentmail setup agentMail
auggy agentmail setup visitorAuth --mode env
```

Reversing this order fails closed instead of replacing shared credentials with
a key that may be too narrow for `agentMail`. `visitorAuth --mode env` reuses
the existing inbox and runtime key; it does not widen them. Custom, inline,
additional, or multiple AgentMail consumers must be assigned credentials
manually rather than passing through this shared singleton setup path.

An interactive `auggy augment add agentMail visitorAuth` performs the two setup
steps through one confirmation and credential flow for the generated
outbound-only policy. The explicit `--yes` sequence above is required when
inbound policy must be saved before provisioning. It is also the recovery path
for standalone adds, skipped setup, automation, or a partial post-add failure.

### What changes require setup again?

| Change | Restart | New runtime key |
| --- | --- | --- |
| Sender allowlist, bounded inbound rates, reply mode, polling interval, or other policy-only setting while inbound remains enabled | Yes | No |
| `inbound.mode: none` to any enabled mode | Yes | Yes: add `message_read` |
| Change spam or blocked classification from `discard` to `process` | Yes | Yes: add the matching label-read permission |
| Change between polling, WebSocket, and webhook while inbound remains enabled | Yes | No; webhook also requires its secret and `webTransport` |
| Disable inbound | Yes | Not required to boot, but rotate if least privilege requires removing `message_read` |
| Add `visitorAuth` to a correctly scoped `agentMail` inbox | Yes | No; attach with `--mode env` |
| Change inbox or replace/revoke its runtime key | Yes | Yes |

Editing YAML never changes provider permissions. When the table requires a new
key, save the YAML first and use the replacement procedure above.

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

## Where to read mail and review replies

Use the two consoles for different jobs:

| Surface | Use it for |
| --- | --- |
| AgentMail | Reading the inbox, browsing threads and sent mail, and managing drafts created in AgentMail |
| Auggy Console → Mail | Reviewing send, reply, and forward actions proposed by the agent; checking inbound status and limits; and resolving mail actions whose outcome is uncertain |

Auggy Console is not a second inbox. It shows only the AgentMail work that
needs an Auggy operator decision or status check. AgentMail remains the place
to read the complete mailbox.

The **Mail** navigation item appears only when the currently running agent has
the `agentMail` augment mounted and reports a supported Mail view. It does not
appear merely because:

- `visitorAuth` uses AgentMail to send magic links;
- `notify` has an outbound AgentMail destination;
- an AgentMail inbox exists at the provider; or
- `agentMail` was added to the project but the running agent has not been
  restarted.

If `agentMail` is mounted but **Mail** is missing, confirm `webTransport` is
serving the Console with its admin route enabled, restart the agent, reload the
dashboard, and confirm the AgentMail capability is present. A still-missing
item means the running runtime did not return a usable Mail view; inspect its
startup and AgentMail status errors before relying on Console review.

**Open in AgentMail** appears for the selected mailbox in Auggy's Mail view and
on its Capabilities card. It opens AgentMail's console in a new tab so you can
read the inbox. AgentMail does not provide Auggy with a stable link directly to
one inbox, so use the inbox address or ID shown in Auggy to select the matching
mailbox there. It does not sign you into AgentMail or select an inbox for you.
The link never includes an API key, Auggy Console token, message content, or
review content.

### A reply proposal is not an AgentMail draft

When an admitted email wakes the agent, the agent may propose a reply. With
`inbound.replies.mode: review`, that proposal waits in **Auggy Console → Mail**
until a creator approves, edits and sends, or rejects it. Nothing is sent to
AgentMail for that proposed reply before approval.

That proposal is stored by Auggy and does not appear in AgentMail's drafts.
Likewise, a draft created in AgentMail does not become an Auggy review item.
This separation keeps Auggy's authorization, recipient checks, rate limits,
and approval decision attached to the exact proposed action. After approval,
Auggy asks AgentMail to send the message; the sent message then belongs to the
AgentMail thread and sent history.

## Configuration

Inbound is disabled by default. Enabling it requires exactly one sender policy:
a non-empty `allowedSenders` list, or the explicit public-inbox switch
`allowAnySender: true`. Configuring both is rejected. Exact addresses and
`*@domain` patterns are compared case insensitively. Patterns must be canonical
email/domain forms; broad or partial wildcards such as `*` and `foo*` remain
invalid. Use `allowAnySender: true` when every well-formed sender should be
eligible. A domain pattern matches that exact domain, not its subdomains.

The goal recipes above are the copyable configurations. Start with one recipe
and add only fields whose behavior you need; combining every optional block at
once makes permission changes and security consequences harder to review.

### Complete configuration reference

Every YAML change below takes effect after an agent restart. The **New key**
column calls out the smaller set of changes that also require a replacement
inbox-scoped AgentMail key. Save the intended YAML before provisioning a new
key so setup can calculate its least-privilege permissions.

#### Top-level `config`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `apiKey` | Non-empty string; normally `${AGENTMAIL_API_KEY}` | Required inbox-scoped runtime key | The changed value is the replacement key; restart after changing it |
| `inboxId` | Non-empty string; normally `${AGENTMAIL_INBOX_ID}` | Required | Yes when moving to another inbox; the key must authorize that inbox |
| `emailAddress` | Well-formed email address; normally `${AGENTMAIL_INBOX_EMAIL}` | Optional in the factory, but setup records the provider-verified canonical address | No permission change; rerun setup rather than editing it when moving inboxes |
| `addressVisibility` | `creator` or `public` | `creator` | No |
| `apiBaseUrl` | AgentMail API URL string | AgentMail's production API; override only for a test or sandbox provider | No scope change, but the credentials must be valid for the selected provider |
| `allowInsecureHttpWithCredentials` | Boolean | `false`; non-loopback plaintext also requires `NODE_ENV=development` | No |
| `dbPath` | Non-empty SQLite path | `./agent-mail.db` for one local instance; deployment and multi-instance resolution may namespace it | No; stop the agent and migrate durable state before changing it |
| `outbound` | Object; fields are listed below | `{}` with the strict outbound defaults below | No |
| `inbound` | Object; fields are listed below | Omitted is equivalent to `mode: none` | Yes only when moving from `none` to an enabled mode, or when a classification adds a provider permission |

`agentDir` also exists on the programmatic factory type, but the CLI resolver
owns and supplies it. Do not put `agentDir` in `augment.yaml`.

#### `outbound`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `allowedTrustLevels` | Array containing `creator`, `agent`, or `public` | `[creator]`; creator-originated calls remain permitted | No |
| `allowedRecipients` | Array of exact addresses or exact-domain patterns such as `*@example.com` | Omitted allows any well-formed recipient; matching is case-insensitive and does not include subdomains | No |
| `maxRecipients` | Positive safe integer; the provider hard ceiling is always 50 | `10`; values above 50 are effectively capped at 50 | No |
| `bodyMaxBytes` | Safe integer from 1 through 1,048,576; counts text and HTML together | `102400` (100 KiB) | No |
| `allowHtml` | Boolean | `false` | No |
| `subjectPrefix` | Non-empty string | `[Auggy] `; the final normalized subject may contain at most 1,000 characters | No |
| `rateLimit` | Object; fields are listed below | Enabled with the defaults below | No |
| `humanReview` | Object; fields are listed below | Public-trust outbound actions require review | No |

`public` in `outbound.allowedTrustLevels` is an authorization class for a
public or anonymous peer. It does not publish the inbox address or open inbound
sender admission.

#### `outbound.rateLimit` and `outbound.humanReview`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `rateLimit.enabled` | Boolean | `true` | No |
| `rateLimit.globalMaxPerHour` | Non-negative number under YAML validation | `10`; automatic inbound replies impose the stricter effective requirement of a safe integer from 1 through 100 | No |
| `rateLimit.perRecipientCooldownMs` | Non-negative number | `300000` (5 minutes) | No |
| `rateLimit.dedupWindowMs` | Non-negative number | `300000` (5 minutes); `0` disables subject-hash deduplication | No |
| `humanReview.requiredForTrustLevels` | Array containing `creator`, `agent`, or `public`; an empty array explicitly disables this review gate | `[public]` | No |
| `humanReview.expiresAfterMs` | Safe integer from 1 through 2,592,000,000 | `86400000` (24 hours) | No |

Outbound rate fields intentionally have no general parser-enforced upper
bounds beyond the automatic-reply rule above. Use finite operational values;
do not interpret parser acceptance as a recommended capacity. Any executable
trust level covered by `requiredForTrustLevels` requires `webTransport` with
`adminRoute: true` so a creator can decide the review.

#### `inbound` delivery and sender admission

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `mode` | `none`, `polling`, `websocket`, or `webhook` | Required when the block is present; omit the block to use `none` | Yes for `none` to any enabled mode (`message_read`); no between enabled modes; rotate after disabling if least privilege should remove `message_read` |
| `allowedSenders` | 1–1,000 unique exact addresses or exact-domain patterns such as `*@example.com`; case-insensitive, no surrounding whitespace, control characters, bare `*`, partial wildcard, or subdomain expansion | Exactly one sender policy is required when inbound is enabled | No |
| `allowAnySender` | Boolean | Omitted; `true` requires `rateLimit` and cannot coexist with `allowedSenders` (even as `false`) | No |
| `rateLimit.globalMaxPerHour` | Safe integer from 1 through 10,000 | Both inbound rate fields are required when the block is present and the block is required with `allowAnySender: true` | No |
| `rateLimit.perSenderMaxPerHour` | Safe integer from 1 through 1,000 and no greater than the global limit | Required with `rateLimit.globalMaxPerHour` | No |
| `pollIntervalMs` | Safe integer from 1,000 through 86,400,000 | `60000` (60 seconds); also controls REST reconciliation for enabled live modes | No |
| `maxPromptBytes` | Safe integer from 512 through 1,048,576 | `102400` (100 KiB) | No |
| `maxAttempts` | Safe integer from 1 through 20 | `5` | No |
| `websocketBaseUrl` | `ws://` or `wss://` URL without embedded credentials | AgentMail's production WebSocket origin; sandbox override only | No |
| `classifications` | Object; fields are listed below | Ordinary received mail is processed and restricted classifications are discarded | Sometimes; see below |
| `replies` | Object; fields are listed below | `disabled` with `mode: none`, otherwise `review` | No |
| `webhook` | Object; fields are listed below | Required only with `mode: webhook`; rejected in other modes | No |
| `creatorDigest` | Object; fields are listed below | Disabled | No |

`allowAnySender: true` makes the inbox open to any well-formed sender at
Auggy's local admission boundary. It does not change address visibility and it
does not upgrade an admitted sender's trust.

#### `inbound.classifications` and `inbound.replies`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `classifications.received` | `process` or `discard` | `process` | No |
| `classifications.spam` | `process` or `discard` | `discard` | Yes when changed to `process` (`label_spam_read`) |
| `classifications.blocked` | `process` or `discard` | `discard` | Yes when changed to `process` (`label_blocked_read`) |
| `classifications.unauthenticated` | `process` or `discard` | `discard` | No additional provider permission beyond enabled inbound |
| `replies.mode` | `disabled`, `review`, or `automatic` | `disabled` when inbound is `none`; `review` when inbound is enabled | No |
| `replies.allowReplyAll` | Boolean | `false`; cannot be `true` when replies are disabled | No |

At least one classification must remain `process` when inbound is enabled.
Any enabled reply mode requires durable review storage and `webTransport` with
`adminRoute: true`. `automatic` also requires
`outbound.rateLimit.enabled: true` and an effective
`outbound.rateLimit.globalMaxPerHour` safe integer from 1 through 100. Sensitive
content and a Reply-To address that differs from From still fall back to
creator review. Reply-all remains subject to the outbound recipient allowlist
and recipient cap.

#### `inbound.webhook`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `path` | String beginning with `/` | `/webhooks/agentmail` for the legacy singleton; `/webhooks/agentmail/<augment-name>` for a named multi-inbox instance | No |
| `secretEnv` | Non-empty environment-variable name | `AGENTMAIL_WEBHOOK_SECRET` | No; update the provider callback secret and restart Auggy together |
| `timestampToleranceSeconds` | Finite number greater than 0 and at most 300 | `300` | No |

Webhook mode requires `webTransport`, a stable HTTPS deployment, and the same
callback path and Svix secret on both sides. The secret is not required for
outbound, polling, or WebSocket use.

#### `inbound.creatorDigest`

| Field | Type and allowed values | Default or requirement | New key |
| --- | --- | --- | --- |
| `enabled` | Boolean | `false`; cannot be enabled with `inbound.mode: none` | No |
| `destination` | Trimmed Notify destination name, 1–128 characters, with no control characters | Required when enabled; must uniquely match a Notify destination that permits creator trust and has a positive durable quota | No |
| `intervalMs` | Safe integer from 60,000 through 86,400,000 | `900000` (15 minutes) | No |
| `maxItems` | Safe integer from 1 through 100 | `20` | No |
| `maxAttempts` | Safe integer from 1 through 20 | `5` | No |

The three similarly named public controls are independent:

| Control | Meaning |
| --- | --- |
| `addressVisibility: public` | The model may tell a contextually appropriate peer the canonical inbox address |
| `inbound.allowAnySender: true` | Any well-formed sender may reach inbound admission, subject to the required quotas |
| Trust level `public` | The runtime identity and authorization class assigned to anonymous/public peers, including admitted email senders |

None of these controls implies either of the others. In particular, sender
allowlisting is admission policy, not authentication; admitted email remains
`public` + `anonymous` unless another explicit runtime boundary establishes a
different identity.

### Advanced policy and runtime behavior

For a deliberately open inbox, `100` globally and `5` per sender is the
recommended starting posture. `globalMaxPerHour` accepts 1–10,000,
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

| Mode | How Auggy receives email | Recovery behavior | Use it when |
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

The tools have intentionally different scopes:

| Tool | What the agent can do | Where it can be used |
| --- | --- | --- |
| `send_message` | Start a new email to allowed recipients with a subject and plain-text body; HTML and labels are optional when policy permits them | Any turn whose trust level and outbound policy allow sending |
| `reply_to_message` | Reply in the thread of the email that started this turn; `replyAll` is optional and separately controlled | Only the turn triggered by that incoming email |
| `forward_message` | Forward the email that started this turn to allowed recipients, optionally with an introduction or subject override | Only the turn triggered by that incoming email |

When an incoming email starts a turn, Auggy gives that turn an internal
reference to that one email. The model supplies that reference as `messageId`
when it calls `reply_to_message` or `forward_message`; users do not need to find,
copy, or type it. Auggy rejects references to a different email, references
copied into a later turn, and IDs merely written in a prompt. In practical
terms, the agent can reply to or forward the email it is handling now, but it
cannot use these tools to browse the inbox, fetch an older thread, or act on an
arbitrary message.

For a reply, Auggy uses the trusted sender and Reply-To information captured
with that incoming email. Reply-all also removes the agent's own verified inbox
address and must be enabled by policy. Reply mode does not authorize forwarding:
the operator's normal outbound trust, recipient, rate, and review policy applies.
Inbound email runs as public trust while outbound defaults to creator-only, so
forwarding from an inbound turn is blocked by default until the operator
explicitly authorizes public outbound actions.

All three tools return `sent`, `pending_review`, `rate_limited`, or `failed`.
`pending_review` means the proposed action is waiting in **Auggy Console →
Mail**; it is not an AgentMail draft.

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

## Verify a normal setup

These checks verify one operator's normal setup. They are not the release
canary or an advanced durability certification.

1. Start or restart the agent and confirm startup does not report an
   AgentMail configuration, credential, or health error.
2. Open **Console → Capabilities → agentMail** and confirm it shows the expected
   inbox address and a healthy outbound connection.
3. Use **Test send** to send one message to an address you control. Confirm it
   appears in AgentMail's sent mail and arrives once.
4. If inbound is enabled, reply from a sender admitted by the saved policy.
   Confirm the message appears in AgentMail and creates one Auggy mail item or
   turn. With reply review enabled, confirm any proposed reply waits in
   **Console → Mail** and is not present in AgentMail drafts.

Stop after the checks that apply to your recipe. Provider canaries, quota
exhaustion, duplicate delivery, restart recovery, multi-inbox isolation,
ambiguous-send reconciliation, and Railway volume recovery are advanced
operational or release-certification checks. Run those against a disposable
inbox and deployment, not as part of first-time setup.

## Common failures

Setup commits local credentials atomically. A failed setup does not partially
rewrite `.env` or an augment file, but `auggy augment add` intentionally leaves
the installed augment files in place so the operator can retry setup or remove
the unresolved augment. A provider request may already have created an inbox
or scoped key before a timeout or response-validation failure; the entries
below call out those cases.

| Symptom | Cause | Safe fix | What changed |
| --- | --- | --- | --- |
| `Unknown augment "agentmail"` or setup says lowercase `agentmail` is unsupported | The installed CLI predates case-insensitive built-in resolution. Current builds accept `agentmail` and canonicalize it to `agentMail`. | Check `auggy --version`, install the current candidate, then rerun `auggy augment add agentMail` or `auggy agentmail setup agentMail`. | The rejected command changes nothing. |
| `missing required argument 'target'` or setup asks which target to use | Both `agentMail` and `visitorAuth` are installed, so Auggy will not guess which policy owns setup. | Run `auggy agentmail setup agentMail`; after it succeeds, run `auggy agentmail setup visitorAuth --mode env` to reuse the same credentials. | The rejected command changes nothing. |
| The combined add asks for AgentMail credentials twice | An older CLI ran two independent post-add setup flows, or the augments were set up separately in the wrong order. | Upgrade first. For a new outbound-only install, run one interactive `auggy augment add agentMail visitorAuth`. For recovery or inbound use, configure `agentMail`, set it up once, then attach `visitorAuth` with `--mode env`. | Installed augment files may already exist. Failed setup does not write new local credentials; inspect AgentMail for resources created by an earlier successful prompt. |
| Signup returns `403 already_exists` and says the human already has an AgentMail account | `signup` is only for a person's first AgentMail account. | Continue with or rerun `auggy agentmail setup agentMail --mode existing`, then provide an **account** API key. | The rejected request changes no provider resource and writes no local credentials. |
| Signup OTP is cancelled, rejected three times, or expires | Signup created the owner-verification challenge but verification did not finish. | Sign into AgentMail, create an account API key, then continue with `--mode existing`; do not repeat signup blindly. | The account and first inbox may exist. No scoped runtime key or local credentials were created. |
| Inbox creation returns `400 validation_error` for `client_id` | The installed CLI is from the pre-fix RC that sent a provider-invalid idempotency identity. This is not caused by the API key or inbox username. | Upgrade the CLI, confirm `auggy --version`, and rerun setup. Do not keep changing keys or usernames to work around it. | Provider validation rejects the create request, so no inbox is created by that request and local credentials remain unchanged. The augment files installed before setup remain. |
| Inbox creation returns `403 resource_taken` or repeatedly says an address is taken | AgentMail inbox addresses are globally unique. The requested address may belong to another account; it will not necessarily appear in the current account's inbox list. | Accept a different username, or use `--mode manual` only when you already own the exact inbox and have its scoped runtime key. Adopt a collision only when Auggy proves the address and compatible `client_id` match and asks for confirmation. | A collision does not create, adopt, overwrite, or delete an inbox. Local credentials remain unchanged. Earlier successful setup attempts or provider resources are separate and must be inspected directly. |
| Inbox creation returns a definite `401`, `403`, `409`, or `429` | The account key lacks provisioning authority, the request conflicts, or the provider quota is exhausted. | Correct the account key or quota, honor any retry window, then explicitly retry. | That create request did not create an inbox and local credentials remain unchanged. |
| Scoped runtime-key creation returns a definite `401`, `403`, `409`, or `429` | The inbox was already created or resolved, but the account key cannot mint the scoped key or a provider limit intervened. | Inspect the inbox, fix the account-key authority or quota, then rerun `existing`; deterministic inbox identity lets setup resolve the same owned inbox. | The inbox exists. No scoped key is proven created and local credentials remain unchanged. |
| Setup refuses because `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, or `AGENTMAIL_INBOX_EMAIL` already exists | Setup never silently rotates the runtime identity. A value may come from `.env` or the invoking process. | To reuse it, choose `--mode env`. To replace it, stop the agent and follow [Replace runtime credentials safely](#replace-runtime-credentials-safely), including revoking the old key before removing local values. | The refusal occurs before replacement; existing local values and provider resources remain unchanged. |
| Setup refuses because `AGENTMAIL_ACCOUNT_API_KEY` is in a dotenv file | The provisioning-level account key was found in a persistent project file. | Remove it from every project dotenv file. Use the masked prompt, or inject it through a process-scoped secret manager for non-interactive `--mode existing`. | Setup stops before contacting AgentMail or changing local files. Remove the exposed persistent copy and rotate it if its storage was not trusted. |
| Setup times out, loses the connection, or rejects an unexpected provider response after provisioning starts | Provider acceptance may have occurred even though Auggy could not prove the final result. Inbox creation is retryable only after inspection; scoped-key creation is not safely idempotent. | Check AgentMail first. A deterministic inbox-create retry targets the same logical inbox. Before retrying scoped-key creation, revoke any orphan key with the setup key name. | Local `.env` and augment configuration remain unchanged. The provider may contain the inbox or an orphan scoped key. |
| Setup reports that a scoped key was created but local commit failed | A concurrent edit, compare-and-swap check, or local write failed after provider provisioning. | Preserve the newer local edit, revoke the orphan key named by the error, correct the conflict, and rerun setup. | The inbox and named scoped key exist remotely. Local `.env` and augment configuration were rolled back or left at the concurrent version. |
| `manual` or `env` cannot resolve the canonical inbox | The supplied inbox ID/runtime key pair is wrong, revoked, or temporarily unreachable. | Verify the exact runtime key and inbox ID, restore provider reachability, then retry the same mode. Do not substitute an account key. | Only a provider read was attempted; provider resources and local credentials remain unchanged. |
| `AGENTMAIL_API_KEY is unresolved` at startup | The referenced runtime key is absent from the agent's environment. | Complete setup, or set the inbox-scoped runtime key in the agent's `.env`, then restart. Do not put the account API key there. | Startup fails before mail is used; provider state and local durable mail state are unchanged. |
| Inbox healthcheck returns a definite `401`, `403`, `404`, or the provider email does not match | The runtime key is invalid, revoked, scoped to another inbox, lacks `inbox_read`, or the configured inbox email is wrong. | Rerun setup with the exact inbox/key pair. Do not hand-edit the setup-verified email. | The healthcheck does not mutate provider or local configuration. Startup fails closed. |
| Inbox healthcheck times out or returns `425`, `429`, `5xx`, or a network error | The read-only provider health request is temporarily unavailable. | Check provider/network status and Console health before sending. Restart after connectivity recovers if inbound readiness never completed. | No provider mutation occurs. The runtime may continue degraded with its setup-verified email, or without a publishable address when none was configured. |
| Inbound setup or runtime returns `403` after inbound was enabled | YAML was changed after an outbound-only key was minted. Enabled inbound requires `message_read`; processing spam or blocked mail adds the matching label-read permission. | Stop the agent and use the credential-replacement procedure. Save the complete inbound policy before provisioning the replacement key. | The failed provider read does not widen the key or process the email. Existing provider mail remains in AgentMail; local policy stays as edited. |
| Inbound config rejects its sender policy | Enabled inbound requires exactly one of a non-empty `allowedSenders` list or `allowAnySender: true`. Bare `"*"`, partial wildcards, and combining both controls are invalid. | Use exact addresses, exact-domain entries such as `"*@example.com"`, or the explicit public-inbox switch. Restart after saving valid YAML. | Validation fails before the inbound worker starts; no messages are admitted or discarded by Auggy. |
| Public inbound says bounded rate limits are required | `allowAnySender: true` must have finite global and per-sender hourly limits, and the per-sender value cannot exceed the global value. | Set both `inbound.rateLimit.globalMaxPerHour` and `perSenderMaxPerHour`, then restart. | Validation changes nothing. AgentMail may still store incoming provider mail while Auggy remains stopped. |
| Webhook mode says `webTransport` or a webhook secret is required | The verified callback cannot be mounted, or `secretEnv` does not resolve to the same Svix secret configured in AgentMail. | Mount `webTransport`, expose the route through HTTPS, set the configured secret environment variable, configure the same callback in AgentMail, and restart. | Auggy does not accept unverified callbacks. Changing the provider callback is a separate AgentMail-side mutation. |
| Human review says the admin route is required | A configured trust level can create reviewed mail actions, but there is no creator-authenticated surface to decide them. | Enable `webTransport.adminRoute`, or remove that trust level from review/send authority, then restart. | Runtime construction fails before mail actions are accepted; existing durable reviews remain unchanged. |
| **Mail** is missing from Console navigation | The running agent does not expose a supported `agentMail` Mail view. `visitorAuth`, Notify, or a provider inbox alone does not add it. | Confirm `agentMail` is mounted, enable the Console admin route, restart, reload, and inspect startup or capability status errors. | Reloading changes nothing. Installing `agentMail` changes local files, but it does not provision an inbox until setup succeeds. |
| Reply or forward is unavailable in this turn | The agent tried to act on an email other than the one that started this turn, or retried from a later turn. | Reply or forward while handling the triggering email. Use `send_message` for a separate follow-up when outbound policy permits it. | The rejected tool call sends nothing and does not create a provider draft. |
| Send, reply, or forward is rejected by Auggy policy | Trust, recipient, count, body, HTML, reply mode, reply-all, or current-turn checks rejected the action before dispatch. | Correct the request or change only the narrow policy that should allow it; restart after YAML edits. | AgentMail was not called, so no provider message or draft exists. |
| Auggy reports rate-limited, cooldown, or duplicate | A durable local outbound limit rejected the action before provider dispatch. | Honor `retryAfter`, confirm the action is still intended, and repair durable rate state if Console reports storage failure. Do not paraphrase a duplicate merely to bypass policy. | AgentMail was not called. Local counters or reservations may have advanced. |
| A runtime provider send fails definitively | AgentMail rejected the mutation with a settled error such as `4xx`/`429`. | Correct the credential, input, or quota and honor any retry window before one deliberate retry. | Auggy records a failed attempt; no successful provider send is proven. This differs from an ambiguous outcome. |
| WebSocket or REST catch-up is degraded or not ready | The subscription/read path lost connectivity or the runtime key cannot read the inbox. | Inspect inbound health and the last provider error in Console, repair connectivity or key scope, then restart if initial readiness never completed. | Provider mail remains in AgentMail. The local ledger/checkpoint retains only progress it already confirmed. |
| Inbound attention is at capacity | The bounded creator-attention queue has no safe slot for another active item. | Resolve or dismiss existing attention items in Console. | The exact email remains pending without consuming a delivery attempt; it resumes when capacity is available. |
| Creator digest says outcome unknown | Notify may have delivered the digest, but Auggy cannot prove the result. | Verify the destination independently, then reconcile the exact Notify incident. Do not retry or dismiss it first. | The ambiguous generation remains fenced and is not resent automatically. |
| Creator digest attempts are exhausted | Bounded definitive delivery failures reached `maxAttempts`. | Inspect and repair the Notify destination, then authorize one evidence-bound retry or dismiss only that digest generation. | Email and reply state are unchanged; only the digest generation is failed. |
| Creator digest target changed | A pending batch is bound to its original Notify destination and policy. | Restore the prior Notify binding, or reconcile the pending batch before moving it. | Auggy does not re-key or resend the batch to the new target. |
| A send outcome is ambiguous | The provider may have accepted the email before the connection failed. | Inspect AgentMail sent mail, then reconcile the exact action in Console as sent or not sent. Never blindly retry. | Auggy reserves the attempt and keeps it fenced; another automatic send is blocked until reconciliation. |
| An inbound turn is outcome-unknown | Model or tool effects may have started before the worker stopped. | Verify downstream effects, then reconcile the exact incident/version as handled or confirmed no-effect. | The provider thread remains blocked, and Auggy does not replay the turn automatically. |
| Mail state appears to vanish after a Railway redeploy | `/app/data` is not the advertised persistent volume, or the deployment is reading a different volume. | Mount the Railway volume at exactly `/app/data` and redeploy. Do not copy an uncertain live database over another instance. | A compliant current runtime fails startup before accepting mail when durability proof fails; provider mail remains in AgentMail. |

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

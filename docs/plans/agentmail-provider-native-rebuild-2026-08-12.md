# AgentMail provider-native rebuild

Status: accepted implementation contract
Date: 2026-08-12
Owner: Auggy runtime

## Decision

Replace the current `agentMail` augment in place. There is one public augment
name and one configuration contract. No legacy implementation, schema-version
switch, compatibility reader, or automatic state migration ships with the new
runtime.

AgentMail is the system of record for inboxes, messages, threads, attachments,
labels, drafts, and delivery state. Auggy owns the runtime behavior AgentMail
cannot provide: waking a turn, crash recovery, peer identity, deterministic
authorization, creator attention, and conversation-aware review.

The replacement keeps `visitorAuth` AgentMail delivery and the `notify`
AgentMail adapter operational. Those are independent outbound consumers and do
not inherit the agent mailbox lifecycle or policy.

## Why the existing implementation is removed

The existing augment maintains an editable review proposal and a parallel
review lifecycle inside Auggy. That duplicates state AgentMail now provides as
provider-native drafts and makes Console and provider edits compete. There are
no supported production users of the existing RC-only contract, so preserving
it would increase security, migration, testing, and recovery surface without a
compatibility benefit.

Git history is the rollback artifact. Unsupported local state is detected and
reported; it is never read, migrated, or deleted automatically.

## Provider capability matrix

| Capability | AgentMail surface | Auggy use | Boundary |
| --- | --- | --- | --- |
| Inbox administration | SDK and hosted MCP | CLI/control-plane diagnostics only | Model turns cannot create, delete, or re-key inboxes |
| Message and thread reads | SDK and hosted MCP | SDK-backed list, search, get, attachment metadata, and label tools | Content remains untrusted; attachment access is bounded and audited |
| Live inbound | SDK WebSocket or verified webhook | WebSocket first; webhook may feed the same normalized event boundary | Reconnect is not replay |
| Offline recovery | Paginated message listing | Catch up after subscribe and after every reconnect | Auggy owns checkpoint and deduplication |
| Provider-native drafts | SDK and hosted MCP | New, reply, reply-all, and forward drafts; list, inspect, revise, delete, and send | No editable body is stored by Auggy; provider-scheduled drafts are visible but scheduling remains in AgentMail |
| Draft creation idempotency | `clientId` | Stable ID derived from inbox, message, and policy generation | One source message has at most one active draft |
| Sending idempotency | `Idempotency-Key` request header | Stable key retained across retries of one approved send | Hosted MCP `send_draft` does not expose this key |
| Admission lists | AgentMail Lists | Optional provider enforcement | Lists do not grant Auggy autonomous authority |
| Credential scope | `auth_me` and API-key permissions | Validate the supplied key and configured inbox | Auggy never creates, rotates, or replaces a key |
| Spam and authentication classification | Received event variants and labels | Additional untrusted-input classification | Provider authentication is not Auggy identity |
| Delivery lifecycle | sent, delivered, bounced, complained, rejected events | Correlate live failure events to Auggy-managed sends and notify the creator | A successful send call is not delivery evidence; AgentMail exposes no message-addressable lifecycle replay API |
| Attachments | Provider metadata and expiring signed download URL | Fetch only for an authorized turn that requires it | Never persist signed URLs or execute content |
| Labels | SDK and hosted MCP | Read and mutate as creator-authorized workflow state | Labels do not grant Auggy identity or send authority |
| Direct delivery | SDK and hosted MCP | SDK send, reply, and forward behind one Auggy policy, rate, idempotency, and audit ledger | Reply-all is draft-only; raw MCP mutations never bypass Auggy policy |
| Official skills | AgentMail skill repository | Adapted, pinned behavioral guidance for safe email use | Skills guide behavior; they do not provide authority or execution |

The implementation is checked against:

- <https://www.agentmail.to/docs/integrations/mcp>
- <https://www.agentmail.to/docs/agent-onboarding>
- <https://www.agentmail.to/docs/integrations/skills>
- <https://www.agentmail.to/docs/websockets>
- <https://www.agentmail.to/docs/webhooks-overview>
- <https://www.agentmail.to/docs/events>
- <https://www.agentmail.to/docs/drafts>
- <https://www.agentmail.to/docs/lists>
- <https://www.agentmail.to/docs/permissions>
- <https://www.agentmail.to/docs/idempotency>
- the installed generated `agentmail` SDK declarations; and
- the generated AgentMail MCP manifest.

Documentation is evidence for provider behavior, not a runtime dependency.
Generated SDK types are the implementation contract. Tests retain sanitized
fixtures for contract drift detection.

## End-to-end execution contract

```text
AgentMail live event
  -> normalize and validate
  -> durably claim message/event
  -> map sender to Auggy peer and policy
  -> enqueue one normal kernel turn
  -> triage untrusted content
  -> create/update AgentMail reply draft
  -> persist provider draft reference
  -> notify creator
       -> review/revise with Auggy, or
       -> open AgentMail
  -> explicit authorized send
  -> live delivery-failure correlation
```

### Boot and reconnect ordering

1. Validate configuration, open the orchestration store, and immediately
   recover interrupted claims from the dead predecessor in the supported
   single-process topology.
2. Verify the supplied credential and configured inbox.
3. Establish the WebSocket and subscribe to the exact inbox.
4. Start paginated REST catch-up from a durable high-water mark.
5. Deduplicate overlap between live delivery and catch-up.
6. Advance a checkpoint only after a message has been durably claimed.
7. Repeat catch-up after every reconnect and on a bounded repair cadence.

This ordering closes the list-before-subscribe race. AgentMail does not
document WebSocket replay, so the design never relies on it.

## State ownership

Auggy may persist only orchestration data:

- inbox, provider event, message, thread, and draft identifiers;
- normalized sender and classification needed for deterministic policy;
- payload hashes, claims, attempts, checkpoints, and processing state;
- authorization policy version and creator-approval provenance;
- creator-notification and provider-delivery settlement; and
- bounded recovery incidents.

Auggy must not persist an editable email body, HTML, attachment bytes, provider
credential, or signed attachment URL in its mail ledger. Message content is
fetched just in time for an admitted turn. The AgentMail draft is fetched each
time it is displayed or revised.

## Identity and authorization

Email admission, email authentication, Auggy identity, and action authority
are separate decisions.

- An unknown sender is a `public` peer and all content is untrusted.
- A syntactically known or provider-authenticated address is still not an
  Auggy creator or recognized visitor.
- Higher trust requires a creator-approved binding to an Auggy identity.
- Visitor authentication identifies a visitor but grants no mail capability.
- Received content, quoted text, links, and attachments never authorize an
  action.
- Layered memory is advisory and cannot grant authority.

The validated YAML policy controls receive admission, whether Auggy creates a
review draft, recipient scope, reply-all, forward, attachments, and
inbound/outbound rate limits. Auggy does not automatically send replies. New,
reply, reply-all, and forward drafts remain provider-native objects. Auggy
revalidates every material field immediately before an explicit creator send,
including separated To/Cc/Bcc recipients, text or HTML, attachment identity and
size, source message, provider schedule state, and provider revision. Auggy
does not create or mutate provider schedules. Changing policy requires an
operator config edit and agent restart.
AgentMail Lists may mirror recipient boundaries as defense in depth but are not
the authorization record.

## Draft and creator-review state machine

```text
received -> triaging -> no_reply
                    -> draft_creating -> draft_ready
                                      -> quarantined
draft_ready -> revising -> draft_ready
            -> stale
            -> approved -> sending -> sent
                                  -> ambiguous

live sent-message events -> delivered (provider evidence only)
                         -> rejected|bounced|complained -> creator attention
```

Each provider draft has one Auggy orchestration record. A source message can
have multiple intentionally distinct drafts, but a stable operation identity
can create at most one of each requested draft. A new message on the provider
thread makes an awaiting reply or reply-all draft stale until the creator
reviews the new context. Revision is serialized inside Auggy, fetches and compares the
provider timestamp immediately before updating, and verifies the result with a
second fetch. AgentMail does not expose a conditional-update token in the
pinned SDK, so a simultaneous AgentMail UI edit can still race that update.
This residual race is documented; creator review and a fresh timestamp remain
mandatory before sending.

The creator can either open AgentMail or ask Auggy to show and revise the
draft. Both paths operate on the same provider object. `Send it` is a new,
creator-authorized mutation; creating or editing a draft is never send
authorization.

Draft-ready creator attention is restart-recoverable because Auggy records the
draft reference and attention item in one local transaction. Delivery-failure
attention is durable after Auggy observes the live event, but events missed
while Auggy is offline cannot be reconstructed per message: AgentMail's inbox
event-list endpoint documents label changes only, while its metrics endpoint
returns aggregate counts without message identity. WebSocket reconnection is
therefore not presented as lifecycle replay. Reliable offline lifecycle-event
recovery requires a future verified webhook inbox or a provider event-history
API with stable message identifiers.

## Error contract

Provider-facing failures use stable categories:

| Code | Meaning | Default handling |
| --- | --- | --- |
| `configuration_invalid` | Local configuration cannot be used safely | Fail mail boot with exact field guidance |
| `credential_rejected` | Credential is absent, invalid, or revoked | Fail mail readiness; do not rotate it |
| `permission_missing` | Supplied key lacks the required capability | Fail the affected operation with permission guidance |
| `provider_rate_limited` | AgentMail rejected work temporarily | Persist the retry time; a later exact creator retry reuses the original operation and idempotency key |
| `provider_unavailable` | Network or provider 5xx failure | Degrade mail, reconnect, and reconcile |
| `provider_contract_invalid` | Response/event violates the validated contract | Quarantine affected work and surface contract drift |
| `mutation_ambiguous` | Provider may have applied a mutation | Fence automatic retry and reconcile by provider IDs/idempotency |
| `resource_conflict` | Draft or policy changed concurrently | Refetch and require creator review |
| `resource_not_found` | Configured inbox/message/draft no longer exists | Reconcile or require operator repair |

Every operational error includes the operation, lifecycle phase, retryability,
safe inbox/message/draft identifiers where useful, provider HTTP status and
machine code when available, and a concrete next action. Errors never contain
API keys, authorization headers, complete provider bodies, message bodies, or
attachment content.

## Runtime failure boundaries

- An unavailable or corrupt orchestration store fails closed before inbound
  traffic is admitted.
- Startup fails readiness if the configured inbox cannot be verified and its
  live subscription cannot be established. After readiness, a transient
  AgentMail outage degrades the mail capability while the rest of the agent
  stays available; reconnect and catch-up repair the mailbox path.
- A poison message quarantines the affected message rather than unrelated mail.
- An ambiguous kernel or provider mutation fences only its affected thread or
  draft until reconciliation.
- Shutdown is bounded and idempotent. Work already persisted is recovered on
  the next boot.
- One logical inbox has one live Auggy consumer. Multi-replica mailbox
  consumption remains unsupported until coordination is fenced.

## Configuration contract

The final public configuration uses the existing `type: agentMail` mount and a
small set of explicit policy groups. There is no `schemaVersion`.

```yaml
type: agentMail
config:
  apiKey: ${AGENTMAIL_API_KEY}
  inboxId: ${AGENTMAIL_INBOX_ID}
  emailAddress: ${AGENTMAIL_INBOX_EMAIL}
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
    subjectPrefix: "[Auggy] "
    maxRecipients: 10
    rateLimit:
      globalMaxPerHour: 10
      perRecipientCooldownMs: 300000
```

Every public field must have validation, documented allowed values and
defaults, runtime tests, and a clear restart/apply contract.

## CLI connection boundary

`auggy augment setup agentMail` and `auggy augment setup visitorAuth` support
three interactive entry paths:

- `signup`: create the first AgentMail account and inbox, verify its email OTP,
  and retain the initial key returned by AgentMail;
- `existing`: create a new inbox with the operator's account key and retain that
  exact key for runtime use; and
- `manual`: connect an existing inbox ID to the exact key the operator chose.

`connect` remains a release-candidate alias for `manual`, while `env`
revalidates existing `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` values.
Setup never mints, narrows, exchanges, rotates, or revokes a second API key.
It validates the configured inbox identity and exercises required read
operations. Output separates reads that were verified from write permissions
that are required but cannot be safely probed during setup. The real-provider
release canary continues to use the same exact key and pre-provisioned inbox
without mutating provider state.

## Explicitly unsupported

- Automatic migration or deletion of the previous RC mail databases/reviews.
- A second inbox UI or independent editable draft store in Auggy.
- Inferring creator identity from a `From` address.
- Treating memory as authorization.
- Blind retry of an outcome-unknown send.
- Creating, changing, or cancelling scheduled drafts through Auggy. Externally
  scheduled provider drafts remain visible and must be managed in AgentMail.
- WebSocket-only recovery.
- Exposing unrestricted AgentMail MCP tools to public turns.
- Exposing hosted MCP send, reply, forward, draft mutation, label mutation, or
  destructive operations as an alternate execution path around Auggy policy.
- Stable inbox/draft deep links until AgentMail documents them.
- Multiple live Auggy consumers for one inbox.

## Release gates

The replacement is complete only when focused tests, full tests, strict
typecheck, lint, Console build, packed isolated install, release smoke, real
provider canary, offline catch-up, and Railway-style persistent-volume restart
all pass. The first publication is a new release candidate, not stable.

## Implementation slices and acceptance criteria

Slices follow their dependency order. Provider, orchestration-store, and
policy foundations may be implemented in parallel only after Slice 1 freezes
their shared contracts. Runtime feature slices consume those foundations and
must not invent a second policy or provider path.

### Slice 1 — capability and authorization contract

- Freeze the supported operations, system-of-record boundary, skill role, MCP
  boundary, and dependency graph in this document.
- Derive inbound peer identity from the effective mounted augment name, not a
  hard-coded default.
- Prove a renamed mount cannot use an inbound public turn to bypass direct-send
  denial.
- Focused AgentMail tests, strict typecheck, lint, and diff checks pass.

### Slice 2 — generated SDK contract gate

- Pin one reviewed AgentMail SDK version and update the frozen lockfile.
- Compile-check every SDK method and request/response field used by the
  provider adapter, including draft forward, reply-all, attachment, label,
  observed schedule state, and idempotency surfaces.
- Disable SDK mutation retries; Auggy's durable operation ledger owns retries.
- Prove the installed SDK's WebSocket implementation boots under the supported
  Bun version without assigning the unsupported `blob` binary type.

### Slice 3 — complete provider adapter

- Expose typed message/thread list, search, get, update, delete, attachment,
  draft, and delivery operations required by the runtime.
- Use specialized SDK methods when they carry stronger reply/forward semantics.
- Normalize every provider response at one boundary and reject contract drift.
- Map validation, credential, permission, conflict, rate, unavailable,
  not-found, and outcome-unknown failures without leaking provider content or
  credentials.

### Slice 4 — durable orchestration model

- Key draft state by provider draft ID and operation identity; represent new,
  reply, reply-all, and forward drafts without storing content.
- Persist immutable material hashes, provider revisions, approvals, observed
  provider schedule state, send idempotency, outcomes, and provider correlation
  IDs.
- Support crash recovery, bounded retention, stale-draft transitions, and
  outcome-unknown reconciliation without duplicate delivery.
- Migrations are transactional and fail closed on unsupported or corrupt state.

### Slice 5 — centralized policy and approval

- Validate all public configuration with explicit defaults and deny unknown
  fields.
- Authorize admission, reads, labels, attachment access, drafts, direct
  delivery, reply-all, forward, delete, and send from one policy module.
- Bind approval to an immutable operation manifest containing action, inbox,
  resource IDs, separated recipients, body/attachment hashes, source message,
  observed provider schedule state, provider revision, creator, and policy
  generation.
- Neither email content, provider labels, official skills, MCP, nor memory can
  grant authority.

### Slice 6 — read, triage, labels, and attachments

- Add bounded list/search/get operations that return safe, useful mail and
  thread metadata.
- Add creator-authorized label updates with clear trash/permanent-delete
  semantics.
- Fetch attachments just in time, enforce count/size/type/path limits, never
  execute content, and never persist bytes or signed URLs in orchestration
  state.
- Preserve pagination and distinguish empty results from provider failures.

### Slice 7 — provider-native draft workflow

- Create, list, show, revise, and delete new, reply, reply-all, and forward
  drafts. Show externally scheduled drafts truthfully but direct schedule
  changes to AgentMail.
- Keep `inReplyTo` and `forwardOf` immutable and preserve provider forward body
  and attachments through delivery.
- Detect external AgentMail edits through provider revision/material hashes and
  invalidate prior approval.
- Notify the creator with actionable draft and source identifiers; allow review
  in Console or AgentMail against the same provider draft.

### Slice 8 — delivery and reconciliation

- Send provider drafts and perform explicitly enabled direct new, reply, and
  forward operations only after current policy and approval checks. Reply-all
  remains provider-draft-only.
- Use a stable provider idempotency key for the identical request for at most
  the documented provider retention window.
- Classify pre-dispatch failures as retryable where safe and post-dispatch
  uncertainty as outcome unknown; never create a new key to escape ambiguity.
- Reconcile by provider IDs/idempotency where evidence exists, otherwise require
  an operator decision and retain an audit record.

### Slice 9 — official skills and MCP boundary

- Adapt and pin the applicable official AgentMail skill guidance, preserving
  the rules that email cannot authorize action, drafts are not send authority,
  exact message IDs anchor reply/forward, and ambiguous sends require
  reconciliation.
- Keep SDK-backed augment tools as the default operational surface.
- If raw hosted MCP is configured, expose creator-only read operations at most;
  mutation tools remain blocked unless they enter the same policy, approval,
  rate, idempotency, and audit path.
- Add mirror/parity tests so packaged skills cannot silently drift.

### Slice 10 — operator surfaces and release proof

- Align CLI setup/doctor, Console action states, public docs, examples, generated
  contracts, and diagnostics with the implemented behavior.
- Never create or replace the operator-supplied AgentMail key; report missing
  permissions per operation.
- Pass focused and full tests, strict typecheck, lint, Console tests/build,
  package/release smoke, cold isolated install, restart/offline catch-up E2E,
  and the sanitized real-provider canary.
- Complete an adversarial review covering authorization bypass, prompt
  injection, duplicate sends, crash boundaries, renamed mounts, provider drift,
  attachment exfiltration, MCP bypass, and secret leakage before release.

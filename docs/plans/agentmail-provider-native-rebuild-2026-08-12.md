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
| Mailbox operations | SDK and hosted MCP | SDK for deterministic runtime work; MCP-compatible names for model-facing tools | MCP does not wake an idle runtime |
| Live inbound | SDK WebSocket or verified webhook | WebSocket first; webhook may feed the same normalized event boundary | Reconnect is not replay |
| Offline recovery | Paginated message listing | Catch up after subscribe and after every reconnect | Auggy owns checkpoint and deduplication |
| Draft review | Provider-native drafts | Create with `inReplyTo`; fetch/update the same draft from Console turns | No editable body is stored by Auggy |
| Draft creation idempotency | `clientId` | Stable ID derived from inbox, message, and policy generation | One source message has at most one active draft |
| Sending idempotency | `Idempotency-Key` request header | Stable key retained across retries of one approved send | Hosted MCP `send_draft` does not expose this key |
| Admission lists | AgentMail Lists | Optional provider enforcement | Lists do not grant Auggy autonomous authority |
| Credential scope | `auth_me` and API-key permissions | Validate the supplied key and configured inbox | Auggy never creates, rotates, or replaces a key |
| Spam and authentication classification | Received event variants and labels | Additional untrusted-input classification | Provider authentication is not Auggy identity |
| Delivery lifecycle | sent, delivered, bounced, complained, rejected events | Correlate live failure events to Auggy-managed sends and notify the creator | A successful send call is not delivery evidence; AgentMail exposes no message-addressable lifecycle replay API |
| Attachments | Provider metadata and expiring signed download URL | Fetch only for an authorized turn that requires it | Never persist signed URLs or execute content |

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

1. Validate configuration and open the orchestration store.
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

Mail policy separately controls receive admission, draft creation, reply,
automatic send, recipient scope, reply-all, attachments, rate limits, expiry,
and revocation. A natural-language policy request is converted into a bounded
structured proposal and becomes active only after explicit creator approval.
AgentMail Lists may mirror recipient boundaries as defense in depth but are not
the authorization record.

## Draft and creator-review state machine

```text
received -> triaging -> no_reply
                    -> draft_creating -> draft_ready
                                      -> quarantined
draft_ready -> revising -> draft_ready
            -> stale
            -> approved -> sending -> sent -> delivered
                                  -> ambiguous
                                  -> rejected|bounced|complained
```

One inbound message can reference at most one active reply draft. A new message
on the provider thread makes an awaiting draft stale until the creator reviews
the new context. Revision is serialized inside Auggy, fetches and compares the
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
| `provider_rate_limited` | AgentMail rejected work temporarily | Respect retry metadata and keep durable work pending |
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
- A transient AgentMail outage degrades only the mail capability when the store
  and configuration remain safe.
- A poison message quarantines its provider thread rather than unrelated mail.
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

`auggy augment setup agentMail` and `auggy augment setup visitorAuth` connect
resources that already exist in AgentMail. The supported modes are:

- `connect`: collect an existing inbox ID and the exact API key the operator
  chose for runtime use; and
- `env`: revalidate the existing `AGENTMAIL_API_KEY` and
  `AGENTMAIL_INBOX_ID` values without changing their identity.

Setup never signs up an AgentMail account, creates or adopts an inbox, or
creates, scopes, rotates, replaces, or revokes an API key. It validates the
configured inbox identity and exercises required read operations without
provider mutations. Output separates reads that were verified from write
permissions that are required but cannot be safely probed during setup. The
real-provider release canary exercises the same exact key and pre-provisioned
inbox without mutating provider state.

## Explicitly unsupported

- Automatic migration or deletion of the previous RC mail databases/reviews.
- A second inbox UI or independent editable draft store in Auggy.
- Inferring creator identity from a `From` address.
- Treating memory as authorization.
- Blind retry of an outcome-unknown send.
- WebSocket-only recovery.
- Exposing unrestricted AgentMail MCP tools to public turns.
- Stable inbox/draft deep links until AgentMail documents them.
- Multiple live Auggy consumers for one inbox.

## Release gates

The replacement is complete only when focused tests, full tests, strict
typecheck, lint, Console build, packed isolated install, release smoke, real
provider canary, offline catch-up, and Railway-style persistent-volume restart
all pass. The first publication is a new release candidate, not stable.

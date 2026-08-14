# Auggy Activity Index architecture

Date: 2026-08-13
Status: accepted direction; implementation not started

## Decision summary

Auggy needs a durable, queryable record of meaningful capability activity so a
verified principal can resolve references such as:

- “Who did you just email?”
- “Which draft is waiting for me?”
- “What woke you up?”
- “Did that notification send?”
- “Which operation has an unknown outcome?”

The initial idea was a global **Activity Ledger**. Adversarial review found that
calling it a ledger and making it globally model-queryable would encourage the
wrong architecture: a second source of truth, arbitrary augment payloads,
privacy leakage, accidental authorization, and an append-only store that could
not honor retention or erasure.

The hardened concept is an **Auggy Activity Index**: a minimized, typed,
authorized projection of domain activity. It is not event sourcing and it is
not a global transcript.

## Decision history from the incident

The discussion began with the right product question: before a new turn, should
Auggy inspect Layered Memory, behavior, identity, authorization, and augment
state so a Telegram request can refer to an earlier Console/AgentMail action?
The answer is yes to coordinated retrieval, but no to indiscriminately loading
every store into every prompt.

The sequence of refinements was:

1. Thread history alone was proven insufficient because the earlier email
   operation occurred in another channel.
2. Layered Memory was identified as the right home for preferences, but the
   wrong authority for exact recipients, provider IDs, or operation outcomes.
3. AgentMail provider/domain state was identified as the authoritative mail
   source, but querying every provider on every turn would add latency, cost,
   and unnecessary disclosure.
4. A global event ledger was proposed to make recent operations discoverable.
5. Adversarial review split that idea into domain state, provider truth,
   security audit/observability, and a smaller Activity Index. It also separated
   executable behavior policy from learned memory and historical activity.
6. The existing `Augment.context(turn)` pipeline was retained as the bounded
   pre-inference extension point. The missing piece is a typed, authorized,
   relevance-aware activity source plus capability-specific just-in-time tools,
   not a new universal hook or merged transcript.

## Required separation of concerns

Four systems must remain distinct:

1. **Domain operation state.** An augment owns its durable workflow state. For
   example, AgentMail's orchestration database owns delivery attempts, draft
   mutations, retries, reconciliation, and `outcome_unknown` fences.
2. **External source of truth.** The provider owns provider resources. AgentMail
   owns inboxes, messages, threads, attachments, and provider-native drafts.
3. **Activity Index.** Core indexes sanitized facts about meaningful activity
   so authorized users and models can retrieve recent cross-channel context.
4. **Security audit and observability.** Authorization decisions, traces,
   diagnostics, and latency metrics remain separate and are not automatically
   model-visible.

Two additional stores have different semantics:

- **Layered Memory** stores learned facts, preferences, and commitments.
- **Behavior policies** store explicit, creator-authored rules about what Auggy
  should do in the future.

In one line:

```text
Behavior says what Auggy should do.
Activity says what Auggy did.
Memory says what Auggy knows or remembers.
The provider owns the actual external resource.
```

## Adversarial findings and corrections

| Risk in a generic ledger | Failure mode | Required correction |
| --- | --- | --- |
| Global arbitrary event log | Augments dump secrets, bodies, or unbounded JSON | Register versioned activity schemas and allowlisted projections |
| Second source of truth | Index says “sent” while provider/domain state disagrees | Domain/provider state remains authoritative; index stores references |
| Dual-write gap | External effect succeeds but index write fails | Domain transaction writes an outbox; projection is idempotent and retryable |
| Generic model tool | Model discovers unrelated capability activity | Prefer capability-specific tools such as `list_recent_mail_activity` |
| Stored trust looks current | Old creator activity is reused as authorization | Re-resolve current identity and policy for every action |
| Append-only retention | Personal data or secrets cannot be erased | Expiry, redaction/tombstones, and where needed crypto-shredding |
| Free-form references | Producers smuggle PII or secret material | Typed, bounded, allowlisted resource fields |
| One subject per event | Real operations involve message, thread, draft, and operation | Support multiple typed resources and relations |
| Wall-clock ordering | Concurrent timestamps make “latest” ambiguous | Core-assigned monotonic committed sequence |
| Terminal events only | Pending, dispatched, or ambiguous work disappears | Project durable state transitions including `outcome_unknown` |
| Inject everything every turn | Context pollution, latency, and privacy loss | Tiny availability hint plus just-in-time retrieval |
| Activity becomes telemetry | Polls and inference spans flood user history | Keep metrics/traces in observability, not the Activity Index |
| Model-written summary | Hallucinated prose becomes authoritative | Deterministic codes and producer-owned safe projections only |

## Ownership boundary

### Core owns

- the versioned envelope and schema registry;
- agent/augment-instance scoping;
- monotonic committed sequence allocation;
- idempotent projection and deduplication;
- audience enforcement before retrieval or context assembly;
- retention, expiry, redaction, tombstones, and erasure orchestration;
- bounded querying and pagination;
- capability registration and health/lag reporting.

### Each augment owns

- authoritative domain state;
- the transaction that commits a domain transition and its outbox entry;
- versioned activity types and safe field projections;
- provider resource references and reconciliation logic;
- migration and rollback compatibility for its outbox.

### The model never owns

- authoritative activity fields;
- audience selection;
- authorization decisions;
- provider outcome classification;
- deduplication keys or committed sequence values.

## Production write path

Do not directly dual-write domain state and a global index:

```text
AgentMail operation reaches a durable transition
  -> same SQLite transaction writes domain state + typed outbox row
  -> projector reads committed outbox rows
  -> validates registered schema and bounds
  -> writes idempotent sanitized Activity Index projection
  -> marks/checkpoints projection progress
```

Delivery guarantees are:

- external effects are never advertised as exactly once;
- domain-to-index projection is at least once;
- deterministic deduplication makes projection idempotent;
- index lag is observable;
- projection failure cannot rewrite the authoritative domain outcome;
- a poisoned invalid outbox record is quarantined and visible to the operator
  without blocking unrelated producers forever.

For an ambiguous provider response:

```text
agentMail.delivery.outcome_unknown
  -> remains ambiguous in domain state and Activity Index
  -> operator/provider reconciliation
  -> agentMail.delivery.reconciled.sent
     or agentMail.delivery.reconciled.not_sent
```

No consumer may infer failure merely because a sent provider resource cannot
yet be found.

## Candidate envelope

The exact public contract requires implementation review, but it should have
these semantics:

```ts
interface ActivityRecordV1 {
  id: string;
  sequence: number;

  scope: {
    agentId: string;
    augmentInstanceId: string;
  };

  type: string; // e.g. "agentMail.reply.sent"
  schemaVersion: 1;

  producer: {
    augmentType: string;
    augmentVersion: string;
  };

  initiator:
    | { kind: "peer"; peerId: string }
    | { kind: "system"; id: string }
    | { kind: "job"; id: string };

  resources: Array<{
    kind: string;       // registered and allowlisted by the activity type
    id: string;         // bounded opaque reference, not resource contents
    relation: string;   // e.g. "reply-to", "produced", "recipient"
  }>;

  outcome:
    | "pending"
    | "dispatched"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "reconciled";

  occurredAt: number;
  committedAt: number;

  operationId?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationKey: string;

  access: {
    audience: "creator" | "operator" | "peer" | "internal";
    retentionClass: "recent" | "operational" | "audit";
    expiresAt?: number;
  };

  projection: {
    code: string;
    fields: Record<string, string>; // schema-bound and size-bounded
  };
}
```

### Envelope cautions

- `initiator.peerId` records who initiated the historical operation; it does
  not prove the current caller is that peer.
- A `destination` resource must not expose a raw secret, Telegram chat ID, or
  credential. Human-readable addresses require an explicit audience and
  retention decision.
- `occurredAt` may come from a provider; `committedAt` and `sequence` come from
  the local index transaction.
- Correlation and causation IDs are bounded opaque identifiers. They are not
  authorization capabilities.
- Activity versions are producer schemas, not a single forever-expanding union
  that forces all augments to release in lockstep.

## Read path and context behavior

Do not inject a stream of recent activity into every turn. The model should get
only a small, audience-checked availability hint when the current message could
refer to operational history:

```text
Recent AgentMail activity is available. Use the AgentMail activity lookup for
cross-channel references to recent mail actions.
```

Then use a narrow tool:

```ts
list_recent_mail_activity({
  action: "reply.sent",
  sinceMinutes: 30,
  limit: 5,
});
```

The capability-specific tool should:

- bind its query to the currently verified audience and agent instance;
- return bounded deterministic summaries and opaque resource references;
- distinguish an empty result from lookup failure;
- return one candidate when unambiguous;
- return concise choices when ambiguous;
- never return bodies, attachments, secrets, or unrelated activity;
- direct the agent to the authoritative capability tool for current resource
  content.

A generic operator/Console activity view can exist later, but a generic
model-facing `list_recent_activity` tool should not be the first interface.

## Behavior policies are separate

The creator statement “for this sender, always draft a reply and notify me for
review” should become an explicit, inspectable rule, not just a memory or prior
activity:

```yaml
trigger: agentMail.message.received
when:
  sender: person-1@example.com
action:
  createReplyDraft: true
  requireReview: true
  notify: creatorTelegram
createdBy: creator
```

Layered Memory may remember the preference and propose creating the rule. Only
a typed behavior-policy write authorized by the current creator establishes
the executable behavior. Creation, modification, disabling, and deletion of a
policy can themselves emit activity.

## Privacy, retention, and erasure

- Default to metadata and opaque provider references, not content.
- Never index credentials, environment values, email bodies, attachments,
  prompts, full transcripts, exception causes, or provider response bodies.
- Apply audience checks before returning results or producing a `ContextBlock`.
- Bound every string, field count, resource count, query window, page size, and
  retention horizon.
- Expire recent convenience activity aggressively unless operational recovery
  requires longer retention.
- Preserve security audit records in the audit system, not by silently widening
  Activity Index retention.
- Support redaction/tombstones for indexed projections. If a referenced
  provider resource is erased, retain only the minimum non-content operational
  tombstone required for integrity.
- Define backup, export, deletion, and rollback behavior before calling the
  feature production-ready.

## Implementation slices

### Slice 1: contract and threat model

- inventory AgentMail, notify, Telegram, job, Console, and custom-augment
  activity candidates;
- classify each candidate as domain state, activity, audit, metric, memory, or
  behavior;
- define schema registration, bounds, audience, retention, redaction, and
  failure semantics;
- write hostile producer and hostile caller tests before storage code.

### Slice 2: core index and projector

- add a versioned SQLite index owned by core;
- allocate monotonic committed sequences transactionally;
- implement idempotent insert/deduplication, pagination, expiry, tombstones,
  and poisoned-record quarantine;
- expose aggregate health and projection lag without dynamic sensitive labels.

### Slice 3: AgentMail transactional outbox

- write outbox transitions in the same transactions as delivery/draft state;
- project only the AgentMail activity types required for the observed
  cross-channel use case;
- retain exact provider resource references in domain state and minimal safe
  references in the index;
- cover restart, duplicate projection, partial failure, reconciliation, and
  schema migration.

### Slice 4: authorized AgentMail retrieval

- add `list_recent_mail_activity` for verified creator access;
- add a tiny relevance-aware AgentMail `ContextBlock` hint;
- update the AgentMail skill with canonical cross-channel examples;
- ensure multiple matches produce clarification rather than silent selection.

### Slice 5: operator visibility and lifecycle

- add creator/operator inspection, retention, redaction, and projection-health
  surfaces;
- document backup, migration, compatibility fingerprint, rollback, and erasure;
- certify the supported single-replica SQLite topology.

### Slice 6: additional producers only after AgentMail proves the model

- consider notify outcomes, durable jobs, deployments, and custom business
  augments;
- reject noisy telemetry and raw lifecycle events;
- require each producer to supply its own contract tests and safe projection.

## Acceptance criteria

- The Activity Index cannot be mistaken for provider or domain truth in API,
  docs, or implementation.
- Domain state and outbox commit atomically.
- Projection is idempotent, restart-safe, bounded, and observable.
- Every record validates against a registered versioned schema.
- Current identity and policy—not historical activity—authorize reads/actions.
- Public and anonymous callers cannot enumerate creator/operator activity.
- Model-visible results are capability-specific and content-minimized.
- `outcome_unknown` remains ambiguous until an explicit reconciliation event.
- Retention, redaction, tombstones, backup, migration, and rollback are tested.
- An end-to-end test replies through Console, resolves the recent reply through
  Telegram, and sends only after current creator authorization succeeds.
- No generic transcript merge or global free-form event payload is introduced.

## Non-goals

- Full event sourcing of the Auggy runtime.
- Replacing augment databases or external systems of record.
- Exactly-once external side effects.
- A data lake of prompts, messages, traces, and provider payloads.
- Authorization derived from activity, memory, email address, or model output.
- Horizontal multi-replica certification.

## Related plan

The incident and retrieval design that motivate this architecture are recorded
in
[`telegram-latency-and-cross-channel-context-2026-08-13.md`](./telegram-latency-and-cross-channel-context-2026-08-13.md).

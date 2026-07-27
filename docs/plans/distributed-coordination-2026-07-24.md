# Distributed Coordination Plan

**Date:** 2026-07-24
**Status:** implementation plan
**Scope:** multiple runtime replicas serving one logical Auggy agent

## Outcome

Auggy will support two explicit deployment tiers:

1. **Local cell:** one process owns the agent's mutable state. The existing
   keyed scheduler, SQLite stores, and volume remain supported.
2. **Distributed cell:** multiple processes serve one logical agent only after
   every correctness-critical mutable boundary is shared, namespaced, and
   fence-aware.

A shared volume, load-balancer affinity, or a process-local scheduler is never
treated as a distributed correctness boundary. Distributed mode fails closed
when its coordinator is unavailable or when a configured component has only a
local mutable backend.

## Revalidation

The finding is confirmed and reachable whenever a load balancer can route one
logical thread to two replicas.

- `src/agent.ts` serializes history with a process-local `threadTails` map.
- `src/kernel/keyed-turn-scheduler.ts` owns process-local queues, active keys,
  rate records, quarantine, drain state, and counters.
- `ThreadHistoryPersistence.commit` has no revision or fencing token.
- web idempotency, budgets, console history, AgentMail, and default replay
  stores are SQLite-backed or otherwise process-local.
- history commits and outbound delivery are not one atomic durable operation.

Two replicas can therefore load the same history revision, execute the same
irreversible tool, commit conflicting snapshots, and send duplicate outbound
messages. A stale AgentMail worker can also continue executing after its
processing lease expires while another worker reclaims the message.

The existing web idempotency implementation does **not** make the same key a
second leader after a stale heartbeat; it returns outcome-unknown. That path is
fail-closed, but it remains local-volume state and does not serialize different
keys for the same thread.

## Security and reliability invariants

- The coordinator namespace is an immutable operator-selected identifier for
  one logical agent. Request data can never choose it.
- A process receives a fresh instance identifier at boot. Concurrent processes
  cannot share an instance identifier.
- A turn reserves global and source capacity before execution.
- A canonical `(namespace, thread)` has at most one active execution.
- A lease grant mints a strictly increasing fencing token using database time
  and transactional state.
- An expired lease whose execution began becomes outcome-unknown and
  quarantines the thread. Expiry is never permission to replay a possible side
  effect.
- A repeated request identifier binds to one canonical peer, thread, source,
  and request body. Changed bindings conflict.
- Terminal state and capacity release happen exactly once.
- Stale fences cannot commit coordinator-owned history, result, or delivery
  intent.
- Coordinator loss stops admission, makes readiness fail, cooperatively aborts
  owned work, and never falls back to local coordination.
- Recovery is authenticated, audited, compare-and-set, and requires the
  operator to reconcile or terminate the stale owner first.
- Queue, result, event, and audit records are bounded and have explicit
  retention.
- One tenant or logical agent cannot read, reserve, or recover another
  namespace.

Arbitrary downstream side effects cannot be made exactly-once by a database
lease alone. First-party effect sinks must accept a stable operation key and,
where possible, a fence. Unknown effects remain quarantined until an operator
reconciles them.

## Responsibility split

The hosting platform owns:

- TLS, WAF and DDoS controls;
- coarse connection and request limits;
- routing and readiness-based removal;
- secret injection and network policy;
- database provisioning, backups, and restore drills;
- process rollout and termination.

Auggy owns:

- canonical peer/thread/request binding;
- distributed admission and per-thread exclusion;
- database-time leases and fencing;
- durable outcome-unknown quarantine and recovery;
- coordinator health and drain semantics;
- shared idempotency semantics;
- fence-aware history/result/outbox commits;
- application-level tenant namespacing.

Sticky routing may reduce contention but is only an optimization.

## Architecture

### Runtime boundary

Keep `KeyedTurnScheduler` as the local fair executor. In distributed mode, a
new internal `DistributedTurnCoordinator` sits in front of model invocation.
It returns an opaque lease containing:

- namespace, instance, turn, attempt, and thread identifiers;
- a monotonic fence;
- a cancellation signal;
- `markExecutionStarted`, `heartbeat`, `complete`, and
  `markOutcomeUnknown` operations.

The local scheduler still protects one process. The coordinator is
authoritative for fleet-wide capacity, request binding, leases, quarantine,
and recovery.

### PostgreSQL state

Use PostgreSQL transactions and database time. Do not use advisory locks as the
only ownership mechanism.

- `auggy_coordination_migrations`: version and checksum.
- `auggy_coordination_agents`: namespace configuration and drain generation.
- `auggy_coordination_instances`: instance heartbeat and accepting/draining
  state.
- `auggy_coordination_capacity`: global and per-source active/queued counters.
- `auggy_coordination_turns`: bounded request binding, state, result reference,
  timestamps, attempt and fence.
- `auggy_coordination_thread_leases`: holder, expiry, monotonic fence, and
  quarantine.
- `auggy_coordination_events`: bounded operator audit trail.
- `auggy_coordination_outbox`: stable recipient/operation keys and delivery
  reconciliation.
- `auggy_coordination_history`: peer-bound snapshots with revision and fence.

All primary and foreign keys include the agent namespace. Every statement also
contains an explicit namespace predicate. A dedicated database role/schema per
tenant is preferred; row-level security is defense in depth, not the sole
boundary.

Workers claim queued rows with transactional row locks. An agent-level row
serializes authoritative capacity accounting. Thread-head ordering provides
bounded FIFO fairness without holding a database transaction open during model
or tool execution.

### Lease state machine

```text
queued
  ├─ canceled
  └─ leased (execution not started)
       ├─ safe expiry -> queued with a new fence
       └─ started
            ├─ succeeded / failed / canceled
            └─ lease or commit ambiguity -> outcome_unknown -> quarantined
                                                        └─ operator recovery
```

The coordinator uses `clock_timestamp()` (or an equivalent database-time
expression), never a replica's wall clock, for ownership decisions.

### Configuration

Distributed mode is explicit:

```yaml
settings:
  coordination:
    mode: postgres
    namespace: 4a11eb09-6576-4f37-a96f-c2fc7eb0e067
    urlEnv: AUGGY_COORDINATION_DATABASE_URL
    fleetCapacity:
      maxConcurrent: 8
      maxQueued: 200
      maxQueuedPerThread: 25
    retention:
      terminalRequestRetentionMs: 604800000
      maxTerminalRequests: 10000
      eventRetentionMs: 2592000000
      maxEvents: 50000
    result:
      maxReplayBytes: 65536
    turnState:
      history:
        maxSnapshotBytes: 65536
        maxMessages: 100
        maxThreads: 1000
      maxCostMarkersPerTurn: 32
      outbox:
        maxIntentsPerTurn: 32
        maxIntentBytes: 65536
        maxPendingIntents: 1000
    leaseDurationMs: 30000
    heartbeatIntervalMs: 5000
    claimPollMs: 100
    maxWaitMs: 30000
```

The URL is read from the named environment variable and is never printed.
`namespace` must be a canonical UUID. `heartbeatIntervalMs * 3` must not exceed
`leaseDurationMs`. `fleetCapacity` is required, applies once to the logical
fleet, and is never multiplied by replica count or inferred from the local
`turnScheduling` boundary. Required retention and replay policies bound
terminal records, audit events, and sanitized UTF-8 replay bytes. Unknown
fields and unsafe bounds are rejected. The required `turnState` policy bounds
peer-bound history snapshots and namespace cardinality, exact-known inference
cost markers, and staged outbox intents. It is part of the immutable namespace
configuration fingerprint.

Auggy computes the protocol and configuration fingerprints from an exact,
versioned, secret-free projection. YAML cannot supply either fingerprint.
Authoritative inputs include namespace, fleet capacity, lease, retention,
replay, turn state, source policy, and trusted augment compatibility evidence. Database
environment names and values, instance identity, local polling/wait settings,
and `turnScheduling` are excluded. Namespace policy is immutable: mixed
protocol or configuration values fail before admission or instance mutation.

Preview migrations are append-only and checksum-bound. Protocol/schema v5 adds
peer-bound history, exact cost markers, a durable outbox, and the atomic turn
checkpoint. An exact v4 namespace can upgrade only while quiescent: all old
instance leases must be expired and no queued or active request may remain.
The catalog remains exact-versioned, so an older binary intentionally rejects
the expanded preview schema. Rollback requires a matching database snapshot or
a fresh preview database; v5 state must not be silently reopened by v4 code.

The CLI must refuse distributed mode when:

- the coordinator schema is missing or incompatible;
- the database is unavailable;
- another live process already owns the instance identifier;
- a configured mutable store is SQLite-only or process-local;
- shared history, ingress idempotency, replay, budgets, or delivery guarantees
  required by the selected augments are absent.

This compatibility gate is intentionally strict. Shipping a coordinator does
not by itself make every current augment replica-safe.

## Implementation loop

### Group 1 — topology contract

1. Add failing parser and runtime tests.
2. Add versioned coordination types and strict configuration validation.
3. Add a startup preflight that preserves local mode and fails distributed
   mode closed on incompatible state or an unavailable coordinator.
4. Document supported topology, operator/platform responsibilities, health,
   rollout, and rollback.
5. Commit as a reviewable Conventional Commit.

### Group 2 — PostgreSQL fenced coordinator

1. Add deterministic contract tests for duplicate binding, global/source
   capacity, thread exclusion, cancellation, stale leases, fencing,
   quarantine, recovery, drain, and namespace isolation.
2. Add checked SQL migrations and an explicit one-off migration command.
3. Implement transactional admission and claims with database time.
4. Wire the coordinator around the complete turn pipeline.
5. Add fence-aware history/result/outbox contracts. Do not enable distributed
   runtime mode for a transport or augment until its mutable state passes the
   compatibility gate.
6. Add health and readiness signals without peer or prompt data.

### Group 3 — multi-process and chaos validation

1. Add disposable-PostgreSQL integration tests using
   `AUGGY_TEST_POSTGRES_URL`.
2. Run two real child processes with JSON-line synchronization.
3. Kill or partition at deterministic barriers: before execution, after a
   side effect begins, after durable result, during outbound, and during drain.
4. Assert zero same-thread overlap, zero stale-fence commit, bounded fleet
   capacity, durable quarantine, exact recovery, namespace isolation, and
   correct 429/503 behavior.
5. Run the PostgreSQL suite in a dedicated sequential CI job. Tests remain in
   the canonical inventory and skip only when the explicit database variable
   is absent.

### Group 4 — workload harness and capacity envelope

Add a tracked, secret-free harness with deterministic mock model and tools.

- **Concierge profile:** bursty anonymous sessions, short reads, provider
  latency, reconnects, and operator escalation.
- **Order-support profile:** authenticated sessions, lookup plus one
  idempotent mutation, long-tail provider latency, duplicate delivery, and
  recovery.

Emit JSON containing throughput, active/queued turns, queue-wait percentiles,
rejections, unknown outcomes, duplicate mutations, stale-fence attempts,
outbox lag, and tenant-isolation failures. The initial certification gate is:

- zero duplicate mutations;
- zero same-thread overlap;
- zero accepted stale-fence commits;
- zero cross-namespace reads;
- configured capacity never exceeded;
- overload rejected before streaming begins;
- coordinator outage returns 503 and makes readiness unhealthy;
- p95 queue wait below one second and p99 below five seconds under the declared
  reference profile.

Capacity numbers are certification results for a declared machine, model
latency, and workload. They are not a universal requests-per-second promise.

## Verification gates

After each group:

- run focused `bun:test` suites sequentially;
- run `bun run typecheck` and `bun run lint`;
- inspect `git diff --check` and the complete group diff;
- give the exact diff to a fresh hostile reviewer;
- resolve every confirmed High or Medium issue before continuing;
- record the ending commit SHA.

Final integration additionally runs:

- the canonical runtime inventory;
- console tests and build;
- PostgreSQL integration/chaos tests;
- both load profiles;
- `bun audit --json`;
- `bun run smoke:release`;
- one cross-cutting adversarial review.

## Migration and rollback

Schema changes are applied by an explicit one-off command under a migration
lock. Runtime replicas only boot against the exact compatible schema. Use
expand, deploy compatible code, backfill/verify, then contract in a later
release.

An existing SQLite-backed customer is not migrated in place in the first
distributed release. Provision a new distributed cell, shadow and verify it,
drain the old cell, then cut over.

Rollback drains traffic and retains PostgreSQL coordination data. Never roll
an enabled distributed namespace back to a SQLite-only binary; doing so loses
ownership and idempotency state and can replay effects.

## Explicitly deferred boundaries

The following are required before a general “replica safe” claim, even if the
coordinator core is complete:

- shared fence-aware history and visitor/session persistence;
- shared budget and notification reservation stores;
- Telegram and AgentMail shared replay/ledger adapters;
- transactional delivery outbox and recipient dedupe;
- shared mutable memory backends;
- downstream idempotency for irreversible tools;
- production database backups, restore drills, and key management.

Until those gates pass, deployment documentation continues to require one
replica for the default scaffold.

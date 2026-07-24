# Agent-wide keyed turn scheduler hardening plan

Date: 2026-07-24

Status: approved for implementation on `security/keyed-turn-scheduler`

## Outcome

Replace Auggy's independent per-transport execution queues and unbounded
per-thread promise tails with one bounded, fair, agent-wide scheduler. The
scheduler will preserve per-transport rate and capacity policy, serialize the
complete externally visible lifecycle of one resolved thread, admit unrelated
threads concurrently, cancel work while it is still queued, expose
privacy-safe saturation state, and drain before runtime dependencies shut
down.

This is a single-process correctness and capacity boundary. It does not claim
that replicas of one logical agent can share mutable state safely. Distributed
leases, fencing, shared idempotency, and shared quotas remain a separate
deployment tier.

The design is informed by
[the OpenClaw and Hermes concurrency research](../research/concurrency-scheduling-openclaw-hermes-2026-07-24.md).

## Revalidation result

### Already fixed

The suspected same-thread history/model race is already fixed on the current
default branch. `src/agent.ts` serializes the following region by the resolved
`threadId` for both transport and injected turns:

1. persistent-history ownership check and load;
2. model and tool execution;
3. history compaction and durable commit.

Existing tests prove both same-thread serialization and different-thread
parallelism. This implementation will retain that defense-in-depth boundary;
it will not manufacture a replacement for an already-fixed authorization
finding.

### Confirmed and reachable

1. Each mounted transport owns a separate queue. There is no agent-wide active
   or pending limit.
2. `AgentHandle.inject()` bypasses every transport queue. Concurrent
   different-thread injections are unbounded, while same-thread injections
   build an unbounded promise chain.
3. A same-thread waiter consumes a transport's active slot before it waits for
   the thread lock. A hot thread can therefore block unrelated runnable
   threads.
4. The thread lock releases before outbound delivery and terminal hooks. With
   concurrency above one, a later same-thread model turn can overlap prior
   response delivery and `onTurnEnd`, and responses can be observed out of
   order.
5. Queue and thread-lock waits ignore cancellation. A disconnected queued
   caller remains retained and can later enter persistence and kernel work.
6. Shutdown tears down augments before all queued, active, and post-turn work
   is known to have settled. A queued turn can start against dependencies that
   are stopping or already stopped.
7. Queue settings are not validated as finite integers. Zero or non-finite
   concurrency can hang or defeat admission.
8. The history-manager LRU can evict a manager belonging to an active
   different-thread turn. Later commit code can then reacquire an empty manager
   for the same ID and corrupt the terminal history snapshot.

These are production availability and state-integrity defects. They are not
new cross-peer authorization findings.

## Security and reliability invariant

For one agent process:

- every turn is admitted under one global bounded policy before model, tool,
  persistence, outbound, or hook work begins;
- the canonical resolved `threadId`, never a peer ID or transport routing
  alias, is the serialization key;
- at most one externally visible turn pipeline is active for a thread;
- a same-thread waiter never consumes global or per-source active capacity;
- different runnable threads make fair progress up to the configured global
  and per-source caps;
- global, per-thread, and per-source pending work is finite;
- a caller canceled while queued cannot later execute;
- an active task retains its capacity until its actual promise settles, even
  if its caller cancels;
- outcome-unknown work quarantines the affected thread against blind retry
  until a trusted operator explicitly recovers it;
- active thread history cannot be evicted;
- shutdown closes admission, settles queued callers, drains active complete
  pipelines, and only then shuts down augments and clears runtime state.

## Threat model

### Attacker and load capabilities

- An anonymous or authenticated caller can send many requests, including many
  requests for one thread or many distinct threads.
- Several transports can deliver traffic concurrently.
- An augment can inject background turns.
- A caller can disconnect or abort while queued or active.
- A model, tool, persistence store, outbound adapter, or lifecycle hook can be
  slow, fail, ignore cancellation, or return an outcome-unknown result.
- An operator can configure invalid or mutually constraining queue limits.

### Protected assets

- process memory, event-loop responsiveness, provider concurrency, and spend;
- per-thread transcript order and persistent-history integrity;
- ordering of user-visible responses and terminal side effects;
- availability of unrelated customer conversations;
- augment resources during shutdown;
- operational telemetry that must not expose peer or prompt data.

### Trust transitions

- transport-specific parsing and identity resolution happen before scheduler
  key selection;
- the resolved thread ID crosses into the scheduler as the canonical lane key;
- scheduler admission precedes persistent history, inference, tools, outbound,
  and hooks;
- `SchedulerContext.inject()` is a narrow capability minted for the currently
  active terminal hook and may perform a causal same-thread child turn;
- manual quarantine recovery is a trusted host API, not a transport or model
  decision.

### Deployment boundary

All state in this plan is process-local. Multiple isolated Auggy agents can be
load-balanced as separate cells. Multiple replicas of the same logical agent
remain unsupported unless their mutable stores and coordination boundaries
are replaced by distributed implementations.

## Architecture

### Authoritative scheduler

Add a kernel-owned keyed scheduler with:

- a configurable agent-wide active cap;
- global and per-thread pending caps;
- per-source active and pending caps derived from each transport's existing
  `concurrency` and `maxQueueDepth` settings;
- one FIFO queue per resolved thread;
- round-robin selection across runnable thread keys;
- queued `AbortSignal` removal;
- accepting, draining, and stopped states;
- a synchronous privacy-safe snapshot;
- monotonic admitted, completed, rejected, canceled, and quarantined counters.

The scheduler chooses a runnable thread before consuming a global or source
active slot. A same-thread waiter is counted as pending, never active. This
avoids the head-of-line defect caused by placing a semaphore outside the
existing thread lock.

Per-peer rate limiting remains source-specific but becomes an admission check,
not a second execution queue. Existing transport settings remain valid.

### Complete-turn ordering and causal injection

The scheduler lane covers:

1. history authorization/load;
2. turn execution;
3. history compaction/commit;
4. outbound delivery;
5. `onTurnEnd`;
6. `scheduleAfterTurn`.

Holding a normal non-reentrant lane across `scheduleAfterTurn` would deadlock
the shipped layered-memory hook, which awaits a same-thread `ctx.inject()`.
Instead, the scheduler gives the active task an unforgeable in-process lease.
Only the `SchedulerContext` minted inside that task can use the lease for a
causal child with the same canonical thread key. The child executes inline
under the parent's occupied global/source slot, then returns to the parent
hook. A different-thread injection or an injection after the lease is revoked
uses normal admission.

Causal depth is finite. A misbehaving recursive hook is rejected rather than
growing the stack or bypassing queue bounds indefinitely. A parent lease also
admits only one direct causal child at a time; overlapping siblings fail closed
instead of running same-thread history concurrently.

### Outcome-unknown quarantine

Add an explicit outcome-unknown marker to terminal results. If a task throws an
`OutcomeUnknownError` or returns that marker, its scheduler lease quarantines
the thread before releasing capacity. Later work for that thread is rejected
without model or tool execution. A trusted `AgentHandle` recovery method
clears the quarantine after the operator has reconciled external state.

No timeout causes an active slot to be released early merely because an abort
was requested. If an operation ignores cancellation, the scheduler owns and
joins that detached promise before releasing the slot. The timeout remains
visible through the outcome-unknown marker and quarantine, so the same thread
cannot be retried while the first attempt may still be running.

### Active-history pinning

Extend the history-manager cache with reference-counted thread pins. Pinned
entries are excluded from LRU eviction. The complete core turn acquires and
releases a pin in `finally`. If all 500 resident entries are pinned, creating a
new manager fails closed instead of evicting active state.

### Configuration and defaults

Add `settings.turnScheduling` / `AgentConfig.turnScheduling`:

```yaml
settings:
  turnScheduling:
    maxConcurrent: 4
    maxQueued: 100
    maxQueuedPerThread: 20
    maxCausalDepth: 8
```

Defaults are finite: 4 active turns, 100 globally queued turns, 20 queued
turns per thread, and 8 causal levels. Values are validated as safe integers;
queue limits may be zero, while active concurrency and causal depth must be at
least one. Per-thread queued capacity cannot exceed global queued capacity.

Transport `concurrency`, `maxQueueDepth`, and `rateLimitPerPeer` remain
source-specific controls. Web's default source concurrency will be raised to
four so different website conversations can use the safe agent-wide default;
operators can lower either boundary.

### Observability

Extend `AgentHealth` with a scheduler snapshot containing only aggregate
gauges, counters, state, and oldest wait duration. Thread IDs, peer IDs,
prompts, and source names are not included.

The initial web SSE contract will expose stable scheduler rejection codes.
Returning a true HTTP `429` or `503` before an SSE response is opened requires
a separate synchronous reservation contract between transports and the
kernel. That transport API change is not required to make admission bounded
and will be documented as residual follow-up rather than simulated with a
misleading post-stream status.

## Implementation slices

### Slice 1 — executable scheduler regressions

Add deterministic `bun:test` coverage using deferred barriers, not timing-only
sleeps:

- same-thread FIFO and exclusion;
- different-thread concurrency;
- head-of-line avoidance;
- round-robin fairness;
- global, per-thread, and per-source boundaries;
- zero pending-cap boundary;
- queued cancellation and abort/dequeue races;
- release after return, throw, rejection, and active cancellation;
- close, drain, restart, metrics, and configuration validation;
- outcome-unknown quarantine and explicit recovery.

The tests should fail against the current queue/thread-tail architecture or
exercise the new scheduler directly before it is wired into the agent.

### Slice 2 — scheduler kernel

Implement the scheduler, source-specific admission policies, stable rejection
reasons, causal leases, quarantine, drain, and privacy-safe snapshots. Replace
the legacy execution queue rather than nesting the scheduler under it.

### Slice 3 — agent integration and history integrity

Route every transport and `AgentHandle.inject()` through the same scheduler.
Move the complete externally visible terminal pipeline inside the keyed lane,
mint the causal injection capability, pin active histories, and change stop
ordering to close/drain before lifecycle shutdown and state clearing.

Integration tests will cover:

- two transports plus injection sharing one global cap;
- same-thread ordering through slow outbound and `onTurnEnd`;
- causal scheduled injection without deadlock or overtaking;
- cancellation before any persistence/model work;
- shutdown with active and queued turns;
- more than 500 resident histories while an older thread is active.

### Slice 4 — public contracts and operator configuration

Add public types, CLI YAML parsing and validation, scaffold comments, health
snapshot, trusted recovery API, stable rejection classification, and focused
contract tests. Preserve durable web-idempotency followers: followers join the
leader before scheduler admission and do not consume turn capacity.

### Slice 5 — documentation and migration guidance

Update kernel, transport, lifecycle, type, architecture, diagram, and testing
documentation. Document:

- defaults and tuning;
- source versus agent-wide limits;
- overload and cancellation behavior;
- quarantine recovery;
- the single-process deployment boundary;
- why sticky routing alone is not replica correctness;
- rollback implications.

## Adversarial review gates

A fresh reviewer will receive the exact completed diff and check for:

- keys derived from peers, aliases, source, context, or task IDs;
- global slots acquired before a thread is runnable;
- hidden per-thread or per-source unbounded queues;
- cancellation listeners retained after settlement;
- abort races that execute a dequeued canceled item;
- fail-open invalid configuration;
- a lane released before outbound or terminal hooks;
- same-thread causal injection deadlocks or forged/reused leases;
- recursion that bypasses causal bounds;
- outcome-unknown work that silently resumes;
- shutdown that races active work;
- active history eviction;
- mutable or high-cardinality telemetry;
- compatibility behavior that restores independent transport execution.

Confirmed High or Medium findings will be fixed and the review repeated.

## Verification gate

Run, at minimum:

```text
bun test tests/kernel/keyed-turn-scheduler.test.ts
bun test tests/kernel/agent-scheduler.test.ts
bun test tests/kernel/thread-history-persistence.test.ts
bun test tests/kernel/schedule-after-turn.test.ts
bun test tests/agent.test.ts
bun test tests/transports/web-idempotency.test.ts
bun test tests/transports/web-transport.test.ts
bun test tests/integration/multi-transport.test.ts
bun test tests/cli/config-parser.test.ts
bun run typecheck
bun run lint
git diff --check
```

Run the complete tracked runtime suite in sequential shards if needed. Run
`bun run smoke:release` because public types, CLI configuration, scaffolds, and
packed runtime behavior change. Dependencies are not expected to change, so
`bun audit --json` is informational rather than a dependency-change gate.

Before pushing, inspect the full branch diff, package contents, secret-bearing
fixtures/logs, and worktree status. Preserve the unrelated untracked
`order-support/` directory.

## Compatibility, rollback, and residual risk

- Raising default web concurrency changes execution timing across different
  threads, while same-thread order becomes stricter. Operators can set web
  concurrency to one for the prior behavior.
- Calls canceled while queued will no longer run later.
- `stop()` can take longer because it waits for genuinely active work before
  shutting dependencies down. Queued work is settled immediately.
- Quarantined threads survive `stop()`/`start()` on the same `AgentHandle` and
  require explicit reconciliation and trusted recovery.
- A brand-new process loses in-memory quarantine state. Deployments that must
  preserve this boundary across process replacement need a future shared,
  durable quarantine store; until then, restart is an explicitly documented
  operational fail-open risk for outcome-unknown threads.
- The in-memory quarantine key set is intentionally not evicted: automatic
  eviction would fail open. An attacker able to force outcome-unknown results
  across many unique threads can therefore create unbounded quarantine
  metadata. A durable bounded store or agent-level circuit breaker is future
  work.
- Durable HTTP idempotency abandonment is replayed exactly to same-process
  followers. A follower in another unsupported replica may observe the absent
  transient claim as outcome-unknown; cross-process admission and replay
  require the future shared coordination boundary.
- True pre-stream HTTP overload statuses remain a transport API follow-up.
- Horizontal replicas of one logical agent remain unsupported.

Rollback is code-only: restore the prior agent and queue implementation and
remove the new optional settings. No persistent-data migration is introduced.

## Deferred follow-up work

After this PR:

1. Telegram conflict quarantine and operator recovery.
2. CI test-surface inventory enforcement.

These will use the same revalidation, delegated analysis, incremental tests,
adversarial diff review, verification, and focused-PR loop. They are not mixed
into the scheduler branch.

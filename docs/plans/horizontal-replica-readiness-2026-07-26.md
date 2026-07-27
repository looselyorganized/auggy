# Horizontal Replica Readiness Plan

**Date:** 2026-07-26

**Status:** approved scope; implementation in progress; runtime remains disabled

**Branch:** `production/horizontal-replica-readiness`

**Depends on:** the single-replica production work merged through PR #165 and
the disabled PostgreSQL coordination foundation merged in PR #163

**Inputs:**
[`distributed-coordination-2026-07-24.md`](./distributed-coordination-2026-07-24.md),
[`distributed-coordination-implementation-report-2026-07-24.md`](./distributed-coordination-implementation-report-2026-07-24.md),
and
[`concurrency-scheduling-openclaw-hermes-2026-07-24.md`](../research/concurrency-scheduling-openclaw-hermes-2026-07-24.md)

## Product decision

Auggy will support multiple runtime replicas serving one logical agent behind
an operator-owned load balancer. This is a distributed-runtime capability, not
a managed Auggy platform.

The boundary is:

> Auggy owns correctness under arbitrary routing. The deployer owns running and
> routing the infrastructure.

Auggy therefore owns cross-replica admission, thread exclusion, request
binding, shared runtime state, fencing, durable result replay, delivery
ambiguity, job claiming, readiness, draining, and recovery semantics. The
deployer owns the load balancer, PostgreSQL service, TLS and network policy,
secrets, replica count, autoscaling policy, backups, rollout automation,
monitoring, and SLOs.

Auggy will not provision infrastructure, place replicas, operate a hosted
control plane, manage tenant accounts, supply billing, or promise a universal
capacity number. Supporting replicas does not change Auggy's product identity:
it remains an embeddable agent runtime and capability system.

## Supported topology target

The first supported distributed topology is deliberately narrow:

- two or more replicas of one immutable Auggy agent namespace;
- one region and one authoritative PostgreSQL primary;
- homogeneous, schema-compatible runtime versions during steady state;
- arbitrary request routing, with affinity permitted only as an optimization;
- independent local executors bounded again by fleet-wide admission;
- a dedicated database and least-privilege role, or an equivalently enforced
  schema boundary, for Auggy-owned distributed state;
- operator-provisioned health-aware load balancing and graceful connection
  draining; and
- only augments whose replica-safety declaration and startup preflight pass.

Running a single replica against the PostgreSQL profile is also supported. It
is the recommended way for a new deployment to remain scale-ready before it
needs a second replica.

The following remain outside the first claim:

- active-active multi-region writes;
- transparent regional failover;
- a shared filesystem as a consistency mechanism;
- exactly-once effects in downstream systems without idempotency support;
- migration of arbitrary third-party augment state;
- durable replay of individual model/tool steps inside one turn; and
- business workflow orchestration, compensation graphs, or human approvals.

Those exclusions do not weaken the replica contract. Unsupported components
make distributed startup fail closed instead of silently falling back to
process-local state.

## Current-state revalidation

The PostgreSQL coordinator in `src/coordination/` is a tested but disabled
foundation. It already provides bounded admission, immutable source policies,
database-time leases, monotonic per-thread fences, pre-execution requeue,
post-execution outcome-unknown quarantine, compare-and-set recovery, instance
drain, and namespace isolation.

It is intentionally not connected to `defineAgent`. Current startup enumerates
the missing shared boundaries and rejects `settings.coordination` before boot.
That rejection is correct and remains in place until the final enablement
checkpoint.

The remaining risks are confirmed in current source:

- `src/agent.ts` keeps thread tails, resident history associations, unmanaged
  ownership, scheduler queues, quarantine, and lifecycle state in one process;
- `ThreadHistoryPersistence` has no expected revision or fencing token;
- web execution idempotency and rate limiting are SQLite-backed;
- budgets, notification delivery, visitor state, console conversations,
  Telegram replay, AgentMail ingress, Link state, and Durable Jobs use local
  mutable stores;
- layered-memory extraction buffers are process-local and the default durable
  store is SQLite;
- the response, history commit, hook pipeline, and outbound delivery are not a
  single fenced durable transition;
- a queued coordinator row does not durably own the request payload, so an
  abandoned HTTP queue entry needs explicit expiry/adoption semantics;
- the coordinator does not yet retain bounded replayable terminal results;
  and
- the generated Railway deployment deliberately enforces one live volume
  owner and one replica.

Enabling replicas around only the existing coordinator would permit stale
history commits, duplicated limits, lost replay state, competing pollers,
duplicated schedules, and ambiguous outbound effects. A load balancer or
sticky sessions cannot repair those failures.

## Security and reliability invariants

1. The agent namespace is immutable, canonical, and selected only by trusted
   configuration. A request cannot select or alter it.
2. Every process receives a fresh server-minted instance ID and registers its
   build, protocol, configuration fingerprint, health, and drain state.
3. Global and source capacity is reserved before execution. Local scheduler
   limits are an additional bound and never multiply the configured fleet
   limit.
4. One canonical namespace/thread has at most one active root pipeline across
   the fleet, including its outbound work, terminal hooks, and causal child
   turns.
5. Every active root pipeline owns a database-time lease and a monotonically
   increasing thread fence. A stale owner cannot commit any Auggy-owned
   authoritative state.
6. Request IDs and idempotency keys bind immutably to canonical source, peer,
   thread, authorization context, request content, and execution kind.
7. Concurrent duplicates join the same execution. Completed duplicates replay
   one bounded sanitized result. Changed bindings conflict.
8. Expiry before execution starts is safely adoptable or removable. Expiry
   after execution starts becomes outcome-unknown and quarantines the thread;
   it is never automatic retry permission.
9. History ownership is checked before model-visible history is loaded. Every
   history commit compares namespace, thread, peer, expected revision, active
   fence, and lease identity.
10. History revision, bounded result, cost commitment, and outbound intent are
    committed through one fenced transition. Final coordinator completion
    occurs exactly once after the root pipeline settles, or the pipeline is
    conservatively classified ambiguous.
11. Coordinator loss closes admission and readiness, aborts cooperative work,
    and never falls back to a local correctness boundary.
12. Pollers, schedule materializers, job workers, replay ledgers, quotas, and
    delivery workers are shared, leased, and namespace-scoped.
13. Queue, result, event, audit, replay, history, memory, and outbox retention
    are explicitly bounded.
14. Recovery is authenticated, audited, compare-and-set, and cannot authorize
    an old worker to continue.
15. Missing or unverified replica-safety metadata on an enabled augment makes
    distributed startup fail closed.
16. Sticky routing, a shared volume, local locks, hostnames, process clocks,
    and remote provider annotations are never authority.

## Architecture decisions

### One PostgreSQL correctness substrate

Use PostgreSQL for the first distributed profile rather than introducing
Redis, a second queue, or a new hosted service. PostgreSQL can atomically bind
admission, leases, history revisions, terminal results, budgets, replay
records, job claims, and delivery intent. This keeps the operator contract
portable and makes one transaction the strongest practical Auggy-owned
boundary.

Process memory may still cache immutable configuration, provider metadata, and
validated history snapshots. A cache is never authoritative and must be
revision-checked or discarded at the end of a distributed turn.

### Local scheduler plus fleet coordinator

Keep `KeyedTurnScheduler` as the bounded executor inside each process. Place the
distributed coordinator around the entire root turn pipeline, not only model
inference. The distributed lease covers:

```text
identity binding
  -> fleet admission
  -> local admission
  -> distributed claim/fence
  -> history load
  -> model and tools
  -> history/result/cost/outbox commit
  -> outbound settlement
  -> terminal hooks and causal children
  -> distributed terminal state
```

Causal same-thread children inherit the root lease and receive derived
server-minted operation IDs. They do not try to acquire a competing thread
lease. A crash makes the complete root pipeline ambiguous.

Queued HTTP requests remain attached to the serving process because Auggy will
not persist arbitrary request bodies merely to move them between replicas. A
queue-owner heartbeat and bounded expiry prevent dead rows. A retry with the
same binding can adopt safe pre-execution work. Durable sources such as jobs,
Telegram, and AgentMail persist their bounded payloads in their source ledger
and may be claimed by another replica.

### Fenced turn commit

Add a shared turn-state contract that can atomically commit an execution
checkpoint containing:

- the next peer-bound history revision;
- one bounded replay result or result reference;
- exactly-once inference cost/accounting state;
- transactional outbound intents; and
- a coordinator state transition that retains the active thread fence through
  required post-turn work.

The commit requires the current namespace, request, instance, attempt, thread,
fence, binding hash, and expected history revision. Zero affected rows is a
stale-owner failure, never success.

External effects remain a separate boundary. First-party effecting tools and
delivery adapters receive a stable, server-minted operation key. When a sink
supports idempotency, Auggy uses it. When it does not, loss of acknowledgement
after dispatch becomes outcome-unknown and requires reconciliation.

### Replica-safety contract for augments

Each augment must declare one reviewed topology class:

- `stateless`: no authoritative mutable state across calls;
- `shared`: authoritative state is in a namespace-scoped atomic store;
- `fence-aware`: commits also validate the active distributed fence;
- `leader-owned`: one leased fleet owner runs the activity and standbys may
  take over; or
- `unsupported`: distributed startup must reject it.

No declaration also means unsupported. Built-in declarations are backed by
tests and store preflight; they are not documentation-only assertions.
Third-party augment code is already trusted application code, but its topology
declaration remains explicit and operator-visible.

Read-only skills and immutable image assets are safe. Writable local
filesystems, SQLite databases, stdio MCP servers with local state, and shell
workspaces are not coherent across replicas and must be rejected or configured
as explicitly replica-private, non-authoritative facilities. A shared POSIX
volume does not change that decision.

### Load-balancer and stream behavior

The load balancer may route every new request to any ready replica. Auggy will
provide documented endpoints and examples; it will not implement the load
balancer.

- liveness reports only that the process is alive;
- readiness requires compatible schema, coordinator connectivity, a registered
  accepting instance, and successful store preflight;
- drain stops new admissions before readiness is removed;
- SIGTERM durably marks the instance draining, stops poller/job claims, waits
  for bounded owned work, and conservatively settles interrupted work;
- HTTP and SSE responses remain on the accepting replica for the life of the
  connection;
- completed keyed requests are replayable from any replica; and
- proxy timeouts, SSE buffering, maximum request duration, and connection
  drain settings are documented for common platforms.

Affinity can reduce database contention for active conversations, but tests
must pass with random routing and no affinity.

## Mutable-state disposition

| Boundary | Distributed implementation | Enablement rule |
| --- | --- | --- |
| Fleet admission and thread lanes | Existing PostgreSQL coordinator, extended with instance registration, queue ownership, bounded cleanup, and status/result reads | Required |
| Thread ownership and history | PostgreSQL peer binding, revision, lease, and fence-aware snapshot commits | Required |
| Web idempotency and rate limits | PostgreSQL claims, immutable binding, waiter joins, bounded result replay, and atomic rate reservations | Required for web transport |
| Visitor assertions and sessions | Shared replay, revocation, rate, and session stores; signed data remains stateless where safe | Required when enabled |
| Budgets and cost accounting | PostgreSQL atomic reservation and exactly-once terminal cost commit | Required when enabled |
| Layered memory | Shared PostgreSQL or verified Supabase storage plus shared extraction/dedupe state | Required when mutable memory is enabled |
| Console chat and overrides | PostgreSQL conversation store; immutable config or shared versioned overrides | Required when console mutation is enabled |
| Notifications and outbound responses | Transactional outbox, stable operation IDs, leased delivery, and ambiguity quarantine | Required when outbound delivery is enabled |
| Telegram | Shared replay/quarantine plus a per-bot polling lease; webhook mode uses atomic update claims | Required when enabled |
| AgentMail | PostgreSQL inbox ledger, checkpoint, leases, fences, quarantine, and recovery | Required when enabled |
| Link | Shared invocation/idempotency state and propagated operation identity | Required when stateful Link behavior is enabled |
| Durable Jobs and schedules | PostgreSQL job store, database-time claims, fenced workers, unique schedule occurrences, and leaderless or leased materialization | Required when `settings.jobs` is enabled |
| Writable filesystem, bash, and local stdio MCP | No general distributed state guarantee | Reject unless explicitly non-authoritative and replica-safe |
| Read-only assets and stateless remote providers | Per-process clients/caches allowed; no authority in cache | Permit after preflight |

## Failure semantics

| Failure point | Required outcome |
| --- | --- |
| Replica dies while queued | Queue ownership expires; a matching retry may adopt or the bounded record is removed |
| Replica dies after claim but before execution start | Lease expires and the request may safely receive a new fence |
| Replica dies after execution starts | Thread and request become outcome-unknown; no automatic replay |
| Commit succeeds but client disconnects | Retry reads and replays the committed result from any replica |
| Database becomes unavailable before execution | Return unavailable, remove readiness, and perform no model/tool work |
| Database becomes unavailable during execution | Abort cooperative work; if effect absence cannot be proven, quarantine |
| Delivery acknowledgement is lost | Use recipient idempotency to reconcile when available; otherwise quarantine the delivery intent |
| Old replica resumes after lease expiry | Every authoritative write fails its fence/owner comparison |
| Rolling deploy introduces incompatible protocol | New instance refuses admission and reports a secret-free compatibility error |
| Schedule materializers race | Unique namespace/schedule/version/occurrence binding produces one job |
| Polling transport owners race | One live source lease polls; atomic replay claims prevent duplicate execution after takeover |

## Implementation program

The existing startup rejection remains the safety catch throughout checkpoints
1-10. Checkpoint 11 is the only change allowed to make a replica-safe profile
start successfully.

### 1. Public topology and compatibility contract

- Define fleet-wide versus per-process capacity semantics.
- Extend coordination configuration with bounded local executor limits,
  retention, result caps, and a protocol/configuration fingerprint.
- Add augment replica-safety metadata and a complete built-in support matrix.
- Replace the coarse blocker list with evidence-producing component preflight.
- Keep distributed startup rejected and test every unsupported combination.

The compatibility projection must bind a code-owned component identifier and a
source-owned, secret-free semantic identity. Removing a component's final
blocker requires an option-sensitive verifier for every backend/store choice
that must be homogeneous across replicas. Operator-authored evidence is never
startup authority.

### 2. Coordinator lifecycle and request ownership

- Register fresh instances and enforce compatible fleet/configuration state.
- Add queue ownership heartbeat, safe adoption, abandonment, and cleanup.
- Add bounded request status, waiter, terminal-result, event, and retention APIs.
- Make drain and coordinator loss propagate to owned cancellation signals.
- Preserve database-time leases and monotonic fences.

### 3. Runtime pipeline wiring

- Wrap the complete root turn pipeline in distributed admission and fencing.
- Reconcile local scheduler and fleet capacity without deadlocks or limit
  multiplication.
- Mark execution started immediately before inference or tool dispatch.
- Propagate stable attempt, fence, and downstream operation identities through
  trusted execution/tool contexts.
- Keep causal children within the root lease and quarantine the root on
  ambiguity.

### 4. Shared history, result replay, and atomic turn commit

- Introduce revision/fence-aware `ThreadHistoryPersistence` contracts.
- Implement peer-bound PostgreSQL history with compare-and-set writes.
- Add bounded sanitized result replay and exact binding conflict behavior.
- Commit history, result, cost marker, outbox intent, and the post-execution
  coordinator checkpoint through one fenced transaction boundary; retain the
  lease until required post-turn work settles.
- Prevent resident process caches from serving an unverified revision.

### 5. Shared admission, identity, quotas, and memory

- Port web idempotency/rate limits, visitor replay/revocation/session state,
  budgets, cost accounting, and notification quotas to PostgreSQL contracts.
- Add shared layered-memory extraction/dedupe buffers and a supported shared
  memory adapter.
- Audit Supabase operations for namespace, peer, atomicity, and fencing needs.
- Provide startup rejection for remaining local mutable adapters.

### 6. Transactional outbound delivery

- Add namespace-scoped outbox rows in the fenced turn commit.
- Claim deliveries with leases and stable operation keys.
- Separate confirmed failure from unknown effect and from confirmed delivery.
- Add authenticated compare-and-set recovery and bounded audit/retention.
- Make retries depend on sink idempotency evidence, never elapsed time alone.

### 7. Telegram and AgentMail ownership

- Add per-provider identity leases, shared replay ledgers, and takeover rules.
- Port Telegram conflict quarantine/recovery and AgentMail ingress/checkpoints
  to PostgreSQL.
- Ensure polling offsets cannot skip uncommitted source records.
- Fence stale consumers before turn execution and terminal source writes.
- Test webhook/polling duplication, takeover, delayed delivery, and compromised
  authenticated-source offset influence.

### 8. PostgreSQL Durable Jobs and schedules

- Implement the existing `DurableJobStore` contract on PostgreSQL.
- Use database time, fenced claims, stable job operation IDs, bounded retry,
  and outcome-unknown quarantine.
- Materialize each schedule occurrence exactly once using a transactional
  uniqueness boundary; no process-local cron leader is correctness-critical.
- Make jobs a coordinator source with explicit fleet capacity.
- Add shared CLI inspection, cancellation, retry, reconciliation, and pruning.

### 9. Console, admin, Link, and remaining built-ins

- Move console conversation state and mutable admin overrides to shared stores
  or reject them in distributed mode.
- Port Link's stateful safety boundary and propagate downstream operation IDs.
- Classify filesystem, bash, MCP modes, file memory, and every shipped augment.
- Add a test that fails whenever a new augment lacks topology classification.
- Produce an operator-readable compatibility report without secrets.

### 10. Fleet operations and migration safety

- Add readiness, drain, instance, backlog, quarantine, outbox, and schema
  health surfaces with bounded labels.
- Add `auggy coordination status`, `drain`, `recover`, `prune`, and preflight
  controls with authenticated/audited mutations.
- Support expand/deploy/backfill/contract migrations and declare runtime/schema
  compatibility ranges.
- Add a database-enforced protocol/session fence before permitting rolling
  mixed-version coordinator operation. Until then, preview schema migrations
  require every older coordinator client to be quiesced first.
- Document fresh PostgreSQL deployment, single-to-distributed cutover, rollback,
  backup/restore ordering, and global restore fencing.
- Provide load-balancer examples without coupling correctness to a vendor.

### 11. Multi-process certification and enablement

- Run two and three real Auggy processes against PostgreSQL behind random
  routing, not a reference model.
- Exercise HTTP/SSE, same-thread serialization, cross-thread concurrency,
  idempotency joins/replay, budgets, memory, outbound delivery, polling
  takeover, jobs, schedules, drain, restart, and rolling deployment.
- Inject deterministic failures before execution, after effect start, before
  and after commit, during delivery, during database loss, and during drain.
- Add soak profiles for concierge, order support, scheduled internal work, and
  a mixed general-agent workload.
- Publish measured envelopes only for declared hardware, PostgreSQL, model
  latency, and workload parameters.
- Enable `settings.coordination` only for a preflight-proven profile and update
  every single-replica warning, scaffold, feature table, and deployment guide.

## Dependency and PR shape

This should not be one unreviewable change. Use sequential, mergeable PRs while
the startup guard keeps behavior disabled:

1. topology contract and coordinator lifecycle;
2. runtime wiring plus fenced history/result commit;
3. shared admission, identity, quota, memory, and console state;
4. transactional outbox plus notification delivery;
5. Telegram, AgentMail, and Link coordination;
6. PostgreSQL Durable Jobs and schedules;
7. fleet operations, certification, documentation, and final enablement.

Each PR starts from the latest green `main`. If an intermediate PR cannot be
merged independently, it is stacked explicitly and its dependency is recorded.
No intermediate PR claims replica support. The final PR cannot enable the mode
until every configured component passes preflight and the complete
multi-process gate.

## Required engineering loop

For each implementation checkpoint:

1. Revalidate the affected source and state the exact invariant.
2. Threat-model attacker capability, crash boundaries, races, stale owners,
   parser/canonicalization differences, deployment behavior, and rollback.
3. Delegate bounded read-only exploit/failure, compatibility, and test
   analysis to specialized agents when parallel work is useful.
4. Add a failing deterministic regression or multi-process reproducer.
5. Implement the smallest complete boundary in reviewable Conventional
   Commits.
6. Add negative, stale-fence, duplicate, outage, restart, capacity, namespace,
   and secret-redaction tests.
7. Give the exact completed diff to a fresh hostile reviewer. Independently
   verify every finding and repeat until no confirmed High or Medium issue
   remains in scope.
8. Run focused `bun:test` suites, `bun run typecheck`, `bun run lint`, canonical
   sequential runtime shards, admin tests/build when relevant, PostgreSQL
   integration tests, `git diff --check`, and secret inspection.
9. Run `bun audit --json` when dependencies change and
   `bun run smoke:release` when public types, configuration, CLI, scaffolds,
   packages, generated assets, or release contents change.
10. Record the checkpoint SHA, exact evidence, compatibility impact, rollback,
    residual risk, and any disproven finding before proceeding.

Port-heavy suites remain sequential or bounded because Bun 1.3.14 has shown
suite-scale `EADDRINUSE`. PostgreSQL integration tests use deterministic
barriers and a dedicated CI service, not timing-only sleeps.

## Certification gates

Replica support is complete only when all of the following pass:

- zero same-thread overlap under random routing;
- zero stale-fence authoritative commits;
- zero cross-namespace or cross-peer reads;
- zero duplicate confirmed mutations in idempotency-capable sinks;
- configured global/source/thread capacity is never exceeded;
- duplicate requests join or replay across different replicas;
- pre-start crashes safely requeue and post-start crashes quarantine;
- coordinator loss returns unavailable before execution and removes readiness;
- rolling drain admits no new work to the draining instance;
- Telegram, AgentMail, notification, and job takeovers do not blindly replay
  ambiguous work;
- schedule races materialize one occurrence;
- every local-only mutable augment fails distributed preflight;
- queue/result/event/history/outbox retention remains bounded under soak;
- all repository, PostgreSQL, admin, release-smoke, audit, and packaging gates
  pass; and
- operator documentation can deploy the profile behind a generic load
  balancer without relying on sticky routing.

## Migration and rollback

Local SQLite mode remains supported for one replica. Distributed mode uses a
fresh PostgreSQL namespace initially; the implementation must not reinterpret
or concurrently mount existing SQLite state.

Before the general replica-safe claim, provide an offline, integrity-checked
cutover for supported built-in stores or clearly require a new deployment.
Because the repository has no production users yet, no speculative online
dual-write migration is required. New deployments that expect to scale should
start with the PostgreSQL profile even at one replica.

Database migrations are explicit and checksum-verified. Use expand, deploy
compatible code, backfill and verify, then contract in a later release. A
rollback drains the fleet and preserves the PostgreSQL state. Never start a
single-replica SQLite binary against a namespace that has accepted distributed
traffic; doing so discards authoritative request, fence, replay, and delivery
state.

## Definition of done

The work is done when a documented two- or three-replica deployment can serve
one logical Auggy through arbitrary load-balancer routing, survive deterministic
process loss without duplicate or stale Auggy-owned commits, recover through
audited controls, execute shared durable jobs and schedules, and refuse every
configuration whose mutable state is not replica-safe.

It is not done merely because multiple processes start, share PostgreSQL, pass
a synthetic coordinator model, or appear stable under sticky sessions.

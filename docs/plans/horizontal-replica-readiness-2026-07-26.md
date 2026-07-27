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
foundation. Checkpoints 1 through 4 provide bounded admission, immutable source
policies, one-use process sessions, process-owned queues, database-time leases,
namespace-wide monotonic fences, pre-execution adoption, bounded terminal
replay and events, post-execution outcome-unknown quarantine, compare-and-set
recovery, cooperative cancellation, instance drain, namespace isolation, and a
fenced root-pipeline integration. The private integration additionally reloads
peer-bound PostgreSQL history on every root and atomically commits its next
history revision, sanitized replay, exact-known cost marker, staged outbox
intent, and terminal request state.

The integration is consumed internally by `defineAgent` only when the private
test adapter is attached. The adapter and coordinator runtime are absent from
all package exports. Ordinary startup still enumerates the missing shared
boundaries and rejects `settings.coordination` before boot or listener
registration. That rejection is correct and remains in place until the final
enablement checkpoint.

The remaining risks are confirmed in current source:

- `src/agent.ts` keeps thread tails, resident history associations, unmanaged
  ownership, scheduler queues, quarantine, and lifecycle state in one process;
- legacy `ThreadHistoryPersistence` has no expected revision or fencing token
  and is therefore rejected by the distributed integration;
- web execution idempotency and rate limiting are SQLite-backed;
- budgets, notification delivery, visitor state, console conversations,
  Telegram replay, AgentMail ingress, Link state, and Durable Jobs use local
  mutable stores;
- layered-memory extraction buffers are process-local and the default durable
  store is SQLite;
- arbitrary custom hook/tool effects remain outside the coordinator transaction
  unless their augment honors fenced operation identities;
- a queued coordinator row does not durably own the request payload, so an
  abandoned HTTP queue entry needs explicit expiry/adoption semantics;
- real transports do not yet mint and propagate source-stable distributed
  request identities; and
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

**Implementation status:** complete on the disabled coordinator boundary;
runtime integration remains blocked on checkpoints 3 and 4.

The implemented lifecycle contract has these consequences:

- `instanceId` names a fresh process start and a private session token fences
  every mutation. Reusing an instance ID after a crash is an operator/config
  error; a different live instance can prune its expired record.
- `buildFingerprint` is secret-free diagnostic evidence. Exact build equality
  is deliberately not compatibility authority because compatible rolling
  builds may differ. The code-owned protocol fingerprint and source-owned
  configuration fingerprint are the fail-closed semantic authority.
- Fleet capacity, source limits, retention, replay size, protocol/configuration
  fingerprints, and lease duration are independently persisted and compared;
  a caller cannot pair a valid fingerprint with drifted operational policy.
- A queued HTTP request remains attached to its accepting process while that
  queue lease is live. An exact retry may adopt it after expiry. Cleanup or
  drain may instead terminalize an abandoned queue row as `canceled`; later
  retries then observe that retained terminal state rather than silently
  executing it.
- Started work that loses its owner becomes `outcome_unknown`, retains its
  incident event, and blocks that thread until an operator reconciles the exact
  fence. Recovery transitions the incident to ordinary `failed`, emits a
  fixed-code audit event, and only then permits bounded cleanup.
- Unresolved incidents are never pruned. New admission fails with
  `incident-capacity` once the configured incident bound is reached; already
  active turns can add at most the configured fleet concurrency beyond that
  threshold before admission closes.
- Terminal request/result retention is also the idempotency replay horizon.
  Inside the horizon, an exact duplicate replays and a changed binding
  conflicts. After pruning, the request ID is missing and must not be reused;
  trusted integrations must mint globally unique request IDs and choose a
  retention window longer than their maximum retry horizon.
- Event cursors are canonical non-negative PostgreSQL bigint strings. Pages are
  bounded, event fields and reasons are fixed secret-free codes, and event
  pruning cannot remove the evidence for an unresolved incident.
- Fences are allocated monotonically for the namespace, not reset with an idle
  thread row. This permits bounded thread cleanup without making an old fence
  valid again when the same thread ID later returns.
- Local abort signals are cooperative cancellation only. Database sessions,
  owner tokens, and fences remain authoritative when work ignores an abort.

The lifecycle and replay/fence schema migrations reject mutation shapes from
older coordinator clients. Checkpoint 3 adds protocol v4 and a single
code-owned v3 predecessor transition, but that transition still requires all
older preview clients and pending work to be quiescent. A rollback likewise
drains the fleet and preserves the database; it does not run an older client
against an upgraded namespace. The schema migration temporarily permits a null
lease policy only for an existing quiesced preview namespace; the first
registered current process fills it under the namespace row lock, and every
ordinary operation fails closed while it is absent.

Checkpoint 3 must still prove that every real execution crosses
`markExecutionStarted` immediately before inference or an effect and that the
returned ownership signal reaches every cancellable runtime boundary. The
runtime integration must also run an authority heartbeat on an independent
deadline: cancellation cannot depend on a potentially hung PostgreSQL query
eventually returning. A never-resolving database-operation test is required.

Checkpoint 10 must make bounded `prune` maintenance mandatory, observable, and
restart-safe, with a documented cadence and maximum cleanup lag. The low-level
API intentionally does not start a hidden timer, and no production caller
exists while distributed startup is disabled. The startup rejection remains
the enforcement preventing this low-level contract from being mistaken for
supported horizontal operation.

**Checkpoint 2 record:** implementation commit `d409861`.

- Focused in-memory/compatibility verification: 26 tests, 188 assertions.
- Clean PostgreSQL 16 verification: 23 tests, 156 assertions, including real
  multiprocess registration/claiming and parent-owned migration setup.
- Adjacent topology, configured-augment, secure-URL, coordination CLI, startup,
  and deployment contracts passed. The enforced test inventory covered 282
  runtime, 29 console, and 3 isolated external test files across 14 shards.
- `bun run test:runtime` passed through the canonical sequential shard runner;
  `bun run typecheck`, `bun run lint`, and `bun run smoke:release` passed. Lint
  reported only the pre-existing informational Biome schema/CLI patch mismatch.
- The completed diff received a fresh hostile review plus delta reviews. No
  High or Medium issue remains in checkpoint 2 scope. The reviewers'
  structural execution-start/cancellation-watchdog and mandatory-maintenance
  findings are recorded above as checkpoints 3 and 10 enablement blockers.
- A wall-clock-sensitive 80 ms PostgreSQL test exposed that lease duration was
  not independently persisted. The final fix stores and compares it as fleet
  policy, uses deterministic forced expiry, and passed a fresh-schema rerun.
- Dependencies did not change, so a repository dependency audit was not
  required. Release smoke audited the isolated packed consumer successfully.
- Rollback requires draining all preview clients and preserving the database.
  Migration `20260726_04` is new on this unmerged branch and must now remain
  immutable; an environment that applied an earlier experimental checksum will
  correctly refuse startup and must be reprovisioned or explicitly migrated.

### 3. Runtime pipeline wiring

- Wrap the complete root turn pipeline in distributed admission and fencing.
- Reconcile local scheduler and fleet capacity without deadlocks or limit
  multiplication.
- Mark execution started immediately before inference or tool dispatch.
- Propagate stable attempt, fence, and downstream operation identities through
  trusted execution/tool contexts.
- Keep causal children within the root lease and quarantine the root on
  ambiguity.

**Implementation status:** complete on the private, disabled integration
boundary; production transport enablement remains blocked on checkpoints 4
through 11.

The checkpoint establishes these invariants:

- Distributed admission and local scheduler admission form a bounded
  two-resource protocol. A deferred fleet claim releases the local executor
  slot while retaining one bounded local queue reservation; same-thread order
  and global/source/thread limits remain deterministic.
- The canonical request binding rejects cyclic, non-normalized, oversized, or
  structurally excessive inputs. One request ID binds one peer/thread/source
  and semantic body. Exact duplicates join or replay; changed bindings
  conflict.
- A root crosses `markExecutionStarted` after history authorization and gate
  preparation, but before gate confirmation, augment/model callbacks, tools,
  delivery, terminal hooks, or causal work. A failed marker prevents those
  effects.
- Attempt/fence authority and stable operation IDs reach gate preparation and
  cost commit, turn-start and context hooks, internal handlers, model/tool
  execution, outbound delivery, terminal hooks, and causal follow-up turns.
  Public traces and delivery/hook contexts receive only the safe execution
  projection; binding and idempotency hashes are not copied into them or into
  the `TurnResult` passed to augment terminal hooks.
- Layered-memory auto-save is explicitly unavailable under distributed
  authority until checkpoint 5 supplies a coordinator-fenced shared memory
  adapter. Its terminal hook returns before transcript retrieval, promotion
  state, process-local buffering, child injection, extraction-model dispatch,
  or persistence. Its internal handler repeats the rejection as defense in
  depth. Single-process auto-save behavior is unchanged.
- Caller cancellation or a decision deadline that races a committed admission
  or claim performs a bounded, attempt-fenced pre-start terminalization.
  Queue and active ownership, process session, generation, lease expiry, and
  the execution-start marker are checked again in the store. A stale owner
  cannot cancel an expired or adopted attempt.
- Every heartbeat has an independent watchdog. Authority loss synchronously
  aborts cooperative work, marks the root outcome unknown, quarantines its
  thread, and after a bounded grace period detaches non-cooperative causal or
  hook work so one lost external operation cannot retain local capacity or
  block shutdown forever.
- An in-flight PostgreSQL operation reports its actual committed result even
  when local authority is invalidated concurrently. Later mutations fail
  closed, except the narrowly scoped attempt-fenced pre-start abandonment used
  to compensate late admission/claim results.
- Coordination protocol v4 changes the attempt/adoption semantics. A code-owned
  v3 predecessor tuple can upgrade atomically only while the namespace row is
  locked, all policy matches, every old instance lease is expired, and no
  queued or active request exists. Old v3 clients fail compatibility after the
  transition. No schema migration is required for this protocol-only change.

Checkpoint 4 advances the preview contract to protocol/schema v5. The only
accepted predecessor is the exact code-owned v4 tuple, and the upgrade is
permitted only after all v4 instance leases expire and no queued or active
request remains. The upgrade fills the new immutable turn-state policy under
the locked namespace row; v4 clients fail compatibility after transition.

This checkpoint deliberately does **not** claim transport-level replica
support. Web, Telegram, AgentMail, and Link still need trusted source-stable
root identities and shared replay ledgers in checkpoints 5, 7, and 9.
Transactional delivery remains checkpoint 6, and final multi-process transport
certification and public enablement remain checkpoint 11. Legacy unfenced
`ThreadHistoryPersistence` is rejected by the private integration instead of
silently composing it with distributed execution.

**Checkpoint 3 verification record:** implementation commit `c18f6ce`.

- Focused agent, root-runtime, coordinator, compatibility, scheduler,
  layered-memory, and adjacent suites pass. The final combined focused run
  covered 146 tests/718 assertions.
- A clean PostgreSQL 16 run passes 28 tests/206 assertions, including real
  multiprocess fencing, transaction-ordering cases, and both queued and
  active-unstarted cleanup after synchronous local invalidation.
- Repeated fresh hostile-review rounds found and closed late admission/claim
  capacity retention, post-invalidation result masking, protocol-version
  ambiguity, expired-owner abandonment, non-cooperative causal retention,
  missing hook/delivery/model authority, trusted-hash leakage to augment
  hooks, shutdown admission delay, and distributed layered-memory buffer and
  persistence gaps. The incomplete Supabase read-then-insert proposal was
  removed; distributed auto-save now fails before any local or remote effect.
  The final fresh review found no unresolved High or Medium issue within the
  checkpoint 3 private integration boundary.
- Canonical runtime shards passed sequentially. Bun 1.3.14 aggregate socket
  exhaustion was reproduced only in server-heavy shards; all 75 capability
  files and all 46 transport/integration files passed in fresh sequential Bun
  processes, as did the isolated engine and workspace server files.
- `bun run typecheck`, `bun run lint`, 243 console tests/1,093 assertions, the
  console production build, and `bun run smoke:release` pass. Lint reports
  only the existing Biome 2.5.0 schema versus 2.5.5 CLI information notice.
- Dependencies are unchanged. Public context types changed, so release smoke
  remains mandatory at the checkpoint gate.
- Rollback must drain every preview client and preserve PostgreSQL state. A v4
  namespace cannot be reopened by v3 code after the atomic protocol upgrade;
  rollback requires the prior code to use a fresh namespace or an explicitly
  reviewed reverse migration.

### 4. Shared history, result replay, and atomic turn commit

**Implementation status:** complete on the private, disabled integration
boundary; public transport enablement remains blocked on checkpoints 5 through
11.

- The coordinator owns peer-bound revisioned history. Every arbitrarily routed
  root reloads it under the exact unstarted lease before model invocation, and
  a changed peer is denied before history exposure or execution.
- The only identity transition is authenticated public anonymous-to-recognized
  promotion with the exact predecessor peer hash and promotion scope.
- Protocol v5 rejects legacy replay-only `complete()`; a successful execution
  must use the atomic checkpoint.
- One PostgreSQL transaction rechecks namespace, instance session, request,
  attempt, fence, lease expiry, execution marker, peer binding, and expected
  history revision before committing history, sanitized replay, exact-known
  cost markers, staged outbox intents, and terminal request state.
- History, replay, cost, outbox, and namespace cardinality are explicitly
  bounded by immutable `turnState` and `result` policies. Pending outbox rows
  protect their terminal request from pruning until checkpoint 6 implements
  fenced delivery and reconciliation.
- Resident history is evicted after each distributed root, so another replica's
  later revision can never be hidden by a stale process cache. Local
  single-replica history behavior remains unchanged.
- Outbound handlers are not invoked by the distributed turn path. The atomic
  commit stages bounded intents only; delivery is intentionally deferred.
- Empty histories are reserved on the active request but are not materialized
  before execution. Pre-start cancellation or expiry releases the reservation,
  preventing abandoned requests from exhausting `maxThreads`.
- Durable history and replay bodies are structurally validated, and replay is
  bound to the requested thread both when stored and when read. Malformed or
  wrong-thread durable state fails closed rather than becoming a replay.

**Checkpoint 4 verification record:** coordinator commit `7ce790e`; runtime
integration commit `9a4c196`.

- Focused coordinator, runtime, compatibility, CLI, and adjacent suites pass;
  the final combined changed-surface run covered 331 tests with 1,399
  assertions. PostgreSQL 16 passes 35 tests with 268 assertions, including
  multiprocess fencing, absent-history capacity reservations, malformed
  checkpoint rejection, wrong-thread replay corruption, and rollback after a
  later atomic write fault.
- Every canonical runtime shard passed sequentially. The console suite passed
  243 tests with 1,093 assertions and the production console build passed.
  `bun run typecheck`, `bun run lint`, `bun audit --json` (`{}`), and
  `bun run smoke:release` pass. Lint reports only the existing Biome schema
  version information notice.
- Three hostile-review rounds found and closed an omitted recovery fingerprint,
  a v5 replay-only completion bypass, pre-start history-capacity leakage,
  syntactically valid but structurally malformed checkpoints, and wrong-thread
  durable replay reads. A suspected causal-child authority bypass was
  independently disproven: the child receives the parent authority, combined
  abort signal, uncertainty callback, distributed accumulator, and keyed
  parent lease.
- No unresolved High or Medium issue remains inside checkpoint 4's private,
  disabled integration boundary. Transactional outbox delivery remains the
  explicit checkpoint 6 activation blocker. Automatic observable pruning and
  history-capacity reclamation remain the explicit checkpoint 10 activation
  blocker. Supported startup still rejects this profile, so neither deferred
  path is reachable through public or local mode.
- Rollback requires a quiescent fleet and preserved PostgreSQL state. Protocol
  v4 code cannot reopen a v5 namespace; use a matching database snapshot or a
  fresh preview namespace rather than attempting an in-place downgrade.

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

Implementation uses one draft integration PR, #166, on
`production/horizontal-replica-readiness`. Each numbered checkpoint ends in
separate reviewable Conventional Commits and a recorded verification/review
gate before the next checkpoint begins. The draft remains unmergeable as a
supported distributed profile while the startup guard is active.

The PR is marked ready only after shared history/result commit, admission and
identity state, quotas and memory, transactional delivery, provider ownership,
jobs, operations, certification, documentation, and the final enablement gate
are complete. No intermediate checkpoint claims replica support.

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

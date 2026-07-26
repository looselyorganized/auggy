# Production-Readiness Engineering Boundary

**Date:** 2026-07-25

**Status:** approved for implementation

**Immediate scope:** production-supported single-replica Auggy

**Deferred decision:** horizontal scaling for one logical Auggy

## Decision

Several production-readiness workstreams are genuine Auggy engineering
requirements. Separating Auggy from a managed platform does not transfer all
runtime operability to the deployer.

The correct distinction is:

- Auggy does not provide hosting, load balancing, backups as a service, tenant
  provisioning, or organizational SLOs.
- Auggy does provide the deterministic runtime contracts that let an operator
  perform those jobs safely.

The immediate implementation covers the seven single-replica engineering
groups below. Multiple replicas for one logical Auggy remain unsupported and
fail closed. After these seven groups pass, horizontal scaling will be
considered as a separate product and engineering decision.

Several independent Auggy deployments may run on the same platform. That is
not horizontal scaling: each deployment has its own logical agent, state,
identity, and operations.

## Group 1 — Runtime observability and capacity signals

Auggy must expose bounded, redacted operational signals for admission, queue
wait, active work, inference and tool latency, provider failures, delivery lag,
cost, quarantine, recovery, memory pressure, and shutdown. The operator owns
the dashboards, alerting system, and service-specific SLOs.

Done when:

- operators can distinguish overload, provider failure, stuck work,
  quarantine, delivery failure, and application failure without inspecting
  customer content;
- metric labels and trace fields are bounded and do not contain credentials,
  prompts, peer-controlled display values, or tool arguments by default; and
- health and metrics describe the supported single-process topology honestly.

## Group 2 — Runtime-state lifecycle and recovery

Auggy must inventory every runtime-owned store, define retention and cleanup,
document consistent backup and restore ordering, and test restart and restore
behavior. The operator owns the storage service, backup scheduler, encryption
system, regional replication, and recovery objectives.

Done when:

- every mutable store has an owner, namespace, schema/version, retention
  behavior, backup classification, and restore order;
- backups do not capture inconsistent live state silently;
- a supported single-replica restore can be rehearsed and verified; and
- restored state cannot replay completed or outcome-unknown effects
  incorrectly.

## Group 3 — Delivery and operator recovery semantics

Every shipped transport and notification path must state and test whether it
is at-most-once, at-least-once, replayable, or outcome-unknown. Auggy does not
need a universal workflow engine, but it cannot silently lose committed work or
blindly repeat ambiguous side effects.

Done when:

- web, Telegram, AgentMail, link, hook, and notification behavior has an
  explicit delivery contract;
- operation identifiers and downstream idempotency are used where supported;
- ambiguous effects become inspectable outcome-unknown state; and
- every durable quarantine or review state has an authenticated, auditable
  recovery path.

## Group 4 — Provider resilience

Auggy must prevent a stalled or failing model provider from exhausting the
runtime. Automatic multi-provider routing is optional; bounded provider
behavior is not.

Done when:

- timeout budgets cover connection, stream setup, streaming, and materialized
  response work;
- retry behavior is explicit, bounded, jittered, and limited to safe failure
  classes;
- cancellation reaches first-party provider operations where supported;
- one provider brownout cannot hold all scheduler capacity indefinitely; and
- provider errors remain stable and credential-safe.

## Group 5 — Real load and soak evidence

The existing distributed coordination harness is a reference model, not a
capacity test of the real Auggy runtime. The production release needs measured
single-process evidence for representative concierge and order-support
workloads.

Done when:

- a real runtime harness exercises bursts, same-thread serialization,
  different-thread concurrency, slow providers, slow clients, restart,
  cancellation, and graceful drain;
- memory, file descriptors, event queues, queue wait, latency, rejection,
  unknown outcomes, and duplicate execution remain bounded;
- test barriers and fault injection are deterministic; and
- results name the hardware, runtime, configuration, provider model, duration,
  and workload rather than claiming a universal requests-per-second limit.

## Group 6 — Public contracts, migrations, and rollback

Pre-1.0 permits public API change, but it does not excuse undocumented stored
data changes or untestable upgrades.

Done when:

- configuration, health, generated clients, scheduler recovery, storage
  schemas, and migration tooling have explicit version or compatibility
  boundaries;
- prior supported fixtures are exercised against current readers/migrators;
- incompatible state fails before serving traffic;
- release notes identify breaking behavior and required operator action; and
- every persisted migration has tested backup and rollback guidance.

Stable SemVer compatibility and a formal deprecation window remain `1.0`
commitments.

## Group 7 — Independent-agent isolation on a shared host

A platform may host two or three Auggys that perform different operations.
Their ports, files, SQLite stores, credentials, budgets, Telegram identities,
console state, deployment records, and runtime namespaces must not collide.

Done when:

- server-minted agent identity selects every Auggy-owned namespace;
- request data cannot select another agent's storage or authority domain;
- shared-host defaults either isolate automatically or reject ambiguity;
- cross-agent negative tests cover files, stores, ports, credentials, replay,
  budgets, console state, and lifecycle commands; and
- deleting, backing up, restoring, or operating one agent cannot mutate
  another agent's state.

This is runtime and CLI isolation. It is not multi-tenant account provisioning
or a hosted Auggy control plane.

## Horizontal scaling and load-balancer ownership

Multiple replicas serving one logical Auggy are not included in these seven
groups. Current configuration must continue to fail closed.

If horizontal scaling is approved later, Auggy must implement and document the
runtime contract a load balancer depends on:

- readiness and liveness meanings;
- graceful drain and rollout ordering;
- trusted proxy and forwarded-identity policy;
- server-minted request, thread, and operation bindings;
- shared-store, lease, fencing, replay, history, budget, memory, session, and
  delivery requirements;
- migration and mixed-version behavior;
- failure, quarantine, and operator-recovery behavior; and
- whether affinity is permitted as an optimization, never as a correctness
  boundary.

The deploying team remains responsible for choosing and configuring the load
balancer, TLS termination, health checks, routing rules, network policy,
autoscaling policy, and infrastructure. Auggy should provide examples for
common platforms only after the runtime contract exists. Documentation must
not suggest that sticky sessions or a shared volume make unsupported replicas
safe.

## Required engineering loop

Each group uses the established hardened loop:

1. Revalidate the existing implementation and threat model.
2. Delegate independent exploit/failure, compatibility/architecture, and
   test/adversarial analysis.
3. Add a failing regression test or executable evidence.
4. Implement the smallest complete boundary in reviewable slices.
5. Add negative, failure, concurrency, restart, and bypass coverage.
6. Give the completed group diff to a fresh hostile reviewer.
7. Verify every finding independently and fix confirmed High or Medium issues.
8. Run focused tests, adjacent tests, typecheck, lint, inventory, full bounded
   suites, console build, dependency audit when approved, and release smoke as
   appropriate.
9. Record the group's result and ending commit before moving to the next group.

One integration branch and one draft pull request will carry the seven groups.
Commits remain small, conventional, reviewable, and independently revertible.

## Implementation checkpoints

### Group 1 — implemented on branch

The runtime now exposes a versioned, process-local operational snapshot through
`AgentHandle` and the authenticated, no-store console dashboard. Scheduler
signals include exact fixed rejection reasons and cumulative queue wait.
Inference, tool, turn, kernel response-delivery, hook, thread-quarantine
recovery, shutdown, cost, and process-memory signals are aggregate numeric
values only. Augment-owned delivery and recovery are connected in Group 3.
The recorder API has
no content or identifier inputs, and `/health` remains the existing liveness
contract rather than being silently repurposed as readiness.

The snapshot deliberately resets at start and has no exporter callback or
persistence side effect. External collection, retention, dashboards, alerting,
and SLO thresholds remain operator responsibilities.

Hostile review found and resolved the following Medium defects before the
checkpoint:

- shutdown was initially invisible while drain was blocked;
- concurrent stop/restart operations could overlap and corrupt the new run;
- internal extraction inference and failed-unpriced attempts were initially
  undercounted;
- causal mismatch/expired-context rejections were not fully counted; and
- ambiguous layered-memory inference was initially flattened into an ordinary
  failure instead of quarantining the thread.

The corrected implementation uses deterministic barriers for drain and
lifecycle races, explicit per-inference outcomes, fixed rejection dimensions,
finite/saturating queue-wait values, and a built-in outcome-unknown extraction
test that proves quarantine and blind-retry rejection. Repeated hostile review
reported no unresolved High or Medium issue after these corrections.

Group verification:

- focused kernel, scheduler, lifecycle, console-route, layered-memory, and
  operational-signal tests passed;
- the complete console suite passed (243 tests) and its production build
  succeeded;
- `bun run typecheck` passed;
- `bun run lint` passed with only the repository's existing Biome schema
  version notice; and
- `git diff --check` passed.

### Group 2 — implemented on branch

The CLI now inventories every shipped local state owner and provides an
offline, whole-runtime-volume `inventory` / `backup` / `verify` / `restore` /
`restore-resume` / `reconcile` workflow. Bundles are identity- and
configuration-bound, bounded by entry/file/aggregate limits, preserve empty
directories and SQLite journal sidecars, hash every payload file, require an
empty restore target, and leave restored state fenced until an operator
reconciles non-rollbackable downstream effects. Interrupted restores can resume
only the exact manifest-bound subset under the same restore ID.

Mutable file memory, relative notification logs, volume admission, restore
fences, and volume identity now operate through pinned directory descriptors.
Symlink leaves, parent replacement, hard links, foreign ownership, unsafe
modes, prefix collisions, and partial temporary writes fail closed. Production
startup parses configuration first and then performs fence validation,
agent/volume identity binding, AgentMail directory admission, and the durability
probe through one held root descriptor. The host must keep the admitted
mountpoint stable for the process lifetime.

Hostile review found and resolved the following High/Medium candidates before
the checkpoint:

- mutable file memory and file notification logs could follow replaced parents
  or symlink leaves;
- backup and restore initially mixed path checks with later string-path I/O;
- the first bundle design omitted empty directories, exact config compatibility,
  robust resume semantics, and strict core SQLite identity;
- pathname-based WAL normalization reintroduced an intermediate-component race;
- fence, identity, reconciliation, and volume admission were initially separate
  path operations; and
- deferred journaled SQLite metadata initially skipped core application/schema
  identity enforcement.

The final design preserves stopped SQLite journal artifacts byte-for-byte and
defers full semantic inspection to core stores at startup, while still checking
their application ID and schema version before bundle publication. No recovery
database is opened by pathname. Authenticated/encrypted backup custody, external
provider recovery points, scheduling, regional replication, and RPO/RTO remain
operator responsibilities.

Group verification:

- the focused state, runtime-volume, resolver, filesystem, notification,
  idempotency, replay, deploy-template, and CLI suites passed (146 tests in the
  broadest checkpoint run, followed by 47 targeted tests after final fixes);
- three independent final hostile reviews reported no unresolved High or Medium
  issue within the documented stable-mount trust boundary;
- `bun run typecheck` passed;
- `bun run lint` passed with only the repository's existing Biome schema-version
  notice; and
- `git diff --check` passed.

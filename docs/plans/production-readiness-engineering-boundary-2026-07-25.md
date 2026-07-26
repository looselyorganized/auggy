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

### Group 3 — implemented on branch

AgentMail inbound work and notification delivery now persist ambiguous effects
as versioned, bounded, outcome-unknown incidents. Runtime startup restores every
durable incident into the scheduler before transports begin accepting work, and
admission rechecks each durable authority fail closed. Recovery is authenticated
and all-authority gated: resolving one source cannot reopen a thread that remains
fenced by another source.

AgentMail no longer reclaims expired processing leases. Restarted or expired
claims are atomically fenced, the old worker cannot settle them after fencing,
and same-thread pending work remains blocked until explicit operator
reconciliation. Notify now requires an owned durable SQLite path outside an
explicit test-only seam, reserves quotas before dispatch, promotes interrupted
reservations during runtime startup, and retains bounded hashed recovery
evidence. Configuration limits notification policy windows to 30 days and the
store bounds retained terminal attempts to 10,000.

Hostile review found and resolved the following High/Medium candidates before
the checkpoint:

- AgentMail could reclaim an expired processing lease and repeat an ambiguous
  side effect;
- Notify incidents were durable but did not restore the scheduler quarantine
  after process restart;
- direct `notify()` construction could silently fall back to a volatile
  in-memory delivery store; and
- one source-specific recovery action could release a thread still fenced by a
  different durable authority.

The suspected non-transactional AgentMail schema migration was disproven: the
migration runs inside the hardened SQLite admission transaction and exact prior
schemas are covered by branded and unbranded migration tests. Repeated hostile
review reported no unresolved High or Medium issue for the supported
single-runtime topology. A second live runtime sharing the same delivery stores
may conservatively create ambiguity and is explicitly unsupported; horizontal
scaling remains deferred.

Group verification:

- the broad focused delivery, AgentMail, Notify, scheduler, configuration,
  resolver, inventory, and admin suites passed (456 tests); independent final
  reviewers repeated overlapping focused runs of 342, 443, and 171 tests with
  zero failures;
- `bun run test:runtime` encountered Bun 1.3.14's known suite-scale
  `EADDRINUSE` failure before `tests/http.test.ts`; that file passed in isolation
  (63 tests), so the socket failure was not classified as an application
  regression;
- `bun run typecheck` passed;
- `bun run lint` passed with only the repository's existing Biome schema-version
  notice; and
- `git diff --check` passed.

### Group 4 — implemented on branch

Every first-party model adapter and the kernel now enforce a finite one-attempt
provider deadline. The default is 120 seconds and the validated maximum is ten
minutes. OpenAI, Anthropic, and OpenRouter SDK retries are disabled because the
current provider-neutral contract cannot prove that a failed generation POST
was unbilled or side-effect free. The deadline covers connection and setup,
stream consumption, and buffered materialization for both kernel and direct
adapter callers. OpenRouter's authoritative restrictive-routing lookup shares
the shorter call deadline.

The kernel closes and deactivates inference streams before provider abort
listeners can emit, fences all late results from tools/history/follow-up work,
releases local scheduler capacity after a non-cooperative provider, and commits
unknown or canceled post-dispatch inference as one unpriced accounting record.
Clearable call-level deadline leases remove timers and caller listeners at
settlement, and Ollama composes provider, `Request`, and init cancellation into
its per-call transport.

Hostile review found and resolved the following High/Medium candidates before
the checkpoint:

- provider abort listeners could synchronously emit a final delta before the
  kernel closed the stream;
- SDK timeouts alone did not bound body or stream consumption for direct
  adapter consumers;
- canceled provider work could skip unpriced cost evidence;
- OpenRouter directory validation could outlive a shorter configured deadline;
- non-disposable timeout signals retained timers after fast calls;
- Ollama setup and request-input signals were not consistently composed; and
- a caller abort between wrapper construction and the dispatch microtask could
  still invoke provider code.

The final regressions cover whole-call hangs in all four adapters, one-attempt
behavior, the synchronous abort/delta race, pre-dispatch cancellation, signal
composition, timer disposal, OpenRouter policy lookup, detached provider work,
and exact cost commitment. Repeated hostile review reported no other unresolved
High or Medium issue.

Group verification:

- the final focused provider, kernel, scheduler, configuration, resolver,
  package-manifest, and public-export reviews passed up to 433 tests with zero
  failures; the post-review immediate-abort suite passed 275 tests;
- `bun run typecheck` passed;
- `bun run lint` passed with only the repository's existing Biome
  schema-version notice;
- the test-surface inventory passed with 274 runtime and 29 admin files across
  12 shards; and
- `git diff --check` passed.

The approved final `bun audit --json` returned an empty advisory set, and the
unsandboxed `bun run smoke:release` passed the packed provider, isolated
consumer, installed scaffold, console asset, health, local MCP, and cloud
preflight checks.

### Group 5 — implemented on branch

The prior distributed load script remains an explicitly synthetic coordinator
reference model. A separate bounded runner now starts a real single-replica
`defineAgent` and exercises the keyed scheduler, turn loop, streamed event path,
validated tool dispatch, delayed outbound delivery, operational snapshots,
active drain, post-drain rejection, and same-handle restart. Concierge,
order-support, queue-saturation, cancellation, and non-cooperative-provider
profiles emit versioned, secret-free JSON with exact machine/runtime/config
metadata, terminal classifications, latency percentiles, scheduler and delivery
peaks, memory, optional Linux `/proc/self/fd` counts, and invariant failures.

The harness is capped at 10,000 requests and makes no universal throughput or
replica claim. Real Bun HTTP/SSE queue limits, disconnect behavior, transport
idempotency, and replay remain in their existing sequential transport suites;
the load runner does not relabel direct runtime injection as HTTP evidence.

The first fault run exposed and resolved one additional Medium provider
availability issue: repeated custom `ModelClient` implementations that ignore
abort could release scheduler slots while accumulating detached work without a
bound. The kernel now tracks detached inference promises, tolerates a small
derived budget so one stall does not pin the only scheduler slot, and then
fails new inference closed until unresolved work settles. Already-active work
can cross the deadline concurrently, but the retained attempt count has a
derived finite upper bound covered by both scheduler and load regressions.

Recorded local evidence on Bun 1.3.14 / Darwin ARM64 / 12 logical CPUs / 32 GiB
includes 1,000-request concierge and order-support bursts, a 10,000-request
order-support soak, and a 128-request cancellation/stall fault run. Every run
had zero same-thread overlap and duplicate effects, respected scheduler and
detached-work bounds, rejected new work during drain, reached zero scheduler
and delivery work, restarted successfully, and returned no invariant failure.
Exact inputs and results are in
[`docs/30-single-replica-load-evidence.md`](../30-single-replica-load-evidence.md).
File-descriptor telemetry was unavailable on Darwin and is explicitly `null`.

Independent revalidation classified the missing real-runtime runner as a
readiness-evidence gap rather than a new source vulnerability. Reviewers also
identified Low follow-up improvements for supplemental CI file-existence
validation, one polling-based idempotency test, and fixed-port smoke retries;
those belong to the CI/contracts checkpoint rather than this runtime harness.

Hostile review found one Medium defect in the first harness implementation: an
all-stalled provider profile could open the detached-attempt circuit before the
held drain probe started, leaving the runner waiting forever on a fixture
barrier. The final harness races probe start against terminal settlement,
reports circuit-blocked drain/restart probes as controlled invariant failures,
and releases fixture barriers and stops the runtime in `finally`. The exact
all-stall regression completes without a hang. Repeat adversarial review found
no unresolved High or Medium Group 5 issue.

### Group 6 — implemented on branch

Configuration and generated artifacts now have explicit fail-closed contract
edges. `settings` must be an object, unknown top-level agent fields are
rejected, the obsolete concierge example metadata is removed, route JSON uses
envelope schema version 1, and generated OpenAPI declares Auggy artifact schema
version 1. Supplemental deterministic, Linux-boundary, and PostgreSQL CI lists
are admitted through the tracked test inventory before Bun runs them, so one
stale selector cannot disappear behind other passing files. Release smoke now
allocates its port immediately before startup and performs at most three
observable collision retries with PID-aware cleanup.

The PostgreSQL coordination preview no longer treats migration-ledger presence
or `CREATE IF NOT EXISTS` as structural proof. Every migration transaction is
pinned to an explicit validated schema, and the shipped CLI/runtime are pinned
to `public`; runtime operations qualify owned relations and reset transaction
function lookup so role- or URL-controlled `search_path` cannot redirect work.
Provisioning validates the complete security-relevant owned catalog: table
kind/persistence, columns, nullability, defaults, identity/generated state,
collations, constraints and deferral, indexes and key semantics, checks,
row-security/rules/triggers, and the exact event sequence dependency, owner,
and parameters. Validation occurs before transactional migration success is
committed and repeats on every invocation.

The compatibility guide records config, public API, generated artifact,
recovery, SQLite, external-store, PostgreSQL, upgrade, and full-state rollback
boundaries. This remains a pre-1.0, stopped single-replica upgrade contract; it
does not claim mixed-version rollout, online migration, universal external
store migration, or compatibility with an unknown artifact version.

Hostile review found and resolved the following High/Medium defects before the
checkpoint:

- migration validation initially omitted one event column and queried a weaker
  legacy catalog shape;
- a role-controlled `search_path` could validate `public` but redirect runtime
  operations and built-in function lookup to shadow objects;
- a foreign same-named sequence could be used as the event default while the
  original owned sequence still existed;
- text collation drift could conflate distinct request, thread, source, or
  namespace identifiers; and
- index ordering/opclass/collation, constraint deferral, and sequence parameter
  changes were not initially included in the strict catalog proof.

The corrected PostgreSQL regressions cover incompatible same-named tables,
ledger revalidation, defaults, collations, partial and descending indexes,
unvalidated checks, deferred primary keys, row security, foreign sequence
defaults, sequence parameters/ownership, unsafe schema identifiers, and a
runtime shadow-schema executor. Repeated hostile review reported no unresolved
High or Medium Group 6 issue. A removed PostgreSQL rule can leave the
conservative `relhasrules` flag set until database maintenance; that may cause
a fail-closed operational rejection but cannot admit a weakened schema.

Group verification:

- the broad configuration, artifact, CI, storage/migration, coordination, and
  readiness run passed 408 tests, skipped 11 PostgreSQL service-backed cases,
  and had zero failures;
- the one database-independent PostgreSQL schema-identifier regression passed;
  this machine has PostgreSQL client tools but no server, so the PostgreSQL 17
  CI service remains required executable evidence for the 11 integration
  cases;
- the tracked inventory passed with 274 runtime and 29 console test files
  across 12 bounded shards;
- `bun run typecheck`, `bun run lint`, `bash -n scripts/release-smoke.sh`, and
  `git diff --check` passed; lint emitted only the existing Biome schema-version
  notice; and
- final root and packed-consumer dependency audits returned no advisories, and
  the complete packed-release smoke passed.

### Group 7 — implemented on branch

The CLI now treats the server-minted `agent.yaml` id as the logical-agent
isolation root. Shared Layered Memory and Supabase stores persist a canonical,
collation-independent exact namespace owner and apply it in the store query
before result limits and on exact reads, writes, supersession, cleanup, and
deletion. Label prefixes are no longer authorization evidence. Durable peer
tombstones serialize verification migration/revocation against concurrent and
future memory writes. Visitor audiences,
Link cards, runtime volumes, local mutable paths, PID manifests, and launchd
services bind to the same immutable id instead of a mutable display name.

Local startup atomically claims the immutable agent id, listener ports,
canonical state pathname plus physical root, Telegram bot identity, and inbound AgentMail inbox before
transports start.
Claims are private, nonce-owned, secret-free, serialized per resource,
PID-incarnation checked, stale-process recoverable, and released only by their
exact owner within one OS user's CLI registry. Manifests are durably published,
cleanup compares the captured claim generation, launchd control is serialized
and authenticated by an installation generation, launchd failures roll back or
preserve recoverable ownership, and destructive removal quarantines and
revalidates the captured root before deletion. Display-name lifecycle aliases are allowed only when unambiguous, named
configuration resolution cannot fall through to a different
current-working-directory agent, and a live legacy name-keyed process blocks
the identity-keyed replacement until it is stopped.

All Auggy-owned local state is contained below the selected agent directory or
the admitted Railway runtime root. Telegram replay keeps its provider-bot
namespace so upgrade cannot hide prior deduplication claims; the agent id owns
the replay database path and the local bot lease instead. Independent agents on
separate services may share an internal port number, but each requires a
dedicated config id, process, secrets, volume, route, and external provider
identity.

Compatibility review records two intentional stopped-upgrade boundaries:
visitor tokens using old display-name audiences must be reissued, and existing
shared layered-memory labels require an offline operator-reviewed
export/relabel/import rather than a fail-open fallback. CLI claims cannot
arbitrate across OS users, containers, services, or machines; the deployer must
enforce exclusive inbound provider identities across those boundaries.
Mutually untrusted agents require different OS or container identities because
`bash` and configured filesystem mounts are capabilities, not a sandbox.
Multiple replicas for one logical Auggy remain unsupported.

The final Group 7 hostile passes also closed blank, malformed-Unicode, case,
and nested namespace aliasing; fail-open legacy memory adoption; standalone
visitor migration defaults; revoke/reverification/write races and retryable
partial erasure; symlinked operator and cloud-metadata paths; noncanonical listener ports; equal,
hierarchical, replaced, and aliased state-root collisions; launchd
start/stop/restart races and partial failures; timezone-dependent process
identities; and secret-bearing environment inheritance by the macOS `ps`
fallback. A byte-for-byte clone of both the immutable identity and cloud record
remains the same logical agent, not an independent deployment. Verification
covered the complete tracked runtime and admin inventory in 12 sequential
shards; final counts are recorded in the pull request. The
portable POSIX check-to-signal PID-reuse window remains a documented Low
same-UID operational residual rather than an absolute process-handle guarantee.

The final cross-group hostile gate then found and resolved six additional
Medium boundaries before PR publication: Railway had bypassed every local
singleton claim; launchd stop had a late manifest-publication window; a signed
visitor absent from the configured identity authority could still be treated
as recognized; active-winner reverification skipped the latest revocation
epoch; the exported same-peer memory migration primitive could self-tombstone;
and unresolved Unicode-normalization aliases could select the wrong memory
namespace. The corrected runtime holds a crash-released same-volume `flock`,
uses a durable launchd active-generation allowlist checked before claims and
after manifest publication, requires configured visitor identity authority,
checks the maximum email revocation epoch, makes same-peer migration a pure
no-op, and conservatively rejects normalization/case-fold aliases.

Repeat hostile review found and resolved four follow-up Medium gaps: exact-id
`stop` now recovers an active launchd generation without a manifest; `start`
closes the previous generation before unload; operator revocation retries
advance both row and denylist epochs monotonically; and unresolved path
comparison covers full Unicode case-fold equivalence. The supported Railway
guarantee remains one runtime per coherently locked dedicated volume. Separate
or cloned volumes remain a deployment boundary and do not make horizontal
replicas supported.

A final launchd re-review found lost stop/restart interleavings before state
publication. Exact immutable-ID controls now acquire the lifecycle lease before
their first manifest or generation lookup. Display-name controls with no
manifest fail explicitly and require the immutable ID because mutable project
configuration cannot prove the identity of an unpublished start. A concurrent
start is therefore either acted on from observed state or causes the control
operation to fail visibly for retry; it can no longer complete after a false
"not running" result.

The last foreground-lifecycle pass found and resolved one further Medium race:
a second `auggy dev` could publish after the stopped process released its
claims but before the operator command returned success. Foreground admission
now transiently participates in the per-agent lifecycle fence through durable
manifest publication, restart explicitly passes its owned fence to the
successor, and stop rejects an unexpected replacement generation instead of
discarding the owner-check result.

One mixed-mode follow-up reproduction then proved an armed launchd generation
could survive a foreground stop and republish after the successful result.
Foreground admission now rejects active launchd state both under the lifecycle
lease and inside its atomic claim transaction. Stop detects pre-existing mixed
state, closes the generation before the dev process can release its claims,
unloads its job and artifacts, and only then completes foreground shutdown.
The closed generation is covered by a regression that attempts delayed
launchd publication after the stop result.

The final launchd rollback review found another Medium last-poll race: a child
could be admitted immediately before timeout handling, survive a nominal
unload, and remain live after start deleted its control artifacts and reported
failure. Rollback now reconciles only the exact closed generation, waits
boundedly for its process to exit, removes a dead owned manifest, and preserves
all recovery artifacts and claims with an explicit error whenever ownership
changes or termination remains live/unverifiable.

The final dependency gate also discovered the newly published
`GHSA-qwww-vcr4-c8h2` against React Router 7.18.1. The console migrated from the
removed `react-router-dom` compatibility package to patched `react-router`
8.3.0. All 243 console tests and the production build passed, and the repeated
`bun audit --json` returned an empty advisory set.

## Final integration gate

- The complete tracked inventory passed 4,280 tests across 274 runtime and 29
  console files in 12 sequential shards. Eleven PostgreSQL 17 service-backed
  cases were skipped locally and remain enforced by CI.
- `bun run typecheck`, `bun run lint`, the console production build,
  `bash -n scripts/release-smoke.sh`, and `git diff --check` passed. Lint
  reported only the pre-existing Biome schema-version notice.
- `bun audit --json` returned `{}`. The packed-agent and each isolated packed
  provider consumer also passed their dependency audits.
- `bun run smoke:release` passed against the unpublished local tarballs,
  including package contents, installed CLI/scaffold, doctor, runtime health,
  console assets, local MCP behavior, and cloud preflight.
- Repeated fresh hostile review found no unresolved High or Medium issue in
  the single-replica production boundary. Horizontal replicas for one logical
  Auggy remain explicitly unsupported.

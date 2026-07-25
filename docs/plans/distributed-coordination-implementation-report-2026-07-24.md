# Distributed Coordination Implementation Report

**Date:** 2026-07-24
**Branch:** `security/distributed-coordination`
**Base:** `main`

## Executive outcome

This change establishes the first safe distributed-coordination boundary
without claiming that the current Auggy runtime is ready for multiple replicas.

- Operators can declare an intended PostgreSQL topology and provision its
  checksum-verified schema.
- The runtime rejects that declaration before lifecycle boot or transport
  registration while any required shared/fenced boundary is absent.
- An internal PostgreSQL coordinator implements bounded admission, immutable
  fleet/source policies, per-thread exclusion, database-time leases, monotonic
  fences, durable outcome-unknown quarantine, compare-and-set recovery, and
  per-instance drain.
- Real PostgreSQL and two-process tests are required by a dedicated CI gate.
- A deterministic reference workload models concierge and order-support
  invariants, but labels its output as a reference model rather than a capacity
  certification.

The default scaffold and deployment guidance still require one runtime replica.
That is intentional: enabling the coordinator before shared history, replay,
budgets, mutable memory, and durable delivery exist would convert visible
single-process limits into hidden consistency failures.

## Group 1 — production topology contract

Implemented:

- strict `settings.coordination` parsing with a canonical namespace, a
  secret-free environment-variable name, and bounded lease/poll timings;
- fail-closed startup before boot hooks and transport registration;
- blocker inventory for fleet admission, thread serialization, history,
  idempotency, quarantine/health, mutable stores, and delivery outbox;
- operator documentation that a volume and sticky routing are not correctness
  boundaries.

Adversarial correction:

- the first slice parsed and propagated the setting but did not stop startup;
  this was classified High because documentation called it fail-closed.
  Startup rejection and pre-lifecycle regression tests now enforce the claim.

## Group 2 — PostgreSQL fenced coordinator foundation

Implemented as an internal, disabled core:

- explicit checksum migrations under a transaction-scoped advisory bootstrap
  lock;
- immutable namespace/source capacity policies after trusted provisioning;
- verified TLS for every non-loopback PostgreSQL coordinator and migration
  connection;
- bounded global, source, and per-thread admission;
- exact request/thread/source/binding conflict detection;
- earliest runnable thread-head fairness;
- one active turn per namespace/thread;
- monotonically increasing per-thread fences;
- database-time lease heartbeats and expiry;
- safe requeue only before execution starts;
- started expiry to outcome-unknown plus durable thread quarantine;
- full lease-identity checks on terminal writes;
- per-instance draining and coordinator health;
- compare-and-set recovery with a bounded audit reason;
- a secret-redacting `auggy coordination migrate` command.

Adversarial corrections:

- same-thread claims could overlap when fleet capacity exceeded one;
- global limits could drift between replicas;
- an old source at capacity could block a runnable source;
- expired work was swept only by claim/heartbeat and could consume capacity
  forever;
- one thread could occupy the whole pending queue;
- a permissive or restrictive replica could mutate policy;
- lease writes initially trusted caller-supplied namespace fields;
- migration bootstrap/checksum handling was incomplete;
- drain initially affected the logical namespace rather than one instance;
- the isolated slice did not pass the repository's strict TypeScript gate.
- Bun's default PostgreSQL TLS policy could fall back from TLS for a remote
  database.

All were fixed before integration. Namespace/source policy is now immutable:
configuration drift returns unavailable and requires an explicit new
namespace/cutover rather than silently changing live fleet limits.
Remote URLs accept one canonical `sslmode=verify-full` policy and reject
competing TLS or connection-routing parameters without reflecting credentials.

This group does **not** wire the coordinator into `defineAgent`. The startup
guard remains authoritative.

## Group 3 — multi-process and PostgreSQL validation

Implemented:

- bounded JSON-line worker/barrier primitives using explicit `READY`/`GO`
  synchronization;
- continuous, redacted stderr draining so noisy workers cannot deadlock;
- optional local PostgreSQL tests gated only by
  `AUGGY_TEST_POSTGRES_URL`;
- a required sequential PostgreSQL 17 CI service job;
- concurrent migration, two-process same-thread claim, fleet capacity,
  binding conflict, namespace isolation, stale-fence, database-time expiry,
  quarantine/recovery audit, drain, per-thread capacity, and health-sweep
  coverage;
- deterministic database-forced expiry plus a real child-process kill after
  `EFFECT_BEGUN`, followed by quarantine, compare-and-set recovery, and a
  higher fenced claim;
- canonical test-surface ownership and aggregate release-gate wiring.
- a digest-pinned PostgreSQL 17.10 Alpine service image.

Local verification intentionally reports PostgreSQL tests as skipped when no
test database is configured. CI is the executable service-backed gate.

## Group 4 — workload and capacity harness

Implemented:

- deterministic concierge and order-support profiles;
- bounded inputs, deterministic seeds, logical replica assignment, and JSON
  metrics;
- distinct in-flight duplicate joins, completed-result replays, and
  outcome-unknown mutation states;
- active/queued peaks, throughput, p50/p95/p99 queue wait, rejection,
  unavailable, unknown, duplicate-mutation, same-thread overlap, stale-fence,
  namespace, quarantine, and recovery-rejection signals;
- adversarial seams that make broken fencing, namespace isolation, coordinator
  availability, and outcome-unknown behavior fail thresholds;
- namespace-scoped mutation idempotency and an explicit cross-namespace
  same-key test.

This harness is a reference state-machine model. It is not a production load
test and publishes no universal requests-per-second limit. The next
certification step is to run the same event interface against independent
processes and the PostgreSQL coordinator on declared machine/provider profiles.

## Final adversarial-review disposition

Fresh hostile reviews covered architecture/startup contracts, SQL and lease
boundaries, multiprocess tests, load-model truthfulness, CI wiring, secret
handling, and operator documentation.

Confirmed findings fixed before the final gate:

- **Medium:** remote Bun.SQL clients inherited opportunistic TLS fallback.
  Non-loopback URLs now require verified TLS before any client is constructed.
- **Medium:** the reference model marked mutations complete when execution
  started. Active joins, completed replays, and ambiguous outcomes now have
  separate states and assertions.
- **Medium:** the PostgreSQL suite did not kill an independent worker after an
  effect began. The deterministic child-kill/quarantine/recovery test closes
  that gap.
- **Low:** malformed or unexpected worker output could be reflected into test
  diagnostics. Worker output is now redacted and sentinel-tested.
- **Low:** source policy and migration command wording overstated runtime
  readiness. Documentation now says trusted provisioning and explicitly
  repeats that replicas remain unsupported.
- **Low:** the PostgreSQL CI service used a mutable image tag. The service is
  pinned by version and digest.

One reported migration blocker was disproven. The built-in migration passes a
parameterless SQL string to `unsafe`; Bun explicitly permits multiple commands
for unsafe queries when no parameters are used. The disposable PostgreSQL CI
job remains the executable regression gate.

No unresolved High or Medium issue remains within the disabled coordinator
foundation's scope. The production-enablement blockers below are not
reclassified: startup continues to reject the topology until they are
implemented.

## Verification

Passed local gates:

```sh
bun test tests/agent.test.ts \
  tests/cli/config-parser.test.ts \
  tests/cli/commands/coordination.test.ts \
  tests/coordination/topology.test.ts \
  tests/coordination/distributed-turn-coordinator.test.ts \
  tests/coordination/postgres-distributed-turn-coordinator.test.ts \
  tests/helpers/multiprocess.test.ts \
  tests/load/distributed-coordination.test.ts \
  tests/ci/security-workflows.test.ts
bun run typecheck
bun run lint
bun scripts/test-surface-inventory.ts check
bun run test:runtime
bun run test:admin
bun run build:admin
git diff --check origin/main...HEAD
```

- focused security/coordination set: 173 passed, 7 expected local PostgreSQL
  skips, 0 failed;
- disposable PostgreSQL 17.10 service: 7 passed, 0 failed;
- canonical inventory: 259 runtime and 29 admin files across 12 shards;
- all sequential runtime shards: passed;
- admin suite: 243 passed; production build passed;
- typecheck and lint: passed (Biome reported only the existing schema-version
  informational message);
- concierge reference profile: 240 settled, 0 rejected/unavailable/unknown/
  duplicate/overlap/stale-fence/namespace failures;
- order-support reference profile: 231 executed plus 9 completed-result
  replays, 0 rejected/unavailable/unknown/duplicate/overlap/stale-fence/
  namespace failures.

The first sandboxed runtime attempt produced Bun 1.3.14 `EADDRINUSE` across its
bounded port range. The same HTTP suite and all canonical runtime shards passed
outside the network sandbox, so this was classified as socket isolation rather
than an application regression.

Local egress-dependent attempts remained policy-blocked: direct
`bun audit --json` was denied permission to send dependency metadata to the
advisory service, and local `bun run smoke:release` could not complete isolated
consumer installs inside the restricted temp/cache sandbox. The trusted PR
release-rehearsal gate then passed the complete `bun run smoke:release`,
including its packed-provider and generated-agent advisory checks. No
dependencies changed in this branch.

CI additionally runs the PostgreSQL test file with the digest-pinned service
and a passwordless, runner-local test URL. CI, CodeQL, all runtime shards, the
PostgreSQL gate, and release rehearsal passed on PR #163.

## Residual blockers before replica enablement

The following are intentionally not hidden behind an “experimental” switch.
They keep `settings.coordination` fail-closed:

- coordinator wiring around the full model/tool/history/outbound/hook pipeline;
- server-minted request binding and source policies at every ingress;
- durable result replay and orphaned queued-request cleanup;
- fence-aware shared thread history;
- transactional delivery outbox and recipient idempotency;
- shared visitor/session/replay, budget, notification, and mutable-memory
  stores;
- AgentMail stale-worker effect handling;
- downstream operation keys/fences for irreversible tools;
- authenticated recovery that proves or operationally enforces stale-owner
  termination;
- terminal/event/source retention and cleanup;
- dedicated database role/schema or equivalent enforced tenant boundary;
- real workload/soak/failover certification and measured capacity envelopes.

## Follow-on roadmap

The earlier seven workstreams were reconciled against Auggy's product boundary
in the
[`OSS Production Release Plan`](./production-readiness-roadmap-2026-07-24.md).
They are no longer treated as one mandatory managed-platform program.

The immediate target is a public-source `0.5.0` production preview with a
documented single-replica contract. Auggy retains responsibility for its own
runtime isolation, health, persistence semantics, safe provider boundaries,
release artifacts, and migrations. The deployer retains responsibility for
tenant infrastructure, load balancing, databases and systems of record,
backup services, monitoring/SLOs, and durable application workflows.

Replica enablement remains a separate future capability gated by the residual
blockers above. It is not a prerequisite for the first OSS production release.

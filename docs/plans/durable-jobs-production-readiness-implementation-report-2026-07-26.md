# Durable Jobs Production-Readiness Implementation Report

**Date:** 2026-07-26

**Branch:** `production/durable-jobs`

**Pull request:** [#165](https://github.com/looselyorganized/auggy/pull/165)

**Status:** implementation complete; required local integration gates passed

## Outcome

Auggy now owns a narrow durable boundary around one trusted complete turn. It
can persist application-authored work, run it after restart, materialize
bounded UTC schedules, cancel cooperatively, retain redacted history, and stop
automatic replay whenever a post-start outcome is uncertain.

This does not make Auggy a workflow or distributed job platform. Durable Jobs
v1 supports one process and one replica on a private SQLite volume. Multi-step
business workflows, human waits, compensation, and independent service retry
remain external-orchestrator responsibilities. The standalone Temporal example
demonstrates that division.

## Implementation checkpoints

| Checkpoint | Outcome | Ending commits |
| --- | --- | --- |
| Store and crash contract | Branded fenced SQLite store; immutable idempotency binding; bounded payload/history/capacity; conservative recovery and reconciliation | `dff312a` through `5f6e35f` |
| Execution boundary | Trusted versioned execution context, unique downstream operation IDs, pre-model start hook, bounded worker, cancellation, deadline quarantine | `6e99c48`, `8198229`, `e45f01a`, `8618317` through `8dd3e22` |
| UTC schedules | Bounded parser; deterministic occurrences; pause/config separation; prefix progress under capacity; exact `DJOB/v1` to `DJOB/v2` migration | `d57c095`, `4845680`, `c9c3e08`, `e5c3db1`, `e68a85c` |
| Runtime and recovery | Opt-in lifecycle integration; post-ready recovery; serialized ticks; private-volume mapping; config fingerprint and backup identity validation | `000d3e8`, `53971ab`, `3d2f468`, `3d0b44d`, `0883138`, `d788381`, `deffe39` |
| Operator controls | Redacted list/inspect; fenced cancel/retry/reconcile; bounded prune; schedule list/pause/resume; nonzero unapplied mutations; CLI cannot migrate state | `e8e8760`, `5dbeff8`, `396dcbe` |
| Embedding and orchestration | Explicit Bun-only `auggy/jobs` subpath and hardened Temporal order-support example | `49226d2`, `3ac1955`, `432e8a9`, `1aa45bb` |
| Release evidence | Tracked test inventory, isolated nested dependency gate, aggregate/rehearsal/publish enforcement, packed subpath imports | `ae86b25`, `86161bb`, `7ff9f35`, `d5674dc` |

## Security and reliability invariants

- Job IDs and lease tokens are server-minted. An idempotency key binds one
  canonical payload and target or conflicts.
- A fenced lease is durably marked `running` immediately before inference or a
  tool may begin. Stale lease tokens cannot start, heartbeat, or settle work.
- Unstarted interruptions may retry within bounded policy. Started uncertainty
  becomes `outcome_unknown` and requires exact incident/version reconciliation.
- A timed-out non-cooperative turn is detached and quarantined; it is never
  blindly retried or allowed to overwrite a later settlement.
- Schedule occurrences are unique across restart and competing SQLite handles.
  Downtime coalesces to at most one occurrence per schedule per tick.
- A capacity-constrained tick commits the deterministic prefix that fits and
  leaves the rest due, avoiding both over-admission and rollback livelock.
- Operator output is an explicit metadata projection. Prompts, bindings,
  responses, provider errors, and reconciliation evidence are not printed.
- CLI compare-and-set refusal is machine-observable through a nonzero exit.
- Only runtime startup may perform the exact v1-to-v2 migration. Operator reads
  and mutations refuse older state without changing it.
- Backup and restore require the exact `DJOB/v2` application ID and user
  version before a replay-critical bundle can be accepted.

## Adversarial review disposition

Fresh reviewers repeatedly inspected exact checkpoint diffs. Confirmed issues
were repaired and re-reviewed:

1. Existing `DJOB/v1` databases would have been rejected after schedule tables
   were added. Fixed with an atomic exact-schema v1-to-v2 migration and
   lookalike rejection before DDL.
2. Operator retry left the attempt ledger inconsistent, causing reopen to
   fail. Fixed by atomically recording `failed` to `requeued` attempt history.
3. Multiple due schedules could roll back the entire tick at capacity and
   livelock. Fixed with deterministic capacity-prefix materialization.
4. Recovery inventory mislabeled the store and omitted its SQLite identity.
   Fixed with `DJOB/v2` registry enforcement and valid/wrong-identity tests.
5. The isolated Temporal suite was not required by aggregate release gates.
   Fixed across primary CI, rehearsal, and publish verification.
6. Stale CLI mutations exited successfully. Fixed with stable JSON plus a
   nonzero exit for every unapplied mutation.
7. An observational CLI command could silently migrate an older database.
   Fixed with read-only version preflight plus a store-level
   `allowMigrations: false` race backstop.
8. A supposedly non-migrating store open could still create a missing database
   or initialize an empty one. Fixed by coupling `allowMigrations: false` to
   SQLite `create: false` and rejecting missing, empty, and v1 state before DDL.
9. The worker accepted `success: true` with a non-completed task status, so an
   `input-required` turn could be persisted as completed. Fixed by requiring
   exact boolean success and exact `completed` status; every other post-start
   result is quarantined for reconciliation.

The final cross-cutting reviews traced authority, thread ownership, execution
start, fencing, recovery, cancellation, reconciliation, schema admission,
schedules, operator output, package exports, Temporal transport, CI coverage,
and release contents. No reviewed High or Medium issue remains.

## Compatibility and operations

- `settings.jobs` is optional. Omission creates no database, worker, scheduler,
  route, or model authority.
- The exact branded `DJOB/v1` schema migrates to `DJOB/v2` on new-runtime
  startup. A v1 binary cannot reopen v2; rollback requires the complete
  pre-upgrade runtime-volume bundle.
- The database stores private prompts and bindings in plaintext. Operators own
  volume encryption, backup confidentiality, retention, and downstream
  reconciliation evidence.
- One live replica and one dedicated volume are required. Sharing SQLite or a
  volume between replicas is unsupported and does not provide distributed
  execution.
- `auggy/jobs` loads `bun:sqlite` and is therefore a Bun-only package subpath.
- The Temporal example owns its own dependencies and lockfile and remains
  outside the Auggy runtime dependency graph.

## Residual risks

- A trusted operator can deliberately configure shared schedule thread IDs;
  normal peer ownership still prevents reuse of an external user's thread.
- SQLite free pages can outlive logical pruning. Reclaiming filesystem space is
  an explicit stopped-maintenance operation.
- The deliberately high hard option ceilings can make startup validation
  expensive when an operator configures extreme retained histories; defaults
  are substantially lower and every admitted record/history dimension remains
  bounded.
- A single-turn downstream operation still needs its own deterministic
  idempotency support. Stable operation IDs make this possible but cannot make
  a non-idempotent external API safe.
- No authenticated remote execution-cancellation endpoint is claimed. Temporal
  cancellation and ambiguous remote outcomes remain manual-reconciliation
  states in the example.
- The explicit CI shard/external-suite manifest must be maintained as new test
  roots are introduced; inventory validation prevents silent unassigned files.
- A non-cooperative turn can monopolize the sole v1 worker until it settles or
  the process restarts. Its persisted state is already quarantined and cannot
  be replayed blindly.
- Capacity is allocated to a deterministic schedule prefix. An earlier due
  schedule can temporarily block a later one until capacity is recovered; the
  definition count and work per tick are bounded.
- The operator CLI's read-only identity preflight has a same-host leaf-swap
  classification race. The hardened store open repeats containment with
  `NOFOLLOW`, uses `create: false`, emits no row contents, and performs no
  mutation, so this does not cross the private-volume trust boundary.
- A trusted job aimed at an already peer-owned thread is rejected before
  history, model, or tool execution, but the conservative execution-start
  boundary records it as `outcome_unknown`. Dedicated schedule thread IDs avoid
  the resulting manual-recovery burden.
- Restoring an old snapshot cannot prove which later external effects occurred.
  The restore fence fails closed until an operator reconciles downstream state.
- Recurring schedule database failures retry at the fixed configured tick
  interval rather than exponential backoff. The interval is bounded and each
  failure emits a stable diagnostic code.
- The nested Temporal dependency audit requires registry availability and
  fails closed when the registry cannot be reached.

## Verification record

Checkpoint verification included focused `bun:test` suites, two-handle SQLite
races, restart fixtures, secret sentinels, and repeated hostile reviews. The
final local gate produced these results:

| Command | Result |
| --- | --- |
| Focused jobs, CLI, recovery, export, and CI suites | 266 passed, 0 failed |
| Fresh hostile-review focused suites | 243 passed and 258 passed independently, 0 failed |
| Completion-state regression and adjacent agent tests | 39 passed, 0 failed |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed; one informational Biome schema-version notice |
| `bun run test:inventory` | 280 runtime, 29 console, and 3 isolated external test files assigned exactly once |
| `bun run test:runtime` | Passed every canonical runtime shard with loopback access |
| `bun run test:admin` | 243 passed, 0 failed |
| `bun run build:admin` | Passed |
| `bun audit --json` | Passed with `{}` |
| `bun run test:temporal-example` | Frozen install, 64 tests, typecheck, and audit passed |
| `bun run smoke:release` | Passed packed contents, isolated provider consumers, CLI scaffold, doctor, health, console assets, and installed-consumer audit |
| `git diff --check` | Passed |

The restricted local sandbox initially prevented loopback binding with
`EPERM`/`EADDRINUSE`. The exact canonical runtime inventory passed when rerun
with loopback access; isolated affected server files also passed. CI results
and their immutable commit association are recorded on PR #165. No package
version was changed and no package was published.

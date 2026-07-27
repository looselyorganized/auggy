# Durable Jobs Production-Readiness Implementation Report

**Date:** 2026-07-26

**Branch:** `production/durable-jobs`

**Pull request:** [#165](https://github.com/looselyorganized/auggy/pull/165)

**Status:** implementation complete; final integration gates pending

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

No reviewed High or Medium issue remains in a completed checkpoint.

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

## Verification record

Checkpoint verification included focused `bun:test` suites, TypeScript,
Biome, diff checks, two-handle SQLite races, restart fixtures, secret
sentinels, and repeated hostile reviews. Final aggregate, audit, packed-release,
and CI results will be recorded in PR #165 before it is marked ready. No package
version was changed and no package was published.

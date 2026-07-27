# Durable Jobs Production-Readiness Plan

**Date:** 2026-07-26

**Status:** implemented on `production/durable-jobs`; final gates tracked in PR #165

**Branch:** `production/durable-jobs`

**Base:** `production/single-replica-readiness` (PR #164)

**Implementation report:**
[`durable-jobs-production-readiness-implementation-report-2026-07-26.md`](./durable-jobs-production-readiness-implementation-report-2026-07-26.md)

## Product decision

Auggy will own a narrow, runtime-level durable job facility for trusted,
operator- or application-authored Auggy turns. It will not become a general
workflow engine.

Durable Jobs v1 will support persisted background turns, UTC schedules,
bounded retries for definite failures, restart recovery, cancellation,
retention, and operator recovery. The durable boundary is one complete Auggy
turn. Internal model and tool steps are not individually replayed or
checkpointed.

Business-critical multi-step workflows, long-lived human approval flows,
compensation graphs, and distributed workflow-history replay belong to an
external orchestrator such as Temporal. Auggy will provide a stable execution
contract and a production-oriented Temporal example rather than embedding
Temporal as an augment.

## Revalidation

Current source has no persistent job queue or cron scheduler.
`AgentHandle.inject()` and the keyed turn scheduler are process-local.
`scheduleAfterTurn` is a bounded causal hook and disappears with the process.
The AgentMail and notification ledgers contain useful delivery patterns, but
they are capability-specific and cannot serve as a general job service.

The single-replica deployment, recovery, load evidence, failure injection, and
load-balancer ownership requirements already exist on the base branch. This
work reuses those contracts and does not duplicate them.

## Security invariants

1. Only trusted application and operator code can submit or schedule jobs by
   default. No public route or model-facing tool receives job authority.
2. Every job has a server-minted identifier and immutable canonical binding.
   A reused idempotency key joins the same job or conflicts; it never creates a
   second execution with changed input.
3. A store grants at most one active fenced lease. Stale workers cannot renew,
   start, or settle work.
4. Execution is durably marked immediately before the runtime may invoke the
   model or a tool.
5. Interrupted claims that never started may be requeued. Interrupted started
   work becomes `outcome_unknown` and is never retried automatically.
6. Definite failures retry only under explicit bounded policy. Side-effecting
   ambiguity requires operator reconciliation.
7. Cancellation is durable. Queued work cancels atomically; active cooperative
   work receives an `AbortSignal`; an ambiguous terminal race fails closed.
8. Each cron occurrence has one deterministic identity. Restart and competing
   scheduler ticks cannot materialize duplicates.
9. Persisted request/result data, error summaries, listings, retention, and
   work per tick are bounded. Default operator output contains no prompts,
   credentials, tool arguments, or provider bodies.
10. SQLite Durable Jobs v1 remains single-replica. A shared SQLite volume or
    load balancer does not enable horizontal scaling.

## Implementation checkpoints

### 1. Store contracts and SQLite implementation

- Add a dedicated transactional `DurableJobStore`; do not widen the generic KV
  `Storage` contract.
- Add an exact, branded SQLite schema with bounded payloads, attempts,
  schedules, incidents, versions, leases, and retention.
- Test parallel submission, immutable binding, two-handle claims, fencing,
  interrupted-before-start recovery, interrupted-after-start quarantine,
  cancellation races, schema rejection, and secret-safe diagnostics.

### 2. Runtime worker and execution context

- Add a versioned execution context propagated to turn state, tool context,
  results, and trusted embedding calls.
- Run claimed jobs through the normal agent scheduler with a job-owned signal.
- Persist the execution-start boundary before inference or tool dispatch.
- Stop admission, abort cooperative work, and conservatively settle ambiguous
  work during shutdown.
- Test completion, definite retry, cancellation, restart, outcome unknown, and
  capacity interaction using deterministic barriers.

### 3. UTC cron and restart-safe materialization

- Support a bounded five-field UTC cron grammar.
- Persist schedule versions, template bindings, deterministic occurrence keys,
  and `next_fire_at`.
- Coalesce missed occurrences to at most one job on restart.
- Test invalid expressions, races, clock movement, pause/resume, revision, and
  crash boundaries.

### 4. Configuration and operator controls

- Add explicit `settings.jobs` configuration and production-volume path
  resolution.
- Add `auggy jobs list`, `inspect`, `cancel`, `retry`, `reconcile`, `prune`, and
  schedule inspection/control with expected-version compare-and-set behavior.
- Refuse blind retry of `outcome_unknown` jobs.
- Register the job database in runtime-state inventory, backup, restore, and
  reconciliation ordering.

### 5. Orchestrator integration contract

- Keep `AgentHandle.inject()` as the trusted low-level embedding API.
- Define stable execution IDs, attempts, deadlines, cancellation, correlation,
  and derived downstream operation identities without leaking raw
  idempotency keys.
- Add a Node-oriented Temporal order-support example that treats target,
  credentials, identity, retry policy, and task queue as operator
  configuration.
- Map Auggy completion, rejection, binding conflict, admission failure,
  cancellation, and outcome ambiguity conservatively.
- Do not claim end-to-end remote cancellation until an authenticated execution
  control boundary exists.

### 6. Documentation and release evidence

- Update the north star and feature matrix to distinguish durable one-turn jobs
  from workflows.
- Document default limits, plaintext-at-rest implications, retention, backup,
  restore, single-replica topology, load-balancer ownership, and Temporal data
  retention.
- Add failure-injection tests and packed/scaffold release-smoke coverage.
- Keep the separate release-automation gap—RC tag parsing and `next` versus
  `latest` publishing—isolated in its own commit or follow-up PR if it does not
  share the durable-jobs boundary.

## Required loop

For every checkpoint:

1. Revalidate callers, persistence, compatibility, and failure boundaries.
2. Add a failing test or executable reproduction.
3. Implement the smallest complete boundary.
4. Add negative, concurrency, restart, cancellation, and bypass coverage.
5. Run focused tests, typecheck, lint, and diff checks.
6. Give the exact checkpoint diff to a fresh hostile reviewer.
7. Verify and fix every confirmed High or Medium finding.
8. Commit the checkpoint conventionally and record its ending SHA.

After all checkpoints, run the tracked suites in bounded shards, console tests
and build, dependency audit, release smoke, package inspection, and a final
cross-cutting hostile review. Open one stacked draft PR early and do not merge
it. Mark it ready only when all applicable gates pass.

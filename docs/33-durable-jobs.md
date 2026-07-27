# Durable Jobs

Durable Jobs is Auggy's narrow persistence boundary for trusted background
turns. It lets application code or an operator submit one complete Auggy turn,
run it after a restart, schedule it with a bounded UTC cron expression, and
recover conservatively when the process loses a trustworthy result.

It is deliberately not a general workflow engine. A durable job checkpoints
the boundary around one turn; it does not checkpoint individual model calls,
tool calls, approvals, or business actions inside that turn.

## Supported topology and authority

Durable Jobs v1 supports one process and one replica for one logical Auggy.
The SQLite database must be on that replica's private durable volume. Sharing
the file or volume with another live replica is unsupported and does not create
distributed scheduling or fencing.

Submission and scheduling are trusted embedding and operator capabilities.
Auggy does not expose them as a public route, console action, augment tool, or
model-callable capability. A prompt cannot grant itself durable execution.

Durable turns run as the system peer (`peer: null`). Use dedicated thread IDs
for this work. They cannot impersonate an authenticated customer, and a thread
already bound to another peer is rejected by the normal runtime boundary.

The programmatic contract is exported from `auggy/jobs`. That subpath is
Bun-only because its SQLite implementation uses `bun:sqlite`; it is not a
Node-compatible subpath merely because the package metadata also declares a
Node engine for build and integration tooling. The job APIs are deliberately
absent from Auggy's root export.

A custom Bun host can own the same boundary directly. It must preserve the
runtime order shown here and keep submission outside model/public authority:

```ts
import { randomUUID } from "node:crypto";
import { createDurableJobRuntime, createSqliteDurableJobStore } from "auggy/jobs";

const store = createSqliteDurableJobStore({ dbPath: "./data/durable-jobs.sqlite" });
const worker = createDurableJobRuntime({
  agent,
  store,
  workerId: `worker:${randomUUID()}`,
});

await agent.start();
store.recoverExpiredLeases();
worker.start();

store.submit({
  idempotencyKey: trustedRequestId,
  binding: { operation: "daily-review", accountId },
  payload: {
    version: 1,
    value: {
      version: 1,
      kind: "agent-turn",
      threadId: `daily-review:${accountId}`,
      prompt: trustedPrompt,
      timeoutMs: 300_000,
      maxAttempts: 3,
    },
  },
});

// Shutdown order: stop admission/work, stop the agent, then close SQLite.
await worker.stop();
await agent.stop();
store.close();
```

The configured CLI runtime performs this ordering automatically. Custom hosts
also own safe path resolution, configuration bounds, schedule reconciliation,
and ensuring only one live worker uses the private volume.

## Configuration

Omitting `settings.jobs` is a complete opt-out: Auggy creates no job database,
worker, scheduler, route, or model authority. A minimal scheduled setup is:

```yaml
settings:
  jobs:
    enabled: true
    dbPath: ./data/durable-jobs.sqlite
    schedules:
      - id: daily_review
        cron: "0 9 * * *"
        prompt: Review the overnight support queue and summarize exceptions.
        enabled: true
        maxAttempts: 3
        timeoutMs: 300000
```

Cron has exactly five numeric UTC fields. It supports wildcards, lists,
ranges, and positive steps; names, seconds, macros such as `@daily`, and local
time zones are rejected. Day-of-month and day-of-week use standard OR
semantics when both are restricted.

The default job limits are:

| Setting | Default |
| --- | ---: |
| Lease duration | 30 seconds |
| Heartbeat interval | 5 seconds |
| Claim polling | 250 milliseconds |
| Turn timeout | 5 minutes |
| Automatic attempts | 3 |
| Total retained jobs | 10,000 |
| Outstanding jobs | 1,000 |
| Job payload and binding bytes | 128 MiB aggregate |
| Schedule-definition bytes | 8 MiB aggregate |
| Terminal retention | 30 days |
| Reconciliation-audit retention | 90 days |

Schedules are reconciled before background admission. Due occurrences are
materialized after the agent is fully started and before job polling begins;
subsequent checks run serially at a bounded interval. A recurring tick failure
emits only `schedule-tick-failed` and is retried on the next tick. Startup
schema, schedule, recovery, or initial-materialization failures stop startup
instead of serving with a partially initialized job boundary.

## State machine

```text
                         definite pre-start failure
queued -> leased ------------------------------------> failed
            |  |
            |  +-- lease lost before execution ------> queued
            |
            +-> running -> completed
                  |   |
                  |   +-- cooperative cancellation --> canceled
                  |
                  +-- ambiguous interruption --------> outcome_unknown
```

The store records a fenced lease before a worker receives private job data.
Immediately before context, model, or tool work may begin, the runtime records
the `running` transition. A stale lease token cannot start, heartbeat, settle,
or overwrite a newer attempt.

An expired lease that never crossed the start boundary can be requeued within
the configured attempt limit. Once execution started, a crash, lost lease,
non-cooperative timeout, or uncertain cancellation becomes
`outcome_unknown`. Auggy never retries that state automatically. An operator
must inspect the downstream system and reconcile the exact incident and
version.

Cancellation is durable and cooperative. Queued work is canceled atomically;
running work receives an `AbortSignal`. If work may have crossed a side-effect
boundary and does not return a trustworthy terminal result, cancellation fails
closed as `outcome_unknown` rather than claiming that the effect did not occur.

## Identity and replay

Every job has a server-minted identifier. A caller supplies an idempotency key
and a canonical binding. Reusing the key with the same binding joins the
existing job; changing the prompt, thread, execution settings, or other bound
input is a conflict. The raw key is not persisted.

Each execution receives a versioned trusted execution context containing a
stable execution ID, attempt number, deadline, and optional correlation ID.
Downstream tool operation IDs are derived from that context and their position
in the turn. This makes retries observable and gives a deterministic service a
stable idempotency input. It does not make a non-idempotent downstream API safe
by itself.

## UTC schedules

Configured schedules use a bounded five-field UTC cron grammar. Schedule
definitions, revisions, pause state, next-fire time, and materialized
occurrences are persisted with the jobs they create.

An occurrence has one deterministic identity. Startup and repeated scheduler
ticks cannot enqueue it twice. When the process was offline across several
fire times, v1 coalesces the missed interval into at most one job and advances
the next-fire time beyond the current tick. It does not replay every missed
minute.

Configuration controls whether a schedule exists and whether it is enabled.
Operator pause is a separate durable state: restarting or re-reading unchanged
configuration does not silently resume a paused schedule.

## Data, limits, and retention

The SQLite database contains private prompts and bindings in plaintext. Keep it
on an owner-only volume, encrypt the volume or backup destination when required,
and never attach it to a public file server. Default list and inspect surfaces
return metadata, fixed error codes, and hashed reconciliation evidence—not
prompts, tool arguments, provider responses, credentials, or model output.

The runtime enforces bounded prompt and JSON sizes, nesting and node limits,
active-job and total-record capacities, attempt and audit-history limits,
per-turn timeouts, lease durations, work per poll, and retention windows. The
private-byte capacity covers canonical job payloads and bindings; it is not a
promise about total SQLite file size. Results are metadata-only and separately
bounded. SQLite can retain free pages after deletion, so reclaiming filesystem
space is an explicit stopped-maintenance concern.

Schedule definitions use their own fixed 8 MiB aggregate private-data budget.
Each definition is also preflighted against the configured job private-byte
limit using worst-case occurrence metadata, so the scheduler cannot accept a
definition that can never become a job. At capacity, a tick commits the
deterministic prefix that fits and leaves the rest due; it does not roll the
successful prefix back into a livelock.

Terminal jobs and reconciliation audit records have separate retention
windows. Pruning is bounded and explicit. Capacity exhaustion fails closed;
Auggy does not evict active work or erase unresolved incidents to admit a new
job.

## Backup, restore, and upgrades

The durable-jobs database is replay-critical runtime state. Include it in the
same stopped, integrity-manifested runtime-volume backup as transport replay,
delivery, notification, console, and memory stores. Do not copy only a SQLite
main file while omitting live WAL state.

After restore, keep ingress closed until downstream effects and every
`outcome_unknown` incident have been reconciled. Restoring an older database
can restore an older view of external effects; a volume snapshot is not a
transaction with payment, email, booking, or other external systems.

The store uses `DJOB/v2`. It atomically migrates only the exact branded
pre-schedule `DJOB/v1` schema; malformed lookalikes fail before DDL or version
changes. Unknown, newer, partially migrated, or structurally altered catalogs
fail closed. Restoring a v1 binary after v2 has opened the database is not a
supported rollback: restore the complete pre-upgrade bundle instead. Rehearse
upgrades and rollback with matching code, configuration, secrets, and complete
state bundles. Operator CLI commands never perform this migration: after an
upgrade, start the sole new runtime once before using `auggy jobs`.

## Operator controls

The CLI opens only the configured owned database and emits redacted JSON:

```bash
auggy jobs list [name] [--state failed] [--limit 100]
auggy jobs inspect <job-id> [name]
auggy jobs cancel <job-id> [name] --version <version>
auggy jobs retry <job-id> [name] --version <version>
auggy jobs reconcile <job-id> [name] \
  --version <version> --disposition retry --evidence ticket-123
auggy jobs schedules list [name]
auggy jobs schedules pause <schedule-id> [name] --version <version>
auggy jobs schedules resume <schedule-id> [name] --version <version>
auggy jobs prune [name] --before <strict-UTC-ISO> --limit 1000 --yes
auggy jobs prune-audit [name] --before <strict-UTC-ISO> --limit 1000 --yes
```

`retry` accepts only a definite `failed` job. It cannot bypass an
`outcome_unknown` incident; that state requires evidence-bearing
`reconcile`. Every mutation is compare-and-set against the displayed version.
Stale, missing, ineligible, or otherwise unapplied mutations emit their stable
JSON result and exit nonzero so automation cannot mistake refusal for success.
Schedule output includes cron and state metadata, never prompts or bindings.
Pruning is permanent, bounded, and requires `--yes`.

## When to use an external workflow engine

Use Durable Jobs when the unit of work is one bounded Auggy turn and it is safe
to treat any post-start interruption as an operator incident.

Use Temporal or another workflow engine when the business process spans
multiple durable steps, hours or days, human approval, timers, compensation,
or independent service retries. The workflow should own business state and
call Auggy as one activity. It should advance only after an exact completed
result; rejection, cancellation, timeout, malformed responses, and ambiguous
execution remain manual-reconciliation states.

The Temporal order-support example demonstrates this boundary. It is a
standalone operator-owned application, not an augment and not a dependency of
the Auggy runtime.

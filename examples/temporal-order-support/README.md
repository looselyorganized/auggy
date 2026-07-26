# Temporal order-support workflow

This is an external Node/TypeScript integration example, not an Auggy augment
and not a published package. It shows the intended boundary:

```text
Temporal Workflow (durable order/refund sequence)
  -> authenticated Activity (one Auggy /agent/run turn)
  -> deterministic refund processor or manual reconciliation
```

Temporal owns workflow history, retries, compensation, and any eventual
payment/refund Activity. Auggy contributes one bounded support turn. Free-form
model output is never used to authorize or execute a refund.

## What is configured where

| Concern | Owner | Location |
| --- | --- | --- |
| Auggy HTTPS target and bearer credential | worker operator | `AUGGY_TARGET`, `AUGGY_BEARER_TOKEN` |
| Temporal address, namespace, API key, and task queue | worker/starter operator | `TEMPORAL_*` environment variables |
| Activity timeout, cancellation mode, and retry budget | workflow deployment operator | [`src/workflow-policy.ts`](./src/workflow-policy.ts) |
| Order/refund identifiers and amount | trusted application | Workflow input |

Target, credentials, task queue, and retry policy are not Workflow arguments,
agent messages, or model-controlled values. `workflow-policy.ts` is deliberately
source-controlled deployment configuration: changing it requires a normal
Temporal-compatible Worker rollout, rather than reading mutable environment
state inside deterministic Workflow code.

## Run locally

This requires a reachable Temporal service and a separately deployed,
bearer-protected Auggy agent. The client deliberately rejects non-HTTPS Auggy
targets; its loopback HTTP exception exists only in the contract tests.

```bash
cd examples/temporal-order-support
bun install
cp .env.example .env

# Terminal 1: use an environment-file mechanism appropriate to your shell.
bun --env-file=.env run worker

# Terminal 2: start one business workflow from trusted application input.
bun --env-file=.env run start -- order_1042 refund_8001 2599 damaged
```

Use a real secret manager or deployment environment for `AUGGY_BEARER_TOKEN`;
`.env` is a local-development convenience and is ignored by Git.

## Durable execution contract

`orderRefundWorkflow` derives one bounded Auggy `Idempotency-Key` from the
stable Temporal Workflow ID. Every Temporal Activity attempt carries that exact
same key. Auggy therefore joins/replays the intended operation rather than
starting another model turn when the network or worker fails.

The Activity POSTs JSON to `/agent/run` with a bearer token, refuses redirects,
and receives AG-UI SSE. It accepts only a bounded stream (default 1 MiB / 10,000
events; immutable ceilings 4 MiB / 100,000 events) and an 8 KiB bearer-token
ceiling. It requires exactly one bounded `RUN_STARTED` whose `threadId` matches
the request, matching terminal `runId`/`threadId`, and
`RUN_FINISHED.result.status === "completed"`. It retains only the server-minted
`runId`; model text and HTTP bodies are not copied into the Activity result or
application logs.

| Auggy result | Example behavior |
| --- | --- |
| One matching `RUN_STARTED` then `RUN_FINISHED.result.status === "completed"`, with no `RUN_ERROR` | Returns `ready-for-deterministic-refund`; a real payment Activity may follow. |
| `RUN_ERROR` `ADMISSION_FAILED`, `SCHEDULER_RATE_LIMITED`, or `SCHEDULER_UNAVAILABLE`; transient HTTP failure; HTTP 408/425/429/500/502/503/504 | Temporal retries the same Activity input and same idempotency key, within the configured budget. |
| HTTP 409 `idempotency_key_conflict` | Never retries as a fresh run; returns `manual-reconciliation-required`. |
| HTTP 409 `idempotency_outcome_unknown`, `RUN_ERROR` `INTERNAL`/`THREAD_QUARANTINED`/unknown, a parser/stream limit, or malformed execution sequence | Fails closed into `manual-reconciliation-required`; investigate or reconcile using the same key. |
| `RUN_FINISHED.result.status` `failed`, `canceled`, `input-required`, `auth-required`, `working`, or unknown | Never counts as completion; returns the applicable manual-reconciliation reason. |
| `RUN_FINISHED.result.status === "rejected"`, HTTP authentication/validation rejection, or `RUN_ERROR` `CAP_DENIED`/`REJECTED` | Does not retry automatically; returns `manual-reconciliation-required`. |

Every SSE classification above is subordinate to the execution-sequence gate.
If the server emits a rejection before `RUN_STARTED`, the client does not infer
that an execution existed: the missing start makes the stream invalid and the
Workflow routes it to manual reconciliation. It never relaxes the one-start,
one-matching-terminal requirement to recover a more convenient error code.

The key is an execution binding, not a business authorization token. Keep it
out of user-visible logs and do not manufacture a new key to escape a conflict
or unknown outcome.

## Cancellation and heartbeats

The Activity heartbeats at least every five seconds and passes Temporal's
cancellation signal to `fetch`. With the configured
`WAIT_CANCELLATION_COMPLETED` mode, a Workflow cancellation waits for the
Activity to observe cancellation and stop waiting on its HTTP connection.

That is **not remote Auggy cancellation**. Today, an admitted keyed Auggy run
can survive an ordinary client disconnect so that another request with the same
key can join or replay it. Cancellation here stops the Temporal Activity's
wait; it does not claim that the model/tools stopped. A later retry or business
reconciliation must use the same idempotency key. Do not promise end-to-end
remote cancellation until Auggy exposes an authenticated execution-control
endpoint. Conversely, a remote `RUN_ERROR` `CANCELED`/`CANCELLED`/`ABORTED`
does not enter Temporal's local cancellation path; it fails closed into manual
reconciliation.

## Temporal data retention and privacy

Temporal persists Workflow input and Activity input in Workflow history. This
example's order/refund identifiers and generated support message are therefore
Temporal data. It intentionally never includes credentials in that data and
does not return model output, but operators still need to:

- set an explicit Namespace retention period appropriate for order/support
  records;
- enable the Temporal deployment's encryption, access controls, and payload
  codec strategy where required;
- avoid passing raw payment data, customer secrets, or credentials in Workflow
  arguments or Activity inputs; and
- verify the provider's backup, deletion, and incident procedures before use.

Temporal provides durable workflow replay; Auggy Durable Jobs provide durable
one-turn execution. Neither provides exactly-once external payment effects by
itself. The deterministic payment/refund system must have its own idempotency
and reconciliation controls.

## Verify

From the repository root, run the same frozen-install, test, typecheck, and
dependency-audit gate used by CI:

```bash
bun run test:temporal-example
```

The dependency-free Bun contract tests inject a fake Auggy HTTP transport. They
verify auth/key propagation, every terminal task state, execution cardinality
and identity, cancellation mapping, operator bounds, and SSE parser limits;
they do not contact a real agent or Temporal service. `bun audit --json` does
use the package registry and therefore runs in the dedicated online CI gate,
not the packed runtime smoke.

## Temporal references

- [TypeScript SDK API reference](https://typescript.temporal.io/)
- [`proxyActivities` and Workflow API](https://typescript.temporal.io/modules/workflow.html#proxyActivities)
- [Activity `Context` cancellation and heartbeat API](https://typescript.temporal.io/classes/activity.Context.html)
- [TypeScript Worker configuration](https://docs.temporal.io/develop/typescript/core-application#run-a-worker-process)
- [Activity execution, heartbeats, and retry policy](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

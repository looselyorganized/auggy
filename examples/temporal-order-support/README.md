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

The Activity POSTs JSON to `/agent/run` with a bearer token, receives AG-UI SSE,
and accepts only a bounded stream (default 1 MiB / 10,000 events). It retains
only the server-minted `runId`; model text and HTTP bodies are not copied into
the Activity result or application logs.

| Auggy result | Example behavior |
| --- | --- |
| Completed `RUN_FINISHED` | Returns `ready-for-deterministic-refund`; a real payment Activity may follow. |
| `RUN_ERROR` with `ADMISSION_FAILED`, transient HTTP failure, 429, or 5xx | Temporal retries the same Activity input and same idempotency key, within the configured budget. |
| HTTP 409 `idempotency_key_conflict` | Never retries as a fresh run; returns `manual-reconciliation-required`. |
| HTTP 409 `idempotency_outcome_unknown`, a parser/stream limit, or malformed terminal stream | Fails closed into `manual-reconciliation-required`; investigate or reconcile using the same key. |
| Authentication/validation rejection or `RUN_ERROR` `REJECTED` | Does not retry automatically; returns `manual-reconciliation-required`. |

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
endpoint.

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

```bash
bun test test/auggy-client.test.ts
bunx tsc --noEmit -p tsconfig.json
```

The dependency-free Bun contract test injects a fake Auggy HTTP transport. It
verifies auth/key propagation, conservative status mapping, and SSE parser
limits; it does not contact a real agent or Temporal service.

## Temporal references

- [TypeScript SDK API reference](https://typescript.temporal.io/)
- [`proxyActivities` and Workflow API](https://typescript.temporal.io/modules/workflow.html#proxyActivities)
- [Activity `Context` cancellation and heartbeat API](https://typescript.temporal.io/classes/activity.Context.html)
- [TypeScript Worker configuration](https://docs.temporal.io/develop/typescript/core-application#run-a-worker-process)
- [Activity execution, heartbeats, and retry policy](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

# Delivery and Operator Recovery Contracts

**Supported topology:** one runtime replica for one logical Auggy deployment

Auggy owns deterministic admission, replay, ambiguity, and recovery behavior.
The deployer owns provider accounts, network delivery, runtime-volume custody,
backup scheduling, and load-balancer infrastructure. Independent Auggys on one
host must use separate identities and state roots. A shared volume does not make
multiple replicas of one Auggy supported.

## Contract matrix

| Path | Admission and replay contract | Ambiguous effect | Recovery |
| --- | --- | --- | --- |
| Web `/agent/run` with idempotency key | One canonical peer/thread/body binding per key. Concurrent duplicates join; completed bounded responses replay. | A started claim that cannot commit becomes a durable `AUID/v2` unknown tombstone; the same key never executes again. | Caller keeps the same key to observe the tombstone and must not manufacture a new key as a retry. Runtime-volume restore remains fenced until downstream reconciliation. |
| Telegram inbound | `TGRP/v2` durably claims `(namespace, update_id, payload hash)`. Exact replays are ignored; conflicting content quarantines the namespace. | Conflicting content and ambiguous turns stop normal progress instead of advancing blindly. | Creator-authenticated, CSRF-protected conflict actions use the server incident identifier. Polling ownership conflicts require stopping the competing poller. |
| AgentMail inbound | REST catch-up, WebSocket, and Svix delivery converge on `AMIL/v2`. A message is durably claimed before kernel admission; an expired claim is fenced, never leased again. | Explicit unknown results, unknown exceptions, lost completion records, expired leases, and interrupted processing become durable incidents. Every later message in that provider thread is blocked, and its scheduler lane is restored on restart. | Creator action compares incident ID and version, records only an evidence hash, and chooses already-handled or confirmed-no-effect. Core releases the lane only after every durable authority for that runtime thread is clear. |
| AgentMail outbound/review | Requests are fingerprinted and quota-reserved before provider dispatch. Reviews preserve exact approved content. | A provider-reached request without a trustworthy result remains in an ambiguous sending state and is never automatically retried. | Creator verifies AgentMail state, then reconciles the exact review fingerprint as sent or failed. |
| Generic `notify` | `NTFY/v1` atomically reserves quota and an operation hash before any adapter await. Exact dedup and quota survive restart. Creator/system calls bypass quota, not replay safety. Direct construction requires durable state. | Throws, adapter-reported unknown results, invalid results, failed settlement, and interrupted pending attempts stay fenced. Runtime startup restores the thread fence before model work. | Creator action compares incident ID/version and records only a SHA-256 evidence digest. Confirmed delivery retains quota; confirmed no-effect releases it. Core still checks every other incident authority before lane recovery. |
| Link calls | Originating identity and delegated authority remain bound across the link; downstream authority cannot exceed the caller. | A non-cancelable post-dispatch timeout is outcome-unknown and terminates the turn. | No blind retry. Reconcile the downstream peer before trusted thread recovery. Link's package-owned task state remains an external recovery prerequisite. |
| Durable jobs | A trusted application/operator submission binds one idempotency key to one canonical system-peer turn. The store leases and marks execution started before inference or tools. | An interrupted unstarted lease may requeue within bounds. Any untrusted post-start result, non-cooperative deadline, or crash becomes a versioned `outcome_unknown` incident. | Inspect the downstream system, then reconcile the exact job incident/version as retry, cancel, or confirmed completed. Ordinary failed jobs and ambiguous jobs use different controls. |
| Lifecycle hooks and first-party tools | The keyed scheduler retains the lane through causally owned work and cancellation. Every admission also consults registered durable incident authorities. | Typed outcome-unknown errors quarantine the runtime thread before another model inference. Durable incidents are restored before routes or listeners register. | `recoverThread` is a trusted operator/application API, never a model tool. Core releases only after every registered authority reports the thread clear. |

## Recovery rules

1. Never retry merely because the client timed out or the process restarted.
2. Inspect the provider or downstream system independently.
3. Use only server-minted incident IDs and the current version.
4. Submit recovery through the authenticated console action with valid CSRF.
5. Do not place credentials, message bodies, provider responses, or customer
   data in evidence. Auggy hashes bounded evidence before persistence.
6. A stale, duplicated, or mismatched recovery request changes nothing.
7. If multiple incidents share a runtime thread, resolving one does not release
   the thread while another remains.

## Backup and deployment implications

`AUID/v2`, `DJOB/v2`, `TGRP/v2`, `AMIL/v2`, and `NTFY/v1` are replay-critical. Back them
up and restore them with the whole stopped runtime-volume workflow in
[`27-runtime-state-recovery.md`](./27-runtime-state-recovery.md). Copying only a
main SQLite file while omitting its WAL/SHM state is unsupported.

Multiple replicas serving one logical Auggy remain unsupported. The runtime
does not claim that shared SQLite, sticky sessions, or a load balancer supplies
distributed leases, fencing, history serialization, quota correctness, or
mixed-version safety. See the horizontal-scaling boundary in
[`production-readiness-engineering-boundary-2026-07-25.md`](./plans/production-readiness-engineering-boundary-2026-07-25.md).

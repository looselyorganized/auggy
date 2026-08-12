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
| AgentMail inbound | WebSocket subscription is established before paginated REST catch-up. Both paths converge on one `AMOR/v1` message claim and checkpoint; overlap is deduplicated by provider identity and payload hash. Sender admission and rolling rates are charged durably before kernel work. | A conflicting provider identity is quarantined. Interrupted processing becomes pending only after the bounded stale-claim interval; provider-native reply-draft creation uses a stable `clientId` so recovery does not create a second draft. | Startup, reconnect, and periodic repair rerun catch-up from the durable high-water mark. A newer message on the thread makes an awaiting managed draft stale. AgentMail remains the message and draft system of record. |
| AgentMail outbound/review | New sends reserve a durable operation/payload binding and rate evidence before provider dispatch. Reviewed replies use an AgentMail draft; Auggy stores its identifier and timestamp, not its editable body. Revision and send refetch the provider draft and require the creator's current timestamp plus a fresh explicit command. | A provider-reached send without a trustworthy result remains `ambiguous` and is never automatically retried. AgentMail does not offer an atomic conditional draft update, so Auggy verifies a revision with a readback and marks conflicts stale. | Inspect AgentMail before any follow-up. An ambiguous operation remains fenced in Auggy; do not manufacture a second operation or send. Draft-ready creator attention is restart-recoverable. Delivery-failure attention is durable only after the live event is observed because AgentMail exposes no message-addressable lifecycle replay. |
| Generic `notify` | `NTFY/v2` atomically reserves quota and an operation/payload binding before any adapter await. Exact dedup and quota survive restart. AgentMail creator digests use the same bounded quota rather than the model tool's creator bypass. Direct construction requires durable state. | Throws, adapter-reported unknown results, invalid results, failed settlement, and interrupted pending attempts stay fenced. Internal definitive failures have a durable attempt ceiling; unknown outcomes cannot be retried. Runtime startup restores the thread fence before model work. | Creator action compares incident ID/version and records only a SHA-256 evidence digest. Confirmed delivery retains quota; confirmed no-effect releases it. One additional internal attempt requires separate CAS-bound authorization over definitively failed attempts. A source-settled internal operation is durably acknowledged, sealed, and removed from active terminal capacity without losing replay evidence. Core still checks every other incident authority before lane recovery. |
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

`AUID/v2`, `DJOB/v2`, `TGRP/v2`, `AMOR/v1`, and `NTFY/v2` are replay-critical. Back them
up and restore them with the whole stopped runtime-volume workflow in
[`27-runtime-state-recovery.md`](./27-runtime-state-recovery.md). Copying only a
main SQLite file while omitting its WAL/SHM state is unsupported.

Multiple replicas serving one logical Auggy remain unsupported. The runtime
does not claim that shared SQLite, sticky sessions, or a load balancer supplies
distributed leases, fencing, history serialization, quota correctness, or
mixed-version safety. See the horizontal-scaling boundary in
[`production-readiness-engineering-boundary-2026-07-25.md`](./plans/production-readiness-engineering-boundary-2026-07-25.md).

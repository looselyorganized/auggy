# Telegram conflict quarantine and operator recovery

Date: 2026-07-24  
Branch: `security/telegram-conflict-recovery`  
Base: merged `main` at `e7c8e76`

## Objective

Harden Telegram inbound processing so a conflicting authenticated delivery
fails closed without retry churn, later updates cannot pass a compromised
replay namespace, and a trusted operator can recover without deleting or
replacing the canonical replay claim.

This plan addresses the residual risk recorded in
`docs/security-audit/2026-07-23-security-remediation-report.md`: a conflicting
polling payload for an already claimed update ID currently retries forever at
one offset. Revalidation also found a separate ownership conflict: Telegram Bot
API `getUpdates` HTTP/API 409 responses are flattened into generic errors and
retried forever.

## Revalidation and classification

### Replay payload conflict

Confirmed and conditional, Medium operational availability/integrity.

`handleUpdate()` hashes and atomically claims each `(namespace, update_id)`
before kernel dispatch. A different hash under an existing ID returns
`conflict`, so duplicate model/tool execution is already prevented. Polling
catches that typed conflict as a generic processing failure, leaves the offset
unchanged, and retries indefinitely. Webhook mode rejects only the conflicting
ID; a later fresh ID can still dispatch even though the authenticated source or
shared store has violated the namespace invariant.

Preconditions are a compromised or faulty authenticated Telegram delivery
source, webhook credential, bot token, explicit namespace collision, or shared
store corruption. An ordinary Telegram user cannot choose `update_id`, and an
unauthenticated webhook caller is rejected before dispatch.

### Polling ownership conflict

Confirmed and conditional, Medium operational availability/integrity.

Telegram uses 409 when `getUpdates` conflicts with another poller or webhook
owner. The client currently discards structured API status and the loop retries
forever, causing an opaque outage or polling duel. Recovery must not mutate
replay claims or automatically call `deleteWebhook`; the operator must first
reconcile the competing deployment and then resume the unchanged offset.

### Adjacent findings

- Canonically equivalent JSON objects with different property insertion order
  currently hash differently. This is a parser differential that can create a
  false conflict.
- Polling assigns `nextOffset = update_id + 1` without whole-batch ordering or
  successor validation. Malformed authenticated responses can regress or
  overflow the offset.
- Volatile polling offset alone is not a vulnerability: durable claims suppress
  execution when older updates are fetched again.

Telegram's official Bot API states that update identifiers increase
sequentially, except that the next identifier may be randomized after at least
a week without updates; `getUpdates.offset` must be one greater than the
highest previously received identifier, and webhooks and `getUpdates` are
mutually exclusive:

- <https://core.telegram.org/bots/api#getupdates>
- <https://core.telegram.org/bots/api#update>

## Security invariants

1. The first claimed payload hash remains canonical for its retention horizon.
2. Recovery never deletes, replaces, or executes the canonical claim.
3. A hash mismatch atomically quarantines the complete replay namespace.
4. No fresh update in that namespace can be claimed while quarantine is active.
5. Default SQLite quarantine survives restart and is visible to every process
   sharing the database.
6. Distributed stores coordinate claim, quarantine, inspection, and recovery in
   the same transactional domain or fail boot.
7. Recovery is compare-and-set bound to a server-minted opaque conflict ID.
8. Replay recovery records the exact conflicting hash as discarded, then
   polling advances only to the persisted conflict update plus one.
9. Polling ownership recovery leaves the offset and replay ledger unchanged.
10. Models, Telegram peers, and public routes cannot invoke recovery.
11. Admin, errors, warnings, and action results never expose tokens, payload
    text, remote descriptions, store credentials, or full hashes.
12. Shutdown wins races with recovery and no poll begins after stop.

## Trust transitions and assets

Protected assets are:

- at-most-once model/tool execution;
- Telegram queue availability and offset integrity;
- canonical replay history;
- bot credentials and message confidentiality;
- operator control over destructive acknowledgement.

Trust transitions are:

- Telegram API/webhook authentication to normalized update;
- canonical update serialization to shared replay claim;
- shared replay decision to kernel admission;
- creator-authenticated, CSRF-bound console action to CAS recovery.

The recovery action acknowledges a delivery as discarded. It is therefore
confirm-required and derives every affected namespace, ID, hash, and offset
from runtime/store state rather than operator-supplied coordinates.

## Implementation slices

### 1. Failing deterministic regressions

Add barrier-driven tests for:

- typed, redacted `getUpdates` 409;
- exactly one poll before ownership quarantine;
- replay conflict stopping the rest of a batch and all later polls;
- webhook namespace quarantine;
- shutdown while paused;
- monotonic, strictly ordered, safe update IDs;
- canonical nested JSON;
- durable conflict, restart, CAS recovery, and discard tombstone;
- multiple Telegram augments with unique admin action IDs.

No timing-only sleep is used for new concurrency assertions.

### 2. Durable replay conflict state

Migrate the hardened SQLite store from schema v1 to v2. Add:

- one active conflict row per namespace;
- server-minted conflict ID;
- update ID, canonical/conflicting SHA-256 values, and detection time;
- resolved discard tombstones keyed by namespace, update ID, and conflicting
  hash.

Claim, quarantine, and recovery are immediate transactions. An active conflict
precedes all new claims. Exact recovery inserts the discard tombstone before
removing the active conflict. Future delivery of that exact conflicting hash is
acknowledged as discarded and never dispatched. A third hash creates a new
conflict.

The public synchronous and asynchronous replay-store contracts gain required
conflict inspection and CAS recovery operations. Legacy custom stores fail boot
with an actionable compatibility error; process-local fallback would violate
the advertised distributed boundary.

### 3. Polling state machine and sanitized API errors

Add a typed `TelegramBotApiError` containing only method, HTTP status, and API
error code. Upstream descriptions and response bodies remain redacted.

The poll loop gains privacy-safe snapshots and a pause latch:

- replay conflict/quarantine pauses without another request;
- ownership 409 pauses without touching replay state;
- invalid update sequencing pauses before partial batch dispatch;
- stop aborts active polling and wakes paused work;
- resume is conflict-kind specific and monotonic.

### 4. Operator recovery

Telegram `adminInfo()` exposes:

- running or quarantined state;
- conflict kind, update ID when applicable, detection time, and opaque incident
  ID;
- a confirm-required recovery action declared before any conflict.

Action IDs are scoped by a stable non-secret replay-domain digest so distinct
bots do not collide in the global admin registry. Replay recovery persists the
CAS discard first, then wakes polling. Ownership recovery only wakes polling.
Missing, stale, malformed, cross-bot, or already-resolved incidents fail
closed.

### 5. Documentation and migration

Update public types, Telegram operator docs, changelog, root export/contract
tests, custom-store examples, backup/mixed-version warnings, and rollback
instructions.

## Adversarial review

A fresh exact-diff reviewer must check:

- any deletion or replacement of the canonical claim;
- process-local fallback for distributed replay conflicts;
- later batch entries executing after an earlier conflict;
- arbitrary offset input or offset advancement on ownership 409;
- stale/cross-bot recovery IDs and action-ID collisions;
- claim/recovery, shutdown/recovery, and restart races;
- parser differentials and unsafe integer successors;
- webhook bypass of namespace quarantine;
- retry loops while paused;
- raw payload, hash, token, DSN, or provider-description leakage;
- a custom store returning malformed conflict/recovery results.

Every confirmed High or Medium issue will be fixed and the review repeated.

## Verification

At minimum:

```text
bun test --max-concurrency=1 tests/telegram-client.test.ts
bun test --max-concurrency=1 tests/augments/telegram-transport/polling.test.ts
bun test --max-concurrency=1 tests/augments/telegram-transport/replay-store.test.ts
bun test --max-concurrency=1 tests/augments/telegram-transport.test.ts
bun test --max-concurrency=1 tests/augments/telegram-transport/webhook.test.ts
bun test --max-concurrency=1 tests/public-api/root-exports.test.ts
bun test --max-concurrency=1 tests/transports/admin/admin-boot-validation.test.ts
bun run typecheck
bun run lint
bun run smoke:release
git diff --check
```

Port-binding suites run sequentially. The final PR remains unmerged.

## Compatibility and rollback

- The default SQLite schema migrates v1 to v2 transactionally.
- Operators should back up `telegram-replay.db` and stop every writer before
  rollout or rollback.
- All replicas sharing a namespace must upgrade together. An old binary must
  reject the v2 database rather than ignore quarantine.
- Custom replay stores must implement the conflict-capable contract.
- Rollback requires stopping v2 writers and restoring the v1 backup; it is not
  code-only.
- Separate bots/namespaces remain isolated.
- Independent replica volumes still require one writer or a shared
  transactional store.

## Deferred boundary

This PR does not add general horizontal scaling for one logical Auggy agent.
It hardens the already public Telegram shared-store coordination boundary only.
CI test-surface inventory enforcement remains the next separate PR.

# 12 — Budgets Augment Reference

> Operator reference for the `budgets` augment — per-trust-level turn budgets, anonymous rate ceiling, dollar spend cap, and the BATS preamble. Source: `src/augments/budgets.ts` and `src/augments/budgets/`.

## 1. Overview

The `budgets` augment enforces admission caps on inbound turns before the engine runs. It is the sole built-in implementation of the `TurnGateProvider` 2PC contract (see [03-types.md § Section 7b](./03-types.md#section-7b--turn-gate-admission-2pc)).

What it does:

- **Turn caps** — limits turns per thread and per day, differentiated by trust level and `publicSubstate`.
- **Dollar cap** — facility-wide daily USD ceiling (blocks once crossed).
- **Anonymous rate ceiling** — facility-wide rolling-minute limit on anonymous-public requests.
- **BATS preamble** — injects a budget summary into the model's context so it can self-regulate verbosity and depth as the budget depletes.

What it does **not** do:

- No pre-call cost estimation (future work — see §10).
- No multi-instance coordination (single SQLite file; single agent process).
- No burst allowances, carry-over, or paid upgrades — those are application-level concerns.

## 2. Quick start

Minimal CLI project config:

```yaml
# agent.yaml
augments:
  - budgets

# augments/budgets/augment.yaml
type: budgets
config:
  dbPath: ./data/budgets.db
  caps:
    public:
      anonymous:
        maxTurnsPerThread: 5
      recognized:
        maxTurnsPerThread: 20
        maxTurnsPerDay: 50
  anonymousGlobalLimit: 60
```

Programmatic setup:

```ts
import { budgets } from "augment-1";

const budget = budgets({
  dbPath: "./data/budgets.db",
  caps: {
    public: {
      anonymous: { maxTurnsPerThread: 5 },
      recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1.00 },
    },
  },
  anonymousGlobalLimit: 60,
  dailyBudgetUsd: 50.00,
});
```

Enable it with `auggy augment add budgets` or add it to your agent's
`augments` array and create `augments/budgets/augment.yaml`. No other wiring is
needed — the kernel detects `turnGate` automatically.

## 3. Configuration reference

### Top-level fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `dbPath` | `string` | yes | — | Path to the SQLite database file. Created on first boot if absent. |
| `caps` | `object` | no | none | Per-trust-level cap configurations. |
| `caps.agent` | `BudgetCaps` | no | none (uncapped) | Caps for `agent`-trust peers. |
| `caps.public.anonymous` | `BudgetCaps` | no | none (uncapped) | Caps for `public` peers with `publicSubstate === "anonymous"`. |
| `caps.public.recognized` | `BudgetCaps` | no | none (uncapped) | Caps for `public` peers with `publicSubstate === "recognized"`. |
| `anonymousGlobalLimit` | `number` | no | none | Max anonymous requests per rolling 60-second window (facility-wide). |
| `dailyBudgetUsd` | `number` | no | none | Facility-wide daily USD ceiling (sum of all priced turns). |
| `cleanupWindowMs` | `number` | no | 3,600,000 | Milliseconds before a stuck pending reservation is swept to `allow:incomplete`. |

### `BudgetCaps` fields

| Field | Type | Description |
|---|---|---|
| `maxTurnsPerThread` | `number` | Maximum turns per `threadId` per calendar day. |
| `maxTurnsPerDay` | `number` | Maximum turns across all threads for this peer per calendar day. |
| `maxUsdPerDay` | `number` | Maximum USD spend per peer per calendar day. Post-hoc (see §9). |

All `BudgetCaps` fields are optional. Omit a field to leave that dimension unconstrained. An empty `BudgetCaps` (`{}`) is valid but has no effect.

### Creator bypass

`creator`-trust peers and null peers (internal/scheduled triggers) bypass all budget checks entirely. No store writes occur for them. They receive no BATS preamble.

## 4. Trust model integration

The augment uses `PeerIdentity.trustLevel` and `PeerIdentity.publicSubstate` to resolve which `BudgetCaps` apply:

| `trustLevel` | `publicSubstate` | Caps applied |
|---|---|---|
| `"creator"` | — | Bypass (no caps, no store write) |
| `"agent"` | — | `caps.agent` |
| `"public"` | `"anonymous"` | `caps.public.anonymous` |
| `"public"` | `"recognized"` | `caps.public.recognized` |
| null peer | — | Bypass (internal trigger) |

If no caps are configured for a tier, that tier is uncapped — the store still records the turn (so future caps can be applied retroactively) but no admission check fires.

## 5. 2PC dispatch flow

Every non-creator turn goes through five phases:

### Phase 1: Prepare

The kernel calls `gate.turnGate.prepare({ turnId, peer, threadId, trigger })`. The budgets augment:

1. Resolves the applicable `BudgetCaps` for this peer.
2. Opens a SQLite `BEGIN IMMEDIATE` transaction.
3. Reads current usage: thread turn count, daily turn count, daily spend, and (if applicable) anonymous request count for the last 60 seconds.
4. Evaluates all configured caps in order. First cap exceeded → decision `{ allow: false, reason }`.
5. Stages a `turn_reservations` INSERT inside the open transaction (decision `"allow"` or `"allow:deny"`). For anonymous peers, stages an `anonymous_requests` INSERT too.
6. Returns a `TurnGateTicket` that owns the open transaction.

### Phase 2: Decision evaluation (kernel)

The kernel inspects the ticket's `decision`. If `allow: false`, it rolls back the ticket and returns `status: "rejected"` with `errorClass: "cap-denied"`. No engine call.

### Phase 3: Confirm (kernel)

The kernel calls `ticket.confirm()`, which commits the SQLite transaction. The reservation row is now live. If this throws, the kernel rolls back and rejects with `errorClass: "admission-state-failed"`.

### Phase 4: Context (BATS preamble)

The kernel runs the augment context pipeline. `budgets.context()` reads current peer usage from the store (the current turn's reservation is already counted) and emits the BATS preamble block (see §8).

### Phase 5: Engine call + cost commit

After the engine returns, the kernel calls `gate.turnGate.commit({ turnId, peer, cost })`. The budgets augment:

1. If `cost.priced === true`: updates `peer_daily_costs` and `daily_global` with the USD amount. Marks the reservation row with `cost_usd` and `committed_at`.
2. If `cost.priced === false`: marks the reservation as unpriced. Turn-count caps still applied.

Errors in the commit phase are logged but do not fail the turn.

## 6. Failure modes

| Situation | What happens |
|---|---|
| Peer over turn cap | `status: "rejected"`, `errorClass: "cap-denied"`, SSE `code: "CAP_DENIED"` |
| Peer over dollar cap | Same as above |
| `anonymousGlobalLimit` exceeded | Same as above |
| `dailyBudgetUsd` exceeded | Same as above |
| SQLite I/O error in prepare | `status: "rejected"`, `errorClass: "admission-state-failed"`, SSE `code: "ADMISSION_FAILED"` |
| SQLite I/O error in confirm | Same |
| SQLite I/O error in commit | Logged, turn continues — response already returned |
| Agent auth wrong secret | HTTP 401 before entering queue |

Cap-denied rejections are expected business logic — the peer exceeded their budget. Admission-state-failed rejections are operational failures — the storage layer had a problem.

## 7. Storage

The SQLite database (at `dbPath`) contains four tables.

### `turn_reservations`

One row per turn. Primary key: `turn_id`.

| Column | Type | Description |
|---|---|---|
| `turn_id` | TEXT PK | The turn's UUID (or Idempotency-Key if provided). |
| `peer_id` | TEXT | Peer identity. |
| `thread_id` | TEXT | Thread this turn belongs to. |
| `day` | TEXT | `YYYY-MM-DD` UTC. |
| `trust_level` | TEXT | `"agent"` or `"public"`. |
| `public_substate` | TEXT | `"anonymous"`, `"recognized"`, or NULL. |
| `reserved_at` | INTEGER | Unix ms when reservation was staged. |
| `committed_at` | INTEGER | Unix ms when kernel confirmed; NULL if pending/incomplete. |
| `cost_usd` | REAL | Actual USD charged; NULL if unpriced or not yet committed. |
| `priced` | INTEGER | 1 if cost was computed; 0 if unpriced. |
| `decision` | TEXT | `"allow"`, `"allow:incomplete"` (swept), or `"allow:orphaned"`. |
| `reason` | TEXT | Reason for non-allow decisions; NULL for allows. |

Indexed on `(peer_id, day)` and `(thread_id, day)` for fast cap evaluation.

### `daily_global`

One row per calendar day.

| Column | Type | Description |
|---|---|---|
| `day` | TEXT PK | `YYYY-MM-DD` UTC. |
| `total_cost_usd` | REAL | Sum of all priced turn costs for this day. |
| `unpriced_turns` | INTEGER | Count of turns with `priced: false`. |
| `updated_at` | INTEGER | Unix ms of last update. |

### `peer_daily_costs`

One row per (peer_id, day).

| Column | Type | Description |
|---|---|---|
| `peer_id` | TEXT | |
| `day` | TEXT | `YYYY-MM-DD` UTC. |
| `cost_usd` | REAL | Sum of this peer's priced turn costs today. |
| `unpriced_turns` | INTEGER | Count of this peer's unpriced turns today. |
| `updated_at` | INTEGER | Unix ms of last update. |

### `anonymous_requests`

Rolling log for the `anonymousGlobalLimit` sliding window.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment. |
| `timestamp` | INTEGER | Unix ms of the anonymous request. |
| `source_hint` | TEXT | Optional tag (currently unused). |

Indexed on `timestamp` for fast window queries.

### Retention

The store does not automatically purge old rows. `turn_reservations` and `peer_daily_costs` / `daily_global` accumulate indefinitely. `anonymous_requests` is queried with a 60-second window filter — old rows do not affect correctness but do accumulate.

A future cleanup augment or cron job can truncate old rows. There is no built-in retention policy in v0.

## 8. BATS preamble

The BATS (Budget-Aware Turn Summary) preamble is a `ContextBlock` the budgets augment contributes to every capped peer's turn context.

**Placement:** `preamble`. **Priority:** `high`. **Origin:** `system`. **TTL:** `turn` (not cached across turns).

Example block content:

```
Turns remaining in this thread: 14 of 20
Turns remaining today: 38 of 50
Estimated spend today: $0.12 of $1.00

Behavioral guidance (budgetRatio = 0.70): Explore thoroughly. No urgency.
```

The `budgetRatio` is the minimum across all configured cap dimensions: `remaining / cap`. Four behavior buckets:

| Range | Guidance |
|---|---|
| `> 0.6` | "Explore thoroughly. No urgency." |
| `0.2 – 0.6` | "Focus on the core question. Begin wrapping up." |
| `< 0.2` | "Final response. Deliver a complete answer." |
| `= 0` | "Grace turn — summarize and close." |

The preamble is emitted after Phase 3 (confirm), so `used.thread` already counts the current turn. "Remaining" values are correct for turns left *after* this one.

The block is omitted entirely when:
- The peer is `creator` or null (bypass tier).
- No caps are configured for this peer tier.
- All configured `BudgetCaps` fields have been omitted.

## 9. Limitations

### Single-instance topology

The SQLite store uses `BEGIN IMMEDIATE` transactions and is not safe for concurrent processes sharing the same `dbPath`. Run one agent instance per database file.

### Post-hoc dollar caps

`maxUsdPerDay` is enforced based on completed turns, not the in-flight turn. The prepare phase reads yesterday's + today's settled costs, so the current turn's cost is unknown at admission time. This means a single turn can push a peer slightly over their daily dollar limit.

The one-turn overshoot is acceptable: the next request will be denied by the now-exceeded cap. Pre-call cost projection is deferred — see §10.

### No rebuild path

If the database file is deleted, historical usage is lost. There is no mechanism to reconstruct the store from external state or audit logs. Back up the database if usage history matters.

### Day boundary is UTC midnight

Calendar days roll at midnight UTC. Peers whose activity spans a UTC midnight get a fresh budget for the new day regardless of their local timezone.

## 10. Roadmap

- **Pre-call cost estimation** — estimate the turn's cost before calling the engine, enabling dollar caps to be enforced pre-turn rather than post-turn. Listed as a "Next" item in the ROADMAP; requires per-model token-budget prediction.
- **Retention / purge policy** — automatic cleanup of old `turn_reservations` and `anonymous_requests` rows.
- **Burst allowances** — carry unused budget across days or allow temporary bursts above the daily cap.

See [ROADMAP.md](../../docs/ROADMAP.md) for the authoritative list.

## Cross-references

- [03-types.md § Section 7b](./03-types.md#section-7b--turn-gate-admission-2pc) — `TurnGateProvider` and `TurnGateTicket` interfaces
- [04-kernel.md § Phase 0b](./04-kernel.md#phase-0b--turn-gate-admission-2pc) — how the kernel calls prepare/confirm/commit
- [06-transports.md § Rejection mapping](./06-transports.md#rejection-mapping--error-codes-in-sse) — SSE error codes for cap-denied and admission-state-failed
- [07-built-in-augments.md § budgets](./07-built-in-augments.md#budgets--per-trust-level-turn-budgets) — quick summary with config table

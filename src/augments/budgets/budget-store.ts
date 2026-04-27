import { Database } from "bun:sqlite";
import type { TurnGateTicket, CostResult, TrustLevel } from "../../types";
import type { BudgetCaps, BudgetStoreConfig } from "./types";

// ────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS turn_reservations (
    turn_id         TEXT PRIMARY KEY,
    peer_id         TEXT NOT NULL,
    thread_id       TEXT NOT NULL,
    day             TEXT NOT NULL,
    trust_level     TEXT NOT NULL,
    public_substate TEXT,
    reserved_at     INTEGER NOT NULL,
    committed_at    INTEGER,
    cost_usd        REAL,
    priced          INTEGER NOT NULL DEFAULT 0,
    decision        TEXT NOT NULL,
    reason          TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reservations_peer_day
     ON turn_reservations(peer_id, day)`,
  `CREATE INDEX IF NOT EXISTS idx_reservations_thread_day
     ON turn_reservations(thread_id, day)`,

  `CREATE TABLE IF NOT EXISTS daily_global (
    day            TEXT PRIMARY KEY,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    unpriced_turns INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS peer_daily_costs (
    peer_id        TEXT NOT NULL,
    day            TEXT NOT NULL,
    cost_usd       REAL NOT NULL DEFAULT 0,
    unpriced_turns INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (peer_id, day)
  )`,

  `CREATE TABLE IF NOT EXISTS anonymous_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    source_hint TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_anon_requests_ts
     ON anonymous_requests(timestamp)`,
];

// ────────────────────────────────────────────────────────────
// Public interface
// ────────────────────────────────────────────────────────────

export interface BudgetStore {
  /**
   * Stage admission writes inside an open transaction. Reads cap state,
   * decides allow/deny, INSERTs reservation row + optional anonymous request
   * row (only when allow). Returns a ticket that owns the open txn.
   *
   * Caller MUST call exactly one of confirm() or rollback() on the ticket.
   */
  prepare(input: {
    turnId: string;
    peerId: string;
    threadId: string;
    trustLevel: TrustLevel;
    publicSubstate: "anonymous" | "recognized" | null;
    caps: BudgetCaps | null;
    anonymousGlobalLimit: number | undefined;
    dailyBudgetUsd: number | undefined;
  }): Promise<TurnGateTicket>;

  /**
   * Post-response cost commit. Updates daily_global and peer_daily_costs
   * atomically. Idempotent on the reservation's committed_at IS NULL guard.
   */
  commit(turnId: string, peerId: string, cost: CostResult): Promise<void>;

  /**
   * Read-only accessor for context() preamble (Phase 1c). Returns current
   * usage so the BATS preamble can compute a budgetRatio.
   */
  getPeerUsage(peerId: string, threadId: string, day?: string): Promise<{
    thread: number;
    day: number;
    costUsd: number;
  }>;

  /**
   * Periodic cleanup. Marks reservations stuck in pending state (engine
   * errored before commit) as 'allow:incomplete'. Default window: 1 hour.
   */
  sweepIncompleteReservations(opts?: { olderThanMs?: number }): Promise<number>;

  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Format a Unix ms timestamp as YYYY-MM-DD UTC. */
function ymdUtc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────

export function createBudgetStore(config: BudgetStoreConfig): BudgetStore {
  const cleanupWindowMs = config.cleanupWindowMs ?? 60 * 60_000; // 1 hour

  const db = new Database(config.dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Schema before prepared statements (statements reference schema objects).
  for (const stmt of SCHEMA_STATEMENTS) {
    db.run(stmt);
  }

  // ── Prepared statements ──────────────────────────────────

  // Reservation reads
  const countActiveThreadStmt = db.prepare<{ n: number }, [string, string, string]>(
    `SELECT COUNT(*) AS n FROM turn_reservations
     WHERE peer_id = ? AND thread_id = ? AND day = ?
       AND decision IN ('allow', 'allow:incomplete', 'allow:orphaned')`,
  );

  const countActiveDayStmt = db.prepare<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM turn_reservations
     WHERE peer_id = ? AND day = ?
       AND decision IN ('allow', 'allow:incomplete', 'allow:orphaned')`,
  );

  const selectDailyTotalStmt = db.prepare<{ total_cost_usd: number }, [string]>(
    `SELECT total_cost_usd FROM daily_global WHERE day = ?`,
  );

  const selectPeerCostStmt = db.prepare<{ cost_usd: number }, [string, string]>(
    `SELECT cost_usd FROM peer_daily_costs WHERE peer_id = ? AND day = ?`,
  );

  const countAnonRequestsSinceStmt = db.prepare<{ n: number }, [number]>(
    `SELECT COUNT(*) AS n FROM anonymous_requests WHERE timestamp >= ?`,
  );

  // Reservation write
  const insertReservationStmt = db.prepare(
    `INSERT INTO turn_reservations
       (turn_id, peer_id, thread_id, day, trust_level, public_substate,
        reserved_at, committed_at, cost_usd, priced, decision, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Anonymous request write
  const insertAnonRequestStmt = db.prepare(
    `INSERT INTO anonymous_requests (timestamp, source_hint) VALUES (?, ?)`,
  );

  // Commit — priced path
  const updateReservationPricedStmt = db.prepare(
    `UPDATE turn_reservations
     SET committed_at = ?, cost_usd = ?, priced = 1
     WHERE turn_id = ? AND committed_at IS NULL`,
  );

  const upsertDailyGlobalPricedStmt = db.prepare(
    `INSERT INTO daily_global (day, total_cost_usd, unpriced_turns, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(day) DO UPDATE SET
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       updated_at     = excluded.updated_at`,
  );

  const upsertPeerDailyCostPricedStmt = db.prepare(
    `INSERT INTO peer_daily_costs (peer_id, day, cost_usd, unpriced_turns, updated_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(peer_id, day) DO UPDATE SET
       cost_usd   = cost_usd + excluded.cost_usd,
       updated_at = excluded.updated_at`,
  );

  // Commit — unpriced path
  const updateReservationUnpricedStmt = db.prepare(
    `UPDATE turn_reservations
     SET committed_at = ?, cost_usd = 0, priced = 0
     WHERE turn_id = ? AND committed_at IS NULL`,
  );

  const upsertDailyGlobalUnpricedStmt = db.prepare(
    `INSERT INTO daily_global (day, total_cost_usd, unpriced_turns, updated_at)
     VALUES (?, 0, 1, ?)
     ON CONFLICT(day) DO UPDATE SET
       unpriced_turns = unpriced_turns + 1,
       updated_at     = excluded.updated_at`,
  );

  const upsertPeerDailyCostUnpricedStmt = db.prepare(
    `INSERT INTO peer_daily_costs (peer_id, day, cost_usd, unpriced_turns, updated_at)
     VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(peer_id, day) DO UPDATE SET
       unpriced_turns = unpriced_turns + 1,
       updated_at     = excluded.updated_at`,
  );

  // Reservation day lookup (for Fix 4: commit books to reservation's day)
  const selectReservationDayStmt = db.prepare<{ day: string }, [string]>(
    `SELECT day FROM turn_reservations WHERE turn_id = ?`,
  );

  // Sweep
  const sweepStmt = db.prepare(
    `UPDATE turn_reservations
     SET decision = 'allow:incomplete'
     WHERE committed_at IS NULL AND reserved_at < ?
       AND decision = 'allow'`,
  );

  // ── Cap evaluation ───────────────────────────────────────

  function checkCaps(
    input: {
      turnId: string;
      peerId: string;
      threadId: string;
      trustLevel: TrustLevel;
      publicSubstate: "anonymous" | "recognized" | null;
      caps: BudgetCaps | null;
      anonymousGlobalLimit: number | undefined;
      dailyBudgetUsd: number | undefined;
    },
    dayKey: string,
    now: number,
  ): string | null {
    // 1. Anonymous global rate (rolling 60-second window)
    if (
      input.publicSubstate === "anonymous" &&
      input.anonymousGlobalLimit !== undefined
    ) {
      const row = countAnonRequestsSinceStmt.get(now - 60_000);
      const count = row?.n ?? 0;
      if (count >= input.anonymousGlobalLimit) {
        return "anonymous global rate limit exceeded";
      }
    }

    // 2. Facility-wide daily USD ceiling
    if (input.dailyBudgetUsd !== undefined) {
      const row = selectDailyTotalStmt.get(dayKey);
      const total = row?.total_cost_usd ?? 0;
      if (total >= input.dailyBudgetUsd) {
        return `dailyBudgetUsd reached ($${total.toFixed(2)})`;
      }
    }

    // 3. Per-peer caps (null = no per-tier caps)
    if (input.caps === null) return null;

    if (input.caps.maxUsdPerDay !== undefined) {
      const row = selectPeerCostStmt.get(input.peerId, dayKey);
      const peerCost = row?.cost_usd ?? 0;
      if (peerCost >= input.caps.maxUsdPerDay) {
        return `peer maxUsdPerDay reached ($${peerCost.toFixed(2)})`;
      }
    }

    if (input.caps.maxTurnsPerThread !== undefined) {
      const row = countActiveThreadStmt.get(input.peerId, input.threadId, dayKey);
      const count = row?.n ?? 0;
      if (count >= input.caps.maxTurnsPerThread) {
        return "per-thread turn cap reached";
      }
    }

    if (input.caps.maxTurnsPerDay !== undefined) {
      const row = countActiveDayStmt.get(input.peerId, dayKey);
      const count = row?.n ?? 0;
      if (count >= input.caps.maxTurnsPerDay) {
        return "daily turn cap reached";
      }
    }

    return null;
  }

  // ── Mutex for prepare ───────────────────────────────────
  // Serializes BEGIN IMMEDIATE acquisitions across concurrent kernel turns.
  // Each prepare awaits the prior one's full lifecycle (confirm or rollback)
  // before starting its own transaction. Without this, concurrency > 1 on the
  // shared Database handle hits SQLite "transaction already in progress" errors.

  let prepareChain: Promise<void> = Promise.resolve();

  // ── prepare ─────────────────────────────────────────────

  async function prepare(input: {
    turnId: string;
    peerId: string;
    threadId: string;
    trustLevel: TrustLevel;
    publicSubstate: "anonymous" | "recognized" | null;
    caps: BudgetCaps | null;
    anonymousGlobalLimit: number | undefined;
    dailyBudgetUsd: number | undefined;
  }): Promise<TurnGateTicket> {
    // Wait for any in-flight prepare/confirm/rollback to finish before starting
    // our own. The chain advances when our ticket's confirm or rollback runs.
    const priorChain = prepareChain;
    let releaseChain!: () => void;
    prepareChain = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    await priorChain;

    const now = Date.now();
    const dayKey = ymdUtc(now);

    let done = false;

    function rollbackIfActive(): void {
      if (done) return;
      done = true;
      try {
        db.run("ROLLBACK");
      } catch {
        // Swallow already-rolled-back errors (bun:sqlite throws if no
        // active transaction).
      } finally {
        releaseChain();
      }
    }

    db.run("BEGIN IMMEDIATE");

    try {
      // ── Retry path: if this turnId already has a reservation row,
      // respect the existing decision rather than failing on PK conflict.
      const existingRow = db
        .prepare<{ decision: string; reason: string | null }, [string]>(
          `SELECT decision, reason FROM turn_reservations WHERE turn_id = ?`,
        )
        .get(input.turnId);

      if (existingRow !== null) {
        // Row already committed on a prior prepare. Roll back (nothing new to commit).
        rollbackIfActive();
        const allowed = existingRow.decision === "allow" ||
          existingRow.decision === "allow:incomplete" ||
          existingRow.decision === "allow:orphaned";
        if (allowed) {
          return {
            decision: { allow: true },
            confirm: async () => { /* already committed */ },
            rollback: async () => { /* already committed */ },
          };
        }
        return {
          decision: { allow: false, reason: existingRow.reason ?? "denied" },
          confirm: async () => { /* no-op */ },
          rollback: async () => { /* no-op */ },
        };
      }

      // ── Evaluate caps inside the open transaction.
      const denyReason = checkCaps(input, dayKey, now);

      if (denyReason !== null) {
        // Deny: rollback the empty transaction (nothing was written).
        return {
          decision: { allow: false, reason: denyReason },
          confirm: async () => rollbackIfActive(), // confirm on deny = rollback
          rollback: async () => rollbackIfActive(),
        };
      }

      // ── Stage writes.
      insertReservationStmt.run(
        input.turnId,
        input.peerId,
        input.threadId,
        dayKey,
        input.trustLevel,
        input.publicSubstate ?? null,
        now,
        null, // committed_at
        null, // cost_usd
        0,    // priced
        "allow",
        null, // reason
      );

      if (
        input.publicSubstate === "anonymous" &&
        input.anonymousGlobalLimit !== undefined
      ) {
        insertAnonRequestStmt.run(now, null);
      }

      return {
        decision: { allow: true },
        confirm: async () => {
          if (done) return;
          done = true;
          try {
            db.run("COMMIT");
          } finally {
            releaseChain();
          }
        },
        rollback: async () => rollbackIfActive(),
      };
    } catch (err) {
      rollbackIfActive();
      throw err;
    }
  }

  // ── commit ───────────────────────────────────────────────

  async function commit(
    turnId: string,
    peerId: string,
    cost: CostResult,
  ): Promise<void> {
    const now = Date.now();

    const tx = db.transaction(() => {
      // Look up the reservation's stored day so cost is booked to the SAME
      // day the admission decision was made against — not the day the engine
      // call happened to finish in. A turn admitted just before UTC midnight
      // and finished just after must not leak spend across day boundaries.
      const reservationRow = selectReservationDayStmt.get(turnId);
      if (!reservationRow) return; // reservation doesn't exist (never reserved or already swept)
      const dayKey = reservationRow.day;

      if (cost.priced) {
        const result = updateReservationPricedStmt.run(now, cost.costUsd, turnId);
        if (result.changes === 0) return; // already committed — idempotent
        upsertDailyGlobalPricedStmt.run(dayKey, cost.costUsd, now);
        upsertPeerDailyCostPricedStmt.run(peerId, dayKey, cost.costUsd, now);
      } else {
        const result = updateReservationUnpricedStmt.run(now, turnId);
        if (result.changes === 0) return; // already committed — idempotent
        upsertDailyGlobalUnpricedStmt.run(dayKey, now);
        upsertPeerDailyCostUnpricedStmt.run(peerId, dayKey, now);
      }
    });

    tx();
  }

  // ── getPeerUsage ─────────────────────────────────────────

  async function getPeerUsage(
    peerId: string,
    threadId: string,
    day?: string,
  ): Promise<{ thread: number; day: number; costUsd: number }> {
    const dayKey = day ?? ymdUtc(Date.now());

    const threadRow = countActiveThreadStmt.get(peerId, threadId, dayKey);
    const dayRow = countActiveDayStmt.get(peerId, dayKey);
    const costRow = selectPeerCostStmt.get(peerId, dayKey);

    return {
      thread: threadRow?.n ?? 0,
      day: dayRow?.n ?? 0,
      costUsd: costRow?.cost_usd ?? 0,
    };
  }

  // ── sweepIncompleteReservations ──────────────────────────

  async function sweepIncompleteReservations(
    opts?: { olderThanMs?: number },
  ): Promise<number> {
    const windowMs = opts?.olderThanMs ?? cleanupWindowMs;
    const cutoff = Date.now() - windowMs;
    const result = sweepStmt.run(cutoff);
    return result.changes;
  }

  // ── close ────────────────────────────────────────────────

  async function close(): Promise<void> {
    db.close();
  }

  return {
    prepare,
    commit,
    getPeerUsage,
    sweepIncompleteReservations,
    close,
  };
}

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createBudgetStore } from "@/augments/budgets/budget-store";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { BudgetStore } from "@/augments/budgets/budget-store";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function ymdUtc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const TODAY = ymdUtc(Date.now());

function baseInput(overrides?: object) {
  return {
    turnId: "turn-1",
    peerId: "peer-1",
    threadId: "thread-1",
    trustLevel: "public" as const,
    publicSubstate: null as "anonymous" | "recognized" | null,
    caps: null,
    anonymousGlobalLimit: undefined as number | undefined,
    dailyBudgetUsd: undefined as number | undefined,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────────

describe("BudgetStore", () => {
  let store: BudgetStore;
  let cleanup: () => Promise<void>;
  let dbPath: string;

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    dbPath = join(dir.path, "budgets.db");
    store = createBudgetStore({ dbPath });
  });

  afterEach(async () => {
    await store.close();
    await cleanup();
  });

  // ── Schema ──────────────────────────────────────────────

  it("schema creation is idempotent (open store twice on same dbPath)", async () => {
    await store.close();
    // Opening again on the same file must not throw.
    const store2 = createBudgetStore({ dbPath });
    const ticket = await store2.prepare(baseInput());
    expect(ticket.decision.allow).toBe(true);
    await ticket.confirm();
    await store2.close();
    // Re-open store so afterEach.close() works cleanly.
    store = createBudgetStore({ dbPath });
  });

  // ── prepare: allow path ─────────────────────────────────

  it("prepare under cap → allow; confirm commits a visible row", async () => {
    const ticket = await store.prepare(baseInput());
    expect(ticket.decision.allow).toBe(true);
    await ticket.confirm();

    // Row must now be visible.
    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.thread).toBe(1);
    expect(usage.day).toBe(1);
  });

  it("prepare + rollback discards the staged row (no row written)", async () => {
    const ticket = await store.prepare(baseInput());
    expect(ticket.decision.allow).toBe(true);
    await ticket.rollback();

    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.thread).toBe(0);
  });

  // ── prepare: deny paths ─────────────────────────────────

  it("per-thread cap reached → deny; no row written after rollback", async () => {
    const caps = { maxTurnsPerThread: 1 };
    // Fill the cap.
    const t1 = await store.prepare(baseInput({ turnId: "t1", caps }));
    expect(t1.decision.allow).toBe(true);
    await t1.confirm();

    // Now the cap is full.
    const t2 = await store.prepare(baseInput({ turnId: "t2", caps }));
    expect(t2.decision.allow).toBe(false);
    if (!t2.decision.allow) {
      expect(t2.decision.reason).toMatch(/per-thread turn cap/);
    }
    await t2.rollback(); // should be no-op — deny never wrote anything

    // Only one row committed.
    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.thread).toBe(1);
  });

  it("deny + rollback is idempotent (double-rollback no-op)", async () => {
    const ticket = await store.prepare(baseInput({ caps: { maxTurnsPerThread: 0 } }));
    expect(ticket.decision.allow).toBe(false);
    await ticket.rollback();
    // Second rollback must not throw.
    await expect(ticket.rollback()).resolves.toBeUndefined();
  });

  it("deny + confirm is harmless (acts like rollback — no write)", async () => {
    const ticket = await store.prepare(baseInput({ caps: { maxTurnsPerThread: 0 } }));
    expect(ticket.decision.allow).toBe(false);
    // confirm() on a deny ticket must not throw and must not commit a row.
    await ticket.confirm();

    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.thread).toBe(0);
  });

  // ── Idempotency guards ──────────────────────────────────

  it("confirm idempotency: calling confirm twice does not throw", async () => {
    const ticket = await store.prepare(baseInput());
    expect(ticket.decision.allow).toBe(true);
    await ticket.confirm();
    await expect(ticket.confirm()).resolves.toBeUndefined();
  });

  it("rollback idempotency: calling rollback twice does not throw", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.rollback();
    await expect(ticket.rollback()).resolves.toBeUndefined();
  });

  it("confirm-then-rollback: rollback is no-op (done flag)", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm();
    // Row must be visible after confirm.
    expect((await store.getPeerUsage("peer-1", "thread-1")).thread).toBe(1);
    // rollback after confirm is a no-op.
    await ticket.rollback();
    // Row still visible — rollback did nothing.
    expect((await store.getPeerUsage("peer-1", "thread-1")).thread).toBe(1);
  });

  it("rollback-then-confirm: confirm is no-op", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.rollback();
    // Nothing committed yet.
    expect((await store.getPeerUsage("peer-1", "thread-1")).thread).toBe(0);
    // confirm after rollback is a no-op.
    await ticket.confirm();
    // Still no row.
    expect((await store.getPeerUsage("peer-1", "thread-1")).thread).toBe(0);
  });

  // ── Anonymous rate limit ─────────────────────────────────

  it("anonymous global rate limit blocks new anon prepares", async () => {
    const anonInput = baseInput({
      publicSubstate: "anonymous",
      anonymousGlobalLimit: 1,
    });

    // First anon prepare should be allowed.
    const t1 = await store.prepare({ ...anonInput, turnId: "t1" });
    expect(t1.decision.allow).toBe(true);
    await t1.confirm();

    // Second anon prepare in the same rolling minute should be denied.
    const t2 = await store.prepare({ ...anonInput, turnId: "t2" });
    expect(t2.decision.allow).toBe(false);
    if (!t2.decision.allow) {
      expect(t2.decision.reason).toMatch(/anonymous global rate limit/);
    }
    await t2.rollback();
  });

  it("recognized peer is unaffected by anonymous global rate limit", async () => {
    // Fill the anon rate limit with an anon peer.
    const anonInput = baseInput({
      turnId: "anon-1",
      peerId: "anon-peer",
      publicSubstate: "anonymous",
      anonymousGlobalLimit: 1,
    });
    const t1 = await store.prepare(anonInput);
    await t1.confirm();

    // Recognized peer in the same window should still be allowed.
    const recognizedInput = baseInput({
      turnId: "rec-1",
      peerId: "vis_recognized",
      publicSubstate: "recognized",
      anonymousGlobalLimit: 1,
    });
    const t2 = await store.prepare(recognizedInput);
    expect(t2.decision.allow).toBe(true);
    await t2.confirm();
  });

  // ── dailyBudgetUsd ──────────────────────────────────────

  it("dailyBudgetUsd cap hit → deny with reason mentioning $", async () => {
    // Commit a priced turn that saturates the cap.
    const t1 = await store.prepare(baseInput({ turnId: "t1", dailyBudgetUsd: 1.0 }));
    await t1.confirm();
    await store.commit("t1", "peer-1", { priced: true, costUsd: 1.0 });

    // Next prepare should be denied.
    const t2 = await store.prepare(baseInput({ turnId: "t2", dailyBudgetUsd: 1.0 }));
    expect(t2.decision.allow).toBe(false);
    if (!t2.decision.allow) {
      expect(t2.decision.reason).toMatch(/dailyBudgetUsd reached \(\$/);
    }
    await t2.rollback();
  });

  // ── Per-peer USD cap ─────────────────────────────────────

  it("per-peer maxUsdPerDay cap hit → deny", async () => {
    const caps = { maxUsdPerDay: 0.5 };

    const t1 = await store.prepare(baseInput({ turnId: "t1", caps }));
    await t1.confirm();
    await store.commit("t1", "peer-1", { priced: true, costUsd: 0.5 });

    const t2 = await store.prepare(baseInput({ turnId: "t2", caps }));
    expect(t2.decision.allow).toBe(false);
    if (!t2.decision.allow) {
      expect(t2.decision.reason).toMatch(/peer maxUsdPerDay reached/);
    }
    await t2.rollback();
  });

  it("per-peer USD cap one-turn overshoot: peer at cap after $0.30, next prepare denied", async () => {
    // Cap is $0.99. Commit $0.30, then check.
    const caps = { maxUsdPerDay: 0.99 };

    const t1 = await store.prepare(baseInput({ turnId: "t1", caps }));
    await t1.confirm();
    await store.commit("t1", "peer-1", { priced: true, costUsd: 0.3 });

    // Under cap — should allow.
    const t2 = await store.prepare(baseInput({ turnId: "t2", caps }));
    expect(t2.decision.allow).toBe(true);
    await t2.confirm();
    await store.commit("t2", "peer-1", { priced: true, costUsd: 0.69 });

    // $0.99 reached — next prepare denied.
    const t3 = await store.prepare(baseInput({ turnId: "t3", caps }));
    expect(t3.decision.allow).toBe(false);
    if (!t3.decision.allow) {
      expect(t3.decision.reason).toMatch(/peer maxUsdPerDay reached/);
    }
    await t3.rollback();
  });

  // ── Retry / PK conflict ──────────────────────────────────

  it("retry of same turnId: second prepare sees existing row and returns allow", async () => {
    const t1 = await store.prepare(baseInput({ turnId: "same-turn" }));
    await t1.confirm();

    // Second prepare with the same turnId should not blow up.
    const t2 = await store.prepare(baseInput({ turnId: "same-turn" }));
    expect(t2.decision.allow).toBe(true);
    await t2.confirm(); // no-op on already-committed row
  });

  // ── commit ───────────────────────────────────────────────

  it("commit with priced result debits both daily_global and peer_daily_costs", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm();
    const commit = await store.commit("turn-1", "peer-1", { priced: true, costUsd: 0.42 });
    expect(commit).toMatchObject({
      turnId: "turn-1",
      peerId: "peer-1",
      day: TODAY,
      priced: true,
      costUsd: 0.42,
    });

    // Verify via getPeerUsage.
    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.costUsd).toBeCloseTo(0.42, 5);

    // Verify daily_global directly.
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    const row = db2
      .prepare<{ total_cost_usd: number }, [string]>(
        "SELECT total_cost_usd FROM daily_global WHERE day = ?",
      )
      .get(TODAY);
    db2.close();
    expect(row?.total_cost_usd).toBeCloseTo(0.42, 5);
  });

  it("commit with unpriced result increments unpriced_turns in both rollups", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm();
    await store.commit("turn-1", "peer-1", { priced: false, reason: "no pricing" });

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });

    const globalRow = db2
      .prepare<{ unpriced_turns: number }, [string]>(
        "SELECT unpriced_turns FROM daily_global WHERE day = ?",
      )
      .get(TODAY);

    const peerRow = db2
      .prepare<{ unpriced_turns: number }, [string, string]>(
        "SELECT unpriced_turns FROM peer_daily_costs WHERE peer_id = ? AND day = ?",
      )
      .get("peer-1", TODAY);

    db2.close();

    expect(globalRow?.unpriced_turns).toBe(1);
    expect(peerRow?.unpriced_turns).toBe(1);
  });

  it("commit idempotency: calling commit twice is a no-op (no double-debit)", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm();

    await store.commit("turn-1", "peer-1", { priced: true, costUsd: 0.1 });
    // Second commit must not throw and must not add another $0.10.
    await store.commit("turn-1", "peer-1", { priced: true, costUsd: 0.1 });

    const usage = await store.getPeerUsage("peer-1", "thread-1");
    expect(usage.costUsd).toBeCloseTo(0.1, 5);
  });

  // ── getPeerUsage ─────────────────────────────────────────

  it("getPeerUsage returns expected thread, day, and costUsd counts", async () => {
    // Turn 1: thread-1
    const t1 = await store.prepare(baseInput({ turnId: "t1" }));
    await t1.confirm();
    await store.commit("t1", "peer-1", { priced: true, costUsd: 0.05 });

    // Turn 2: thread-1 same peer
    const t2 = await store.prepare(baseInput({ turnId: "t2" }));
    await t2.confirm();
    await store.commit("t2", "peer-1", { priced: true, costUsd: 0.1 });

    // Turn 3: thread-2 same peer (different thread)
    const t3 = await store.prepare(baseInput({ turnId: "t3", threadId: "thread-2" }));
    await t3.confirm();

    const usageThread1 = await store.getPeerUsage("peer-1", "thread-1");
    expect(usageThread1.thread).toBe(2);
    expect(usageThread1.day).toBe(3); // all three count toward peer's day
    expect(usageThread1.costUsd).toBeCloseTo(0.15, 5);

    const usageThread2 = await store.getPeerUsage("peer-1", "thread-2");
    expect(usageThread2.thread).toBe(1);
    expect(usageThread2.day).toBe(3);
  });

  it("getPeerUsage returns unpricedTurns count from peer_daily_costs", async () => {
    // Mixed priced + unpriced commits for the same peer.
    const t1 = await store.prepare(baseInput({ turnId: "tu1", peerId: "peer-mixed" }));
    await t1.confirm();
    await store.commit("tu1", "peer-mixed", { priced: true, costUsd: 0.01 });

    const t2 = await store.prepare(baseInput({ turnId: "tu2", peerId: "peer-mixed" }));
    await t2.confirm();
    await store.commit("tu2", "peer-mixed", { priced: false, reason: "service_tier=batch" });

    const usage = await store.getPeerUsage("peer-mixed", "thread-1");
    expect(usage.thread).toBe(2);
    expect(usage.day).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.01, 6);
    expect(usage.unpricedTurns).toBe(1);
  });

  it("getPeerUsage returns unpricedTurns=0 when no unpriced commits", async () => {
    const ticket = await store.prepare(
      baseInput({ turnId: "tu-priced", peerId: "peer-priced", threadId: "thread-x" }),
    );
    await ticket.confirm();
    await store.commit("tu-priced", "peer-priced", { priced: true, costUsd: 0.005 });

    const usage = await store.getPeerUsage("peer-priced", "thread-x");
    expect(usage.unpricedTurns).toBe(0);
  });

  it("getPeerUsage returns unpricedTurns=0 for a peer with no commits at all", async () => {
    const usage = await store.getPeerUsage("peer-never-seen", "thread-z");
    expect(usage.thread).toBe(0);
    expect(usage.day).toBe(0);
    expect(usage.costUsd).toBe(0);
    expect(usage.unpricedTurns).toBe(0);
  });

  // ── getDaySpend ─────────────────────────────────────────

  it("getDaySpend returns total and per-peer unpriced turn counts", async () => {
    const priced = await store.prepare(baseInput({ turnId: "day-priced", peerId: "peer-a" }));
    await priced.confirm();
    await store.commit("day-priced", "peer-a", { priced: true, costUsd: 0.25 });

    const unpricedA = await store.prepare(
      baseInput({ turnId: "day-unpriced-a", peerId: "peer-a" }),
    );
    await unpricedA.confirm();
    await store.commit("day-unpriced-a", "peer-a", { priced: false, reason: "unknown model" });

    const unpricedB = await store.prepare(
      baseInput({ turnId: "day-unpriced-b", peerId: "peer-b" }),
    );
    await unpricedB.confirm();
    await store.commit("day-unpriced-b", "peer-b", { priced: false, reason: "unknown model" });

    const spend = await store.getDaySpend();
    expect(spend.totalUsd).toBeCloseTo(0.25, 5);
    expect(spend.unpricedTurns).toBe(2);
    expect(spend.byPeer).toContainEqual({
      peerId: "peer-a",
      costUsd: 0.25,
      unpricedTurns: 1,
    });
    expect(spend.byPeer).toContainEqual({
      peerId: "peer-b",
      costUsd: 0,
      unpricedTurns: 1,
    });
  });

  // ── sweepIncompleteReservations ──────────────────────────

  it("sweepIncompleteReservations marks stale pending rows as allow:incomplete", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm(); // committed = row with decision='allow', committed_at=NULL

    // The row is committed (has committed_at set by confirm). We need
    // an actually-pending row: confirm without committing it to the DB.
    // Create a second store instance pointing at the same file to backdoor
    // a raw row.
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    // Insert a stale pending row directly (committed_at NULL, old reserved_at).
    db2.run(
      `INSERT INTO turn_reservations
         (turn_id, peer_id, thread_id, day, trust_level, public_substate,
          reserved_at, committed_at, cost_usd, priced, decision, reason)
       VALUES ('stale-1', 'peer-2', 'thread-2', ?, 'public', NULL, ?, NULL, NULL, 0, 'allow', NULL)`,
      [TODAY, Date.now() - 7_200_000], // 2 hours ago
    );
    db2.close();

    // Sweep with 1-hour window — the 2-hour-old row should be swept.
    const swept = await store.sweepIncompleteReservations({ olderThanMs: 3_600_000 });
    expect(swept).toBe(1);

    // Verify it's now 'allow:incomplete'.
    const db3 = new Database(dbPath, { readwrite: true });
    const row = db3
      .prepare<{ decision: string }, [string]>(
        "SELECT decision FROM turn_reservations WHERE turn_id = ?",
      )
      .get("stale-1");
    db3.close();
    expect(row?.decision).toBe("allow:incomplete");
  });

  it("sweepIncompleteReservations leaves recently-committed rows alone", async () => {
    const ticket = await store.prepare(baseInput());
    await ticket.confirm();

    // Commit the reservation so it has committed_at set.
    await store.commit("turn-1", "peer-1", { priced: false, reason: "no price" });

    // Sweep with a large window — nothing is stale enough.
    const swept = await store.sweepIncompleteReservations({ olderThanMs: 60_000 });
    expect(swept).toBe(0);
  });

  // ── purgeOldRows / retention ────────────────────────────

  it("purgeOldRows is default-off but deletes old rows when retentionDays is supplied", async () => {
    const oldMs = Date.now() - 60 * 86_400_000;
    const oldDay = ymdUtc(oldMs);
    const retainedMs = Date.now() - 5 * 86_400_000;
    const retainedDay = ymdUtc(retainedMs);

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    db2.run(
      `INSERT INTO turn_reservations
       (turn_id, peer_id, thread_id, day, trust_level, public_substate,
        reserved_at, committed_at, cost_usd, priced, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "old-turn",
        "old-peer",
        "old-thread",
        oldDay,
        "public",
        null,
        oldMs,
        oldMs,
        0.1,
        1,
        "allow",
        null,
      ],
    );
    db2.run(
      `INSERT INTO turn_reservations
         (turn_id, peer_id, thread_id, day, trust_level, public_substate,
          reserved_at, committed_at, cost_usd, priced, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "retained-turn",
        "retained-peer",
        "retained-thread",
        retainedDay,
        "public",
        null,
        retainedMs,
        retainedMs,
        0.2,
        1,
        "allow",
        null,
      ],
    );
    db2.run(
      `INSERT INTO daily_global (day, total_cost_usd, unpriced_turns, updated_at)
       VALUES (?, ?, 0, ?)`,
      [oldDay, 0.1, oldMs],
    );
    db2.run(
      `INSERT INTO daily_global (day, total_cost_usd, unpriced_turns, updated_at)
       VALUES (?, ?, 0, ?)`,
      [retainedDay, 0.2, retainedMs],
    );
    db2.run(
      `INSERT INTO peer_daily_costs (peer_id, day, cost_usd, unpriced_turns, updated_at)
       VALUES (?, ?, ?, 0, ?)`,
      ["old-peer", oldDay, 0.1, oldMs],
    );
    db2.run(
      `INSERT INTO peer_daily_costs (peer_id, day, cost_usd, unpriced_turns, updated_at)
       VALUES (?, ?, ?, 0, ?)`,
      ["retained-peer", retainedDay, 0.2, retainedMs],
    );
    db2.run("INSERT INTO anonymous_requests (timestamp, source_hint) VALUES (?, ?)", [
      oldMs,
      "old",
    ]);
    db2.run("INSERT INTO anonymous_requests (timestamp, source_hint) VALUES (?, ?)", [
      retainedMs,
      "retained",
    ]);
    db2.close();

    expect(await store.purgeOldRows()).toEqual({
      turnReservations: 0,
      dailyGlobal: 0,
      peerDailyCosts: 0,
      anonymousRequests: 0,
      total: 0,
    });

    const purged = await store.purgeOldRows({ retentionDays: 30 });
    expect(purged).toEqual({
      turnReservations: 1,
      dailyGlobal: 1,
      peerDailyCosts: 1,
      anonymousRequests: 1,
      total: 4,
    });

    const db3 = new Database(dbPath, { readwrite: true });
    const count = (table: string) =>
      db3.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    expect(count("turn_reservations")).toBe(1);
    expect(count("daily_global")).toBe(1);
    expect(count("peer_daily_costs")).toBe(1);
    expect(count("anonymous_requests")).toBe(1);
    db3.close();
  });

  // ── daily turn cap ───────────────────────────────────────

  it("daily turn cap reached → deny", async () => {
    const caps = { maxTurnsPerDay: 2 };

    const t1 = await store.prepare(baseInput({ turnId: "t1", caps }));
    await t1.confirm();
    const t2 = await store.prepare(baseInput({ turnId: "t2", caps }));
    await t2.confirm();

    const t3 = await store.prepare(baseInput({ turnId: "t3", caps }));
    expect(t3.decision.allow).toBe(false);
    if (!t3.decision.allow) {
      expect(t3.decision.reason).toMatch(/daily turn cap/);
    }
    await t3.rollback();
  });

  // ── Fix 2: concurrent prepares serialize via mutex ───────

  it("Fix 2: concurrent prepares serialize — no SQLite transaction collision", async () => {
    // Fire 3 prepare() calls simultaneously to verify the JS-level mutex
    // prevents "transaction already in progress" errors on the shared handle.
    // The mutex serializes BEGIN IMMEDIATE acquisitions, so each prepare runs
    // in sequence. We interleave confirm/rollback inside the Promise chain
    // so that the mutex's releaseChain fires in time for each subsequent prepare.
    const caps = { maxTurnsPerDay: 2 };

    // Launch all three concurrently. Each chains off the prior one's mutex.
    // After each ticket resolves, we immediately confirm (or rollback for deny)
    // to unblock the next prepare in the chain.
    const results: Array<{ allow: boolean; reason?: string }> = [];
    const errors: unknown[] = [];

    async function run(turnId: string): Promise<void> {
      try {
        const ticket = await store.prepare(baseInput({ turnId, caps }));
        results.push({
          allow: ticket.decision.allow,
          reason: (ticket.decision as { allow: false; reason: string }).reason,
        });
        if (ticket.decision.allow) {
          await ticket.confirm();
        } else {
          await ticket.rollback();
        }
      } catch (err) {
        errors.push(err);
      }
    }

    // Fire all three simultaneously — the mutex chains them.
    await Promise.all([run("c1"), run("c2"), run("c3")]);

    // Must have no errors (no SQLite transaction collisions).
    expect(errors).toHaveLength(0);

    // Exactly 2 allows (cap = 2), 1 deny.
    const allows = results.filter((r) => r.allow === true).length;
    const denies = results.filter((r) => r.allow === false).length;
    expect(allows).toBe(2);
    expect(denies).toBe(1);

    // The denial reason must match the cap message.
    const denied = results.find((r) => !r.allow);
    expect(denied?.reason).toMatch(/daily turn cap/);
  });

  // ── Fix 4: commit books to reservation's day, not completion day ──

  it("Fix 4: commit books cost to the reservation's day, not the current day", async () => {
    // Manually INSERT a reservation row with a past day to simulate a turn that
    // was admitted on a different UTC day than the one commit() runs on.
    const pastDay = "2026-04-26";
    const todayDay = ymdUtc(Date.now());

    // Ensure the days are different (otherwise the test doesn't prove anything).
    // If they're the same (i.e., today IS 2026-04-26), use a clearly different past day.
    const reservationDay = todayDay === pastDay ? "2026-04-25" : pastDay;

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    db2.run(
      `INSERT INTO turn_reservations
         (turn_id, peer_id, thread_id, day, trust_level, public_substate,
          reserved_at, committed_at, cost_usd, priced, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "cross-day-turn",
        "peer-x",
        "thread-x",
        reservationDay,
        "public",
        null,
        Date.now() - 86400_000,
        null,
        null,
        0,
        "allow",
        null,
      ],
    );
    db2.close();

    // Commit today (different day from reservation).
    await store.commit("cross-day-turn", "peer-x", { priced: true, costUsd: 0.5 });

    // The cost MUST appear in the reservation's day, not today's day.
    const db3 = new Database(dbPath, { readwrite: true });
    const pastRow = db3
      .prepare<{ total_cost_usd: number }, [string]>(
        "SELECT total_cost_usd FROM daily_global WHERE day = ?",
      )
      .get(reservationDay);
    const todayRow = db3
      .prepare<{ total_cost_usd: number }, [string]>(
        "SELECT total_cost_usd FROM daily_global WHERE day = ?",
      )
      .get(todayDay);
    db3.close();

    // The reservation's day gets $0.50.
    expect(pastRow?.total_cost_usd).toBeCloseTo(0.5, 5);
    // Today's global total must NOT have the $0.50 from this turn.
    // (It may have other values from other tests if dbPath is shared, but
    // since each test gets a fresh temp dir, todayRow should be null or 0.)
    expect(todayRow?.total_cost_usd ?? 0).toBeCloseTo(0, 5);
  });

  it("Fix 4: commit with no matching reservation is a silent no-op", async () => {
    // Calling commit() for a turn_id that was never reserved must not throw.
    await expect(
      store.commit("nonexistent-turn", "peer-1", { priced: true, costUsd: 1.0 }),
    ).resolves.toBeUndefined();
  });
});

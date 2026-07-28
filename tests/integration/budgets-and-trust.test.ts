import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { defineAgent, webTransport } from "@/index";
import { budgets } from "@/augments/budgets";
import type { PeerIdentity, TurnTrigger } from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTrigger(opts: {
  turnId?: string;
  threadId?: string;
  peer: PeerIdentity | null;
}): TurnTrigger {
  const turnId = opts.turnId ?? crypto.randomUUID();
  const threadId = opts.threadId ?? crypto.randomUUID();
  return {
    type: "message",
    turnId,
    threadId,
    timestamp: Date.now(),
    source: "test",
    peer: opts.peer,
    payload: {
      parts: [{ kind: "text", text: "hello" }],
      sourceAugment: "test",
      peer: opts.peer,
      timestamp: Date.now(),
    },
  };
}

function recognizedPeer(id: string): PeerIdentity {
  return {
    id,
    kind: "human",
    trustLevel: "public",
    publicSubstate: "recognized",
    sourceAugment: "test",
  };
}

function anonymousPeer(threadId: string): PeerIdentity {
  return {
    id: `anon-${threadId}`,
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "test",
  };
}

function creatorPeer(): PeerIdentity {
  return {
    id: "creator",
    kind: "human",
    trustLevel: "creator",
    sourceAugment: "test",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────────

describe("budgets + trust integration", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // ── Test 1: Recognized peer hits per-thread cap ────────────────────────────

  it("Test 1: recognized peer is denied on the 3rd request when maxTurnsPerThread: 2", async () => {
    const dbPath = join(tmp.path, "t1.db");
    const model = createMockModel({ response: "ok" });
    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: { public: { recognized: { maxTurnsPerThread: 2 } } },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = recognizedPeer("vis-test1");
      const threadId = "thread-t1";

      // Turns 1 and 2 should succeed
      for (let i = 1; i <= 2; i++) {
        const result = await agent.inject(makeTrigger({ peer, threadId }));
        expect(result.success).toBe(true);
        expect(result.status).toBe("completed");
      }

      // Turn 3 should be denied at the kernel level
      const denied = await agent.inject(makeTrigger({ peer, threadId }));
      expect(denied.success).toBe(false);
      expect(denied.status).toBe("rejected");
      expect(denied.errorClass).toBe("cap-denied");
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 2: Anonymous global ceiling ──────────────────────────────────────

  it("Test 2: 4th anonymous request denied with anonymous global rate limit reason", async () => {
    const dbPath = join(tmp.path, "t2.db");
    const model = createMockModel({ response: "ok" });
    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            anonymousGlobalLimit: 3,
            caps: {
              public: {
                // high thread cap so the global limit is what kicks in
                anonymous: { maxTurnsPerThread: 100 },
              },
            },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const threadId = "thread-t2";
      const peer = anonymousPeer(threadId);

      // Turns 1-3 succeed
      for (let i = 1; i <= 3; i++) {
        const result = await agent.inject(makeTrigger({ peer, threadId }));
        expect(result.success).toBe(true);
        expect(result.status).toBe("completed");
      }

      // Turn 4 denied by global anonymous rate limit
      const denied = await agent.inject(makeTrigger({ peer, threadId }));
      expect(denied.success).toBe(false);
      expect(denied.status).toBe("rejected");
      expect(denied.errorClass).toBe("cap-denied");
      expect(denied.error?.message).toMatch(/anonymous global rate limit/);
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 3: Creator bypasses caps ─────────────────────────────────────────

  it("Test 3: creator bypasses all caps; no reservation rows written", async () => {
    const dbPath = join(tmp.path, "t3.db");
    const model = createMockModel({ response: "ok" });
    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: {
              public: {
                // deliberately tight caps; creator must ignore them
                recognized: { maxTurnsPerThread: 1 },
                anonymous: { maxTurnsPerThread: 1 },
              },
            },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = creatorPeer();
      const threadId = "thread-t3";

      // 10 turns — all must succeed despite tight public caps
      for (let i = 0; i < 10; i++) {
        const result = await agent.inject(makeTrigger({ peer, threadId }));
        expect(result.success).toBe(true);
        expect(result.status).toBe("completed");
      }

      // Verify: creator bypass path writes NO reservation rows to SQLite
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM turn_reservations")
        .get();
      db.close();

      expect(row?.n ?? 0).toBe(0);
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 4: Idempotency-Key retry deduplication ───────────────────────────

  it("Test 4: Idempotency-Key retries don't consume extra turn slots", async () => {
    const dbPath = join(tmp.path, "t4.db");
    const model = createMockModel({ response: "ok" });
    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: { public: { recognized: { maxTurnsPerThread: 2 } } },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = recognizedPeer("vis-test4");
      const threadId = "thread-t4";

      // First request with idempotency key "my-key-123" → success (consumes slot 1)
      const r1 = await agent.inject(makeTrigger({ turnId: "my-key-123", peer, threadId }));
      expect(r1.success).toBe(true);
      expect(r1.status).toBe("completed");

      // Direct kernel injection has no response-replay coordinator. Reusing a
      // turn ID therefore fails closed instead of executing again against the
      // original allowance.
      const r2 = await agent.inject(makeTrigger({ turnId: "my-key-123", peer, threadId }));
      expect(r2.success).toBe(false);
      expect(r2.status).toBe("rejected");
      expect(r2.errorClass).toBe("cap-denied");
      expect(model.calls).toHaveLength(1);

      // Third request with a DIFFERENT key → success (consumes slot 2)
      const r3 = await agent.inject(makeTrigger({ turnId: "my-key-456", peer, threadId }));
      expect(r3.success).toBe(true);
      expect(r3.status).toBe("completed");

      // Fourth request with another fresh key → denied (cap of 2 is reached)
      const r4 = await agent.inject(makeTrigger({ turnId: "my-key-789", peer, threadId }));
      expect(r4.success).toBe(false);
      expect(r4.status).toBe("rejected");
      expect(r4.errorClass).toBe("cap-denied");

      // Prove deduplication was effective: exactly 2 reservation rows exist
      // (my-key-123 once, my-key-456 once — the duplicate was not re-inserted).
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM turn_reservations")
        .get();
      db.close();
      expect(row?.n ?? 0).toBe(2);
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 5: Cost commit happens on success ────────────────────────────────

  it("Test 5: cost commit updates peer_daily_costs after a successful priced turn", async () => {
    const dbPath = join(tmp.path, "t5.db");
    const model = createMockModel();
    const knownCostUsd = 0.0045;

    // Override the default unpriced response with a known priced response
    model.pushResponse({
      content: "Priced response",
      costUsd: knownCostUsd,
      inputTokens: 1000,
      outputTokens: 100,
      finishReason: "end_turn",
    });

    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: { public: { recognized: { maxUsdPerDay: 1.0 } } },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = recognizedPeer("vis-test5");
      const threadId = "thread-t5";

      const result = await agent.inject(makeTrigger({ peer, threadId }));
      expect(result.success).toBe(true);

      // The kernel awaits runCostCommit() before returning TurnResult, so by
      // the time we reach here the commit is complete.
      const db = new Database(dbPath, { readonly: true });
      const today = new Date().toISOString().slice(0, 10);
      const costRow = db
        .prepare<{ cost_usd: number }, [string, string]>(
          "SELECT cost_usd FROM peer_daily_costs WHERE peer_id = ? AND day = ?",
        )
        .get(peer.id, today);
      db.close();

      expect(costRow).not.toBeNull();
      expect(costRow!.cost_usd).toBeCloseTo(knownCostUsd, 6);
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 6: Budget preamble block injected into context ──────────────────

  it("Test 6: recognized peer with caps gets a budget preamble block in the model's contextBlocks", async () => {
    const dbPath = join(tmp.path, "t6.db");
    const model = createMockModel({ response: "ok" });
    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: { public: { recognized: { maxTurnsPerThread: 10, maxTurnsPerDay: 50 } } },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = recognizedPeer("vis-test6");
      const threadId = "thread-t6";

      const result = await agent.inject(makeTrigger({ peer, threadId }));
      expect(result.success).toBe(true);

      // The model must have been called and the assembled prompt must contain
      // the BATS budget block in its contextBlocks (placement: "preamble").
      expect(model.calls.length).toBeGreaterThan(0);
      const prompt = model.calls[0]!;
      const contextText = prompt.contextBlocks.join("\n");

      // After 1 turn with maxTurnsPerThread: 10, used.thread = 1, remaining = 9
      expect(contextText).toContain("Turns remaining in this thread: 9 of 10");
      // After 1 turn with maxTurnsPerDay: 50, used.day = 1, remaining = 49
      expect(contextText).toContain("Turns remaining today: 49 of 50");
      // Guidance: ratio = min(9/10, 49/50) = 0.9 → "Explore thoroughly. No urgency."
      expect(contextText).toContain("Explore thoroughly. No urgency.");
      // Per ADR-030, the augment-name source label is NO LONGER in the model-bound
      // wire (was previously `[AUGMENT CONTEXT: budgets]`). Block content above is
      // the authoritative signal that the budgets augment reached the model.
      expect(contextText).not.toContain("[AUGMENT CONTEXT:");
    } finally {
      await agent.stop();
    }
  }, 30000);

  // ── Test 7: Unpriced cost commit is honest ────────────────────────────────

  it("Test 7: unpriced turn increments unpriced_turns, cost_usd stays 0", async () => {
    const dbPath = join(tmp.path, "t7.db");
    // Default createMockModel returns costUsd: undefined → priced: false path in kernel
    const model = createMockModel({ response: "Unpriced response" });

    const port = 0;

    const agent = defineAgent(
      {
        name: "test-agent",
        purpose: "test",
        model: "mock",
        augments: [
          budgets({
            dbPath,
            caps: { public: { recognized: { maxUsdPerDay: 1.0 } } },
          }),
          webTransport({
            port,
            auth: { type: "bearer", token: "test-token" },
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const peer = recognizedPeer("vis-test7");
      const threadId = "thread-t7";

      const result = await agent.inject(makeTrigger({ peer, threadId }));
      expect(result.success).toBe(true);

      const db = new Database(dbPath, { readonly: true });
      const today = new Date().toISOString().slice(0, 10);
      const costRow = db
        .prepare<{ cost_usd: number; unpriced_turns: number }, [string, string]>(
          "SELECT cost_usd, unpriced_turns FROM peer_daily_costs WHERE peer_id = ? AND day = ?",
        )
        .get(peer.id, today);
      db.close();

      expect(costRow).not.toBeNull();
      // cost_usd must be exactly 0 (unpriced — no USD debited)
      expect(costRow!.cost_usd).toBe(0);
      // unpriced_turns must be 1
      expect(costRow!.unpriced_turns).toBe(1);
    } finally {
      await agent.stop();
    }
  }, 30000);
});

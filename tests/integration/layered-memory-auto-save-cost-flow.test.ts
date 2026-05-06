/**
 * PR β option-(a) end-to-end cost-flow integration test.
 *
 * This is THE test that proves Codex Critical-2 is closed. The Phase 2b
 * shortcut (option b) ran extraction inline inside scheduleAfterTurn,
 * bypassing turnGate.commit. The Phase 2c upgrade (option a, this PR)
 * routes extraction through ctx.inject + Augment.handleInternalTurn so
 * the extraction LLM call's cost flows through runCostCommit ->
 * turnGate.commit identically to a user-facing turn.
 *
 * The mock budgets gate here records every commit it observes; the
 * assertion is that one of those commits is the extraction turn AND
 * carries the priced cost the mock extraction engine reported.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { layeredMemory } from "@/augments/layered-memory";
import type {
  Augment,
  CostResult,
  InboundMessage,
  PeerIdentity,
  TurnGateProvider,
  TurnTrigger,
} from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

interface RecordedCommit {
  turnId: string;
  peerId: string | null;
  cost: CostResult;
}

/**
 * Stand-in for the budgets augment that records every turnGate.commit
 * invocation. Allows the test to assert the extraction turn fired commit
 * with the priced cost the mock extraction engine reported.
 */
function recordingBudgetGate(commits: RecordedCommit[]): Augment {
  const turnGate: TurnGateProvider = {
    async prepare() {
      return {
        decision: { allow: true },
        confirm: async () => {},
        rollback: async () => {},
      };
    },
    async commit({ turnId, peer, cost }) {
      commits.push({ turnId, peerId: peer?.id ?? null, cost });
    },
  };
  return {
    name: "recording-budget-gate",
    capabilities: ["lifecycle"],
    turnGate,
  };
}

function makeMessageTrigger(turnId: string, threadId: string, peer: PeerIdentity): TurnTrigger {
  return {
    type: "message",
    turnId,
    threadId,
    timestamp: Date.now(),
    source: "test-transport",
    peer,
    payload: {
      parts: [{ kind: "text", text: "Hi, my name is Sam." }],
      sourceAugment: "test-transport",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

describe("layered-memory auto-save cost-flow (option a)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  test("extraction turn cost flows through turnGate.commit", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Mock extraction engine that returns a single fact with a known
    // priced cost. The dispatch wiring must make this cost surface in
    // the budget-gate's commit record.
    const EXTRACTION_COST_USD = 0.0073;
    const mockExtractionEngine = {
      complete: async (_prompt: string) => ({
        text: '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true}]',
        costUsd: EXTRACTION_COST_USD,
      }),
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        // Force agent peer to extract every turn (default for agent is
        // every-N-turns; we want every-turn here so the test runs
        // extraction on the first turn).
        extractionFrequency: { agent: "every-turn" },
        engine: mockExtractionEngine,
      },
    });

    const commits: RecordedCommit[] = [];
    const budgetGate = recordingBudgetGate(commits);

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        // Order matters: budgetGate first so it observes the turn-gate
        // 2PC, layered-memory second so its scheduleAfterTurn fires.
        augments: [budgetGate, lm],
      },
      createMockModel({ response: "Hi Sam!" }),
    );

    await agent.start();
    try {
      const userPeer: PeerIdentity = {
        id: "agent-peer-1",
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "test-transport",
      };
      // Run a user-facing turn. layered-memory's scheduleAfterTurn
      // should fire after onTurnEnd, decide to extract, and ctx.inject
      // an internal trigger. The kernel routes that trigger to layered-
      // memory's handleInternalTurn, which runs the extraction LLM call.
      const result = await agent.inject(
        makeMessageTrigger("user-turn-1", "th-cost-flow", userPeer),
      );
      expect(result.success).toBe(true);
    } finally {
      await agent.stop();
    }

    // Two commits expected: one for the user-facing turn, one for the
    // extraction turn. The extraction commit MUST carry the priced cost
    // the engine reported — that's the Critical-2 assertion.
    expect(commits.length).toBe(2);
    const extractionCommit = commits.find((c) => c.turnId !== "user-turn-1");
    expect(extractionCommit).toBeDefined();
    expect(extractionCommit?.peerId).toBe("agent-peer-1");
    expect(extractionCommit?.cost).toEqual({
      priced: true,
      costUsd: EXTRACTION_COST_USD,
    });
  });

  test("extraction failure still commits engine cost (parse failure path)", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Engine reports a cost (it billed for the turn) but emits malformed
    // JSON the parser can't handle. Cost MUST still flow through commit
    // — the model billed for the spend; suppressing it in budgets would
    // silently break daily-cap accounting.
    const FAILED_COST_USD = 0.0021;
    const mockExtractionEngine = {
      complete: async () => ({
        text: "not-valid-json",
        costUsd: FAILED_COST_USD,
      }),
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        extractionFrequency: { agent: "every-turn" },
        engine: mockExtractionEngine,
      },
    });
    const commits: RecordedCommit[] = [];
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [recordingBudgetGate(commits), lm],
      },
      createMockModel({ response: "ack" }),
    );
    await agent.start();
    try {
      const peer: PeerIdentity = {
        id: "agent-peer-fail",
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "test-transport",
      };
      await agent.inject(makeMessageTrigger("user-turn-fail", "th-fail", peer));
    } finally {
      await agent.stop();
    }

    expect(commits.length).toBe(2);
    const extractionCommit = commits.find((c) => c.turnId !== "user-turn-fail");
    expect(extractionCommit).toBeDefined();
    // Even though extraction failed (parse error), the engine billed us;
    // commit MUST surface the cost.
    expect(extractionCommit?.cost).toEqual({
      priced: true,
      costUsd: FAILED_COST_USD,
    });
  });

  test("extraction is skipped (no extra commit) when frequency dispatcher returns skip", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");
    const mockExtractionEngine = {
      complete: async () => ({
        text: "[]",
        costUsd: 0.001,
      }),
    };
    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        // never → skip every turn
        extractionFrequency: { agent: "never" },
        engine: mockExtractionEngine,
      },
    });
    const commits: RecordedCommit[] = [];
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [recordingBudgetGate(commits), lm],
      },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    try {
      const peer: PeerIdentity = {
        id: "agent-peer-skip",
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "test-transport",
      };
      await agent.inject(makeMessageTrigger("u1", "th-skip", peer));
    } finally {
      await agent.stop();
    }
    // Only the user-facing turn committed; no extraction occurred.
    expect(commits.length).toBe(1);
    expect(commits[0]?.turnId).toBe("u1");
  });

  test("layered-memory's handleInternalTurn never throws on engine failure (ADR-027 D5 throw-contract regression guard)", async () => {
    // ADR-027 Decision 5: handlers MUST NOT throw with side effects.
    // If they do, the kernel's catch-block commits a turn with no cost
    // recorded — budgets undercounts. Layered-memory's handler must
    // catch every engine failure mode internally and return a failed
    // TurnResult with priced inference steps. This test locks that
    // contract for the layered-memory implementation specifically;
    // future custom handlers must satisfy the same contract per the
    // JSDoc on `Augment.handleInternalTurn`.
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Engine throws synchronously — simulates network failure, rate
    // limit, transient backend error.
    const throwingEngine = {
      complete: async () => {
        throw new Error("simulated engine failure");
      },
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        extractionFrequency: { agent: "every-turn" },
        engine: throwingEngine,
      },
    });
    const commits: RecordedCommit[] = [];
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [recordingBudgetGate(commits), lm],
      },
      createMockModel({ response: "ack" }),
    );

    // Spy on console.warn to detect the kernel's "handler threw" warning
    // — if this fires, the handler regressed and is now throwing.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    try {
      await agent.start();
      try {
        const peer: PeerIdentity = {
          id: "agent-peer-throw",
          kind: "agent",
          trustLevel: "agent",
          sourceAugment: "test-transport",
        };
        // The user-facing turn must succeed; auto-save's failure must
        // not propagate.
        await agent.inject(makeMessageTrigger("user-turn-throw", "th-throw", peer));
      } finally {
        await agent.stop();
      }
    } finally {
      console.warn = originalWarn;
    }

    // The kernel-level "handler threw" warning must NOT have fired —
    // proves the handler caught the engine failure internally.
    const handlerThrewWarning = warnings.find(
      (w) => w.includes("handleInternalTurn") && w.includes("threw"),
    );
    expect(handlerThrewWarning).toBeUndefined();

    // Both turns committed (user-facing + extraction); the extraction
    // commit fired even though extraction failed.
    expect(commits.length).toBe(2);
    expect(commits.find((c) => c.turnId === "user-turn-throw")).toBeDefined();
    const extractionCommit = commits.find((c) => c.turnId !== "user-turn-throw");
    expect(extractionCommit).toBeDefined();
  });
});

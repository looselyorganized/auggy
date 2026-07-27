import { describe, expect, test } from "bun:test";
import { budgets } from "@/augments/budgets";
import { coordinatorBudgetPolicyForTurnGate } from "@/kernel/turn-gate-authority";
import type { DistributedBudgetPolicyV1, PeerIdentity, TurnState, TurnTrigger } from "@/types";

const policy: DistributedBudgetPolicyV1 = {
  id: "support",
  caps: {
    public: {
      recognized: { maxTurnsPerThread: 5, maxTurnsPerDay: 10, maxUsdPerDay: 2 },
    },
  },
  dailyBudgetUsd: 10,
  maxReservations: 10_100,
  reservationRetentionMs: 604_800_000,
  maxAnonymousEvents: 100,
  maxPeerDays: 100,
  maxThresholdIntents: 0,
  aggregateRetentionDays: 7,
};

function turn(metadata: Record<string, unknown>): TurnState {
  const peer: PeerIdentity = {
    id: "visitor:one",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "recognized",
    sourceAugment: "web",
  };
  const trigger: TurnTrigger = {
    type: "message",
    turnId: "turn-one",
    timestamp: Date.now(),
    peer,
    payload: { parts: [], sourceAugment: "web", peer, timestamp: Date.now() },
  };
  return {
    turnId: trigger.turnId,
    threadId: "thread-one",
    trigger,
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata,
  };
}

describe("coordinator-backed budgets augment", () => {
  test("exposes immutable policy and renders only coordinator-minted usage", async () => {
    const augment = budgets({ backend: "coordinator", policy });
    expect(coordinatorBudgetPolicyForTurnGate(augment.turnGate!)).toEqual(policy);
    await expect(augment.turnGate!.prepare({} as never)).rejects.toThrow(
      "require distributed turn authority",
    );
    await expect(augment.turnGate!.commit!({} as never)).rejects.toThrow(
      "require atomic distributed cost settlement",
    );

    const blocks = await augment.context!(
      turn({
        "auggy.distributedBudget.support": {
          admissionDay: "2026-07-27",
          threadTurns: 2,
          peerTurns: 4,
          peerCostUsd: 0.5,
          peerUnpricedTurns: 0,
          globalCostUsd: 1,
          globalUnpricedTurns: 0,
        },
      }),
    );
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (!block || typeof block === "string") throw new Error("expected budget context block");
    expect(block.content).toContain("Turns remaining in this thread: 3 of 5");
    expect(block.content).toContain("Turns remaining today: 6 of 10");
    expect(block.content).toContain("Estimated spend today: $0.50 of $2.00");
  });

  test("fails closed when coordinator usage is absent or malformed", async () => {
    const augment = budgets({ backend: "coordinator", policy });
    await expect(augment.context!(turn({}))).rejects.toThrow(
      "distributed budget usage is unavailable",
    );
    await expect(
      augment.context!(
        turn({
          "auggy.distributedBudget.support": {
            admissionDay: "2026-07-27",
            threadTurns: Number.NaN,
          },
        }),
      ),
    ).rejects.toThrow("distributed budget usage is unavailable");
  });

  test("requires an explicit immutable policy", () => {
    expect(() => budgets({ backend: "coordinator" })).toThrow(
      "coordinator budgets require an immutable policy",
    );
  });
});

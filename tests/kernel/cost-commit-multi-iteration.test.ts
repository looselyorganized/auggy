import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import type { Augment, TurnTrigger, PeerIdentity, InboundMessage, CostResult } from "@/types";

function makeTrigger(text: string): TurnTrigger {
  const peer: PeerIdentity = {
    id: "p1",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "test",
  };
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: Date.now(),
    source: "test",
    peer,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function identityAugment(): Augment {
  return {
    name: "identity",
    required: true,
    capabilities: ["context"],
    context: async () => [
      {
        source: "identity",
        content: "You are a test agent.",
        placement: "system",
        provenance: "identity",
        priority: "required",
        eviction: "never",
        origin: "operator",
      },
    ],
  };
}

function captureGate(): {
  augment: Augment;
  committedCosts: CostResult[];
} {
  const committedCosts: CostResult[] = [];
  return {
    committedCosts,
    augment: {
      name: "capture-gate",
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async ({ cost }) => {
          committedCosts.push(cost);
        },
      },
    },
  };
}

describe("runCostCommit — multi-iteration sum", () => {
  it("commits sum of priced costs across all inference steps", async () => {
    const model = createMockModel();
    // Iteration 1: tool call
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: 0.001,
    });
    // Iteration 2: tool call
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "y" } }],
      finishReason: "tool_use",
      costUsd: 0.002,
    });
    // Iteration 3: end turn
    model.pushResponse({
      content: "done",
      finishReason: "end_turn",
      costUsd: 0.003,
    });

    const echoAug: Augment = {
      name: "echo-aug",
      capabilities: ["tools"],
      tools: [
        {
          name: "echo",
          description: "echoes input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();

    const loop = createTurnLoop({
      augments: [identityAugment(), echoAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(result.status).toBe("completed");
    expect(model.calls).toHaveLength(3);
    expect(gate.committedCosts).toHaveLength(1); // commit fires once at end
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(true);
    if (!cost.priced) throw new Error("expected priced");
    // 0.001 + 0.002 + 0.003 = 0.006
    expect(cost.costUsd).toBeCloseTo(0.006, 9);
  });

  it("marks the whole turn unpriced if any inference step is unpriced", async () => {
    const model = createMockModel();
    // Iteration 1: priced
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: 0.005,
    });
    // Iteration 2: UNPRICED (e.g. service_tier discriminator)
    model.pushResponse({
      content: "done",
      finishReason: "end_turn",
      costUsd: undefined,
      unpricedReason: "anthropic: service_tier=batch not modeled",
    });

    const echoAug: Augment = {
      name: "echo-aug",
      capabilities: ["tools"],
      tools: [
        {
          name: "echo",
          description: "echoes input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();

    const loop = createTurnLoop({
      augments: [identityAugment(), echoAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(false);
    if (cost.priced) throw new Error("expected unpriced");
    expect(cost.reason).toContain("service_tier=batch");
  });

  it("commits priced cost for single-iteration turn (regression-guard)", async () => {
    const model = createMockModel();
    model.pushResponse({ content: "", finishReason: "end_turn", costUsd: 0.001 });
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    // Single-iteration turn: cost is 0.001 (regression-guard for back-compat).
    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(true);
    if (!cost.priced) throw new Error("expected priced");
    expect(cost.costUsd).toBeCloseTo(0.001, 9);
  });
});

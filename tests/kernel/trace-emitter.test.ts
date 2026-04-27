import { describe, it, expect } from "bun:test";
import { createTraceEmitter } from "@/kernel/trace-emitter";

describe("TraceEmitter", () => {
  it("creates a turn trace with required fields", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: {
        type: "message",
        sourceAugment: "web",
        peerKind: "human",
        trustLevel: "agent",
      },
    });

    expect(trace.turnId).toBe("t1");
    expect(trace.threadId).toBe("th1");
    expect(trace.trigger.type).toBe("message");
  });

  it("records context assembly", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.recordContextAssembly(trace, {
      augmentBlocks: [
        { source: "identity", tokens: 100, included: true, evicted: false },
      ],
      preambleTokens: 0,
      toolSchemaTokens: 0,
      historyTokens: 500,
      totalTokens: 600,
      budgetUsed: 60,
    });

    expect(trace.contextAssembly.augmentBlocks).toHaveLength(1);
    expect(trace.contextAssembly.totalTokens).toBe(600);
  });

  it("records inference", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.recordInference(trace, {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 1500,
      toolCalls: [],
      cost: { priced: true, costUsd: 0.006 },
    });

    expect(trace.inferenceSteps).toHaveLength(1);
    expect(trace.inferenceSteps[0]!.model).toBe("claude-sonnet-4-6");
    expect(trace.inferenceSteps[0]!.durationMs).toBe(1500);
  });

  it("accumulates multiple inference steps", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.recordInference(trace, {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 1500,
      toolCalls: [],
      cost: { priced: true, costUsd: 0.006 },
    });

    emitter.recordInference(trace, {
      model: "claude-sonnet-4-6",
      inputTokens: 1200,
      outputTokens: 100,
      durationMs: 800,
      toolCalls: [],
      cost: { priced: true, costUsd: 0.005 },
    });

    expect(trace.inferenceSteps).toHaveLength(2);
    const totalTokens = trace.inferenceSteps.reduce(
      (sum, s) => sum + s.inputTokens + s.outputTokens,
      0,
    );
    expect(totalTokens).toBe(2500);
  });

  it("finalizes with duration", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.finalize(trace);
    expect(trace.duration).toBeGreaterThanOrEqual(0);
  });

  it("records cost as CostResult { priced: true } when a real cost is known", () => {
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.recordInference(trace, {
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 100,
      durationMs: 800,
      toolCalls: [],
      cost: { priced: true, costUsd: 0.003 },
    });

    const cost = trace.inferenceSteps[0]!.cost;
    expect(cost.priced).toBe(true);
    if (cost.priced) expect(cost.costUsd).toBeCloseTo(0.003);
  });

  it("records cost as CostResult { priced: false } when model pricing was unavailable", () => {
    // Represents a turn where the engine returned no costUsd (unknown model, no costOverride).
    // The turn-loop records { priced: false, reason } — no costUsd field exists.
    const emitter = createTraceEmitter();
    const trace = emitter.startTurn({
      turnId: "t2",
      threadId: "th1",
      trigger: { type: "message" },
    });

    emitter.recordInference(trace, {
      model: "claude-future-99",
      inputTokens: 200,
      outputTokens: 50,
      durationMs: 400,
      toolCalls: [],
      cost: { priced: false, reason: "engine returned no costUsd" },
    });

    const cost = trace.inferenceSteps[0]!.cost;
    expect(cost.priced).toBe(false);
    if (!cost.priced) {
      expect(cost.reason).toBe("engine returned no costUsd");
      // costUsd field does not exist on the unpriced variant
      expect((cost as Record<string, unknown>)["costUsd"]).toBeUndefined();
    }
  });
});

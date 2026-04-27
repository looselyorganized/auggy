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
        trustLevel: "authenticated",
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
      cost: { inputCost: 0.003, outputCost: 0.003, total: 0.006, priced: true },
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
      cost: { inputCost: 0.003, outputCost: 0.003, total: 0.006, priced: true },
    });

    emitter.recordInference(trace, {
      model: "claude-sonnet-4-6",
      inputTokens: 1200,
      outputTokens: 100,
      durationMs: 800,
      toolCalls: [],
      cost: { inputCost: 0.004, outputCost: 0.001, total: 0.005, priced: true },
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

  it("records cost.priced=true when a real cost is known", () => {
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
      cost: { inputCost: 0.0015, outputCost: 0.0015, total: 0.003, priced: true },
    });

    expect(trace.inferenceSteps[0]!.cost.priced).toBe(true);
    expect(trace.inferenceSteps[0]!.cost.total).toBeCloseTo(0.003);
  });

  it("records cost.priced=false and total=0 when model pricing was unavailable", () => {
    // Represents a turn where costUsd was undefined (unknown model, no costOverride).
    // The turn-loop sets priced=false and total=0 as a safe display value.
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
      cost: { inputCost: 0, outputCost: 0, total: 0, priced: false },
    });

    expect(trace.inferenceSteps[0]!.cost.priced).toBe(false);
    expect(trace.inferenceSteps[0]!.cost.total).toBe(0);
  });
});

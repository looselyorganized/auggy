import { describe, expect, test } from "bun:test";
import {
  computeTokenCost,
  computeContextUtilization,
  computeLatency,
  aggregateMetrics,
} from "../../../evals/harness/metrics";
import type { TurnTrace } from "../../../src/types";

function makeTrace(overrides?: Partial<TurnTrace>): TurnTrace {
  return {
    turnId: "t1",
    threadId: "th1",
    timestamp: Date.now(),
    duration: 500,
    trigger: { type: "message" },
    contextAssembly: {
      augmentBlocks: [
        { source: "preamble", tokens: 100, included: true, evicted: false },
        { source: "webFetch", tokens: 50, included: true, evicted: false },
        { source: "filesystem", tokens: 80, included: true, evicted: false },
        { source: "eval-identity", tokens: 30, included: true, evicted: false },
        { source: "unused-aug", tokens: 200, included: false, evicted: true },
      ],
      historyTokens: 150,
      totalTokens: 410,
      budgetUsed: 45,
    },
    toolSelection: {
      totalTools: 5,
      phase1Used: false,
      mountedTools: ["web_fetch", "read_file"],
      withheldTools: ["blocked_tool"],
    },
    inferenceSteps: [
      {
        model: "claude-sonnet-4-6",
        inputTokens: 400,
        outputTokens: 60,
        durationMs: 350,
        toolCalls: [
          { name: "web_fetch", augment: "webFetch", durationMs: 80, approved: true },
        ],
        cost: { inputCost: 0.003, outputCost: 0.001, total: 0.004 },
      },
    ],
    capabilityChecks: [],
    ...overrides,
  };
}

describe("computeTokenCost", () => {
  test("sums tokens and cost from inference steps", () => {
    const result = computeTokenCost(makeTrace());
    expect(result.tokensIn).toBe(400);
    expect(result.tokensOut).toBe(60);
    expect(result.tokensTotal).toBe(460);
    expect(result.costUsd).toBeCloseTo(0.004);
  });

  test("includes augment breakdown", () => {
    const result = computeTokenCost(makeTrace());
    expect(result.augmentBreakdown.length).toBe(5);
    const preamble = result.augmentBreakdown.find((b) => b.source === "preamble");
    expect(preamble?.tokens).toBe(100);
    expect(preamble?.included).toBe(true);
  });
});

describe("computeContextUtilization", () => {
  test("classifies preamble and eval- sources as structural", () => {
    const result = computeContextUtilization(makeTrace());
    expect(result.structuralTokens).toBe(130); // preamble 100 + eval-identity 30
    expect(result.taskRelevantTokens).toBe(130); // webFetch 50 + filesystem 80
  });

  test("computes utilization ratio", () => {
    const result = computeContextUtilization(makeTrace());
    expect(result.utilizationRatio).toBeCloseTo(130 / 410, 2);
  });

  test("respects explicit structural sources", () => {
    const result = computeContextUtilization(makeTrace(), ["filesystem"]);
    expect(result.structuralTokens).toBe(210); // preamble 100 + eval-identity 30 + filesystem 80
    expect(result.taskRelevantTokens).toBe(50); // webFetch only
  });

  test("excludes evicted blocks", () => {
    const result = computeContextUtilization(makeTrace());
    const sources = result.augmentBlocks.map((b) => b.source);
    expect(sources).not.toContain("unused-aug");
  });
});

describe("computeLatency", () => {
  test("separates model, tool, and framework time", () => {
    const result = computeLatency(makeTrace());
    expect(result.totalMs).toBe(500);
    expect(result.modelInferenceMs).toBe(350);
    expect(result.toolExecutionMs).toBe(80);
    expect(result.frameworkOverheadMs).toBe(70); // 500 - 350 - 80
  });

  test("computes overhead percentage", () => {
    const result = computeLatency(makeTrace());
    expect(result.overheadPercent).toBeCloseTo(14, 0); // 70/500 = 14%
  });
});

describe("aggregateMetrics", () => {
  test("aggregates across multiple traces", () => {
    const t1 = makeTrace();
    const t2 = makeTrace({
      duration: 600,
      inferenceSteps: [
        {
          model: "claude-sonnet-4-6",
          inputTokens: 500,
          outputTokens: 80,
          durationMs: 400,
          toolCalls: [],
          cost: { inputCost: 0.004, outputCost: 0.002, total: 0.006 },
        },
      ],
    });

    const agg = aggregateMetrics([t1, t2]);
    expect(agg.tokenCost.meanTokensIn).toBe(450); // (400 + 500) / 2
    expect(agg.tokenCost.meanCostUsd).toBeCloseTo(0.005); // (0.004 + 0.006) / 2
    expect(agg.latency.totalP50Ms).toBeGreaterThanOrEqual(500);
  });

  test("handles empty trace array", () => {
    const agg = aggregateMetrics([]);
    expect(agg.tokenCost.meanTokensIn).toBe(0);
    expect(agg.contextUtilization.meanRatio).toBe(0);
    expect(agg.latency.totalP50Ms).toBe(0);
  });
});

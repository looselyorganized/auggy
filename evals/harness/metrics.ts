import type { TurnTrace } from "../../src/types";

export interface TokenCostMetrics {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number;
  augmentBreakdown: { source: string; tokens: number; included: boolean }[];
}

export interface ContextUtilizationMetrics {
  totalTokens: number;
  taskRelevantTokens: number;
  structuralTokens: number;
  utilizationRatio: number;
  historyTokens: number;
  augmentBlocks: { source: string; tokens: number; included: boolean }[];
  budgetUsedPercent: number;
}

export interface LatencyMetrics {
  totalMs: number;
  modelInferenceMs: number;
  frameworkOverheadMs: number;
  toolExecutionMs: number;
  overheadPercent: number;
}

export function computeTokenCost(trace: TurnTrace): TokenCostMetrics {
  const tokensIn = trace.inferenceSteps.reduce((s, step) => s + step.inputTokens, 0);
  const tokensOut = trace.inferenceSteps.reduce((s, step) => s + step.outputTokens, 0);
  const costUsd = trace.inferenceSteps.reduce((s, step) => s + step.cost.total, 0);

  return {
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    costUsd,
    augmentBreakdown: trace.contextAssembly.augmentBlocks.map((b) => ({
      source: b.source,
      tokens: b.tokens,
      included: b.included,
    })),
  };
}

export function computeContextUtilization(
  trace: TurnTrace,
  structuralSources: string[] = [],
): ContextUtilizationMetrics {
  const included = trace.contextAssembly.augmentBlocks.filter((b) => b.included);

  const structuralTokens = included
    .filter((b) => isStructural(b.source, structuralSources))
    .reduce((s, b) => s + b.tokens, 0);

  const taskRelevantTokens = included
    .filter((b) => !isStructural(b.source, structuralSources))
    .reduce((s, b) => s + b.tokens, 0);

  const totalTokens = trace.contextAssembly.totalTokens;

  return {
    totalTokens,
    taskRelevantTokens,
    structuralTokens,
    utilizationRatio: totalTokens > 0 ? taskRelevantTokens / totalTokens : 0,
    historyTokens: trace.contextAssembly.historyTokens,
    augmentBlocks: included.map((b) => ({
      source: b.source,
      tokens: b.tokens,
      included: b.included,
    })),
    budgetUsedPercent: trace.contextAssembly.budgetUsed,
  };
}

function isStructural(source: string, explicitStructural: string[]): boolean {
  if (explicitStructural.includes(source)) return true;
  const lower = source.toLowerCase();
  return lower.includes("preamble") || lower.includes("identity") || lower.includes("eval-");
}

export function computeLatency(trace: TurnTrace): LatencyMetrics {
  const totalMs = trace.duration;
  const modelInferenceMs = trace.inferenceSteps.reduce((s, step) => s + step.durationMs, 0);
  const toolExecutionMs = trace.inferenceSteps.reduce(
    (s, step) => s + step.toolCalls.reduce((ts, tc) => ts + tc.durationMs, 0),
    0,
  );
  const frameworkOverheadMs = Math.max(0, totalMs - modelInferenceMs - toolExecutionMs);

  return {
    totalMs,
    modelInferenceMs,
    frameworkOverheadMs,
    toolExecutionMs,
    overheadPercent: totalMs > 0 ? (frameworkOverheadMs / totalMs) * 100 : 0,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export interface AggregatedMetrics {
  tokenCost: {
    meanTokensIn: number;
    meanTokensOut: number;
    meanTotal: number;
    meanCostUsd: number;
  };
  contextUtilization: {
    meanRatio: number;
    meanStructuralTokens: number;
    meanTaskRelevantTokens: number;
  };
  latency: {
    totalP50Ms: number;
    totalP95Ms: number;
    modelP50Ms: number;
    modelP95Ms: number;
    overheadP50Ms: number;
    overheadP95Ms: number;
    meanOverheadPercent: number;
  };
}

export function aggregateMetrics(
  traces: TurnTrace[],
  structuralSources: string[] = [],
): AggregatedMetrics {
  const tokenMetrics = traces.map(computeTokenCost);
  const contextMetrics = traces.map((t) => computeContextUtilization(t, structuralSources));
  const latencyMetrics = traces.map(computeLatency);

  const mean = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    tokenCost: {
      meanTokensIn: mean(tokenMetrics.map((m) => m.tokensIn)),
      meanTokensOut: mean(tokenMetrics.map((m) => m.tokensOut)),
      meanTotal: mean(tokenMetrics.map((m) => m.tokensTotal)),
      meanCostUsd: mean(tokenMetrics.map((m) => m.costUsd)),
    },
    contextUtilization: {
      meanRatio: mean(contextMetrics.map((m) => m.utilizationRatio)),
      meanStructuralTokens: mean(contextMetrics.map((m) => m.structuralTokens)),
      meanTaskRelevantTokens: mean(contextMetrics.map((m) => m.taskRelevantTokens)),
    },
    latency: {
      totalP50Ms: percentile(latencyMetrics.map((m) => m.totalMs), 50),
      totalP95Ms: percentile(latencyMetrics.map((m) => m.totalMs), 95),
      modelP50Ms: percentile(latencyMetrics.map((m) => m.modelInferenceMs), 50),
      modelP95Ms: percentile(latencyMetrics.map((m) => m.modelInferenceMs), 95),
      overheadP50Ms: percentile(latencyMetrics.map((m) => m.frameworkOverheadMs), 50),
      overheadP95Ms: percentile(latencyMetrics.map((m) => m.frameworkOverheadMs), 95),
      meanOverheadPercent: mean(latencyMetrics.map((m) => m.overheadPercent)),
    },
  };
}

export function printMetricsSummary(agg: AggregatedMetrics, label: string): void {
  console.log(`\n=== ${label} — Operational Metrics ===\n`);

  console.log("Token Cost:");
  console.log(`  Mean tokens in:    ${agg.tokenCost.meanTokensIn.toFixed(0)}`);
  console.log(`  Mean tokens out:   ${agg.tokenCost.meanTokensOut.toFixed(0)}`);
  console.log(`  Mean tokens total: ${agg.tokenCost.meanTotal.toFixed(0)}`);
  console.log(`  Mean cost/task:    $${agg.tokenCost.meanCostUsd.toFixed(6)}`);

  console.log("\nContext Utilization:");
  console.log(`  Mean utilization ratio:    ${(agg.contextUtilization.meanRatio * 100).toFixed(1)}%`);
  console.log(`  Mean task-relevant tokens: ${agg.contextUtilization.meanTaskRelevantTokens.toFixed(0)}`);
  console.log(`  Mean structural tokens:    ${agg.contextUtilization.meanStructuralTokens.toFixed(0)}`);

  console.log("\nFramework Latency:");
  console.log(`  Total p50/p95:     ${agg.latency.totalP50Ms.toFixed(0)}ms / ${agg.latency.totalP95Ms.toFixed(0)}ms`);
  console.log(`  Model p50/p95:     ${agg.latency.modelP50Ms.toFixed(0)}ms / ${agg.latency.modelP95Ms.toFixed(0)}ms`);
  console.log(`  Overhead p50/p95:  ${agg.latency.overheadP50Ms.toFixed(0)}ms / ${agg.latency.overheadP95Ms.toFixed(0)}ms`);
  console.log(`  Mean overhead %:   ${agg.latency.meanOverheadPercent.toFixed(1)}%`);
  console.log();
}

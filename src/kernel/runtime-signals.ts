import type { CostResult, RuntimeSignalsSnapshot } from "../types";

type TurnOutcome = "completed" | "failed" | "canceled" | "rejected" | "outcome-unknown";
type InferenceOutcome = "completed" | "failed" | "canceled" | "outcome-unknown";
type ToolOutcome = "completed" | "failed" | "denied" | "outcome-unknown";
type DeliveryOutcome = "completed" | "failed" | "outcome-unknown";
type HookFailureOutcome = "failed" | "outcome-unknown";

interface MemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface RuntimeSignals {
  reset(): void;
  recordTurn(input: { outcome: TurnOutcome; durationMs: number }): void;
  recordInference(input: {
    outcome: InferenceOutcome;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: CostResult;
  }): void;
  recordTool(input: { outcome: ToolOutcome; durationMs: number }): void;
  beginResponseDelivery(): {
    finish(outcome: DeliveryOutcome, durationMs: number): void;
  };
  recordResponseDelivery(input: { outcome: DeliveryOutcome; durationMs: number }): void;
  recordHookFailure(outcome: HookFailureOutcome): void;
  recordThreadRecovery(completed: boolean): void;
  beginShutdown(): { finish(hookFailures: number): void };
  snapshot(): RuntimeSignalsSnapshot;
}

const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function safeValue(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function add(current: number, value: number): number {
  return Math.min(MAX_COUNTER, current + safeValue(value));
}

function increment(current: number): number {
  return Math.min(MAX_COUNTER, current + 1);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/**
 * Process-local, cardinality-free operational counters.
 *
 * Recorder methods deliberately accept only fixed enums and numeric values.
 * Customer identifiers, prompts, destinations, tool payloads, model names,
 * and exception strings therefore cannot cross this boundary accidentally.
 */
export function createRuntimeSignals(options?: {
  now?: () => number;
  memoryUsage?: () => MemoryUsageSnapshot;
}): RuntimeSignals {
  const now = options?.now ?? Date.now;
  const memoryUsage = options?.memoryUsage ?? (() => process.memoryUsage());

  let startedAt = 0;
  let turns = emptyTurns();
  let inference = emptyInference();
  let tools = emptyTools();
  let responseDelivery = emptyDelivery();
  let hooks = emptyHooks();
  let recovery = emptyRecovery();
  let shutdown = emptyShutdown();
  let shutdownInFlight = 0;
  let shutdownStartedAt = 0;

  function emptyTurns() {
    return {
      total: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      outcomeUnknown: 0,
      rejected: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
  }

  function emptyInference() {
    return {
      attempts: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      outcomeUnknown: 0,
      inputTokens: 0,
      outputTokens: 0,
      pricedCostUsd: 0,
      unpriced: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
  }

  function emptyTools() {
    return {
      attempts: 0,
      completed: 0,
      failed: 0,
      denied: 0,
      outcomeUnknown: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
  }

  function emptyDelivery() {
    return {
      attempts: 0,
      completed: 0,
      failed: 0,
      outcomeUnknown: 0,
      inFlight: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
  }

  function emptyHooks() {
    return { failed: 0, outcomeUnknown: 0 };
  }

  function emptyRecovery() {
    return { attempted: 0, completed: 0, rejected: 0 };
  }

  function emptyShutdown() {
    return {
      attempts: 0,
      completed: 0,
      inProgress: false,
      startedAt: 0,
      elapsedMs: 0,
      hookFailures: 0,
      lastDurationMs: 0,
      maxDurationMs: 0,
    };
  }

  function recordDuration(
    target: { totalDurationMs: number; maxDurationMs: number },
    value: number,
  ) {
    const durationMs = safeValue(value);
    target.totalDurationMs = add(target.totalDurationMs, durationMs);
    target.maxDurationMs = Math.max(target.maxDurationMs, durationMs);
  }

  function recordDelivery(input: { outcome: DeliveryOutcome; durationMs: number }): void {
    responseDelivery[input.outcome === "outcome-unknown" ? "outcomeUnknown" : input.outcome] =
      increment(
        responseDelivery[input.outcome === "outcome-unknown" ? "outcomeUnknown" : input.outcome],
      );
    recordDuration(responseDelivery, input.durationMs);
  }

  return {
    reset() {
      startedAt = safeValue(now());
      turns = emptyTurns();
      inference = emptyInference();
      tools = emptyTools();
      responseDelivery = emptyDelivery();
      hooks = emptyHooks();
      recovery = emptyRecovery();
      shutdown = emptyShutdown();
      shutdownInFlight = 0;
      shutdownStartedAt = 0;
    },

    recordTurn(input) {
      turns.total = increment(turns.total);
      const key = input.outcome === "outcome-unknown" ? "outcomeUnknown" : input.outcome;
      turns[key] = increment(turns[key]);
      recordDuration(turns, input.durationMs);
    },

    recordInference(input) {
      inference.attempts = increment(inference.attempts);
      const key = input.outcome === "outcome-unknown" ? "outcomeUnknown" : input.outcome;
      inference[key] = increment(inference[key]);
      inference.inputTokens = add(inference.inputTokens, input.inputTokens ?? 0);
      inference.outputTokens = add(inference.outputTokens, input.outputTokens ?? 0);
      if (input.cost?.priced) {
        inference.pricedCostUsd = add(inference.pricedCostUsd, input.cost.costUsd);
      } else if (input.cost) {
        inference.unpriced = increment(inference.unpriced);
      }
      recordDuration(inference, input.durationMs);
    },

    recordTool(input) {
      tools.attempts = increment(tools.attempts);
      const key = input.outcome === "outcome-unknown" ? "outcomeUnknown" : input.outcome;
      tools[key] = increment(tools[key]);
      recordDuration(tools, input.durationMs);
    },

    beginResponseDelivery() {
      responseDelivery.attempts = increment(responseDelivery.attempts);
      responseDelivery.inFlight = increment(responseDelivery.inFlight);
      let finished = false;
      return {
        finish(outcome, durationMs) {
          if (finished) return;
          finished = true;
          responseDelivery.inFlight = Math.max(0, responseDelivery.inFlight - 1);
          recordDelivery({ outcome, durationMs });
        },
      };
    },

    recordResponseDelivery(input) {
      responseDelivery.attempts = increment(responseDelivery.attempts);
      recordDelivery(input);
    },

    recordHookFailure(outcome) {
      hooks.failed = increment(hooks.failed);
      if (outcome === "outcome-unknown") hooks.outcomeUnknown = increment(hooks.outcomeUnknown);
    },

    recordThreadRecovery(completed) {
      recovery.attempted = increment(recovery.attempted);
      if (completed) recovery.completed = increment(recovery.completed);
      else recovery.rejected = increment(recovery.rejected);
    },

    beginShutdown() {
      const beganAt = safeValue(now());
      shutdown.attempts = increment(shutdown.attempts);
      shutdownInFlight = increment(shutdownInFlight);
      if (shutdownInFlight === 1) shutdownStartedAt = beganAt;
      let finished = false;
      return {
        finish(hookFailures) {
          if (finished) return;
          finished = true;
          const durationMs = safeValue(now() - beganAt);
          shutdown.completed = increment(shutdown.completed);
          shutdown.hookFailures = add(shutdown.hookFailures, hookFailures);
          shutdown.lastDurationMs = durationMs;
          shutdown.maxDurationMs = Math.max(shutdown.maxDurationMs, durationMs);
          shutdownInFlight = Math.max(0, shutdownInFlight - 1);
          if (shutdownInFlight === 0) shutdownStartedAt = 0;
        },
      };
    },

    snapshot() {
      let memory: MemoryUsageSnapshot;
      try {
        memory = memoryUsage();
      } catch {
        memory = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
      }
      return frozen({
        schemaVersion: 1 as const,
        scope: "process" as const,
        startedAt,
        collectedAt: safeValue(now()),
        turns: frozen({ ...turns }),
        inference: frozen({ ...inference }),
        tools: frozen({ ...tools }),
        responseDelivery: frozen({ ...responseDelivery }),
        hooks: frozen({ ...hooks }),
        threadRecovery: frozen({ ...recovery }),
        shutdown: frozen({
          ...shutdown,
          inProgress: shutdownInFlight > 0,
          startedAt: shutdownStartedAt,
          elapsedMs:
            shutdownInFlight > 0 ? safeValue(now() - shutdownStartedAt) : shutdown.lastDurationMs,
        }),
        memory: frozen({
          rssBytes: safeValue(memory.rss),
          heapTotalBytes: safeValue(memory.heapTotal),
          heapUsedBytes: safeValue(memory.heapUsed),
          externalBytes: safeValue(memory.external),
          arrayBuffersBytes: safeValue(memory.arrayBuffers),
        }),
      });
    },
  };
}

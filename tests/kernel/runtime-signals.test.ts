import { describe, expect, test } from "bun:test";
import { createRuntimeSignals } from "../../src/kernel/runtime-signals";

describe("runtime operational signals", () => {
  test("returns a deeply frozen, bounded aggregate snapshot", () => {
    let now = 1_000;
    const signals = createRuntimeSignals({
      now: () => now,
      memoryUsage: () => ({
        rss: 11,
        heapTotal: 22,
        heapUsed: 17,
        external: 3,
        arrayBuffers: 2,
      }),
    });

    signals.reset();
    signals.recordInference({
      outcome: "completed",
      durationMs: 25,
      inputTokens: 7,
      outputTokens: 5,
      cost: { priced: true, costUsd: 0.25 },
    });
    signals.recordInference({
      outcome: "failed",
      durationMs: 40,
      cost: { priced: false, reason: "provider did not report a price" },
    });
    signals.recordTool({ outcome: "completed", durationMs: 12 });
    signals.recordTool({ outcome: "outcome-unknown", durationMs: 18 });
    signals.recordTurn({ outcome: "completed", durationMs: 60 });
    signals.recordTurn({ outcome: "outcome-unknown", durationMs: 80 });
    signals.recordResponseDelivery({ outcome: "failed", durationMs: 9 });
    signals.recordHookFailure("outcome-unknown");
    signals.recordThreadRecovery(true);
    signals.recordThreadRecovery(false);
    const shutdown = signals.beginShutdown();
    now = 1_085;
    expect(signals.snapshot().shutdown).toMatchObject({
      attempts: 1,
      completed: 0,
      inProgress: true,
      startedAt: 1_000,
      elapsedMs: 85,
    });
    shutdown.finish(1);
    now = 1_100;

    const snapshot = signals.snapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      scope: "process",
      startedAt: 1_000,
      collectedAt: 1_100,
      turns: {
        total: 2,
        completed: 1,
        outcomeUnknown: 1,
        totalDurationMs: 140,
        maxDurationMs: 80,
      },
      inference: {
        attempts: 2,
        completed: 1,
        failed: 1,
        inputTokens: 7,
        outputTokens: 5,
        pricedCostUsd: 0.25,
        unpriced: 1,
        totalDurationMs: 65,
        maxDurationMs: 40,
      },
      tools: {
        attempts: 2,
        completed: 1,
        outcomeUnknown: 1,
        totalDurationMs: 30,
      },
      responseDelivery: { attempts: 1, failed: 1, inFlight: 0, totalDurationMs: 9 },
      hooks: { failed: 1, outcomeUnknown: 1 },
      threadRecovery: { attempted: 2, completed: 1, rejected: 1 },
      shutdown: {
        attempts: 1,
        completed: 1,
        inProgress: false,
        hookFailures: 1,
        lastDurationMs: 85,
      },
      memory: { rssBytes: 11, heapTotalBytes: 22, heapUsedBytes: 17, externalBytes: 3 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.turns)).toBe(true);
    expect(Object.isFrozen(snapshot.memory)).toBe(true);
  });

  test("accepts only fixed outcome dimensions and clamps invalid numeric input", () => {
    const signals = createRuntimeSignals();
    signals.reset();
    signals.recordInference({
      outcome: "completed",
      durationMs: Number.POSITIVE_INFINITY,
      inputTokens: -1,
      outputTokens: Number.NaN,
      cost: { priced: true, costUsd: Number.POSITIVE_INFINITY },
    });
    signals.recordTool({ outcome: "failed", durationMs: -100 });
    signals.recordTurn({ outcome: "rejected", durationMs: Number.NaN });

    const serialized = JSON.stringify(signals.snapshot());
    expect(serialized).not.toContain("null");
    expect(signals.snapshot()).toMatchObject({
      turns: { total: 1, rejected: 1, totalDurationMs: 0 },
      inference: {
        attempts: 1,
        completed: 1,
        inputTokens: 0,
        outputTokens: 0,
        pricedCostUsd: 0,
        totalDurationMs: 0,
      },
      tools: { attempts: 1, failed: 1, totalDurationMs: 0 },
    });
  });

  test("tracks delivery in-flight pressure without storing destinations or payloads", () => {
    const signals = createRuntimeSignals();
    signals.reset();
    const first = signals.beginResponseDelivery();
    const second = signals.beginResponseDelivery();
    expect(signals.snapshot().responseDelivery).toMatchObject({ attempts: 2, inFlight: 2 });

    first.finish("completed", 5);
    first.finish("failed", 100);
    second.finish("outcome-unknown", 8);

    expect(signals.snapshot().responseDelivery).toMatchObject({
      attempts: 2,
      completed: 1,
      outcomeUnknown: 1,
      failed: 0,
      inFlight: 0,
    });
  });

  test("keeps outcome-unknown inference distinct from completed work", () => {
    const signals = createRuntimeSignals();
    signals.reset();
    signals.recordInference({
      outcome: "outcome-unknown",
      durationMs: 3,
      cost: { priced: false, reason: "terminal result unavailable" },
    });
    expect(signals.snapshot().inference).toMatchObject({
      attempts: 1,
      completed: 0,
      failed: 0,
      outcomeUnknown: 1,
      unpriced: 1,
    });
  });
});

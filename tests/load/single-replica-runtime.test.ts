import { describe, expect, test } from "bun:test";
import { runSingleReplicaRuntimeLoad } from "../../scripts/load/single-replica-runtime";

describe("single-replica real-runtime load harness", () => {
  test("runs a bounded concierge burst through scheduler, delivery, drain, and restart", async () => {
    const report = await runSingleReplicaRuntimeLoad({
      profile: "concierge",
      seed: 7,
      requests: 32,
      threads: 8,
      maxConcurrent: 4,
      maxQueued: 32,
      providerLatencyMs: 1,
      deliveryLatencyMs: 1,
    });

    expect(report.mode).toBe("single-replica-runtime");
    expect(report.topology).toBe("one-process-one-logical-agent");
    expect(report.result.completed).toBe(32);
    expect(report.result.activePeak).toBeGreaterThan(1);
    expect(report.result.activePeak).toBeLessThanOrEqual(4);
    expect(report.result.queuedPeak).toBeLessThanOrEqual(32);
    expect(report.result.sameThreadOverlap).toBe(0);
    expect(report.result.deliveryActivePeak).toBeGreaterThan(0);
    expect(report.result.drainActiveTurnHeld).toBe(true);
    expect(report.result.drainProbeRejected).toBe(true);
    expect(report.result.restartProbeCompleted).toBe(true);
    expect(report.terminalSnapshot.scheduler).toMatchObject({
      state: "stopped",
      activeTurns: 0,
      queuedTurns: 0,
    });
    expect(report.invariantFailures).toEqual([]);
    expect(report.interpretation).toBe("machine-specific-evidence-not-a-capacity-guarantee");
  });

  test("runs tool-heavy order support without duplicate effects", async () => {
    const report = await runSingleReplicaRuntimeLoad({
      profile: "order-support",
      seed: 11,
      requests: 24,
      threads: 6,
      maxConcurrent: 4,
      maxQueued: 24,
      providerLatencyMs: 0,
      deliveryLatencyMs: 0,
    });

    expect(report.result.completed).toBe(24);
    expect(report.result.toolEffects).toBe(24);
    expect(report.result.duplicateToolEffects).toBe(0);
    // The terminal snapshot also includes the one held turn used to prove drain.
    expect(report.terminalSnapshot.tools).toMatchObject({ attempts: 25, completed: 25 });
    expect(report.terminalSnapshot.inference.attempts).toBe(50);
    expect(report.invariantFailures).toEqual([]);
  });

  test("classifies bounded queue saturation and queued cancellation exactly once", async () => {
    const report = await runSingleReplicaRuntimeLoad({
      profile: "concierge",
      requests: 20,
      threads: 20,
      maxConcurrent: 1,
      maxQueued: 5,
      providerLatencyMs: 2,
      deliveryLatencyMs: 2,
      cancelEvery: 2,
    });

    expect(report.result.canceled).toBeGreaterThan(0);
    expect(report.result.rejected).toBeGreaterThan(0);
    expect(
      report.result.completed +
        report.result.failed +
        report.result.canceled +
        report.result.rejected +
        report.result.outcomeUnknown,
    ).toBe(20);
    expect(report.result.activePeak).toBe(1);
    expect(report.result.queuedPeak).toBeLessThanOrEqual(5);
    expect(report.invariantFailures).toEqual([]);
  });

  test("releases runtime capacity after one non-cooperative provider stalls", async () => {
    const report = await runSingleReplicaRuntimeLoad({
      profile: "concierge",
      requests: 8,
      threads: 8,
      maxConcurrent: 2,
      maxQueued: 8,
      providerLatencyMs: 0,
      deliveryLatencyMs: 0,
      providerTimeoutMs: 5,
      stallEvery: 8,
    });

    expect(report.result.outcomeUnknown).toBe(1);
    expect(report.result.completed).toBe(7);
    expect(report.result.providerActiveAtEnd).toBe(1);
    expect(report.result.activePeak).toBeLessThanOrEqual(2);
    expect(report.result.restartProbeCompleted).toBe(true);
    expect(report.invariantFailures).toEqual([]);
  });

  test("returns a controlled report when the detached-provider circuit blocks probes", async () => {
    const run = runSingleReplicaRuntimeLoad({
      profile: "concierge",
      requests: 4,
      threads: 4,
      maxConcurrent: 1,
      maxQueued: 4,
      providerLatencyMs: 0,
      deliveryLatencyMs: 0,
      providerTimeoutMs: 5,
      stallEvery: 1,
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("all-stall load run hung")), 1_000);
    });
    const report = await Promise.race([run, timeout]);

    expect(report.result.outcomeUnknown).toBe(2);
    expect(report.result.rejected).toBe(2);
    expect(report.result.drainActiveTurnHeld).toBe(false);
    expect(report.result.drainProbeRejected).toBe(true);
    expect(report.result.restartProbeCompleted).toBe(false);
    expect(report.invariantFailures).toContain(
      "provider circuit prevented the held drain probe from starting",
    );
    expect(report.invariantFailures).toContain("restart probe did not complete");
  });

  test("rejects unknown and oversized inputs before allocating a workload", async () => {
    await expect(
      runSingleReplicaRuntimeLoad({ profile: "concierge", requests: 10_001 }),
    ).rejects.toThrow("requests must be a finite integer");
    await expect(
      runSingleReplicaRuntimeLoad({
        profile: "concierge",
        requests: 10,
        threads: 11,
      }),
    ).rejects.toThrow("threads must be a finite integer");
    await expect(
      runSingleReplicaRuntimeLoad({
        profile: "concierge",
        stallEvery: 1,
        providerTimeoutMs: 30_001,
      }),
    ).rejects.toThrow("providerTimeoutMs must be at most 30000");
  });
});

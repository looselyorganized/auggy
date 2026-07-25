import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SYNTHETIC_LOAD_THRESHOLDS,
  evaluateSyntheticLoad,
  runSyntheticDistributedLoad,
} from "../../scripts/load/distributed-coordination";

describe("synthetic distributed coordination load harness", () => {
  test("models a deterministic bursty concierge workload with bounded metrics", () => {
    const first = runSyntheticDistributedLoad({ profile: "concierge", seed: 7, requests: 120 });
    const second = runSyntheticDistributedLoad({ profile: "concierge", seed: 7, requests: 120 });

    expect(first).toEqual(second);
    expect(first.mode).toBe("reference-model");
    expect(first.replicaAssignments).toHaveLength(3);
    expect(first.replicaAssignments.reduce((total, count) => total + count, 0)).toBe(120);
    expect(first.completed).toBe(120);
    expect(first.activePeak).toBeGreaterThan(0);
    expect(first.queueWaitMs.p99).toBeGreaterThanOrEqual(first.queueWaitMs.p95);
    expect(evaluateSyntheticLoad(first, DEFAULT_SYNTHETIC_LOAD_THRESHOLDS)).toEqual([]);
  });

  test("joins in-flight duplicates and replays only completed order mutations", () => {
    const metrics = runSyntheticDistributedLoad({
      profile: "order-support",
      seed: 7,
      requests: 180,
      maxActive: 8,
    });

    expect(metrics.completed).toBeLessThanOrEqual(metrics.requested);
    expect(metrics.duplicateMutations).toBe(0);
    expect(metrics.inFlightMutationJoins).toBeGreaterThan(0);
    expect(metrics.completedMutationReplays).toBeGreaterThan(0);
    expect(metrics.sameThreadOverlap).toBe(0);
    expect(metrics.staleFenceAccepts).toBe(0);
    expect(metrics.staleFenceRejects).toBe(1);
    expect(metrics.namespaceViolations).toBe(0);
    expect(metrics.namespaceRejects).toBe(1);
    expect(metrics.crossNamespaceSameKeyExecutions).toBeGreaterThan(0);
    expect(evaluateSyntheticLoad(metrics)).toEqual([]);
  });

  test("quarantines an outcome-unknown thread and rejects later work without recovery", () => {
    const metrics = runSyntheticDistributedLoad({
      profile: "order-support",
      seed: 4,
      requests: 72,
      faults: { outcomeUnknownEvery: 1 },
    });

    expect(metrics.outcomeUnknown).toBeGreaterThan(0);
    expect(metrics.quarantinedThreads).toBeGreaterThan(0);
    expect(metrics.recoveryRejected).toBeGreaterThan(0);
    expect(evaluateSyntheticLoad(metrics)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("outcome unknown"),
        expect.stringContaining("recovery rejected"),
      ]),
    );
  });

  test("executes immediately when the queue capacity is zero and a slot is available", () => {
    const metrics = runSyntheticDistributedLoad({
      profile: "concierge",
      seed: 8,
      requests: 1,
      maxQueued: 0,
    });

    expect(metrics.rejections).toBe(0);
    expect(metrics.completed).toBe(1);
  });

  test("makes deliberately broken fencing, namespace, and availability seams visible", () => {
    const metrics = runSyntheticDistributedLoad({
      profile: "order-support",
      requests: 24,
      faults: {
        acceptStaleFences: true,
        allowCrossNamespaceReads: true,
        coordinatorUnavailableEvery: 7,
        outcomeUnknownEvery: 5,
      },
    });

    expect(metrics.staleFenceAccepts).toBe(1);
    expect(metrics.namespaceViolations).toBe(1);
    expect(metrics.unavailable).toBeGreaterThan(0);
    expect(metrics.outcomeUnknown).toBeGreaterThan(0);
    expect(evaluateSyntheticLoad(metrics)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stale fence accepts"),
        expect.stringContaining("namespace violations"),
        expect.stringContaining("unavailable"),
        expect.stringContaining("outcome unknown"),
      ]),
    );
  });

  test("rejects oversized synthetic runs before allocating an unbounded workload", () => {
    expect(() =>
      runSyntheticDistributedLoad({
        profile: "concierge",
        requests: DEFAULT_SYNTHETIC_LOAD_THRESHOLDS.maxRequests + 1,
      }),
    ).toThrow("requests must be a finite integer");
  });
});

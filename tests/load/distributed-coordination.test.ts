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
    expect(first.completed).toBe(120);
    expect(first.activePeak).toBeGreaterThan(0);
    expect(first.queueWaitMs.p99).toBeGreaterThanOrEqual(first.queueWaitMs.p95);
    expect(evaluateSyntheticLoad(first, DEFAULT_SYNTHETIC_LOAD_THRESHOLDS)).toEqual([]);
  });

  test("replays duplicate order mutations without overlap or stale fence acceptance", () => {
    const metrics = runSyntheticDistributedLoad({
      profile: "order-support",
      seed: 19,
      requests: 180,
      maxActive: 8,
    });

    expect(metrics.completed).toBeLessThanOrEqual(metrics.requested);
    expect(metrics.duplicateMutations).toBe(0);
    expect(metrics.sameThreadOverlap).toBe(0);
    expect(metrics.staleFenceAccepts).toBe(0);
    expect(metrics.namespaceViolations).toBe(0);
    expect(evaluateSyntheticLoad(metrics)).toEqual([]);
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

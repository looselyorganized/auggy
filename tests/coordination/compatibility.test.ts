import { describe, expect, test } from "bun:test";
import {
  buildDistributedCoordinationCompatibility,
  DISTRIBUTED_COORDINATION_PROTOCOL,
} from "../../src/coordination/compatibility";
import type {
  DistributedCoordinationConfig,
  DistributedCoordinationTurnStateConfig,
} from "../../src";

const defaultTurnState: DistributedCoordinationTurnStateConfig = {
  history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 1_000 },
  maxCostMarkersPerTurn: 32,
  outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 1_000 },
};

function coordination(): DistributedCoordinationConfig {
  return {
    mode: "postgres",
    namespace: "5d9b9796-65ba-43d0-9ba9-57f1a9db5ef7",
    urlEnv: "SENTINEL_DATABASE_ENV",
    fleetCapacity: { maxConcurrent: 8, maxQueued: 200, maxQueuedPerThread: 25 },
    retention: {
      terminalRequestRetentionMs: 604_800_000,
      maxTerminalRequests: 10_000,
      eventRetentionMs: 2_592_000_000,
      maxEvents: 50_000,
    },
    result: { maxReplayBytes: 65_536 },
    turnState: structuredClone(defaultTurnState),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5_000,
    claimPollMs: 100,
    maxWaitMs: 30_000,
  };
}

function input() {
  return {
    coordination: coordination(),
    sources: [
      { id: "jobs", maxConcurrent: 2, maxQueued: 20 },
      { id: "web", maxConcurrent: 8, maxQueued: 200 },
    ],
    augments: [
      {
        augmentIndex: 0,
        componentType: "fileMemory",
        topologyClass: "unsupported" as const,
        compatibilityVersion: 1,
        semanticFingerprint: "a".repeat(64),
        requirements: ["local-mutable-state" as const],
      },
      {
        augmentIndex: 1,
        componentType: "budgets",
        topologyClass: "unsupported" as const,
        compatibilityVersion: 1,
        semanticFingerprint: "b".repeat(64),
        requirements: ["shared-budget-store-missing" as const],
      },
    ],
  };
}

describe("distributed coordination compatibility fingerprints", () => {
  test("derives stable code-owned protocol and configuration fingerprints", () => {
    const first = buildDistributedCoordinationCompatibility(input());
    const reorderedSources = input();
    reorderedSources.sources.reverse();
    const second = buildDistributedCoordinationCompatibility(reorderedSources);

    expect(DISTRIBUTED_COORDINATION_PROTOCOL).toEqual({
      name: "auggy-postgres-coordination",
      protocolVersion: 8,
      schemaVersion: 8,
      fingerprintVersion: 2,
    });
    expect(first).toEqual(second);
    expect(first.protocolVersion).toBe(8);
    expect(first.protocolFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.upgradeFrom).toMatchObject({ protocolVersion: 7 });
    expect(first.upgradeFrom.protocolFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.upgradeFrom.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.upgradeFrom.protocolFingerprint).not.toBe(first.protocolFingerprint);
    expect(first.upgradeFrom.configurationFingerprint).not.toBe(first.configurationFingerprint);
  });

  test("binds authoritative fleet policy and preserves augment order", () => {
    const baseline = buildDistributedCoordinationCompatibility(input());
    const mutations = [
      (value: ReturnType<typeof input>) => (value.coordination.fleetCapacity.maxConcurrent += 1),
      (value: ReturnType<typeof input>) => (value.coordination.leaseDurationMs += 1_000),
      (value: ReturnType<typeof input>) => (value.coordination.retention.maxEvents += 1),
      (value: ReturnType<typeof input>) => (value.coordination.result.maxReplayBytes += 1),
      (value: ReturnType<typeof input>) => (value.coordination.turnState.history.maxThreads += 1),
      (value: ReturnType<typeof input>) =>
        (value.coordination.turnState.outbox.maxPendingIntents += 1),
      (value: ReturnType<typeof input>) => {
        value.coordination.admission = {
          maxRateLimitEvents: 100,
          capacityClasses: [
            {
              id: "public",
              maxRetainedRequests: 100,
              maxRetainedRequestsPerPartition: 10,
            },
          ],
          rateLimits: [
            { id: "web.anonymous-network.v1", max: 10, maxEvents: 100, windowMs: 60_000 },
          ],
        };
      },
      (value: ReturnType<typeof input>) => {
        value.coordination.budgets = {
          policies: [
            {
              id: "support",
              caps: { public: { recognized: { maxTurnsPerDay: 10 } } },
              maxReservations: 20_000,
              reservationRetentionMs: 604_800_000,
              maxAnonymousEvents: 1_000,
              maxPeerDays: 1_000,
              maxThresholdIntents: 21,
              aggregateRetentionDays: 7,
            },
          ],
        };
      },
      (value: ReturnType<typeof input>) => (value.sources[0]!.maxQueued += 1),
      (value: ReturnType<typeof input>) => {
        value.augments.reverse();
        value.augments.forEach((augment, augmentIndex) => {
          augment.augmentIndex = augmentIndex;
        });
      },
      (value: ReturnType<typeof input>) => (value.augments[0]!.compatibilityVersion += 1),
      (value: ReturnType<typeof input>) => (value.augments[0]!.componentType = "supabaseMemory"),
      (value: ReturnType<typeof input>) =>
        (value.augments[0]!.semanticFingerprint = "c".repeat(64)),
    ];

    for (const mutate of mutations) {
      const changed = input();
      mutate(changed);
      expect(buildDistributedCoordinationCompatibility(changed).configurationFingerprint).not.toBe(
        baseline.configurationFingerprint,
      );
    }
  });

  test("canonicalizes distributed admission policy ordering", () => {
    const firstInput = input();
    firstInput.coordination.admission = {
      maxRateLimitEvents: 100,
      capacityClasses: [
        { id: "public", maxRetainedRequests: 100, maxRetainedRequestsPerPartition: 10 },
        { id: "agent", maxRetainedRequests: 50, maxRetainedRequestsPerPartition: 5 },
      ],
      rateLimits: [
        { id: "web.route.one", max: 5, maxEvents: 50, windowMs: 60_000 },
        { id: "web.route.two", max: 2, maxEvents: 50, windowMs: 60_000 },
      ],
    };
    const secondInput = structuredClone(firstInput);
    secondInput.coordination.admission!.capacityClasses = [
      ...secondInput.coordination.admission!.capacityClasses!,
    ].reverse();
    secondInput.coordination.admission!.rateLimits = [
      ...secondInput.coordination.admission!.rateLimits,
    ].reverse();

    expect(buildDistributedCoordinationCompatibility(firstInput)).toEqual(
      buildDistributedCoordinationCompatibility(secondInput),
    );
  });

  test("excludes process-local polling, environment names, and secret option values", () => {
    const baseline = buildDistributedCoordinationCompatibility(input());
    const changed = input();
    changed.coordination.urlEnv = "SENTINEL_SECOND_DATABASE_ENV";
    changed.coordination.heartbeatIntervalMs = 1_000;
    changed.coordination.claimPollMs = 10;
    changed.coordination.maxWaitMs = 0;
    (changed as unknown as { secretOptions: unknown }).secretOptions = {
      apiKey: "SENTINEL_API_KEY_VALUE",
      databaseUrl: "postgres://sentinel-secret@example.invalid/db",
    };

    const result = buildDistributedCoordinationCompatibility(changed);
    expect(result).toEqual(baseline);
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");
  });

  test("rejects malformed, duplicate, missing, and oversized compatibility input", () => {
    const invalid = [
      () => {
        const value = input();
        value.coordination.fleetCapacity.maxConcurrent = Number.NaN;
        return value;
      },
      () => {
        const value = input();
        value.sources[1]!.id = value.sources[0]!.id;
        return value;
      },
      () => {
        const value = input();
        value.augments[1]!.augmentIndex = 0;
        return value;
      },
      () => {
        const value = input();
        value.augments[0]!.requirements = ["forged-safe-claim" as never];
        return value;
      },
      () => {
        const value = input();
        value.augments[0]!.requirements = ["local-mutable-state", "local-mutable-state"];
        return value;
      },
      () => {
        const value = input();
        value.augments[0]!.semanticFingerprint = "forged-safe-claim";
        return value;
      },
      () => {
        const value = input();
        value.augments = Array.from({ length: 257 }, (_, augmentIndex) => ({
          ...value.augments[0]!,
          augmentIndex,
        }));
        return value;
      },
      () => {
        const value = input();
        value.coordination.admission = {
          maxRateLimitEvents: 0,
          capacityClasses: [
            { id: "public", maxRetainedRequests: 8_000, maxRetainedRequestsPerPartition: 1 },
            { id: "agent", maxRetainedRequests: 8_000, maxRetainedRequestsPerPartition: 1 },
          ],
          rateLimits: [],
        };
        return value;
      },
      () => {
        const value = input();
        value.coordination.admission = {
          maxRateLimitEvents: 0,
          capacityClasses: [
            { id: "public", maxRetainedRequests: 10, maxRetainedRequestsPerPartition: 1 },
            { id: "public", maxRetainedRequests: 10, maxRetainedRequestsPerPartition: 1 },
          ],
          rateLimits: [],
        };
        return value;
      },
    ];

    for (const build of invalid) {
      expect(() => buildDistributedCoordinationCompatibility(build())).toThrow(
        "invalid distributed compatibility input",
      );
    }
  });

  test("sanitizes exceptions raised while reading hostile objects", () => {
    const sentinel = "SENTINEL_GETTER_SECRET";
    const value = input();
    Object.defineProperty(value.coordination.fleetCapacity, "maxConcurrent", {
      get: () => {
        throw new Error(sentinel);
      },
    });

    expect(() => buildDistributedCoordinationCompatibility(value)).toThrow(
      "invalid distributed compatibility input",
    );
    try {
      buildDistributedCoordinationCompatibility(value);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
    }
  });
});

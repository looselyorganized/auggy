import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import type {
  DistributedCoordinatorConfig,
  DistributedTurnRequest,
} from "../../src/coordination/types";

const source = { id: "transport:web", maxConcurrent: 2, maxQueued: 8 } as const;
const reservation = {
  policyId: "web.anonymous-network.v1",
  subjectHash: "d".repeat(64),
} as const;

function config(instanceId: string): DistributedCoordinatorConfig {
  return {
    namespace: "distributed-admission-test",
    instanceId,
    buildFingerprint: "c".repeat(64),
    maxConcurrent: 2,
    maxQueued: 8,
    maxQueuedPerThread: 4,
    leaseMs: 1_000,
    sources: [source],
    retention: {
      terminalRequestRetentionMs: 60_000,
      maxTerminalRequests: 100,
      eventRetentionMs: 60_000,
      maxEvents: 100,
    },
    result: { maxReplayBytes: 65_536 },
    turnState: {
      history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 100 },
      maxCostMarkersPerTurn: 32,
      outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 100 },
    },
    admission: {
      maxRateLimitEvents: 100,
      capacityClasses: [
        { id: "public", maxRetainedRequests: 4, maxRetainedRequestsPerPartition: 2 },
        { id: "agent", maxRetainedRequests: 1, maxRetainedRequestsPerPartition: 1 },
        { id: "creator", maxRetainedRequests: 1, maxRetainedRequestsPerPartition: 1 },
      ],
      rateLimits: [
        {
          id: reservation.policyId,
          max: 1,
          maxEvents: 100,
          windowMs: 60_000,
        },
      ],
    },
    compatibility: {
      protocolVersion: 6,
      protocolFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    },
  };
}

function request(
  requestId: string,
  overrides: Partial<DistributedTurnRequest> = {},
): DistributedTurnRequest {
  return {
    requestId,
    threadId: `thread:${requestId}`,
    source,
    bindingHash: "e".repeat(64),
    capacity: { classId: "public", partitionHash: "c".repeat(64) },
    admission: [reservation],
    ...overrides,
  };
}

afterEach(() => resetInMemoryDistributedCoordination());

describe("distributed admission reservations", () => {
  test("preflights the isolated evidence capacity required by a source", () => {
    const owner = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    expect(
      owner.supportsAdmissionPolicy({
        rateLimits: [
          {
            id: reservation.policyId,
            max: 1,
            minRetainedEvents: 100,
            windowMs: 60_000,
          },
        ],
      }),
    ).toBe(true);
    expect(
      owner.supportsAdmissionPolicy({
        rateLimits: [
          {
            id: reservation.policyId,
            max: 1,
            minRetainedEvents: 101,
            windowMs: 60_000,
          },
        ],
      }),
    ).toBe(false);
  });

  test("an exact cross-replica duplicate joins without spending another quota slot", async () => {
    const first = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    const second = createInMemoryDistributedTurnCoordinator(config("replica-b"));
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const canonical = request("request-one");
    expect(await first.admit(canonical)).toEqual({ status: "admitted", attempt: 1 });
    expect(await second.admit(canonical)).toEqual({ status: "joined", state: "queued" });

    expect(await second.admit(request("request-two"))).toMatchObject({
      status: "rejected",
      reason: "rate-limited",
    });
  });

  test("the same request id conflicts when its reservation subjects change", async () => {
    const first = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    const second = createInMemoryDistributedTurnCoordinator(config("replica-b"));
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const canonical = request("request-one");
    expect(await first.admit(canonical)).toEqual({ status: "admitted", attempt: 1 });
    expect(
      await second.admit(
        request("request-one", {
          admission: [{ ...reservation, subjectHash: "f".repeat(64) }],
        }),
      ),
    ).toEqual({ status: "conflict" });
  });

  test("unknown or duplicated policies fail closed without creating a request", async () => {
    const owner = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    expect(await owner.register()).toEqual({ status: "registered" });

    expect(
      await owner.admit(
        request("unknown-policy", {
          admission: [{ policyId: "web.missing.v1", subjectHash: "a".repeat(64) }],
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-admission" });
    expect(
      await owner.admit(
        request("duplicate-policy", {
          admission: [reservation, reservation],
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid-admission" });

    expect(await owner.admit(request("request-one"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
  });

  test("rate-event capacity fails closed and does not fall back to local authority", async () => {
    const limited = config("replica-a");
    limited.admission!.maxRateLimitEvents = 1;
    limited.admission!.rateLimits[0]!.max = 10;
    limited.admission!.rateLimits[0]!.maxEvents = 1;
    const owner = createInMemoryDistributedTurnCoordinator(limited);
    expect(await owner.register()).toEqual({ status: "registered" });

    expect(await owner.admit(request("request-one"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(
      await owner.admit(
        request("request-two", {
          admission: [{ ...reservation, subjectHash: "f".repeat(64) }],
        }),
      ),
    ).toEqual({ status: "rejected", reason: "admission-capacity" });
  });

  test("retained-request capacity is isolated by trust class and partition", async () => {
    const firstConfig = config("replica-a");
    const secondConfig = config("replica-b");
    firstConfig.admission!.capacityClasses![0]!.maxRetainedRequests = 2;
    firstConfig.admission!.capacityClasses![0]!.maxRetainedRequestsPerPartition = 1;
    secondConfig.admission!.capacityClasses![0]!.maxRetainedRequests = 2;
    secondConfig.admission!.capacityClasses![0]!.maxRetainedRequestsPerPartition = 1;
    const first = createInMemoryDistributedTurnCoordinator(firstConfig);
    const second = createInMemoryDistributedTurnCoordinator(secondConfig);
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const publicRequest = request("public-one");
    expect(await first.admit(publicRequest)).toEqual({ status: "admitted", attempt: 1 });
    expect(await second.admit(publicRequest)).toEqual({ status: "joined", state: "queued" });
    expect(
      await second.admit(
        request("public-two", {
          admission: [],
          capacity: { classId: "public", partitionHash: "c".repeat(64) },
        }),
      ),
    ).toEqual({ status: "rejected", reason: "request-capacity" });
    expect(
      await second.admit(
        request("public-other-partition", {
          admission: [],
          capacity: { classId: "public", partitionHash: "d".repeat(64) },
        }),
      ),
    ).toEqual({ status: "admitted", attempt: 1 });
    expect(
      await second.admit(
        request("agent-one", {
          admission: [],
          capacity: { classId: "agent", partitionHash: "e".repeat(64) },
        }),
      ),
    ).toEqual({ status: "admitted", attempt: 1 });
  });

  test("an existing request conflicts when its capacity binding changes", async () => {
    const owner = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    expect(await owner.register()).toEqual({ status: "registered" });
    expect(await owner.admit(request("capacity-binding"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(
      await owner.admit(
        request("capacity-binding", {
          capacity: { classId: "agent", partitionHash: "c".repeat(64) },
        }),
      ),
    ).toEqual({ status: "conflict" });
  });

  test("missing and unknown capacity projections fail before spending rate evidence", async () => {
    const owner = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    expect(await owner.register()).toEqual({ status: "registered" });
    const missing = request("capacity-missing");
    delete missing.capacity;
    expect(await owner.admit(missing)).toEqual({
      status: "rejected",
      reason: "invalid-admission",
    });
    expect(
      await owner.admit(
        request("capacity-unknown", {
          capacity: { classId: "unknown", partitionHash: "c".repeat(64) },
        }),
      ),
    ).toEqual({ status: "rejected", reason: "invalid-admission" });
    expect(await owner.admit(request("capacity-valid"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
  });

  test("standalone route reservations are atomic and idempotent across replicas", async () => {
    const first = createInMemoryDistributedTurnCoordinator(config("replica-a"));
    const second = createInMemoryDistributedTurnCoordinator(config("replica-b"));
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const routeReservation = {
      reservationId: "rate:route-request-one",
      admission: [reservation],
    };
    expect(await first.reserveRateLimits(routeReservation)).toEqual({ status: "reserved" });
    expect(await second.reserveRateLimits(routeReservation)).toEqual({ status: "replayed" });
    expect(
      await second.reserveRateLimits({
        reservationId: routeReservation.reservationId,
        admission: [{ ...reservation, subjectHash: "f".repeat(64) }],
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await second.reserveRateLimits({
        reservationId: "rate:route-request-two",
        admission: [reservation],
      }),
    ).toMatchObject({ status: "rejected", reason: "rate-limited" });
  });

  test("partitions bounded rate evidence by policy so one route cannot exhaust turns", async () => {
    const bounded = config("replica-a");
    bounded.admission = {
      maxRateLimitEvents: 2,
      capacityClasses: bounded.admission!.capacityClasses,
      rateLimits: [
        { id: "web.route.v1", max: 10, maxEvents: 1, windowMs: 60_000 },
        { id: reservation.policyId, max: 10, maxEvents: 1, windowMs: 60_000 },
      ],
    };
    const owner = createInMemoryDistributedTurnCoordinator(bounded);
    expect(await owner.register()).toEqual({ status: "registered" });
    expect(
      await owner.reserveRateLimits({
        reservationId: "rate:route-one",
        admission: [{ policyId: "web.route.v1", subjectHash: "a".repeat(64) }],
      }),
    ).toEqual({ status: "reserved" });
    expect(
      await owner.reserveRateLimits({
        reservationId: "rate:route-two",
        admission: [{ policyId: "web.route.v1", subjectHash: "b".repeat(64) }],
      }),
    ).toEqual({ status: "rejected", reason: "admission-capacity" });
    expect(
      await owner.admit(
        request("turn-after-route", {
          admission: [reservation],
        }),
      ),
    ).toEqual({ status: "admitted", attempt: 1 });
  });

  test("upgrades admission policy only with an empty predecessor request ledger", async () => {
    let now = 0;
    const predecessorTuple = {
      protocolVersion: 5,
      protocolFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    };
    const predecessor = config("old-empty");
    delete predecessor.admission;
    predecessor.compatibility = predecessorTuple;
    const successor = config("new-empty");
    successor.compatibility = {
      protocolVersion: 6,
      protocolFingerprint: "f".repeat(64),
      configurationFingerprint: "1".repeat(64),
      upgradeFrom: predecessorTuple,
    };
    const oldEmpty = createInMemoryDistributedTurnCoordinator(predecessor, { now: () => now });
    const newEmpty = createInMemoryDistributedTurnCoordinator(successor, { now: () => now });
    expect(await oldEmpty.register()).toEqual({ status: "registered" });
    now = 1_001;
    expect(await newEmpty.register()).toEqual({ status: "registered" });

    resetInMemoryDistributedCoordination();
    now = 0;
    const oldRetained = createInMemoryDistributedTurnCoordinator(predecessor, { now: () => now });
    const newRetained = createInMemoryDistributedTurnCoordinator(successor, { now: () => now });
    expect(await oldRetained.register()).toEqual({ status: "registered" });
    const retained = request("retained-predecessor");
    delete retained.capacity;
    delete retained.admission;
    expect(await oldRetained.admit(retained)).toEqual({ status: "admitted", attempt: 1 });
    expect(await oldRetained.abandon(retained)).toEqual({ status: "ok" });
    now = 1_001;
    expect(await newRetained.register()).toEqual({ status: "unavailable" });
  });
});

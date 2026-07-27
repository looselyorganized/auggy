import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import { POSTGRES_COORDINATION_MIGRATIONS } from "../../src/coordination/migrations";

const hash = "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY";
const source = { id: "web", maxConcurrent: 1, maxQueued: 2 };
const coordinatorPolicy = {
  retention: {
    terminalRequestRetentionMs: 604_800_000,
    maxTerminalRequests: 10_000,
    eventRetentionMs: 2_592_000_000,
    maxEvents: 50_000,
  },
  result: { maxReplayBytes: 65_536 },
  compatibility: {
    protocolVersion: 1,
    protocolFingerprint: "a".repeat(64),
    configurationFingerprint: "b".repeat(64),
  },
};

function replica(
  instanceId: string,
  now: () => number,
  extra: Partial<{
    maxConcurrent: number;
    maxQueued: number;
    failClosed: () => boolean;
    protocolVersion: number;
    configurationFingerprint: string;
  }> = {},
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "orders-prod",
      instanceId,
      maxConcurrent: extra.maxConcurrent ?? 1,
      maxQueued: extra.maxQueued ?? 2,
      maxQueuedPerThread: extra.maxQueued ?? 2,
      leaseMs: 100,
      ...coordinatorPolicy,
      compatibility: {
        protocolVersion: extra.protocolVersion ?? 1,
        protocolFingerprint: "a".repeat(64),
        configurationFingerprint: extra.configurationFingerprint ?? "b".repeat(64),
      },
    },
    { now, failClosed: extra.failClosed },
  );
}

function request(requestId: string, threadId = "thread-1", bindingHash = hash) {
  return { requestId, threadId, source, bindingHash };
}

afterEach(resetInMemoryDistributedCoordination);

describe("distributed turn coordinator", () => {
  test("derives every persisted migration checksum from its immutable SQL", () => {
    for (const migration of POSTGRES_COORDINATION_MIGRATIONS) {
      expect(new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex")).toBe(
        migration.checksum,
      );
    }
  });

  test("joins an exact duplicate but rejects a changed canonical binding", async () => {
    const coordinator = replica("instance-a", () => 1);
    expect(await coordinator.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("request-1"))).toEqual({
      status: "joined",
      state: "queued",
    });
    expect(await coordinator.admit(request("request-1", "thread-2"))).toEqual({
      status: "conflict",
    });
    expect(await coordinator.admit(request("request-1", "thread-1", "a".repeat(32)))).toEqual({
      status: "conflict",
    });
  });

  test("rejects mixed protocol or configuration before mutating namespace state", async () => {
    const first = replica("instance-a", () => 1);
    expect(await first.admit(request("request-1"))).toEqual({ status: "admitted" });

    const changedProtocol = replica("instance-b", () => 1, { protocolVersion: 2 });
    expect(await changedProtocol.admit(request("request-2"))).toEqual({ status: "unavailable" });

    const changedConfiguration = replica("instance-c", () => 1, {
      configurationFingerprint: "c".repeat(64),
    });
    expect(await changedConfiguration.admit(request("request-2"))).toEqual({
      status: "unavailable",
    });

    expect(await first.admit(request("request-2"))).toEqual({ status: "admitted" });
  });

  test("enforces one active turn per thread across replicas and fences later attempts", async () => {
    const now = 1;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await first.admit(request("request-1"));
    const claimed = await first.claim(request("request-1"));
    expect(claimed.status).toBe("acquired");
    expect(await second.claim(request("request-1"))).toEqual({ status: "waiting" });
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    expect(await first.complete(claimed.lease)).toEqual({ status: "ok" });
    await second.admit(request("request-2"));
    const later = await second.claim(request("request-2"));
    expect(later.status).toBe("acquired");
    if (later.status !== "acquired") throw new Error("expected acquisition");
    expect(later.lease.fence).toBeGreaterThan(claimed.lease.fence);
    expect(await first.heartbeat(claimed.lease)).toEqual({ status: "stale" });
  });

  test("never admits two active requests for one thread even with spare global capacity", async () => {
    const now = 1;
    const first = replica("instance-a", () => now, { maxConcurrent: 2, maxQueued: 2 });
    const second = replica("instance-b", () => now, { maxConcurrent: 2, maxQueued: 2 });
    await first.admit(request("request-1"));
    const active = await first.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    await second.admit(request("request-2"));
    expect(await second.claim(request("request-2"))).toEqual({ status: "waiting" });
  });

  test("bounds global and source queues without a process-local bypass", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 1 });
    expect(await coordinator.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
    const sourceBound = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "source-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 4,
        maxQueuedPerThread: 2,
        leaseMs: 100,
        ...coordinatorPolicy,
      },
      { now: () => 1 },
    );
    await sourceBound.admit({
      ...request("request-3", "thread-3"),
      source: { ...source, maxQueued: 1 },
    });
    expect(
      await sourceBound.admit({
        ...request("request-4", "thread-4"),
        source: { ...source, maxQueued: 1 },
      }),
    ).toEqual({ status: "rejected", reason: "source-capacity" });
  });

  test("allows one direct admission when waiting capacity is zero, then rejects a waiter", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 0 });
    expect(await coordinator.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
  });

  test("fails closed on namespace policy drift without mutating the established limits", async () => {
    const restrictive = replica("instance-a", () => 1, { maxConcurrent: 1, maxQueued: 1 });
    const permissive = replica("instance-b", () => 1, { maxConcurrent: 10, maxQueued: 10 });
    const wideSource = { id: "web", maxConcurrent: 10, maxQueued: 10 };
    await restrictive.admit({ ...request("request-1"), source: wideSource });
    const active = await restrictive.claim({ ...request("request-1"), source: wideSource });
    if (active.status !== "acquired") throw new Error("expected acquisition");
    expect(
      await permissive.admit({ ...request("request-2", "thread-2"), source: wideSource }),
    ).toEqual({ status: "unavailable" });
    expect(
      await restrictive.admit({ ...request("request-3", "thread-3"), source: wideSource }),
    ).toEqual({ status: "admitted" });
  });

  test("claims the earliest eligible thread head even when a newer replica polls first", async () => {
    let now = 1;
    const first = replica("instance-a", () => now++, { maxConcurrent: 2, maxQueued: 3 });
    const second = replica("instance-b", () => now++, { maxConcurrent: 2, maxQueued: 3 });
    const wideSource = { id: "web", maxConcurrent: 2, maxQueued: 3 };
    const older = { ...request("older", "thread-older"), source: wideSource };
    const newer = { ...request("newer", "thread-newer"), source: wideSource };
    await first.admit(older);
    await second.admit(newer);
    expect(await second.claim(newer)).toEqual({ status: "waiting" });
    expect((await first.claim(older)).status).toBe("acquired");
  });

  test("does not let a source-saturated queue head block another runnable source", async () => {
    let now = 1;
    const coordinator = replica("instance-a", () => now++, {
      maxConcurrent: 2,
      maxQueued: 4,
    });
    const sourceA = { id: "source-a", maxConcurrent: 1, maxQueued: 4 };
    const sourceB = { id: "source-b", maxConcurrent: 1, maxQueued: 4 };
    const activeA = { ...request("a-active", "a-active-thread"), source: sourceA };
    const queuedA = { ...request("a-queued", "a-queued-thread"), source: sourceA };
    const queuedB = { ...request("b-queued", "b-queued-thread"), source: sourceB };
    await coordinator.admit(activeA);
    expect((await coordinator.claim(activeA)).status).toBe("acquired");
    await coordinator.admit(queuedA);
    await coordinator.admit(queuedB);

    expect((await coordinator.claim(queuedB)).status).toBe("acquired");
  });

  test("bounds pending work per thread without consuming another thread's queue budget", async () => {
    const coordinator = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "thread-cap-prod",
        instanceId: "instance-a",
        maxConcurrent: 1,
        maxQueued: 3,
        maxQueuedPerThread: 1,
        leaseMs: 100,
        ...coordinatorPolicy,
      },
      { now: () => 1 },
    );
    expect(await coordinator.admit(request("thread-first"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("thread-second"))).toEqual({
      status: "rejected",
      reason: "thread-capacity",
    });
    expect(await coordinator.admit(request("other-thread", "thread-2"))).toEqual({
      status: "admitted",
    });
  });

  test("rejects source-policy drift and releases capacity only after a fenced terminal write", async () => {
    const first = replica("instance-a", () => 1, { maxConcurrent: 2, maxQueued: 3 });
    const second = replica("instance-b", () => 1, { maxConcurrent: 2, maxQueued: 3 });
    const fixedSource = { id: "web", maxConcurrent: 1, maxQueued: 1 };
    await first.admit({
      ...request("request-1"),
      source: fixedSource,
    });
    const active = await first.claim({ ...request("request-1"), source: fixedSource });
    if (active.status !== "acquired") throw new Error("expected acquisition");
    expect(
      await second.admit({
        ...request("drifted", "thread-2"),
        source: { id: "web", maxConcurrent: 10, maxQueued: 10 },
      }),
    ).toEqual({ status: "unavailable" });
    const waiting = { ...request("request-2", "thread-2"), source: fixedSource };
    expect(await second.admit(waiting)).toEqual({ status: "admitted" });
    expect(await second.claim(waiting)).toEqual({ status: "waiting" });
    expect(await first.complete({ ...active.lease, sourceId: "other-source" })).toEqual({
      status: "stale",
    });
    expect(await first.complete(active.lease)).toEqual({ status: "ok" });
    expect((await second.claim(waiting)).status).toBe("acquired");
  });

  test("requeues an unstarted expired lease but quarantines started work until fenced recovery", async () => {
    let now = 0;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await first.admit(request("before-start"));
    const acquired = await first.claim(request("before-start"));
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    now = 101;
    const reacquired = await second.claim(request("before-start"));
    expect(reacquired.status).toBe("acquired");
    if (reacquired.status !== "acquired") throw new Error("expected reacquisition");
    expect(reacquired.lease.fence).toBeGreaterThan(acquired.lease.fence);

    await second.admit(request("after-start"));
    await second.complete(reacquired.lease);
    const started = await second.claim(request("after-start"));
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await second.markExecutionStarted(started.lease)).toEqual({ status: "ok" });
    now = 202;
    expect(await first.claim(request("after-start"))).toEqual({ status: "quarantined" });
    expect(
      await first.recover(
        "thread-1",
        started.lease.fence,
        "worker was terminated after lease loss",
      ),
    ).toEqual({ status: "ok" });
  });

  test("sweeps an expired started lease during health and frees zero-queue capacity", async () => {
    let now = 0;
    const coordinator = replica("instance-a", () => now, {
      maxConcurrent: 1,
      maxQueued: 0,
    });
    const startedRequest = request("started");
    await coordinator.admit(startedRequest);
    const started = await coordinator.claim(startedRequest);
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await coordinator.markExecutionStarted(started.lease)).toEqual({ status: "ok" });

    now = 101;
    expect(await coordinator.health()).toMatchObject({
      active: 0,
      queued: 0,
      quarantined: 1,
    });
    expect(await coordinator.admit(request("same-thread"))).toEqual({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(await coordinator.admit(request("other-thread", "thread-2"))).toEqual({
      status: "admitted",
    });
  });

  test("isolates namespaces, rejects admission on a draining replica, and fails closed during outage", async () => {
    const first = replica("instance-a", () => 1);
    const other = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "concierge-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedPerThread: 1,
        leaseMs: 100,
        ...coordinatorPolicy,
      },
      { now: () => 1 },
    );
    expect(await first.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await other.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await first.setDraining(true)).toEqual({ status: "ok" });
    expect(await first.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "draining",
    });
    expect(await first.health()).toMatchObject({ status: "draining" });
    const unavailable = replica("instance-c", () => 1, { failClosed: () => true });
    expect(await unavailable.admit(request("request-3", "thread-3"))).toEqual({
      status: "unavailable",
    });
    expect(await unavailable.health()).toEqual({
      status: "unavailable",
      active: 0,
      queued: 0,
      quarantined: 0,
    });
  });
});

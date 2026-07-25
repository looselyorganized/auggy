import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";

const hash = "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY";
const source = { id: "web", maxConcurrent: 1, maxQueued: 2 };

function replica(
  instanceId: string,
  now: () => number,
  extra: Partial<{ maxConcurrent: number; maxQueued: number; failClosed: () => boolean }> = {},
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "orders-prod",
      instanceId,
      maxConcurrent: extra.maxConcurrent ?? 1,
      maxQueued: extra.maxQueued ?? 2,
      leaseMs: 100,
    },
    { now, failClosed: extra.failClosed },
  );
}

function request(requestId: string, threadId = "thread-1", bindingHash = hash) {
  return { requestId, threadId, source, bindingHash };
}

afterEach(resetInMemoryDistributedCoordination);

describe("distributed turn coordinator", () => {
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
    const sourceBound = replica("instance-b", () => 1, { maxQueued: 4 });
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

  test("treats source-policy drift as restrictive and releases capacity only after a fenced terminal write", async () => {
    const first = replica("instance-a", () => 1, { maxConcurrent: 2, maxQueued: 3 });
    const second = replica("instance-b", () => 1, { maxConcurrent: 2, maxQueued: 3 });
    await first.admit({
      ...request("request-1"),
      source: { id: "web", maxConcurrent: 1, maxQueued: 1 },
    });
    const active = await first.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    await second.admit({
      ...request("request-2", "thread-2"),
      source: { id: "web", maxConcurrent: 10, maxQueued: 10 },
    });
    expect(await second.claim(request("request-2", "thread-2"))).toEqual({ status: "waiting" });
    expect(await first.complete({ ...active.lease, sourceId: "other-source" })).toEqual({
      status: "stale",
    });
    expect(await first.complete(active.lease)).toEqual({ status: "ok" });
    expect((await second.claim(request("request-2", "thread-2"))).status).toBe("acquired");
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

  test("isolates namespaces, drains new admission, and fails closed during database outage", async () => {
    const first = replica("instance-a", () => 1);
    const other = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "concierge-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 1,
        leaseMs: 100,
      },
      { now: () => 1 },
    );
    expect(await first.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await other.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await first.setDraining(true)).toEqual({ status: "ok" });
    expect(await first.admit(request("request-2", "thread-2"))).toEqual({ status: "admitted" });
    expect(await first.claim(request("request-2", "thread-2"))).toEqual({ status: "waiting" });
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

import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import { POSTGRES_COORDINATION_MIGRATIONS } from "../../src/coordination/migrations";

const hash = "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY";
const source = { id: "web", maxConcurrent: 1, maxQueued: 2 };
const coordinatorPolicy = {
  buildFingerprint: "c".repeat(64),
  sources: [source],
  retention: {
    terminalRequestRetentionMs: 604_800_000,
    maxTerminalRequests: 10_000,
    eventRetentionMs: 2_592_000_000,
    maxEvents: 50_000,
  },
  result: { maxReplayBytes: 65_536 },
  compatibility: {
    protocolVersion: 3,
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
    leaseMs: number;
    failClosed: () => boolean;
    protocolVersion: number;
    configurationFingerprint: string;
    sources: readonly (typeof source)[];
  }> = {},
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "orders-prod",
      instanceId,
      maxConcurrent: extra.maxConcurrent ?? 1,
      maxQueued: extra.maxQueued ?? 2,
      maxQueuedPerThread: extra.maxQueued ?? 2,
      leaseMs: extra.leaseMs ?? 100,
      ...coordinatorPolicy,
      sources: extra.sources ?? coordinatorPolicy.sources,
      compatibility: {
        protocolVersion: extra.protocolVersion ?? 3,
        protocolFingerprint: "a".repeat(64),
        configurationFingerprint: extra.configurationFingerprint ?? "b".repeat(64),
      },
    },
    { now, failClosed: extra.failClosed },
  );
}

async function register(
  ...coordinators: ReturnType<typeof createInMemoryDistributedTurnCoordinator>[]
): Promise<void> {
  for (const coordinator of coordinators) {
    expect(await coordinator.register()).toEqual({ status: "registered" });
  }
}

function request(requestId: string, threadId = "thread-1", bindingHash = hash) {
  return { requestId, threadId, source, bindingHash };
}

function replay(value: unknown = { ok: true }) {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json" as const,
  };
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

  test("requires one explicit live instance incarnation before any request mutation", async () => {
    let now = 0;
    const first = replica("shared-instance", () => now);
    const collision = replica("shared-instance", () => now);

    expect(await first.admit(request("before-registration"))).toEqual({ status: "unavailable" });
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await collision.register()).toEqual({ status: "conflict" });
    expect(await collision.admit(request("collision-request"))).toEqual({
      status: "unavailable",
    });

    now = 101;
    expect(await first.heartbeatInstance()).toEqual({ status: "stale" });
    expect(await collision.register()).toEqual({ status: "conflict" });
  });

  test("keeps live queued work with its accepting replica and fences exact retry adoption", async () => {
    let now = 0;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const live = request("live-owner", "live-thread");
    expect(await first.admit(live)).toEqual({ status: "admitted" });
    expect(await second.claim(live)).toEqual({ status: "waiting" });
    expect((await first.claim(live)).status).toBe("acquired");

    const adoptable = request("adoptable", "adoptable-thread");
    expect(await first.admit(adoptable)).toEqual({ status: "admitted" });
    now = 50;
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    expect(await second.admit(adoptable)).toEqual({ status: "adopted" });
    expect(await first.heartbeatQueued(adoptable)).toEqual({ status: "stale" });
    expect(await first.abandon(adoptable)).toEqual({ status: "stale" });
    expect((await second.claim(adoptable)).status).toBe("acquired");

    expect(await second.admit(request("adoptable", "changed-thread"))).toEqual({
      status: "conflict",
    });
  });

  test("joins an exact duplicate but rejects a changed canonical binding", async () => {
    const coordinator = replica("instance-a", () => 1);
    await register(coordinator);
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
    await register(first);
    expect(await first.admit(request("request-1"))).toEqual({ status: "admitted" });

    const changedProtocol = replica("instance-b", () => 1, { protocolVersion: 4 });
    expect(await changedProtocol.register()).toEqual({ status: "unavailable" });

    const changedConfiguration = replica("instance-c", () => 1, {
      configurationFingerprint: "c".repeat(64),
    });
    expect(await changedConfiguration.register()).toEqual({
      status: "unavailable",
    });
    const changedLease = replica("instance-d", () => 1, { leaseMs: 200 });
    expect(await changedLease.register()).toEqual({ status: "unavailable" });

    expect(await first.admit(request("request-2"))).toEqual({ status: "admitted" });
  });

  test("enforces one active turn per thread across replicas and fences later attempts", async () => {
    const now = 1;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await register(first, second);
    await first.admit(request("request-1"));
    const claimed = await first.claim(request("request-1"));
    expect(claimed.status).toBe("acquired");
    expect(await second.claim(request("request-1"))).toEqual({ status: "waiting" });
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    expect(await first.complete(claimed.lease, replay())).toEqual({ status: "ok" });
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
    await register(first, second);
    await first.admit(request("request-1"));
    const active = await first.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    await second.admit(request("request-2"));
    expect(await second.claim(request("request-2"))).toEqual({ status: "waiting" });
  });

  test("bounds global and source queues without a process-local bypass", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 1 });
    await register(coordinator);
    expect(await coordinator.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
    const boundedSource = { ...source, maxQueued: 1 };
    const sourceBound = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "source-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 4,
        maxQueuedPerThread: 2,
        leaseMs: 100,
        ...coordinatorPolicy,
        sources: [boundedSource],
      },
      { now: () => 1 },
    );
    await register(sourceBound);
    await sourceBound.admit({
      ...request("request-3", "thread-3"),
      source: boundedSource,
    });
    expect(
      await sourceBound.admit({
        ...request("request-4", "thread-4"),
        source: boundedSource,
      }),
    ).toEqual({ status: "rejected", reason: "source-capacity" });
  });

  test("allows one direct admission when waiting capacity is zero, then rejects a waiter", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 0 });
    await register(coordinator);
    expect(await coordinator.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
  });

  test("fails closed on namespace policy drift without mutating the established limits", async () => {
    const restrictive = replica("instance-a", () => 1, { maxConcurrent: 1, maxQueued: 1 });
    const permissive = replica("instance-b", () => 1, { maxConcurrent: 10, maxQueued: 10 });
    await register(restrictive);
    expect(await permissive.register()).toEqual({ status: "unavailable" });
    await restrictive.admit(request("request-1"));
    const active = await restrictive.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    expect(await permissive.admit(request("request-2", "thread-2"))).toEqual({
      status: "unavailable",
    });
    expect(await restrictive.admit(request("request-3", "thread-3"))).toEqual({
      status: "admitted",
    });
  });

  test("claims the earliest eligible thread head even when a newer replica polls first", async () => {
    let now = 1;
    const wideSource = { id: "web", maxConcurrent: 2, maxQueued: 3 };
    const first = replica("instance-a", () => now++, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [wideSource],
    });
    const second = replica("instance-b", () => now++, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [wideSource],
    });
    await register(first, second);
    const older = { ...request("older", "thread-older"), source: wideSource };
    const newer = { ...request("newer", "thread-newer"), source: wideSource };
    await first.admit(older);
    await second.admit(newer);
    expect(await second.claim(newer)).toEqual({ status: "waiting" });
    expect((await first.claim(older)).status).toBe("acquired");
  });

  test("does not let a source-saturated queue head block another runnable source", async () => {
    let now = 1;
    const sourceA = { id: "source-a", maxConcurrent: 1, maxQueued: 4 };
    const sourceB = { id: "source-b", maxConcurrent: 1, maxQueued: 4 };
    const coordinator = replica("instance-a", () => now++, {
      maxConcurrent: 2,
      maxQueued: 4,
      sources: [sourceA, sourceB],
    });
    await register(coordinator);
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
    await register(coordinator);
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
    const fixedSource = { id: "web", maxConcurrent: 1, maxQueued: 1 };
    const first = replica("instance-a", () => 1, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [fixedSource],
    });
    const second = replica("instance-b", () => 1, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [fixedSource],
    });
    await register(first, second);
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
    expect(await first.complete({ ...active.lease, sourceId: "other-source" }, replay())).toEqual({
      status: "stale",
    });
    expect(await first.complete(active.lease, replay())).toEqual({ status: "ok" });
    expect((await second.claim(waiting)).status).toBe("acquired");
  });

  test("requeues an unstarted expired lease but quarantines started work until fenced recovery", async () => {
    let now = 0;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await register(first, second);
    await first.admit(request("before-start"));
    const acquired = await first.claim(request("before-start"));
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    now = 50;
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    const reacquired = await second.claim(request("before-start"));
    expect(reacquired.status).toBe("acquired");
    if (reacquired.status !== "acquired") throw new Error("expected reacquisition");
    expect(reacquired.lease.fence).toBeGreaterThan(acquired.lease.fence);

    await second.admit(request("after-start"));
    await second.complete(reacquired.lease, replay());
    const started = await second.claim(request("after-start"));
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await second.markExecutionStarted(started.lease)).toEqual({ status: "ok" });
    now = 149;
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 202;
    expect(await second.claim(request("after-start"))).toEqual({ status: "quarantined" });
    expect(
      await second.recover("thread-1", started.lease.fence, "worker-terminated-after-lease-loss"),
    ).toEqual({ status: "ok" });
  });

  test("turns post-start failure into outcome-unknown quarantine before releasing a thread", async () => {
    const first = replica("instance-a", () => 1);
    const second = replica("instance-b", () => 1);
    await register(first, second);
    const effecting = request("effecting", "effect-thread");
    expect(await first.admit(effecting)).toEqual({ status: "admitted" });
    const claimed = await first.claim(effecting);
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    expect(await first.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    expect(await first.fail(claimed.lease)).toEqual({ status: "outcome-unknown" });
    expect(await second.claim(effecting)).toEqual({ status: "quarantined" });
    expect(await second.admit(request("later-effect", "effect-thread"))).toEqual({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(
      await second.recover("effect-thread", claimed.lease.fence, "execution-failed-after-start"),
    ).toEqual({ status: "ok" });
  });

  test("replays bounded terminal results only for the exact canonical binding", async () => {
    const first = replica("instance-a", () => 1);
    const second = replica("instance-b", () => 1);
    await register(first, second);
    const completed = request("result-request", "result-thread");
    await first.admit(completed);
    const claimed = await first.claim(completed);
    if (claimed.status !== "acquired") throw new Error("expected result lease");

    const exactBody = JSON.stringify("a".repeat(coordinatorPolicy.result.maxReplayBytes - 2));
    const exactResult = replay(JSON.parse(exactBody));
    expect(exactResult.body.byteLength).toBe(coordinatorPolicy.result.maxReplayBytes);
    expect(await first.complete(claimed.lease, exactResult)).toEqual({ status: "ok" });
    const status = await second.status(completed);
    expect(status).toEqual({ status: "completed", result: exactResult });
    if (status.status !== "completed") throw new Error("expected replay");
    status.result.body[0] = 0;
    expect(await second.status(completed)).toEqual({ status: "completed", result: exactResult });
    expect(await second.status({ ...completed, threadId: "changed-thread" })).toEqual({
      status: "conflict",
    });
    expect(await second.wait(completed, { timeoutMs: 0, pollMs: 10 })).toEqual({
      status: "completed",
      result: exactResult,
    });

    const oversized = request("oversized-result", "oversized-thread");
    await first.admit(oversized);
    const oversizedLease = await first.claim(oversized);
    if (oversizedLease.status !== "acquired") throw new Error("expected oversized lease");
    expect(
      await first.complete(
        oversizedLease.lease,
        replay("é".repeat(coordinatorPolicy.result.maxReplayBytes / 2)),
      ),
    ).toEqual({ status: "rejected", reason: "result-too-large" });
    expect(await second.status(oversized)).toEqual({ status: "pending", state: "active" });
    expect(await first.complete(oversizedLease.lease, replay({ smaller: true }))).toEqual({
      status: "ok",
    });

    const pending = request("aborted-wait", "aborted-thread");
    await first.admit(pending);
    const abort = new AbortController();
    abort.abort();
    expect(
      await second.wait(pending, { timeoutMs: 1_000, pollMs: 10, signal: abort.signal }),
    ).toEqual({
      status: "wait-aborted",
    });
  });

  test("cancels locally owned work on queue loss, coordinator loss, and close", async () => {
    const now = 0;
    let unavailable = false;
    const coordinator = replica("instance-a", () => now, {
      failClosed: () => unavailable,
    });
    await register(coordinator);

    const queued = request("queued-signal", "queued-signal-thread");
    expect(await coordinator.admit(queued)).toEqual({ status: "admitted" });
    const queuedSignal = coordinator.ownedSignal(queued);
    expect(queuedSignal.aborted).toBeFalse();
    expect(await coordinator.beginDrain()).toEqual({ status: "ok" });
    expect(queuedSignal.aborted).toBeTrue();
    expect(queuedSignal.reason).toBe("draining");

    resetInMemoryDistributedCoordination();
    const activeCoordinator = replica("instance-b", () => now, {
      failClosed: () => unavailable,
    });
    await register(activeCoordinator);
    const active = request("active-signal", "active-signal-thread");
    await activeCoordinator.admit(active);
    const claimed = await activeCoordinator.claim(active);
    if (claimed.status !== "acquired") throw new Error("expected active signal lease");
    const activeSignal = activeCoordinator.ownedSignal(active);
    expect(activeSignal.aborted).toBeFalse();
    unavailable = true;
    expect(await activeCoordinator.heartbeatInstance()).toEqual({ status: "unavailable" });
    expect(activeSignal.aborted).toBeTrue();
    expect(activeSignal.reason).toBe("coordinator-authority-lost");

    unavailable = false;
    resetInMemoryDistributedCoordination();
    const failing = replica("instance-failure", () => now, {
      failClosed: () => unavailable,
    });
    await register(failing);
    const unsettled = request("unavailable-failure", "unavailable-failure-thread");
    await failing.admit(unsettled);
    const unsettledLease = await failing.claim(unsettled);
    if (unsettledLease.status !== "acquired") throw new Error("expected unsettled lease");
    const unsettledSignal = failing.ownedSignal(unsettled);
    unavailable = true;
    expect(await failing.fail(unsettledLease.lease)).toEqual({ status: "unavailable" });
    expect(unsettledSignal.aborted).toBeTrue();
    expect(unsettledSignal.reason).toBe("coordinator-authority-lost");

    unavailable = false;
    resetInMemoryDistributedCoordination();
    const closing = replica("instance-c", () => now);
    await register(closing);
    const closingRequest = request("closing-signal", "closing-thread");
    await closing.admit(closingRequest);
    const closingSignal = closing.ownedSignal(closingRequest);
    await closing.close();
    expect(closingSignal.aborted).toBeTrue();
    expect(closingSignal.reason).toBe("coordinator-closed");
  });

  test("sweeps an expired started lease during health and frees zero-queue capacity", async () => {
    let now = 0;
    const coordinator = replica("instance-a", () => now, {
      maxConcurrent: 1,
      maxQueued: 0,
    });
    await register(coordinator);
    const startedRequest = request("started");
    await coordinator.admit(startedRequest);
    const started = await coordinator.claim(startedRequest);
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await coordinator.markExecutionStarted(started.lease)).toEqual({ status: "ok" });

    now = 50;
    expect(await coordinator.heartbeatInstance()).toEqual({ status: "ok" });
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

  test("bounds replay and events while preserving unresolved incidents and monotonic fences", async () => {
    let now = 0;
    const coordinator = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "retention-prod",
        instanceId: "retention-replica",
        maxConcurrent: 1,
        maxQueued: 2,
        maxQueuedPerThread: 2,
        leaseMs: 200_000,
        ...coordinatorPolicy,
        retention: {
          terminalRequestRetentionMs: 60_000,
          maxTerminalRequests: 2,
          eventRetentionMs: 60_000,
          maxEvents: 1,
        },
      },
      { now: () => now },
    );
    await register(coordinator);

    let firstFence = 0;
    for (const [index, [requestId, threadId]] of (
      [
        ["retained-first", "reused-thread"],
        ["retained-second", "retained-thread-2"],
        ["retained-third", "retained-thread-3"],
      ] as const
    ).entries()) {
      now = index;
      const item = request(requestId, threadId);
      expect(await coordinator.admit(item)).toEqual({ status: "admitted" });
      const claimed = await coordinator.claim(item);
      if (claimed.status !== "acquired") throw new Error("expected retention lease");
      if (index === 0) firstFence = claimed.lease.fence;
      expect(await coordinator.complete(claimed.lease, replay({ requestId }))).toEqual({
        status: "ok",
      });
    }

    now = 3;
    const unknown = request("unknown-incident", "unknown-thread");
    expect(await coordinator.admit(unknown)).toEqual({ status: "admitted" });
    const unknownLease = await coordinator.claim(unknown);
    if (unknownLease.status !== "acquired") throw new Error("expected incident lease");
    expect(await coordinator.markExecutionStarted(unknownLease.lease)).toEqual({ status: "ok" });
    expect(await coordinator.fail(unknownLease.lease)).toEqual({ status: "outcome-unknown" });

    now = 59_000;
    expect(await coordinator.heartbeatInstance()).toEqual({ status: "ok" });
    now = 60_003;
    expect(await coordinator.prune(1)).toEqual({
      status: "ok",
      events: 0,
      instances: 0,
      requests: 1,
      threads: 1,
    });
    expect(await coordinator.status(request("retained-first", "reused-thread"))).toEqual({
      status: "missing",
    });
    expect(await coordinator.status(unknown)).toEqual({ status: "quarantined" });
    expect(await coordinator.events({ limit: 1 })).toMatchObject({
      status: "ok",
      events: [{ eventType: "outcome_unknown", requestId: unknown.requestId }],
    });
    expect(await coordinator.events({ afterEventId: "01", limit: 1 })).toEqual({
      status: "unavailable",
    });

    expect(
      await coordinator.recover(unknown.threadId, unknownLease.lease.fence, "operator-reconciled"),
    ).toEqual({ status: "ok" });
    expect(await coordinator.status(unknown)).toEqual({ status: "terminal", state: "failed" });
    const firstPage = await coordinator.events({ limit: 1 });
    if (firstPage.status !== "ok") throw new Error("expected event page");
    expect(firstPage.events[0]?.eventType).toBe("outcome_unknown");
    if (!firstPage.nextEventId) throw new Error("expected event cursor");
    const secondPage = await coordinator.events({
      afterEventId: firstPage.nextEventId,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      status: "ok",
      events: [{ eventType: "operator_recovery", requestId: unknown.requestId }],
    });

    const reused = request("reused-after-prune", "reused-thread");
    expect(await coordinator.admit(reused)).toEqual({ status: "admitted" });
    const reusedLease = await coordinator.claim(reused);
    if (reusedLease.status !== "acquired") throw new Error("expected reused thread lease");
    expect(reusedLease.lease.fence).toBeGreaterThan(firstFence);
    expect(await coordinator.complete(reusedLease.lease, replay())).toEqual({ status: "ok" });

    now = 120_004;
    expect(await coordinator.prune(1)).toMatchObject({
      status: "ok",
      events: 1,
      requests: 1,
    });
    expect(await coordinator.events({ limit: 10 })).toMatchObject({
      status: "ok",
      events: [{ eventType: "operator_recovery" }],
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
    await register(first, other);
    expect(await first.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await other.admit(request("request-1"))).toEqual({ status: "admitted" });
    expect(await first.beginDrain()).toEqual({ status: "ok" });
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

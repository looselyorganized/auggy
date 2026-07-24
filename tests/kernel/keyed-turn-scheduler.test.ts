import { describe, expect, test } from "bun:test";
import {
  createKeyedTurnScheduler,
  type ScheduledRunResult,
} from "../../src/kernel/keyed-turn-scheduler";

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type DeferredVoid = ReturnType<typeof deferred<void>>;

const source = {
  id: "web",
  maxConcurrent: 4,
  maxQueued: 50,
} as const;

function expectValue<T>(result: ScheduledRunResult<T>): T {
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(`expected completion, got ${result.status}`);
  return result.value;
}

describe("keyed turn scheduler", () => {
  test("serializes one thread while unrelated threads use global capacity", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 2,
      maxQueued: 10,
      maxQueuedPerKey: 10,
      maxCausalDepth: 4,
    });
    const releaseA = deferred();
    const releaseB = deferred();
    const releaseA2 = deferred();
    const startedA = deferred();
    const startedB = deferred();
    const startedA2 = deferred();
    let didStartA2 = false;

    const a1 = scheduler.submit({ key: "a", source }, async () => {
      startedA.resolve();
      await releaseA.promise;
      return "a1";
    });
    await startedA.promise;
    const a2 = scheduler.submit({ key: "a", source }, async () => {
      didStartA2 = true;
      startedA2.resolve();
      await releaseA2.promise;
      return "a2";
    });
    const b1 = scheduler.submit({ key: "b", source }, async () => {
      startedB.resolve();
      await releaseB.promise;
      return "b1";
    });

    await startedB.promise;
    expect(scheduler.snapshot()).toMatchObject({
      activeTurns: 2,
      activeThreads: 2,
      queuedTurns: 1,
      queuedThreads: 1,
    });
    expect(didStartA2).toBe(false);

    releaseA.resolve();
    await startedA2.promise;
    releaseA2.resolve();
    releaseB.resolve();
    expect(expectValue(await a1)).toBe("a1");
    expect(expectValue(await a2)).toBe("a2");
    expect(expectValue(await b1)).toBe("b1");
  });

  test("round-robins runnable thread queues without reordering a thread", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedPerKey: 10,
      maxCausalDepth: 4,
    });
    const releases = new Map<string, DeferredVoid>();
    const startSignals = new Map<string, DeferredVoid>();
    const started: string[] = [];
    const run = (key: string, id: string) => {
      const startSignal = deferred();
      startSignals.set(id, startSignal);
      return scheduler.submit({ key, source }, async () => {
        started.push(id);
        startSignal.resolve();
        const gate = deferred();
        releases.set(id, gate);
        await gate.promise;
        return id;
      });
    };

    const a1 = run("a", "a1");
    await startSignals.get("a1")!.promise;
    const a2 = run("a", "a2");
    const a3 = run("a", "a3");
    const b1 = run("b", "b1");
    expect(started).toEqual(["a1"]);

    releases.get("a1")!.resolve();
    await startSignals.get("b1")!.promise;
    expect(started).toEqual(["a1", "b1"]);

    releases.get("b1")!.resolve();
    await startSignals.get("a2")!.promise;
    expect(started).toEqual(["a1", "b1", "a2"]);

    releases.get("a2")!.resolve();
    await startSignals.get("a3")!.promise;
    expect(started).toEqual(["a1", "b1", "a2", "a3"]);
    releases.get("a3")!.resolve();
    await Promise.all([a1, a2, a3, b1]);
  });

  test("enforces global, per-key, and per-source pending limits", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 1,
      maxCausalDepth: 4,
    });
    const release = deferred();
    const active = scheduler.submit({ key: "a", source }, async () => {
      await release.promise;
      return "active";
    });
    await Promise.resolve();

    const queuedA = scheduler.submit({ key: "a", source }, async () => "queued-a");
    const rejectedA = await scheduler.submit({ key: "a", source }, async () => "must-not-run");
    expect(rejectedA).toMatchObject({
      status: "rejected",
      reason: "thread-capacity",
    });

    const narrowSource = { id: "telegram", maxConcurrent: 1, maxQueued: 1 } as const;
    const queuedB = scheduler.submit({ key: "b", source: narrowSource }, async () => "queued-b");
    const rejectedSource = await scheduler.submit(
      { key: "c", source: narrowSource },
      async () => "must-not-run",
    );
    expect(rejectedSource).toMatchObject({
      status: "rejected",
      reason: "source-capacity",
    });

    const rejectedGlobal = await scheduler.submit(
      { key: "d", source: { id: "link", maxConcurrent: 1, maxQueued: 50 } },
      async () => "must-not-run",
    );
    expect(rejectedGlobal).toMatchObject({
      status: "rejected",
      reason: "agent-capacity",
    });

    release.resolve();
    await Promise.all([active, queuedA, queuedB]);
  });

  test("allows immediate work when pending capacity is zero", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      maxQueuedPerKey: 0,
      maxCausalDepth: 1,
    });
    const release = deferred();
    const active = scheduler.submit(
      {
        key: "a",
        source: { id: "web", maxConcurrent: 1, maxQueued: 0 },
      },
      async () => {
        await release.promise;
        return "active";
      },
    );
    await Promise.resolve();
    const rejected = await scheduler.submit(
      {
        key: "b",
        source: { id: "web", maxConcurrent: 1, maxQueued: 0 },
      },
      async () => "must-not-run",
    );
    expect(rejected).toMatchObject({ status: "rejected", reason: "thread-capacity" });
    release.resolve();
    expect(expectValue(await active)).toBe("active");
  });

  test("rate-limits peers within one trusted source and reports retry timing", async () => {
    let now = 10_000;
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 1,
      now: () => now,
    });
    const limitedSource = {
      id: "web",
      maxConcurrent: 1,
      maxQueued: 1,
      rateLimitPerPeer: { maxPerMinute: 1 },
    } as const;
    expectValue(
      await scheduler.submit(
        { key: "a", source: limitedSource, peerId: "peer-a" },
        async () => "first",
      ),
    );
    const denied = await scheduler.submit(
      { key: "b", source: limitedSource, peerId: "peer-a" },
      async () => "must-not-run",
    );
    expect(denied).toMatchObject({
      status: "rejected",
      reason: "peer-rate-limit",
      retryAfterMs: 60_000,
    });
    expectValue(
      await scheduler.submit(
        { key: "c", source: limitedSource, peerId: "peer-b" },
        async () => "other-peer",
      ),
    );
    now += 60_001;
    expectValue(
      await scheduler.submit(
        { key: "d", source: limitedSource, peerId: "peer-a" },
        async () => "window-reset",
      ),
    );
  });

  test("removes a canceled queued turn before it can execute", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 4,
    });
    const release = deferred();
    const active = scheduler.submit({ key: "a", source }, async () => {
      await release.promise;
      return "active";
    });
    await Promise.resolve();

    const controller = new AbortController();
    let ran = false;
    const canceled = scheduler.submit({ key: "b", source, signal: controller.signal }, async () => {
      ran = true;
      return "must-not-run";
    });
    expect(scheduler.snapshot().queuedTurns).toBe(1);
    controller.abort(new DOMException("caller left", "AbortError"));
    expect(await canceled).toMatchObject({ status: "canceled" });
    expect(ran).toBe(false);
    expect(scheduler.snapshot().queuedTurns).toBe(0);

    const replacement = scheduler.submit({ key: "c", source }, async () => "replacement");
    release.resolve();
    expect(expectValue(await active)).toBe("active");
    expect(expectValue(await replacement)).toBe("replacement");
  });

  test("keeps active capacity occupied until non-cooperative work settles", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 4,
    });
    const controller = new AbortController();
    const release = deferred();
    let secondStarted = false;
    const first = scheduler.submit({ key: "a", source, signal: controller.signal }, async () => {
      await release.promise;
      return "first";
    });
    await Promise.resolve();
    const second = scheduler.submit({ key: "b", source }, async () => {
      secondStarted = true;
      return "second";
    });

    controller.abort(new DOMException("caller left", "AbortError"));
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    expect(scheduler.snapshot().activeTurns).toBe(1);
    release.resolve();
    expect(expectValue(await first)).toBe("first");
    expect(expectValue(await second)).toBe("second");
  });

  test("supports bounded causal same-thread work under the active lease", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 2,
    });
    const order: string[] = [];
    const parent = scheduler.submit({ key: "a", source }, async (lease) => {
      order.push("parent:start");
      const child = await scheduler.runCausal(lease, { key: "a" }, async (childLease) => {
        order.push("child:start");
        const grandchild = await scheduler.runCausal(
          childLease,
          { key: "a" },
          async (grandchildLease) => {
            const tooDeep = await scheduler.runCausal(
              grandchildLease,
              { key: "a" },
              async () => "must-not-run",
            );
            expect(tooDeep).toMatchObject({ status: "rejected", reason: "causal-depth" });
            return "grandchild";
          },
        );
        expect(expectValue(grandchild)).toBe("grandchild");
        order.push("child:end");
        return "child";
      });
      expect(expectValue(child)).toBe("child");
      order.push("parent:end");
      return "parent";
    });
    expect(expectValue(await parent)).toBe("parent");
    expect(order).toEqual(["parent:start", "child:start", "child:end", "parent:end"]);
    expect(scheduler.snapshot()).toMatchObject({
      activeTurns: 0,
      queuedTurns: 0,
      admitted: 3,
      rejected: 1,
      settled: 3,
    });
  });

  test("quarantines outcome-unknown threads until explicit recovery", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 2,
    });
    const first = await scheduler.submit({ key: "a", source }, async (lease) => {
      lease.quarantine();
      return "unknown";
    });
    expect(expectValue(first)).toBe("unknown");
    expect(scheduler.snapshot().quarantinedThreads).toBe(1);

    const denied = await scheduler.submit({ key: "a", source }, async () => "must-not-run");
    expect(denied).toMatchObject({ status: "rejected", reason: "thread-quarantined" });
    expect(scheduler.recover("a")).toBe(true);
    const recovered = await scheduler.submit({ key: "a", source }, async () => "recovered");
    expect(expectValue(recovered)).toBe("recovered");
  });

  test("closes admission, settles queued callers, and drains active work", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 2,
    });
    const release = deferred();
    const active = scheduler.submit({ key: "a", source }, async () => {
      await release.promise;
      return "active";
    });
    await Promise.resolve();
    const queued = scheduler.submit({ key: "b", source }, async () => "must-not-run");

    scheduler.close();
    expect(await queued).toMatchObject({ status: "rejected", reason: "runtime-stopping" });
    const later = await scheduler.submit({ key: "c", source }, async () => "must-not-run");
    expect(later).toMatchObject({ status: "rejected", reason: "runtime-stopping" });
    const draining = scheduler.drain();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    expect(expectValue(await active)).toBe("active");
    await draining;
    expect(scheduler.snapshot()).toMatchObject({
      state: "stopped",
      activeTurns: 0,
      queuedTurns: 0,
    });

    scheduler.reopen();
    const restarted = await scheduler.submit({ key: "d", source }, async () => "restarted");
    expect(expectValue(restarted)).toBe("restarted");
  });

  test("rejects invalid configuration and inconsistent source policies", async () => {
    for (const maxConcurrent of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createKeyedTurnScheduler({
          maxConcurrent,
          maxQueued: 1,
          maxQueuedPerKey: 1,
          maxCausalDepth: 1,
        }),
      ).toThrow();
    }
    expect(() =>
      createKeyedTurnScheduler({
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedPerKey: 2,
        maxCausalDepth: 1,
      }),
    ).toThrow();

    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 1,
    });
    expectValue(
      await scheduler.submit(
        { key: "a", source: { id: "web", maxConcurrent: 1, maxQueued: 1 } },
        async () => "first",
      ),
    );
    expect(() =>
      scheduler.submit(
        { key: "b", source: { id: "web", maxConcurrent: 2, maxQueued: 1 } },
        async () => "second",
      ),
    ).toThrow(/source policy/i);
  });
});

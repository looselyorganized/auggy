import { describe, expect, test } from "bun:test";
import {
  createKeyedTurnScheduler,
  type KeyedTurnLease,
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
  test("releases a local slot while distributed admission is deferred", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedPerKey: 10,
      maxCausalDepth: 4,
    });
    const resumeBlocked = deferred();
    const blockedProbe = deferred();
    const runnableStarted = deferred();
    let blockedAttempts = 0;

    const blocked = scheduler.submit(
      {
        key: "blocked-thread",
        source,
        beforeStart: async () => {
          blockedAttempts++;
          blockedProbe.resolve();
          return blockedAttempts === 1
            ? { status: "defer" as const, resume: resumeBlocked.promise }
            : { status: "ready" as const };
        },
      },
      async () => "blocked",
    );
    await blockedProbe.promise;

    const runnable = scheduler.submit({ key: "runnable-thread", source }, async () => {
      runnableStarted.resolve();
      return "runnable";
    });

    await runnableStarted.promise;
    expect(expectValue(await runnable)).toBe("runnable");
    expect(blockedAttempts).toBe(1);
    expect(scheduler.snapshot()).toMatchObject({
      activeTurns: 0,
      queuedTurns: 1,
    });

    resumeBlocked.resolve();
    expect(expectValue(await blocked)).toBe("blocked");
    expect(blockedAttempts).toBe(2);
  });

  test("never starts work when cancellation crosses an asynchronous admission probe", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 4,
    });
    const controller = new AbortController();
    const probeStarted = deferred();
    const probe = deferred<{ status: "ready" }>();
    let ran = false;
    const pending = scheduler.submit(
      {
        key: "thread",
        source,
        signal: controller.signal,
        beforeStart: async () => {
          probeStarted.resolve();
          return probe.promise;
        },
      },
      async () => {
        ran = true;
      },
    );
    await probeStarted.promise;

    controller.abort(new DOMException("caller left", "AbortError"));
    expect(await pending).toMatchObject({ status: "canceled" });
    probe.resolve({ status: "ready" });
    await Promise.resolve();

    expect(ran).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
  });

  test("fails closed when quarantine or shutdown crosses an admission probe", async () => {
    for (const action of ["quarantine", "close"] as const) {
      const scheduler = createKeyedTurnScheduler({
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedPerKey: 1,
        maxCausalDepth: 4,
      });
      const probeStarted = deferred();
      const probe = deferred<{ status: "defer"; resume: Promise<void> }>();
      const resume = deferred();
      let ran = false;
      const pending = scheduler.submit(
        {
          key: "thread",
          source,
          beforeStart: async () => {
            probeStarted.resolve();
            return probe.promise;
          },
        },
        async () => {
          ran = true;
        },
      );
      await probeStarted.promise;

      if (action === "quarantine") scheduler.quarantine("thread");
      else scheduler.close();
      expect(await pending).toMatchObject({
        status: "rejected",
        reason: action === "quarantine" ? "thread-quarantined" : "runtime-stopping",
      });
      probe.resolve({ status: "defer", resume: resume.promise });
      resume.resolve();
      await Promise.resolve();

      expect(ran).toBe(false);
      expect(scheduler.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
      if (action === "close") await scheduler.drain();
    }
  });

  test("dispatches unrelated queued work after quarantining a pending probe", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 4,
    });
    const probeStarted = deferred();
    const probe = deferred<{ status: "ready" }>();
    const blocked = scheduler.submit(
      {
        key: "blocked",
        source,
        beforeStart: async () => {
          probeStarted.resolve();
          return probe.promise;
        },
      },
      async () => "must-not-run",
    );
    await probeStarted.promise;
    const unrelated = scheduler.submit({ key: "unrelated", source }, async () => "ran");

    scheduler.quarantine("blocked");
    expect(await blocked).toMatchObject({ status: "rejected", reason: "thread-quarantined" });
    expect(expectValue(await unrelated)).toBe("ran");
    probe.resolve({ status: "ready" });
  });

  test("wakes a same-thread successor when a deferred head is canceled or its resume rejects", async () => {
    for (const outcome of ["cancel", "reject"] as const) {
      const scheduler = createKeyedTurnScheduler({
        maxConcurrent: 1,
        maxQueued: 2,
        maxQueuedPerKey: 2,
        maxCausalDepth: 4,
      });
      const controller = new AbortController();
      const deferredOnce = deferred();
      const resume = deferred();
      let probes = 0;
      const head = scheduler.submit(
        {
          key: "thread",
          source,
          signal: controller.signal,
          beforeStart: async () => {
            probes++;
            if (probes === 1) {
              deferredOnce.resolve();
              return { status: "defer" as const, resume: resume.promise };
            }
            return { status: "ready" as const };
          },
        },
        async () => "head",
      );
      await deferredOnce.promise;
      for (let index = 0; index < 10 && scheduler.snapshot().queuedTurns !== 1; index++) {
        await Promise.resolve();
      }
      expect(scheduler.snapshot().queuedTurns).toBe(1);
      const tail = scheduler.submit({ key: "thread", source }, async () => "tail");

      if (outcome === "cancel") controller.abort(new DOMException("canceled", "AbortError"));
      else resume.reject(new Error("claim poll failed"));
      if (outcome === "cancel") expect(await head).toMatchObject({ status: "canceled" });
      else await expect(head).rejects.toThrow("claim poll failed");
      expect(expectValue(await tail)).toBe("tail");

      if (outcome === "cancel") resume.reject(new Error("late rejection"));
      await Promise.resolve();
      expect(scheduler.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
    }
  });

  test("reserves a deferred probe position ahead of newer work", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 4,
    });
    const probeStarted = deferred();
    const probe = deferred<{ status: "defer"; resume: Promise<void> }>();
    const resume = deferred();
    let attempts = 0;
    const oldest = scheduler.submit(
      {
        key: "thread",
        source: { ...source, maxQueued: 1 },
        beforeStart: async () => {
          attempts++;
          if (attempts === 1) {
            probeStarted.resolve();
            return probe.promise;
          }
          return { status: "ready" as const };
        },
      },
      async () => "oldest",
    );
    await probeStarted.promise;

    expect(
      await scheduler.submit(
        { key: "thread", source: { ...source, maxQueued: 1 } },
        async () => "newer",
      ),
    ).toMatchObject({ status: "rejected", reason: "thread-capacity" });
    probe.resolve({ status: "defer", resume: resume.promise });
    await Promise.resolve();
    resume.resolve();
    expect(expectValue(await oldest)).toBe("oldest");
  });

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

  test("exposes frozen aggregate metrics without thread or peer identifiers", async () => {
    let now = 1_000;
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 1,
      now: () => now,
    });
    const release = deferred();
    const active = scheduler.submit(
      { key: "secret-thread", source, peerId: "secret-peer" },
      async () => {
        await release.promise;
        return "active";
      },
    );
    await Promise.resolve();
    const queued = scheduler.submit(
      { key: "other-secret-thread", source, peerId: "other-secret-peer" },
      async () => "queued",
    );
    now += 250;
    const snapshot = scheduler.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.oldestQueueWaitMs).toBe(250);
    expect(snapshot.queueWait).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    release.resolve();
    await Promise.all([active, queued]);
    expect(scheduler.snapshot().queueWait).toEqual({ count: 1, totalMs: 250, maxMs: 250 });
  });

  test("counts admission rejections by a fixed reason without identifier labels", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 0,
      maxQueuedPerKey: 0,
      maxCausalDepth: 1,
    });
    const release = deferred();
    const active = scheduler.submit({ key: "secret-active", source }, async () => {
      await release.promise;
    });
    await Promise.resolve();
    await scheduler.submit({ key: "secret-rejected", source }, async () => undefined);

    const snapshot = scheduler.snapshot();
    expect(snapshot.rejectedByReason).toMatchObject({ "thread-capacity": 1 });
    expect(Object.keys(snapshot.rejectedByReason).sort()).toEqual(
      [
        "agent-capacity",
        "causal-concurrency",
        "causal-context-expired",
        "causal-depth",
        "causal-thread-mismatch",
        "peer-rate-limit",
        "runtime-stopping",
        "source-capacity",
        "thread-capacity",
        "thread-quarantined",
      ].sort(),
    );
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    release.resolve();
    await active;
  });

  test("keeps operational wait fields finite when a clock is invalid", async () => {
    let now = 1;
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 1,
      now: () => now,
    });
    const release = deferred();
    const active = scheduler.submit({ key: "a", source }, async () => {
      await release.promise;
    });
    await Promise.resolve();
    const queued = scheduler.submit({ key: "b", source }, async () => undefined);
    now = Number.POSITIVE_INFINITY;
    expect(scheduler.snapshot().oldestQueueWaitMs).toBe(0);
    release.resolve();
    await Promise.all([active, queued]);
    expect(JSON.stringify(scheduler.snapshot())).not.toContain("null");
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

  test("detaches causal work only after an active root is quarantined", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 2,
    });
    const childStarted = deferred();
    const never = new Promise<never>(() => {});

    const root = scheduler.submit({ key: "authority-lost", source }, async (lease) => {
      expect(() => lease.detachOwnedWorkAfterAuthorityLoss()).toThrow(
        "active quarantined root lease",
      );
      void scheduler.runCausal(lease, { key: "authority-lost" }, async () => {
        childStarted.resolve();
        return never;
      });
      await childStarted.promise;
      lease.quarantine();
      lease.detachOwnedWorkAfterAuthorityLoss();
      return "unknown";
    });

    expect(expectValue(await root)).toBe("unknown");
    expect(scheduler.snapshot()).toMatchObject({
      activeTurns: 0,
      queuedTurns: 0,
      quarantinedThreads: 1,
    });
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

  test("counts a causal cross-thread attempt as a structured rejection", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 2,
    });
    const root = await scheduler.submit({ key: "a", source }, async (lease) =>
      scheduler.runCausal(lease, { key: "b" }, async () => "must-not-run"),
    );
    const nested = expectValue(root);
    expect(nested).toEqual({ status: "rejected", reason: "causal-thread-mismatch" });
    expect(scheduler.snapshot().rejectedByReason["causal-thread-mismatch"]).toBe(1);
  });

  test("rejects concurrent causal siblings instead of violating thread serialization", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 2,
    });
    const childStarted = deferred();
    const releaseChild = deferred();
    let siblingExecuted = false;

    const parent = scheduler.submit({ key: "a", source }, async (lease) => {
      const child = scheduler.runCausal(lease, { key: "a" }, async () => {
        childStarted.resolve();
        await releaseChild.promise;
        return "child";
      });
      await childStarted.promise;
      const sibling = await scheduler.runCausal(lease, { key: "a" }, async () => {
        siblingExecuted = true;
        return "sibling";
      });
      expect(sibling).toMatchObject({
        status: "rejected",
        reason: "causal-concurrency",
      });
      releaseChild.resolve();
      expect(expectValue(await child)).toBe("child");
      return "parent";
    });

    expect(expectValue(await parent)).toBe("parent");
    expect(siblingExecuted).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({
      admitted: 2,
      rejected: 1,
      settled: 2,
    });
  });

  test("owns detached causal descendants until they settle and preserves quarantine", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerKey: 2,
      maxCausalDepth: 3,
    });
    const childStarted = deferred();
    const grandchildStarted = deferred();
    const releaseGrandchild = deferred();
    let parentSettled = false;
    let successorExecuted = false;

    const parent = scheduler.submit({ key: "a", source }, async (lease) => {
      void scheduler.runCausal(lease, { key: "a" }, async (childLease) => {
        childStarted.resolve();
        void scheduler.runCausal(childLease, { key: "a" }, async (grandchildLease) => {
          grandchildStarted.resolve();
          await releaseGrandchild.promise;
          grandchildLease.quarantine();
          return "grandchild";
        });
        return "child";
      });
      await childStarted.promise;
      return "parent";
    });
    void parent.then(() => {
      parentSettled = true;
    });
    await grandchildStarted.promise;

    const successor = scheduler.submit({ key: "a", source }, async () => {
      successorExecuted = true;
      return "successor";
    });
    await Promise.resolve();
    expect(parentSettled).toBe(false);
    expect(successorExecuted).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({
      activeTurns: 1,
      activeThreads: 1,
      queuedTurns: 1,
    });

    releaseGrandchild.resolve();
    expect(expectValue(await parent)).toBe("parent");
    expect(await successor).toMatchObject({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(successorExecuted).toBe(false);
    expect(scheduler.snapshot().quarantinedThreads).toBe(1);
  });

  test("revokes a child lease when that exact causal execution settles", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 3,
    });
    let staleLease: KeyedTurnLease | undefined;
    let staleTaskExecuted = false;

    const parent = scheduler.submit({ key: "a", source }, async (rootLease) => {
      const child = await scheduler.runCausal(rootLease, { key: "a" }, async (childLease) => {
        staleLease = childLease;
        return "child";
      });
      expect(expectValue(child)).toBe("child");
      await expect(
        scheduler.runCausal(staleLease!, { key: "a" }, async () => {
          staleTaskExecuted = true;
          return "must-not-run";
        }),
      ).rejects.toThrow("invalid, inactive");
      return "parent";
    });

    expect(expectValue(await parent)).toBe("parent");
    expect(staleTaskExecuted).toBe(false);
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
    scheduler.close();
    await scheduler.drain();
    scheduler.reopen();
    const deniedAfterRestart = await scheduler.submit(
      { key: "a", source },
      async () => "must-not-run",
    );
    expect(deniedAfterRestart).toMatchObject({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(scheduler.recover("a")).toBe(true);
    const recovered = await scheduler.submit({ key: "a", source }, async () => "recovered");
    expect(expectValue(recovered)).toBe("recovered");
  });

  test("restores a durable quarantine before work is admitted", async () => {
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 2,
    });
    expect(scheduler.quarantine("restored-thread")).toBe(true);
    expect(scheduler.quarantine("restored-thread")).toBe(false);
    let executed = false;
    expect(
      await scheduler.submit({ key: "restored-thread", source }, async () => {
        executed = true;
      }),
    ).toMatchObject({ status: "rejected", reason: "thread-quarantined" });
    expect(executed).toBe(false);
    expect(scheduler.recover("restored-thread")).toBe(true);
    expect(
      expectValue(
        await scheduler.submit({ key: "restored-thread", source }, async () => "allowed"),
      ),
    ).toBe("allowed");
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

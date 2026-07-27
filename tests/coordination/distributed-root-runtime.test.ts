import { afterEach, describe, expect, test } from "bun:test";
import {
  createCanonicalDistributedTurnRequest,
  createDistributedRootTurnRuntime,
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import { createKeyedTurnScheduler } from "../../src/kernel/keyed-turn-scheduler";
import type { DistributedTurnCoordinator } from "../../src/coordination/types";
import type { TurnTrigger } from "../../src/types";

const source = { id: "web", maxConcurrent: 2, maxQueued: 10 } as const;

function coordinator(instanceId: string, now: () => number = () => 1, leaseMs = 1_000) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "root-runtime",
      instanceId,
      buildFingerprint: "c".repeat(64),
      maxConcurrent: 2,
      maxQueued: 10,
      maxQueuedPerThread: 10,
      leaseMs,
      sources: [source],
      retention: {
        terminalRequestRetentionMs: 60_000,
        maxTerminalRequests: 100,
        eventRetentionMs: 60_000,
        maxEvents: 100,
      },
      result: { maxReplayBytes: 65_536 },
      turnState: {
        history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 1_000 },
        maxCostMarkersPerTurn: 32,
        outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 1_000 },
      },
      compatibility: {
        // This suite isolates the generic pre-v5 root runtime contract. The
        // v5 agent composition and atomic commit are covered separately.
        protocolVersion: 4,
        protocolFingerprint: "a".repeat(64),
        configurationFingerprint: "b".repeat(64),
      },
    },
    { now },
  );
}

function trigger(overrides: Partial<TurnTrigger> = {}): TurnTrigger {
  return {
    type: "message",
    turnId: "ephemeral-turn",
    threadId: "thread-1",
    timestamp: 1,
    source: "web",
    peer: {
      id: "peer-1",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
    },
    payload: {
      parts: [{ kind: "text", text: "hello" }],
      sourceAugment: "web",
      peer: null,
      timestamp: 1,
      metadata: { b: 2, a: 1 },
    },
    ...overrides,
  };
}

function replay(value: unknown) {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json" as const,
  };
}

afterEach(resetInMemoryDistributedCoordination);

describe("distributed root turn runtime", () => {
  test("canonicalizes semantic request identity while excluding ephemeral timestamps and key order", () => {
    const executionContext = {
      version: 1 as const,
      executionId: "execution-1",
      attempt: 1,
      idempotencyKeyHash: "d".repeat(64),
    };
    const first = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext,
    });
    const reordered = createCanonicalDistributedTurnRequest({
      trigger: trigger({
        turnId: "different-ephemeral-turn",
        timestamp: 999,
        payload: {
          metadata: { a: 1, b: 2 },
          timestamp: 999,
          peer: null,
          sourceAugment: "web",
          parts: [{ kind: "text", text: "hello" }],
        },
      }),
      threadId: "thread-1",
      source,
      executionContext,
    });
    expect(reordered).toEqual(first);

    const changedPeer = createCanonicalDistributedTurnRequest({
      trigger: trigger({ peer: { ...trigger().peer!, id: "peer-2" } }),
      threadId: "thread-1",
      source,
      executionContext,
    });
    const changedBody = createCanonicalDistributedTurnRequest({
      trigger: trigger({
        payload: {
          parts: [{ kind: "text", text: "changed" }],
          sourceAugment: "web",
          peer: null,
          timestamp: 1,
        },
      }),
      threadId: "thread-1",
      source,
      executionContext,
    });
    expect(changedPeer.requestId).toBe(first.requestId);
    expect(changedPeer.bindingHash).not.toBe(first.bindingHash);
    expect(changedBody.bindingHash).not.toBe(first.bindingHash);
  });

  test("fails closed on cyclic, non-normalized, and oversized request bindings", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      createCanonicalDistributedTurnRequest({
        trigger: trigger({ payload: cyclic }),
        threadId: "thread-1",
        source,
      }),
    ).toThrow("must not be cyclic");
    expect(() =>
      createCanonicalDistributedTurnRequest({
        trigger: trigger({ payload: { text: "e\u0301" } }),
        threadId: "thread-1",
        source,
      }),
    ).toThrow("NFC-normalized");
    expect(() =>
      createCanonicalDistributedTurnRequest({
        trigger: trigger({ payload: { text: "x".repeat(1_100_000) } }),
        threadId: "thread-1",
        source,
      }),
    ).toThrow("byte limits");
    expect(() =>
      createCanonicalDistributedTurnRequest({
        trigger: trigger({ payload: { nested: { text: "x".repeat(400_000) } } }),
        threadId: "thread-1",
        source,
      }),
    ).not.toThrow();
  });

  test("executes one claimed root, replays exact duplicates, and conflicts changed bindings", async () => {
    const owner = coordinator("instance-a");
    const runtime = createDistributedRootTurnRuntime({
      coordinator: owner,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      claimPollMs: 10,
      maxWaitMs: 20,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: {
        version: 1,
        executionId: "execution-1",
        attempt: 1,
        idempotencyKeyHash: "d".repeat(64),
      },
    });
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedPerKey: 10,
      maxCausalDepth: 4,
    });
    let executions = 0;

    const first = await runtime.run<{ ok: boolean }>({
      request,
      local: async (control) => {
        const scheduled = await scheduler.submit(
          { key: request.threadId, source, beforeStart: control.beforeStart },
          async () => {
            await control.ensureExecutionStarted();
            executions++;
            expect(control.executionAuthority()).toEqual({ version: 1, attempt: 1, fence: 1 });
            return { ok: true };
          },
        );
        if (scheduled.status === "completed") {
          return { status: "completed", value: scheduled.value };
        }
        return scheduled.status === "rejected"
          ? { status: "rejected", value: { ok: false } }
          : { status: "canceled" };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
    });
    expect(first).toEqual({ status: "completed", value: { ok: true } });
    expect(executions).toBe(1);

    const duplicate = await runtime.run({
      request,
      local: async () => {
        executions++;
        return { status: "completed", value: { ok: false } };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
    });
    expect(duplicate.status).toBe("replay");
    expect(executions).toBe(1);

    const conflict = await runtime.run({
      request: { ...request, bindingHash: "e".repeat(64) },
      local: async () => {
        executions++;
        return { status: "completed", value: { ok: false } };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
    });
    expect(conflict).toEqual({ status: "conflict" });
    expect(executions).toBe(1);
    await runtime.close();
  });

  test("uses the atomic outcome-unknown settlement hook after execution starts", async () => {
    const owner = coordinator("instance-a");
    let legacySettlements = 0;
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "markOutcomeUnknown") {
          return (...args: Parameters<DistributedTurnCoordinator["markOutcomeUnknown"]>) => {
            legacySettlements++;
            return target.markOutcomeUnknown(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      claimPollMs: 10,
      maxWaitMs: 20,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "execution-cost", attempt: 1 },
    });
    const settlements: string[] = [];
    const result = await runtime.run({
      request,
      local: async (control) => {
        await control.beforeStart();
        await control.ensureExecutionStarted();
        return { status: "completed", value: { ok: false } };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
      settleOutcomeUnknown: (lease, reason) => {
        settlements.push(reason);
        return owner.settleOutcomeUnknown(lease, reason, []);
      },
    });

    expect(result).toEqual({ status: "outcome-unknown" });
    expect(settlements).toEqual(["effect-outcome-unknown"]);
    expect(legacySettlements).toBe(0);
    expect(await owner.status(request)).toEqual({ status: "quarantined" });
    await runtime.close();
  });

  test("abandons an admission whose result arrives after caller cancellation", async () => {
    const owner = coordinator("instance-a", Date.now, 1_000);
    let releaseAdmission!: () => void;
    const admissionRelease = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      admissionCommitted = resolve;
    });
    let cleanupFinished!: () => void;
    const cleaned = new Promise<void>((resolve) => {
      cleanupFinished = resolve;
    });
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "admit") {
          return async (...args: Parameters<DistributedTurnCoordinator["admit"]>) => {
            const result = await target.admit(...args);
            admissionCommitted();
            await admissionRelease;
            return result;
          };
        }
        if (property === "abandon") {
          return async (...args: Parameters<DistributedTurnCoordinator["abandon"]>) => {
            const result = await target.abandon(...args);
            cleanupFinished();
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      claimPollMs: 10,
      maxWaitMs: 20,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "late-admission", attempt: 1 },
    });
    const abort = new AbortController();
    const running = runtime.run({
      request,
      signal: abort.signal,
      local: async () => {
        throw new Error("canceled admission must not reach local execution");
      },
      isSuccessful: () => false,
      commit: async () => ({ status: "unavailable" }),
    });

    await committed;
    abort.abort("caller-canceled");
    expect(await running).toEqual({ status: "unavailable" });
    releaseAdmission();
    await cleaned;
    expect(await owner.status(request)).toEqual({ status: "terminal", state: "canceled" });
    expect(await owner.health()).toMatchObject({ active: 0, queued: 0 });
    await runtime.close();
  });

  test("terminalizes a claim whose result arrives after local cancellation", async () => {
    const owner = coordinator("instance-a", Date.now, 1_000);
    let releaseClaim!: () => void;
    const claimRelease = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      claimCommitted = resolve;
    });
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (...args: Parameters<DistributedTurnCoordinator["claim"]>) => {
            const result = await target.claim(...args);
            claimCommitted();
            await claimRelease;
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
      claimPollMs: 10,
      maxWaitMs: 20,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "late-claim", attempt: 1 },
    });
    const scheduler = createKeyedTurnScheduler({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedPerKey: 1,
      maxCausalDepth: 1,
    });
    const abort = new AbortController();
    const running = runtime.run({
      request,
      signal: abort.signal,
      local: async (control) => {
        const scheduled = await scheduler.submit(
          {
            key: request.threadId,
            source,
            signal: abort.signal,
            beforeStart: control.beforeStart,
          },
          async () => {
            throw new Error("canceled work must not start");
          },
        );
        if (scheduled.status === "completed") {
          return { status: "completed", value: scheduled.value };
        }
        return scheduled.status === "rejected"
          ? { status: "rejected", value: undefined }
          : { status: "canceled" };
      },
      isSuccessful: () => false,
      commit: async () => ({ status: "unavailable" }),
    });

    await committed;
    abort.abort("caller-canceled");
    expect(await running).toEqual({ status: "terminal", state: "canceled" });
    expect(await owner.status(request)).toEqual({ status: "terminal", state: "canceled" });
    expect(scheduler.snapshot()).toMatchObject({ activeTurns: 0, queuedTurns: 0 });
    releaseClaim();
    await Promise.resolve();
    expect(await owner.health()).toMatchObject({ active: 0, queued: 0 });
    await runtime.close();
  });

  test("aborts authority on a never-resolving active heartbeat without overlapping it", async () => {
    let now = 0;
    const owner = coordinator("instance-a", () => now, 100);
    const standby = coordinator("instance-b", () => now, 100);
    await standby.register();
    let activeHeartbeatCalls = 0;
    const hanging = new Promise<never>(() => {});
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "heartbeat") {
          return () => {
            activeHeartbeatCalls++;
            return hanging;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const callbacks = new Map<number, { at: number; callback: () => void }>();
    let nextTimer = 1;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 20,
      claimPollMs: 10,
      maxWaitMs: 20,
      timers: {
        now: () => now,
        setTimeout(callback, milliseconds) {
          const id = nextTimer++;
          callbacks.set(id, { at: now + milliseconds, callback });
          return id;
        },
        clearTimeout(handle) {
          callbacks.delete(handle as number);
        },
      },
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "execution-1", attempt: 1 },
    });
    let observedAbort = false;
    let markEffectStarted!: () => void;
    const effectStarted = new Promise<void>((resolve) => {
      markEffectStarted = resolve;
    });
    const running = runtime.run({
      request,
      local: async (control) => {
        await control.beforeStart();
        await control.ensureExecutionStarted();
        markEffectStarted();
        control.signal.addEventListener("abort", () => {
          observedAbort = true;
        });
        if (!control.signal.aborted) {
          await new Promise<void>((resolve) =>
            control.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { status: "canceled" };
      },
      isSuccessful: () => false,
      commit: async () => ({ status: "unavailable" }),
    });

    const advanceTo = async (target: number) => {
      while (true) {
        const next = [...callbacks.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!next) break;
        callbacks.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    };

    // The active heartbeat begins at t=20 and never resolves. Instance
    // heartbeats continue, but the active authority deadline still fires at
    // t=100 without starting an overlapping active heartbeat.
    await effectStarted;
    await advanceTo(90);
    expect(await standby.heartbeatInstance()).toEqual({ status: "ok" });
    await advanceTo(101);
    const result = await running;

    expect(observedAbort).toBe(true);
    expect(activeHeartbeatCalls).toBe(1);
    expect(result).toEqual({ status: "outcome-unknown" });
    expect(runtime.snapshot()).toEqual({ state: "unavailable" });
    expect(await standby.status(request)).toEqual({ status: "quarantined" });
    expect(await standby.health()).toMatchObject({ status: "healthy", quarantined: 1 });
    await runtime.close();
  });

  test("keeps instance and active heartbeats alive while gracefully draining", async () => {
    const owner = coordinator("instance-a", Date.now, 100);
    const runtime = createDistributedRootTurnRuntime({
      coordinator: owner,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 20,
      claimPollMs: 10,
      maxWaitMs: 100,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "execution-1", attempt: 1 },
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = runtime.run({
      request,
      local: async (control) => {
        await control.beforeStart();
        await control.ensureExecutionStarted();
        markStarted();
        await new Promise((done) => setTimeout(done, 140));
        return { status: "completed", value: { ok: true } };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
    });
    await started;
    await runtime.beginDrain();
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(await running).toEqual({ status: "completed", value: { ok: true } });
    expect(runtime.snapshot()).toEqual({ state: "draining" });
    expect(await owner.health()).toMatchObject({ status: "draining", active: 0 });
    await runtime.close();
  });

  test("bounds a never-resolving coordinator drain and revokes local authority", async () => {
    const owner = coordinator("instance-a", Date.now, 100);
    const never = new Promise<never>(() => {});
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "beginDrain") return () => never;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 20,
      claimPollMs: 10,
      maxWaitMs: 100,
    });
    await runtime.start();

    await expect(runtime.beginDrain()).rejects.toThrow("distributed drain unavailable");
    expect(runtime.snapshot()).toEqual({ state: "unavailable" });
    await runtime.close();
  });

  test("revokes authority when a claim decision exceeds its independent deadline", async () => {
    const owner = coordinator("instance-a", Date.now, 100);
    const never = new Promise<never>(() => {});
    let claimCalls = 0;
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "claim") {
          return () => {
            claimCalls++;
            return never;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const runtime = createDistributedRootTurnRuntime({
      coordinator: wrapped,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 20,
      claimPollMs: 10,
      maxWaitMs: 100,
    });
    await runtime.start();
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext: { version: 1, executionId: "execution-1", attempt: 1 },
    });

    const result = await runtime.run({
      request,
      local: async (control) => {
        await control.beforeStart();
        return { status: "completed", value: { ok: true } };
      },
      isSuccessful: (value) => value.ok,
      commit: (lease, value) => owner.complete(lease, replay(value)),
    });

    expect(claimCalls).toBe(1);
    expect(result).toEqual({ status: "unavailable" });
    expect(runtime.snapshot()).toEqual({ state: "unavailable" });
    await runtime.close();
  });
});

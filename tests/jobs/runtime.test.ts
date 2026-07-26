import { describe, expect, it } from "bun:test";
import { emptyTrace } from "@/kernel/trace-emitter";
import {
  createDurableJobRuntime,
  DurableJobRuntimeError,
  type DurableJobRuntimeLease,
  type DurableJobRuntimeState,
  type DurableJobRuntimeStore,
  type DurableJobRuntimeSummary,
} from "@/jobs/runtime";
import type { AgentHandle, TurnResult } from "@/types";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function successfulResult(): TurnResult {
  return {
    turnId: "durable:job-1:1",
    success: true,
    status: "completed",
    response: { parts: [{ kind: "text", text: "sentinel-private-model-output" }] },
    toolCalls: [
      { name: "refund", input: { token: "sentinel-secret" }, output: "ok", durationMs: 1 },
    ],
    trace: emptyTrace({
      turnId: "durable:job-1:1",
      threadId: "order-1",
      trigger: { type: "internal", sourceAugment: "durable-jobs" },
    }),
  };
}

function lease(attempt = 1, value?: unknown): DurableJobRuntimeLease {
  return {
    job: { id: "job-1", attempt, cancelRequested: false },
    token: "lease-1",
    expiresAt: 100_000,
    payload: {
      version: 1,
      value:
        value ??
        ({
          version: 1,
          kind: "agent-turn",
          threadId: "order-1",
          prompt: "sentinel-private-order-prompt",
          correlationId: "correlation-1",
          timeoutMs: 5_000,
          maxAttempts: 2,
        } as const),
    },
  };
}

function storeWith(next: DurableJobRuntimeLease | null): {
  store: DurableJobRuntimeStore;
  calls: Array<{ method: string; input?: unknown }>;
  setState: (state: DurableJobRuntimeState) => void;
} {
  const calls: Array<{ method: string; input?: unknown }> = [];
  let state: DurableJobRuntimeState = "leased";
  const summary = (): DurableJobRuntimeSummary => ({
    id: "job-1",
    state,
    attempt: 1,
    cancelRequested: state === "canceled",
  });
  return {
    calls,
    setState(nextState) {
      state = nextState;
    },
    store: {
      claim(input) {
        calls.push({ method: "claim", input });
        const claimed = next;
        next = null;
        return claimed;
      },
      markExecutionStarted(input) {
        calls.push({ method: "markExecutionStarted", input });
        state = "running";
        return summary();
      },
      heartbeat(input) {
        calls.push({ method: "heartbeat", input });
        return summary();
      },
      releaseUnstarted(input) {
        calls.push({ method: "releaseUnstarted", input });
        state = "queued";
        return summary();
      },
      rejectUnstarted(input) {
        calls.push({ method: "rejectUnstarted", input });
        state = "failed";
        return summary();
      },
      complete(input) {
        calls.push({ method: "complete", input });
        state = "completed";
        return summary();
      },
      markOutcomeUnknown(input) {
        calls.push({ method: "markOutcomeUnknown", input });
        state = "outcome_unknown";
        return summary();
      },
      getSummary(jobId) {
        calls.push({ method: "getSummary", input: jobId });
        return summary();
      },
    },
  };
}

function runtime(
  agent: Pick<AgentHandle, "inject">,
  store: DurableJobRuntimeStore,
  overrides: Partial<Parameters<typeof createDurableJobRuntime>[0]> = {},
) {
  return createDurableJobRuntime({
    agent,
    store,
    workerId: "worker-1",
    now: () => 10_000,
    leaseMs: 3_000,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 1_000,
    setTimeout: () => Symbol("timeout"),
    clearTimeout: () => {},
    setInterval: () => Symbol("interval"),
    clearInterval: () => {},
    ...overrides,
  });
}

function timerHarness() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimeout(callback: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    setInterval(callback: () => void, ms: number): number {
      const id = nextId++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(handle: unknown): void {
      intervals.delete(handle as number);
    },
    fireNext(ms: number): void {
      const timer = [...timers.entries()].find(([, entry]) => entry.ms === ms);
      if (!timer) throw new Error(`Missing timer ${ms}`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    delays(): number[] {
      return [...timers.values()].map((timer) => timer.ms);
    },
    activeCount(): number {
      return timers.size + intervals.size;
    },
  };
}

describe("durable job runtime", () => {
  it("marks the fenced start boundary before injection and persists only bounded result metadata", async () => {
    const { store, calls } = storeWith(lease());
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(trigger, options) {
        expect(calls.map((call) => call.method)).toEqual(["claim"]);
        await options?.onExecutionStart?.();
        expect(calls.map((call) => call.method)).toEqual(["claim", "markExecutionStarted"]);
        expect(trigger).toMatchObject({
          type: "internal",
          source: "durable-jobs",
          threadId: "order-1",
          payload: { peer: null },
        });
        expect(options?.executionContext).toMatchObject({
          version: 1,
          executionId: "job-1",
          attempt: 1,
          correlationId: "correlation-1",
        });
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "completed", jobId: "job-1" });
    const serialized = JSON.stringify(calls.find((call) => call.method === "complete")?.input);
    expect(serialized).toContain('"responseCount":1');
    expect(serialized).toContain('"toolCallCount":1');
    expect(serialized).not.toContain("sentinel-private-model-output");
    expect(serialized).not.toContain("sentinel-secret");
    expect(serialized).not.toContain("sentinel-private-order-prompt");
  });

  it("retries pre-start admission failures with bounded backoff", async () => {
    const { store, calls } = storeWith(lease());
    const agent: Pick<AgentHandle, "inject"> = {
      async inject() {
        return {
          ...successfulResult(),
          success: false,
          status: "rejected",
          rejection: { reason: "source-capacity" },
        };
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "requeued", jobId: "job-1" });
    expect(calls.find((call) => call.method === "releaseUnstarted")?.input).toEqual({
      jobId: "job-1",
      token: "lease-1",
      errorCode: "admission-rejected",
      availableAt: 11_000,
    });
  });

  it("terminally rejects pre-start failures at the configured attempt bound", async () => {
    const bounded = lease(2);
    const { store, calls } = storeWith(bounded);
    const agent: Pick<AgentHandle, "inject"> = {
      async inject() {
        throw new Error("scheduler unavailable");
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "failed", jobId: "job-1" });
    expect(calls.map((call) => call.method)).toEqual(["claim", "rejectUnstarted"]);
  });

  it("returns canceled when cancellation wins the pre-start requeue race", async () => {
    const { store, setState } = storeWith(lease());
    store.releaseUnstarted = () => {
      setState("canceled");
      throw new Error("sentinel canceled lease detail");
    };
    const agent: Pick<AgentHandle, "inject"> = {
      async inject() {
        return {
          ...successfulResult(),
          success: false,
          status: "rejected",
          rejection: { reason: "agent-capacity" },
        };
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "canceled", jobId: "job-1" });
  });

  it("terminally rejects oversized malformed payloads before allocating an encoder buffer", async () => {
    const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
    if (!originalTextEncoder) throw new Error("TextEncoder descriptor is unavailable");
    let encoderCalled = false;
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: class {
        encode(): Uint8Array {
          encoderCalled = true;
          throw new Error("encoder must not be reached");
        }
      },
    });
    try {
      const oversized = lease(1, {
        version: 1,
        kind: "agent-turn",
        threadId: "order-1",
        prompt: "x".repeat(1024 * 1024),
      });
      const { store, calls } = storeWith(oversized);
      const agent: Pick<AgentHandle, "inject"> = {
        async inject() {
          throw new Error("must not execute");
        },
      };
      const worker = runtime(agent, store);
      worker.start();
      await expect(worker.processNext()).resolves.toEqual({ status: "failed", jobId: "job-1" });
      expect(encoderCalled).toBe(false);
      expect(calls.map((call) => call.method)).toEqual(["claim", "rejectUnstarted"]);
    } finally {
      Object.defineProperty(globalThis, "TextEncoder", originalTextEncoder);
    }
  });

  it("quarantines every post-start exception without a retry escape hatch", async () => {
    const { store, calls } = storeWith(lease());
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        throw new Error("sentinel-provider-detail-that-must-not-persist");
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({
      status: "outcome-unknown",
      jobId: "job-1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "claim",
      "markExecutionStarted",
      "markOutcomeUnknown",
    ]);
    expect(JSON.stringify(calls)).not.toContain("sentinel-provider-detail-that-must-not-persist");
    expect(calls.find((call) => call.method === "markOutcomeUnknown")?.input).toMatchObject({
      reasonCode: "execution-outcome-unknown",
    });
  });

  it("reports the actual durable state when completion races with cancellation", async () => {
    const { store, calls, setState } = storeWith(lease());
    store.complete = (input) => {
      calls.push({ method: "complete", input });
      setState("outcome_unknown");
      return store.getSummary("job-1")!;
    };
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({
      status: "outcome-unknown",
      jobId: "job-1",
    });
    expect(calls.map((call) => call.method)).toContain("complete");
  });

  it("inspects a raced settlement and returns canceled instead of the attempted state", async () => {
    const { store, setState } = storeWith(lease());
    store.complete = () => {
      setState("canceled");
      throw new Error("sentinel cancellation race detail");
    };
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "canceled", jobId: "job-1" });
  });

  it("fails safely when settlement persistence cannot be verified", async () => {
    const { store } = storeWith(lease());
    store.complete = () => {
      throw new Error("sentinel database detail");
    };
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).rejects.toEqual(
      new DurableJobRuntimeError("settlement-unverified"),
    );
  });

  it("rejects an unexpected post-start settlement state instead of reporting a retry", async () => {
    const { store, setState } = storeWith(lease());
    store.complete = () => {
      setState("queued");
      return store.getSummary("job-1")!;
    };
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).rejects.toEqual(
      new DurableJobRuntimeError("settlement-unverified"),
    );
  });

  it("joins concurrent ticks so one worker does not claim two jobs", async () => {
    const { store, calls } = storeWith(lease());
    const release = deferred<TurnResult>();
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return release.promise;
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    const first = worker.processNext();
    const second = worker.processNext();
    expect(first).toBe(second);
    expect(calls.filter((call) => call.method === "claim")).toHaveLength(1);
    release.resolve(successfulResult());
    await expect(first).resolves.toEqual({ status: "completed", jobId: "job-1" });
  });

  it("aborts the injected turn during shutdown and records an ambiguous post-start outcome", async () => {
    const { store, calls } = storeWith(lease());
    const injected = deferred<TurnResult>();
    let receivedSignal: AbortSignal | undefined;
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        receivedSignal = options?.signal;
        return injected.promise;
      },
    };
    const worker = runtime(agent, store);
    worker.start();
    const running = worker.processNext();
    await Promise.resolve();

    const stopping = worker.stop();
    expect(receivedSignal?.aborted).toBe(true);
    injected.resolve({ ...successfulResult(), success: false, status: "canceled" });
    await stopping;
    await expect(running).resolves.toEqual({ status: "outcome-unknown", jobId: "job-1" });
    expect(calls.map((call) => call.method)).toContain("markOutcomeUnknown");
  });

  it("bounds shutdown wait, quarantines detached work, and blocks restart until it settles", async () => {
    const timers = timerHarness();
    const { store, calls } = storeWith(lease());
    const injected = deferred<TurnResult>();
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        return injected.promise;
      },
    };
    const worker = runtime(agent, store, {
      shutdownGraceMs: 500,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    worker.start();
    const running = worker.processNext();
    await Promise.resolve();

    const stopping = worker.stop();
    timers.fireNext(500);
    await stopping;
    expect(calls.find((call) => call.method === "markOutcomeUnknown")?.input).toMatchObject({
      reasonCode: "shutdown-interrupted",
    });
    expect(timers.activeCount()).toBe(0);
    expect(() => worker.start()).toThrow("cannot restart while an execution is unresolved");

    injected.resolve({ ...successfulResult(), success: false, status: "canceled" });
    await expect(running).resolves.toEqual({ status: "outcome-unknown", jobId: "job-1" });
    worker.start();
    expect(worker.isStarted()).toBe(true);
  });

  it("contains poll failures, reports a fixed classification, and backs off", async () => {
    const timers = timerHarness();
    const { store } = storeWith(null);
    const classifications: string[] = [];
    store.claim = () => {
      throw new Error("sentinel private database path");
    };
    const worker = runtime({ inject: async () => successfulResult() }, store, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onOperationalError: (classification) => classifications.push(classification),
    });
    worker.start();
    timers.fireNext(1_000);
    for (let step = 0; step < 8 && timers.delays().length === 0; step++) {
      await Promise.resolve();
    }

    expect(classifications).toEqual(["poll-failed"]);
    expect(timers.delays()).toContain(2_000);
    await expect(worker.processNext()).rejects.toThrow("sentinel private database path");
  });

  it("does not execute a claim canceled at the fenced start boundary", async () => {
    const { store, calls, setState } = storeWith(lease());
    store.markExecutionStarted = (input) => {
      calls.push({ method: "markExecutionStarted", input });
      setState("canceled");
      return store.getSummary("job-1")!;
    };
    let modelExecuted = false;
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        modelExecuted = true;
        return successfulResult();
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "canceled", jobId: "job-1" });
    expect(modelExecuted).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { emptyTrace } from "@/kernel/trace-emitter";
import {
  createDurableJobRuntime,
  type DurableJobRuntimeLease,
  type DurableJobRuntimeStore,
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

function lease(attempt = 1): DurableJobRuntimeLease {
  return {
    job: { id: "job-1", attempt, cancelRequested: false },
    token: "lease-1",
    expiresAt: 100_000,
    payload: {
      version: 1,
      value: {
        version: 1,
        kind: "agent-turn",
        threadId: "order-1",
        prompt: "sentinel-private-order-prompt",
        correlationId: "correlation-1",
        timeoutMs: 5_000,
        maxAttempts: 2,
      },
    },
  };
}

function storeWith(next: DurableJobRuntimeLease | null): {
  store: DurableJobRuntimeStore;
  calls: Array<{ method: string; input?: unknown }>;
} {
  const calls: Array<{ method: string; input?: unknown }> = [];
  return {
    calls,
    store: {
      claim(input) {
        calls.push({ method: "claim", input });
        const claimed = next;
        next = null;
        return claimed;
      },
      markExecutionStarted(input) {
        calls.push({ method: "markExecutionStarted", input });
        return { state: "running", cancelRequested: false };
      },
      heartbeat(input) {
        calls.push({ method: "heartbeat", input });
        return { cancelRequested: false };
      },
      releaseUnstarted(input) {
        calls.push({ method: "releaseUnstarted", input });
      },
      complete(input) {
        calls.push({ method: "complete", input });
      },
      failDefinite(input) {
        calls.push({ method: "failDefinite", input });
      },
      markOutcomeUnknown(input) {
        calls.push({ method: "markOutcomeUnknown", input });
      },
      recoverInterrupted() {
        calls.push({ method: "recoverInterrupted" });
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
    setInterval: () => Symbol("timer"),
    clearInterval: () => {},
    ...overrides,
  });
}

describe("durable job runtime", () => {
  it("marks the fenced start boundary before injection and persists only bounded result metadata", async () => {
    const { store, calls } = storeWith(lease());
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(trigger, options) {
        expect(calls.map((call) => call.method)).toEqual(["recoverInterrupted", "claim"]);
        await options?.onExecutionStart?.();
        expect(calls.map((call) => call.method)).toEqual([
          "recoverInterrupted",
          "claim",
          "markExecutionStarted",
        ]);
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
    const completed = calls.find((call) => call.method === "complete")?.input;
    const serialized = JSON.stringify(completed);
    expect(serialized).toContain('"responseCount":1');
    expect(serialized).toContain('"toolCallCount":1');
    expect(serialized).not.toContain("sentinel-private-model-output");
    expect(serialized).not.toContain("sentinel-secret");
    expect(serialized).not.toContain("sentinel-private-order-prompt");
  });

  it("requeues scheduler admission failures without crossing the execution boundary", async () => {
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
    expect(calls.map((call) => call.method)).toEqual([
      "recoverInterrupted",
      "claim",
      "releaseUnstarted",
    ]);
  });

  it("requeues a pre-start admission exception without classifying it as an execution failure", async () => {
    const { store, calls } = storeWith(lease());
    const agent: Pick<AgentHandle, "inject"> = {
      async inject() {
        throw new Error("scheduler stopped before admission");
      },
    };
    const worker = runtime(agent, store);
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "requeued", jobId: "job-1" });
    expect(calls.map((call) => call.method)).toEqual([
      "recoverInterrupted",
      "claim",
      "releaseUnstarted",
    ]);
  });

  it("quarantines every unclassified post-start exception instead of blind retrying", async () => {
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
      "recoverInterrupted",
      "claim",
      "markExecutionStarted",
      "markOutcomeUnknown",
    ]);
    expect(JSON.stringify(calls)).not.toContain("sentinel-provider-detail-that-must-not-persist");
    expect(calls.find((call) => call.method === "failDefinite")).toBeUndefined();
  });

  it("permits bounded retries only when a trusted classifier proves no side effect began", async () => {
    const { store, calls } = storeWith(lease(1));
    const agent: Pick<AgentHandle, "inject"> = {
      async inject(_trigger, options) {
        await options?.onExecutionStart?.();
        throw new Error("known-pre-dispatch-failure");
      },
    };
    const worker = runtime(agent, store, {
      classifyDefiniteFailure: () => "definite-failure",
    });
    worker.start();

    await expect(worker.processNext()).resolves.toEqual({ status: "requeued", jobId: "job-1" });
    expect(calls.find((call) => call.method === "failDefinite")?.input).toEqual({
      jobId: "job-1",
      token: "lease-1",
      errorCode: "trusted-definite-failure",
      retryAt: 11_000,
    });
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
    expect(receivedSignal?.aborted).toBe(false);

    const stopping = worker.stop();
    expect(receivedSignal?.aborted).toBe(true);
    injected.resolve({ ...successfulResult(), success: false, status: "canceled" });
    await stopping;
    await expect(running).resolves.toEqual({ status: "outcome-unknown", jobId: "job-1" });
    expect(calls.map((call) => call.method)).toContain("markOutcomeUnknown");
  });

  it("does not execute a claim already canceled at the fenced start boundary", async () => {
    const { store, calls } = storeWith(lease());
    store.markExecutionStarted = (input) => {
      calls.push({ method: "markExecutionStarted", input });
      return { state: "canceled", cancelRequested: true };
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
    expect(calls.map((call) => call.method)).toEqual([
      "recoverInterrupted",
      "claim",
      "markExecutionStarted",
    ]);
  });
});

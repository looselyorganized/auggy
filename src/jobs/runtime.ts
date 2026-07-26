import type { AgentHandle, ExecutionContextV1, TurnResult, TurnTrigger } from "../types";

const MAX_PROMPT_CHARS = 16 * 1024;
const MAX_THREAD_ID_LENGTH = 128;
const MAX_CORRELATION_ID_LENGTH = 256;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_ATTEMPTS = 20;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The only v1 payload the runtime can execute. Submission remains a trusted
 * application/operator boundary; this module intentionally exposes no route,
 * augment, or model tool for creating jobs.
 */
export interface DurableTurnJobPayloadV1 {
  version: 1;
  kind: "agent-turn";
  threadId: string;
  prompt: string;
  contextId?: string;
  taskId?: string;
  correlationId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface DurableJobRuntimeLease {
  job: {
    id: string;
    attempt: number;
    cancelRequested: boolean;
  };
  /** Private bounded job data. Store list APIs must never return this field. */
  payload: { version: 1; value: unknown };
  token: string;
  expiresAt: number;
}

/**
 * Deliberately narrow adapter over the transactional DurableJobStore. Fenced
 * methods must reject stale tokens rather than applying a best-effort update.
 */
export interface DurableJobRuntimeStore {
  claim(input: { workerId: string; leaseMs: number }): DurableJobRuntimeLease | null;
  markExecutionStarted(input: { jobId: string; token: string }): {
    state: "running" | "canceled";
    cancelRequested: boolean;
  };
  heartbeat(input: { jobId: string; token: string; leaseMs: number }): {
    cancelRequested: boolean;
  };
  releaseUnstarted(input: {
    jobId: string;
    token: string;
    errorCode: string;
    availableAt?: number;
  }): unknown;
  complete(input: { jobId: string; token: string; result: DurableJobResultV1 }): unknown;
  failDefinite(input: {
    jobId: string;
    token: string;
    errorCode: string;
    retryAt?: number;
  }): unknown;
  markOutcomeUnknown(input: { jobId: string; token: string; reasonCode: string }): unknown;
  recoverInterrupted?: () => unknown;
}

/** Intentionally metadata-only: raw model output and error text stay out of the job database. */
export interface DurableJobResultV1 {
  version: 1;
  outcome: "completed";
  responseCount: number;
  toolCallCount: number;
}

export interface DurableJobRuntimeOptions {
  agent: Pick<AgentHandle, "inject">;
  store: DurableJobRuntimeStore;
  workerId: string;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /**
   * Opt-in evidence supplied by a trusted embedding. Returning true asserts
   * that this exact error proves no external side effect began.
   */
  classifyDefiniteFailure?: (
    error: unknown,
    lease: DurableJobRuntimeLease,
  ) => "definite-failure" | "outcome-unknown";
}

export type DurableJobProcessResult =
  | { status: "idle" | "stopped" }
  | { status: "completed" | "requeued" | "failed" | "canceled" | "outcome-unknown"; jobId: string };

const defaultNow = () => Date.now();

function boundedIdentifier(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.normalize("NFC") ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    throw new Error(`Invalid durable job ${name}`);
  }
  return value;
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROMPT_CHARS) {
    throw new Error("Invalid durable job prompt");
  }
  // The character cap bounds this allocation; reject multi-byte input beyond
  // the same 64 KiB persistence ceiling before a turn is admitted.
  if (new TextEncoder().encode(value).byteLength > 64 * 1024) {
    throw new Error("Invalid durable job prompt");
  }
  return value;
}

function boundedTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1_000 ||
    (value as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error("Invalid durable job timeout");
  }
  return value as number;
}

function boundedAttempts(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ATTEMPTS) {
    throw new Error("Invalid durable job max attempts");
  }
  return value as number;
}

function parsePayload(
  value: unknown,
  defaultTimeoutMs: number,
): Required<Pick<DurableTurnJobPayloadV1, "threadId" | "prompt" | "timeoutMs" | "maxAttempts">> &
  Pick<DurableTurnJobPayloadV1, "contextId" | "taskId" | "correlationId"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid durable job payload");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "kind",
    "threadId",
    "prompt",
    "contextId",
    "taskId",
    "correlationId",
    "timeoutMs",
    "maxAttempts",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    input.version !== 1 ||
    input.kind !== "agent-turn"
  ) {
    throw new Error("Invalid durable job payload");
  }
  const optionalIdentifier = (key: "contextId" | "taskId" | "correlationId", max: number) =>
    input[key] === undefined ? undefined : boundedIdentifier(input[key], key, max);
  return {
    threadId: boundedIdentifier(input.threadId, "thread ID", MAX_THREAD_ID_LENGTH),
    prompt: boundedPrompt(input.prompt),
    timeoutMs: boundedTimeout(input.timeoutMs, defaultTimeoutMs),
    maxAttempts: boundedAttempts(input.maxAttempts),
    ...(input.contextId === undefined
      ? {}
      : { contextId: optionalIdentifier("contextId", MAX_THREAD_ID_LENGTH) }),
    ...(input.taskId === undefined
      ? {}
      : { taskId: optionalIdentifier("taskId", MAX_THREAD_ID_LENGTH) }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: optionalIdentifier("correlationId", MAX_CORRELATION_ID_LENGTH) }),
  };
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
}

function resultSummary(result: TurnResult): DurableJobResultV1 {
  return Object.freeze({
    version: 1,
    outcome: "completed",
    responseCount: result.responses?.length ?? (result.response ? 1 : 0),
    toolCallCount: result.toolCalls.length,
  });
}

class CanceledBeforeExecutionError extends Error {}

/**
 * Runtime-owned single-turn worker. It is intentionally single-process: the
 * SQLite store provides fencing, but a shared volume does not make v1 a
 * multi-replica service.
 */
export function createDurableJobRuntime(options: DurableJobRuntimeOptions) {
  const now = options.now ?? defaultNow;
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(leaseMs / 3));
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
  const setIntervalFn =
    options.setInterval ??
    ((callback: () => void, ms: number): unknown => globalThis.setInterval(callback, ms));
  const clearIntervalFn =
    options.clearInterval ??
    ((handle: unknown): void => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  if (!SAFE_IDENTIFIER.test(options.workerId) || options.workerId.length > 128) {
    throw new Error("Invalid durable jobs worker ID");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
    throw new Error("Invalid durable jobs lease duration");
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 100 ||
    heartbeatIntervalMs >= leaseMs
  ) {
    throw new Error("Invalid durable jobs heartbeat interval");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new Error("Invalid durable jobs poll interval");
  }
  if (
    !Number.isSafeInteger(defaultTimeoutMs) ||
    defaultTimeoutMs < 1_000 ||
    defaultTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("Invalid durable jobs default timeout");
  }

  let started = false;
  let pollTimer: unknown;
  let currentAbort: AbortController | undefined;
  let current: Promise<DurableJobProcessResult> | undefined;

  async function settleUnknown(lease: DurableJobRuntimeLease, reasonCode: string): Promise<void> {
    try {
      options.store.markOutcomeUnknown({ jobId: lease.job.id, token: lease.token, reasonCode });
    } catch {
      // A stale worker must not overwrite a later owner's outcome. The store
      // has already fenced the token; no raw error is persisted or logged.
    }
  }

  async function releaseUnstarted(lease: DurableJobRuntimeLease, errorCode: string): Promise<void> {
    try {
      options.store.releaseUnstarted({ jobId: lease.job.id, token: lease.token, errorCode });
    } catch {
      // Stale/expired leases cannot be repaired by this worker.
    }
  }

  async function processOne(): Promise<DurableJobProcessResult> {
    if (!started) return { status: "stopped" };
    const lease = options.store.claim({ workerId: options.workerId, leaseMs });
    if (!lease) return { status: "idle" };
    let payload: ReturnType<typeof parsePayload>;
    try {
      if (lease.payload.version !== 1) throw new Error("Invalid durable job payload");
      payload = parsePayload(lease.payload.value, defaultTimeoutMs);
    } catch {
      await releaseUnstarted(lease, "invalid-payload");
      return { status: "requeued", jobId: lease.job.id };
    }

    const controller = new AbortController();
    currentAbort = controller;
    let began = false;
    let heartbeatFailed = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = () => {
      try {
        const state = options.store.heartbeat({ jobId: lease.job.id, token: lease.token, leaseMs });
        if (state.cancelRequested) controller.abort("durable-job-canceled");
      } catch {
        heartbeatFailed = true;
        controller.abort("durable-job-lease-lost");
      }
    };
    const heartbeatTimer = setIntervalFn(heartbeat, heartbeatIntervalMs);

    const context: ExecutionContextV1 = {
      version: 1,
      executionId: lease.job.id,
      attempt: lease.job.attempt,
      // AgentHandle validates execution deadlines against the process wall
      // clock. The injectable `now` remains solely for deterministic store
      // scheduling and retry tests.
      deadlineAt: Date.now() + payload.timeoutMs,
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    };
    const trigger: TurnTrigger = {
      type: "internal",
      turnId: `durable:${lease.job.id}:${lease.job.attempt}`,
      threadId: payload.threadId,
      source: "durable-jobs",
      timestamp: now(),
      payload: {
        parts: [{ kind: "text", text: payload.prompt }],
        sourceAugment: "durable-jobs",
        peer: null,
        timestamp: now(),
        ...(payload.contextId === undefined ? {} : { contextId: payload.contextId }),
        ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
      },
    };

    try {
      deadlineTimer = setTimeout(() => controller.abort("durable-job-deadline"), payload.timeoutMs);
      const result = await options.agent.inject(trigger, {
        signal: controller.signal,
        executionContext: context,
        onExecutionStart: async () => {
          const state = options.store.markExecutionStarted({
            jobId: lease.job.id,
            token: lease.token,
          });
          if (state.state !== "running" || state.cancelRequested) {
            throw new CanceledBeforeExecutionError();
          }
          began = true;
        },
      });
      if (!began) {
        await releaseUnstarted(
          lease,
          result.status === "canceled" ? "admission-canceled" : "admission-rejected",
        );
        return { status: "requeued", jobId: lease.job.id };
      }
      if (
        heartbeatFailed ||
        controller.signal.aborted ||
        result.outcomeUnknown ||
        !result.success
      ) {
        await settleUnknown(lease, heartbeatFailed ? "lease-lost" : "execution-ambiguous");
        return { status: "outcome-unknown", jobId: lease.job.id };
      }
      options.store.complete({
        jobId: lease.job.id,
        token: lease.token,
        result: resultSummary(result),
      });
      return { status: "completed", jobId: lease.job.id };
    } catch (error) {
      if (!began) {
        if (error instanceof CanceledBeforeExecutionError) {
          return { status: "canceled", jobId: lease.job.id };
        }
        await releaseUnstarted(lease, "admission-failed");
        return { status: "requeued", jobId: lease.job.id };
      }
      const classification = options.classifyDefiniteFailure?.(error, lease) ?? "outcome-unknown";
      if (classification === "definite-failure") {
        const retryAt =
          lease.job.attempt < payload.maxAttempts
            ? now() + retryDelayMs(lease.job.attempt)
            : undefined;
        options.store.failDefinite({
          jobId: lease.job.id,
          token: lease.token,
          errorCode: "trusted-definite-failure",
          ...(retryAt === undefined ? {} : { retryAt }),
        });
        return { status: retryAt === undefined ? "failed" : "requeued", jobId: lease.job.id };
      }
      await settleUnknown(
        lease,
        controller.signal.aborted ? "execution-aborted" : "execution-threw",
      );
      return { status: "outcome-unknown", jobId: lease.job.id };
    } finally {
      clearIntervalFn(heartbeatTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (currentAbort === controller) currentAbort = undefined;
    }
  }

  return Object.freeze({
    start(): void {
      if (started) return;
      options.store.recoverInterrupted?.();
      started = true;
      pollTimer = setIntervalFn(() => {
        void processNext();
      }, pollIntervalMs);
    },
    async stop(): Promise<void> {
      started = false;
      if (pollTimer !== undefined) {
        clearIntervalFn(pollTimer);
        pollTimer = undefined;
      }
      currentAbort?.abort("durable-job-runtime-stopping");
      await current?.catch(() => {});
    },
    processNext,
    isStarted(): boolean {
      return started;
    },
  });

  function processNext(): Promise<DurableJobProcessResult> {
    if (current) return current;
    current = processOne().finally(() => {
      current = undefined;
    });
    return current;
  }
}

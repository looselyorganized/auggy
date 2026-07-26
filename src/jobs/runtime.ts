import type { AgentHandle, ExecutionContextV1, TurnResult, TurnTrigger } from "../types";
import type { DurableJobErrorCode, DurableJobPayload, DurableJobState } from "./types";

const MAX_PROMPT_UTF16_UNITS = 32 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_THREAD_ID_LENGTH = 128;
const MAX_CORRELATION_ID_LENGTH = 256;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
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
  payload: DurableJobPayload;
  token: string;
  expiresAt: number;
}

export type DurableJobRuntimeState = DurableJobState;

export interface DurableJobRuntimeSummary {
  id: string;
  state: DurableJobRuntimeState;
  attempt: number;
  cancelRequested: boolean;
}

type DurableJobPrestartErrorCode =
  | "invalid-payload"
  | "admission-canceled"
  | "admission-rejected"
  | "admission-failed"
  | "shutdown-before-execution";

/**
 * Deliberately narrow adapter over the transactional DurableJobStore. Fenced
 * methods must reject stale tokens rather than applying a best-effort update.
 */
export interface DurableJobRuntimeStore {
  claim(input: { workerId: string; leaseMs: number }): DurableJobRuntimeLease | null;
  markExecutionStarted(input: { jobId: string; token: string }): DurableJobRuntimeSummary;
  heartbeat(input: { jobId: string; token: string; leaseMs: number }): DurableJobRuntimeSummary;
  releaseUnstarted(input: {
    jobId: string;
    token: string;
    errorCode: DurableJobErrorCode;
    availableAt?: number;
  }): DurableJobRuntimeSummary;
  rejectUnstarted(input: {
    jobId: string;
    token: string;
    errorCode: DurableJobErrorCode;
  }): DurableJobRuntimeSummary;
  complete(input: {
    jobId: string;
    token: string;
    result: DurableJobResultV1;
  }): DurableJobRuntimeSummary;
  markOutcomeUnknown(input: {
    jobId: string;
    token: string;
    reasonCode: string;
  }): DurableJobRuntimeSummary;
  /** Redacted state lookup used only to verify a raced or failed settlement. */
  getSummary(jobId: string): DurableJobRuntimeSummary | null;
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
  deadlineGraceMs?: number;
  shutdownGraceMs?: number;
  maxPollBackoffMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  onOperationalError?: (classification: "poll-failed" | "settlement-failed") => void;
}

export type DurableJobProcessResult =
  | { status: "idle" | "stopped" }
  | { status: "completed" | "requeued" | "failed" | "canceled" | "outcome-unknown"; jobId: string };

export class DurableJobRuntimeError extends Error {
  constructor(readonly code: "settlement-unverified") {
    super(`Durable job runtime error: ${code}`);
    this.name = "DurableJobRuntimeError";
  }
}

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
  // This constant-time metadata check prevents an attacker-controlled encoder
  // allocation above the bounded UTF-16 envelope.
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROMPT_UTF16_UNITS) {
    throw new Error("Invalid durable job prompt");
  }
  if (new TextEncoder().encode(value).byteLength > MAX_PROMPT_BYTES) {
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

class CanceledBeforeExecutionError extends Error {
  constructor(readonly result: DurableJobProcessResult) {
    super("Durable job canceled before execution");
  }
}

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
  const maxPollBackoffMs = options.maxPollBackoffMs ?? 30_000;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
  const deadlineGraceMs = options.deadlineGraceMs ?? 5_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  const setTimeoutFn =
    options.setTimeout ??
    ((callback: () => void, ms: number): unknown => globalThis.setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeout ??
    ((handle: unknown): void => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
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
    !Number.isSafeInteger(maxPollBackoffMs) ||
    maxPollBackoffMs < pollIntervalMs ||
    maxPollBackoffMs > 5 * 60_000
  ) {
    throw new Error("Invalid durable jobs maximum poll backoff");
  }
  if (
    !Number.isSafeInteger(defaultTimeoutMs) ||
    defaultTimeoutMs < 1_000 ||
    defaultTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("Invalid durable jobs default timeout");
  }
  if (!Number.isSafeInteger(deadlineGraceMs) || deadlineGraceMs < 100 || deadlineGraceMs > 60_000) {
    throw new Error("Invalid durable jobs deadline grace");
  }
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 100 || shutdownGraceMs > 60_000) {
    throw new Error("Invalid durable jobs shutdown grace");
  }

  let started = false;
  let pollTimer: unknown;
  let pollTimerSet = false;
  let nextPollDelayMs = pollIntervalMs;
  let active:
    | {
        lease: DurableJobRuntimeLease;
        controller: AbortController;
        began: boolean;
        maxAttempts: number;
        cleanup: () => void;
        forcedResult?: DurableJobProcessResult;
        forcedError?: DurableJobRuntimeError;
      }
    | undefined;
  let current: Promise<DurableJobProcessResult> | undefined;
  let stopping: Promise<void> | undefined;

  function reportOperationalError(classification: "poll-failed" | "settlement-failed"): void {
    try {
      options.onOperationalError?.(classification);
    } catch {
      // Observability callbacks cannot take down the worker or leak the source
      // exception into another logging path.
    }
  }

  function processResult(summary: DurableJobRuntimeSummary): DurableJobProcessResult | undefined {
    switch (summary.state) {
      case "queued":
        return { status: "requeued", jobId: summary.id };
      case "completed":
        return { status: "completed", jobId: summary.id };
      case "failed":
        return { status: "failed", jobId: summary.id };
      case "canceled":
        return { status: "canceled", jobId: summary.id };
      case "outcome_unknown":
        return { status: "outcome-unknown", jobId: summary.id };
      case "leased":
      case "running":
        return undefined;
    }
  }

  function verifySettlement(
    lease: DurableJobRuntimeLease,
    operation: () => DurableJobRuntimeSummary,
    allowedStates: ReadonlySet<DurableJobRuntimeState>,
  ): DurableJobProcessResult {
    let summary: DurableJobRuntimeSummary | null;
    try {
      summary = operation();
    } catch {
      try {
        summary = options.store.getSummary(lease.job.id);
      } catch {
        throw new DurableJobRuntimeError("settlement-unverified");
      }
    }
    if (!summary || summary.id !== lease.job.id || !allowedStates.has(summary.state)) {
      throw new DurableJobRuntimeError("settlement-unverified");
    }
    const result = processResult(summary);
    if (!result) throw new DurableJobRuntimeError("settlement-unverified");
    return result;
  }

  function settleUnstarted(
    lease: DurableJobRuntimeLease,
    maxAttempts: number,
    errorCode: DurableJobPrestartErrorCode,
  ): DurableJobProcessResult {
    if (lease.job.attempt >= maxAttempts) {
      return verifySettlement(
        lease,
        () => options.store.rejectUnstarted({ jobId: lease.job.id, token: lease.token, errorCode }),
        new Set(["failed", "canceled", "outcome_unknown"]),
      );
    }
    return verifySettlement(
      lease,
      () =>
        options.store.releaseUnstarted({
          jobId: lease.job.id,
          token: lease.token,
          errorCode,
          availableAt: now() + retryDelayMs(lease.job.attempt),
        }),
      new Set(["queued", "canceled", "outcome_unknown"]),
    );
  }

  function settleUnknown(
    lease: DurableJobRuntimeLease,
    reasonCode: "execution-outcome-unknown" | "shutdown-interrupted",
  ): DurableJobProcessResult {
    return verifySettlement(
      lease,
      () =>
        options.store.markOutcomeUnknown({ jobId: lease.job.id, token: lease.token, reasonCode }),
      new Set(["outcome_unknown", "canceled", "completed"]),
    );
  }

  function markStarted(lease: DurableJobRuntimeLease): DurableJobRuntimeSummary {
    let summary: DurableJobRuntimeSummary | null;
    try {
      summary = options.store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
    } catch {
      try {
        summary = options.store.getSummary(lease.job.id);
      } catch {
        throw new DurableJobRuntimeError("settlement-unverified");
      }
    }
    if (
      !summary ||
      summary.id !== lease.job.id ||
      !["running", "canceled"].includes(summary.state)
    ) {
      throw new DurableJobRuntimeError("settlement-unverified");
    }
    return summary;
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
      return verifySettlement(
        lease,
        () =>
          options.store.rejectUnstarted({
            jobId: lease.job.id,
            token: lease.token,
            errorCode: "invalid-payload",
          }),
        new Set(["failed", "canceled", "outcome_unknown"]),
      );
    }

    const controller = new AbortController();
    const execution: NonNullable<typeof active> = {
      lease,
      controller,
      began: false,
      maxAttempts: payload.maxAttempts,
      cleanup: () => {},
    };
    active = execution;
    let heartbeatFailed = false;
    let deadlineTimer: unknown;
    let deadlineTimerSet = false;
    let deadlineWatchdogTimer: unknown;
    let deadlineWatchdogTimerSet = false;
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
    let cleanedUp = false;
    execution.cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearIntervalFn(heartbeatTimer);
      if (deadlineTimerSet) clearTimeoutFn(deadlineTimer);
      if (deadlineWatchdogTimerSet) clearTimeoutFn(deadlineWatchdogTimer);
    };

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
      deadlineTimer = setTimeoutFn(() => {
        deadlineTimerSet = false;
        controller.abort("durable-job-deadline");
        deadlineWatchdogTimer = setTimeoutFn(() => {
          deadlineWatchdogTimerSet = false;
          if (active !== execution || execution.forcedResult || execution.forcedError) return;
          execution.cleanup();
          try {
            execution.forcedResult = execution.began
              ? settleUnknown(lease, "execution-outcome-unknown")
              : settleUnstarted(lease, execution.maxAttempts, "admission-canceled");
          } catch {
            execution.forcedError = new DurableJobRuntimeError("settlement-unverified");
            reportOperationalError("settlement-failed");
          }
        }, deadlineGraceMs);
        deadlineWatchdogTimerSet = true;
      }, payload.timeoutMs);
      deadlineTimerSet = true;
      const result = await options.agent.inject(trigger, {
        signal: controller.signal,
        executionContext: context,
        onExecutionStart: async () => {
          const state = markStarted(lease);
          if (state.state !== "running" || state.cancelRequested) {
            const durable = processResult(state);
            if (!durable) throw new DurableJobRuntimeError("settlement-unverified");
            throw new CanceledBeforeExecutionError(durable);
          }
          execution.began = true;
        },
      });
      if (execution.forcedError) throw execution.forcedError;
      if (execution.forcedResult) return execution.forcedResult;
      if (!execution.began) {
        return settleUnstarted(
          lease,
          payload.maxAttempts,
          result.status === "canceled" ? "admission-canceled" : "admission-rejected",
        );
      }
      if (
        heartbeatFailed ||
        controller.signal.aborted ||
        result.outcomeUnknown ||
        !result.success
      ) {
        return settleUnknown(lease, "execution-outcome-unknown");
      }
      return verifySettlement(
        lease,
        () =>
          options.store.complete({
            jobId: lease.job.id,
            token: lease.token,
            result: resultSummary(result),
          }),
        new Set(["completed", "canceled", "outcome_unknown"]),
      );
    } catch (error) {
      if (execution.forcedError) throw execution.forcedError;
      if (execution.forcedResult) return execution.forcedResult;
      if (!execution.began) {
        if (error instanceof CanceledBeforeExecutionError) {
          return error.result;
        }
        if (error instanceof DurableJobRuntimeError) throw error;
        return settleUnstarted(lease, payload.maxAttempts, "admission-failed");
      }
      if (error instanceof DurableJobRuntimeError) throw error;
      return settleUnknown(lease, "execution-outcome-unknown");
    } finally {
      execution.cleanup();
      if (active === execution) active = undefined;
    }
  }

  function clearPollTimer(): void {
    if (!pollTimerSet) return;
    clearTimeoutFn(pollTimer);
    pollTimer = undefined;
    pollTimerSet = false;
  }

  function schedulePoll(delayMs: number): void {
    if (!started || pollTimerSet) return;
    pollTimer = setTimeoutFn(() => {
      pollTimerSet = false;
      pollTimer = undefined;
      void processNext()
        .then(() => {
          nextPollDelayMs = pollIntervalMs;
        })
        .catch(() => {
          reportOperationalError("poll-failed");
          nextPollDelayMs = Math.min(
            maxPollBackoffMs,
            Math.max(pollIntervalMs, nextPollDelayMs * 2),
          );
        })
        .finally(() => schedulePoll(nextPollDelayMs));
    }, delayMs);
    pollTimerSet = true;
  }

  async function waitForShutdownGrace(promise: Promise<unknown>): Promise<"settled" | "elapsed"> {
    let graceTimer: unknown;
    const elapsed = new Promise<"elapsed">((resolve) => {
      graceTimer = setTimeoutFn(() => resolve("elapsed"), shutdownGraceMs);
    });
    const settled = promise.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    const result = await Promise.race([settled, elapsed]);
    if (result === "settled") clearTimeoutFn(graceTimer);
    return result;
  }

  const runtime = Object.freeze({
    start(): void {
      if (started) return;
      if (current) {
        throw new Error("Durable job runtime cannot restart while an execution is unresolved");
      }
      started = true;
      nextPollDelayMs = pollIntervalMs;
      schedulePoll(nextPollDelayMs);
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = stopRuntime().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
    processNext,
    isStarted(): boolean {
      return started;
    },
  });

  async function stopRuntime(): Promise<void> {
    started = false;
    clearPollTimer();
    const pending = current;
    const execution = active;
    execution?.controller.abort("durable-job-runtime-stopping");
    if (!pending) return;
    if ((await waitForShutdownGrace(pending)) === "settled") return;
    // The task promise stays rejection-observed through `current`. A restart
    // remains forbidden until its finally handler clears that reference.
    if (!execution || active !== execution) return;
    execution.cleanup();
    if (execution.forcedResult || execution.forcedError) return;
    try {
      if (execution.began) {
        execution.forcedResult = settleUnknown(execution.lease, "shutdown-interrupted");
      } else {
        execution.forcedResult = settleUnstarted(
          execution.lease,
          execution.maxAttempts,
          "shutdown-before-execution",
        );
      }
    } catch {
      execution.forcedError = new DurableJobRuntimeError("settlement-unverified");
      reportOperationalError("settlement-failed");
    }
  }

  function processNext(): Promise<DurableJobProcessResult> {
    if (current) return current;
    current = processOne().finally(() => {
      current = undefined;
    });
    return current;
  }

  return runtime;
}

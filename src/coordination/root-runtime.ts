import { createHash, randomUUID } from "node:crypto";
import type { SchedulerStartDecision } from "../kernel/keyed-turn-scheduler";
import type { ExecutionContextV1, RouteAuthContext, TurnTrigger } from "../types";
import type {
  AdmitResult,
  DistributedReplayResult,
  DistributedSourcePolicy,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  LeaseResult,
  RegistrationResult,
} from "./types";

const MAX_BINDING_BYTES = 1_048_576;
const MAX_BINDING_DEPTH = 32;
const MAX_BINDING_NODES = 10_000;

export interface CoordinationTimers {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: CoordinationTimers = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DistributedExecutionAuthorityV1 {
  version: 1;
  attempt: number;
  fence: number;
}

export interface DistributedRootExecutionControl {
  readonly signal: AbortSignal;
  beforeStart(): Promise<SchedulerStartDecision>;
  ensureExecutionStarted(): Promise<void>;
  executionAuthority(): DistributedExecutionAuthorityV1;
  markUncertain(): void;
}

export type DistributedLocalRunResult<T> =
  | { status: "completed"; value: T }
  | { status: "rejected" }
  | { status: "canceled" };

export type DistributedRootRunResult<T> =
  | { status: "completed"; value: T }
  | { status: "replay"; result: DistributedReplayResult }
  | { status: "rejected"; reason: string }
  | { status: "conflict" }
  | { status: "pending" }
  | { status: "terminal"; state: "failed" | "canceled" }
  | { status: "outcome-unknown" }
  | { status: "unavailable" };

export interface DistributedRootRuntimeOptions {
  coordinator: DistributedTurnCoordinator;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  claimPollMs: number;
  maxWaitMs: number;
  timers?: CoordinationTimers;
}

export interface DistributedRootRunOptions<T> {
  request: DistributedTurnRequest;
  signal?: AbortSignal;
  local(control: DistributedRootExecutionControl): Promise<DistributedLocalRunResult<T>>;
  isSuccessful(value: T): boolean;
  commit(lease: DistributedTurnLease, value: T): Promise<LeaseResult>;
}

export interface DistributedRootTurnRuntime {
  start(): Promise<void>;
  run<T>(run: DistributedRootRunOptions<T>): Promise<DistributedRootRunResult<T>>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
  snapshot(): { state: "created" | "accepting" | "draining" | "unavailable" | "closed" };
}

function safeAuthorizationBinding(value: RouteAuthContext | undefined): unknown {
  if (value?.mode !== "visitor" || value.state !== "recognized") return value;
  const {
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    principal,
    externalAuth,
    ...topLevel
  } = value;
  const { externalAuth: principalExternalAuth, ...stablePrincipal } = principal;
  const stableExternalAuth = externalAuth
    ? (({ keyId: _keyId, jti: _jti, ...claims }) => claims)(externalAuth)
    : undefined;
  const stablePrincipalExternalAuth = principalExternalAuth
    ? (({ keyId: _keyId, jti: _jti, ...claims }) => claims)(principalExternalAuth)
    : undefined;
  return {
    ...topLevel,
    ...(stableExternalAuth ? { externalAuth: stableExternalAuth } : {}),
    principal: {
      ...stablePrincipal,
      ...(stablePrincipalExternalAuth ? { externalAuth: stablePrincipalExternalAuth } : {}),
    },
  };
}

function semanticPayload(trigger: TurnTrigger): unknown {
  const payload = trigger.payload;
  if (
    trigger.type === "message" &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Array.isArray((payload as Record<string, unknown>).parts)
  ) {
    const {
      timestamp: _timestamp,
      parts,
      sourceAugment,
      peer,
      contextId,
      taskId,
      metadata,
    } = payload as Record<string, unknown>;
    return { parts, sourceAugment, peer, contextId, taskId, metadata };
  }
  return payload;
}

function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const consume = (encoded: string) => {
    bytes += Buffer.byteLength(encoded, "utf8");
    if (bytes > MAX_BINDING_BYTES) {
      throw new Error("distributed request binding exceeds byte limits");
    }
    return encoded;
  };
  const encode = (input: unknown, depth: number): string => {
    nodes++;
    if (nodes > MAX_BINDING_NODES || depth > MAX_BINDING_DEPTH) {
      throw new Error("distributed request binding exceeds structural limits");
    }
    if (input === null || typeof input === "boolean") {
      return consume(JSON.stringify(input));
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("distributed request binding is not finite");
      return consume(JSON.stringify(input));
    }
    if (typeof input === "string") {
      if (input !== input.normalize("NFC")) {
        throw new Error("distributed request binding strings must be NFC-normalized");
      }
      return consume(JSON.stringify(input));
    }
    if (Array.isArray(input)) {
      if (ancestors.has(input)) throw new Error("distributed request binding must not be cyclic");
      ancestors.add(input);
      consume("[");
      const values = input.map((item, index) => {
        if (index > 0) consume(",");
        return encode(item, depth + 1);
      });
      ancestors.delete(input);
      consume("]");
      return `[${values.join(",")}]`;
    }
    if (typeof input === "object") {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("distributed request binding must contain plain data");
      }
      if (ancestors.has(input)) throw new Error("distributed request binding must not be cyclic");
      ancestors.add(input);
      const record = input as Record<string, unknown>;
      consume("{");
      const entries = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key, index) => {
          if (index > 0) consume(",");
          const encodedKey = encode(key, depth + 1);
          consume(":");
          return `${encodedKey}:${encode(record[key], depth + 1)}`;
        });
      ancestors.delete(input);
      consume("}");
      return `{${entries.join(",")}}`;
    }
    throw new Error("distributed request binding contains unsupported data");
  };
  return encode(value, 0);
}

export function createCanonicalDistributedTurnRequest(options: {
  trigger: TurnTrigger;
  threadId: string;
  source: DistributedSourcePolicy;
  executionContext?: ExecutionContextV1;
  randomId?: () => string;
}): DistributedTurnRequest {
  const identity =
    options.executionContext?.idempotencyKeyHash ??
    options.executionContext?.executionId ??
    (options.randomId ?? randomUUID)();
  const requestId = `req:${createHash("sha256").update(identity).digest("hex")}`;
  const binding = canonicalJson({
    version: 1,
    requestId,
    sourcePolicy: options.source.id,
    threadId: options.threadId,
    trigger: {
      type: options.trigger.type,
      source: options.trigger.source,
      contextId: options.trigger.contextId,
      taskId: options.trigger.taskId,
      peer: options.trigger.peer ?? null,
      auth: safeAuthorizationBinding(options.trigger.auth),
      payload: semanticPayload(options.trigger),
    },
  });
  return {
    requestId,
    threadId: options.threadId,
    source: options.source,
    bindingHash: createHash("sha256").update(binding).digest("hex"),
  };
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export function createDistributedRootTurnRuntime(
  options: DistributedRootRuntimeOptions,
): DistributedRootTurnRuntime {
  for (const [name, value, minimum] of [
    ["leaseDurationMs", options.leaseDurationMs, 100],
    ["heartbeatIntervalMs", options.heartbeatIntervalMs, 10],
    ["claimPollMs", options.claimPollMs, 10],
    ["maxWaitMs", options.maxWaitMs, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
    }
  }
  if (options.heartbeatIntervalMs >= options.leaseDurationMs) {
    throw new Error("heartbeatIntervalMs must be less than leaseDurationMs");
  }
  if (
    options.leaseDurationMs > 300_000 ||
    options.heartbeatIntervalMs > 300_000 ||
    options.claimPollMs > 1_000 ||
    options.maxWaitMs > 300_000
  ) {
    throw new Error("distributed runtime timing exceeds supported limits");
  }
  const timers = options.timers ?? defaultTimers;
  const coordinator = options.coordinator;
  const authorityLost = new AbortController();
  const heartbeatStops = new Map<() => void, "instance" | "queued" | "active">();
  let state: "created" | "accepting" | "draining" | "unavailable" | "closed" = "created";

  const invalidate = (reason: "heartbeat-deadline" | "runtime-stopping") => {
    if (state === "unavailable" || state === "closed") return;
    state = reason === "runtime-stopping" ? "draining" : "unavailable";
    coordinator.invalidateLocalAuthority(reason);
    authorityLost.abort("coordinator-authority-lost");
    for (const stop of [...heartbeatStops.keys()]) stop();
  };

  const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const handle = timers.setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, milliseconds);
      const aborted = () => {
        timers.clearTimeout(handle);
        resolve();
      };
      signal.addEventListener("abort", aborted, { once: true });
    });
  };

  const callWithAuthority = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
    const outcome = await Promise.race([
      operation.then((value) => ({ status: "value" as const, value })),
      waitForAbort(signal).then(() => ({ status: "aborted" as const })),
    ]);
    if (outcome.status === "aborted") throw new Error("distributed authority unavailable");
    return outcome.value;
  };

  const callWithDecisionDeadline = async <T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> => {
    const deadline = new AbortController();
    const handle = timers.setTimeout(
      () => deadline.abort("coordinator-decision-deadline"),
      options.leaseDurationMs,
    );
    try {
      const value = await callWithAuthority(operation, combinedSignal(signal, deadline.signal));
      if (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        value.status === "unavailable"
      ) {
        invalidate("heartbeat-deadline");
      }
      return value;
    } catch (error) {
      if (deadline.signal.aborted || (!signal.aborted && !authorityLost.signal.aborted)) {
        invalidate("heartbeat-deadline");
      }
      throw error;
    } finally {
      timers.clearTimeout(handle);
    }
  };

  const startHeartbeat = (
    kind: "instance" | "queued" | "active",
    operation: () => Promise<LeaseResult>,
    onSuccess?: (result: Extract<LeaseResult, { status: "ok" }>) => void,
  ): (() => void) => {
    let stopped = false;
    let intervalHandle: unknown;
    let deadlineHandle: unknown;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (intervalHandle !== undefined) timers.clearTimeout(intervalHandle);
      if (deadlineHandle !== undefined) timers.clearTimeout(deadlineHandle);
      heartbeatStops.delete(stop);
    };
    const armDeadline = () => {
      if (deadlineHandle !== undefined) timers.clearTimeout(deadlineHandle);
      deadlineHandle = timers.setTimeout(
        () => invalidate("heartbeat-deadline"),
        options.leaseDurationMs,
      );
    };
    const schedule = () => {
      intervalHandle = timers.setTimeout(() => {
        if (
          stopped ||
          (state !== "accepting" &&
            !(state === "draining" && (kind === "instance" || kind === "active")))
        ) {
          return;
        }
        const heartbeat = operation();
        void heartbeat.then(
          (result) => {
            if (stopped) return;
            if (result.status !== "ok") {
              invalidate("heartbeat-deadline");
              return;
            }
            onSuccess?.(result);
            armDeadline();
            schedule();
          },
          () => invalidate("heartbeat-deadline"),
        );
      }, options.heartbeatIntervalMs);
    };
    heartbeatStops.set(stop, kind);
    armDeadline();
    schedule();
    return stop;
  };

  const settleUnknown = async (lease: DistributedTurnLease): Promise<void> => {
    const signal = combinedSignal(authorityLost.signal);
    try {
      await callWithDecisionDeadline(
        coordinator.markOutcomeUnknown(lease, "effect-outcome-unknown"),
        signal,
      );
    } catch {
      // Lease expiry is still fail-closed and will quarantine on the next
      // coordinator observation. Never hold a response on unavailable I/O.
    }
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (state !== "created") throw new Error("distributed runtime cannot be started twice");
      const registrationDeadline = new AbortController();
      const handle = timers.setTimeout(() => registrationDeadline.abort(), options.leaseDurationMs);
      let registration: RegistrationResult;
      try {
        registration = await callWithAuthority(
          coordinator.register(),
          combinedSignal(authorityLost.signal, registrationDeadline.signal),
        );
      } catch {
        invalidate("heartbeat-deadline");
        throw new Error("distributed runtime registration unavailable");
      } finally {
        timers.clearTimeout(handle);
      }
      if (registration.status !== "registered") {
        invalidate("heartbeat-deadline");
        throw new Error("distributed runtime registration unavailable");
      }
      state = "accepting";
      startHeartbeat("instance", () => coordinator.heartbeatInstance());
    },

    async run<T>(run: DistributedRootRunOptions<T>): Promise<DistributedRootRunResult<T>> {
      if (state !== "accepting") return { status: "unavailable" };
      const abandonAttempt = async (attempt: number): Promise<LeaseResult> => {
        const deadline = new AbortController();
        const handle = timers.setTimeout(
          () => deadline.abort("pre-start-abandon-deadline"),
          options.leaseDurationMs,
        );
        try {
          return await callWithAuthority(
            coordinator.abandon(run.request, attempt),
            deadline.signal,
          );
        } catch {
          return { status: "unavailable" };
        } finally {
          timers.clearTimeout(handle);
        }
      };
      const admissionOperation = coordinator.admit(run.request);
      let admitted: AdmitResult;
      try {
        admitted = await callWithDecisionDeadline(
          admissionOperation,
          combinedSignal(authorityLost.signal, run.signal),
        );
      } catch {
        void admissionOperation.then(
          async (late) => {
            if (late.status === "admitted" || late.status === "adopted") {
              await abandonAttempt(late.attempt);
            }
          },
          () => {},
        );
        return { status: "unavailable" };
      }
      if (admitted.status === "conflict") return { status: "conflict" };
      if (admitted.status === "unavailable") return { status: "unavailable" };
      if (admitted.status === "rejected") {
        return { status: "rejected", reason: admitted.reason };
      }
      if (admitted.status === "joined") {
        const joined = await callWithDecisionDeadline(
          coordinator.wait(run.request, {
            signal: run.signal,
            timeoutMs: options.maxWaitMs,
            pollMs: options.claimPollMs,
          }),
          combinedSignal(authorityLost.signal, run.signal),
        ).catch(() => ({ status: "unavailable" }) as const);
        if (joined.status === "completed") return { status: "replay", result: joined.result };
        if (joined.status === "terminal") return joined;
        if (joined.status === "conflict") return { status: "conflict" };
        if (joined.status === "quarantined") return { status: "outcome-unknown" };
        if (joined.status === "unavailable") return { status: "unavailable" };
        return { status: "pending" };
      }

      const ownerSignal = coordinator.ownedSignal(run.request);
      const signal = combinedSignal(authorityLost.signal, ownerSignal, run.signal);
      let lease: DistributedTurnLease | undefined;
      let executionStarted = false;
      let uncertain = false;
      let startPromise: Promise<void> | undefined;
      let activeHeartbeatStop: (() => void) | undefined;
      let localFinished = false;
      const queueAttempt = admitted.attempt;
      const queuedHeartbeatStop = startHeartbeat("queued", () =>
        coordinator.heartbeatQueued(run.request, queueAttempt),
      );
      const abandonPreStartAttempt = () => abandonAttempt(queueAttempt);

      const control: DistributedRootExecutionControl = {
        signal,
        async beforeStart() {
          if (signal.aborted) throw new Error("distributed authority unavailable");
          const claim = await callWithDecisionDeadline(
            coordinator.claim(run.request, queueAttempt),
            signal,
          );
          if (claim.status === "waiting") {
            return { status: "defer", resume: delay(options.claimPollMs, signal) };
          }
          if (claim.status !== "acquired") {
            throw new Error("distributed claim unavailable");
          }
          if (signal.aborted || localFinished) {
            queuedHeartbeatStop();
            await abandonPreStartAttempt();
            throw new Error("distributed claim arrived after local cancellation");
          }
          lease = claim.lease;
          queuedHeartbeatStop();
          activeHeartbeatStop = startHeartbeat(
            "active",
            () => coordinator.heartbeat(lease!),
            (result) => {
              if (result.lease) lease = result.lease;
            },
          );
          return { status: "ready" };
        },
        ensureExecutionStarted() {
          startPromise ??= (async () => {
            if (!lease || signal.aborted) throw new Error("distributed authority unavailable");
            const marked = await callWithDecisionDeadline(
              coordinator.markExecutionStarted(lease),
              signal,
            );
            if (marked.status !== "ok") throw new Error("distributed effect marker unavailable");
            executionStarted = true;
          })();
          return startPromise;
        },
        executionAuthority() {
          if (!lease) throw new Error("distributed execution has not been claimed");
          return Object.freeze({ version: 1, attempt: lease.attempt, fence: lease.fence });
        },
        markUncertain() {
          uncertain = true;
        },
      };

      try {
        let local: DistributedLocalRunResult<T>;
        try {
          local = await run.local(control);
        } finally {
          localFinished = true;
        }
        if (!lease) {
          queuedHeartbeatStop();
          const abandoned = await abandonPreStartAttempt();
          if (abandoned.status !== "ok") return { status: "unavailable" };
          if (local.status === "rejected") return { status: "rejected", reason: "local-admission" };
          if (local.status === "canceled") return { status: "terminal", state: "canceled" };
          return { status: "unavailable" };
        }
        if (!executionStarted) {
          activeHeartbeatStop?.();
          const abandoned = await abandonPreStartAttempt();
          if (abandoned.status !== "ok") return { status: "unavailable" };
          return local.status === "rejected"
            ? { status: "rejected", reason: "runtime-admission" }
            : { status: "terminal", state: "canceled" };
        }
        if (
          local.status !== "completed" ||
          uncertain ||
          signal.aborted ||
          !run.isSuccessful(local.value)
        ) {
          activeHeartbeatStop?.();
          await settleUnknown(lease);
          return { status: "outcome-unknown" };
        }
        const committed = await callWithDecisionDeadline(
          run.commit(lease, local.value),
          authorityLost.signal,
        ).catch(() => ({ status: "unavailable" }) as LeaseResult);
        activeHeartbeatStop?.();
        if (committed.status !== "ok") {
          await settleUnknown(lease);
          return { status: "outcome-unknown" };
        }
        return { status: "completed", value: local.value };
      } catch {
        queuedHeartbeatStop();
        activeHeartbeatStop?.();
        if (lease && executionStarted) {
          await settleUnknown(lease);
          return { status: "outcome-unknown" };
        }
        await abandonPreStartAttempt();
        return { status: "unavailable" };
      }
    },

    async beginDrain(): Promise<void> {
      if (state !== "accepting") return;
      state = "draining";
      for (const [stop, kind] of [...heartbeatStops]) {
        if (kind === "queued") stop();
      }
      const deadline = new AbortController();
      const handle = timers.setTimeout(() => deadline.abort(), options.leaseDurationMs);
      try {
        const result = await callWithAuthority(
          coordinator.beginDrain(),
          combinedSignal(authorityLost.signal, deadline.signal),
        );
        if (result.status !== "ok") throw new Error("distributed drain unavailable");
      } catch {
        invalidate("heartbeat-deadline");
        throw new Error("distributed drain unavailable");
      } finally {
        timers.clearTimeout(handle);
      }
    },

    async close(): Promise<void> {
      if (state === "closed") return;
      invalidate("runtime-stopping");
      state = "closed";
      let deadlineHandle: unknown;
      const close = coordinator.close().catch(() => {});
      await Promise.race([
        close,
        new Promise<void>((resolve) => {
          deadlineHandle = timers.setTimeout(resolve, options.leaseDurationMs);
        }),
      ]);
      if (deadlineHandle !== undefined) timers.clearTimeout(deadlineHandle);
      void close;
    },

    snapshot() {
      return Object.freeze({ state });
    },
  });
}

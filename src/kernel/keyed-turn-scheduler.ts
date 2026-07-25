export type SchedulerState = "accepting" | "draining" | "stopped";

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_RATE_LIMIT_PEERS_PER_SOURCE = 10_000;
const MAX_OPERATIONAL_COUNTER = Number.MAX_SAFE_INTEGER;

export type SchedulerRejectionReason =
  | "peer-rate-limit"
  | "thread-capacity"
  | "source-capacity"
  | "agent-capacity"
  | "runtime-stopping"
  | "thread-quarantined"
  | "causal-depth"
  | "causal-concurrency"
  | "causal-context-expired"
  | "causal-thread-mismatch";

export interface KeyedTurnSchedulerConfig {
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedPerKey: number;
  maxCausalDepth: number;
  now?: () => number;
}

export interface SchedulerSourcePolicy {
  /** Trusted registration identity. Never derive this from trigger.source. */
  id: string;
  maxConcurrent: number;
  maxQueued: number;
  rateLimitPerPeer?: { maxPerMinute: number };
}

export interface SchedulerSubmitOptions {
  key: string;
  source: SchedulerSourcePolicy;
  peerId?: string;
  signal?: AbortSignal;
}

export interface SchedulerCausalOptions {
  key: string;
  signal?: AbortSignal;
}

export type ScheduledRunResult<T> =
  | { status: "completed"; value: T }
  | {
      status: "rejected";
      reason: SchedulerRejectionReason;
      retryAfterMs?: number;
    }
  | { status: "canceled"; reason: unknown };

export interface TurnSchedulerSnapshot {
  state: SchedulerState;
  activeTurns: number;
  queuedTurns: number;
  activeThreads: number;
  queuedThreads: number;
  quarantinedThreads: number;
  oldestQueueWaitMs: number;
  queueWait: { count: number; totalMs: number; maxMs: number };
  admitted: number;
  settled: number;
  rejected: number;
  canceled: number;
  quarantined: number;
  rejectedByReason: Record<SchedulerRejectionReason, number>;
}

interface RootLeaseState {
  active: boolean;
  quarantined: boolean;
}

export interface KeyedTurnLease {
  readonly key: string;
  readonly depth: number;
  quarantine(): void;
  /** Retain this lane until detached work actually settles. */
  track(work: Promise<unknown>): void;
  /** Wait for work causally owned by this exact lease. */
  join(): Promise<void>;
}

export interface KeyedTurnScheduler {
  registerSource(policy: SchedulerSourcePolicy): void;
  submit<T>(
    options: SchedulerSubmitOptions,
    task: (lease: KeyedTurnLease) => Promise<T>,
  ): Promise<ScheduledRunResult<T>>;
  runCausal<T>(
    parent: KeyedTurnLease,
    options: SchedulerCausalOptions,
    task: (lease: KeyedTurnLease) => Promise<T>,
  ): Promise<ScheduledRunResult<T>>;
  close(): void;
  drain(): Promise<void>;
  reopen(): void;
  recover(key: string): boolean;
  /** Count a kernel-owned rejection that occurs before a causal task can be submitted. */
  recordExternalRejection(reason: SchedulerRejectionReason): void;
  snapshot(): TurnSchedulerSnapshot;
}

interface InternalLease extends KeyedTurnLease {
  readonly schedulerToken: symbol;
  readonly root: RootLeaseState;
  readonly ownedWork: Set<Promise<unknown>>;
  active: boolean;
  childActive: boolean;
}

interface PendingItem {
  readonly key: string;
  readonly source: SchedulerSourcePolicy;
  readonly signal?: AbortSignal;
  readonly task: (lease: KeyedTurnLease) => Promise<unknown>;
  readonly enqueuedAt: number;
  readonly resolve: (result: ScheduledRunResult<unknown>) => void;
  readonly reject: (error: unknown) => void;
  abortListener?: () => void;
  state: "queued" | "active" | "settled";
}

interface SourceState {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly rateLimitPerPeer?: { maxPerMinute: number };
  readonly peerTimestamps: Map<string, number[]>;
  lastPeerSweepAt: number;
  active: number;
  queued: number;
}

function assertSafeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function safeElapsedMs(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function addOperationalCounter(current: number, value = 1): number {
  return Math.min(MAX_OPERATIONAL_COUNTER, current + safeElapsedMs(value));
}

export function createKeyedTurnScheduler(config: KeyedTurnSchedulerConfig): KeyedTurnScheduler {
  assertSafeInteger("maxConcurrent", config.maxConcurrent, 1);
  assertSafeInteger("maxQueued", config.maxQueued, 0);
  assertSafeInteger("maxQueuedPerKey", config.maxQueuedPerKey, 0);
  assertSafeInteger("maxCausalDepth", config.maxCausalDepth, 1);
  if (config.maxQueuedPerKey > config.maxQueued) {
    throw new Error("maxQueuedPerKey cannot exceed maxQueued");
  }

  const now = config.now ?? Date.now;
  const schedulerToken = Symbol("keyed-turn-scheduler");
  const queues = new Map<string, PendingItem[]>();
  const readyKeys: string[] = [];
  const readySet = new Set<string>();
  const activeKeys = new Set<string>();
  const quarantinedKeys = new Set<string>();
  const sources = new Map<string, SourceState>();
  const drainWaiters: Array<() => void> = [];

  let state: SchedulerState = "accepting";
  let activeTurns = 0;
  let queuedTurns = 0;
  let admitted = 0;
  let settled = 0;
  let rejected = 0;
  let canceled = 0;
  let quarantined = 0;
  let queueWaitCount = 0;
  let queueWaitTotalMs = 0;
  let queueWaitMaxMs = 0;
  let rejectedByReason = emptyRejectedByReason();

  function emptyRejectedByReason(): Record<SchedulerRejectionReason, number> {
    return {
      "peer-rate-limit": 0,
      "thread-capacity": 0,
      "source-capacity": 0,
      "agent-capacity": 0,
      "runtime-stopping": 0,
      "thread-quarantined": 0,
      "causal-depth": 0,
      "causal-concurrency": 0,
      "causal-context-expired": 0,
      "causal-thread-mismatch": 0,
    };
  }

  function recordRejection(reason: SchedulerRejectionReason): void {
    rejected++;
    rejectedByReason[reason] = addOperationalCounter(rejectedByReason[reason]);
  }

  function sourceState(policy: SchedulerSourcePolicy): SourceState {
    if (policy.id.trim().length === 0) throw new Error("source id must not be empty");
    assertSafeInteger(`source "${policy.id}" maxConcurrent`, policy.maxConcurrent, 1);
    assertSafeInteger(`source "${policy.id}" maxQueued`, policy.maxQueued, 0);
    if (policy.rateLimitPerPeer) {
      assertSafeInteger(
        `source "${policy.id}" rateLimitPerPeer.maxPerMinute`,
        policy.rateLimitPerPeer.maxPerMinute,
        1,
      );
    }
    const current = sources.get(policy.id);
    if (current) {
      if (
        current.maxConcurrent !== policy.maxConcurrent ||
        current.maxQueued !== policy.maxQueued ||
        current.rateLimitPerPeer?.maxPerMinute !== policy.rateLimitPerPeer?.maxPerMinute
      ) {
        throw new Error(`source policy for "${policy.id}" changed after registration`);
      }
      return current;
    }
    const created: SourceState = {
      maxConcurrent: policy.maxConcurrent,
      maxQueued: policy.maxQueued,
      ...(policy.rateLimitPerPeer ? { rateLimitPerPeer: { ...policy.rateLimitPerPeer } } : {}),
      peerTimestamps: new Map(),
      lastPeerSweepAt: now(),
      active: 0,
      queued: 0,
    };
    sources.set(policy.id, created);
    return created;
  }

  function enqueueReadyKey(key: string): void {
    if (activeKeys.has(key) || readySet.has(key) || (queues.get(key)?.length ?? 0) === 0) return;
    readySet.add(key);
    readyKeys.push(key);
  }

  function removeReadyKey(key: string): void {
    if (!readySet.delete(key)) return;
    const index = readyKeys.indexOf(key);
    if (index >= 0) readyKeys.splice(index, 1);
  }

  function removeQueuedItem(item: PendingItem): boolean {
    if (item.state !== "queued") return false;
    const queue = queues.get(item.key);
    if (!queue) return false;
    const index = queue.indexOf(item);
    if (index < 0) return false;
    queue.splice(index, 1);
    queuedTurns--;
    sourceState(item.source).queued--;
    item.signal?.removeEventListener("abort", item.abortListener!);
    item.abortListener = undefined;
    item.state = "settled";
    if (queue.length === 0) {
      queues.delete(item.key);
      removeReadyKey(item.key);
    }
    return true;
  }

  function rejectItem(
    item: PendingItem,
    reason: SchedulerRejectionReason,
    retryAfterMs?: number,
  ): void {
    if (item.state === "queued") removeQueuedItem(item);
    recordRejection(reason);
    item.resolve({
      status: "rejected",
      reason,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  function cancelItem(item: PendingItem, reason: unknown): void {
    if (!removeQueuedItem(item)) return;
    canceled++;
    item.resolve({ status: "canceled", reason });
  }

  function finishDrainIfIdle(): void {
    if (state !== "draining" || activeTurns !== 0 || queuedTurns !== 0) return;
    state = "stopped";
    for (const resolve of drainWaiters.splice(0)) resolve();
  }

  function quarantineKey(key: string): void {
    if (!quarantinedKeys.has(key)) {
      quarantinedKeys.add(key);
      quarantined++;
    }
    const queue = queues.get(key);
    if (!queue) return;
    for (const item of [...queue]) rejectItem(item, "thread-quarantined");
  }

  function makeLease(key: string, depth: number, root: RootLeaseState): InternalLease {
    const lease: InternalLease = {
      key,
      depth,
      schedulerToken,
      root,
      ownedWork: new Set(),
      active: true,
      childActive: false,
      quarantine() {
        if (!root.active || root.quarantined) return;
        root.quarantined = true;
      },
      track(work) {
        if (!root.active || !lease.active) return;
        const observed = Promise.resolve(work);
        lease.ownedWork.add(observed);
        observed.then(
          () => lease.ownedWork.delete(observed),
          () => lease.ownedWork.delete(observed),
        );
      },
      join() {
        return waitForOwnedWork(lease);
      },
    };
    return lease;
  }

  async function waitForOwnedWork(lease: InternalLease): Promise<void> {
    while (lease.ownedWork.size > 0) {
      await Promise.allSettled([...lease.ownedWork]);
    }
  }

  function startItem(item: PendingItem): void {
    if (item.state === "queued") {
      const waitedMs = safeElapsedMs(now() - item.enqueuedAt);
      queueWaitCount = addOperationalCounter(queueWaitCount);
      queueWaitTotalMs = addOperationalCounter(queueWaitTotalMs, waitedMs);
      queueWaitMaxMs = Math.max(queueWaitMaxMs, waitedMs);
      const queue = queues.get(item.key);
      if (!queue || queue[0] !== item) {
        throw new Error(`scheduler invariant violated for thread "${item.key}"`);
      }
      queue.shift();
      queuedTurns--;
      sourceState(item.source).queued--;
      item.signal?.removeEventListener("abort", item.abortListener!);
      item.abortListener = undefined;
      if (queue.length === 0) queues.delete(item.key);
    }

    item.state = "active";
    activeTurns++;
    activeKeys.add(item.key);
    const source = sourceState(item.source);
    source.active++;
    admitted++;
    const root: RootLeaseState = { active: true, quarantined: false };
    const lease = makeLease(item.key, 0, root);

    const finish = () => {
      root.active = false;
      item.state = "settled";
      activeTurns--;
      activeKeys.delete(item.key);
      source.active--;
      settled++;
      if (root.quarantined) quarantineKey(item.key);
      enqueueReadyKey(item.key);
      dispatch();
      finishDrainIfIdle();
    };

    Promise.resolve()
      .then(() => item.task(lease))
      .then(
        async (value) => {
          await waitForOwnedWork(lease);
          lease.active = false;
          finish();
          item.resolve({ status: "completed", value });
        },
        async (error) => {
          await waitForOwnedWork(lease);
          lease.active = false;
          finish();
          item.reject(error);
        },
      );
  }

  function dispatch(): void {
    if (state === "stopped" || activeTurns >= config.maxConcurrent || readyKeys.length === 0) {
      return;
    }

    let scansRemaining = readyKeys.length;
    while (activeTurns < config.maxConcurrent && readyKeys.length > 0 && scansRemaining > 0) {
      const key = readyKeys.shift()!;
      readySet.delete(key);
      const queue = queues.get(key);
      if (!queue || queue.length === 0 || activeKeys.has(key)) {
        scansRemaining--;
        continue;
      }
      const item = queue[0]!;
      const source = sourceState(item.source);
      if (source.active >= source.maxConcurrent) {
        enqueueReadyKey(key);
        scansRemaining--;
        continue;
      }
      startItem(item);
      scansRemaining = readyKeys.length;
    }
  }

  function canStartImmediately(key: string, source: SourceState): boolean {
    return (
      state === "accepting" &&
      activeTurns < config.maxConcurrent &&
      !activeKeys.has(key) &&
      (queues.get(key)?.length ?? 0) === 0 &&
      source.active < source.maxConcurrent
    );
  }

  function immediateRejected<T>(
    reason: SchedulerRejectionReason,
    retryAfterMs?: number,
  ): Promise<ScheduledRunResult<T>> {
    recordRejection(reason);
    return Promise.resolve({
      status: "rejected",
      reason,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  function peerRateLimit(
    source: SourceState,
    peerId: string | undefined,
  ): { limited: boolean; retryAfterMs?: number } {
    if (!source.rateLimitPerPeer || !peerId) return { limited: false };
    const currentTime = now();
    if (currentTime - source.lastPeerSweepAt >= RATE_LIMIT_WINDOW_MS) {
      const cutoff = currentTime - RATE_LIMIT_WINDOW_MS;
      for (const [trackedPeer, timestamps] of source.peerTimestamps) {
        if ((timestamps.at(-1) ?? 0) <= cutoff) source.peerTimestamps.delete(trackedPeer);
      }
      source.lastPeerSweepAt = currentTime;
    }
    if (
      !source.peerTimestamps.has(peerId) &&
      source.peerTimestamps.size >= MAX_TRACKED_RATE_LIMIT_PEERS_PER_SOURCE
    ) {
      return { limited: true, retryAfterMs: 1_000 };
    }
    const timestamps = (source.peerTimestamps.get(peerId) ?? []).filter(
      (timestamp) => currentTime - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (timestamps.length === 0) source.peerTimestamps.delete(peerId);
    else source.peerTimestamps.set(peerId, timestamps);
    if (timestamps.length < source.rateLimitPerPeer.maxPerMinute) {
      return { limited: false };
    }
    return {
      limited: true,
      retryAfterMs: Math.max(1, RATE_LIMIT_WINDOW_MS - (currentTime - timestamps[0]!)),
    };
  }

  function recordPeerAdmission(source: SourceState, peerId: string | undefined): void {
    if (!source.rateLimitPerPeer || !peerId) return;
    const timestamps = source.peerTimestamps.get(peerId) ?? [];
    timestamps.push(now());
    source.peerTimestamps.set(peerId, timestamps);
  }

  const scheduler: KeyedTurnScheduler = {
    registerSource(policy: SchedulerSourcePolicy): void {
      sourceState(policy);
    },

    submit<T>(
      options: SchedulerSubmitOptions,
      task: (lease: KeyedTurnLease) => Promise<T>,
    ): Promise<ScheduledRunResult<T>> {
      if (options.key.length === 0) return immediateRejected("thread-capacity");
      const source = sourceState(options.source);
      if (options.signal?.aborted) {
        canceled++;
        return Promise.resolve({ status: "canceled", reason: abortReason(options.signal) });
      }
      if (state !== "accepting") return immediateRejected("runtime-stopping");
      if (quarantinedKeys.has(options.key)) return immediateRejected("thread-quarantined");
      const rateLimit = peerRateLimit(source, options.peerId);
      if (rateLimit.limited) {
        return immediateRejected("peer-rate-limit", rateLimit.retryAfterMs);
      }

      return new Promise<ScheduledRunResult<T>>((resolve, rejectPromise) => {
        const item: PendingItem = {
          key: options.key,
          source: options.source,
          ...(options.signal ? { signal: options.signal } : {}),
          task,
          enqueuedAt: now(),
          resolve: (result) => resolve(result as ScheduledRunResult<T>),
          reject: rejectPromise,
          state: "queued",
        };

        if (canStartImmediately(options.key, source)) {
          recordPeerAdmission(source, options.peerId);
          item.state = "active";
          startItem(item);
          return;
        }
        const keyQueued = queues.get(options.key)?.length ?? 0;
        if (keyQueued >= config.maxQueuedPerKey) {
          recordRejection("thread-capacity");
          resolve({ status: "rejected", reason: "thread-capacity" });
          return;
        }
        if (source.queued >= source.maxQueued) {
          recordRejection("source-capacity");
          resolve({ status: "rejected", reason: "source-capacity" });
          return;
        }
        if (queuedTurns >= config.maxQueued) {
          recordRejection("agent-capacity");
          resolve({ status: "rejected", reason: "agent-capacity" });
          return;
        }

        const queue = queues.get(options.key) ?? [];
        queue.push(item);
        queues.set(options.key, queue);
        queuedTurns++;
        source.queued++;
        recordPeerAdmission(source, options.peerId);
        item.abortListener = () => cancelItem(item, abortReason(options.signal!));
        options.signal?.addEventListener("abort", item.abortListener, { once: true });
        enqueueReadyKey(options.key);
        dispatch();
      });
    },

    runCausal<T>(
      parent: KeyedTurnLease,
      options: SchedulerCausalOptions,
      task: (lease: KeyedTurnLease) => Promise<T>,
    ): Promise<ScheduledRunResult<T>> {
      const internal = parent as InternalLease;
      if (
        internal.schedulerToken !== schedulerToken ||
        !internal.root ||
        !internal.root.active ||
        !internal.active ||
        internal.key !== parent.key
      ) {
        return Promise.reject(
          new Error("causal scheduler lease is invalid, inactive, or belongs to another thread"),
        );
      }
      if (parent.key !== options.key) {
        recordRejection("causal-thread-mismatch");
        return Promise.resolve({ status: "rejected", reason: "causal-thread-mismatch" });
      }
      if (options.signal?.aborted) {
        canceled++;
        return Promise.resolve({ status: "canceled", reason: abortReason(options.signal) });
      }
      if (internal.root.quarantined || quarantinedKeys.has(options.key)) {
        recordRejection("thread-quarantined");
        return Promise.resolve({ status: "rejected", reason: "thread-quarantined" });
      }
      if (parent.depth >= config.maxCausalDepth) {
        recordRejection("causal-depth");
        return Promise.resolve({ status: "rejected", reason: "causal-depth" });
      }
      if (internal.childActive) {
        recordRejection("causal-concurrency");
        return Promise.resolve({ status: "rejected", reason: "causal-concurrency" });
      }

      internal.childActive = true;
      admitted++;
      const lease = makeLease(options.key, parent.depth + 1, internal.root);
      const execution = (async (): Promise<ScheduledRunResult<T>> => {
        try {
          const value = await task(lease);
          await waitForOwnedWork(lease);
          return { status: "completed", value };
        } catch (error) {
          await waitForOwnedWork(lease);
          throw error;
        } finally {
          lease.active = false;
          internal.childActive = false;
          settled++;
        }
      })();
      internal.track(execution);
      return execution;
    },

    close(): void {
      if (state !== "accepting") return;
      state = "draining";
      for (const queue of [...queues.values()]) {
        for (const item of [...queue]) rejectItem(item, "runtime-stopping");
      }
      finishDrainIfIdle();
    },

    drain(): Promise<void> {
      if (state === "accepting") throw new Error("scheduler must be closed before drain");
      if (state === "stopped") return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },

    reopen(): void {
      if (state !== "stopped" || activeTurns !== 0 || queuedTurns !== 0) {
        throw new Error("scheduler can reopen only after it has fully stopped");
      }
      for (const source of sources.values()) {
        source.active = 0;
        source.queued = 0;
        source.peerTimestamps.clear();
        source.lastPeerSweepAt = now();
      }
      admitted = 0;
      settled = 0;
      rejected = 0;
      canceled = 0;
      quarantined = 0;
      queueWaitCount = 0;
      queueWaitTotalMs = 0;
      queueWaitMaxMs = 0;
      rejectedByReason = emptyRejectedByReason();
      state = "accepting";
    },

    recover(key: string): boolean {
      return quarantinedKeys.delete(key);
    },

    recordExternalRejection(reason: SchedulerRejectionReason): void {
      recordRejection(reason);
    },

    snapshot(): TurnSchedulerSnapshot {
      let oldestQueueWaitMs = 0;
      if (queuedTurns > 0) {
        let oldest = Infinity;
        for (const queue of queues.values()) {
          for (const item of queue) oldest = Math.min(oldest, item.enqueuedAt);
        }
        oldestQueueWaitMs = safeElapsedMs(now() - oldest);
      }
      return Object.freeze({
        state,
        activeTurns,
        queuedTurns,
        activeThreads: activeKeys.size,
        queuedThreads: queues.size,
        quarantinedThreads: quarantinedKeys.size,
        oldestQueueWaitMs,
        queueWait: Object.freeze({
          count: queueWaitCount,
          totalMs: queueWaitTotalMs,
          maxMs: queueWaitMaxMs,
        }),
        admitted,
        settled,
        rejected,
        canceled,
        quarantined,
        rejectedByReason: Object.freeze({ ...rejectedByReason }),
      });
    },
  };

  return scheduler;
}

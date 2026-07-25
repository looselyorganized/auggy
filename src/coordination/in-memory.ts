import type {
  AdmitResult,
  ClaimResult,
  CoordinationRequestState,
  DistributedCoordinatorConfig,
  DistributedCoordinatorHealth,
  DistributedSourcePolicy,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  LeaseResult,
} from "./types";

interface StoredRequest extends DistributedTurnRequest {
  state: CoordinationRequestState;
  queuedAt: number;
  fence?: number;
  ownerInstance?: string;
  expiresAt?: number;
  executionStarted: boolean;
}

interface StoredThread {
  nextFence: number;
  quarantined: boolean;
  quarantineFence?: number;
}

interface NamespaceState {
  drainingInstances: Set<string>;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedPerThread: number;
  requests: Map<string, StoredRequest>;
  threads: Map<string, StoredThread>;
  sources: Map<string, DistributedSourcePolicy>;
}

const namespaces = new Map<string, NamespaceState>();
let transaction: Promise<void> = Promise.resolve();
const MAX_CAPACITY = 1_000_000;
const MAX_LEASE_MS = 3_600_000;

function assertIdentifier(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`${name} must be a non-secret identifier of at most 160 characters`);
  }
}

function assertLimit(name: string, value: number, minimum: number, maximum = MAX_CAPACITY): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function assertConfig(config: DistributedCoordinatorConfig): void {
  assertIdentifier("namespace", config.namespace);
  assertIdentifier("instanceId", config.instanceId);
  assertLimit("maxConcurrent", config.maxConcurrent, 1);
  assertLimit("maxQueued", config.maxQueued, 0);
  assertLimit("maxQueuedPerThread", config.maxQueuedPerThread, 0);
  if (config.maxQueuedPerThread > config.maxQueued) {
    throw new Error("maxQueuedPerThread cannot exceed maxQueued");
  }
  assertLimit("leaseMs", config.leaseMs, 1, MAX_LEASE_MS);
}

function assertRequest(request: DistributedTurnRequest): void {
  assertIdentifier("requestId", request.requestId);
  assertIdentifier("threadId", request.threadId);
  assertIdentifier("source.id", request.source.id);
  assertLimit("source.maxConcurrent", request.source.maxConcurrent, 1);
  assertLimit("source.maxQueued", request.source.maxQueued, 0);
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(request.bindingHash)) {
    throw new Error("bindingHash must be a one-way canonical request hash");
  }
}

function sameBinding(left: StoredRequest, right: DistributedTurnRequest): boolean {
  return (
    left.threadId === right.threadId &&
    left.source.id === right.source.id &&
    left.bindingHash === right.bindingHash
  );
}

function terminal(
  state: CoordinationRequestState,
): state is Exclude<CoordinationRequestState, "queued" | "active"> {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "outcome_unknown"
  );
}

/** Test seam for repeatable process-replica contract tests. */
export function resetInMemoryDistributedCoordination(): void {
  namespaces.clear();
  transaction = Promise.resolve();
}

/**
 * Process-independent state-machine model. Production uses the Postgres
 * implementation; this adapter makes the exact state transitions testable
 * without silently using process-local coordination in deployment.
 */
export function createInMemoryDistributedTurnCoordinator(
  config: DistributedCoordinatorConfig,
  options: { now?: () => number; failClosed?: () => boolean } = {},
): DistributedTurnCoordinator {
  assertConfig(config);
  const now = options.now ?? Date.now;

  function state(): NamespaceState {
    let value = namespaces.get(config.namespace);
    if (!value) {
      value = {
        drainingInstances: new Set(),
        maxConcurrent: config.maxConcurrent,
        maxQueued: config.maxQueued,
        maxQueuedPerThread: config.maxQueuedPerThread,
        requests: new Map(),
        threads: new Map(),
        sources: new Map(),
      };
      namespaces.set(config.namespace, value);
    }
    return value;
  }

  /** One immutable namespace has one exact fleet policy. Drift fails closed. */
  function namespacePolicy(
    current: NamespaceState,
  ): Pick<NamespaceState, "maxConcurrent" | "maxQueued" | "maxQueuedPerThread"> {
    if (
      current.maxConcurrent !== config.maxConcurrent ||
      current.maxQueued !== config.maxQueued ||
      current.maxQueuedPerThread !== config.maxQueuedPerThread
    ) {
      throw new Error("coordinator namespace policy mismatch");
    }
    return current;
  }

  async function exclusive<T>(operation: () => T): Promise<T> {
    const previous = transaction;
    let release!: () => void;
    transaction = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (options.failClosed?.()) throw new Error("coordinator unavailable");
      return operation();
    } finally {
      release();
    }
  }

  function expire(current: NamespaceState, timestamp: number): void {
    for (const request of current.requests.values()) {
      if (request.state !== "active" || (request.expiresAt ?? Infinity) > timestamp) continue;
      if (request.executionStarted) {
        request.state = "outcome_unknown";
        const thread = current.threads.get(request.threadId)!;
        thread.quarantined = true;
        thread.quarantineFence = request.fence;
      } else {
        request.state = "queued";
        request.ownerInstance = undefined;
        request.expiresAt = undefined;
      }
    }
  }

  /** Source identities and policies are server-owned and immutable within a namespace. */
  function sourcePolicy(
    current: NamespaceState,
    incoming: DistributedSourcePolicy,
  ): DistributedSourcePolicy {
    const existing = current.sources.get(incoming.id);
    if (!existing) {
      const stored = { ...incoming };
      current.sources.set(incoming.id, stored);
      return stored;
    }
    if (
      existing.maxConcurrent !== incoming.maxConcurrent ||
      existing.maxQueued !== incoming.maxQueued
    ) {
      throw new Error("coordinator source policy mismatch");
    }
    return existing;
  }

  function earliestEligibleThreadHead(
    current: NamespaceState,
    requests: Iterable<StoredRequest>,
    active: readonly StoredRequest[],
  ): StoredRequest | undefined {
    const heads = new Map<string, StoredRequest>();
    for (const request of requests) {
      if (request.state !== "queued") continue;
      const prior = heads.get(request.threadId);
      if (
        !prior ||
        request.queuedAt < prior.queuedAt ||
        (request.queuedAt === prior.queuedAt && request.requestId < prior.requestId)
      ) {
        heads.set(request.threadId, request);
      }
    }
    return [...heads.values()]
      .filter((request) => {
        if (active.some((candidate) => candidate.threadId === request.threadId)) return false;
        const policy = current.sources.get(request.source.id);
        if (!policy) return false;
        return (
          active.filter((candidate) => candidate.source.id === request.source.id).length <
          policy.maxConcurrent
        );
      })
      .sort((a, b) => a.queuedAt - b.queuedAt || a.requestId.localeCompare(b.requestId))[0];
  }

  function leaseFrom(request: StoredRequest): DistributedTurnLease {
    if (!request.fence || !request.ownerInstance || !request.expiresAt)
      throw new Error("missing active lease");
    return {
      namespace: config.namespace,
      requestId: request.requestId,
      threadId: request.threadId,
      sourceId: request.source.id,
      instanceId: request.ownerInstance,
      fence: request.fence,
      expiresAt: request.expiresAt,
    };
  }

  function owns(current: NamespaceState, lease: DistributedTurnLease): StoredRequest | undefined {
    if (lease.namespace !== config.namespace || lease.instanceId !== config.instanceId)
      return undefined;
    const request = current.requests.get(lease.requestId);
    if (
      request?.state !== "active" ||
      request.threadId !== lease.threadId ||
      request.source.id !== lease.sourceId ||
      request.fence !== lease.fence ||
      request.ownerInstance !== lease.instanceId ||
      (request.expiresAt ?? 0) <= now()
    ) {
      return undefined;
    }
    return request;
  }

  async function safe<T>(operation: () => Promise<T>, unavailableResult: T): Promise<T> {
    try {
      return await operation();
    } catch {
      return unavailableResult;
    }
  }

  return {
    admit: (request) =>
      safe(
        () =>
          exclusive(() => {
            assertRequest(request);
            const current = state();
            expire(current, now());
            const existing = current.requests.get(request.requestId);
            if (existing)
              return sameBinding(existing, request)
                ? { status: "joined", state: existing.state }
                : { status: "conflict" };
            if (current.drainingInstances.has(config.instanceId))
              return { status: "rejected", reason: "draining" };
            const limits = namespacePolicy(current);
            const policy = sourcePolicy(current, request.source);
            const queued = [...current.requests.values()].filter((item) => item.state === "queued");
            const active = [...current.requests.values()].filter((item) => item.state === "active");
            const thread = current.threads.get(request.threadId);
            if (thread?.quarantined) {
              return { status: "rejected", reason: "thread-quarantined" };
            }
            const threadQueued = queued.filter((item) => item.threadId === request.threadId);
            const threadBusy = active.some((item) => item.threadId === request.threadId);
            const globalDirectSlot =
              queued.length === 0 && active.length < limits.maxConcurrent && !threadBusy;
            const sourceDirectSlot =
              queued.filter((item) => item.source.id === policy.id).length === 0 &&
              active.filter((item) => item.source.id === policy.id).length < policy.maxConcurrent;
            if (queued.length >= limits.maxQueued && !globalDirectSlot)
              return { status: "rejected", reason: "global-capacity" };
            if (
              queued.filter((item) => item.source.id === policy.id).length >= policy.maxQueued &&
              !sourceDirectSlot
            ) {
              return { status: "rejected", reason: "source-capacity" };
            }
            if (
              threadQueued.length >= limits.maxQueuedPerThread &&
              !(threadQueued.length === 0 && globalDirectSlot && sourceDirectSlot)
            ) {
              return { status: "rejected", reason: "thread-capacity" };
            }
            current.requests.set(request.requestId, {
              ...request,
              source: { ...policy },
              state: "queued",
              queuedAt: now(),
              executionStarted: false,
            });
            return { status: "admitted" };
          }),
        { status: "unavailable" } as AdmitResult,
      ),
    claim: (request) =>
      safe(
        () =>
          exclusive(() => {
            assertRequest(request);
            const current = state();
            const limits = namespacePolicy(current);
            const timestamp = now();
            expire(current, timestamp);
            const stored = current.requests.get(request.requestId);
            if (!stored || !sameBinding(stored, request)) return { status: "conflict" };
            if (terminal(stored.state))
              return stored.state === "outcome_unknown"
                ? { status: "quarantined" }
                : { status: "terminal", state: stored.state };
            if (stored.state === "active") return { status: "waiting" };
            if (current.drainingInstances.has(config.instanceId)) return { status: "waiting" };
            const thread = current.threads.get(stored.threadId) ?? {
              nextFence: 0,
              quarantined: false,
            };
            current.threads.set(stored.threadId, thread);
            if (thread.quarantined) return { status: "quarantined" };
            const active = [...current.requests.values()].filter((item) => item.state === "active");
            const policy = sourcePolicy(current, stored.source);
            if (active.some((item) => item.threadId === stored.threadId))
              return { status: "waiting" };
            if (
              active.length >= limits.maxConcurrent ||
              active.filter((item) => item.source.id === stored.source.id).length >=
                policy.maxConcurrent
            )
              return { status: "waiting" };
            const threadHead = [...current.requests.values()]
              .filter((item) => item.state === "queued" && item.threadId === stored.threadId)
              .sort((a, b) => a.queuedAt - b.queuedAt || a.requestId.localeCompare(b.requestId))[0];
            if (threadHead !== stored) return { status: "waiting" };
            const fairHead = earliestEligibleThreadHead(current, current.requests.values(), active);
            if (fairHead !== stored) return { status: "waiting" };
            thread.nextFence++;
            stored.state = "active";
            stored.fence = thread.nextFence;
            stored.ownerInstance = config.instanceId;
            stored.expiresAt = timestamp + config.leaseMs;
            stored.executionStarted = false;
            return { status: "acquired", lease: leaseFrom(stored) };
          }),
        { status: "unavailable" } as ClaimResult,
      ),
    markExecutionStarted: (lease) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const current = state();
            expire(current, now());
            const stored = owns(current, lease);
            if (!stored) return { status: "stale" };
            stored.executionStarted = true;
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    heartbeat: (lease) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const current = state();
            expire(current, now());
            const stored = owns(current, lease);
            if (!stored) return { status: "stale" };
            stored.expiresAt = now() + config.leaseMs;
            return { status: "ok", lease: leaseFrom(stored) };
          }),
        { status: "unavailable" },
      ),
    complete: (lease) => settle("completed", lease),
    fail: (lease) => settle("failed", lease),
    cancel: (request) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const current = state();
            expire(current, now());
            const stored = current.requests.get(request.requestId);
            if (!stored || stored.bindingHash !== request.bindingHash || stored.state !== "queued")
              return { status: "stale" };
            stored.state = "canceled";
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    recover: (threadId, expectedFence, reason) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            assertIdentifier("threadId", threadId);
            if (reason.trim().length < 3 || reason.length > 160)
              throw new Error("recovery reason must be a concise operator audit record");
            const current = state();
            const thread = current.threads.get(threadId);
            if (!thread?.quarantined || thread.quarantineFence !== expectedFence)
              return { status: "stale" };
            thread.quarantined = false;
            thread.quarantineFence = undefined;
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    setDraining: (draining) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const current = state();
            if (draining) current.drainingInstances.add(config.instanceId);
            else current.drainingInstances.delete(config.instanceId);
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    health: () =>
      safe(
        () =>
          exclusive(() => {
            const current = state();
            expire(current, now());
            const values = [...current.requests.values()];
            return {
              status: current.drainingInstances.has(config.instanceId) ? "draining" : "healthy",
              active: values.filter((item) => item.state === "active").length,
              queued: values.filter((item) => item.state === "queued").length,
              quarantined: [...current.threads.values()].filter((thread) => thread.quarantined)
                .length,
            };
          }),
        {
          status: "unavailable",
          active: 0,
          queued: 0,
          quarantined: 0,
        } as DistributedCoordinatorHealth,
      ),
  };

  function settle(
    stateName: "completed" | "failed",
    lease: DistributedTurnLease,
  ): Promise<LeaseResult> {
    return safe<LeaseResult>(
      () =>
        exclusive(() => {
          const current = state();
          expire(current, now());
          const stored = owns(current, lease);
          if (!stored) return { status: "stale" };
          stored.state = stateName;
          stored.expiresAt = undefined;
          return { status: "ok" };
        }),
      { status: "unavailable" },
    );
  }
}

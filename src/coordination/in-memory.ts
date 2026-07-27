import type {
  AdmitResult,
  ClaimResult,
  CoordinationOutcomeUnknownReason,
  CoordinationRequestState,
  DistributedCoordinationEvent,
  DistributedCoordinatorConfig,
  DistributedCoordinatorHealth,
  DistributedEventPage,
  DistributedPruneResult,
  DistributedReplayResult,
  DistributedRequestStatus,
  DistributedSourcePolicy,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  LeaseResult,
  RegistrationResult,
} from "./types";

interface StoredRequest extends DistributedTurnRequest {
  state: CoordinationRequestState;
  queuedAt: number;
  fence?: number;
  ownerInstance?: string;
  ownerSession?: string;
  expiresAt?: number;
  executionStarted: boolean;
  result?: DistributedReplayResult;
  queueOwnerInstance?: string;
  queueOwnerSession?: string;
  queueGeneration: number;
  queueExpiresAt?: number;
  terminalAt?: number;
}

interface StoredInstance {
  sessionId: string;
  buildFingerprint: string;
  accepting: boolean;
  draining: boolean;
  expiresAt: number;
  registeredAt: number;
}

interface StoredThread {
  nextFence: number;
  quarantined: boolean;
  quarantineFence?: number;
}

interface StoredEvent extends DistributedCoordinationEvent {
  createdAtMs: number;
  numericId: bigint;
}

interface LocalOwnedOperation {
  bindingHash: string;
  controller: AbortController;
  phase: "queued" | "active";
  sourceId: string;
  threadId: string;
}

interface NamespaceState {
  events: StoredEvent[];
  instances: Map<string, StoredInstance>;
  leaseMs: number;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedPerThread: number;
  nextEventId: bigint;
  nextFence: number;
  retention: DistributedCoordinatorConfig["retention"];
  result: DistributedCoordinatorConfig["result"];
  compatibility: DistributedCoordinatorConfig["compatibility"];
  requests: Map<string, StoredRequest>;
  threads: Map<string, StoredThread>;
  sources: Map<string, DistributedSourcePolicy>;
}

const namespaces = new Map<string, NamespaceState>();
let transaction: Promise<void> = Promise.resolve();
const MAX_CAPACITY = 1_000_000;
const MAX_LEASE_MS = 3_600_000;
const MAX_EVENT_PAGE = 500;
const MAX_PRUNE_BATCH = 1_000;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const OUTCOME_UNKNOWN_REASONS = new Set<CoordinationOutcomeUnknownReason>([
  "coordinator-unavailable",
  "effect-outcome-unknown",
  "execution-failed-after-start",
  "lease-lost",
]);

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
  if (!/^[0-9a-f]{64}$/.test(config.buildFingerprint)) {
    throw new Error("buildFingerprint must be a secret-free SHA-256 digest");
  }
  assertLimit("maxConcurrent", config.maxConcurrent, 1);
  assertLimit("maxQueued", config.maxQueued, 0);
  assertLimit("maxQueuedPerThread", config.maxQueuedPerThread, 0);
  if (config.maxQueuedPerThread > config.maxQueued) {
    throw new Error("maxQueuedPerThread cannot exceed maxQueued");
  }
  assertLimit("leaseMs", config.leaseMs, 1, MAX_LEASE_MS);
  assertLimit(
    "retention.terminalRequestRetentionMs",
    config.retention.terminalRequestRetentionMs,
    60_000,
    31_536_000_000,
  );
  assertLimit("retention.maxTerminalRequests", config.retention.maxTerminalRequests, 1);
  assertLimit(
    "retention.eventRetentionMs",
    config.retention.eventRetentionMs,
    60_000,
    31_536_000_000,
  );
  assertLimit("retention.maxEvents", config.retention.maxEvents, 1);
  assertLimit("result.maxReplayBytes", config.result.maxReplayBytes, 1_024, 1_048_576);
  assertLimit("compatibility.protocolVersion", config.compatibility.protocolVersion, 1);
  if (
    !/^[0-9a-f]{64}$/.test(config.compatibility.protocolFingerprint) ||
    !/^[0-9a-f]{64}$/.test(config.compatibility.configurationFingerprint)
  ) {
    throw new Error("coordinator compatibility fingerprints are invalid");
  }
  if (!Array.isArray(config.sources) || config.sources.length > 256) {
    throw new Error("coordinator sources exceed supported bounds");
  }
  const sourceIds = new Set<string>();
  for (const source of config.sources) {
    assertIdentifier("source.id", source.id);
    assertLimit("source.maxConcurrent", source.maxConcurrent, 1);
    assertLimit("source.maxQueued", source.maxQueued, 0);
    if (sourceIds.has(source.id)) throw new Error("coordinator source ids must be unique");
    sourceIds.add(source.id);
  }
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
  const sessionId = crypto.randomUUID();
  const owned = new Map<string, LocalOwnedOperation>();

  function trackOwned(request: DistributedTurnRequest, phase: "queued" | "active"): void {
    const existing = owned.get(request.requestId);
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.bindingHash === request.bindingHash &&
      existing.threadId === request.threadId &&
      existing.sourceId === request.source.id
    ) {
      existing.phase = phase;
      return;
    }
    existing?.controller.abort("ownership-replaced");
    owned.set(request.requestId, {
      bindingHash: request.bindingHash,
      controller: new AbortController(),
      phase,
      sourceId: request.source.id,
      threadId: request.threadId,
    });
  }

  function abortOwned(requestId: string, reason: string): void {
    const operation = owned.get(requestId);
    if (!operation) return;
    operation.controller.abort(reason);
    owned.delete(requestId);
  }

  function abortOwnedPhase(phase: LocalOwnedOperation["phase"], reason: string): void {
    for (const [requestId, operation] of owned) {
      if (operation.phase === phase) abortOwned(requestId, reason);
    }
  }

  function abortAllOwned(reason: string): void {
    for (const requestId of [...owned.keys()]) abortOwned(requestId, reason);
  }

  function unavailableSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort("not-owned");
    return controller.signal;
  }

  function copyReplayResult(result: DistributedReplayResult): DistributedReplayResult {
    return { body: new Uint8Array(result.body), contentType: result.contentType };
  }

  function validReplayResult(result: DistributedReplayResult): boolean {
    if (result.contentType !== "application/json" || !(result.body instanceof Uint8Array)) {
      return false;
    }
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
      return true;
    } catch {
      return false;
    }
  }

  async function waitDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", aborted);
        resolve(true);
      }, milliseconds);
      const aborted = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        resolve(false);
      };
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  function state(create = false): NamespaceState | undefined {
    let value = namespaces.get(config.namespace);
    if (!value && create) {
      value = {
        events: [],
        instances: new Map(),
        leaseMs: config.leaseMs,
        maxConcurrent: config.maxConcurrent,
        maxQueued: config.maxQueued,
        maxQueuedPerThread: config.maxQueuedPerThread,
        nextEventId: 0n,
        nextFence: 0,
        retention: { ...config.retention },
        result: { ...config.result },
        compatibility: { ...config.compatibility },
        requests: new Map(),
        threads: new Map(),
        sources: new Map(config.sources.map((source) => [source.id, { ...source }])),
      };
      namespaces.set(config.namespace, value);
    } else if (value) {
      namespacePolicy(value);
    }
    return value;
  }

  /** One immutable namespace has one exact fleet policy. Drift fails closed. */
  function namespacePolicy(
    current: NamespaceState,
  ): Pick<NamespaceState, "maxConcurrent" | "maxQueued" | "maxQueuedPerThread"> {
    const sourcesMatch =
      current.sources.size === config.sources.length &&
      config.sources.every((source) => {
        const stored = current.sources.get(source.id);
        return (
          stored?.maxConcurrent === source.maxConcurrent && stored.maxQueued === source.maxQueued
        );
      });
    if (
      current.maxConcurrent !== config.maxConcurrent ||
      current.leaseMs !== config.leaseMs ||
      current.maxQueued !== config.maxQueued ||
      current.maxQueuedPerThread !== config.maxQueuedPerThread ||
      current.retention.terminalRequestRetentionMs !==
        config.retention.terminalRequestRetentionMs ||
      current.retention.maxTerminalRequests !== config.retention.maxTerminalRequests ||
      current.retention.eventRetentionMs !== config.retention.eventRetentionMs ||
      current.retention.maxEvents !== config.retention.maxEvents ||
      current.result.maxReplayBytes !== config.result.maxReplayBytes ||
      current.compatibility.protocolVersion !== config.compatibility.protocolVersion ||
      current.compatibility.protocolFingerprint !== config.compatibility.protocolFingerprint ||
      current.compatibility.configurationFingerprint !==
        config.compatibility.configurationFingerprint ||
      !sourcesMatch
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
        quarantine(current, request, timestamp, "lease-lost");
      } else {
        request.state = "queued";
        request.fence = undefined;
        request.ownerInstance = undefined;
        request.ownerSession = undefined;
        request.expiresAt = undefined;
        request.queueGeneration++;
        request.queueOwnerInstance = undefined;
        request.queueOwnerSession = undefined;
        request.queueExpiresAt = undefined;
      }
    }
  }

  /** Trusted runtime integration provisions immutable source policy per namespace. */
  function sourcePolicy(
    current: NamespaceState,
    incoming: DistributedSourcePolicy,
  ): DistributedSourcePolicy {
    const existing = current.sources.get(incoming.id);
    if (!existing) throw new Error("coordinator source is not provisioned");
    if (
      existing.maxConcurrent !== incoming.maxConcurrent ||
      existing.maxQueued !== incoming.maxQueued
    ) {
      throw new Error("coordinator source policy mismatch");
    }
    return existing;
  }

  function liveInstance(
    current: NamespaceState,
    timestamp: number,
    requireAccepting = false,
  ): StoredInstance | undefined {
    const instance = current.instances.get(config.instanceId);
    if (
      !instance ||
      instance.sessionId !== sessionId ||
      instance.buildFingerprint !== config.buildFingerprint ||
      instance.expiresAt <= timestamp ||
      (requireAccepting && (!instance.accepting || instance.draining))
    ) {
      return undefined;
    }
    return instance;
  }

  function sameQueueOwner(request: StoredRequest): boolean {
    return (
      request.queueOwnerInstance === config.instanceId && request.queueOwnerSession === sessionId
    );
  }

  function abandonExpiredQueued(
    current: NamespaceState,
    timestamp: number,
    exceptRequestId?: string,
  ): void {
    for (const request of current.requests.values()) {
      if (
        request.requestId === exceptRequestId ||
        request.state !== "queued" ||
        (request.queueExpiresAt ?? 0) > timestamp
      ) {
        continue;
      }
      request.state = "canceled";
      request.terminalAt = timestamp;
      request.queueOwnerInstance = undefined;
      request.queueOwnerSession = undefined;
      request.queueExpiresAt = undefined;
    }
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

  function owns(
    current: NamespaceState,
    lease: DistributedTurnLease,
    timestamp: number,
  ): StoredRequest | undefined {
    if (lease.namespace !== config.namespace || lease.instanceId !== config.instanceId)
      return undefined;
    const request = current.requests.get(lease.requestId);
    if (
      request?.state !== "active" ||
      request.threadId !== lease.threadId ||
      request.source.id !== lease.sourceId ||
      request.fence !== lease.fence ||
      request.ownerInstance !== lease.instanceId ||
      request.ownerSession !== sessionId ||
      (request.expiresAt ?? 0) <= timestamp
    ) {
      return undefined;
    }
    return request;
  }

  function operationalState(timestamp: number, requireAccepting = false): NamespaceState {
    const current = state();
    if (!current || !liveInstance(current, timestamp, requireAccepting)) {
      throw new Error("coordinator instance is not registered");
    }
    return current;
  }

  function quarantine(
    current: NamespaceState,
    request: StoredRequest,
    timestamp: number,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): void {
    request.state = "outcome_unknown";
    request.terminalAt = timestamp;
    request.ownerInstance = undefined;
    request.ownerSession = undefined;
    request.expiresAt = undefined;
    const thread = current.threads.get(request.threadId);
    if (!thread) throw new Error("missing active thread");
    thread.quarantined = true;
    thread.quarantineFence = request.fence;
    recordEvent(
      current,
      {
        eventType: "outcome_unknown",
        fence: request.fence,
        reasonCode,
        requestId: request.requestId,
        threadId: request.threadId,
      },
      timestamp,
    );
  }

  function recordEvent(
    current: NamespaceState,
    event: Omit<DistributedCoordinationEvent, "createdAt" | "eventId">,
    timestamp: number,
  ): void {
    current.nextEventId++;
    current.events.push({
      ...event,
      createdAt: new Date(timestamp).toISOString(),
      createdAtMs: timestamp,
      eventId: current.nextEventId.toString(),
      numericId: current.nextEventId,
    });
  }

  async function safe<T>(
    operation: () => Promise<T>,
    unavailableResult: T,
    observe?: (result: T) => void,
  ): Promise<T> {
    try {
      const result = await operation();
      observe?.(result);
      return result;
    } catch {
      observe?.(unavailableResult);
      return unavailableResult;
    }
  }

  return {
    register: () =>
      safe<RegistrationResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state(true)!;
            const existing = current.instances.get(config.instanceId);
            if (existing) {
              if (
                existing.sessionId !== sessionId ||
                existing.buildFingerprint !== config.buildFingerprint ||
                existing.expiresAt <= timestamp
              ) {
                return { status: "conflict" };
              }
              existing.expiresAt = timestamp + config.leaseMs;
              return { status: "registered" };
            }
            current.instances.set(config.instanceId, {
              sessionId,
              buildFingerprint: config.buildFingerprint,
              accepting: true,
              draining: false,
              expiresAt: timestamp + config.leaseMs,
              registeredAt: timestamp,
            });
            return { status: "registered" };
          }),
        { status: "unavailable" },
      ),
    heartbeatInstance: () =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current) return { status: "stale" };
            const instance = liveInstance(current, timestamp);
            if (!instance) return { status: "stale" };
            instance.expiresAt = timestamp + config.leaseMs;
            return { status: "ok" };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status !== "ok") abortAllOwned("coordinator-authority-lost");
        },
      ),
    admit: (request) =>
      safe(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = operationalState(timestamp);
            expire(current, timestamp);
            const existing = current.requests.get(request.requestId);
            if (existing) {
              if (!sameBinding(existing, request)) return { status: "conflict" };
              if (existing.state === "queued" && (existing.queueExpiresAt ?? 0) <= timestamp) {
                const accepting = liveInstance(current, timestamp, true);
                if (!accepting) return { status: "rejected", reason: "draining" };
                existing.queueOwnerInstance = config.instanceId;
                existing.queueOwnerSession = sessionId;
                existing.queueGeneration++;
                existing.queueExpiresAt = timestamp + config.leaseMs;
                trackOwned(request, "queued");
                return { status: "adopted" };
              }
              return { status: "joined", state: existing.state };
            }
            if (!liveInstance(current, timestamp, true))
              return { status: "rejected", reason: "draining" };
            const limits = namespacePolicy(current);
            if (
              [...current.requests.values()].filter((item) => item.state === "outcome_unknown")
                .length >= current.retention.maxTerminalRequests
            ) {
              return { status: "rejected", reason: "incident-capacity" };
            }
            const policy = sourcePolicy(current, request.source);
            abandonExpiredQueued(current, timestamp);
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
              queuedAt: timestamp,
              executionStarted: false,
              queueOwnerInstance: config.instanceId,
              queueOwnerSession: sessionId,
              queueGeneration: 1,
              queueExpiresAt: timestamp + config.leaseMs,
            });
            trackOwned(request, "queued");
            return { status: "admitted" };
          }),
        { status: "unavailable" } as AdmitResult,
      ),
    heartbeatQueued: (request) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const stored = current.requests.get(request.requestId);
            if (
              !stored ||
              !sameBinding(stored, request) ||
              stored.state !== "queued" ||
              !sameQueueOwner(stored) ||
              (stored.queueExpiresAt ?? 0) <= timestamp
            ) {
              return { status: "stale" };
            }
            stored.queueExpiresAt = timestamp + config.leaseMs;
            return { status: "ok" };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status !== "ok") abortOwned(request.requestId, "queue-ownership-lost");
        },
      ),
    abandon: (request) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const stored = current.requests.get(request.requestId);
            if (
              !stored ||
              !sameBinding(stored, request) ||
              stored.state !== "queued" ||
              !sameQueueOwner(stored) ||
              (stored.queueExpiresAt ?? 0) <= timestamp
            ) {
              return { status: "stale" };
            }
            stored.state = "canceled";
            stored.terminalAt = timestamp;
            stored.queueOwnerInstance = undefined;
            stored.queueOwnerSession = undefined;
            stored.queueExpiresAt = undefined;
            return { status: "ok" };
          }),
        { status: "unavailable" },
        () => abortOwned(request.requestId, "queue-abandoned"),
      ),
    claim: (request) =>
      safe(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = operationalState(timestamp);
            const limits = namespacePolicy(current);
            expire(current, timestamp);
            const stored = current.requests.get(request.requestId);
            if (!stored || !sameBinding(stored, request)) return { status: "conflict" };
            if (terminal(stored.state))
              return stored.state === "outcome_unknown"
                ? { status: "quarantined" }
                : { status: "terminal", state: stored.state };
            if (stored.state === "active") return { status: "waiting" };
            if (!sameQueueOwner(stored) || (stored.queueExpiresAt ?? 0) <= timestamp) {
              if (!sameQueueOwner(stored) && (stored.queueExpiresAt ?? 0) > timestamp) {
                return { status: "waiting" };
              }
              if (!liveInstance(current, timestamp, true)) return { status: "waiting" };
              stored.queueOwnerInstance = config.instanceId;
              stored.queueOwnerSession = sessionId;
              stored.queueGeneration++;
              stored.queueExpiresAt = timestamp + config.leaseMs;
            }
            abandonExpiredQueued(current, timestamp, stored.requestId);
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
            current.nextFence++;
            thread.nextFence = current.nextFence;
            stored.state = "active";
            stored.fence = current.nextFence;
            stored.ownerInstance = config.instanceId;
            stored.ownerSession = sessionId;
            stored.expiresAt = timestamp + config.leaseMs;
            stored.executionStarted = false;
            stored.queueOwnerInstance = undefined;
            stored.queueOwnerSession = undefined;
            stored.queueExpiresAt = undefined;
            trackOwned(request, "active");
            return { status: "acquired", lease: leaseFrom(stored) };
          }),
        { status: "unavailable" } as ClaimResult,
      ),
    ownedSignal: (request) => {
      try {
        assertRequest(request);
      } catch {
        return unavailableSignal();
      }
      const operation = owned.get(request.requestId);
      return operation &&
        operation.bindingHash === request.bindingHash &&
        operation.threadId === request.threadId &&
        operation.sourceId === request.source.id
        ? operation.controller.signal
        : unavailableSignal();
    },
    markExecutionStarted: (lease) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored) return { status: "stale" };
            stored.executionStarted = true;
            return { status: "ok" };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status !== "ok") abortOwned(lease.requestId, "lease-ownership-lost");
        },
      ),
    heartbeat: (lease) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored) return { status: "stale" };
            stored.expiresAt = timestamp + config.leaseMs;
            return { status: "ok", lease: leaseFrom(stored) };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status !== "ok") abortOwned(lease.requestId, "lease-ownership-lost");
        },
      ),
    complete: (lease, result) => {
      if (!validReplayResult(result)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-result" });
      }
      if (result.body.byteLength > config.result.maxReplayBytes) {
        return Promise.resolve({ status: "rejected", reason: "result-too-large" });
      }
      return settle("completed", lease, copyReplayResult(result));
    },
    fail: (lease) => settle("failed", lease),
    markOutcomeUnknown: (lease, reasonCode) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            if (!OUTCOME_UNKNOWN_REASONS.has(reasonCode)) {
              throw new Error("invalid outcome-unknown reason code");
            }
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored) return { status: "stale" };
            quarantine(current, stored, timestamp, reasonCode);
            return { status: "outcome-unknown" };
          }),
        { status: "unavailable" },
        (result) =>
          abortOwned(
            lease.requestId,
            result.status === "outcome-unknown"
              ? "outcome-unknown"
              : result.status === "unavailable"
                ? "coordinator-authority-lost"
                : "lease-ownership-lost",
          ),
      ),
    status: (request) =>
      safe<DistributedRequestStatus>(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = operationalState(timestamp);
            expire(current, timestamp);
            const stored = current.requests.get(request.requestId);
            if (!stored) return { status: "missing" };
            if (!sameBinding(stored, request)) return { status: "conflict" };
            if (stored.state === "queued" || stored.state === "active") {
              return { status: "pending", state: stored.state };
            }
            if (stored.state === "outcome_unknown") return { status: "quarantined" };
            if (stored.state === "completed") {
              if (!stored.result) throw new Error("missing completed replay result");
              return { status: "completed", result: copyReplayResult(stored.result) };
            }
            return { status: "terminal", state: stored.state };
          }),
        { status: "unavailable" },
      ),
    wait: async (request, waitOptions) => {
      if (
        !Number.isSafeInteger(waitOptions.timeoutMs) ||
        waitOptions.timeoutMs < 0 ||
        waitOptions.timeoutMs > 300_000 ||
        !Number.isSafeInteger(waitOptions.pollMs) ||
        waitOptions.pollMs < 10 ||
        waitOptions.pollMs > 1_000
      ) {
        return { status: "unavailable" };
      }
      const deadline = Date.now() + waitOptions.timeoutMs;
      while (true) {
        if (waitOptions.signal?.aborted) return { status: "wait-aborted" };
        const result = await (async () => {
          assertRequest(request);
          const timestamp = now();
          return safe<DistributedRequestStatus>(
            () =>
              exclusive(() => {
                const current = operationalState(timestamp);
                expire(current, timestamp);
                const stored = current.requests.get(request.requestId);
                if (!stored) return { status: "missing" };
                if (!sameBinding(stored, request)) return { status: "conflict" };
                if (stored.state === "queued" || stored.state === "active") {
                  return { status: "pending", state: stored.state };
                }
                if (stored.state === "outcome_unknown") return { status: "quarantined" };
                if (stored.state === "completed") {
                  if (!stored.result) throw new Error("missing completed replay result");
                  return { status: "completed", result: copyReplayResult(stored.result) };
                }
                return { status: "terminal", state: stored.state };
              }),
            { status: "unavailable" },
          );
        })().catch(() => ({ status: "unavailable" }) as DistributedRequestStatus);
        if (result.status !== "pending") return result;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { status: "wait-timeout" };
        if (!(await waitDelay(Math.min(waitOptions.pollMs, remaining), waitOptions.signal))) {
          return { status: "wait-aborted" };
        }
      }
    },
    events: (eventOptions) =>
      safe<DistributedEventPage>(
        () =>
          exclusive(() => {
            assertLimit("events.limit", eventOptions.limit, 1, MAX_EVENT_PAGE);
            let afterEventId = 0n;
            if (eventOptions.afterEventId !== undefined) {
              if (!/^(0|[1-9][0-9]{0,18})$/.test(eventOptions.afterEventId)) {
                throw new Error("afterEventId must be a canonical non-negative bigint");
              }
              afterEventId = BigInt(eventOptions.afterEventId);
              if (afterEventId > MAX_BIGINT) throw new Error("afterEventId exceeds bigint range");
            }
            const current = operationalState(now());
            const page = current.events
              .filter((event) => event.numericId > afterEventId)
              .slice(0, eventOptions.limit);
            return {
              status: "ok",
              events: page.map(
                ({ createdAtMs: _createdAtMs, numericId: _numericId, ...event }) => ({
                  ...event,
                }),
              ),
              ...(page.length > 0 ? { nextEventId: page.at(-1)!.eventId } : {}),
            };
          }),
        { status: "unavailable" },
      ),
    prune: (batchSize) =>
      safe<DistributedPruneResult>(
        () =>
          exclusive(() => {
            assertLimit("prune.batchSize", batchSize, 1, MAX_PRUNE_BATCH);
            const timestamp = now();
            const current = operationalState(timestamp);
            expire(current, timestamp);
            abandonExpiredQueued(current, timestamp);

            const terminalRequests = [...current.requests.values()]
              .filter(
                (request) =>
                  request.state === "completed" ||
                  request.state === "failed" ||
                  request.state === "canceled",
              )
              .sort(
                (left, right) =>
                  (left.terminalAt ?? 0) - (right.terminalAt ?? 0) ||
                  left.requestId.localeCompare(right.requestId),
              );
            const requestOverflow = Math.max(
              0,
              terminalRequests.length - current.retention.maxTerminalRequests,
            );
            const removableRequests = terminalRequests
              .filter(
                (request, index) =>
                  (request.terminalAt ?? timestamp) <=
                    timestamp - current.retention.terminalRequestRetentionMs ||
                  index < requestOverflow,
              )
              .slice(0, batchSize);
            for (const request of removableRequests) current.requests.delete(request.requestId);

            const referencedThreadIds = new Set(
              [...current.requests.values()].map((request) => request.threadId),
            );
            const removableThreads = [...current.threads.entries()]
              .filter(
                ([threadId, thread]) => !thread.quarantined && !referencedThreadIds.has(threadId),
              )
              .sort(([left], [right]) => left.localeCompare(right))
              .slice(0, batchSize);
            for (const [threadId] of removableThreads) current.threads.delete(threadId);

            const protectedRequestIds = new Set(
              [...current.requests.values()]
                .filter((request) => request.state === "outcome_unknown")
                .map((request) => request.requestId),
            );
            const eligibleEvents = current.events.filter(
              (event) => !event.requestId || !protectedRequestIds.has(event.requestId),
            );
            const eventOverflow = Math.max(0, eligibleEvents.length - current.retention.maxEvents);
            const removableEventIds = new Set(
              eligibleEvents
                .filter(
                  (event, index) =>
                    event.createdAtMs <= timestamp - current.retention.eventRetentionMs ||
                    index < eventOverflow,
                )
                .slice(0, batchSize)
                .map((event) => event.numericId),
            );
            current.events = current.events.filter(
              (event) => !removableEventIds.has(event.numericId),
            );

            const referencedSessions = new Set<string>();
            for (const request of current.requests.values()) {
              if (request.ownerSession) referencedSessions.add(request.ownerSession);
              if (request.queueOwnerSession) referencedSessions.add(request.queueOwnerSession);
            }
            const removableInstances = [...current.instances.entries()]
              .filter(
                ([instanceId, instance]) =>
                  instanceId !== config.instanceId &&
                  instance.expiresAt <= timestamp &&
                  !referencedSessions.has(instance.sessionId),
              )
              .sort(
                ([leftId, left], [rightId, right]) =>
                  left.registeredAt - right.registeredAt || leftId.localeCompare(rightId),
              )
              .slice(0, batchSize);
            for (const [instanceId] of removableInstances) current.instances.delete(instanceId);

            return {
              status: "ok",
              events: removableEventIds.size,
              instances: removableInstances.length,
              requests: removableRequests.length,
              threads: removableThreads.length,
            };
          }),
        { status: "unavailable" },
      ),
    recover: (threadId, expectedFence, reason) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            assertIdentifier("threadId", threadId);
            if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reason)) {
              throw new Error("recovery reason must be a fixed secret-free reason code");
            }
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const thread = current.threads.get(threadId);
            if (!thread?.quarantined || thread.quarantineFence !== expectedFence)
              return { status: "stale" };
            const incident = [...current.requests.values()].find(
              (request) =>
                request.threadId === threadId &&
                request.fence === expectedFence &&
                request.state === "outcome_unknown",
            );
            if (!incident) return { status: "stale" };
            incident.state = "failed";
            incident.terminalAt = timestamp;
            thread.quarantined = false;
            thread.quarantineFence = undefined;
            recordEvent(
              current,
              {
                eventType: "operator_recovery",
                fence: expectedFence,
                reasonCode: reason,
                requestId: incident.requestId,
                threadId,
              },
              timestamp,
            );
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    beginDrain: () =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const instance = liveInstance(current, timestamp);
            if (!instance) return { status: "stale" };
            instance.accepting = false;
            instance.draining = true;
            for (const request of current.requests.values()) {
              if (request.state !== "queued" || !sameQueueOwner(request)) continue;
              request.state = "canceled";
              request.terminalAt = timestamp;
              request.queueOwnerInstance = undefined;
              request.queueOwnerSession = undefined;
              request.queueExpiresAt = undefined;
            }
            return { status: "ok" };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status === "ok") abortOwnedPhase("queued", "draining");
          else abortAllOwned("coordinator-authority-lost");
        },
      ),
    health: () =>
      safe(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = operationalState(timestamp);
            expire(current, timestamp);
            abandonExpiredQueued(current, timestamp);
            const values = [...current.requests.values()];
            const instance = liveInstance(current, timestamp)!;
            return {
              status: instance.draining ? "draining" : "healthy",
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
        (result) => {
          if (result.status === "unavailable") abortAllOwned("coordinator-authority-lost");
        },
      ),
    close: async () => abortAllOwned("coordinator-closed"),
  };

  function settle(
    stateName: "completed" | "failed",
    lease: DistributedTurnLease,
    result?: DistributedReplayResult,
  ): Promise<LeaseResult> {
    return safe<LeaseResult>(
      () =>
        exclusive(() => {
          const timestamp = now();
          const current = state();
          if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
          expire(current, timestamp);
          const stored = owns(current, lease, timestamp);
          if (!stored) return { status: "stale" };
          if (stateName === "failed" && stored.executionStarted) {
            quarantine(current, stored, timestamp, "execution-failed-after-start");
            return { status: "outcome-unknown" };
          }
          stored.state = stateName;
          stored.terminalAt = timestamp;
          stored.ownerInstance = undefined;
          stored.ownerSession = undefined;
          stored.expiresAt = undefined;
          stored.result = result;
          return { status: "ok" };
        }),
      { status: "unavailable" },
      (result) =>
        abortOwned(
          lease.requestId,
          result.status === "ok"
            ? "settled"
            : result.status === "outcome-unknown"
              ? "outcome-unknown"
              : result.status === "unavailable"
                ? "coordinator-authority-lost"
                : "lease-ownership-lost",
        ),
    );
  }
}

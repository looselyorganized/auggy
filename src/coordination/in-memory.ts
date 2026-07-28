import type {
  AdmitResult,
  ClaimResult,
  CoordinationOutcomeUnknownReason,
  CoordinationRequestState,
  DistributedCoordinationEvent,
  DistributedAdmissionConfig,
  DistributedAdmissionReservation,
  DistributedBudgetReservationResult,
  DistributedCoordinatorConfig,
  DistributedCoordinatorCompatibilityTuple,
  DistributedCoordinatorHealth,
  DistributedCostMarkerV1,
  DistributedEventPage,
  DistributedHistoryLoadResult,
  DistributedHistorySnapshotV1,
  DistributedMemoryEntryV1,
  DistributedMemoryMutationV1,
  DistributedMemoryOriginV1,
  DistributedMemoryPeerEpochResult,
  DistributedMemoryReadResult,
  DistributedMemorySearchResult,
  DistributedOutboxClaimResult,
  DistributedOutboxIntentV1,
  DistributedOutboxLeaseV1,
  DistributedOutboxResult,
  DistributedPeerBindingV1,
  DistributedPruneResult,
  DistributedReplayResult,
  DistributedRateReservationResult,
  DistributedRequestStatus,
  DistributedSourcePolicy,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  DistributedTurnRequestIdentity,
  LeaseResult,
  RegistrationResult,
} from "./types";
import {
  distributedBudgetCostNanos,
  isCanonicalDistributedBudgetCostUsd,
  MAX_DISTRIBUTED_BUDGET_COST_USD,
  normalizeDistributedBudgetConfig,
  resolveDistributedBudgetCaps,
  sameDistributedBudgetPolicy,
} from "./budget-policy";
import {
  decodeDistributedMemoryDocument,
  decodeDistributedMemoryQuery,
  distributedMemoryEraseTargetScope,
  distributedMemoryPeerScope,
  normalizeDistributedMemoryConfig,
  sameDistributedMemoryPolicy,
} from "./memory-policy";
import {
  EMPTY_DISTRIBUTED_HISTORY,
  validDistributedPeerBinding,
  validDistributedReplay,
  validateDistributedTurnCheckpoint,
} from "./turn-state";

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
  historyClaim?: {
    binding: DistributedPeerBindingV1;
    expectedRevision: number;
  };
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

interface StoredHistory extends DistributedHistorySnapshotV1 {
  binding: DistributedPeerBindingV1;
  revision: number;
}

interface StoredMemoryEntry {
  id: string;
  peerIdHash: string;
  body: Uint8Array;
  content: string;
  sourceTurnId: string;
  origin: DistributedMemoryOriginV1;
  provenanceHash: string;
  createdAt: number;
}

interface StoredMemoryOperation {
  semanticHash: string;
  policyId: string;
  expiresAt: number;
}

type StoredCostMarker = DistributedCostMarkerV1 & { requestId: string; fence: number };

interface StoredOutboxIntent extends DistributedOutboxIntentV1 {
  requestId: string;
  fence: number;
  state: "pending" | "delivering" | "delivered" | "failed" | "outcome_unknown";
  createdAt: number;
  updatedAt: number;
  attempt: number;
  deliveryFence: number;
  ownerInstance?: string;
  ownerSession?: string;
  leaseExpiresAt?: number;
  settledAt?: number;
  reasonCode?: string;
}

interface StoredBudgetReservation {
  policyId: string;
  requestId: string;
  bindingHash: string;
  peerIdHash: string;
  threadIdHash: string;
  trustLevel: "agent" | "public";
  publicSubstate?: "anonymous" | "recognized";
  attempt: number;
  fence: number;
  admissionDay: string;
  state: "reserved" | "committed" | "outcome_unknown";
  reservedAt: number;
  settledAt?: number;
}

interface StoredBudgetDaily {
  turns: number;
  costNanos: bigint;
  unpricedTurns: number;
}

interface LocalOwnedOperation {
  admissionHash: string;
  attempt: number;
  bindingHash: string;
  controller: AbortController;
  phase: "queued" | "active";
  sourceId: string;
  threadId: string;
}

interface NamespaceState {
  admission: DistributedAdmissionConfig;
  admissionEvents: Array<{
    policyId: string;
    subjectHash: string;
    requestId: string;
    occurredAt: number;
    expiresAt: number;
  }>;
  rateReservations: Map<string, { bindingHash: string; expiresAt: number }>;
  costMarkers: Map<string, StoredCostMarker>;
  budgets: ReturnType<typeof normalizeDistributedBudgetConfig>;
  memory: ReturnType<typeof normalizeDistributedMemoryConfig>;
  memoryEntries: Map<string, StoredMemoryEntry>;
  memoryTombstones: Map<string, number>;
  memoryPeerEraseEpochs: Map<string, { epoch: number; expiresAt: number }>;
  memoryOperations: Map<string, StoredMemoryOperation>;
  budgetReservations: Map<string, StoredBudgetReservation>;
  budgetAnonymousEvents: Array<{
    policyId: string;
    requestId: string;
    subjectHash: string;
    occurredAt: number;
    expiresAt: number;
  }>;
  budgetDaily: Map<string, StoredBudgetDaily>;
  budgetThresholds: Map<string, { state: "pending" | "suppressed" }>;
  events: StoredEvent[];
  histories: Map<string, StoredHistory>;
  instances: Map<string, StoredInstance>;
  leaseMs: number;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedPerThread: number;
  nextEventId: bigint;
  nextFence: number;
  retention: DistributedCoordinatorConfig["retention"];
  result: DistributedCoordinatorConfig["result"];
  turnState: DistributedCoordinatorConfig["turnState"];
  compatibility: DistributedCoordinatorCompatibilityTuple;
  outbox: Map<string, StoredOutboxIntent>;
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
const MAX_RATE_POLICIES = 64;
const MAX_CAPACITY_CLASSES = 64;
const MAX_RATE_RESERVATIONS = 16;
const MAX_RATE_WINDOW_MS = 86_400_000;
const GLOBAL_BUDGET_SUBJECT_HASH = "0".repeat(64);

function budgetDigest(domain: string, ...values: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256").update(domain).update("\0");
  for (const value of values) hasher.update(value).update("\0");
  return hasher.digest("hex");
}

function budgetDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function budgetDailyKey(
  policyId: string,
  day: string,
  kind: "global" | "peer",
  subjectHash: string,
): string {
  return `${policyId}\0${day}\0${kind}\0${subjectHash}`;
}

function normalizedAdmission(config: DistributedCoordinatorConfig): DistributedAdmissionConfig {
  return config.admission ?? { maxRateLimitEvents: 0, capacityClasses: [], rateLimits: [] };
}

function normalizedMemory(config: DistributedCoordinatorConfig) {
  return normalizeDistributedMemoryConfig(
    config.memory,
    config.retention.terminalRequestRetentionMs,
  );
}

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
  assertLimit(
    "turnState.history.maxSnapshotBytes",
    config.turnState.history.maxSnapshotBytes,
    1_024,
    1_048_576,
  );
  assertLimit("turnState.history.maxMessages", config.turnState.history.maxMessages, 1, 10_000);
  assertLimit("turnState.history.maxThreads", config.turnState.history.maxThreads, 1);
  assertLimit("turnState.maxCostMarkersPerTurn", config.turnState.maxCostMarkersPerTurn, 1, 1_000);
  assertLimit(
    "turnState.outbox.maxIntentsPerTurn",
    config.turnState.outbox.maxIntentsPerTurn,
    0,
    1_000,
  );
  assertLimit(
    "turnState.outbox.maxIntentBytes",
    config.turnState.outbox.maxIntentBytes,
    1_024,
    1_048_576,
  );
  assertLimit("turnState.outbox.maxPendingIntents", config.turnState.outbox.maxPendingIntents, 0);
  const admission = normalizedAdmission(config);
  // Validate immutable memory policies at construction. No request-controlled
  // values can make a disabled policy available later.
  normalizedMemory(config);
  assertLimit("admission.maxRateLimitEvents", admission.maxRateLimitEvents, 0);
  if (!Array.isArray(admission.rateLimits) || admission.rateLimits.length > MAX_RATE_POLICIES) {
    throw new Error("admission rate policies exceed supported bounds");
  }
  const ratePolicyIds = new Set<string>();
  for (const policy of admission.rateLimits) {
    assertIdentifier("admission.rateLimits.id", policy.id);
    assertLimit("admission.rateLimits.max", policy.max, 1);
    assertLimit("admission.rateLimits.maxEvents", policy.maxEvents, 1);
    assertLimit("admission.rateLimits.windowMs", policy.windowMs, 1_000, MAX_RATE_WINDOW_MS);
    if (ratePolicyIds.has(policy.id)) throw new Error("admission rate policy ids must be unique");
    ratePolicyIds.add(policy.id);
  }
  if (
    admission.rateLimits.reduce((sum, policy) => sum + policy.maxEvents, 0) >
    admission.maxRateLimitEvents
  ) {
    throw new Error("admission rate policy partitions exceed the namespace event capacity");
  }
  const capacityClasses = admission.capacityClasses ?? [];
  if (!Array.isArray(capacityClasses) || capacityClasses.length > MAX_CAPACITY_CLASSES) {
    throw new Error("admission capacity classes exceed supported bounds");
  }
  const capacityClassIds = new Set<string>();
  let reservedRequestCapacity = 0;
  for (const policy of capacityClasses) {
    assertIdentifier("admission.capacityClasses.id", policy.id);
    assertLimit("admission.capacityClasses.maxRetainedRequests", policy.maxRetainedRequests, 1);
    assertLimit(
      "admission.capacityClasses.maxRetainedRequestsPerPartition",
      policy.maxRetainedRequestsPerPartition,
      1,
    );
    if (policy.maxRetainedRequestsPerPartition > policy.maxRetainedRequests) {
      throw new Error("admission partition capacity cannot exceed its class capacity");
    }
    if (capacityClassIds.has(policy.id)) {
      throw new Error("admission capacity class ids must be unique");
    }
    capacityClassIds.add(policy.id);
    reservedRequestCapacity += policy.maxRetainedRequests;
  }
  if (reservedRequestCapacity > config.retention.maxTerminalRequests) {
    throw new Error("admission capacity classes exceed retained-request capacity");
  }
  const budgets = normalizeDistributedBudgetConfig(
    config.budgets,
    config.retention.terminalRequestRetentionMs,
  );
  const minimumReservations =
    config.retention.maxTerminalRequests + config.maxConcurrent + config.maxQueued;
  if (budgets.policies.some((policy) => policy.maxReservations < minimumReservations)) {
    throw new Error("coordination budget reservation capacity cannot retain request evidence");
  }
  assertLimit("compatibility.protocolVersion", config.compatibility.protocolVersion, 1);
  if (
    !/^[0-9a-f]{64}$/.test(config.compatibility.protocolFingerprint) ||
    !/^[0-9a-f]{64}$/.test(config.compatibility.configurationFingerprint)
  ) {
    throw new Error("coordinator compatibility fingerprints are invalid");
  }
  if (config.compatibility.upgradeFrom) {
    assertLimit(
      "compatibility.upgradeFrom.protocolVersion",
      config.compatibility.upgradeFrom.protocolVersion,
      1,
    );
    if (
      config.compatibility.upgradeFrom.protocolVersion + 1 !==
        config.compatibility.protocolVersion ||
      !/^[0-9a-f]{64}$/.test(config.compatibility.upgradeFrom.protocolFingerprint) ||
      !/^[0-9a-f]{64}$/.test(config.compatibility.upgradeFrom.configurationFingerprint)
    ) {
      throw new Error("coordinator compatibility upgrade contract is invalid");
    }
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
  if (request.capacity !== undefined) {
    assertIdentifier("capacity.classId", request.capacity.classId);
    if (!/^[0-9a-f]{64}$/.test(request.capacity.partitionHash)) {
      throw new Error("capacity.partitionHash must be a SHA-256 digest");
    }
  }
  if (
    !Array.isArray(request.admission ?? []) ||
    (request.admission?.length ?? 0) > MAX_RATE_RESERVATIONS
  ) {
    throw new Error("distributed admission reservations exceed supported bounds");
  }
  for (const reservation of request.admission ?? []) {
    assertIdentifier("admission.policyId", reservation.policyId);
    if (!/^[0-9a-f]{64}$/.test(reservation.subjectHash)) {
      throw new Error("admission.subjectHash must be a SHA-256 digest");
    }
  }
}

function canonicalAdmission(
  reservations: readonly DistributedAdmissionReservation[] | undefined,
): string {
  return [...(reservations ?? [])]
    .map((reservation) => `${reservation.policyId}\0${reservation.subjectHash}`)
    .sort()
    .join("\n");
}

function canonicalCapacity(capacity: DistributedTurnRequest["capacity"]): string {
  return capacity ? `${capacity.classId}\0${capacity.partitionHash}` : "";
}

function canonicalRequestAdmission(request: DistributedTurnRequestIdentity): string {
  return `${canonicalCapacity(request.capacity)}\n${canonicalAdmission(request.admission)}`;
}

function sameBinding(left: StoredRequest, right: DistributedTurnRequest): boolean {
  return (
    left.threadId === right.threadId &&
    left.source.id === right.source.id &&
    left.bindingHash === right.bindingHash &&
    canonicalRequestAdmission(left) === canonicalRequestAdmission(right)
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
  const admission = normalizedAdmission(config);
  const budgets = normalizeDistributedBudgetConfig(
    config.budgets,
    config.retention.terminalRequestRetentionMs,
  );
  const memory = normalizedMemory(config);
  const owned = new Map<string, LocalOwnedOperation>();
  let invalidated = false;

  function trackOwned(
    request: DistributedTurnRequest,
    phase: "queued" | "active",
    attempt: number,
  ): void {
    if (invalidated) return;
    const existing = owned.get(request.requestId);
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.bindingHash === request.bindingHash &&
      existing.admissionHash === canonicalRequestAdmission(request) &&
      existing.threadId === request.threadId &&
      existing.sourceId === request.source.id
    ) {
      existing.phase = phase;
      existing.attempt = attempt;
      return;
    }
    existing?.controller.abort("ownership-replaced");
    owned.set(request.requestId, {
      admissionHash: canonicalRequestAdmission(request),
      attempt,
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

  function abortOwnedAttempt(requestId: string, attempt: number, reason: string): void {
    const operation = owned.get(requestId);
    if (operation?.attempt === attempt) {
      abortOwned(requestId, reason);
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

  function validDigest(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  }

  function validOperationId(value: unknown): value is string {
    return typeof value === "string" && /^auggy-op-v1-[0-9a-f]{64}$/.test(value);
  }

  function validPeerBinding(binding: DistributedPeerBindingV1): boolean {
    if (
      binding.version !== 1 ||
      !validDigest(binding.bindingHash) ||
      (binding.peerIdHash !== null && !validDigest(binding.peerIdHash)) ||
      !validDigest(binding.promotionScopeHash) ||
      !(["creator", "agent", "public"] as const).includes(binding.trustLevel) ||
      (binding.priorPeerIdHash !== undefined && !validDigest(binding.priorPeerIdHash))
    ) {
      return false;
    }
    if (binding.trustLevel === "public") {
      if (binding.publicSubstate !== "anonymous" && binding.publicSubstate !== "recognized") {
        return false;
      }
      if (binding.peerIdHash === null) return false;
      if (binding.publicSubstate === "anonymous" && binding.priorPeerIdHash !== undefined) {
        return false;
      }
      return true;
    }
    return binding.publicSubstate === undefined && binding.priorPeerIdHash === undefined;
  }

  function copyPeerBinding(binding: DistributedPeerBindingV1): DistributedPeerBindingV1 {
    return { ...binding };
  }

  function samePeerBinding(
    left: DistributedPeerBindingV1,
    right: DistributedPeerBindingV1,
  ): boolean {
    return left.bindingHash === right.bindingHash;
  }

  function allowsAuthenticatedPromotion(
    stored: DistributedPeerBindingV1,
    incoming: DistributedPeerBindingV1,
  ): boolean {
    return (
      stored.trustLevel === "public" &&
      stored.publicSubstate === "anonymous" &&
      incoming.trustLevel === "public" &&
      incoming.publicSubstate === "recognized" &&
      stored.peerIdHash !== null &&
      incoming.peerIdHash !== null &&
      incoming.priorPeerIdHash === stored.peerIdHash &&
      incoming.promotionScopeHash === stored.promotionScopeHash
    );
  }

  function copyHistory(history: StoredHistory): DistributedHistorySnapshotV1 {
    return {
      version: 1,
      body: new Uint8Array(history.body),
      messageCount: history.messageCount,
    };
  }

  function validHistory(history: DistributedHistorySnapshotV1): boolean {
    if (
      history.version !== 1 ||
      !(history.body instanceof Uint8Array) ||
      !Number.isSafeInteger(history.messageCount) ||
      history.messageCount < 0 ||
      history.messageCount > config.turnState.history.maxMessages ||
      history.body.byteLength > config.turnState.history.maxSnapshotBytes
    ) {
      return false;
    }
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(history.body));
      return (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.version === 1 &&
        Array.isArray(parsed.messages) &&
        parsed.messages.length === history.messageCount
      );
    } catch {
      return false;
    }
  }

  function validCostMarkers(markers: readonly DistributedCostMarkerV1[]): boolean {
    if (!Array.isArray(markers) || markers.length > config.turnState.maxCostMarkersPerTurn) {
      return false;
    }
    const operations = new Set<string>();
    return markers.every((marker) => {
      if (
        marker.version !== 1 ||
        !validOperationId(marker.operationId) ||
        operations.has(marker.operationId)
      ) {
        return false;
      }
      operations.add(marker.operationId);
      return marker.priced
        ? isCanonicalDistributedBudgetCostUsd(marker.costUsd)
        : marker.reason === "missing-usage" || marker.reason === "missing-pricing";
    });
  }

  function validOutboxIntents(intents: readonly DistributedOutboxIntentV1[]): boolean {
    if (!Array.isArray(intents) || intents.length > config.turnState.outbox.maxIntentsPerTurn) {
      return false;
    }
    const operations = new Set<string>();
    const ordinals = new Set<number>();
    return intents.every((intent) => {
      if (
        intent.version !== 1 ||
        intent.contentType !== "application/json" ||
        !(intent.body instanceof Uint8Array) ||
        intent.body.byteLength > config.turnState.outbox.maxIntentBytes ||
        !Number.isSafeInteger(intent.ordinal) ||
        intent.ordinal < 0 ||
        intent.ordinal >= intents.length ||
        !validOperationId(intent.operationId) ||
        (intent.retryMode !== "never" && intent.retryMode !== "sink-idempotent") ||
        !Number.isSafeInteger(intent.maxAttempts) ||
        intent.maxAttempts < 1 ||
        intent.maxAttempts > 10 ||
        (intent.retryMode === "never" && intent.maxAttempts !== 1) ||
        operations.has(intent.operationId) ||
        ordinals.has(intent.ordinal)
      ) {
        return false;
      }
      operations.add(intent.operationId);
      ordinals.add(intent.ordinal);
      try {
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(intent.body));
        return true;
      } catch {
        return false;
      }
    });
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

  function compatibilityTuple(): DistributedCoordinatorCompatibilityTuple {
    return {
      protocolVersion: config.compatibility.protocolVersion,
      protocolFingerprint: config.compatibility.protocolFingerprint,
      configurationFingerprint: config.compatibility.configurationFingerprint,
    };
  }

  function sameCompatibility(
    left: DistributedCoordinatorCompatibilityTuple,
    right: DistributedCoordinatorCompatibilityTuple,
  ): boolean {
    return (
      left.protocolVersion === right.protocolVersion &&
      left.protocolFingerprint === right.protocolFingerprint &&
      left.configurationFingerprint === right.configurationFingerprint
    );
  }

  function state(create = false, enforcePolicy = true): NamespaceState | undefined {
    let value = namespaces.get(config.namespace);
    if (!value && create) {
      value = {
        admission: {
          maxRateLimitEvents: admission.maxRateLimitEvents,
          capacityClasses: (admission.capacityClasses ?? []).map((policy) => ({ ...policy })),
          rateLimits: admission.rateLimits.map((policy) => ({ ...policy })),
        },
        admissionEvents: [],
        rateReservations: new Map(),
        costMarkers: new Map(),
        budgets: {
          policies: budgets.policies.map((policy) => structuredClone(policy)),
        },
        memory: { policies: memory.policies.map((policy) => structuredClone(policy)) },
        memoryEntries: new Map(),
        memoryTombstones: new Map(),
        memoryPeerEraseEpochs: new Map(),
        memoryOperations: new Map(),
        budgetReservations: new Map(),
        budgetAnonymousEvents: [],
        budgetDaily: new Map(),
        budgetThresholds: new Map(),
        events: [],
        histories: new Map(),
        instances: new Map(),
        leaseMs: config.leaseMs,
        maxConcurrent: config.maxConcurrent,
        maxQueued: config.maxQueued,
        maxQueuedPerThread: config.maxQueuedPerThread,
        nextEventId: 0n,
        nextFence: 0,
        outbox: new Map(),
        retention: { ...config.retention },
        result: { ...config.result },
        turnState: {
          history: { ...config.turnState.history },
          maxCostMarkersPerTurn: config.turnState.maxCostMarkersPerTurn,
          outbox: { ...config.turnState.outbox },
        },
        compatibility: compatibilityTuple(),
        requests: new Map(),
        threads: new Map(),
        sources: new Map(config.sources.map((source) => [source.id, { ...source }])),
      };
      namespaces.set(config.namespace, value);
    } else if (value && enforcePolicy) {
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
    const admissionMatches =
      current.admission.maxRateLimitEvents === admission.maxRateLimitEvents &&
      (current.admission.capacityClasses ?? []).length ===
        (admission.capacityClasses ?? []).length &&
      (admission.capacityClasses ?? []).every((policy) => {
        const stored = (current.admission.capacityClasses ?? []).find(
          (candidate) => candidate.id === policy.id,
        );
        return (
          stored?.maxRetainedRequests === policy.maxRetainedRequests &&
          stored.maxRetainedRequestsPerPartition === policy.maxRetainedRequestsPerPartition
        );
      }) &&
      current.admission.rateLimits.length === admission.rateLimits.length &&
      admission.rateLimits.every((policy) => {
        const stored = current.admission.rateLimits.find((candidate) => candidate.id === policy.id);
        return (
          stored?.max === policy.max &&
          stored.maxEvents === policy.maxEvents &&
          stored.windowMs === policy.windowMs
        );
      });
    const budgetsMatch =
      current.budgets.policies.length === budgets.policies.length &&
      budgets.policies.every((policy) => {
        const stored = current.budgets.policies.find((candidate) => candidate.id === policy.id);
        return stored !== undefined && sameDistributedBudgetPolicy(stored, policy);
      });
    const memoryMatch =
      current.memory.policies.length === memory.policies.length &&
      memory.policies.every((policy) => {
        const stored = current.memory.policies.find((candidate) => candidate.id === policy.id);
        return stored !== undefined && sameDistributedMemoryPolicy(stored, policy);
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
      current.turnState.history.maxSnapshotBytes !== config.turnState.history.maxSnapshotBytes ||
      current.turnState.history.maxMessages !== config.turnState.history.maxMessages ||
      current.turnState.history.maxThreads !== config.turnState.history.maxThreads ||
      current.turnState.maxCostMarkersPerTurn !== config.turnState.maxCostMarkersPerTurn ||
      current.turnState.outbox.maxIntentsPerTurn !== config.turnState.outbox.maxIntentsPerTurn ||
      current.turnState.outbox.maxIntentBytes !== config.turnState.outbox.maxIntentBytes ||
      current.turnState.outbox.maxPendingIntents !== config.turnState.outbox.maxPendingIntents ||
      !sameCompatibility(current.compatibility, compatibilityTuple()) ||
      !sourcesMatch ||
      !admissionMatches ||
      !budgetsMatch ||
      !memoryMatch
    ) {
      throw new Error("coordinator namespace policy mismatch");
    }
    return current;
  }

  function upgradeQuiescentCompatibility(current: NamespaceState, timestamp: number): boolean {
    const predecessor = config.compatibility.upgradeFrom;
    if (!predecessor || !sameCompatibility(current.compatibility, predecessor)) return false;
    if ([...current.instances.values()].some((instance) => instance.expiresAt > timestamp)) {
      return false;
    }
    if (
      [...current.requests.values()].some(
        (request) => request.state === "queued" || request.state === "active",
      )
    ) {
      return false;
    }
    const admissionChanges =
      current.admission.maxRateLimitEvents !== admission.maxRateLimitEvents ||
      (current.admission.capacityClasses ?? []).length !==
        (admission.capacityClasses ?? []).length ||
      current.admission.rateLimits.length !== admission.rateLimits.length ||
      admission.rateLimits.some((policy) => {
        const stored = current.admission.rateLimits.find((candidate) => candidate.id === policy.id);
        return (
          stored?.max !== policy.max ||
          stored.maxEvents !== policy.maxEvents ||
          stored.windowMs !== policy.windowMs
        );
      });
    const budgetChanges =
      current.budgets.policies.length !== budgets.policies.length ||
      budgets.policies.some((policy) => {
        const stored = current.budgets.policies.find((candidate) => candidate.id === policy.id);
        return stored === undefined || !sameDistributedBudgetPolicy(stored, policy);
      });
    if (
      admissionChanges &&
      (current.requests.size > 0 ||
        current.admissionEvents.length > 0 ||
        current.rateReservations.size > 0)
    ) {
      return false;
    }
    if (
      budgetChanges &&
      (current.budgetReservations.size > 0 ||
        current.budgetAnonymousEvents.length > 0 ||
        current.budgetDaily.size > 0 ||
        current.budgetThresholds.size > 0)
    ) {
      return false;
    }
    const prior = current.compatibility;
    const priorAdmission = current.admission;
    const priorBudgets = current.budgets;
    current.compatibility = compatibilityTuple();
    if (admissionChanges) {
      current.admission = {
        maxRateLimitEvents: admission.maxRateLimitEvents,
        capacityClasses: (admission.capacityClasses ?? []).map((policy) => ({ ...policy })),
        rateLimits: admission.rateLimits.map((policy) => ({ ...policy })),
      };
    }
    if (budgetChanges) {
      current.budgets = {
        policies: budgets.policies.map((policy) => structuredClone(policy)),
      };
    }
    try {
      namespacePolicy(current);
    } catch {
      current.compatibility = prior;
      current.admission = priorAdmission;
      current.budgets = priorBudgets;
      return false;
    }
    for (const [instanceId, instance] of current.instances) {
      if (instance.expiresAt <= timestamp) current.instances.delete(instanceId);
    }
    return true;
  }

  async function exclusive<T>(operation: () => T, allowAfterInvalidation = false): Promise<T> {
    const previous = transaction;
    let release!: () => void;
    transaction = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if ((!allowAfterInvalidation && invalidated) || options.failClosed?.()) {
        throw new Error("coordinator unavailable");
      }
      return operation();
    } finally {
      release();
    }
  }

  function expire(current: NamespaceState, timestamp: number): void {
    for (const request of current.requests.values()) {
      if (request.state !== "active" || (request.expiresAt ?? Infinity) > timestamp) continue;
      if (request.executionStarted) {
        const expiredLease = leaseFrom(request);
        settleBudgetAccounting(
          current,
          expiredLease,
          missingUsageAccountingMarkers(expiredLease),
          "outcome_unknown",
          timestamp,
        );
        quarantine(current, request, timestamp, "lease-lost");
      } else {
        releaseBudgetReservationsForRequest(current, request.requestId, request.queueGeneration);
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

  function reserveAdmission(
    current: NamespaceState,
    requestId: string,
    reservations: readonly DistributedAdmissionReservation[],
    timestamp: number,
  ):
    | { status: "ok"; expiresAt: number }
    | {
        status: "rejected";
        reason: "admission-capacity" | "invalid-admission" | "rate-limited";
        retryAfterMs?: number;
      } {
    const seen = new Set<string>();
    const resolved: Array<{
      policyId: string;
      subjectHash: string;
      max: number;
      maxEvents: number;
      windowMs: number;
    }> = [];
    for (const reservation of reservations) {
      if (seen.has(reservation.policyId)) {
        return { status: "rejected", reason: "invalid-admission" };
      }
      seen.add(reservation.policyId);
      const policy = current.admission.rateLimits.find(
        (candidate) => candidate.id === reservation.policyId,
      );
      if (!policy) return { status: "rejected", reason: "invalid-admission" };
      resolved.push({
        ...reservation,
        max: policy.max,
        maxEvents: policy.maxEvents,
        windowMs: policy.windowMs,
      });
    }
    current.admissionEvents = current.admissionEvents.filter(
      (event) => event.expiresAt > timestamp,
    );
    for (const item of resolved) {
      const policyEvidence = current.admissionEvents.filter(
        (event) => event.policyId === item.policyId,
      ).length;
      if (policyEvidence >= item.maxEvents) {
        return { status: "rejected", reason: "admission-capacity" };
      }
    }
    let retryAfterMs = 0;
    for (const item of resolved) {
      const matching = current.admissionEvents
        .filter(
          (event) => event.policyId === item.policyId && event.subjectHash === item.subjectHash,
        )
        .sort((left, right) => left.occurredAt - right.occurredAt);
      if (matching.length >= item.max) {
        retryAfterMs = Math.max(retryAfterMs, matching[0]!.expiresAt - timestamp);
      }
    }
    if (retryAfterMs > 0) {
      return { status: "rejected", reason: "rate-limited", retryAfterMs };
    }
    for (const item of resolved) {
      current.admissionEvents.push({
        policyId: item.policyId,
        subjectHash: item.subjectHash,
        requestId,
        occurredAt: timestamp,
        expiresAt: timestamp + item.windowMs,
      });
    }
    return {
      status: "ok",
      expiresAt: resolved.reduce(
        (maximum, item) => Math.max(maximum, timestamp + item.windowMs),
        timestamp,
      ),
    };
  }

  function reserveRequestCapacity(
    current: NamespaceState,
    request: DistributedTurnRequest,
  ): { status: "ok" } | { status: "rejected"; reason: "invalid-admission" | "request-capacity" } {
    const policies = current.admission.capacityClasses ?? [];
    if (policies.length === 0) {
      return request.capacity === undefined
        ? { status: "ok" }
        : { status: "rejected", reason: "invalid-admission" };
    }
    if (request.capacity === undefined) {
      return { status: "rejected", reason: "invalid-admission" };
    }
    const policy = policies.find((candidate) => candidate.id === request.capacity!.classId);
    if (!policy) return { status: "rejected", reason: "invalid-admission" };
    const retained = [...current.requests.values()].filter(
      (candidate) => candidate.capacity?.classId === request.capacity!.classId,
    );
    if (retained.length >= policy.maxRetainedRequests) {
      return { status: "rejected", reason: "request-capacity" };
    }
    const partitionRetained = retained.filter(
      (candidate) => candidate.capacity?.partitionHash === request.capacity!.partitionHash,
    );
    return partitionRetained.length >= policy.maxRetainedRequestsPerPartition
      ? { status: "rejected", reason: "request-capacity" }
      : { status: "ok" };
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
      releaseBudgetReservationsForRequest(current, request.requestId, request.queueGeneration);
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
      attempt: request.queueGeneration,
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
      request.queueGeneration !== lease.attempt ||
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

  function budgetReservationKey(policyId: string, requestId: string): string {
    return `${policyId}\0${requestId}`;
  }

  function budgetUsage(
    current: NamespaceState,
    policyId: string,
    admissionDay: string,
    peerIdHash: string,
    threadIdHash: string,
  ) {
    const peer = current.budgetDaily.get(
      budgetDailyKey(policyId, admissionDay, "peer", peerIdHash),
    ) ?? { turns: 0, costNanos: 0n, unpricedTurns: 0 };
    const global = current.budgetDaily.get(
      budgetDailyKey(policyId, admissionDay, "global", GLOBAL_BUDGET_SUBJECT_HASH),
    ) ?? { turns: 0, costNanos: 0n, unpricedTurns: 0 };
    const threadTurns = [...current.budgetReservations.values()].filter(
      (reservation) =>
        reservation.policyId === policyId &&
        reservation.admissionDay === admissionDay &&
        reservation.peerIdHash === peerIdHash &&
        reservation.threadIdHash === threadIdHash,
    ).length;
    return {
      admissionDay,
      threadTurns,
      peerTurns: peer.turns,
      peerCostUsd: Number(peer.costNanos) / 1_000_000_000,
      peerUnpricedTurns: peer.unpricedTurns,
      globalCostUsd: Number(global.costNanos) / 1_000_000_000,
      globalUnpricedTurns: global.unpricedTurns,
    };
  }

  function releaseBudgetReservation(
    current: NamespaceState,
    policyId: string,
    requestId: string,
    attempt?: number,
    fence?: number,
  ): boolean {
    const key = budgetReservationKey(policyId, requestId);
    const reservation = current.budgetReservations.get(key);
    if (
      reservation?.state !== "reserved" ||
      (attempt !== undefined && reservation.attempt !== attempt) ||
      (fence !== undefined && reservation.fence !== fence)
    ) {
      return false;
    }
    current.budgetReservations.delete(key);
    current.budgetAnonymousEvents = current.budgetAnonymousEvents.filter(
      (event) => event.policyId !== policyId || event.requestId !== requestId,
    );
    for (const [kind, subjectHash] of [
      ["global", GLOBAL_BUDGET_SUBJECT_HASH],
      ["peer", reservation.peerIdHash],
    ] as const) {
      const dailyKey = budgetDailyKey(policyId, reservation.admissionDay, kind, subjectHash);
      const daily = current.budgetDaily.get(dailyKey);
      if (daily) {
        daily.turns = Math.max(0, daily.turns - 1);
        if (daily.turns === 0 && daily.costNanos === 0n && daily.unpricedTurns === 0) {
          current.budgetDaily.delete(dailyKey);
        }
      }
    }
    return true;
  }

  function releaseBudgetReservationsForRequest(
    current: NamespaceState,
    requestId: string,
    attempt?: number,
  ): void {
    for (const reservation of [...current.budgetReservations.values()]) {
      if (reservation.requestId === requestId && reservation.state === "reserved") {
        releaseBudgetReservation(current, reservation.policyId, requestId, attempt);
      }
    }
  }

  function pruneBudgetEvidence(
    current: NamespaceState,
    timestamp: number,
    policyId?: string,
  ): void {
    for (const policy of current.budgets.policies) {
      if (policyId !== undefined && policy.id !== policyId) continue;
      const reservationCutoff = timestamp - policy.reservationRetentionMs;
      for (const [key, reservation] of current.budgetReservations) {
        if (
          reservation.policyId === policy.id &&
          (reservation.state === "committed" ||
            (reservation.state === "outcome_unknown" &&
              current.requests.get(reservation.requestId)?.state !== "outcome_unknown")) &&
          reservation.settledAt !== undefined &&
          reservation.settledAt <= reservationCutoff
        ) {
          current.budgetReservations.delete(key);
        }
      }
      const cutoffDay = budgetDay(timestamp - policy.aggregateRetentionDays * 24 * 60 * 60 * 1_000);
      const protectedDays = new Set(
        [...current.budgetReservations.values()]
          .filter(
            (reservation) =>
              reservation.policyId === policy.id &&
              (reservation.state === "reserved" || reservation.state === "outcome_unknown"),
          )
          .map((reservation) => reservation.admissionDay),
      );
      for (const key of current.budgetDaily.keys()) {
        const [storedPolicyId, day] = key.split("\0");
        if (storedPolicyId === policy.id && day! <= cutoffDay && !protectedDays.has(day!)) {
          current.budgetDaily.delete(key);
        }
      }
      for (const key of current.budgetThresholds.keys()) {
        const [storedPolicyId, day] = key.split("\0");
        if (
          storedPolicyId === policy.id &&
          day! <= cutoffDay &&
          current.budgetThresholds.get(key)?.state === "suppressed"
        ) {
          current.budgetThresholds.delete(key);
        }
      }
    }
  }

  function settleBudgetAccounting(
    current: NamespaceState,
    lease: DistributedTurnLease,
    markers: readonly DistributedCostMarkerV1[],
    reservationState: "committed" | "outcome_unknown",
    timestamp: number,
  ): void {
    const reservations = [...current.budgetReservations.values()].filter(
      (reservation) =>
        reservation.requestId === lease.requestId &&
        reservation.attempt === lease.attempt &&
        reservation.fence === lease.fence &&
        reservation.state === "reserved",
    );
    const hasUnpriced = markers.some((marker) => !marker.priced);
    const pricedCostNanos = markers.reduce(
      (sum, marker) => sum + (marker.priced ? distributedBudgetCostNanos(marker.costUsd) : 0n),
      0n,
    );
    if (pricedCostNanos > distributedBudgetCostNanos(MAX_DISTRIBUTED_BUDGET_COST_USD)) {
      throw new Error("distributed cost total exceeds budget accounting bounds");
    }
    const settlements = reservations.map((reservation) => {
      const policy = current.budgets.policies.find(
        (candidate) => candidate.id === reservation.policyId,
      );
      if (!policy) throw new Error("distributed budget reservation policy is unavailable");
      const global = current.budgetDaily.get(
        budgetDailyKey(
          reservation.policyId,
          reservation.admissionDay,
          "global",
          GLOBAL_BUDGET_SUBJECT_HASH,
        ),
      );
      const peer = current.budgetDaily.get(
        budgetDailyKey(
          reservation.policyId,
          reservation.admissionDay,
          "peer",
          reservation.peerIdHash,
        ),
      );
      if (!global || !peer) throw new Error("distributed budget aggregate is missing");
      const globalTotalNanos = global.costNanos + pricedCostNanos;
      let newThresholds: number[] = [];
      if (policy.dailyBudgetUsd !== undefined && policy.notifications && pricedCostNanos > 0n) {
        const dailyBudgetNanos = distributedBudgetCostNanos(policy.dailyBudgetUsd);
        const crossed = policy.notifications.thresholds.filter(
          (threshold) =>
            globalTotalNanos * 1_000_000n >=
            dailyBudgetNanos * BigInt(Math.round(threshold * 1_000_000)),
        );
        newThresholds = crossed.filter(
          (threshold) =>
            !current.budgetThresholds.has(
              `${policy.id}\0${reservation.admissionDay}\0${Math.round(threshold * 1_000_000)}`,
            ),
        );
        const policyThresholds = [...current.budgetThresholds.keys()].filter((key) =>
          key.startsWith(`${policy.id}\0`),
        ).length;
        if (policyThresholds + newThresholds.length > policy.maxThresholdIntents) {
          throw new Error("distributed budget threshold intent capacity is exhausted");
        }
      }
      return { reservation, policy, global, peer, newThresholds };
    });
    for (const { reservation, policy, global, peer, newThresholds } of settlements) {
      if (pricedCostNanos > 0n) {
        global.costNanos += pricedCostNanos;
        peer.costNanos += pricedCostNanos;
      }
      if (hasUnpriced) {
        global.unpricedTurns++;
        peer.unpricedTurns++;
      }
      const highest = newThresholds.at(-1);
      for (const threshold of newThresholds) {
        current.budgetThresholds.set(
          `${policy.id}\0${reservation.admissionDay}\0${Math.round(threshold * 1_000_000)}`,
          { state: threshold === highest ? "pending" : "suppressed" },
        );
      }
      reservation.state = reservationState;
      reservation.settledAt = timestamp;
    }
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
    allowAfterInvalidation = false,
  ): Promise<T> {
    if (invalidated && !allowAfterInvalidation) {
      observe?.(unavailableResult);
      return unavailableResult;
    }
    try {
      const result = await operation();
      observe?.(result);
      return result;
    } catch {
      observe?.(unavailableResult);
      return unavailableResult;
    }
  }

  function collisionAccountingMarkers(
    markers: readonly DistributedCostMarkerV1[],
    duplicateOperationIds: ReadonlySet<string>,
  ): readonly DistributedCostMarkerV1[] {
    return markers.map((marker) =>
      duplicateOperationIds.has(marker.operationId)
        ? { version: 1, operationId: marker.operationId, priced: false, reason: "missing-usage" }
        : marker,
    );
  }

  function missingUsageAccountingMarkers(
    lease: DistributedTurnLease,
  ): readonly DistributedCostMarkerV1[] {
    return [
      {
        version: 1,
        operationId: `auggy-op-v1-${budgetDigest(
          "auggy-distributed-budget-unknown-cost-v1",
          config.namespace,
          lease.requestId,
          String(lease.attempt),
          String(lease.fence),
        )}`,
        priced: false,
        reason: "missing-usage",
      },
    ];
  }

  function outcomeUnknownAccountingMarkers(
    lease: DistributedTurnLease,
    markers: readonly DistributedCostMarkerV1[],
    duplicateOperationIds: ReadonlySet<string> = new Set(),
  ): readonly DistributedCostMarkerV1[] {
    if (duplicateOperationIds.size > 0) {
      return collisionAccountingMarkers(markers, duplicateOperationIds);
    }
    return markers.length > 0 ? markers : missingUsageAccountingMarkers(lease);
  }

  function settleUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
    costMarkers: readonly DistributedCostMarkerV1[],
  ): Promise<LeaseResult> {
    if (!OUTCOME_UNKNOWN_REASONS.has(reasonCode)) {
      return Promise.resolve({ status: "rejected", reason: "invalid-turn-state" });
    }
    if (!validCostMarkers(costMarkers)) {
      return Promise.resolve({ status: "rejected", reason: "invalid-turn-state" });
    }
    return safe<LeaseResult>(
      () =>
        exclusive(() => {
          const timestamp = now();
          const current = state();
          if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
          expire(current, timestamp);
          const stored = owns(current, lease, timestamp);
          if (!stored?.executionStarted) return { status: "stale" };
          const duplicateCostOperations = new Set(
            costMarkers
              .filter((marker) => current.costMarkers.has(marker.operationId))
              .map((marker) => marker.operationId),
          );
          settleBudgetAccounting(
            current,
            lease,
            outcomeUnknownAccountingMarkers(lease, costMarkers, duplicateCostOperations),
            "outcome_unknown",
            timestamp,
          );
          for (const marker of costMarkers) {
            if (!duplicateCostOperations.has(marker.operationId)) {
              current.costMarkers.set(marker.operationId, {
                ...marker,
                requestId: lease.requestId,
                fence: lease.fence,
              });
            }
          }
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
    );
  }

  function memoryEntryKey(policyId: string, peerIdHash: string, entryId: string): string {
    return `${policyId}\0${peerIdHash}\0${entryId}`;
  }

  function memoryTombstoneKey(policyId: string, peerIdHash: string, entryId: string): string {
    return `${policyId}\0${peerIdHash}\0${entryId}`;
  }

  function memoryPeerEraseKey(policyId: string, peerIdHash: string): string {
    return `${policyId}\0${peerIdHash}`;
  }

  function memorySemanticHash(
    mutation: DistributedMemoryMutationV1,
    affectedPeerScope: string,
    namespacePrefix: string,
  ): string {
    const body =
      mutation.kind === "forget"
        ? ""
        : new Bun.CryptoHasher("sha256").update(mutation.body).digest("hex");
    return new Bun.CryptoHasher("sha256")
      .update("auggy-distributed-memory-mutation-v1\0")
      .update(
        JSON.stringify({
          policyId: mutation.policyId,
          namespacePrefix,
          peerScope: affectedPeerScope,
          sourceTurnId: mutation.sourceTurnId,
          origin: mutation.origin,
          provenanceHash: mutation.provenanceHash,
          kind: mutation.kind,
          ...(mutation.kind === "forget"
            ? { targetPeerScope: affectedPeerScope }
            : { entryId: mutation.entryId }),
          ...(mutation.kind === "supersede"
            ? { supersedesEntryId: mutation.supersedesEntryId }
            : {}),
          ...(mutation.kind === "forget"
            ? {}
            : { expectedPeerEraseEpoch: mutation.expectedPeerEraseEpoch }),
          body,
        }),
      )
      .digest("hex");
  }

  function pruneMemory(current: NamespaceState, timestamp: number): void {
    for (const [key, entry] of current.memoryEntries) {
      const policy = current.memory.policies.find((candidate) =>
        key.startsWith(`${candidate.id}\0`),
      );
      if (!policy || entry.createdAt + policy.entryRetentionMs <= timestamp)
        current.memoryEntries.delete(key);
    }
    for (const [key, deletedAt] of current.memoryTombstones) {
      const policy = current.memory.policies.find((candidate) =>
        key.startsWith(`${candidate.id}\0`),
      );
      const retentionMs = key.endsWith("\0*")
        ? policy?.operationRetentionMs
        : policy?.entryRetentionMs;
      if (!retentionMs || deletedAt + retentionMs <= timestamp)
        current.memoryTombstones.delete(key);
    }
    for (const [key, operation] of current.memoryOperations) {
      if (operation.expiresAt <= timestamp) current.memoryOperations.delete(key);
    }
    for (const [key, erase] of current.memoryPeerEraseEpochs) {
      if (erase.expiresAt <= timestamp) current.memoryPeerEraseEpochs.delete(key);
    }
  }

  function preflightMemoryMutations(
    current: NamespaceState,
    peerBinding: DistributedPeerBindingV1,
    mutations: readonly DistributedMemoryMutationV1[] | undefined,
    _timestamp: number,
  ): "memory-capacity" | "memory-conflict" | "invalid-turn-state" | undefined {
    if (!mutations || mutations.length === 0) return undefined;
    const perPolicy = new Map<string, number>();
    const bytesPerPolicy = new Map<string, number>();
    const removalsPerPolicy = new Map<string, number>();
    const removedBytesPerPolicy = new Map<string, number>();
    const tombstoneAdds = new Map<string, number>();
    const stagedTargets = new Set<string>();
    const stagedSupersedes = new Set<string>();
    const stagedErases = new Set<string>();
    const stagedWriteScopes = new Set<string>();
    for (const mutation of mutations) {
      const policy = current.memory.policies.find(
        (candidate) => candidate.id === mutation.policyId,
      );
      if (
        !policy ||
        mutations.filter((candidate) => candidate.policyId === mutation.policyId).length >
          policy.maxMutationsPerTurn
      ) {
        return "invalid-turn-state";
      }
      if (
        (mutation.kind === "write" || mutation.kind === "supersede") &&
        mutation.body.byteLength > policy.maxEntryBytes
      )
        return "invalid-turn-state";
      if (mutation.kind === "write" || mutation.kind === "supersede") {
        try {
          decodeDistributedMemoryDocument(mutation.body);
        } catch {
          return "invalid-turn-state";
        }
      }
      const peerScope = distributedMemoryPeerScope(peerBinding);
      let affectedPeerScope = peerScope;
      if (mutation.kind === "forget") {
        try {
          affectedPeerScope = distributedMemoryEraseTargetScope(mutation.targetPeerId);
        } catch {
          return "invalid-turn-state";
        }
      }
      const semanticHash = memorySemanticHash(mutation, affectedPeerScope, policy.namespacePrefix);
      const existingOperation = current.memoryOperations.get(mutation.operationId);
      if (existingOperation && existingOperation.semanticHash !== semanticHash)
        return "memory-conflict";
      if (existingOperation) continue;
      if (
        [...current.memoryOperations.values()].filter(
          (operation) => operation.policyId === policy.id,
        ).length +
          mutations.filter(
            (candidate) =>
              candidate.policyId === policy.id &&
              !current.memoryOperations.has(candidate.operationId),
          ).length >
        policy.maxOperations
      ) {
        return "memory-capacity";
      }
      if (mutation.kind === "forget") {
        if (peerBinding.trustLevel !== "creator" && peerBinding.trustLevel !== "agent") {
          return "memory-conflict";
        }
        const eraseKey = `${policy.id}\0${affectedPeerScope}`;
        if (stagedErases.has(eraseKey) || stagedWriteScopes.has(eraseKey)) {
          return "memory-conflict";
        }
        stagedErases.add(eraseKey);
        if (!current.memoryTombstones.has(memoryTombstoneKey(policy.id, affectedPeerScope, "*"))) {
          tombstoneAdds.set(policy.id, (tombstoneAdds.get(policy.id) ?? 0) + 1);
        }
        continue;
      }
      const writeScope = `${policy.id}\0${peerScope}`;
      if (stagedErases.has(writeScope)) return "memory-conflict";
      stagedWriteScopes.add(writeScope);
      const key = memoryEntryKey(policy.id, peerScope, mutation.entryId);
      const eraseEpoch =
        current.memoryPeerEraseEpochs.get(memoryPeerEraseKey(policy.id, peerScope))?.epoch ?? 0;
      if (mutation.expectedPeerEraseEpoch !== eraseEpoch) return "memory-conflict";
      const tombstone = memoryTombstoneKey(policy.id, peerScope, mutation.entryId);
      if (
        stagedTargets.has(key) ||
        current.memoryEntries.has(key) ||
        current.memoryTombstones.has(key) ||
        current.memoryTombstones.has(tombstone)
      )
        return "memory-conflict";
      if (mutation.kind === "supersede") {
        const previousKey = memoryEntryKey(policy.id, peerScope, mutation.supersedesEntryId);
        const previous = current.memoryEntries.get(previousKey);
        if (stagedSupersedes.has(previousKey) || !previous) return "memory-conflict";
        stagedSupersedes.add(previousKey);
        removalsPerPolicy.set(policy.id, (removalsPerPolicy.get(policy.id) ?? 0) + 1);
        removedBytesPerPolicy.set(
          policy.id,
          (removedBytesPerPolicy.get(policy.id) ?? 0) + previous.body.byteLength,
        );
        tombstoneAdds.set(policy.id, (tombstoneAdds.get(policy.id) ?? 0) + 1);
      }
      stagedTargets.add(key);
      perPolicy.set(policy.id, (perPolicy.get(policy.id) ?? 0) + 1);
      bytesPerPolicy.set(
        policy.id,
        (bytesPerPolicy.get(policy.id) ?? 0) + mutation.body.byteLength,
      );
    }
    for (const [policyId, additions] of perPolicy) {
      const policy = current.memory.policies.find((candidate) => candidate.id === policyId)!;
      const total = [...current.memoryEntries.keys()].filter((key) =>
        key.startsWith(`${policyId}\0`),
      ).length;
      let peer = 0;
      let totalBytes = 0;
      let peerBytes = 0;
      for (const [key, entry] of current.memoryEntries) {
        if (key.startsWith(`${policyId}\0`)) {
          totalBytes += entry.body.byteLength;
          if (entry.peerIdHash === distributedMemoryPeerScope(peerBinding)) {
            peer += 1;
            peerBytes += entry.body.byteLength;
          }
        }
      }
      const removals = removalsPerPolicy.get(policyId) ?? 0;
      const removedBytes = removedBytesPerPolicy.get(policyId) ?? 0;
      const additionsBytes = bytesPerPolicy.get(policyId) ?? 0;
      if (
        total - removals + additions > policy.maxEntries ||
        peer - removals + additions > policy.maxEntriesPerPeer ||
        totalBytes - removedBytes + additionsBytes > policy.maxBytes ||
        peerBytes - removedBytes + additionsBytes > policy.maxBytesPerPeer
      )
        return "memory-capacity";
    }
    for (const [policyId, additions] of tombstoneAdds) {
      const policy = current.memory.policies.find((candidate) => candidate.id === policyId)!;
      const retained = [...current.memoryTombstones.keys()].filter((key) =>
        key.startsWith(`${policyId}\0`),
      ).length;
      if (retained + additions > policy.maxTombstones) return "memory-capacity";
    }
    return undefined;
  }

  function applyMemoryMutations(
    current: NamespaceState,
    peerBinding: DistributedPeerBindingV1,
    mutations: readonly DistributedMemoryMutationV1[] | undefined,
    timestamp: number,
  ): void {
    if (!mutations) return;
    const peerIdHash = distributedMemoryPeerScope(peerBinding);
    for (const mutation of mutations) {
      const policy = current.memory.policies.find(
        (candidate) => candidate.id === mutation.policyId,
      )!;
      const affectedPeerScope =
        mutation.kind === "forget"
          ? distributedMemoryEraseTargetScope(mutation.targetPeerId)
          : peerIdHash;
      const semanticHash = memorySemanticHash(mutation, affectedPeerScope, policy.namespacePrefix);
      if (current.memoryOperations.has(mutation.operationId)) continue;
      current.memoryOperations.set(mutation.operationId, {
        semanticHash,
        policyId: policy.id,
        expiresAt: timestamp + policy.operationRetentionMs,
      });
      if (mutation.kind === "forget") {
        const targetScope = distributedMemoryEraseTargetScope(mutation.targetPeerId);
        for (const key of current.memoryEntries.keys()) {
          if (key.startsWith(`${policy.id}\0${targetScope}\0`)) current.memoryEntries.delete(key);
        }
        current.memoryTombstones.set(memoryTombstoneKey(policy.id, targetScope, "*"), timestamp);
        const eraseKey = memoryPeerEraseKey(policy.id, targetScope);
        const prior = current.memoryPeerEraseEpochs.get(eraseKey)?.epoch ?? 0;
        current.memoryPeerEraseEpochs.set(eraseKey, {
          epoch: prior + 1,
          expiresAt: timestamp + policy.operationRetentionMs,
        });
      } else {
        const entryKey = memoryEntryKey(policy.id, peerIdHash, mutation.entryId);
        if (mutation.kind === "supersede") {
          const oldKey = memoryEntryKey(policy.id, peerIdHash, mutation.supersedesEntryId);
          current.memoryEntries.delete(oldKey);
          current.memoryTombstones.set(
            memoryTombstoneKey(policy.id, peerIdHash, mutation.supersedesEntryId),
            timestamp,
          );
        }
        current.memoryEntries.set(entryKey, {
          id: mutation.entryId,
          peerIdHash,
          body: new Uint8Array(mutation.body),
          content: decodeDistributedMemoryDocument(mutation.body).content,
          sourceTurnId: mutation.sourceTurnId,
          origin: mutation.origin,
          provenanceHash: mutation.provenanceHash,
          createdAt: timestamp,
        });
      }
    }
  }

  function validDeliveryReason(value: string): boolean {
    return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value);
  }

  function unresolvedOutbox(intent: StoredOutboxIntent): boolean {
    return (
      intent.state === "pending" ||
      intent.state === "delivering" ||
      intent.state === "outcome_unknown"
    );
  }

  function expireOutbox(current: NamespaceState, timestamp: number): void {
    for (const intent of current.outbox.values()) {
      if (intent.state !== "delivering" || (intent.leaseExpiresAt ?? 0) > timestamp) continue;
      intent.ownerInstance = undefined;
      intent.ownerSession = undefined;
      intent.leaseExpiresAt = undefined;
      intent.updatedAt = timestamp;
      if (intent.retryMode === "sink-idempotent" && intent.attempt < intent.maxAttempts) {
        intent.state = "pending";
        intent.reasonCode = "delivery-lease-expired-retry-safe";
      } else {
        intent.state = "outcome_unknown";
        intent.settledAt = timestamp;
        intent.reasonCode = "delivery-lease-expired";
      }
    }
  }

  function copyOutboxLease(
    current: NamespaceState,
    intent: StoredOutboxIntent,
  ): DistributedOutboxLeaseV1 {
    const request = current.requests.get(intent.requestId);
    if (!request || intent.leaseExpiresAt === undefined) {
      throw new Error("outbox request or lease is missing");
    }
    return {
      version: 1,
      requestId: intent.requestId,
      threadId: request.threadId,
      ordinal: intent.ordinal,
      operationId: intent.operationId,
      body: new Uint8Array(intent.body),
      contentType: intent.contentType,
      retryMode: intent.retryMode,
      maxAttempts: intent.maxAttempts,
      attempt: intent.attempt,
      deliveryFence: intent.deliveryFence,
      leaseExpiresAt: new Date(intent.leaseExpiresAt).toISOString(),
    };
  }

  function ownsOutbox(
    current: NamespaceState,
    lease: DistributedOutboxLeaseV1,
    timestamp: number,
  ): StoredOutboxIntent | undefined {
    if (
      lease.version !== 1 ||
      !validOperationId(lease.operationId) ||
      !Number.isSafeInteger(lease.ordinal) ||
      lease.ordinal < 0 ||
      !Number.isSafeInteger(lease.attempt) ||
      lease.attempt < 1 ||
      !Number.isSafeInteger(lease.deliveryFence) ||
      lease.deliveryFence < 1
    ) {
      return undefined;
    }
    const intent = current.outbox.get(`${lease.requestId}:${lease.ordinal}`);
    if (
      intent?.state !== "delivering" ||
      intent.operationId !== lease.operationId ||
      intent.attempt !== lease.attempt ||
      intent.deliveryFence !== lease.deliveryFence ||
      intent.ownerInstance !== config.instanceId ||
      intent.ownerSession !== sessionId ||
      (intent.leaseExpiresAt ?? 0) <= timestamp
    ) {
      return undefined;
    }
    return intent;
  }

  return {
    supportsAdmissionPolicy(requirements) {
      try {
        const expectedCapacity = requirements.capacityClasses ?? [];
        const expectedRates = requirements.rateLimits ?? [];
        if (!Array.isArray(expectedCapacity) || !Array.isArray(expectedRates)) return false;
        return (
          expectedCapacity.every((expected) => {
            const stored = (admission.capacityClasses ?? []).find(
              (candidate) => candidate.id === expected.id,
            );
            return (
              stored?.maxRetainedRequests === expected.maxRetainedRequests &&
              stored?.maxRetainedRequestsPerPartition === expected.maxRetainedRequestsPerPartition
            );
          }) &&
          expectedRates.every((expected) => {
            const stored = admission.rateLimits.find((candidate) => candidate.id === expected.id);
            return (
              stored !== undefined &&
              stored.max === expected.max &&
              stored.windowMs === expected.windowMs &&
              (expected.minRetainedEvents === undefined ||
                stored.maxEvents >= expected.minRetainedEvents)
            );
          })
        );
      } catch {
        return false;
      }
    },
    supportsBudgetPolicy(policy) {
      try {
        const normalized = normalizeDistributedBudgetConfig(
          { policies: [policy] },
          config.retention.terminalRequestRetentionMs,
        ).policies[0]!;
        const stored = budgets.policies.find((candidate) => candidate.id === normalized.id);
        return stored !== undefined && sameDistributedBudgetPolicy(stored, normalized);
      } catch {
        return false;
      }
    },
    supportsMemoryPolicy(policy) {
      try {
        const normalized = normalizeDistributedMemoryConfig(
          { policies: [policy] },
          config.retention.terminalRequestRetentionMs,
        ).policies[0]!;
        const stored = memory.policies.find((candidate) => candidate.id === normalized.id);
        return stored !== undefined && sameDistributedMemoryPolicy(stored, normalized);
      } catch {
        return false;
      }
    },
    register: () =>
      safe<RegistrationResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state(true, false)!;
            if (
              !sameCompatibility(current.compatibility, compatibilityTuple()) &&
              !upgradeQuiescentCompatibility(current, timestamp)
            ) {
              throw new Error("coordinator namespace policy mismatch");
            }
            namespacePolicy(current);
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
      safe<AdmitResult>(
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
                trackOwned(request, "queued", existing.queueGeneration);
                return { status: "adopted", attempt: existing.queueGeneration };
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
            const capacityResult = reserveRequestCapacity(current, request);
            if (capacityResult.status === "rejected") return capacityResult;
            const admissionResult = reserveAdmission(
              current,
              request.requestId,
              request.admission ?? [],
              timestamp,
            );
            if (admissionResult.status === "rejected") return admissionResult;
            current.requests.set(request.requestId, {
              ...request,
              source: { ...policy },
              ...(request.capacity ? { capacity: { ...request.capacity } } : {}),
              admission: request.admission?.map((reservation) => ({ ...reservation })),
              state: "queued",
              queuedAt: timestamp,
              executionStarted: false,
              queueOwnerInstance: config.instanceId,
              queueOwnerSession: sessionId,
              queueGeneration: 1,
              queueExpiresAt: timestamp + config.leaseMs,
            });
            trackOwned(request, "queued", 1);
            return { status: "admitted", attempt: 1 };
          }),
        { status: "unavailable" } as AdmitResult,
      ),
    reserveRateLimits: (request) =>
      safe<DistributedRateReservationResult>(
        () =>
          exclusive(() => {
            if (
              !/^rate:[A-Za-z0-9][A-Za-z0-9._:-]{0,154}$/.test(request.reservationId) ||
              !Array.isArray(request.admission) ||
              request.admission.length !== 1
            ) {
              return { status: "rejected", reason: "invalid-admission" };
            }
            for (const reservation of request.admission) {
              assertIdentifier("admission.policyId", reservation.policyId);
              if (!/^[0-9a-f]{64}$/.test(reservation.subjectHash)) {
                return { status: "rejected", reason: "invalid-admission" };
              }
            }
            const timestamp = now();
            const current = operationalState(timestamp);
            if (!liveInstance(current, timestamp, true)) {
              return { status: "rejected", reason: "draining" };
            }
            for (const [reservationId, stored] of current.rateReservations) {
              if (stored.expiresAt <= timestamp) current.rateReservations.delete(reservationId);
            }
            const bindingHash = canonicalAdmission(request.admission);
            const existing = current.rateReservations.get(request.reservationId);
            if (existing) {
              return existing.bindingHash === bindingHash
                ? { status: "replayed" }
                : { status: "conflict" };
            }
            const result = reserveAdmission(
              current,
              request.reservationId,
              request.admission,
              timestamp,
            );
            if (result.status === "rejected") return result;
            current.rateReservations.set(request.reservationId, {
              bindingHash,
              expiresAt: result.expiresAt,
            });
            return { status: "reserved" };
          }),
        { status: "unavailable" },
      ),
    heartbeatQueued: (request, attempt = 1) =>
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
              stored.queueGeneration !== attempt ||
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
          if (result.status !== "ok") {
            abortOwnedAttempt(request.requestId, attempt, "queue-ownership-lost");
          }
        },
      ),
    abandon: (request, attempt = 1) =>
      safe<LeaseResult>(
        () =>
          exclusive(() => {
            assertRequest(request);
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const stored = current.requests.get(request.requestId);
            const ownsQueued =
              stored?.state === "queued" &&
              sameQueueOwner(stored) &&
              (stored.queueExpiresAt ?? 0) > timestamp;
            const ownsUnstartedActive =
              stored?.state === "active" &&
              stored.ownerInstance === config.instanceId &&
              stored.ownerSession === sessionId &&
              (stored.expiresAt ?? 0) > timestamp &&
              stored.executionStarted === false;
            if (
              !stored ||
              !sameBinding(stored, request) ||
              stored.queueGeneration !== attempt ||
              (!ownsQueued && !ownsUnstartedActive)
            ) {
              return { status: "stale" };
            }
            stored.state = "canceled";
            stored.terminalAt = timestamp;
            stored.queueOwnerInstance = undefined;
            stored.queueOwnerSession = undefined;
            stored.queueExpiresAt = undefined;
            stored.ownerInstance = undefined;
            stored.ownerSession = undefined;
            stored.expiresAt = undefined;
            releaseBudgetReservationsForRequest(current, stored.requestId, stored.queueGeneration);
            return { status: "ok" };
          }, true),
        { status: "unavailable" },
        (result) => {
          if (result.status === "ok") {
            abortOwnedAttempt(request.requestId, attempt, "pre-start-abandoned");
          }
        },
        true,
      ),
    claim: (request, attempt = 1) =>
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
            if (
              !Number.isSafeInteger(attempt) ||
              attempt <= 0 ||
              stored.queueGeneration !== attempt
            ) {
              return { status: "stale" };
            }
            if (!sameQueueOwner(stored)) {
              return (stored.queueExpiresAt ?? 0) > timestamp
                ? { status: "waiting" }
                : { status: "stale" };
            }
            if ((stored.queueExpiresAt ?? 0) <= timestamp) return { status: "stale" };
            if (!liveInstance(current, timestamp, true)) return { status: "waiting" };
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
            trackOwned(request, "active", stored.queueGeneration);
            return { status: "acquired", lease: leaseFrom(stored) };
          }),
        { status: "unavailable" } as ClaimResult,
      ),
    ownedSignal: (request) => {
      if (invalidated) return unavailableSignal();
      try {
        assertRequest(request);
      } catch {
        return unavailableSignal();
      }
      const operation = owned.get(request.requestId);
      return operation &&
        operation.bindingHash === request.bindingHash &&
        operation.admissionHash === canonicalRequestAdmission(request) &&
        operation.threadId === request.threadId &&
        operation.sourceId === request.source.id
        ? operation.controller.signal
        : unavailableSignal();
    },
    invalidateLocalAuthority: () => {
      if (invalidated) return;
      invalidated = true;
      abortAllOwned("coordinator-authority-lost");
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
    reserveBudget: (lease, request) => {
      try {
        assertIdentifier("budget.policyId", request.policyId);
      } catch {
        return Promise.resolve({ status: "unavailable" });
      }
      if (
        typeof request.peerId !== "string" ||
        request.peerId.length < 1 ||
        request.peerId.length > 256 ||
        request.threadId !== lease.threadId ||
        (request.trustLevel !== "agent" && request.trustLevel !== "public") ||
        (request.trustLevel === "public"
          ? request.publicSubstate !== "anonymous" && request.publicSubstate !== "recognized"
          : request.publicSubstate !== undefined)
      ) {
        return Promise.resolve({ status: "unavailable" });
      }
      const policy = budgets.policies.find((candidate) => candidate.id === request.policyId);
      if (!policy) return Promise.resolve({ status: "unavailable" });
      const peerIdHash = budgetDigest(
        "auggy-distributed-budget-peer-v1",
        config.namespace,
        request.peerId,
      );
      const threadIdHash = budgetDigest(
        "auggy-distributed-budget-thread-v1",
        config.namespace,
        request.threadId,
      );
      return safe<DistributedBudgetReservationResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored || stored.executionStarted) return { status: "stale" };
            const key = budgetReservationKey(policy.id, lease.requestId);
            const existing = current.budgetReservations.get(key);
            if (existing) {
              const matches =
                existing.bindingHash === stored.bindingHash &&
                existing.peerIdHash === peerIdHash &&
                existing.threadIdHash === threadIdHash &&
                existing.trustLevel === request.trustLevel &&
                existing.publicSubstate === request.publicSubstate &&
                existing.attempt === lease.attempt &&
                existing.fence === lease.fence;
              return matches
                ? {
                    status: "replayed",
                    ...budgetUsage(
                      current,
                      policy.id,
                      existing.admissionDay,
                      peerIdHash,
                      threadIdHash,
                    ),
                  }
                : { status: "conflict" };
            }

            current.budgetAnonymousEvents = current.budgetAnonymousEvents.filter(
              (event) => event.expiresAt > timestamp,
            );
            pruneBudgetEvidence(current, timestamp, policy.id);
            const policyReservations = [...current.budgetReservations.values()].filter(
              (reservation) => reservation.policyId === policy.id,
            ).length;
            const policyAnonymousEvents = current.budgetAnonymousEvents.filter(
              (event) => event.policyId === policy.id,
            ).length;
            const admissionDay = budgetDay(timestamp);
            const policyThresholds = [...current.budgetThresholds.keys()].filter((key) =>
              key.startsWith(`${policy.id}\0`),
            );
            const prospectiveThresholdDays = new Set(
              [...current.budgetReservations.values()]
                .filter(
                  (reservation) =>
                    reservation.policyId === policy.id && reservation.state === "reserved",
                )
                .map((reservation) => reservation.admissionDay),
            );
            prospectiveThresholdDays.add(admissionDay);
            const prospectiveThresholdIntents = policyThresholds.filter((key) => {
              const [, day] = key.split("\0");
              return prospectiveThresholdDays.has(day!);
            }).length;
            if (
              policyReservations >= policy.maxReservations ||
              policyThresholds.length +
                (policy.notifications?.thresholds.length ?? 0) * prospectiveThresholdDays.size -
                prospectiveThresholdIntents >
                policy.maxThresholdIntents ||
              (request.publicSubstate === "anonymous" &&
                policy.anonymousGlobalLimit !== undefined &&
                policyAnonymousEvents >= policy.maxAnonymousEvents)
            ) {
              return { status: "rejected", reason: "budget-capacity" };
            }
            const caps = resolveDistributedBudgetCaps(
              policy,
              request.trustLevel,
              request.publicSubstate,
            );
            const usage = budgetUsage(current, policy.id, admissionDay, peerIdHash, threadIdHash);
            if (
              request.publicSubstate === "anonymous" &&
              policy.anonymousGlobalLimit !== undefined &&
              current.budgetAnonymousEvents.filter(
                (event) => event.policyId === policy.id && event.occurredAt > timestamp - 60_000,
              ).length >= policy.anonymousGlobalLimit
            ) {
              return { status: "rejected", reason: "anonymous-rate-cap" };
            }
            const globalCostNanos =
              current.budgetDaily.get(
                budgetDailyKey(policy.id, admissionDay, "global", GLOBAL_BUDGET_SUBJECT_HASH),
              )?.costNanos ?? 0n;
            const peerCostNanos =
              current.budgetDaily.get(budgetDailyKey(policy.id, admissionDay, "peer", peerIdHash))
                ?.costNanos ?? 0n;
            if (
              policy.dailyBudgetUsd !== undefined &&
              globalCostNanos >= distributedBudgetCostNanos(policy.dailyBudgetUsd)
            ) {
              return { status: "rejected", reason: "daily-global-usd-cap" };
            }
            if (
              caps?.maxUsdPerDay !== undefined &&
              peerCostNanos >= distributedBudgetCostNanos(caps.maxUsdPerDay)
            ) {
              return { status: "rejected", reason: "daily-peer-usd-cap" };
            }
            if (
              caps?.maxTurnsPerThread !== undefined &&
              usage.threadTurns >= caps.maxTurnsPerThread
            ) {
              return { status: "rejected", reason: "daily-thread-turn-cap" };
            }
            if (caps?.maxTurnsPerDay !== undefined && usage.peerTurns >= caps.maxTurnsPerDay) {
              return { status: "rejected", reason: "daily-turn-cap" };
            }
            const peerDayKey = budgetDailyKey(policy.id, admissionDay, "peer", peerIdHash);
            const peerDayCount = [...current.budgetDaily.keys()].filter((key) => {
              const [storedPolicyId, , kind] = key.split("\0");
              return storedPolicyId === policy.id && kind === "peer";
            }).length;
            if (!current.budgetDaily.has(peerDayKey) && peerDayCount >= policy.maxPeerDays) {
              return { status: "rejected", reason: "budget-capacity" };
            }
            for (const [kind, subjectHash] of [
              ["global", GLOBAL_BUDGET_SUBJECT_HASH],
              ["peer", peerIdHash],
            ] as const) {
              const dailyKey = budgetDailyKey(policy.id, admissionDay, kind, subjectHash);
              const daily = current.budgetDaily.get(dailyKey) ?? {
                turns: 0,
                costNanos: 0n,
                unpricedTurns: 0,
              };
              daily.turns++;
              current.budgetDaily.set(dailyKey, daily);
            }
            current.budgetReservations.set(key, {
              policyId: policy.id,
              requestId: lease.requestId,
              bindingHash: stored.bindingHash,
              peerIdHash,
              threadIdHash,
              trustLevel: request.trustLevel,
              ...(request.publicSubstate ? { publicSubstate: request.publicSubstate } : {}),
              attempt: lease.attempt,
              fence: lease.fence,
              admissionDay,
              state: "reserved",
              reservedAt: timestamp,
            });
            if (
              request.publicSubstate === "anonymous" &&
              policy.anonymousGlobalLimit !== undefined
            ) {
              current.budgetAnonymousEvents.push({
                policyId: policy.id,
                requestId: lease.requestId,
                subjectHash: peerIdHash,
                occurredAt: timestamp,
                expiresAt: timestamp + 60_000,
              });
            }
            return {
              status: "reserved",
              ...budgetUsage(current, policy.id, admissionDay, peerIdHash, threadIdHash),
            };
          }),
        { status: "unavailable" },
      );
    },
    releaseBudget: (lease, policyId) => {
      try {
        assertIdentifier("budget.policyId", policyId);
      } catch {
        return Promise.resolve({ status: "unavailable" });
      }
      return safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored || stored.executionStarted) return { status: "stale" };
            releaseBudgetReservation(
              current,
              policyId,
              lease.requestId,
              lease.attempt,
              lease.fence,
            );
            return { status: "ok" };
          }),
        { status: "unavailable" },
      );
    },
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
    loadHistory: (lease, peerBinding) => {
      if (!validDistributedPeerBinding(peerBinding)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-peer-binding" });
      }
      return safe<DistributedHistoryLoadResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored || stored.executionStarted) return { status: "stale" };

            let history = current.histories.get(lease.threadId);
            if (!history) {
              const reservations = [...current.requests.values()].filter(
                (request) =>
                  request !== stored &&
                  request.state === "active" &&
                  request.historyClaim?.expectedRevision === 0 &&
                  !current.histories.has(request.threadId),
              ).length;
              if (
                !stored.historyClaim &&
                current.histories.size + reservations >= current.turnState.history.maxThreads
              ) {
                return { status: "rejected", reason: "history-capacity" };
              }
              history = {
                version: 1,
                binding: copyPeerBinding(peerBinding),
                body: new Uint8Array(EMPTY_DISTRIBUTED_HISTORY),
                messageCount: 0,
                revision: 0,
              };
            } else if (
              !samePeerBinding(history.binding, peerBinding) &&
              !allowsAuthenticatedPromotion(history.binding, peerBinding)
            ) {
              return { status: "denied" };
            }

            if (
              stored.historyClaim &&
              (!samePeerBinding(stored.historyClaim.binding, peerBinding) ||
                stored.historyClaim.expectedRevision !== history.revision)
            ) {
              return { status: "denied" };
            }
            stored.historyClaim = {
              binding: copyPeerBinding(peerBinding),
              expectedRevision: history.revision,
            };
            return {
              status: "ok",
              revision: history.revision,
              ...copyHistory(history),
            };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status === "stale" || result.status === "unavailable") {
            abortOwned(lease.requestId, "lease-ownership-lost");
          }
        },
      );
    },
    readMemory: (lease, request) =>
      safe<DistributedMemoryReadResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            pruneMemory(current, timestamp);
            if (
              !validPeerBinding(request.peerBinding) ||
              !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.entryId)
            ) {
              return { status: "rejected", reason: "invalid-memory-request" };
            }
            const policy = current.memory.policies.find(
              (candidate) => candidate.id === request.policyId,
            );
            if (!policy) return { status: "denied" };
            const owned = owns(current, lease, timestamp);
            if (!owned?.executionStarted || !owned.historyClaim) return { status: "stale" };
            if (!samePeerBinding(owned.historyClaim.binding, request.peerBinding)) {
              return { status: "denied" };
            }
            const entry = current.memoryEntries.get(
              memoryEntryKey(
                policy.id,
                distributedMemoryPeerScope(request.peerBinding),
                request.entryId,
              ),
            );
            if (!entry) return { status: "missing" };
            return {
              status: "ok",
              entry: {
                version: 1,
                id: entry.id,
                body: new Uint8Array(entry.body),
                sourceTurnId: entry.sourceTurnId,
                origin: entry.origin,
                provenanceHash: entry.provenanceHash,
                createdAt: new Date(entry.createdAt).toISOString(),
              },
            };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status === "stale" || result.status === "unavailable") {
            abortOwned(lease.requestId, "lease-ownership-lost");
          }
        },
      ),
    loadMemoryPeerEpoch: (lease, request) =>
      safe<DistributedMemoryPeerEpochResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            pruneMemory(current, timestamp);
            if (!validPeerBinding(request.peerBinding)) {
              return { status: "rejected", reason: "invalid-memory-request" };
            }
            const policy = current.memory.policies.find(
              (candidate) => candidate.id === request.policyId,
            );
            if (!policy) return { status: "denied" };
            const owned = owns(current, lease, timestamp);
            if (!owned?.executionStarted || !owned.historyClaim) return { status: "stale" };
            if (!samePeerBinding(owned.historyClaim.binding, request.peerBinding)) {
              return { status: "denied" };
            }
            return {
              status: "ok",
              eraseEpoch:
                current.memoryPeerEraseEpochs.get(
                  memoryPeerEraseKey(policy.id, distributedMemoryPeerScope(request.peerBinding)),
                )?.epoch ?? 0,
            };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status === "stale" || result.status === "unavailable") {
            abortOwned(lease.requestId, "lease-ownership-lost");
          }
        },
      ),
    searchMemory: (lease, request) =>
      safe<DistributedMemorySearchResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            pruneMemory(current, timestamp);
            if (
              !validPeerBinding(request.peerBinding) ||
              !(request.query instanceof Uint8Array) ||
              !Number.isSafeInteger(request.limit) ||
              request.limit < 1
            ) {
              return { status: "rejected", reason: "invalid-memory-request" };
            }
            const policy = current.memory.policies.find(
              (candidate) => candidate.id === request.policyId,
            );
            if (!policy) return { status: "denied" };
            if (
              request.query.byteLength > policy.maxQueryBytes ||
              request.limit > policy.maxResults
            ) {
              return { status: "rejected", reason: "invalid-memory-request" };
            }
            let query: { contains: string };
            try {
              query = decodeDistributedMemoryQuery(request.query);
            } catch {
              return { status: "rejected", reason: "invalid-memory-request" };
            }
            const owned = owns(current, lease, timestamp);
            if (!owned?.executionStarted || !owned.historyClaim) return { status: "stale" };
            if (!samePeerBinding(owned.historyClaim.binding, request.peerBinding)) {
              return { status: "denied" };
            }
            let bytes = 0;
            const entries: DistributedMemoryEntryV1[] = [];
            const candidates: StoredMemoryEntry[] = [];
            const compare = (left: StoredMemoryEntry, right: StoredMemoryEntry) =>
              right.createdAt - left.createdAt || left.id.localeCompare(right.id);
            for (const [key, candidate] of current.memoryEntries) {
              if (
                !key.startsWith(`${policy.id}\0`) ||
                candidate.peerIdHash !== distributedMemoryPeerScope(request.peerBinding) ||
                !candidate.content.includes(query.contains)
              ) {
                continue;
              }
              let index = candidates.findIndex((existing) => compare(candidate, existing) < 0);
              if (index < 0) index = candidates.length;
              candidates.splice(index, 0, candidate);
              if (candidates.length > request.limit) candidates.pop();
            }
            for (const entry of candidates) {
              if (
                entries.length >= request.limit ||
                bytes + entry.body.byteLength > policy.maxResultBytes
              )
                break;
              bytes += entry.body.byteLength;
              entries.push({
                version: 1,
                id: entry.id,
                body: new Uint8Array(entry.body),
                sourceTurnId: entry.sourceTurnId,
                origin: entry.origin,
                provenanceHash: entry.provenanceHash,
                createdAt: new Date(entry.createdAt).toISOString(),
              });
            }
            return { status: "ok", entries };
          }),
        { status: "unavailable" },
        (result) => {
          if (result.status === "stale" || result.status === "unavailable") {
            abortOwned(lease.requestId, "lease-ownership-lost");
          }
        },
      ),
    commitTurn: (lease, checkpoint) => {
      const checkpointRejection = validateDistributedTurnCheckpoint(
        checkpoint,
        config.turnState,
        config.result,
        lease.threadId,
      );
      if (checkpointRejection) return Promise.resolve(checkpointRejection);
      if (!validPeerBinding(checkpoint.peerBinding)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-turn-state" });
      }
      if (
        !Number.isSafeInteger(checkpoint.expectedHistoryRevision) ||
        checkpoint.expectedHistoryRevision < 0
      ) {
        return Promise.resolve({ status: "rejected", reason: "invalid-turn-state" });
      }
      if (checkpoint.history.body.byteLength > config.turnState.history.maxSnapshotBytes) {
        return Promise.resolve({ status: "rejected", reason: "history-too-large" });
      }
      if (!validHistory(checkpoint.history)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-history" });
      }
      if (!validReplayResult(checkpoint.replay)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-result" });
      }
      if (checkpoint.replay.body.byteLength > config.result.maxReplayBytes) {
        return Promise.resolve({ status: "rejected", reason: "result-too-large" });
      }
      if (
        !validCostMarkers(checkpoint.costMarkers) ||
        !validOutboxIntents(checkpoint.outboxIntents)
      ) {
        return Promise.resolve({ status: "rejected", reason: "invalid-turn-state" });
      }
      return safe<LeaseResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expire(current, timestamp);
            const stored = owns(current, lease, timestamp);
            if (!stored) return { status: "stale" };

            if (
              checkpoint.memoryMutations?.some(
                (mutation) => mutation.sourceTurnId !== lease.requestId,
              )
            ) {
              return { status: "rejected", reason: "invalid-turn-state" };
            }

            const history = current.histories.get(lease.threadId);
            pruneMemory(current, timestamp);
            const memoryRejection = preflightMemoryMutations(
              current,
              checkpoint.peerBinding,
              checkpoint.memoryMutations,
              timestamp,
            );
            if (memoryRejection) return { status: "rejected", reason: memoryRejection };
            const historyMatches =
              stored.executionStarted &&
              stored.historyClaim !== undefined &&
              samePeerBinding(stored.historyClaim.binding, checkpoint.peerBinding) &&
              stored.historyClaim.expectedRevision === checkpoint.expectedHistoryRevision &&
              (history
                ? history.revision === checkpoint.expectedHistoryRevision &&
                  (samePeerBinding(history.binding, checkpoint.peerBinding) ||
                    allowsAuthenticatedPromotion(history.binding, checkpoint.peerBinding))
                : checkpoint.expectedHistoryRevision === 0);
            const duplicateCostOperations = new Set(
              checkpoint.costMarkers
                .filter((marker) => current.costMarkers.has(marker.operationId))
                .map((marker) => marker.operationId),
            );
            const existingOutboxOperations = new Set(
              [...current.outbox.values()].map((intent) => intent.operationId),
            );
            const duplicateOutbox = checkpoint.outboxIntents.some((intent) =>
              existingOutboxOperations.has(intent.operationId),
            );
            const pendingOutboxCapacityExceeded =
              [...current.outbox.values()].filter(unresolvedOutbox).length +
                checkpoint.outboxIntents.length >
              current.turnState.outbox.maxPendingIntents;
            const historyCapacityExceeded =
              !history && current.histories.size >= current.turnState.history.maxThreads;
            if (
              !historyMatches ||
              duplicateCostOperations.size > 0 ||
              duplicateOutbox ||
              pendingOutboxCapacityExceeded ||
              historyCapacityExceeded
            ) {
              settleBudgetAccounting(
                current,
                lease,
                outcomeUnknownAccountingMarkers(
                  lease,
                  checkpoint.costMarkers,
                  duplicateCostOperations,
                ),
                "outcome_unknown",
                timestamp,
              );
              for (const marker of checkpoint.costMarkers) {
                if (!duplicateCostOperations.has(marker.operationId)) {
                  current.costMarkers.set(marker.operationId, {
                    ...marker,
                    requestId: lease.requestId,
                    fence: lease.fence,
                  });
                }
              }
              quarantine(current, stored, timestamp, "effect-outcome-unknown");
              return { status: "outcome-unknown" };
            }

            settleBudgetAccounting(current, lease, checkpoint.costMarkers, "committed", timestamp);
            current.histories.set(lease.threadId, {
              version: 1,
              binding: copyPeerBinding(checkpoint.peerBinding),
              body: new Uint8Array(checkpoint.history.body),
              messageCount: checkpoint.history.messageCount,
              revision: (history?.revision ?? 0) + 1,
            });
            applyMemoryMutations(
              current,
              checkpoint.peerBinding,
              checkpoint.memoryMutations,
              timestamp,
            );
            for (const marker of checkpoint.costMarkers) {
              current.costMarkers.set(marker.operationId, {
                ...marker,
                requestId: lease.requestId,
                fence: lease.fence,
              });
            }
            for (const intent of checkpoint.outboxIntents) {
              current.outbox.set(`${lease.requestId}:${intent.ordinal}`, {
                ...intent,
                body: new Uint8Array(intent.body),
                requestId: lease.requestId,
                fence: lease.fence,
                state: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
                attempt: 0,
                deliveryFence: 0,
              });
            }
            stored.state = "completed";
            stored.terminalAt = timestamp;
            stored.ownerInstance = undefined;
            stored.ownerSession = undefined;
            stored.expiresAt = undefined;
            stored.result = copyReplayResult(checkpoint.replay);
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
    },
    claimOutbox: () =>
      safe<DistributedOutboxClaimResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp, true)) return { status: "stale" };
            expireOutbox(current, timestamp);
            const intent = [...current.outbox.values()]
              .filter(
                (candidate) =>
                  candidate.state === "pending" && candidate.attempt < candidate.maxAttempts,
              )
              .sort(
                (left, right) =>
                  left.createdAt - right.createdAt ||
                  left.requestId.localeCompare(right.requestId) ||
                  left.ordinal - right.ordinal,
              )[0];
            if (!intent) return { status: "waiting" };
            current.nextFence++;
            intent.state = "delivering";
            intent.attempt++;
            intent.deliveryFence = current.nextFence;
            intent.ownerInstance = config.instanceId;
            intent.ownerSession = sessionId;
            intent.leaseExpiresAt = timestamp + config.leaseMs;
            intent.updatedAt = timestamp;
            intent.settledAt = undefined;
            intent.reasonCode = undefined;
            return { status: "acquired", lease: copyOutboxLease(current, intent) };
          }),
        { status: "unavailable" },
      ),
    heartbeatOutbox: (lease) =>
      safe<DistributedOutboxResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const intent = ownsOutbox(current, lease, timestamp);
            if (!intent) return { status: "stale" };
            intent.leaseExpiresAt = timestamp + config.leaseMs;
            intent.updatedAt = timestamp;
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    settleOutbox: (lease, settlement) =>
      safe<DistributedOutboxResult>(
        () =>
          exclusive(() => {
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            const intent = ownsOutbox(current, lease, timestamp);
            if (!intent) return { status: "stale" };
            if (
              (settlement.outcome === "confirmed-failure" ||
                settlement.outcome === "outcome-unknown") &&
              !validDeliveryReason(settlement.reasonCode)
            ) {
              return { status: "rejected", reason: "invalid-delivery" };
            }
            intent.state =
              settlement.outcome === "delivered"
                ? "delivered"
                : settlement.outcome === "confirmed-failure"
                  ? "failed"
                  : "outcome_unknown";
            intent.reasonCode =
              settlement.outcome === "delivered" ? undefined : settlement.reasonCode;
            intent.ownerInstance = undefined;
            intent.ownerSession = undefined;
            intent.leaseExpiresAt = undefined;
            intent.settledAt = timestamp;
            intent.updatedAt = timestamp;
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    recoverOutbox: (operationId, expectedDeliveryFence, resolution, reasonCode) =>
      safe<DistributedOutboxResult>(
        () =>
          exclusive(() => {
            if (
              !validOperationId(operationId) ||
              !Number.isSafeInteger(expectedDeliveryFence) ||
              expectedDeliveryFence < 1 ||
              !validDeliveryReason(reasonCode) ||
              (resolution !== "delivered" &&
                resolution !== "confirmed-failure" &&
                resolution !== "retry")
            ) {
              return { status: "rejected", reason: "invalid-delivery" };
            }
            const timestamp = now();
            const current = state();
            if (!current || !liveInstance(current, timestamp)) return { status: "stale" };
            expireOutbox(current, timestamp);
            const intent = [...current.outbox.values()].find(
              (candidate) => candidate.operationId === operationId,
            );
            if (intent?.state !== "outcome_unknown") return { status: "stale" };
            if (intent.deliveryFence !== expectedDeliveryFence) return { status: "conflict" };
            if (resolution === "retry") {
              if (intent.retryMode !== "sink-idempotent" || intent.attempt >= intent.maxAttempts) {
                return { status: "rejected", reason: "retry-unsafe" };
              }
              intent.state = "pending";
              intent.settledAt = undefined;
            } else {
              intent.state = resolution === "delivered" ? "delivered" : "failed";
              intent.settledAt = timestamp;
            }
            intent.reasonCode = reasonCode;
            intent.updatedAt = timestamp;
            const request = current.requests.get(intent.requestId);
            if (!request) throw new Error("outbox recovery request is missing");
            recordEvent(
              current,
              {
                eventType: "operator_recovery",
                fence: expectedDeliveryFence,
                reasonCode,
                requestId: intent.requestId,
                threadId: request.threadId,
              },
              timestamp,
            );
            return { status: "ok" };
          }),
        { status: "unavailable" },
      ),
    complete: (lease, result) => {
      if (!validReplayResult(result)) {
        return Promise.resolve({ status: "rejected", reason: "invalid-result" });
      }
      if (result.body.byteLength > config.result.maxReplayBytes) {
        return Promise.resolve({ status: "rejected", reason: "result-too-large" });
      }
      if (config.compatibility.protocolVersion >= 5) {
        return Promise.resolve({ status: "rejected", reason: "atomic-turn-state-required" });
      }
      const current = state();
      if (current?.requests.get(lease.requestId)?.historyClaim) {
        return Promise.resolve({ status: "rejected", reason: "atomic-turn-state-required" });
      }
      return settle("completed", lease, copyReplayResult(result));
    },
    fail: (lease) => settle("failed", lease),
    markOutcomeUnknown: (lease, reasonCode) => settleUnknown(lease, reasonCode, []),
    settleOutcomeUnknown: (lease, reasonCode, costMarkers) =>
      settleUnknown(lease, reasonCode, costMarkers),
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
              if (
                current.compatibility.protocolVersion >= 5 &&
                !validDistributedReplay(stored.result, request.threadId)
              ) {
                throw new Error("invalid completed replay result");
              }
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
                  if (
                    current.compatibility.protocolVersion >= 5 &&
                    !validDistributedReplay(stored.result, request.threadId)
                  ) {
                    throw new Error("invalid completed replay result");
                  }
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
                  (request.state === "completed" ||
                    request.state === "failed" ||
                    request.state === "canceled") &&
                  ![...current.outbox.values()].some(
                    (intent) => intent.requestId === request.requestId && unresolvedOutbox(intent),
                  ),
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
            for (const request of removableRequests) {
              current.requests.delete(request.requestId);
              current.budgetAnonymousEvents = current.budgetAnonymousEvents.filter(
                (event) => event.requestId !== request.requestId,
              );
              for (const [operationId, marker] of current.costMarkers) {
                if (marker.requestId === request.requestId) current.costMarkers.delete(operationId);
              }
              for (const [key, intent] of current.outbox) {
                if (intent.requestId === request.requestId) current.outbox.delete(key);
              }
            }
            pruneBudgetEvidence(current, timestamp);

            const referencedThreadIds = new Set(
              [...current.requests.values()].map((request) => request.threadId),
            );
            const removableThreads = [...current.threads.entries()]
              .filter(
                ([threadId, thread]) => !thread.quarantined && !referencedThreadIds.has(threadId),
              )
              .sort(([left], [right]) => left.localeCompare(right))
              .slice(0, batchSize);
            for (const [threadId] of removableThreads) {
              current.histories.delete(threadId);
              current.threads.delete(threadId);
            }

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
            settleBudgetAccounting(
              current,
              lease,
              missingUsageAccountingMarkers(lease),
              "outcome_unknown",
              timestamp,
            );
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

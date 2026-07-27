import { migratePostgresCoordinator, type PostgresMigrationExecutor } from "./migrations";
import { createSecurePostgresCoordinationClient } from "./postgres-url";
import {
  distributedBudgetCostNanos,
  distributedBudgetPolicyFingerprint,
  formatDistributedBudgetCostNanos,
  isCanonicalDistributedBudgetCostUsd,
  MAX_DISTRIBUTED_BUDGET_COST_USD,
  normalizeDistributedBudgetConfig,
  parseDistributedBudgetCostNanos,
  resolveDistributedBudgetCaps,
  sameDistributedBudgetPolicy,
} from "./budget-policy";
import type { DistributedBudgetPolicyV1 } from "../types";
import {
  allowsDistributedPeerPromotion,
  EMPTY_DISTRIBUTED_HISTORY,
  sameDistributedPeerBinding,
  validDistributedPeerBinding,
  validDistributedReplay,
  validateDistributedTurnCheckpoint,
} from "./turn-state";
import type {
  AdmitResult,
  ClaimResult,
  CoordinationOutcomeUnknownReason,
  CoordinationRequestState,
  DistributedAdmissionConfig,
  DistributedAdmissionReservation,
  DistributedCapacityClassPolicy,
  DistributedBudgetReservationRequest,
  DistributedBudgetReservationResult,
  DistributedCoordinationEvent,
  DistributedCostMarkerV1,
  DistributedCoordinatorConfig,
  DistributedCoordinatorHealth,
  DistributedEventPage,
  DistributedHistoryLoadResult,
  DistributedPeerBindingV1,
  DistributedPruneResult,
  DistributedReplayResult,
  DistributedRateReservationResult,
  DistributedRequestStatus,
  DistributedTurnCoordinator,
  DistributedTurnCheckpointV1,
  DistributedTurnLease,
  DistributedTurnRequest,
  DistributedTurnRequestIdentity,
  LeaseResult,
  RegistrationResult,
} from "./types";

type Row = Record<string, unknown>;
const MAX_CAPACITY = 1_000_000;
const MAX_LEASE_MS = 3_600_000;
const MAX_EVENT_PAGE = 500;
const MAX_PRUNE_BATCH = 1_000;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_RATE_POLICIES = 64;
const MAX_CAPACITY_CLASSES = 64;
const MAX_RATE_RESERVATIONS = 16;
const MAX_RATE_WINDOW_MS = 86_400_000;
const MAX_BUDGET_POLICIES = 16;
const MAX_COST_USD = MAX_DISTRIBUTED_BUDGET_COST_USD;
const GLOBAL_BUDGET_SUBJECT_HASH = "0".repeat(64);
const OUTCOME_UNKNOWN_REASONS = new Set<CoordinationOutcomeUnknownReason>([
  "coordinator-unavailable",
  "effect-outcome-unknown",
  "execution-failed-after-start",
  "lease-lost",
]);

interface SqlTransaction extends PostgresMigrationExecutor {
  begin<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
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

interface ResolvedAdmissionReservation extends DistributedAdmissionReservation {
  max: number;
  maxEvents: number;
  windowMs: number;
}

function normalizedAdmission(config: DistributedCoordinatorConfig): DistributedAdmissionConfig {
  return config.admission ?? { maxRateLimitEvents: 0, capacityClasses: [], rateLimits: [] };
}

function normalizedBudgets(config: DistributedCoordinatorConfig) {
  return normalizeDistributedBudgetConfig(
    config.budgets,
    config.retention.terminalRequestRetentionMs,
  );
}

function budgetDigest(domain: string, ...values: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256").update(domain).update("\0");
  for (const value of values) hasher.update(value).update("\0");
  return hasher.digest("hex");
}

function budgetTotals(config: ReturnType<typeof normalizedBudgets>) {
  return config.policies.reduce(
    (total, policy) => ({
      reservations: total.reservations + policy.maxReservations,
      anonymousEvents: total.anonymousEvents + policy.maxAnonymousEvents,
      peerDays: total.peerDays + policy.maxPeerDays,
      thresholdIntents: total.thresholdIntents + policy.maxThresholdIntents,
    }),
    { reservations: 0, anonymousEvents: 0, peerDays: 0, thresholdIntents: 0 },
  );
}

function canonicalAdmission(
  reservations: readonly DistributedAdmissionReservation[] | undefined,
): string {
  return [...(reservations ?? [])]
    .map((reservation) => `${reservation.policyId}\0${reservation.subjectHash}`)
    .sort()
    .join("\n");
}

function requestAdmissionHash(request: DistributedTurnRequestIdentity): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      request.capacity ? `${request.capacity.classId}\0${request.capacity.partitionHash}\n` : "\n",
    )
    .update(canonicalAdmission(request.admission))
    .digest("hex");
}

function admissionPolicyFingerprint(config: DistributedAdmissionConfig): string {
  const capacity = [...(config.capacityClasses ?? [])]
    .map(
      (policy) =>
        `${policy.id}\0${policy.maxRetainedRequests}\0${policy.maxRetainedRequestsPerPartition}`,
    )
    .sort()
    .join("\n");
  const rates = [...config.rateLimits]
    .map((policy) => `${policy.id}\0${policy.max}\0${policy.maxEvents}\0${policy.windowMs}`)
    .sort()
    .join("\n");
  return new Bun.CryptoHasher("sha256")
    .update("auggy-distributed-admission-policy-v1\0")
    .update(String(config.maxRateLimitEvents))
    .update("\0")
    .update(capacity)
    .update("\0")
    .update(rates)
    .digest("hex");
}

function resolveAdmissionReservations(
  config: DistributedAdmissionConfig,
  reservations: readonly DistributedAdmissionReservation[] | undefined,
): ResolvedAdmissionReservation[] | null {
  const policies = new Map(config.rateLimits.map((policy) => [policy.id, policy]));
  const seen = new Set<string>();
  const resolved: ResolvedAdmissionReservation[] = [];
  for (const reservation of reservations ?? []) {
    if (seen.has(reservation.policyId)) return null;
    seen.add(reservation.policyId);
    const policy = policies.get(reservation.policyId);
    if (!policy) return null;
    resolved.push({
      ...reservation,
      max: policy.max,
      maxEvents: policy.maxEvents,
      windowMs: policy.windowMs,
    });
  }
  return resolved;
}

export interface PostgresCoordinatorOptions extends DistributedCoordinatorConfig {
  /** Connection string for a dedicated coordination database/role. */
  url?: string;
  /** Injectable only for tests and hosts that own their Bun.SQL lifecycle. */
  sql?: SqlTransaction;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid coordinator database row: ${key}`);
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value))
  ) {
    throw new Error(`invalid coordinator database row: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid coordinator database row: ${key}`);
  return parsed;
}

function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : number(row, key);
}

function decimal(row: Row, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
  ) {
    throw new Error(`invalid coordinator database row: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_COST_USD * MAX_CAPACITY) {
    throw new Error(`invalid coordinator database row: ${key}`);
  }
  return parsed;
}

function date(row: Row, key: string): number {
  const value = row[key];
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`invalid coordinator database row: ${key}`);
  return parsed;
}

function bool(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`invalid coordinator database row: ${key}`);
  return value;
}

function bytes(row: Row, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`invalid coordinator database row: ${key}`);
  return new Uint8Array(value);
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function peerBindingFromRow(row: Row): DistributedPeerBindingV1 {
  const trustLevel = text(row, "trust_level");
  if (trustLevel !== "creator" && trustLevel !== "agent" && trustLevel !== "public") {
    throw new Error("invalid coordinator history trust binding");
  }
  const publicSubstate = nullableText(row, "public_substate");
  if (
    publicSubstate !== null &&
    publicSubstate !== "anonymous" &&
    publicSubstate !== "recognized"
  ) {
    throw new Error("invalid coordinator history public binding");
  }
  const binding: DistributedPeerBindingV1 = {
    version: 1,
    bindingHash: text(row, "peer_binding_hash"),
    peerIdHash: nullableText(row, "peer_id_hash"),
    promotionScopeHash: text(row, "promotion_scope_hash"),
    trustLevel,
    ...(publicSubstate === null ? {} : { publicSubstate }),
  };
  if (!validDistributedPeerBinding(binding)) {
    throw new Error("invalid coordinator history peer binding");
  }
  return binding;
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

function validTerminalCostMarkers(
  markers: readonly DistributedCostMarkerV1[],
  maximum: number,
): boolean {
  if (!Array.isArray(markers) || markers.length > maximum) return false;
  const operations = new Set<string>();
  return markers.every((marker) => {
    if (
      marker.version !== 1 ||
      !/^auggy-op-v1-[0-9a-f]{64}$/.test(marker.operationId) ||
      operations.has(marker.operationId)
    ) {
      return false;
    }
    operations.add(marker.operationId);
    return marker.priced
      ? isCanonicalDistributedBudgetCostUsd(marker.costUsd)
      : marker.reason === "missing-pricing" || marker.reason === "missing-usage";
  });
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
  namespace: string,
  lease: DistributedTurnLease,
): readonly DistributedCostMarkerV1[] {
  return [
    {
      version: 1,
      operationId: `auggy-op-v1-${budgetDigest(
        "auggy-distributed-budget-unknown-cost-v1",
        namespace,
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
  namespace: string,
  lease: DistributedTurnLease,
  markers: readonly DistributedCostMarkerV1[],
  duplicateOperationIds: ReadonlySet<string> = new Set(),
): readonly DistributedCostMarkerV1[] {
  if (duplicateOperationIds.size > 0) {
    return collisionAccountingMarkers(markers, duplicateOperationIds);
  }
  return markers.length > 0 ? markers : missingUsageAccountingMarkers(namespace, lease);
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

function isTerminal(
  state: string,
): state is Exclude<CoordinationRequestState, "queued" | "active"> {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "outcome_unknown"
  );
}

function assertIdentifier(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`);
}

function assertRequest(request: DistributedTurnRequest): void {
  assertIdentifier("requestId", request.requestId);
  assertIdentifier("threadId", request.threadId);
  assertIdentifier("source.id", request.source.id);
  if (
    !Number.isSafeInteger(request.source.maxConcurrent) ||
    request.source.maxConcurrent < 1 ||
    request.source.maxConcurrent > MAX_CAPACITY
  )
    throw new Error("source.maxConcurrent is invalid");
  if (
    !Number.isSafeInteger(request.source.maxQueued) ||
    request.source.maxQueued < 0 ||
    request.source.maxQueued > MAX_CAPACITY
  )
    throw new Error("source.maxQueued is invalid");
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(request.bindingHash))
    throw new Error("bindingHash must be a one-way canonical request hash");
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

/**
 * PostgreSQL-backed coordinator. All decisions use clock_timestamp() inside a
 * locked transaction; process clocks, advisory locks, and client IPs are not
 * authority. The constructor does not perform DDL: provision explicitly with
 * migrate().
 */
export class PostgresDistributedTurnCoordinator implements DistributedTurnCoordinator {
  readonly #config: DistributedCoordinatorConfig;
  readonly #sql: SqlTransaction;
  readonly #ownsSql: boolean;
  readonly #sessionId: string;
  readonly #owned = new Map<string, LocalOwnedOperation>();
  #invalidated = false;

  constructor(options: PostgresCoordinatorOptions) {
    if (!options.sql && !options.url) throw new Error("Postgres coordination requires url or sql");
    if (
      !Number.isSafeInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > MAX_CAPACITY
    )
      throw new Error("maxConcurrent must be positive");
    if (
      !Number.isSafeInteger(options.maxQueued) ||
      options.maxQueued < 0 ||
      options.maxQueued > MAX_CAPACITY
    )
      throw new Error("maxQueued must not be negative");
    if (
      !Number.isSafeInteger(options.maxQueuedPerThread) ||
      options.maxQueuedPerThread < 0 ||
      options.maxQueuedPerThread > options.maxQueued
    )
      throw new Error("maxQueuedPerThread must be between zero and maxQueued");
    if (
      !Number.isSafeInteger(options.leaseMs) ||
      options.leaseMs < 1 ||
      options.leaseMs > MAX_LEASE_MS
    )
      throw new Error("leaseMs must be positive");
    if (
      !Number.isSafeInteger(options.retention?.terminalRequestRetentionMs) ||
      options.retention.terminalRequestRetentionMs < 60_000 ||
      options.retention.terminalRequestRetentionMs > 31_536_000_000 ||
      !Number.isSafeInteger(options.retention.maxTerminalRequests) ||
      options.retention.maxTerminalRequests < 1 ||
      options.retention.maxTerminalRequests > MAX_CAPACITY ||
      !Number.isSafeInteger(options.retention.eventRetentionMs) ||
      options.retention.eventRetentionMs < 60_000 ||
      options.retention.eventRetentionMs > 31_536_000_000 ||
      !Number.isSafeInteger(options.retention.maxEvents) ||
      options.retention.maxEvents < 1 ||
      options.retention.maxEvents > MAX_CAPACITY
    ) {
      throw new Error("coordination retention policy is invalid");
    }
    if (
      !Number.isSafeInteger(options.result?.maxReplayBytes) ||
      options.result.maxReplayBytes < 1_024 ||
      options.result.maxReplayBytes > 1_048_576
    ) {
      throw new Error("coordination replay policy is invalid");
    }
    if (
      !Number.isSafeInteger(options.turnState?.history.maxSnapshotBytes) ||
      options.turnState.history.maxSnapshotBytes < 1_024 ||
      options.turnState.history.maxSnapshotBytes > 1_048_576 ||
      !Number.isSafeInteger(options.turnState.history.maxMessages) ||
      options.turnState.history.maxMessages < 1 ||
      options.turnState.history.maxMessages > 10_000 ||
      !Number.isSafeInteger(options.turnState.history.maxThreads) ||
      options.turnState.history.maxThreads < 1 ||
      options.turnState.history.maxThreads > MAX_CAPACITY ||
      !Number.isSafeInteger(options.turnState.maxCostMarkersPerTurn) ||
      options.turnState.maxCostMarkersPerTurn < 1 ||
      options.turnState.maxCostMarkersPerTurn > 1_000 ||
      !Number.isSafeInteger(options.turnState.outbox.maxIntentsPerTurn) ||
      options.turnState.outbox.maxIntentsPerTurn < 0 ||
      options.turnState.outbox.maxIntentsPerTurn > 1_000 ||
      !Number.isSafeInteger(options.turnState.outbox.maxIntentBytes) ||
      options.turnState.outbox.maxIntentBytes < 1_024 ||
      options.turnState.outbox.maxIntentBytes > 1_048_576 ||
      !Number.isSafeInteger(options.turnState.outbox.maxPendingIntents) ||
      options.turnState.outbox.maxPendingIntents < 0 ||
      options.turnState.outbox.maxPendingIntents > MAX_CAPACITY
    ) {
      throw new Error("coordination turn-state policy is invalid");
    }
    const admission = normalizedAdmission(options);
    if (
      !Number.isSafeInteger(admission.maxRateLimitEvents) ||
      admission.maxRateLimitEvents < 0 ||
      admission.maxRateLimitEvents > MAX_CAPACITY ||
      !Array.isArray(admission.rateLimits) ||
      admission.rateLimits.length > MAX_RATE_POLICIES
    ) {
      throw new Error("coordination admission policy is invalid");
    }
    const ratePolicyIds = new Set<string>();
    for (const policy of admission.rateLimits) {
      assertIdentifier("admission.rateLimits.id", policy.id);
      if (
        !Number.isSafeInteger(policy.max) ||
        policy.max < 1 ||
        policy.max > MAX_CAPACITY ||
        !Number.isSafeInteger(policy.maxEvents) ||
        policy.maxEvents < 1 ||
        policy.maxEvents > MAX_CAPACITY ||
        !Number.isSafeInteger(policy.windowMs) ||
        policy.windowMs < 1_000 ||
        policy.windowMs > MAX_RATE_WINDOW_MS ||
        ratePolicyIds.has(policy.id)
      ) {
        throw new Error("coordination admission rate policy is invalid");
      }
      ratePolicyIds.add(policy.id);
    }
    if (
      admission.rateLimits.reduce((sum, policy) => sum + policy.maxEvents, 0) >
      admission.maxRateLimitEvents
    ) {
      throw new Error("coordination admission policy partitions exceed bounded event capacity");
    }
    const capacityClasses = admission.capacityClasses ?? [];
    if (!Array.isArray(capacityClasses) || capacityClasses.length > MAX_CAPACITY_CLASSES) {
      throw new Error("coordination admission capacity policy is invalid");
    }
    const capacityClassIds = new Set<string>();
    let reservedRequestCapacity = 0;
    for (const policy of capacityClasses) {
      assertIdentifier("admission.capacityClasses.id", policy.id);
      if (
        !Number.isSafeInteger(policy.maxRetainedRequests) ||
        policy.maxRetainedRequests < 1 ||
        policy.maxRetainedRequests > MAX_CAPACITY ||
        !Number.isSafeInteger(policy.maxRetainedRequestsPerPartition) ||
        policy.maxRetainedRequestsPerPartition < 1 ||
        policy.maxRetainedRequestsPerPartition > policy.maxRetainedRequests ||
        capacityClassIds.has(policy.id)
      ) {
        throw new Error("coordination admission capacity policy is invalid");
      }
      capacityClassIds.add(policy.id);
      reservedRequestCapacity += policy.maxRetainedRequests;
    }
    if (reservedRequestCapacity > options.retention.maxTerminalRequests) {
      throw new Error("coordination admission capacity exceeds retained-request capacity");
    }
    const budgets = normalizedBudgets(options);
    if (budgets.policies.length > MAX_BUDGET_POLICIES) {
      throw new Error("coordination budget policies exceed supported bounds");
    }
    const minimumReservations =
      options.retention.maxTerminalRequests + options.maxConcurrent + options.maxQueued;
    if (budgets.policies.some((policy) => policy.maxReservations < minimumReservations)) {
      throw new Error("coordination budget reservation capacity cannot retain request evidence");
    }
    const totalBudgetCapacity = budgetTotals(budgets);
    if (Object.values(totalBudgetCapacity).some((value) => value > MAX_CAPACITY)) {
      throw new Error("coordination budget capacity exceeds namespace bounds");
    }
    if (
      !Number.isSafeInteger(options.compatibility?.protocolVersion) ||
      options.compatibility.protocolVersion < 1 ||
      options.compatibility.protocolVersion > MAX_CAPACITY ||
      !/^[0-9a-f]{64}$/.test(options.compatibility.protocolFingerprint) ||
      !/^[0-9a-f]{64}$/.test(options.compatibility.configurationFingerprint)
    ) {
      throw new Error("coordinator compatibility contract is invalid");
    }
    if (
      options.compatibility.upgradeFrom &&
      (!Number.isSafeInteger(options.compatibility.upgradeFrom.protocolVersion) ||
        options.compatibility.upgradeFrom.protocolVersion + 1 !==
          options.compatibility.protocolVersion ||
        !/^[0-9a-f]{64}$/.test(options.compatibility.upgradeFrom.protocolFingerprint) ||
        !/^[0-9a-f]{64}$/.test(options.compatibility.upgradeFrom.configurationFingerprint))
    ) {
      throw new Error("coordinator compatibility upgrade contract is invalid");
    }
    assertIdentifier("namespace", options.namespace);
    assertIdentifier("instanceId", options.instanceId);
    if (!/^[0-9a-f]{64}$/.test(options.buildFingerprint)) {
      throw new Error("buildFingerprint must be a secret-free SHA-256 digest");
    }
    if (!Array.isArray(options.sources) || options.sources.length > 256) {
      throw new Error("coordinator sources exceed supported bounds");
    }
    const sourceIds = new Set<string>();
    for (const source of options.sources) {
      assertIdentifier("source.id", source.id);
      if (
        !Number.isSafeInteger(source.maxConcurrent) ||
        source.maxConcurrent < 1 ||
        source.maxConcurrent > MAX_CAPACITY ||
        !Number.isSafeInteger(source.maxQueued) ||
        source.maxQueued < 0 ||
        source.maxQueued > MAX_CAPACITY
      ) {
        throw new Error("coordinator source policy is invalid");
      }
      if (sourceIds.has(source.id)) throw new Error("coordinator source ids must be unique");
      sourceIds.add(source.id);
    }
    this.#config = {
      ...options,
      sources: options.sources.map((source) => ({ ...source })),
      turnState: {
        history: { ...options.turnState.history },
        maxCostMarkersPerTurn: options.turnState.maxCostMarkersPerTurn,
        outbox: { ...options.turnState.outbox },
      },
      ...(options.admission
        ? {
            admission: {
              maxRateLimitEvents: options.admission.maxRateLimitEvents,
              capacityClasses: (options.admission.capacityClasses ?? []).map((policy) => ({
                ...policy,
              })),
              rateLimits: options.admission.rateLimits.map((policy) => ({ ...policy })),
            },
          }
        : {}),
      ...(options.budgets === undefined
        ? {}
        : {
            budgets: {
              policies: budgets.policies.map((policy) => ({
                ...policy,
                ...(policy.caps
                  ? {
                      caps: {
                        ...(policy.caps.agent ? { agent: { ...policy.caps.agent } } : {}),
                        ...(policy.caps.public
                          ? {
                              public: {
                                ...(policy.caps.public.anonymous
                                  ? { anonymous: { ...policy.caps.public.anonymous } }
                                  : {}),
                                ...(policy.caps.public.recognized
                                  ? { recognized: { ...policy.caps.public.recognized } }
                                  : {}),
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
                ...(policy.notifications
                  ? {
                      notifications: {
                        destination: policy.notifications.destination,
                        thresholds: [...policy.notifications.thresholds],
                      },
                    }
                  : {}),
              })),
            },
          }),
    };
    this.#sessionId = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
    this.#ownsSql = !options.sql;
    this.#sql = (options.sql ??
      createSecurePostgresCoordinationClient(options.url!)) as unknown as SqlTransaction;
  }

  async migrate(): Promise<void> {
    await migratePostgresCoordinator(this.#sql);
  }

  async close(): Promise<void> {
    this.abortAllOwned("coordinator-closed");
    if (this.#ownsSql) await (this.#sql as unknown as { close: () => Promise<void> }).close();
  }

  supportsAdmissionPolicy(
    requirements: Parameters<DistributedTurnCoordinator["supportsAdmissionPolicy"]>[0],
  ): boolean {
    try {
      const admission = normalizedAdmission(this.#config);
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
  }

  supportsBudgetPolicy(policy: DistributedBudgetPolicyV1): boolean {
    try {
      const normalized = normalizeDistributedBudgetConfig(
        { policies: [policy] },
        this.#config.retention.terminalRequestRetentionMs,
      ).policies[0];
      const stored = normalizedBudgets(this.#config).policies.find(
        (candidate) => candidate.id === normalized?.id,
      );
      return normalized !== undefined && stored !== undefined
        ? sameDistributedBudgetPolicy(stored, normalized)
        : false;
    } catch {
      return false;
    }
  }

  async register(): Promise<RegistrationResult> {
    return this.safe<RegistrationResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx, true, true);
        await this.provisionRequestCapacityCounters(tx);
        await this.verifyRequestCapacityCounters(tx);
        await this.provisionRateCounters(tx);
        await this.verifyRateEvidenceCounter(tx);
        await this.verifyBudgetEvidence(tx);
        const inserted = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_instances (namespace, instance_id, session_id, build_fingerprint, accepting, draining, lease_expires_at) VALUES ($1, $2, $3, $4, TRUE, FALSE, clock_timestamp() + ($5 * interval '1 millisecond')) ON CONFLICT (namespace, instance_id) DO NOTHING RETURNING session_id",
          [
            this.#config.namespace,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.buildFingerprint,
            this.#config.leaseMs,
          ],
        );
        if (!inserted[0]) {
          const existing = await tx.unsafe<Row>(
            "SELECT session_id, build_fingerprint, lease_expires_at > clock_timestamp() AS live FROM public.auggy_coordination_instances WHERE namespace = $1 AND instance_id = $2 FOR UPDATE",
            [this.#config.namespace, this.#config.instanceId],
          );
          const row = existing[0];
          if (
            !row ||
            text(row, "session_id") !== this.#sessionId ||
            text(row, "build_fingerprint") !== this.#config.buildFingerprint ||
            !bool(row, "live")
          ) {
            return { status: "conflict" };
          }
          await tx.unsafe(
            "UPDATE public.auggy_coordination_instances SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $4",
            [
              this.#config.namespace,
              this.#config.instanceId,
              this.#config.leaseMs,
              this.#sessionId,
            ],
          );
        }
        await this.provisionSources(tx);
        return { status: "registered" };
      }),
    );
  }

  async heartbeatInstance(): Promise<LeaseResult> {
    return this.safe<LeaseResult>(
      { status: "unavailable" },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          const instance = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_instances SET lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND build_fingerprint = $5 AND lease_expires_at > clock_timestamp() RETURNING instance_id",
            [
              this.#config.namespace,
              this.#config.instanceId,
              this.#sessionId,
              this.#config.leaseMs,
              this.#config.buildFingerprint,
            ],
          );
          if (!instance[0]) return { status: "stale" };
          return { status: "ok" };
        }),
      (result) => {
        if (result.status !== "ok") this.abortAllOwned("coordinator-authority-lost");
      },
    );
  }

  async admit(request: DistributedTurnRequest): Promise<AdmitResult> {
    const result = await this.safe<AdmitResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const resolvedAdmission = resolveAdmissionReservations(
          normalizedAdmission(this.#config),
          request.admission,
        );
        if (!resolvedAdmission) return { status: "rejected", reason: "invalid-admission" };
        const capacityPolicies = normalizedAdmission(this.#config).capacityClasses ?? [];
        const capacityPolicy = request.capacity
          ? capacityPolicies.find((policy) => policy.id === request.capacity!.classId)
          : undefined;
        if (
          (capacityPolicies.length === 0 && request.capacity !== undefined) ||
          (capacityPolicies.length > 0 && capacityPolicy === undefined)
        ) {
          return { status: "rejected", reason: "invalid-admission" };
        }
        const identityAdmissionHash = requestAdmissionHash(request);
        const limits = await this.#lockNamespace(tx);
        const instance = await this.registeredInstance(tx);
        if (!instance) throw new Error("coordinator instance is not registered");
        await this.#expireActive(tx);
        const existing = await tx.unsafe<Row>(
          "SELECT thread_id, source_id, binding_hash, admission_hash, state, queue_generation, queue_expires_at <= clock_timestamp() AS queue_expired FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        if (existing[0]) {
          const row = existing[0];
          if (
            text(row, "thread_id") !== request.threadId ||
            text(row, "source_id") !== request.source.id ||
            text(row, "binding_hash") !== request.bindingHash ||
            text(row, "admission_hash") !== identityAdmissionHash
          ) {
            return { status: "conflict" };
          }
          if (text(row, "state") === "queued" && row.queue_expired === true) {
            if (!instance.accepting || instance.draining) {
              return { status: "rejected", reason: "draining" };
            }
            const adopted = await tx.unsafe<Row>(
              "UPDATE public.auggy_coordination_requests SET queue_owner_instance = $3, queue_owner_session = $4, queue_generation = queue_generation + 1, queue_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND state = 'queued' AND queue_expires_at <= clock_timestamp() RETURNING request_id",
              [
                this.#config.namespace,
                request.requestId,
                this.#config.instanceId,
                this.#sessionId,
                this.#config.leaseMs,
              ],
            );
            if (!adopted[0]) return { status: "joined", state: "queued" };
            return { status: "adopted", attempt: number(row, "queue_generation") + 1 };
          }
          return {
            status: "joined",
            state: text(row, "state") as CoordinationRequestState,
          };
        }
        if (!instance.accepting || instance.draining) {
          return { status: "rejected", reason: "draining" };
        }
        await this.#cancelExpiredQueued(tx);
        const incidents = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS count FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'outcome_unknown'",
          [this.#config.namespace],
        );
        if (number(incidents[0]!, "count") >= this.#config.retention.maxTerminalRequests) {
          return { status: "rejected", reason: "incident-capacity" };
        }
        const policy = await this.sourcePolicy(tx, request.source);
        const threadState = await tx.unsafe<Row>(
          "SELECT quarantined FROM public.auggy_coordination_threads WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, request.threadId],
        );
        if (threadState[0] && bool(threadState[0], "quarantined")) {
          return { status: "rejected", reason: "thread-quarantined" };
        }
        const queue = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS total, count(*) FILTER (WHERE source_id = $2)::integer AS source_total, count(*) FILTER (WHERE thread_id = $3)::integer AS thread_total FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'queued'",
          [this.#config.namespace, request.source.id, request.threadId],
        );
        const count = queue[0];
        if (!count) throw new Error("missing queue count");
        const active = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS total, count(*) FILTER (WHERE source_id = $2)::integer AS source_total, bool_or(thread_id = $3) AS thread_busy FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'active'",
          [this.#config.namespace, policy.id, request.threadId],
        );
        const activeCount = active[0];
        if (!activeCount) throw new Error("missing active count");
        const globalDirectSlot =
          number(count, "total") === 0 &&
          number(activeCount, "total") < limits.maxConcurrent &&
          activeCount.thread_busy !== true;
        const sourceDirectSlot =
          number(count, "source_total") === 0 &&
          number(activeCount, "source_total") < policy.maxConcurrent;
        if (number(count, "total") >= limits.maxQueued && !globalDirectSlot)
          return { status: "rejected", reason: "global-capacity" };
        if (number(count, "source_total") >= policy.maxQueued && !sourceDirectSlot)
          return { status: "rejected", reason: "source-capacity" };
        if (
          number(count, "thread_total") >= limits.maxQueuedPerThread &&
          !(number(count, "thread_total") === 0 && globalDirectSlot && sourceDirectSlot)
        ) {
          return { status: "rejected", reason: "thread-capacity" };
        }
        if (capacityPolicy && request.capacity) {
          if (
            !(await this.lockAvailableRequestCapacity(
              tx,
              capacityPolicy,
              request.capacity.partitionHash,
            ))
          ) {
            return { status: "rejected", reason: "request-capacity" };
          }
        }
        if (resolvedAdmission.length > 0) {
          await this.lockRatePolicies(
            tx,
            resolvedAdmission.map((reservation) => reservation.policyId),
          );
          await this.cleanupExpiredRateEvents(
            tx,
            resolvedAdmission.map((reservation) => reservation.policyId),
          );
          let retryAfterMs = 0;
          for (const reservation of resolvedAdmission) {
            const usage = await tx.unsafe<Row>(
              "SELECT count(*)::integer AS count, CASE WHEN count(*) = 0 THEN 0 ELSE GREATEST(1, ceil(extract(epoch FROM (min(expires_at) - clock_timestamp())) * 1000)::bigint) END AS retry_after_ms FROM public.auggy_coordination_rate_events WHERE namespace = $1 AND policy_id = $2 AND subject_hash = $3 AND expires_at > clock_timestamp()",
              [this.#config.namespace, reservation.policyId, reservation.subjectHash],
            );
            if (number(usage[0]!, "count") >= reservation.max) {
              retryAfterMs = Math.max(retryAfterMs, number(usage[0]!, "retry_after_ms"));
            }
          }
          if (retryAfterMs > 0) {
            return { status: "rejected", reason: "rate-limited", retryAfterMs };
          }
          if (!(await this.reserveRateEventSlots(tx, resolvedAdmission))) {
            return { status: "rejected", reason: "admission-capacity" };
          }
        }
        if (capacityPolicy && request.capacity) {
          await this.reserveRequestCapacitySlot(tx, capacityPolicy, request.capacity.partitionHash);
        }
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_requests (namespace, request_id, thread_id, source_id, binding_hash, admission_hash, capacity_class, capacity_partition_hash, state, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at) VALUES ($1, $2, $3, $4, $5, $9, $10, $11, 'queued', $6, $7, 1, clock_timestamp() + ($8 * interval '1 millisecond'))",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            policy.id,
            request.bindingHash,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.leaseMs,
            identityAdmissionHash,
            request.capacity?.classId ?? null,
            request.capacity?.partitionHash ?? null,
          ],
        );
        for (const reservation of resolvedAdmission) {
          await tx.unsafe(
            "INSERT INTO public.auggy_coordination_rate_events (namespace, policy_id, subject_hash, request_id, expires_at) VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * interval '1 millisecond'))",
            [
              this.#config.namespace,
              reservation.policyId,
              reservation.subjectHash,
              request.requestId,
              reservation.windowMs,
            ],
          );
        }
        return { status: "admitted", attempt: 1 };
      }),
    );
    if (result.status === "admitted" || result.status === "adopted") {
      this.trackOwned(request, "queued", result.attempt);
    }
    return result;
  }

  async reserveRateLimits(
    request: Parameters<DistributedTurnCoordinator["reserveRateLimits"]>[0],
  ): Promise<DistributedRateReservationResult> {
    return this.safe<DistributedRateReservationResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
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
        const resolved = resolveAdmissionReservations(
          normalizedAdmission(this.#config),
          request.admission,
        );
        if (!resolved) return { status: "rejected", reason: "invalid-admission" };
        const instance = await this.registeredInstance(tx, false);
        if (!instance?.accepting || instance.draining) {
          return { status: "rejected", reason: "draining" };
        }
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${this.#config.namespace}\n${request.reservationId}`,
        ]);
        const existing = await tx.unsafe<Row>(
          "SELECT policy_id, subject_hash, expires_at > clock_timestamp() AS live FROM public.auggy_coordination_rate_events WHERE namespace = $1 AND request_id = $2 ORDER BY policy_id, subject_hash FOR UPDATE",
          [this.#config.namespace, request.reservationId],
        );
        const live = existing.filter((row) => row.live === true);
        if (live.length > 0) {
          const storedCanonical = live
            .map((row) => `${text(row, "policy_id")}\0${text(row, "subject_hash")}`)
            .join("\n");
          return storedCanonical === canonicalAdmission(request.admission)
            ? { status: "replayed" }
            : { status: "conflict" };
        }
        const policyIds = [
          ...new Set([...existing.map((row) => text(row, "policy_id")), resolved[0]!.policyId]),
        ];
        await this.lockRatePolicies(tx, policyIds);
        if (existing.length > 0) {
          const deleted = await tx.unsafe<Row>(
            "WITH deleted AS (DELETE FROM public.auggy_coordination_rate_events WHERE namespace = $1 AND request_id = $2 AND expires_at <= clock_timestamp() RETURNING policy_id) SELECT policy_id, count(*)::integer AS count FROM deleted GROUP BY policy_id ORDER BY policy_id",
            [this.#config.namespace, request.reservationId],
          );
          await this.releaseRateEventSlots(
            tx,
            deleted.map((row) => ({
              policyId: text(row, "policy_id"),
              count: number(row, "count"),
            })),
          );
        }
        await this.cleanupExpiredRateEvents(
          tx,
          resolved.map((reservation) => reservation.policyId),
        );
        let retryAfterMs = 0;
        for (const reservation of resolved) {
          const usage = await tx.unsafe<Row>(
            "SELECT count(*)::integer AS count, CASE WHEN count(*) = 0 THEN 0 ELSE GREATEST(1, ceil(extract(epoch FROM (min(expires_at) - clock_timestamp())) * 1000)::bigint) END AS retry_after_ms FROM public.auggy_coordination_rate_events WHERE namespace = $1 AND policy_id = $2 AND subject_hash = $3 AND expires_at > clock_timestamp()",
            [this.#config.namespace, reservation.policyId, reservation.subjectHash],
          );
          if (number(usage[0]!, "count") >= reservation.max) {
            retryAfterMs = Math.max(retryAfterMs, number(usage[0]!, "retry_after_ms"));
          }
        }
        if (retryAfterMs > 0) {
          return { status: "rejected", reason: "rate-limited", retryAfterMs };
        }
        if (!(await this.reserveRateEventSlots(tx, resolved))) {
          return { status: "rejected", reason: "admission-capacity" };
        }
        for (const reservation of resolved) {
          await tx.unsafe(
            "INSERT INTO public.auggy_coordination_rate_events (namespace, policy_id, subject_hash, request_id, expires_at) VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * interval '1 millisecond'))",
            [
              this.#config.namespace,
              reservation.policyId,
              reservation.subjectHash,
              request.reservationId,
              reservation.windowMs,
            ],
          );
        }
        return { status: "reserved" };
      }),
    );
  }

  async heartbeatQueued(
    request: DistributedTurnRequestIdentity,
    attempt = 1,
  ): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET queue_expires_at = clock_timestamp() + ($9 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND admission_hash = $10 AND state = 'queued' AND queue_owner_instance = $6 AND queue_owner_session = $7 AND queue_generation = $8 AND queue_expires_at > clock_timestamp() RETURNING request_id",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            request.source.id,
            request.bindingHash,
            this.#config.instanceId,
            this.#sessionId,
            attempt,
            this.#config.leaseMs,
            requestAdmissionHash(request),
          ],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
    if (result.status !== "ok") {
      this.abortOwnedAttempt(request.requestId, attempt, "queue-ownership-lost");
    }
    return result;
  }

  async abandon(request: DistributedTurnRequestIdentity, attempt = 1): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>(
      { status: "unavailable" },
      async () =>
        this.transaction(async (tx) => {
          assertRequest(request);
          await this.#lockNamespace(tx);
          if (!(await this.registeredInstance(tx))) return { status: "stale" };
          const rows = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND admission_hash = $9 AND queue_generation = $8 AND ((state = 'queued' AND queue_owner_instance = $6 AND queue_owner_session = $7 AND queue_expires_at > clock_timestamp()) OR (state = 'active' AND owner_instance = $6 AND owner_session = $7 AND execution_started_at IS NULL AND lease_expires_at > clock_timestamp())) RETURNING request_id",
            [
              this.#config.namespace,
              request.requestId,
              request.threadId,
              request.source.id,
              request.bindingHash,
              this.#config.instanceId,
              this.#sessionId,
              attempt,
              requestAdmissionHash(request),
            ],
          );
          if (rows[0]) {
            await this.releaseBudgetReservationsForRequest(tx, request.requestId, attempt);
          }
          return rows[0] ? { status: "ok" } : { status: "stale" };
        }),
      undefined,
      true,
    );
    if (result.status === "ok") {
      this.abortOwnedAttempt(request.requestId, attempt, "pre-start-abandoned");
    }
    return result;
  }

  async claim(request: DistributedTurnRequest, attempt = 1): Promise<ClaimResult> {
    const result = await this.safe<ClaimResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const limits = await this.#lockNamespace(tx);
        const instance = await this.registeredInstance(tx);
        if (!instance) throw new Error("coordinator instance is not registered");
        await this.#expireActive(tx);
        const found = await tx.unsafe<Row>(
          "SELECT state, thread_id, source_id, binding_hash, admission_hash, fence, owner_instance, owner_session, lease_expires_at, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at <= clock_timestamp() AS queue_expired FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        const row = found[0];
        if (
          !row ||
          text(row, "thread_id") !== request.threadId ||
          text(row, "source_id") !== request.source.id ||
          text(row, "binding_hash") !== request.bindingHash ||
          text(row, "admission_hash") !== requestAdmissionHash(request)
        )
          return { status: "conflict" };
        const state = text(row, "state");
        if (state === "outcome_unknown") return { status: "quarantined" };
        if (isTerminal(state)) return { status: "terminal", state };
        if (state === "active") return { status: "waiting" };
        const sameQueueOwner =
          row.queue_owner_instance === this.#config.instanceId &&
          row.queue_owner_session === this.#sessionId;
        if (
          !Number.isSafeInteger(attempt) ||
          attempt <= 0 ||
          number(row, "queue_generation") !== attempt
        ) {
          return { status: "stale" };
        }
        if (!sameQueueOwner)
          return row.queue_expired === true ? { status: "stale" } : { status: "waiting" };
        if (row.queue_expired === true) return { status: "stale" };
        if (!instance.accepting || instance.draining) return { status: "waiting" };
        await this.#cancelExpiredQueued(tx, request.requestId);
        const policy = await this.sourcePolicy(tx, request.source);
        const thread = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_threads (namespace, thread_id) VALUES ($1, $2) ON CONFLICT (namespace, thread_id) DO UPDATE SET updated_at = clock_timestamp() RETURNING quarantined",
          [this.#config.namespace, request.threadId],
        );
        if (!thread[0]) throw new Error("missing thread row");
        if (bool(thread[0], "quarantined")) return { status: "quarantined" };
        const capacity = await tx.unsafe<Row>(
          "SELECT count(*) FILTER (WHERE state = 'active')::integer AS active, count(*) FILTER (WHERE state = 'active' AND source_id = $2)::integer AS source_active FROM public.auggy_coordination_requests WHERE namespace = $1",
          [this.#config.namespace, policy.id],
        );
        const current = capacity[0];
        const fairHead = await tx.unsafe<Row>(
          "WITH thread_heads AS (SELECT DISTINCT ON (thread_id) request_id, thread_id, source_id, queued_at FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'queued' ORDER BY thread_id, queued_at, request_id), eligible AS (SELECT heads.request_id, heads.queued_at FROM thread_heads heads JOIN public.auggy_coordination_sources source_policy ON source_policy.namespace = $1 AND source_policy.source_id = heads.source_id WHERE NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests active_thread WHERE active_thread.namespace = $1 AND active_thread.thread_id = heads.thread_id AND active_thread.state = 'active') AND (SELECT count(*) FROM public.auggy_coordination_requests active_source WHERE active_source.namespace = $1 AND active_source.source_id = heads.source_id AND active_source.state = 'active') < source_policy.max_concurrent) SELECT request_id FROM eligible ORDER BY queued_at, request_id LIMIT 1",
          [this.#config.namespace],
        );
        if (!fairHead[0] || text(fairHead[0], "request_id") !== request.requestId)
          return { status: "waiting" };
        if (
          !current ||
          number(current, "active") >= limits.maxConcurrent ||
          number(current, "source_active") >= policy.maxConcurrent
        )
          return { status: "waiting" };
        const fenced = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_namespaces SET next_fence = next_fence + 1, updated_at = clock_timestamp() WHERE namespace = $1 RETURNING next_fence",
          [this.#config.namespace],
        );
        const fence = number(fenced[0]!, "next_fence");
        await tx.unsafe(
          "UPDATE public.auggy_coordination_threads SET next_fence = $3, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, request.threadId, fence],
        );
        const claimed = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'active', fence = $3, owner_instance = $4, owner_session = $5, lease_expires_at = clock_timestamp() + ($6 * interval '1 millisecond'), execution_started_at = NULL, queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND state = 'queued' AND queue_generation = $7 AND queue_owner_instance = $4 AND queue_owner_session = $5 RETURNING lease_expires_at, queue_generation",
          [
            this.#config.namespace,
            request.requestId,
            fence,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.leaseMs,
            attempt,
          ],
        );
        if (!claimed[0]) return { status: "waiting" };
        return {
          status: "acquired",
          lease: this.lease(
            request,
            number(claimed[0]!, "queue_generation"),
            fence,
            date(claimed[0]!, "lease_expires_at"),
          ),
        };
      }),
    );
    if (result.status === "acquired") this.trackOwned(request, "active", result.lease.attempt);
    return result;
  }

  ownedSignal(request: DistributedTurnRequestIdentity): AbortSignal {
    if (this.#invalidated) return this.unavailableSignal();
    try {
      assertRequest(request);
    } catch {
      return this.unavailableSignal();
    }
    const operation = this.#owned.get(request.requestId);
    return operation &&
      operation.bindingHash === request.bindingHash &&
      operation.admissionHash === requestAdmissionHash(request) &&
      operation.threadId === request.threadId &&
      operation.sourceId === request.source.id
      ? operation.controller.signal
      : this.unavailableSignal();
  }

  invalidateLocalAuthority(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    this.abortAllOwned("coordinator-authority-lost");
  }

  async markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult> {
    const result = await this.updateLease(
      lease,
      "execution_started_at = clock_timestamp(), updated_at = clock_timestamp()",
      [],
    );
    if (result.status !== "ok") this.abortOwned(lease.requestId, "lease-ownership-lost");
    return result;
  }

  async reserveBudget(
    lease: DistributedTurnLease,
    request: DistributedBudgetReservationRequest,
  ): Promise<DistributedBudgetReservationResult> {
    assertIdentifier("budget.policyId", request.policyId);
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
      return { status: "unavailable" };
    }
    const policy = normalizedBudgets(this.#config).policies.find(
      (candidate) => candidate.id === request.policyId,
    );
    if (!policy) return { status: "unavailable" };
    const peerIdHash = budgetDigest(
      "auggy-distributed-budget-peer-v1",
      this.#config.namespace,
      request.peerId,
    );
    const threadIdHash = budgetDigest(
      "auggy-distributed-budget-thread-v1",
      this.#config.namespace,
      request.threadId,
    );

    return this.safe<DistributedBudgetReservationResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const requests = await tx.unsafe<Row>(
          "SELECT binding_hash FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NULL FOR UPDATE",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        const owner = requests[0];
        if (!owner) return { status: "stale" };
        const bindingHash = text(owner, "binding_hash");
        const existing = await tx.unsafe<Row>(
          "SELECT request_binding_hash, peer_id_hash, thread_id_hash, trust_level, public_substate, attempt, fence, admission_day::text AS admission_day FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND policy_id = $2 AND request_id = $3 FOR UPDATE",
          [this.#config.namespace, policy.id, lease.requestId],
        );
        const current = existing[0];
        if (current) {
          const matches =
            text(current, "request_binding_hash") === bindingHash &&
            text(current, "peer_id_hash") === peerIdHash &&
            text(current, "thread_id_hash") === threadIdHash &&
            text(current, "trust_level") === request.trustLevel &&
            nullableText(current, "public_substate") === (request.publicSubstate ?? null) &&
            number(current, "attempt") === lease.attempt &&
            number(current, "fence") === lease.fence;
          if (!matches) return { status: "conflict" };
          const usage = await this.budgetUsage(
            tx,
            policy.id,
            text(current, "admission_day"),
            peerIdHash,
            threadIdHash,
          );
          return { status: "replayed", ...usage };
        }

        await this.cleanupExpiredBudgetEvidence(tx, policy, MAX_CAPACITY);
        const dayRows = await tx.unsafe<Row>(
          "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS admission_day",
        );
        const admissionDay = text(dayRows[0]!, "admission_day");
        const counts = await tx.unsafe<Row>(
          "WITH prospective_days AS (SELECT DISTINCT admission_day FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND policy_id = $2 AND state = 'reserved' UNION SELECT $3::date), prospective_intents AS (SELECT count(*)::integer AS count FROM public.auggy_coordination_budget_threshold_intents intent WHERE intent.namespace = $1 AND intent.policy_id = $2 AND intent.admission_day IN (SELECT admission_day FROM prospective_days)) SELECT (SELECT count(*)::integer FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND policy_id = $2) AS reservations, (SELECT count(*)::integer FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 AND policy_id = $2) AS anonymous_events, (SELECT count(*)::integer FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND subject_kind = 'peer') AS peer_days, (SELECT count(*)::integer FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1 AND policy_id = $2) AS threshold_intents, (SELECT count(*)::integer FROM prospective_days) AS prospective_threshold_days, (SELECT count FROM prospective_intents) AS prospective_threshold_intents",
          [this.#config.namespace, policy.id, admissionDay],
        );
        const count = counts[0];
        if (
          !count ||
          number(count, "reservations") >= policy.maxReservations ||
          number(count, "threshold_intents") +
            (policy.notifications?.thresholds.length ?? 0) *
              number(count, "prospective_threshold_days") -
            number(count, "prospective_threshold_intents") >
            policy.maxThresholdIntents ||
          (request.publicSubstate === "anonymous" &&
            policy.anonymousGlobalLimit !== undefined &&
            number(count, "anonymous_events") >= policy.maxAnonymousEvents)
        ) {
          return { status: "rejected", reason: "budget-capacity" };
        }

        const caps = resolveDistributedBudgetCaps(
          policy,
          request.trustLevel,
          request.publicSubstate,
        );
        const usage = await this.budgetUsage(tx, policy.id, admissionDay, peerIdHash, threadIdHash);
        const costCaps = await tx.unsafe<Row>(
          "SELECT COALESCE((SELECT cost_usd >= $4::numeric FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'global' AND subject_hash = $6), FALSE) AS global_reached, COALESCE((SELECT cost_usd >= $5::numeric FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'peer' AND subject_hash = $7), FALSE) AS peer_reached",
          [
            this.#config.namespace,
            policy.id,
            admissionDay,
            policy.dailyBudgetUsd === undefined
              ? null
              : formatDistributedBudgetCostNanos(distributedBudgetCostNanos(policy.dailyBudgetUsd)),
            caps?.maxUsdPerDay === undefined
              ? null
              : formatDistributedBudgetCostNanos(distributedBudgetCostNanos(caps.maxUsdPerDay)),
            GLOBAL_BUDGET_SUBJECT_HASH,
            peerIdHash,
          ],
        );
        if (request.publicSubstate === "anonymous" && policy.anonymousGlobalLimit !== undefined) {
          const anonymous = await tx.unsafe<Row>(
            "SELECT count(*)::integer AS count FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 AND policy_id = $2 AND occurred_at > clock_timestamp() - interval '60 seconds'",
            [this.#config.namespace, policy.id],
          );
          if (number(anonymous[0]!, "count") >= policy.anonymousGlobalLimit) {
            return { status: "rejected", reason: "anonymous-rate-cap" };
          }
        }
        if (bool(costCaps[0]!, "global_reached")) {
          return { status: "rejected", reason: "daily-global-usd-cap" };
        }
        if (bool(costCaps[0]!, "peer_reached")) {
          return { status: "rejected", reason: "daily-peer-usd-cap" };
        }
        if (caps?.maxTurnsPerThread !== undefined && usage.threadTurns >= caps.maxTurnsPerThread) {
          return { status: "rejected", reason: "daily-thread-turn-cap" };
        }
        if (caps?.maxTurnsPerDay !== undefined && usage.peerTurns >= caps.maxTurnsPerDay) {
          return { status: "rejected", reason: "daily-turn-cap" };
        }
        const peerDayExists = await tx.unsafe<Row>(
          "SELECT subject_hash FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'peer' AND subject_hash = $4",
          [this.#config.namespace, policy.id, admissionDay, peerIdHash],
        );
        if (!peerDayExists[0] && number(count, "peer_days") >= policy.maxPeerDays) {
          return { status: "rejected", reason: "budget-capacity" };
        }

        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_budget_daily (namespace, policy_id, admission_day, subject_kind, subject_hash, turns_reserved) VALUES ($1, $2, $3::date, 'global', $4, 1) ON CONFLICT (namespace, policy_id, admission_day, subject_kind, subject_hash) DO UPDATE SET turns_reserved = auggy_coordination_budget_daily.turns_reserved + 1, updated_at = clock_timestamp()",
          [this.#config.namespace, policy.id, admissionDay, GLOBAL_BUDGET_SUBJECT_HASH],
        );
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_budget_daily (namespace, policy_id, admission_day, subject_kind, subject_hash, turns_reserved) VALUES ($1, $2, $3::date, 'peer', $4, 1) ON CONFLICT (namespace, policy_id, admission_day, subject_kind, subject_hash) DO UPDATE SET turns_reserved = auggy_coordination_budget_daily.turns_reserved + 1, updated_at = clock_timestamp()",
          [this.#config.namespace, policy.id, admissionDay, peerIdHash],
        );
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_budget_reservations (namespace, policy_id, request_id, request_binding_hash, peer_id_hash, thread_id_hash, trust_level, public_substate, attempt, fence, admission_day) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date)",
          [
            this.#config.namespace,
            policy.id,
            lease.requestId,
            bindingHash,
            peerIdHash,
            threadIdHash,
            request.trustLevel,
            request.publicSubstate ?? null,
            lease.attempt,
            lease.fence,
            admissionDay,
          ],
        );
        if (request.publicSubstate === "anonymous" && policy.anonymousGlobalLimit !== undefined) {
          await tx.unsafe(
            "INSERT INTO public.auggy_coordination_budget_anonymous_events (namespace, policy_id, request_id, subject_hash, expires_at) VALUES ($1, $2, $3, $4, clock_timestamp() + interval '60 seconds')",
            [this.#config.namespace, policy.id, lease.requestId, peerIdHash],
          );
        }
        return {
          status: "reserved",
          ...(await this.budgetUsage(tx, policy.id, admissionDay, peerIdHash, threadIdHash)),
        };
      }),
    );
  }

  async releaseBudget(lease: DistributedTurnLease, policyId: string): Promise<LeaseResult> {
    assertIdentifier("budget.policyId", policyId);
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        const requests = await tx.unsafe<Row>(
          "SELECT request_id FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NULL FOR UPDATE",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        if (!requests[0]) return { status: "stale" };
        const reservations = await tx.unsafe<Row>(
          "DELETE FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND policy_id = $2 AND request_id = $3 AND attempt = $4 AND fence = $5 AND state = 'reserved' RETURNING admission_day::text AS admission_day, peer_id_hash",
          [this.#config.namespace, policyId, lease.requestId, lease.attempt, lease.fence],
        );
        const reservation = reservations[0];
        if (!reservation) return { status: "ok" };
        await tx.unsafe(
          "DELETE FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 AND policy_id = $2 AND request_id = $3",
          [this.#config.namespace, policyId, lease.requestId],
        );
        await tx.unsafe(
          "UPDATE public.auggy_coordination_budget_daily SET turns_reserved = turns_reserved - 1, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND ((subject_kind = 'global' AND subject_hash = $4) OR (subject_kind = 'peer' AND subject_hash = $5)) AND turns_reserved > 0",
          [
            this.#config.namespace,
            policyId,
            text(reservation, "admission_day"),
            GLOBAL_BUDGET_SUBJECT_HASH,
            text(reservation, "peer_id_hash"),
          ],
        );
        await tx.unsafe(
          "DELETE FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND ((subject_kind = 'global' AND subject_hash = $4) OR (subject_kind = 'peer' AND subject_hash = $5)) AND turns_reserved = 0 AND cost_usd = 0 AND unpriced_turns = 0",
          [
            this.#config.namespace,
            policyId,
            text(reservation, "admission_day"),
            GLOBAL_BUDGET_SUBJECT_HASH,
            text(reservation, "peer_id_hash"),
          ],
        );
        return { status: "ok" };
      }),
    );
  }

  async heartbeat(lease: DistributedTurnLease): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET lease_expires_at = clock_timestamp() + ($1 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $2 AND request_id = $3 AND thread_id = $4 AND source_id = $5 AND state = 'active' AND queue_generation = $6 AND fence = $7 AND owner_instance = $8 AND owner_session = $9 AND lease_expires_at > clock_timestamp() RETURNING lease_expires_at",
          [
            this.#config.leaseMs,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        return rows[0]
          ? { status: "ok", lease: { ...lease, expiresAt: date(rows[0], "lease_expires_at") } }
          : { status: "stale" };
      }),
    );
    if (result.status !== "ok") this.abortOwned(lease.requestId, "lease-ownership-lost");
    return result;
  }

  async loadHistory(
    lease: DistributedTurnLease,
    peerBinding: DistributedPeerBindingV1,
  ): Promise<DistributedHistoryLoadResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    if (!validDistributedPeerBinding(peerBinding)) {
      return { status: "rejected", reason: "invalid-peer-binding" };
    }
    const result = await this.safe<DistributedHistoryLoadResult>(
      { status: "unavailable" },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          if (!(await this.registeredInstance(tx))) return { status: "stale" };
          await this.#expireActive(tx);
          const requests = await tx.unsafe<Row>(
            "SELECT history_binding_hash, history_revision FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NULL FOR UPDATE",
            [
              this.#config.namespace,
              lease.requestId,
              lease.threadId,
              lease.sourceId,
              lease.attempt,
              lease.fence,
              this.#config.instanceId,
              this.#sessionId,
            ],
          );
          const request = requests[0];
          if (!request) return { status: "stale" };

          const histories = await tx.unsafe<Row>(
            "SELECT peer_binding_hash, peer_id_hash, promotion_scope_hash, trust_level, public_substate, revision, snapshot_version, snapshot_body, message_count FROM public.auggy_coordination_history WHERE namespace = $1 AND thread_id = $2 FOR UPDATE",
            [this.#config.namespace, lease.threadId],
          );
          const history = histories[0];
          if (!history && request.history_binding_hash === null) {
            const counts = await tx.unsafe<Row>(
              "SELECT ((SELECT count(*) FROM public.auggy_coordination_history history WHERE history.namespace = $1) + (SELECT count(*) FROM public.auggy_coordination_requests reservation WHERE reservation.namespace = $1 AND reservation.request_id <> $2 AND reservation.state = 'active' AND reservation.history_binding_hash IS NOT NULL AND reservation.history_revision = 0 AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_history history WHERE history.namespace = reservation.namespace AND history.thread_id = reservation.thread_id)))::integer AS count",
              [this.#config.namespace, lease.requestId],
            );
            if (number(counts[0]!, "count") >= this.#config.turnState.history.maxThreads) {
              return { status: "rejected", reason: "history-capacity" };
            }
          }
          if (
            history &&
            !sameDistributedPeerBinding(peerBindingFromRow(history), peerBinding) &&
            !allowsDistributedPeerPromotion(peerBindingFromRow(history), peerBinding)
          ) {
            return { status: "denied" };
          }
          const revision = history ? number(history, "revision") : 0;
          if (
            request.history_binding_hash !== null &&
            (text(request, "history_binding_hash") !== peerBinding.bindingHash ||
              number(request, "history_revision") !== revision)
          ) {
            return { status: "denied" };
          }
          const claimed = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_requests SET history_binding_hash = $9, history_revision = $10, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NULL RETURNING request_id",
            [
              this.#config.namespace,
              lease.requestId,
              lease.threadId,
              lease.sourceId,
              lease.attempt,
              lease.fence,
              this.#config.instanceId,
              this.#sessionId,
              peerBinding.bindingHash,
              revision,
            ],
          );
          if (!claimed[0]) throw new Error("history claim lost during transaction");
          const body = history
            ? bytes(history, "snapshot_body")
            : new Uint8Array(EMPTY_DISTRIBUTED_HISTORY);
          const messageCount = history ? number(history, "message_count") : 0;
          if (
            (history && number(history, "snapshot_version") !== 1) ||
            body.byteLength > this.#config.turnState.history.maxSnapshotBytes ||
            messageCount > this.#config.turnState.history.maxMessages
          ) {
            throw new Error("stored history exceeds configured policy");
          }
          return { status: "ok", version: 1, body, messageCount, revision };
        }),
    );
    if (result.status === "stale" || result.status === "unavailable") {
      this.abortOwned(lease.requestId, "lease-ownership-lost");
    }
    return result;
  }

  async commitTurn(
    lease: DistributedTurnLease,
    checkpoint: DistributedTurnCheckpointV1,
  ): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    const rejection = validateDistributedTurnCheckpoint(
      checkpoint,
      this.#config.turnState,
      this.#config.result,
      lease.threadId,
    );
    if (rejection) return rejection;
    if (
      !validTerminalCostMarkers(
        checkpoint.costMarkers,
        this.#config.turnState.maxCostMarkersPerTurn,
      )
    ) {
      return { status: "rejected", reason: "invalid-turn-state" };
    }

    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const requests = await tx.unsafe<Row>(
          "SELECT history_binding_hash, history_revision FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NOT NULL FOR UPDATE",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        const request = requests[0];
        if (!request) return { status: "stale" };
        const histories = await tx.unsafe<Row>(
          "SELECT peer_binding_hash, peer_id_hash, promotion_scope_hash, trust_level, public_substate, revision FROM public.auggy_coordination_history WHERE namespace = $1 AND thread_id = $2 FOR UPDATE",
          [this.#config.namespace, lease.threadId],
        );
        const history = histories[0];
        const historyBinding = history ? peerBindingFromRow(history) : undefined;
        let ambiguous =
          request.history_binding_hash === null ||
          text(request, "history_binding_hash") !== checkpoint.peerBinding.bindingHash ||
          number(request, "history_revision") !== checkpoint.expectedHistoryRevision ||
          (history
            ? number(history, "revision") !== checkpoint.expectedHistoryRevision ||
              (!sameDistributedPeerBinding(historyBinding!, checkpoint.peerBinding) &&
                !allowsDistributedPeerPromotion(historyBinding!, checkpoint.peerBinding))
            : checkpoint.expectedHistoryRevision !== 0);
        const duplicateCostOperations = new Set<string>();
        for (const marker of checkpoint.costMarkers) {
          const duplicate = await tx.unsafe<Row>(
            "SELECT operation_id FROM public.auggy_coordination_cost_markers WHERE namespace = $1 AND operation_id = $2",
            [this.#config.namespace, marker.operationId],
          );
          if (duplicate[0]) {
            ambiguous = true;
            duplicateCostOperations.add(marker.operationId);
          }
        }

        if (!ambiguous) {
          for (const intent of checkpoint.outboxIntents) {
            const duplicate = await tx.unsafe<Row>(
              "SELECT operation_id FROM public.auggy_coordination_outbox WHERE namespace = $1 AND operation_id = $2",
              [this.#config.namespace, intent.operationId],
            );
            if (duplicate[0]) ambiguous = true;
          }
          const pending = await tx.unsafe<Row>(
            "SELECT count(*)::integer AS count FROM public.auggy_coordination_outbox WHERE namespace = $1 AND state = 'pending'",
            [this.#config.namespace],
          );
          if (
            number(pending[0]!, "count") + checkpoint.outboxIntents.length >
            this.#config.turnState.outbox.maxPendingIntents
          ) {
            ambiguous = true;
          }
          if (!history) {
            const historyCounts = await tx.unsafe<Row>(
              "SELECT count(*)::integer AS count FROM public.auggy_coordination_history WHERE namespace = $1",
              [this.#config.namespace],
            );
            if (number(historyCounts[0]!, "count") >= this.#config.turnState.history.maxThreads) {
              ambiguous = true;
            }
          }
        }
        if (ambiguous) {
          for (const marker of checkpoint.costMarkers) {
            if (!duplicateCostOperations.has(marker.operationId)) {
              await this.insertCostMarker(tx, lease, marker);
            }
          }
          await this.settleBudgetAccounting(
            tx,
            lease,
            outcomeUnknownAccountingMarkers(
              this.#config.namespace,
              lease,
              checkpoint.costMarkers,
              duplicateCostOperations,
            ),
            "outcome_unknown",
          );
          const quarantined = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_requests SET state = 'outcome_unknown', terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NOT NULL RETURNING request_id",
            [
              this.#config.namespace,
              lease.requestId,
              lease.threadId,
              lease.sourceId,
              lease.attempt,
              lease.fence,
              this.#config.instanceId,
              this.#sessionId,
            ],
          );
          if (!quarantined[0]) throw new Error("lease changed during turn quarantine");
          await this.recordQuarantine(
            tx,
            lease.threadId,
            lease.requestId,
            lease.fence,
            "effect-outcome-unknown",
          );
          return { status: "outcome-unknown" };
        }

        const historyValues = [
          this.#config.namespace,
          lease.threadId,
          checkpoint.expectedHistoryRevision,
          checkpoint.peerBinding.bindingHash,
          checkpoint.peerBinding.peerIdHash,
          checkpoint.peerBinding.promotionScopeHash,
          checkpoint.peerBinding.trustLevel,
          checkpoint.peerBinding.publicSubstate ?? null,
          new Uint8Array(checkpoint.history.body),
          checkpoint.history.messageCount,
        ];
        const updatedHistory = history
          ? await tx.unsafe<Row>(
              "/* cp4:history */ UPDATE public.auggy_coordination_history SET peer_binding_hash = $4, peer_id_hash = $5, promotion_scope_hash = $6, trust_level = $7, public_substate = $8, revision = revision + 1, snapshot_version = 1, snapshot_body = $9, message_count = $10, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2 AND revision = $3 RETURNING revision",
              historyValues,
            )
          : await tx.unsafe<Row>(
              "/* cp4:history */ INSERT INTO public.auggy_coordination_history (namespace, thread_id, peer_binding_hash, peer_id_hash, promotion_scope_hash, trust_level, public_substate, revision, snapshot_version, snapshot_body, message_count) VALUES ($1, $2, $4, $5, $6, $7, $8, 1, 1, $9, $10) RETURNING revision",
              historyValues,
            );
        if (!updatedHistory[0]) throw new Error("history revision changed during commit");
        for (const marker of checkpoint.costMarkers) {
          await this.insertCostMarker(tx, lease, marker);
        }
        await this.settleBudgetAccounting(tx, lease, checkpoint.costMarkers, "committed");
        for (const intent of checkpoint.outboxIntents) {
          await tx.unsafe(
            "/* cp4:outbox */ INSERT INTO public.auggy_coordination_outbox (namespace, request_id, intent_ordinal, operation_id, fence, intent_version, intent_body, intent_content_type) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)",
            [
              this.#config.namespace,
              lease.requestId,
              intent.ordinal,
              intent.operationId,
              lease.fence,
              new Uint8Array(intent.body),
              intent.contentType,
            ],
          );
        }
        const completed = await tx.unsafe<Row>(
          "/* cp4:request */ UPDATE public.auggy_coordination_requests SET state = 'completed', result_body = $9, result_content_type = $10, result_version = 1, terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NOT NULL AND history_binding_hash = $11 AND history_revision = $12 RETURNING request_id",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
            new Uint8Array(checkpoint.replay.body),
            checkpoint.replay.contentType,
            checkpoint.peerBinding.bindingHash,
            checkpoint.expectedHistoryRevision,
          ],
        );
        if (!completed[0]) throw new Error("lease changed during atomic turn commit");
        return { status: "ok" };
      }),
    );
    this.abortOwned(
      lease.requestId,
      result.status === "ok"
        ? "settled"
        : result.status === "outcome-unknown"
          ? "outcome-unknown"
          : result.status === "unavailable"
            ? "coordinator-authority-lost"
            : "lease-ownership-lost",
    );
    return result;
  }

  async complete(
    lease: DistributedTurnLease,
    replayResult: DistributedReplayResult,
  ): Promise<LeaseResult> {
    if (!validReplayResult(replayResult)) {
      return { status: "rejected", reason: "invalid-result" };
    }
    if (replayResult.body.byteLength > this.#config.result.maxReplayBytes) {
      return { status: "rejected", reason: "result-too-large" };
    }
    if (this.#config.compatibility.protocolVersion >= 5) {
      return { status: "rejected", reason: "atomic-turn-state-required" };
    }
    if (!this.validLease(lease)) return { status: "stale" };
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "SELECT history_binding_hash FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() FOR UPDATE",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        if (!rows[0]) return { status: "stale" };
        if (rows[0].history_binding_hash !== null) {
          return { status: "rejected", reason: "atomic-turn-state-required" };
        }
        const completed = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'completed', result_body = $9, result_content_type = $10, result_version = 1, terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND history_binding_hash IS NULL RETURNING request_id",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
            new Uint8Array(replayResult.body),
            replayResult.contentType,
          ],
        );
        if (!completed[0]) throw new Error("lease changed during completion");
        return { status: "ok" };
      }),
    );
    if (result.status === "ok") this.abortOwned(lease.requestId, "settled");
    else if (result.status === "unavailable") {
      this.abortOwned(lease.requestId, "coordinator-authority-lost");
    } else if (result.status !== "rejected") {
      this.abortOwned(lease.requestId, "lease-ownership-lost");
    }
    return result;
  }

  async fail(lease: DistributedTurnLease): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = CASE WHEN execution_started_at IS NULL THEN 'failed' ELSE 'outcome_unknown' END, terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() RETURNING thread_id, fence, execution_started_at IS NOT NULL AS ambiguous",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        const row = rows[0];
        if (!row) return { status: "stale" };
        if (!bool(row, "ambiguous")) return { status: "ok" };
        await this.settleBudgetAccounting(
          tx,
          lease,
          missingUsageAccountingMarkers(this.#config.namespace, lease),
          "outcome_unknown",
        );
        await this.recordQuarantine(
          tx,
          lease.threadId,
          lease.requestId,
          lease.fence,
          "execution-failed-after-start",
        );
        return { status: "outcome-unknown" };
      }),
    );
    this.abortOwned(
      lease.requestId,
      result.status === "ok"
        ? "settled"
        : result.status === "outcome-unknown"
          ? "outcome-unknown"
          : result.status === "unavailable"
            ? "coordinator-authority-lost"
            : "lease-ownership-lost",
    );
    return result;
  }

  async markOutcomeUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<LeaseResult> {
    return this.settleOutcomeUnknown(lease, reasonCode, []);
  }

  async settleOutcomeUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
    costMarkers: readonly DistributedCostMarkerV1[],
  ): Promise<LeaseResult> {
    if (!this.validLease(lease) || !OUTCOME_UNKNOWN_REASONS.has(reasonCode)) {
      return { status: "stale" };
    }
    if (!validTerminalCostMarkers(costMarkers, this.#config.turnState.maxCostMarkersPerTurn)) {
      return { status: "rejected", reason: "invalid-turn-state" };
    }
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "SELECT request_id FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NOT NULL FOR UPDATE",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        if (!rows[0]) return { status: "stale" };
        const duplicateCostOperations = new Set<string>();
        for (const marker of costMarkers) {
          const duplicate = await tx.unsafe<Row>(
            "SELECT request_id, fence FROM public.auggy_coordination_cost_markers WHERE namespace = $1 AND operation_id = $2",
            [this.#config.namespace, marker.operationId],
          );
          if (duplicate[0]) duplicateCostOperations.add(marker.operationId);
        }
        for (const marker of costMarkers) {
          if (!duplicateCostOperations.has(marker.operationId)) {
            await this.insertCostMarker(tx, lease, marker);
          }
        }
        await this.settleBudgetAccounting(
          tx,
          lease,
          outcomeUnknownAccountingMarkers(
            this.#config.namespace,
            lease,
            costMarkers,
            duplicateCostOperations,
          ),
          "outcome_unknown",
        );
        const settled = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'outcome_unknown', terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() AND execution_started_at IS NOT NULL RETURNING request_id",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        if (!settled[0]) throw new Error("lease changed during outcome-unknown settlement");
        await this.recordQuarantine(tx, lease.threadId, lease.requestId, lease.fence, reasonCode);
        return { status: "outcome-unknown" };
      }),
    );
    this.abortOwned(
      lease.requestId,
      result.status === "outcome-unknown"
        ? "outcome-unknown"
        : result.status === "unavailable"
          ? "coordinator-authority-lost"
          : "lease-ownership-lost",
    );
    return result;
  }

  async status(request: DistributedTurnRequestIdentity): Promise<DistributedRequestStatus> {
    return this.safe<DistributedRequestStatus>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "SELECT state, thread_id, source_id, binding_hash, admission_hash, CASE WHEN result_body IS NULL THEN NULL ELSE octet_length(result_body) END AS result_bytes FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2",
          [this.#config.namespace, request.requestId],
        );
        const row = rows[0];
        if (!row) return { status: "missing" };
        if (
          text(row, "thread_id") !== request.threadId ||
          text(row, "source_id") !== request.source.id ||
          text(row, "binding_hash") !== request.bindingHash ||
          text(row, "admission_hash") !== requestAdmissionHash(request)
        ) {
          return { status: "conflict" };
        }
        const state = text(row, "state");
        if (state === "queued" || state === "active") return { status: "pending", state };
        if (state === "outcome_unknown") return { status: "quarantined" };
        if (state === "failed" || state === "canceled") return { status: "terminal", state };
        if (state !== "completed") throw new Error("invalid request state");
        const resultBytes = number(row, "result_bytes");
        if (resultBytes > this.#config.result.maxReplayBytes) {
          throw new Error("stored replay exceeds configured limit");
        }
        const replayRows = await tx.unsafe<Row>(
          "SELECT result_body, result_content_type, result_version FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND admission_hash = $6 AND state = 'completed'",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            request.source.id,
            request.bindingHash,
            requestAdmissionHash(request),
          ],
        );
        const replayRow = replayRows[0];
        if (
          !replayRow ||
          text(replayRow, "result_content_type") !== "application/json" ||
          number(replayRow, "result_version") !== 1
        ) {
          throw new Error("missing completed replay result");
        }
        const result = {
          body: bytes(replayRow, "result_body"),
          contentType: "application/json" as const,
        };
        if (
          result.body.byteLength !== resultBytes ||
          (this.#config.compatibility.protocolVersion >= 5
            ? !validDistributedReplay(result, request.threadId)
            : !validReplayResult(result))
        ) {
          throw new Error("invalid completed replay result");
        }
        return { status: "completed", result };
      }),
    );
  }

  async wait(
    request: DistributedTurnRequestIdentity,
    options: { signal?: AbortSignal; timeoutMs: number; pollMs: number },
  ): Promise<DistributedRequestStatus> {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 0 ||
      options.timeoutMs > 300_000 ||
      !Number.isSafeInteger(options.pollMs) ||
      options.pollMs < 10 ||
      options.pollMs > 1_000
    ) {
      return { status: "unavailable" };
    }
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      if (options.signal?.aborted) return { status: "wait-aborted" };
      const status = await this.status(request);
      if (status.status !== "pending") return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "wait-timeout" };
      if (!(await waitDelay(Math.min(options.pollMs, remaining), options.signal))) {
        return { status: "wait-aborted" };
      }
    }
  }

  async events(options: { afterEventId?: string; limit: number }): Promise<DistributedEventPage> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_EVENT_PAGE
    ) {
      return { status: "unavailable" };
    }
    let afterEventId = "0";
    if (options.afterEventId !== undefined) {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(options.afterEventId)) {
        return { status: "unavailable" };
      }
      if (BigInt(options.afterEventId) > MAX_BIGINT) return { status: "unavailable" };
      afterEventId = options.afterEventId;
    }
    return this.safe<DistributedEventPage>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        const rows = await tx.unsafe<Row>(
          "SELECT created_at, event_id::text AS event_id, event_type, fence, reason, request_id, thread_id FROM public.auggy_coordination_events WHERE namespace = $1 AND event_id > $2::bigint ORDER BY event_id LIMIT $3",
          [this.#config.namespace, afterEventId, options.limit],
        );
        const events = rows.map((row): DistributedCoordinationEvent => {
          const eventType = text(row, "event_type");
          if (eventType !== "operator_recovery" && eventType !== "outcome_unknown") {
            throw new Error("invalid coordinator event type");
          }
          const reasonCode = text(row, "reason");
          if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reasonCode)) {
            throw new Error("invalid coordinator event reason");
          }
          return {
            createdAt: new Date(date(row, "created_at")).toISOString(),
            eventId: text(row, "event_id"),
            eventType,
            ...(row.fence === null ? {} : { fence: number(row, "fence") }),
            reasonCode,
            ...(row.request_id === null ? {} : { requestId: text(row, "request_id") }),
            threadId: text(row, "thread_id"),
          };
        });
        return {
          status: "ok",
          events,
          ...(events.length > 0 ? { nextEventId: events.at(-1)!.eventId } : {}),
        };
      }),
    );
  }

  async prune(batchSize: number): Promise<DistributedPruneResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_PRUNE_BATCH) {
      return { status: "unavailable" };
    }
    return this.safe<DistributedPruneResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        await this.#expireActive(tx);
        await this.#cancelExpiredQueued(tx);
        for (const policy of normalizedBudgets(this.#config).policies) {
          await this.cleanupExpiredBudgetEvidence(tx, policy, batchSize);
        }
        const requestRows = await tx.unsafe<Row>(
          "WITH ranked AS (SELECT request.request_id, request.terminal_at, row_number() OVER (ORDER BY request.terminal_at DESC, request.request_id DESC) AS newest_rank FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.state IN ('completed', 'failed', 'canceled') AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_outbox outbox WHERE outbox.namespace = request.namespace AND outbox.request_id = request.request_id AND outbox.state = 'pending')), victims AS MATERIALIZED (SELECT request_id FROM ranked WHERE terminal_at <= clock_timestamp() - ($2 * interval '1 millisecond') OR newest_rank > $3 ORDER BY terminal_at, request_id LIMIT $4), deleted_costs AS (DELETE FROM public.auggy_coordination_cost_markers cost USING victims WHERE cost.namespace = $1 AND cost.request_id = victims.request_id RETURNING 1), deleted_budget_anonymous AS (DELETE FROM public.auggy_coordination_budget_anonymous_events event USING victims WHERE event.namespace = $1 AND event.request_id = victims.request_id RETURNING 1) DELETE FROM public.auggy_coordination_requests request USING victims WHERE request.namespace = $1 AND request.request_id = victims.request_id AND (SELECT count(*) FROM deleted_costs) >= 0 AND (SELECT count(*) FROM deleted_budget_anonymous) >= 0 RETURNING request.capacity_class, request.capacity_partition_hash",
          [
            this.#config.namespace,
            this.#config.retention.terminalRequestRetentionMs,
            this.#config.retention.maxTerminalRequests,
            batchSize,
          ],
        );
        await this.releaseRequestCapacitySlots(tx, requestRows);
        const threadRows = await tx.unsafe<Row>(
          "WITH victims AS MATERIALIZED (SELECT thread.thread_id FROM public.auggy_coordination_threads thread WHERE thread.namespace = $1 AND NOT thread.quarantined AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.thread_id = thread.thread_id) ORDER BY thread.thread_id LIMIT $2), deleted_history AS (DELETE FROM public.auggy_coordination_history history USING victims WHERE history.namespace = $1 AND history.thread_id = victims.thread_id RETURNING 1), deleted AS (DELETE FROM public.auggy_coordination_threads thread USING victims WHERE thread.namespace = $1 AND thread.thread_id = victims.thread_id AND (SELECT count(*) FROM deleted_history) >= 0 RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [this.#config.namespace, batchSize],
        );
        const eventRows = await tx.unsafe<Row>(
          "WITH eligible AS (SELECT event.event_id, event.created_at FROM public.auggy_coordination_events event WHERE event.namespace = $1 AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.request_id = event.request_id AND request.state = 'outcome_unknown')), ranked AS (SELECT event_id, created_at, row_number() OVER (ORDER BY event_id DESC) AS newest_rank FROM eligible), victims AS (SELECT event_id FROM ranked WHERE created_at <= clock_timestamp() - ($2 * interval '1 millisecond') OR newest_rank > $3 ORDER BY event_id LIMIT $4), deleted AS (DELETE FROM public.auggy_coordination_events event USING victims WHERE event.namespace = $1 AND event.event_id = victims.event_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [
            this.#config.namespace,
            this.#config.retention.eventRetentionMs,
            this.#config.retention.maxEvents,
            batchSize,
          ],
        );
        const instanceRows = await tx.unsafe<Row>(
          "WITH victims AS (SELECT instance.instance_id FROM public.auggy_coordination_instances instance WHERE instance.namespace = $1 AND instance.instance_id <> $2 AND instance.lease_expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND ((request.owner_instance = instance.instance_id AND request.owner_session = instance.session_id) OR (request.queue_owner_instance = instance.instance_id AND request.queue_owner_session = instance.session_id))) ORDER BY instance.registered_at, instance.instance_id LIMIT $3), deleted AS (DELETE FROM public.auggy_coordination_instances instance USING victims WHERE instance.namespace = $1 AND instance.instance_id = victims.instance_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [this.#config.namespace, this.#config.instanceId, batchSize],
        );
        return {
          status: "ok",
          events: number(eventRows[0]!, "count"),
          instances: number(instanceRows[0]!, "count"),
          requests: requestRows.length,
          threads: number(threadRows[0]!, "count"),
        };
      }),
    );
  }

  async recover(threadId: string, expectedFence: number, reason: string): Promise<LeaseResult> {
    assertIdentifier("threadId", threadId);
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reason)) {
      throw new Error("recovery reason must be a fixed secret-free reason code");
    }
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const threads = await tx.unsafe<Row>(
          "SELECT thread_id FROM public.auggy_coordination_threads WHERE namespace = $1 AND thread_id = $2 AND quarantined = TRUE AND quarantine_fence = $3 FOR UPDATE",
          [this.#config.namespace, threadId, expectedFence],
        );
        if (!threads[0]) return { status: "stale" };
        const incidents = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'failed', terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2 AND fence = $3 AND state = 'outcome_unknown' RETURNING request_id",
          [this.#config.namespace, threadId, expectedFence],
        );
        const incident = incidents[0];
        if (!incident) return { status: "stale" };
        await tx.unsafe(
          "UPDATE public.auggy_coordination_threads SET quarantined = FALSE, quarantine_fence = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, threadId],
        );
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_events (namespace, thread_id, request_id, fence, event_type, reason) VALUES ($1, $2, $3, $4, 'operator_recovery', $5)",
          [this.#config.namespace, threadId, text(incident, "request_id"), expectedFence, reason],
        );
        return { status: "ok" };
      }),
    );
  }

  async beginDrain(): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        const drained = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_instances SET accepting = FALSE, draining = TRUE, updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND lease_expires_at > clock_timestamp() RETURNING instance_id",
          [this.#config.namespace, this.#config.instanceId, this.#sessionId],
        );
        if (!drained[0]) return { status: "stale" };
        await tx.unsafe(
          "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'queued' AND queue_owner_instance = $2 AND queue_owner_session = $3",
          [this.#config.namespace, this.#config.instanceId, this.#sessionId],
        );
        return { status: "ok" };
      }),
    );
    if (result.status === "ok") this.abortOwnedPhase("queued", "draining");
    else this.abortAllOwned("coordinator-authority-lost");
    return result;
  }

  async health(): Promise<DistributedCoordinatorHealth> {
    const result = await this.safe<DistributedCoordinatorHealth>(
      { status: "unavailable", active: 0, queued: 0, quarantined: 0 },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          const instance = await this.registeredInstance(tx);
          if (!instance) throw new Error("coordinator instance is not registered");
          await this.#expireActive(tx);
          await this.#cancelExpiredQueued(tx);
          const rows = await tx.unsafe<Row>(
            "SELECT count(*) FILTER (WHERE state = 'active')::integer AS active, count(*) FILTER (WHERE state = 'queued')::integer AS queued, (SELECT count(*)::integer FROM public.auggy_coordination_threads WHERE namespace = $1 AND quarantined) AS quarantined FROM public.auggy_coordination_requests WHERE namespace = $1",
            [this.#config.namespace],
          );
          const row = rows[0];
          if (!row) throw new Error("missing coordinator health row");
          return {
            status: instance.draining ? "draining" : "healthy",
            active: number(row, "active"),
            queued: number(row, "queued"),
            quarantined: number(row, "quarantined"),
          };
        }),
    );
    if (result.status === "unavailable") this.abortAllOwned("coordinator-authority-lost");
    return result;
  }

  async insertCostMarker(
    tx: SqlTransaction,
    lease: DistributedTurnLease,
    marker: DistributedCostMarkerV1,
  ): Promise<void> {
    await tx.unsafe(
      "/* cp4:cost */ INSERT INTO public.auggy_coordination_cost_markers (namespace, operation_id, request_id, fence, marker_version, priced, cost_usd, unpriced_reason) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)",
      [
        this.#config.namespace,
        marker.operationId,
        lease.requestId,
        lease.fence,
        marker.priced,
        marker.priced
          ? formatDistributedBudgetCostNanos(distributedBudgetCostNanos(marker.costUsd))
          : null,
        marker.priced ? null : marker.reason,
      ],
    );
  }

  async settleBudgetAccounting(
    tx: SqlTransaction,
    lease: DistributedTurnLease,
    costMarkers: readonly DistributedCostMarkerV1[],
    state: "committed" | "outcome_unknown",
  ): Promise<void> {
    const reservations = await tx.unsafe<Row>(
      "SELECT policy_id, admission_day::text AS admission_day, peer_id_hash, thread_id_hash FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND request_id = $2 AND attempt = $3 AND fence = $4 AND state = 'reserved' ORDER BY policy_id FOR UPDATE",
      [this.#config.namespace, lease.requestId, lease.attempt, lease.fence],
    );
    if (reservations.length === 0) return;
    const hasUnpriced = costMarkers.some((marker) => !marker.priced);
    const pricedCostNanos = costMarkers.reduce(
      (sum, marker) => sum + (marker.priced ? distributedBudgetCostNanos(marker.costUsd) : 0n),
      0n,
    );
    if (pricedCostNanos > distributedBudgetCostNanos(MAX_COST_USD)) {
      throw new Error("distributed cost total exceeds budget accounting bounds");
    }
    const pricedCost = formatDistributedBudgetCostNanos(pricedCostNanos);
    const policies = new Map(
      normalizedBudgets(this.#config).policies.map((policy) => [policy.id, policy]),
    );
    for (const reservation of reservations) {
      const policyId = text(reservation, "policy_id");
      const policy = policies.get(policyId);
      if (!policy) throw new Error("distributed budget reservation policy is unavailable");
      const admissionDay = text(reservation, "admission_day");
      const peerIdHash = text(reservation, "peer_id_hash");
      let globalTotalNanos: bigint | null = null;
      if (pricedCostNanos > 0n) {
        const global = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_budget_daily SET cost_usd = cost_usd + $5::numeric, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'global' AND subject_hash = $4 RETURNING cost_usd::text AS cost_usd",
          [this.#config.namespace, policyId, admissionDay, GLOBAL_BUDGET_SUBJECT_HASH, pricedCost],
        );
        const peer = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_budget_daily SET cost_usd = cost_usd + $5::numeric, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'peer' AND subject_hash = $4 RETURNING subject_hash",
          [this.#config.namespace, policyId, admissionDay, peerIdHash, pricedCost],
        );
        if (!global[0] || !peer[0]) throw new Error("distributed budget aggregate is missing");
        globalTotalNanos = parseDistributedBudgetCostNanos(text(global[0], "cost_usd"));
      }
      if (hasUnpriced) {
        const global = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_budget_daily SET unpriced_turns = unpriced_turns + 1, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'global' AND subject_hash = $4 RETURNING subject_hash",
          [this.#config.namespace, policyId, admissionDay, GLOBAL_BUDGET_SUBJECT_HASH],
        );
        const peer = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_budget_daily SET unpriced_turns = unpriced_turns + 1, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND subject_kind = 'peer' AND subject_hash = $4 RETURNING subject_hash",
          [this.#config.namespace, policyId, admissionDay, peerIdHash],
        );
        if (!global[0] || !peer[0]) throw new Error("distributed budget aggregate is missing");
      }

      if (
        globalTotalNanos !== null &&
        policy.dailyBudgetUsd !== undefined &&
        policy.notifications &&
        policy.notifications.thresholds.length > 0
      ) {
        const dailyBudgetNanos = distributedBudgetCostNanos(policy.dailyBudgetUsd);
        const crossed = policy.notifications.thresholds.filter(
          (threshold) =>
            globalTotalNanos! * 1_000_000n >=
            dailyBudgetNanos * BigInt(Math.round(threshold * 1_000_000)),
        );
        if (crossed.length > 0) {
          const existing = await tx.unsafe<Row>(
            "SELECT threshold_ppm FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date ORDER BY threshold_ppm FOR UPDATE",
            [this.#config.namespace, policyId, admissionDay],
          );
          const sent = new Set(existing.map((row) => number(row, "threshold_ppm")));
          const newlyCrossed = crossed.filter(
            (threshold) => !sent.has(Math.round(threshold * 1_000_000)),
          );
          if (newlyCrossed.length > 0) {
            const capacity = await tx.unsafe<Row>(
              "SELECT count(*)::integer AS count FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1 AND policy_id = $2",
              [this.#config.namespace, policyId],
            );
            if (number(capacity[0]!, "count") + newlyCrossed.length > policy.maxThresholdIntents) {
              throw new Error("distributed budget threshold intent capacity is exhausted");
            }
            const highest = newlyCrossed.at(-1)!;
            for (const threshold of newlyCrossed) {
              const thresholdPpm = Math.round(threshold * 1_000_000);
              const pending = threshold === highest;
              const operationId = pending
                ? `auggy-op-v1-${budgetDigest(
                    "auggy-distributed-budget-threshold-v1",
                    this.#config.namespace,
                    policyId,
                    admissionDay,
                    String(thresholdPpm),
                  )}`
                : null;
              const totalUsd = Number(globalTotalNanos) / 1_000_000_000;
              const body = pending
                ? new TextEncoder().encode(
                    JSON.stringify({
                      version: 1,
                      kind: "budget-threshold",
                      destination: policy.notifications.destination,
                      threshold,
                      day: admissionDay,
                      totalUsd,
                      dailyBudgetUsd: policy.dailyBudgetUsd,
                      requestId: lease.requestId,
                      peerIdHash,
                      threadIdHash: text(reservation, "thread_id_hash"),
                      summary: `Budget threshold reached: ${Math.round(threshold * 100)}% of daily budget used`,
                      reason: `Daily budget spend is $${totalUsd.toFixed(2)} of $${policy.dailyBudgetUsd.toFixed(2)} for ${admissionDay}.`,
                    }),
                  )
                : null;
              if (body && body.byteLength > 65_536) {
                throw new Error("distributed budget threshold intent exceeds bounds");
              }
              await tx.unsafe(
                "INSERT INTO public.auggy_coordination_budget_threshold_intents (namespace, policy_id, admission_day, threshold_ppm, destination, request_id, operation_id, intent_body, state) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)",
                [
                  this.#config.namespace,
                  policyId,
                  admissionDay,
                  thresholdPpm,
                  policy.notifications.destination,
                  lease.requestId,
                  operationId,
                  body,
                  pending ? "pending" : "suppressed",
                ],
              );
            }
          }
        }
      }
      const updated = await tx.unsafe<Row>(
        "UPDATE public.auggy_coordination_budget_reservations SET state = $5, settled_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND request_id = $3 AND state = 'reserved' AND attempt = $4 AND fence = $6 RETURNING request_id",
        [this.#config.namespace, policyId, lease.requestId, lease.attempt, state, lease.fence],
      );
      if (!updated[0]) throw new Error("distributed budget reservation changed during settlement");
    }
  }

  async budgetUsage(
    tx: SqlTransaction,
    policyId: string,
    admissionDay: string,
    peerIdHash: string,
    threadIdHash: string,
  ) {
    const rows = await tx.unsafe<Row>(
      "SELECT (SELECT count(*)::integer FROM public.auggy_coordination_budget_reservations reservation WHERE reservation.namespace = $1 AND reservation.policy_id = $2 AND reservation.admission_day = $3::date AND reservation.peer_id_hash = $4 AND reservation.thread_id_hash = $5) AS thread_turns, COALESCE(max(daily.turns_reserved) FILTER (WHERE daily.subject_kind = 'peer' AND daily.subject_hash = $4), 0)::integer AS peer_turns, COALESCE(max(daily.cost_usd) FILTER (WHERE daily.subject_kind = 'peer' AND daily.subject_hash = $4), 0)::text AS peer_cost_usd, COALESCE(max(daily.unpriced_turns) FILTER (WHERE daily.subject_kind = 'peer' AND daily.subject_hash = $4), 0)::integer AS peer_unpriced_turns, COALESCE(max(daily.cost_usd) FILTER (WHERE daily.subject_kind = 'global' AND daily.subject_hash = $6), 0)::text AS global_cost_usd, COALESCE(max(daily.unpriced_turns) FILTER (WHERE daily.subject_kind = 'global' AND daily.subject_hash = $6), 0)::integer AS global_unpriced_turns FROM public.auggy_coordination_budget_daily daily WHERE daily.namespace = $1 AND daily.policy_id = $2 AND daily.admission_day = $3::date",
      [
        this.#config.namespace,
        policyId,
        admissionDay,
        peerIdHash,
        threadIdHash,
        GLOBAL_BUDGET_SUBJECT_HASH,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("missing distributed budget usage row");
    return {
      admissionDay,
      threadTurns: number(row, "thread_turns"),
      peerTurns: number(row, "peer_turns"),
      peerCostUsd: decimal(row, "peer_cost_usd"),
      peerUnpricedTurns: number(row, "peer_unpriced_turns"),
      globalCostUsd: decimal(row, "global_cost_usd"),
      globalUnpricedTurns: number(row, "global_unpriced_turns"),
    };
  }

  async cleanupExpiredBudgetEvidence(
    tx: SqlTransaction,
    policy: DistributedBudgetPolicyV1,
    limit: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CAPACITY) {
      throw new Error("distributed budget cleanup limit is invalid");
    }
    await tx.unsafe(
      "WITH victims AS (SELECT request_id FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 AND policy_id = $2 AND expires_at <= clock_timestamp() ORDER BY expires_at, request_id LIMIT $3) DELETE FROM public.auggy_coordination_budget_anonymous_events event USING victims WHERE event.namespace = $1 AND event.policy_id = $2 AND event.request_id = victims.request_id",
      [this.#config.namespace, policy.id, limit],
    );
    await tx.unsafe(
      "WITH victims AS (SELECT reservation.request_id FROM public.auggy_coordination_budget_reservations reservation WHERE reservation.namespace = $1 AND reservation.policy_id = $2 AND reservation.settled_at <= clock_timestamp() - ($3 * interval '1 millisecond') AND (reservation.state = 'committed' OR (reservation.state = 'outcome_unknown' AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = reservation.namespace AND request.request_id = reservation.request_id AND request.state = 'outcome_unknown'))) ORDER BY reservation.settled_at, reservation.request_id LIMIT $4) DELETE FROM public.auggy_coordination_budget_reservations reservation USING victims WHERE reservation.namespace = $1 AND reservation.policy_id = $2 AND reservation.request_id = victims.request_id",
      [this.#config.namespace, policy.id, policy.reservationRetentionMs, limit],
    );
    await tx.unsafe(
      "WITH victims AS (SELECT daily.admission_day, daily.subject_kind, daily.subject_hash FROM public.auggy_coordination_budget_daily daily WHERE daily.namespace = $1 AND daily.policy_id = $2 AND daily.admission_day <= (clock_timestamp() AT TIME ZONE 'UTC')::date - $3 AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_budget_reservations reservation WHERE reservation.namespace = daily.namespace AND reservation.policy_id = daily.policy_id AND reservation.admission_day = daily.admission_day AND reservation.state IN ('reserved', 'outcome_unknown')) ORDER BY daily.admission_day, daily.subject_kind, daily.subject_hash LIMIT $4) DELETE FROM public.auggy_coordination_budget_daily daily USING victims WHERE daily.namespace = $1 AND daily.policy_id = $2 AND daily.admission_day = victims.admission_day AND daily.subject_kind = victims.subject_kind AND daily.subject_hash = victims.subject_hash",
      [this.#config.namespace, policy.id, policy.aggregateRetentionDays, limit],
    );
    await tx.unsafe(
      "WITH victims AS (SELECT admission_day, threshold_ppm FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1 AND policy_id = $2 AND state = 'suppressed' AND admission_day <= (clock_timestamp() AT TIME ZONE 'UTC')::date - $3 ORDER BY admission_day, threshold_ppm LIMIT $4) DELETE FROM public.auggy_coordination_budget_threshold_intents intent USING victims WHERE intent.namespace = $1 AND intent.policy_id = $2 AND intent.admission_day = victims.admission_day AND intent.threshold_ppm = victims.threshold_ppm",
      [this.#config.namespace, policy.id, policy.aggregateRetentionDays, limit],
    );
  }

  async releaseBudgetReservationsForRequest(
    tx: SqlTransaction,
    requestId: string,
    attempt: number,
  ): Promise<void> {
    const reservations = await tx.unsafe<Row>(
      "DELETE FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 AND request_id = $2 AND attempt = $3 AND state = 'reserved' RETURNING policy_id, admission_day::text AS admission_day, peer_id_hash",
      [this.#config.namespace, requestId, attempt],
    );
    if (reservations.length === 0) return;
    await tx.unsafe(
      "DELETE FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 AND request_id = $2",
      [this.#config.namespace, requestId],
    );
    for (const reservation of reservations) {
      await tx.unsafe(
        "UPDATE public.auggy_coordination_budget_daily SET turns_reserved = turns_reserved - 1, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND ((subject_kind = 'global' AND subject_hash = $4) OR (subject_kind = 'peer' AND subject_hash = $5)) AND turns_reserved > 0",
        [
          this.#config.namespace,
          text(reservation, "policy_id"),
          text(reservation, "admission_day"),
          GLOBAL_BUDGET_SUBJECT_HASH,
          text(reservation, "peer_id_hash"),
        ],
      );
      await tx.unsafe(
        "DELETE FROM public.auggy_coordination_budget_daily WHERE namespace = $1 AND policy_id = $2 AND admission_day = $3::date AND ((subject_kind = 'global' AND subject_hash = $4) OR (subject_kind = 'peer' AND subject_hash = $5)) AND turns_reserved = 0 AND cost_usd = 0 AND unpriced_turns = 0",
        [
          this.#config.namespace,
          text(reservation, "policy_id"),
          text(reservation, "admission_day"),
          GLOBAL_BUDGET_SUBJECT_HASH,
          text(reservation, "peer_id_hash"),
        ],
      );
    }
  }

  async #lockNamespace(
    tx: SqlTransaction,
    create = false,
    allowQuiescentUpgrade = false,
  ): Promise<
    Pick<DistributedCoordinatorConfig, "maxConcurrent" | "maxQueued" | "maxQueuedPerThread">
  > {
    const admission = normalizedAdmission(this.#config);
    const configuredAdmission =
      this.#config.admission !== undefined || this.#config.compatibility.protocolVersion >= 6;
    const ratePolicyFingerprint = configuredAdmission
      ? admissionPolicyFingerprint(admission)
      : null;
    const budgets = normalizedBudgets(this.#config);
    const configuredBudgets =
      this.#config.budgets !== undefined || this.#config.compatibility.protocolVersion >= 8;
    const budgetPolicyFingerprint = configuredBudgets
      ? distributedBudgetPolicyFingerprint(budgets)
      : null;
    const budgetCapacity = budgetTotals(budgets);
    if (create) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_namespaces (namespace, max_concurrent, max_queued, max_queued_per_thread, lease_ms, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes, max_history_snapshot_bytes, max_history_messages, max_history_threads, max_cost_markers_per_turn, max_outbox_intents_per_turn, max_outbox_intent_bytes, max_pending_outbox_intents, max_rate_limit_events, rate_policy_fingerprint, max_budget_reservations, max_budget_anonymous_events, max_budget_peer_days, max_budget_threshold_intents, budget_policy_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27) ON CONFLICT (namespace) DO NOTHING",
        [
          this.#config.namespace,
          this.#config.maxConcurrent,
          this.#config.maxQueued,
          this.#config.maxQueuedPerThread,
          this.#config.leaseMs,
          this.#config.compatibility.protocolVersion,
          this.#config.compatibility.protocolFingerprint,
          this.#config.compatibility.configurationFingerprint,
          this.#config.retention.terminalRequestRetentionMs,
          this.#config.retention.maxTerminalRequests,
          this.#config.retention.eventRetentionMs,
          this.#config.retention.maxEvents,
          this.#config.result.maxReplayBytes,
          this.#config.turnState.history.maxSnapshotBytes,
          this.#config.turnState.history.maxMessages,
          this.#config.turnState.history.maxThreads,
          this.#config.turnState.maxCostMarkersPerTurn,
          this.#config.turnState.outbox.maxIntentsPerTurn,
          this.#config.turnState.outbox.maxIntentBytes,
          this.#config.turnState.outbox.maxPendingIntents,
          configuredAdmission ? admission.maxRateLimitEvents : null,
          ratePolicyFingerprint,
          configuredBudgets ? budgetCapacity.reservations : null,
          configuredBudgets ? budgetCapacity.anonymousEvents : null,
          configuredBudgets ? budgetCapacity.peerDays : null,
          configuredBudgets ? budgetCapacity.thresholdIntents : null,
          budgetPolicyFingerprint,
        ],
      );
      await tx.unsafe(
        "UPDATE public.auggy_coordination_namespaces SET lease_ms = $2, updated_at = clock_timestamp() WHERE namespace = $1 AND lease_ms IS NULL",
        [this.#config.namespace, this.#config.leaseMs],
      );
    }
    const policy = await tx.unsafe<Row>(
      "SELECT max_concurrent, max_queued, max_queued_per_thread, lease_ms, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes, max_history_snapshot_bytes, max_history_messages, max_history_threads, max_cost_markers_per_turn, max_outbox_intents_per_turn, max_outbox_intent_bytes, max_pending_outbox_intents, max_rate_limit_events, rate_policy_fingerprint, max_budget_reservations, max_budget_anonymous_events, max_budget_peer_days, max_budget_threshold_intents, budget_policy_fingerprint FROM public.auggy_coordination_namespaces WHERE namespace = $1 FOR UPDATE",
      [this.#config.namespace],
    );
    const row = policy[0];
    if (!row) throw new Error("missing namespace policy row");
    const stored = {
      maxConcurrent: number(row, "max_concurrent"),
      maxQueued: number(row, "max_queued"),
      maxQueuedPerThread: number(row, "max_queued_per_thread"),
      leaseMs: number(row, "lease_ms"),
      protocolVersion: number(row, "protocol_version"),
      protocolFingerprint: text(row, "protocol_fingerprint"),
      configurationFingerprint: text(row, "configuration_fingerprint"),
      terminalRequestRetentionMs: number(row, "terminal_request_retention_ms"),
      maxTerminalRequests: number(row, "max_terminal_requests"),
      eventRetentionMs: number(row, "event_retention_ms"),
      maxEvents: number(row, "max_events"),
      maxReplayBytes: number(row, "max_replay_bytes"),
      maxHistorySnapshotBytes: nullableNumber(row, "max_history_snapshot_bytes"),
      maxHistoryMessages: nullableNumber(row, "max_history_messages"),
      maxHistoryThreads: nullableNumber(row, "max_history_threads"),
      maxCostMarkersPerTurn: nullableNumber(row, "max_cost_markers_per_turn"),
      maxOutboxIntentsPerTurn: nullableNumber(row, "max_outbox_intents_per_turn"),
      maxOutboxIntentBytes: nullableNumber(row, "max_outbox_intent_bytes"),
      maxPendingOutboxIntents: nullableNumber(row, "max_pending_outbox_intents"),
      maxRateLimitEvents: nullableNumber(row, "max_rate_limit_events"),
      ratePolicyFingerprint: nullableText(row, "rate_policy_fingerprint"),
      maxBudgetReservations: nullableNumber(row, "max_budget_reservations"),
      maxBudgetAnonymousEvents: nullableNumber(row, "max_budget_anonymous_events"),
      maxBudgetPeerDays: nullableNumber(row, "max_budget_peer_days"),
      maxBudgetThresholdIntents: nullableNumber(row, "max_budget_threshold_intents"),
      budgetPolicyFingerprint: nullableText(row, "budget_policy_fingerprint"),
    };
    const basePolicyMatches =
      stored.maxConcurrent === this.#config.maxConcurrent &&
      stored.maxQueued === this.#config.maxQueued &&
      stored.maxQueuedPerThread === this.#config.maxQueuedPerThread &&
      stored.leaseMs === this.#config.leaseMs &&
      stored.terminalRequestRetentionMs === this.#config.retention.terminalRequestRetentionMs &&
      stored.maxTerminalRequests === this.#config.retention.maxTerminalRequests &&
      stored.eventRetentionMs === this.#config.retention.eventRetentionMs &&
      stored.maxEvents === this.#config.retention.maxEvents &&
      stored.maxReplayBytes === this.#config.result.maxReplayBytes;
    let turnStateMatches =
      stored.maxHistorySnapshotBytes === this.#config.turnState.history.maxSnapshotBytes &&
      stored.maxHistoryMessages === this.#config.turnState.history.maxMessages &&
      stored.maxHistoryThreads === this.#config.turnState.history.maxThreads &&
      stored.maxCostMarkersPerTurn === this.#config.turnState.maxCostMarkersPerTurn &&
      stored.maxOutboxIntentsPerTurn === this.#config.turnState.outbox.maxIntentsPerTurn &&
      stored.maxOutboxIntentBytes === this.#config.turnState.outbox.maxIntentBytes &&
      stored.maxPendingOutboxIntents === this.#config.turnState.outbox.maxPendingIntents;
    const emptyTurnStatePolicy =
      stored.maxHistorySnapshotBytes === null &&
      stored.maxHistoryMessages === null &&
      stored.maxHistoryThreads === null &&
      stored.maxCostMarkersPerTurn === null &&
      stored.maxOutboxIntentsPerTurn === null &&
      stored.maxOutboxIntentBytes === null &&
      stored.maxPendingOutboxIntents === null;
    let admissionMatches = configuredAdmission
      ? stored.maxRateLimitEvents === admission.maxRateLimitEvents &&
        stored.ratePolicyFingerprint === ratePolicyFingerprint
      : stored.maxRateLimitEvents === null && stored.ratePolicyFingerprint === null;
    const emptyAdmissionPolicy =
      stored.maxRateLimitEvents === null && stored.ratePolicyFingerprint === null;
    let budgetMatches = configuredBudgets
      ? stored.maxBudgetReservations === budgetCapacity.reservations &&
        stored.maxBudgetAnonymousEvents === budgetCapacity.anonymousEvents &&
        stored.maxBudgetPeerDays === budgetCapacity.peerDays &&
        stored.maxBudgetThresholdIntents === budgetCapacity.thresholdIntents &&
        stored.budgetPolicyFingerprint === budgetPolicyFingerprint
      : stored.maxBudgetReservations === null &&
        stored.maxBudgetAnonymousEvents === null &&
        stored.maxBudgetPeerDays === null &&
        stored.maxBudgetThresholdIntents === null &&
        stored.budgetPolicyFingerprint === null;
    const emptyBudgetPolicy =
      stored.maxBudgetReservations === null &&
      stored.maxBudgetAnonymousEvents === null &&
      stored.maxBudgetPeerDays === null &&
      stored.maxBudgetThresholdIntents === null &&
      stored.budgetPolicyFingerprint === null;
    let compatibilityMatches =
      stored.protocolVersion === this.#config.compatibility.protocolVersion &&
      stored.protocolFingerprint === this.#config.compatibility.protocolFingerprint &&
      stored.configurationFingerprint === this.#config.compatibility.configurationFingerprint;
    const predecessor = this.#config.compatibility.upgradeFrom;
    const upgradesTurnState = !configuredAdmission && emptyTurnStatePolicy;
    const upgradesAdmission = configuredAdmission && turnStateMatches && emptyAdmissionPolicy;
    const upgradesBudgets =
      configuredBudgets && turnStateMatches && admissionMatches && emptyBudgetPolicy;
    const upgradesProtocolOnly = turnStateMatches && admissionMatches && budgetMatches;
    if (
      !compatibilityMatches &&
      allowQuiescentUpgrade &&
      basePolicyMatches &&
      (upgradesTurnState || upgradesAdmission || upgradesBudgets || upgradesProtocolOnly) &&
      predecessor &&
      stored.protocolVersion === predecessor.protocolVersion &&
      stored.protocolFingerprint === predecessor.protocolFingerprint &&
      stored.configurationFingerprint === predecessor.configurationFingerprint
    ) {
      const activity = await tx.unsafe<Row>(
        "SELECT count(*) FILTER (WHERE lease_expires_at > clock_timestamp())::integer AS live_instances, (SELECT count(*)::integer FROM public.auggy_coordination_requests WHERE namespace = $1 AND state IN ('queued', 'active')) AS pending_requests, (SELECT count(*)::integer FROM public.auggy_coordination_requests WHERE namespace = $1) AS total_requests, (SELECT count(*)::integer FROM public.auggy_coordination_rate_events WHERE namespace = $1) AS rate_events, (SELECT count(*)::integer FROM public.auggy_coordination_budget_reservations WHERE namespace = $1) AS budget_reservations, (SELECT count(*)::integer FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1) AS budget_anonymous_events, (SELECT count(*)::integer FROM public.auggy_coordination_budget_daily WHERE namespace = $1) AS budget_daily, (SELECT count(*)::integer FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1) AS budget_threshold_intents FROM public.auggy_coordination_instances WHERE namespace = $1",
        [this.#config.namespace],
      );
      const quiescent =
        activity[0] &&
        number(activity[0], "live_instances") === 0 &&
        number(activity[0], "pending_requests") === 0 &&
        (!upgradesAdmission ||
          (number(activity[0], "total_requests") === 0 &&
            number(activity[0], "rate_events") === 0)) &&
        (!upgradesBudgets ||
          (number(activity[0], "budget_reservations") === 0 &&
            number(activity[0], "budget_anonymous_events") === 0 &&
            number(activity[0], "budget_daily") === 0 &&
            number(activity[0], "budget_threshold_intents") === 0));
      if (quiescent) {
        const upgraded = upgradesAdmission
          ? await tx.unsafe<Row>(
              "UPDATE public.auggy_coordination_namespaces SET protocol_version = $5, protocol_fingerprint = $6, configuration_fingerprint = $7, max_rate_limit_events = $8, rate_policy_fingerprint = $9, updated_at = clock_timestamp() WHERE namespace = $1 AND protocol_version = $2 AND protocol_fingerprint = $3 AND configuration_fingerprint = $4 AND max_rate_limit_events IS NULL AND rate_policy_fingerprint IS NULL RETURNING namespace",
              [
                this.#config.namespace,
                predecessor.protocolVersion,
                predecessor.protocolFingerprint,
                predecessor.configurationFingerprint,
                this.#config.compatibility.protocolVersion,
                this.#config.compatibility.protocolFingerprint,
                this.#config.compatibility.configurationFingerprint,
                admission.maxRateLimitEvents,
                ratePolicyFingerprint,
              ],
            )
          : upgradesBudgets
            ? await tx.unsafe<Row>(
                "UPDATE public.auggy_coordination_namespaces SET protocol_version = $5, protocol_fingerprint = $6, configuration_fingerprint = $7, max_budget_reservations = $8, max_budget_anonymous_events = $9, max_budget_peer_days = $10, max_budget_threshold_intents = $11, budget_policy_fingerprint = $12, updated_at = clock_timestamp() WHERE namespace = $1 AND protocol_version = $2 AND protocol_fingerprint = $3 AND configuration_fingerprint = $4 AND max_budget_reservations IS NULL AND max_budget_anonymous_events IS NULL AND max_budget_peer_days IS NULL AND max_budget_threshold_intents IS NULL AND budget_policy_fingerprint IS NULL RETURNING namespace",
                [
                  this.#config.namespace,
                  predecessor.protocolVersion,
                  predecessor.protocolFingerprint,
                  predecessor.configurationFingerprint,
                  this.#config.compatibility.protocolVersion,
                  this.#config.compatibility.protocolFingerprint,
                  this.#config.compatibility.configurationFingerprint,
                  budgetCapacity.reservations,
                  budgetCapacity.anonymousEvents,
                  budgetCapacity.peerDays,
                  budgetCapacity.thresholdIntents,
                  budgetPolicyFingerprint,
                ],
              )
            : upgradesProtocolOnly
              ? await tx.unsafe<Row>(
                  "UPDATE public.auggy_coordination_namespaces SET protocol_version = $5, protocol_fingerprint = $6, configuration_fingerprint = $7, updated_at = clock_timestamp() WHERE namespace = $1 AND protocol_version = $2 AND protocol_fingerprint = $3 AND configuration_fingerprint = $4 RETURNING namespace",
                  [
                    this.#config.namespace,
                    predecessor.protocolVersion,
                    predecessor.protocolFingerprint,
                    predecessor.configurationFingerprint,
                    this.#config.compatibility.protocolVersion,
                    this.#config.compatibility.protocolFingerprint,
                    this.#config.compatibility.configurationFingerprint,
                  ],
                )
              : await tx.unsafe<Row>(
                  "UPDATE public.auggy_coordination_namespaces SET protocol_version = $5, protocol_fingerprint = $6, configuration_fingerprint = $7, max_history_snapshot_bytes = $8, max_history_messages = $9, max_history_threads = $10, max_cost_markers_per_turn = $11, max_outbox_intents_per_turn = $12, max_outbox_intent_bytes = $13, max_pending_outbox_intents = $14, updated_at = clock_timestamp() WHERE namespace = $1 AND protocol_version = $2 AND protocol_fingerprint = $3 AND configuration_fingerprint = $4 AND max_history_snapshot_bytes IS NULL AND max_history_messages IS NULL AND max_history_threads IS NULL AND max_cost_markers_per_turn IS NULL AND max_outbox_intents_per_turn IS NULL AND max_outbox_intent_bytes IS NULL AND max_pending_outbox_intents IS NULL RETURNING namespace",
                  [
                    this.#config.namespace,
                    predecessor.protocolVersion,
                    predecessor.protocolFingerprint,
                    predecessor.configurationFingerprint,
                    this.#config.compatibility.protocolVersion,
                    this.#config.compatibility.protocolFingerprint,
                    this.#config.compatibility.configurationFingerprint,
                    this.#config.turnState.history.maxSnapshotBytes,
                    this.#config.turnState.history.maxMessages,
                    this.#config.turnState.history.maxThreads,
                    this.#config.turnState.maxCostMarkersPerTurn,
                    this.#config.turnState.outbox.maxIntentsPerTurn,
                    this.#config.turnState.outbox.maxIntentBytes,
                    this.#config.turnState.outbox.maxPendingIntents,
                  ],
                );
        if (upgraded[0]) {
          await tx.unsafe(
            "DELETE FROM public.auggy_coordination_instances WHERE namespace = $1 AND lease_expires_at <= clock_timestamp()",
            [this.#config.namespace],
          );
          compatibilityMatches = true;
          if (upgradesTurnState) turnStateMatches = true;
          if (upgradesAdmission) admissionMatches = true;
          if (upgradesBudgets) budgetMatches = true;
        }
      }
    }
    if (
      !basePolicyMatches ||
      !turnStateMatches ||
      !admissionMatches ||
      !budgetMatches ||
      !compatibilityMatches
    ) {
      throw new Error("coordinator namespace policy mismatch");
    }
    return stored;
  }

  async registeredInstance(
    tx: SqlTransaction,
    lock = true,
  ): Promise<{ accepting: boolean; draining: boolean } | undefined> {
    const rows = await tx.unsafe<Row>(
      `SELECT accepting, draining FROM public.auggy_coordination_instances WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND build_fingerprint = $4 AND lease_expires_at > clock_timestamp()${lock ? " FOR UPDATE" : ""}`,
      [
        this.#config.namespace,
        this.#config.instanceId,
        this.#sessionId,
        this.#config.buildFingerprint,
      ],
    );
    const row = rows[0];
    return row ? { accepting: bool(row, "accepting"), draining: bool(row, "draining") } : undefined;
  }

  /** Provision immutable retained-request partitions while the namespace row is locked. */
  async provisionRequestCapacityCounters(tx: SqlTransaction): Promise<void> {
    const policies = [...(normalizedAdmission(this.#config).capacityClasses ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    for (const policy of policies) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_request_class_counters (namespace, capacity_class, max_retained_requests, max_retained_per_partition) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, capacity_class) DO NOTHING",
        [
          this.#config.namespace,
          policy.id,
          policy.maxRetainedRequests,
          policy.maxRetainedRequestsPerPartition,
        ],
      );
    }
    const rows = await tx.unsafe<Row>(
      "SELECT capacity_class, max_retained_requests, max_retained_per_partition FROM public.auggy_coordination_request_class_counters WHERE namespace = $1 ORDER BY capacity_class FOR UPDATE",
      [this.#config.namespace],
    );
    if (
      rows.length !== policies.length ||
      rows.some((row, index) => {
        const policy = policies[index];
        return (
          !policy ||
          text(row, "capacity_class") !== policy.id ||
          number(row, "max_retained_requests") !== policy.maxRetainedRequests ||
          number(row, "max_retained_per_partition") !== policy.maxRetainedRequestsPerPartition
        );
      })
    ) {
      throw new Error("coordinator retained request partition mismatch");
    }
  }

  /** Fail closed if durable counters and the retained ledger ever diverge. */
  async verifyRequestCapacityCounters(tx: SqlTransaction): Promise<void> {
    const classes = await tx.unsafe<Row>(
      "SELECT counter.capacity_class, counter.retained_count, counter.max_retained_requests, (SELECT count(*)::integer FROM public.auggy_coordination_requests request WHERE request.namespace = counter.namespace AND request.capacity_class = counter.capacity_class) AS actual_count FROM public.auggy_coordination_request_class_counters counter WHERE counter.namespace = $1 ORDER BY counter.capacity_class FOR UPDATE",
      [this.#config.namespace],
    );
    if (
      classes.some(
        (row) =>
          number(row, "retained_count") !== number(row, "actual_count") ||
          number(row, "retained_count") > number(row, "max_retained_requests"),
      )
    ) {
      throw new Error("coordinator retained request counter mismatch");
    }
    const inconsistentPartitions = await tx.unsafe<Row>(
      "SELECT counter.capacity_class FROM public.auggy_coordination_request_partition_counters counter WHERE counter.namespace = $1 AND (counter.retained_count <= 0 OR counter.retained_count > COALESCE((SELECT class_counter.max_retained_per_partition FROM public.auggy_coordination_request_class_counters class_counter WHERE class_counter.namespace = counter.namespace AND class_counter.capacity_class = counter.capacity_class), -1) OR counter.retained_count <> (SELECT count(*)::integer FROM public.auggy_coordination_requests request WHERE request.namespace = counter.namespace AND request.capacity_class = counter.capacity_class AND request.capacity_partition_hash = counter.partition_hash)) LIMIT 1 FOR UPDATE",
      [this.#config.namespace],
    );
    const orphanedRequests = await tx.unsafe<Row>(
      "SELECT request.request_id FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.capacity_class IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM public.auggy_coordination_request_class_counters class_counter WHERE class_counter.namespace = request.namespace AND class_counter.capacity_class = request.capacity_class) OR NOT EXISTS (SELECT 1 FROM public.auggy_coordination_request_partition_counters partition_counter WHERE partition_counter.namespace = request.namespace AND partition_counter.capacity_class = request.capacity_class AND partition_counter.partition_hash = request.capacity_partition_hash)) LIMIT 1",
      [this.#config.namespace],
    );
    if (inconsistentPartitions[0] || orphanedRequests[0]) {
      throw new Error("coordinator retained request counter mismatch");
    }
  }

  /** Locks the bounded counter rows without mutating them so later rejection remains side-effect free. */
  async lockAvailableRequestCapacity(
    tx: SqlTransaction,
    policy: DistributedCapacityClassPolicy,
    partitionHash: string,
  ): Promise<boolean> {
    const classes = await tx.unsafe<Row>(
      "SELECT max_retained_requests, max_retained_per_partition, retained_count FROM public.auggy_coordination_request_class_counters WHERE namespace = $1 AND capacity_class = $2 FOR UPDATE",
      [this.#config.namespace, policy.id],
    );
    const capacityClass = classes[0];
    if (
      !capacityClass ||
      number(capacityClass, "max_retained_requests") !== policy.maxRetainedRequests ||
      number(capacityClass, "max_retained_per_partition") !== policy.maxRetainedRequestsPerPartition
    ) {
      throw new Error("coordinator retained request partition mismatch");
    }
    if (number(capacityClass, "retained_count") >= policy.maxRetainedRequests) return false;
    const partitions = await tx.unsafe<Row>(
      "SELECT retained_count FROM public.auggy_coordination_request_partition_counters WHERE namespace = $1 AND capacity_class = $2 AND partition_hash = $3 FOR UPDATE",
      [this.#config.namespace, policy.id, partitionHash],
    );
    return (
      !partitions[0] ||
      number(partitions[0], "retained_count") < policy.maxRetainedRequestsPerPartition
    );
  }

  /** Consumes a previously locked retained-request slot in the admission transaction. */
  async reserveRequestCapacitySlot(
    tx: SqlTransaction,
    policy: DistributedCapacityClassPolicy,
    partitionHash: string,
  ): Promise<void> {
    const capacityClass = await tx.unsafe<Row>(
      "UPDATE public.auggy_coordination_request_class_counters SET retained_count = retained_count + 1, updated_at = clock_timestamp() WHERE namespace = $1 AND capacity_class = $2 AND max_retained_requests = $3 AND max_retained_per_partition = $4 AND retained_count < max_retained_requests RETURNING capacity_class",
      [
        this.#config.namespace,
        policy.id,
        policy.maxRetainedRequests,
        policy.maxRetainedRequestsPerPartition,
      ],
    );
    if (!capacityClass[0]) throw new Error("coordinator retained request counter mismatch");
    const partition = await tx.unsafe<Row>(
      "INSERT INTO public.auggy_coordination_request_partition_counters (namespace, capacity_class, partition_hash, retained_count) VALUES ($1, $2, $3, 1) ON CONFLICT (namespace, capacity_class, partition_hash) DO UPDATE SET retained_count = auggy_coordination_request_partition_counters.retained_count + 1, updated_at = clock_timestamp() WHERE auggy_coordination_request_partition_counters.retained_count < $4 RETURNING capacity_class",
      [this.#config.namespace, policy.id, partitionHash, policy.maxRetainedRequestsPerPartition],
    );
    if (!partition[0]) throw new Error("coordinator retained request counter mismatch");
  }

  /** Releases retained-request slots in the same transaction that prunes their ledger rows. */
  async releaseRequestCapacitySlots(tx: SqlTransaction, deleted: readonly Row[]): Promise<void> {
    const classes = new Map<string, { count: number; partitions: Map<string, number> }>();
    for (const row of deleted) {
      const capacityClass = nullableText(row, "capacity_class");
      const partitionHash = nullableText(row, "capacity_partition_hash");
      if (capacityClass === null && partitionHash === null) continue;
      if (capacityClass === null || partitionHash === null) {
        throw new Error("coordinator retained request counter mismatch");
      }
      const entry = classes.get(capacityClass) ?? { count: 0, partitions: new Map() };
      entry.count += 1;
      entry.partitions.set(partitionHash, (entry.partitions.get(partitionHash) ?? 0) + 1);
      classes.set(capacityClass, entry);
    }
    for (const [capacityClass, release] of [...classes].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const updatedClass = await tx.unsafe<Row>(
        "UPDATE public.auggy_coordination_request_class_counters SET retained_count = retained_count - $3, updated_at = clock_timestamp() WHERE namespace = $1 AND capacity_class = $2 AND retained_count >= $3 RETURNING capacity_class",
        [this.#config.namespace, capacityClass, release.count],
      );
      if (!updatedClass[0]) throw new Error("coordinator retained request counter mismatch");
      for (const [partitionHash, count] of [...release.partitions].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const updatedPartition = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_request_partition_counters SET retained_count = retained_count - $4, updated_at = clock_timestamp() WHERE namespace = $1 AND capacity_class = $2 AND partition_hash = $3 AND retained_count >= $4 RETURNING retained_count",
          [this.#config.namespace, capacityClass, partitionHash, count],
        );
        const row = updatedPartition[0];
        if (!row) throw new Error("coordinator retained request counter mismatch");
        if (number(row, "retained_count") === 0) {
          const removed = await tx.unsafe<Row>(
            "DELETE FROM public.auggy_coordination_request_partition_counters WHERE namespace = $1 AND capacity_class = $2 AND partition_hash = $3 AND retained_count = 0 RETURNING capacity_class",
            [this.#config.namespace, capacityClass, partitionHash],
          );
          if (!removed[0]) throw new Error("coordinator retained request counter mismatch");
        }
      }
    }
  }

  /** Provision immutable per-policy evidence partitions while the namespace row is locked. */
  async provisionRateCounters(tx: SqlTransaction): Promise<void> {
    const policies = [...normalizedAdmission(this.#config).rateLimits].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const policy of policies) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_rate_counters (namespace, policy_id, max_events) VALUES ($1, $2, $3) ON CONFLICT (namespace, policy_id) DO NOTHING",
        [this.#config.namespace, policy.id, policy.maxEvents],
      );
    }
    const rows = await tx.unsafe<Row>(
      "SELECT policy_id, max_events FROM public.auggy_coordination_rate_counters WHERE namespace = $1 ORDER BY policy_id FOR UPDATE",
      [this.#config.namespace],
    );
    if (
      rows.length !== policies.length ||
      rows.some((row, index) => {
        const policy = policies[index];
        return (
          !policy ||
          text(row, "policy_id") !== policy.id ||
          number(row, "max_events") !== policy.maxEvents
        );
      })
    ) {
      throw new Error("coordinator rate evidence partition mismatch");
    }
  }

  async provisionSources(tx: SqlTransaction): Promise<void> {
    for (const source of this.#config.sources) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_sources (namespace, source_id, max_concurrent, max_queued) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, source_id) DO NOTHING",
        [this.#config.namespace, source.id, source.maxConcurrent, source.maxQueued],
      );
    }
    const rows = await tx.unsafe<Row>(
      "SELECT source_id, max_concurrent, max_queued FROM public.auggy_coordination_sources WHERE namespace = $1 ORDER BY source_id FOR UPDATE",
      [this.#config.namespace],
    );
    const expected = [...this.#config.sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (
      rows.length !== expected.length ||
      rows.some((row, index) => {
        const source = expected[index];
        return (
          !source ||
          text(row, "source_id") !== source.id ||
          number(row, "max_concurrent") !== source.maxConcurrent ||
          number(row, "max_queued") !== source.maxQueued
        );
      })
    ) {
      throw new Error("coordinator source policy mismatch");
    }
  }

  /** Trusted runtime integration provisions immutable source policy per namespace. */
  async sourcePolicy(
    tx: SqlTransaction,
    incoming: DistributedTurnRequest["source"],
  ): Promise<DistributedTurnRequest["source"]> {
    const rows = await tx.unsafe<Row>(
      "SELECT source_id, max_concurrent, max_queued FROM public.auggy_coordination_sources WHERE namespace = $1 AND source_id = $2",
      [this.#config.namespace, incoming.id],
    );
    const row = rows[0];
    if (!row) throw new Error("missing source policy row");
    const stored = {
      id: text(row, "source_id"),
      maxConcurrent: number(row, "max_concurrent"),
      maxQueued: number(row, "max_queued"),
    };
    if (
      stored.maxConcurrent !== incoming.maxConcurrent ||
      stored.maxQueued !== incoming.maxQueued
    ) {
      throw new Error("coordinator source policy mismatch");
    }
    return stored;
  }

  async lockRatePolicies(tx: SqlTransaction, policyIds: readonly string[]): Promise<void> {
    const configured = new Map(
      normalizedAdmission(this.#config).rateLimits.map((policy) => [policy.id, policy]),
    );
    for (const policyId of [...new Set(policyIds)].sort()) {
      const policy = configured.get(policyId);
      if (!policy) throw new Error("coordinator rate policy is unavailable");
      const rows = await tx.unsafe<Row>(
        "SELECT max_events FROM public.auggy_coordination_rate_counters WHERE namespace = $1 AND policy_id = $2 FOR UPDATE",
        [this.#config.namespace, policyId],
      );
      if (!rows[0] || number(rows[0], "max_events") !== policy.maxEvents) {
        throw new Error("coordinator rate evidence partition mismatch");
      }
    }
  }

  async cleanupExpiredRateEvents(tx: SqlTransaction, policyIds: readonly string[]): Promise<void> {
    for (const policyId of [...new Set(policyIds)].sort()) {
      const rows = await tx.unsafe<Row>(
        "WITH victims AS (SELECT namespace, policy_id, subject_hash, request_id FROM public.auggy_coordination_rate_events WHERE namespace = $1 AND policy_id = $2 AND expires_at <= clock_timestamp() ORDER BY expires_at, subject_hash, request_id LIMIT 1000), deleted AS (DELETE FROM public.auggy_coordination_rate_events event USING victims WHERE event.namespace = victims.namespace AND event.policy_id = victims.policy_id AND event.subject_hash = victims.subject_hash AND event.request_id = victims.request_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
        [this.#config.namespace, policyId],
      );
      const deleted = number(rows[0]!, "count");
      if (deleted > 0) await this.releaseRateEventSlots(tx, [{ policyId, count: deleted }]);
    }
  }

  async verifyRateEvidenceCounter(tx: SqlTransaction): Promise<void> {
    const rows = await tx.unsafe<Row>(
      "SELECT counter.policy_id, counter.event_count, counter.max_events, (SELECT count(*)::integer FROM public.auggy_coordination_rate_events event WHERE event.namespace = counter.namespace AND event.policy_id = counter.policy_id) AS actual_count FROM public.auggy_coordination_rate_counters counter WHERE counter.namespace = $1 ORDER BY counter.policy_id FOR UPDATE",
      [this.#config.namespace],
    );
    if (
      rows.some(
        (row) =>
          number(row, "event_count") !== number(row, "actual_count") ||
          number(row, "event_count") > number(row, "max_events"),
      )
    ) {
      throw new Error("coordinator rate evidence counter mismatch");
    }
    const orphaned = await tx.unsafe<Row>(
      "SELECT count(*)::integer AS count FROM public.auggy_coordination_rate_events event WHERE event.namespace = $1 AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_rate_counters counter WHERE counter.namespace = event.namespace AND counter.policy_id = event.policy_id)",
      [this.#config.namespace],
    );
    if (number(orphaned[0]!, "count") !== 0) {
      throw new Error("coordinator rate evidence counter mismatch");
    }
  }

  async verifyBudgetEvidence(tx: SqlTransaction): Promise<void> {
    const policies = normalizedBudgets(this.#config).policies;
    const rows = await tx.unsafe<Row>(
      "SELECT policy_id, (SELECT count(*)::integer FROM public.auggy_coordination_budget_reservations reservation WHERE reservation.namespace = $1 AND reservation.policy_id = policy.policy_id) AS reservations, (SELECT count(*)::integer FROM public.auggy_coordination_budget_anonymous_events event WHERE event.namespace = $1 AND event.policy_id = policy.policy_id) AS anonymous_events, (SELECT count(*)::integer FROM public.auggy_coordination_budget_daily daily WHERE daily.namespace = $1 AND daily.policy_id = policy.policy_id AND daily.subject_kind = 'peer') AS peer_days, (SELECT count(*)::integer FROM public.auggy_coordination_budget_threshold_intents intent WHERE intent.namespace = $1 AND intent.policy_id = policy.policy_id) AS threshold_intents FROM (SELECT DISTINCT policy_id FROM public.auggy_coordination_budget_reservations WHERE namespace = $1 UNION SELECT DISTINCT policy_id FROM public.auggy_coordination_budget_anonymous_events WHERE namespace = $1 UNION SELECT DISTINCT policy_id FROM public.auggy_coordination_budget_daily WHERE namespace = $1 UNION SELECT DISTINCT policy_id FROM public.auggy_coordination_budget_threshold_intents WHERE namespace = $1) policy ORDER BY policy_id",
      [this.#config.namespace],
    );
    const expected = new Map(policies.map((policy) => [policy.id, policy]));
    for (const row of rows) {
      const policy = expected.get(text(row, "policy_id"));
      if (
        !policy ||
        number(row, "reservations") > policy.maxReservations ||
        number(row, "anonymous_events") > policy.maxAnonymousEvents ||
        number(row, "peer_days") > policy.maxPeerDays ||
        number(row, "threshold_intents") > policy.maxThresholdIntents
      ) {
        throw new Error("coordinator budget evidence exceeds immutable policy");
      }
    }
  }

  async reserveRateEventSlots(
    tx: SqlTransaction,
    reservations: readonly ResolvedAdmissionReservation[],
  ): Promise<boolean> {
    for (const reservation of reservations) {
      const rows = await tx.unsafe<Row>(
        "SELECT event_count, max_events FROM public.auggy_coordination_rate_counters WHERE namespace = $1 AND policy_id = $2 FOR UPDATE",
        [this.#config.namespace, reservation.policyId],
      );
      if (
        !rows[0] ||
        number(rows[0], "max_events") !== reservation.maxEvents ||
        number(rows[0], "event_count") >= reservation.maxEvents
      ) {
        return false;
      }
    }
    for (const reservation of reservations) {
      const updated = await tx.unsafe<Row>(
        "UPDATE public.auggy_coordination_rate_counters SET event_count = event_count + 1, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND event_count < max_events RETURNING policy_id",
        [this.#config.namespace, reservation.policyId],
      );
      if (!updated[0]) throw new Error("coordinator rate evidence counter mismatch");
    }
    return true;
  }

  async releaseRateEventSlots(
    tx: SqlTransaction,
    releases: readonly { policyId: string; count: number }[],
  ): Promise<void> {
    for (const release of releases) {
      if (release.count < 1) continue;
      const updated = await tx.unsafe<Row>(
        "UPDATE public.auggy_coordination_rate_counters SET event_count = event_count - $3, updated_at = clock_timestamp() WHERE namespace = $1 AND policy_id = $2 AND event_count >= $3 RETURNING policy_id",
        [this.#config.namespace, release.policyId, release.count],
      );
      if (!updated[0]) throw new Error("coordinator rate evidence counter mismatch");
    }
  }

  async #expireActive(tx: SqlTransaction): Promise<void> {
    const expired = await tx.unsafe<Row>(
      "UPDATE public.auggy_coordination_requests SET state = CASE WHEN execution_started_at IS NULL THEN 'queued' ELSE 'outcome_unknown' END, queue_owner_instance = CASE WHEN execution_started_at IS NULL THEN owner_instance ELSE NULL END, queue_owner_session = CASE WHEN execution_started_at IS NULL THEN owner_session ELSE NULL END, queue_generation = CASE WHEN execution_started_at IS NULL THEN queue_generation + 1 ELSE queue_generation END, queue_expires_at = CASE WHEN execution_started_at IS NULL THEN clock_timestamp() ELSE NULL END, fence = CASE WHEN execution_started_at IS NULL THEN NULL ELSE fence END, owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, terminal_at = CASE WHEN execution_started_at IS NULL THEN NULL ELSE clock_timestamp() END, updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'active' AND lease_expires_at <= clock_timestamp() RETURNING request_id, thread_id, source_id, fence, execution_started_at, queue_generation",
      [this.#config.namespace],
    );
    for (const row of expired) {
      if (row.execution_started_at === null) {
        await this.releaseBudgetReservationsForRequest(
          tx,
          text(row, "request_id"),
          number(row, "queue_generation") - 1,
        );
        continue;
      }
      const lease: DistributedTurnLease = {
        namespace: this.#config.namespace,
        requestId: text(row, "request_id"),
        threadId: text(row, "thread_id"),
        sourceId: text(row, "source_id"),
        instanceId: this.#config.instanceId,
        attempt: number(row, "queue_generation"),
        fence: number(row, "fence"),
        expiresAt: 0,
      };
      await this.settleBudgetAccounting(
        tx,
        lease,
        missingUsageAccountingMarkers(this.#config.namespace, lease),
        "outcome_unknown",
      );
      await this.recordQuarantine(
        tx,
        text(row, "thread_id"),
        text(row, "request_id"),
        number(row, "fence"),
        "lease-lost",
      );
    }
  }

  async recordQuarantine(
    tx: SqlTransaction,
    threadId: string,
    requestId: string,
    fence: number,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<void> {
    await tx.unsafe(
      "UPDATE public.auggy_coordination_threads SET quarantined = TRUE, quarantine_fence = $3, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
      [this.#config.namespace, threadId, fence],
    );
    await tx.unsafe(
      "INSERT INTO public.auggy_coordination_events (namespace, thread_id, request_id, fence, event_type, reason) VALUES ($1, $2, $3, $4, 'outcome_unknown', $5)",
      [this.#config.namespace, threadId, requestId, fence, reasonCode],
    );
  }

  async #cancelExpiredQueued(tx: SqlTransaction, exceptRequestId?: string): Promise<void> {
    await tx.unsafe(
      "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'queued' AND queue_expires_at <= clock_timestamp() AND ($2::text IS NULL OR request_id <> $2)",
      [this.#config.namespace, exceptRequestId ?? null],
    );
  }

  async updateLease(
    lease: DistributedTurnLease,
    set: string,
    values: unknown[],
  ): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          `UPDATE public.auggy_coordination_requests SET ${set} WHERE namespace = $${values.length + 1} AND request_id = $${values.length + 2} AND thread_id = $${values.length + 3} AND source_id = $${values.length + 4} AND state = 'active' AND queue_generation = $${values.length + 5} AND fence = $${values.length + 6} AND owner_instance = $${values.length + 7} AND owner_session = $${values.length + 8} AND lease_expires_at > clock_timestamp() RETURNING request_id`,
          [
            ...values,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
  }

  lease(
    request: DistributedTurnRequest,
    attempt: number,
    fence: number,
    expiresAt: number,
  ): DistributedTurnLease {
    return {
      namespace: this.#config.namespace,
      requestId: request.requestId,
      threadId: request.threadId,
      sourceId: request.source.id,
      instanceId: this.#config.instanceId,
      attempt,
      fence,
      expiresAt,
    };
  }

  validLease(lease: DistributedTurnLease): boolean {
    return (
      lease.namespace === this.#config.namespace &&
      lease.instanceId === this.#config.instanceId &&
      Number.isSafeInteger(lease.attempt) &&
      lease.attempt > 0 &&
      Number.isSafeInteger(lease.fence) &&
      lease.fence > 0 &&
      (() => {
        try {
          assertIdentifier("requestId", lease.requestId);
          assertIdentifier("threadId", lease.threadId);
          assertIdentifier("sourceId", lease.sourceId);
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  trackOwned(
    request: DistributedTurnRequest,
    phase: LocalOwnedOperation["phase"],
    attempt: number,
  ): void {
    if (this.#invalidated) return;
    const existing = this.#owned.get(request.requestId);
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.bindingHash === request.bindingHash &&
      existing.admissionHash === requestAdmissionHash(request) &&
      existing.threadId === request.threadId &&
      existing.sourceId === request.source.id
    ) {
      existing.phase = phase;
      existing.attempt = attempt;
      return;
    }
    existing?.controller.abort("ownership-replaced");
    this.#owned.set(request.requestId, {
      admissionHash: requestAdmissionHash(request),
      attempt,
      bindingHash: request.bindingHash,
      controller: new AbortController(),
      phase,
      sourceId: request.source.id,
      threadId: request.threadId,
    });
  }

  abortOwned(requestId: string, reason: string): void {
    const operation = this.#owned.get(requestId);
    if (!operation) return;
    operation.controller.abort(reason);
    this.#owned.delete(requestId);
  }

  abortOwnedPhase(phase: LocalOwnedOperation["phase"], reason: string): void {
    for (const [requestId, operation] of this.#owned) {
      if (operation.phase === phase) this.abortOwned(requestId, reason);
    }
  }

  abortOwnedAttempt(requestId: string, attempt: number, reason: string): void {
    const operation = this.#owned.get(requestId);
    if (operation?.attempt === attempt) {
      this.abortOwned(requestId, reason);
    }
  }

  abortAllOwned(reason: string): void {
    for (const requestId of [...this.#owned.keys()]) this.abortOwned(requestId, reason);
  }

  unavailableSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort("not-owned");
    return controller.signal;
  }

  async transaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      // With pg_catalog omitted, PostgreSQL searches it implicitly before the
      // fixed schema. A role- or URL-supplied search_path cannot shadow either
      // built-in functions or coordination relations for this transaction.
      await tx.unsafe("SET LOCAL search_path TO public");
      return callback(tx);
    });
  }

  async safe<T>(
    fallback: T,
    callback: () => Promise<T>,
    observe?: (result: T) => void,
    allowAfterInvalidation = false,
  ): Promise<T> {
    if (this.#invalidated && !allowAfterInvalidation) {
      observe?.(fallback);
      return fallback;
    }
    try {
      const result = await callback();
      observe?.(result);
      return result;
    } catch {
      observe?.(fallback);
      return fallback;
    }
  }
}

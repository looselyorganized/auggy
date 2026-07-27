/**
 * Durable, fenced admission for a single logical agent. The coordinator stores
 * identifiers and one-way request binding hashes in its control plane. Durable
 * history, replay, and outbox records are a separate bounded data plane and may
 * contain conversation content and delivery routing. Callers must never put
 * credentials or raw provider failures in either plane.
 */
import type {
  DistributedAdmissionCapacityV1,
  DistributedAdmissionPolicyRequirementsV1,
  DistributedAdmissionReservationV1,
  DistributedCoordinationResultConfig,
  DistributedCoordinationRetentionConfig,
  DistributedCoordinationTurnStateConfig,
} from "../types";

export type CoordinationRequestState =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export interface DistributedSourcePolicy {
  id: string;
  maxConcurrent: number;
  maxQueued: number;
}

export interface DistributedCoordinatorConfig {
  /** Stable, server-controlled identity of the logical agent deployment. */
  namespace: string;
  /** Fresh random id generated for each process start, never a hostname. */
  instanceId: string;
  /**
   * Secret-free digest of the exact running build, for fleet diagnostics.
   * Protocol/configuration fingerprints—not build equality—are compatibility authority.
   */
  buildFingerprint: string;
  maxConcurrent: number;
  maxQueued: number;
  /** Maximum waiting requests for one canonical thread. */
  maxQueuedPerThread: number;
  leaseMs: number;
  /** Trusted source policies are provisioned at registration, never from a request. */
  sources: readonly DistributedSourcePolicy[];
  retention: DistributedCoordinationRetentionConfig;
  result: DistributedCoordinationResultConfig;
  turnState: DistributedCoordinationTurnStateConfig;
  /**
   * Immutable database-time rate policies. Omission is the protocol-v5
   * compatibility shape and permits no distributed rate reservations.
   */
  admission?: DistributedAdmissionConfig;
  compatibility: DistributedCoordinatorCompatibility;
}

export interface DistributedRateLimitPolicy {
  id: string;
  max: number;
  /** Isolated evidence capacity for this policy within the namespace-wide bound. */
  maxEvents: number;
  windowMs: number;
}

export interface DistributedAdmissionConfig {
  /** Hard bound for the sum of every policy's isolated evidence capacity. */
  maxRateLimitEvents: number;
  capacityClasses?: readonly DistributedCapacityClassPolicy[];
  rateLimits: readonly DistributedRateLimitPolicy[];
}

export interface DistributedCapacityClassPolicy {
  id: string;
  maxRetainedRequests: number;
  maxRetainedRequestsPerPartition: number;
}

export type DistributedAdmissionReservation = DistributedAdmissionReservationV1;
export type DistributedAdmissionCapacity = DistributedAdmissionCapacityV1;

export interface DistributedCoordinatorCompatibilityTuple {
  protocolVersion: number;
  protocolFingerprint: string;
  configurationFingerprint: string;
}

export interface DistributedCoordinatorCompatibility
  extends DistributedCoordinatorCompatibilityTuple {
  /** One code-owned predecessor accepted only for a quiescent atomic upgrade. */
  upgradeFrom?: DistributedCoordinatorCompatibilityTuple;
}

export interface DistributedTurnRequest {
  requestId: string;
  threadId: string;
  source: DistributedSourcePolicy;
  /** SHA-256 (or equivalent) of canonical trusted request identity/body. */
  bindingHash: string;
  /** Trusted retained-request partition, required when capacity classes are configured. */
  capacity?: DistributedAdmissionCapacity;
  /** Bounded quota subjects selected by trusted source code, never a client. */
  admission?: readonly DistributedAdmissionReservation[];
}

export type DistributedTurnRequestIdentity = Pick<
  DistributedTurnRequest,
  "requestId" | "threadId" | "source" | "bindingHash" | "capacity" | "admission"
>;

export interface DistributedRateReservationRequest {
  reservationId: string;
  admission: readonly DistributedAdmissionReservation[];
}

export type DistributedRateReservationResult =
  | { status: "reserved" }
  | { status: "replayed" }
  | { status: "conflict" }
  | {
      status: "rejected";
      reason: "admission-capacity" | "invalid-admission" | "rate-limited" | "draining";
      retryAfterMs?: number;
    }
  | { status: "unavailable" };

export interface DistributedTurnLease {
  namespace: string;
  requestId: string;
  threadId: string;
  sourceId: string;
  instanceId: string;
  /** Monotonic queue-owner generation. Adoption always creates a new attempt. */
  attempt: number;
  /** Monotonically increasing per-thread fencing token. */
  fence: number;
  expiresAt: number;
}

export interface DistributedReplayResult {
  body: Uint8Array;
  contentType: "application/json";
}

/** Canonical, secret-free authorization binding for one durable thread. */
export interface DistributedPeerBindingV1 {
  version: 1;
  bindingHash: string;
  peerIdHash: string | null;
  promotionScopeHash: string;
  trustLevel: "creator" | "agent" | "public";
  publicSubstate?: "anonymous" | "recognized";
  /** Evidence for the one allowed anonymous-to-recognized identity transition. */
  priorPeerIdHash?: string;
}

export interface DistributedHistorySnapshotV1 {
  version: 1;
  body: Uint8Array;
  messageCount: number;
}

export type DistributedHistoryLoadResult =
  | ({ status: "ok"; revision: number } & DistributedHistorySnapshotV1)
  | { status: "denied" }
  | { status: "rejected"; reason: "history-capacity" | "invalid-peer-binding" }
  | { status: "stale" }
  | { status: "unavailable" };

export type DistributedCostMarkerV1 =
  | {
      version: 1;
      operationId: string;
      priced: true;
      costUsd: number;
    }
  | {
      version: 1;
      operationId: string;
      priced: false;
      reason: "missing-usage" | "missing-pricing";
    };

export interface DistributedOutboxIntentV1 {
  version: 1;
  ordinal: number;
  operationId: string;
  body: Uint8Array;
  contentType: "application/json";
}

export interface DistributedTurnCheckpointV1 {
  peerBinding: DistributedPeerBindingV1;
  expectedHistoryRevision: number;
  history: DistributedHistorySnapshotV1;
  replay: DistributedReplayResult;
  costMarkers: readonly DistributedCostMarkerV1[];
  outboxIntents: readonly DistributedOutboxIntentV1[];
}

export type AdmitResult =
  | { status: "admitted"; attempt: number }
  | { status: "adopted"; attempt: number }
  | { status: "joined"; state: CoordinationRequestState }
  | {
      status: "rejected";
      reason:
        | "global-capacity"
        | "incident-capacity"
        | "source-capacity"
        | "thread-capacity"
        | "thread-quarantined"
        | "request-capacity"
        | "admission-capacity"
        | "invalid-admission"
        | "rate-limited"
        | "draining";
      retryAfterMs?: number;
    }
  | { status: "conflict" }
  | { status: "unavailable" };

export type ClaimResult =
  | { status: "acquired"; lease: DistributedTurnLease }
  | { status: "waiting" }
  | { status: "terminal"; state: Exclude<CoordinationRequestState, "queued" | "active"> }
  | { status: "quarantined" }
  | { status: "conflict" }
  | { status: "stale" }
  | { status: "unavailable" };

export type LeaseResult =
  | { status: "ok"; lease?: DistributedTurnLease }
  | { status: "outcome-unknown" }
  | {
      status: "rejected";
      reason:
        | "atomic-turn-state-required"
        | "history-too-large"
        | "invalid-history"
        | "invalid-result"
        | "invalid-turn-state"
        | "outbox-capacity"
        | "result-too-large";
    }
  | { status: "stale" }
  | { status: "unavailable" };

export type DistributedRequestStatus =
  | { status: "missing" }
  | { status: "conflict" }
  | { status: "pending"; state: "queued" | "active" }
  | { status: "terminal"; state: "failed" | "canceled" }
  | { status: "completed"; result: DistributedReplayResult }
  | { status: "quarantined" }
  | { status: "wait-aborted" }
  | { status: "wait-timeout" }
  | { status: "unavailable" };

export interface DistributedWaitOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  pollMs: number;
}

export interface DistributedCoordinationEvent {
  createdAt: string;
  eventId: string;
  eventType: "operator_recovery" | "outcome_unknown";
  fence?: number;
  reasonCode: string;
  requestId?: string;
  threadId: string;
}

export type DistributedEventPage =
  | { status: "ok"; events: DistributedCoordinationEvent[]; nextEventId?: string }
  | { status: "unavailable" };

export type DistributedPruneResult =
  | {
      status: "ok";
      events: number;
      instances: number;
      requests: number;
      threads: number;
    }
  | { status: "unavailable" };

export type CoordinationOutcomeUnknownReason =
  | "coordinator-unavailable"
  | "effect-outcome-unknown"
  | "execution-failed-after-start"
  | "lease-lost";

export type RegistrationResult =
  | { status: "registered" }
  | { status: "conflict" }
  | { status: "unavailable" };

export interface DistributedCoordinatorHealth {
  status: "healthy" | "draining" | "unavailable";
  active: number;
  queued: number;
  quarantined: number;
}

export interface DistributedTurnCoordinator {
  /** Establish one one-use process incarnation before any other operation. */
  register(): Promise<RegistrationResult>;
  heartbeatInstance(): Promise<LeaseResult>;
  admit(request: DistributedTurnRequest): Promise<AdmitResult>;
  /** Atomically reserve fleet rate evidence for a non-turn trusted route. */
  reserveRateLimits(
    request: DistributedRateReservationRequest,
  ): Promise<DistributedRateReservationResult>;
  /** Local immutable-policy check; registration makes the namespace fingerprint authoritative. */
  supportsAdmissionPolicy(requirements: DistributedAdmissionPolicyRequirementsV1): boolean;
  heartbeatQueued(
    request: DistributedTurnRequestIdentity,
    /** Omission is compatible only with the initial generation (attempt 1). */
    attempt?: number,
  ): Promise<LeaseResult>;
  abandon(
    request: DistributedTurnRequestIdentity,
    /**
     * Terminalize the matching locally owned attempt while it is queued or
     * active but has not crossed the execution-start marker. Omission is
     * compatible only with the initial generation (attempt 1).
     */
    attempt?: number,
  ): Promise<LeaseResult>;
  claim(request: DistributedTurnRequest, attempt?: number): Promise<ClaimResult>;
  /**
   * Cooperative local cancellation for the currently owned queue/lease.
   * Database ownership and fencing remain authoritative.
   */
  ownedSignal(request: DistributedTurnRequestIdentity): AbortSignal;
  /**
   * Synchronously revoke this process incarnation after an authority watchdog
   * expires. This performs no database I/O and cannot be reversed.
   */
  invalidateLocalAuthority(reason: "heartbeat-deadline" | "runtime-stopping"): void;
  /** Must be called immediately before work that could cause an external effect. */
  markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult>;
  heartbeat(lease: DistributedTurnLease): Promise<LeaseResult>;
  /** Claim one peer-bound history revision before model invocation. */
  loadHistory(
    lease: DistributedTurnLease,
    peerBinding: DistributedPeerBindingV1,
  ): Promise<DistributedHistoryLoadResult>;
  /** Atomically commit every durable effect of one fenced root turn. */
  commitTurn(
    lease: DistributedTurnLease,
    checkpoint: DistributedTurnCheckpointV1,
  ): Promise<LeaseResult>;
  /** Legacy pre-v5 result completion. Protocol v5 and later reject this path. */
  complete(lease: DistributedTurnLease, result: DistributedReplayResult): Promise<LeaseResult>;
  fail(lease: DistributedTurnLease): Promise<LeaseResult>;
  markOutcomeUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<LeaseResult>;
  status(request: DistributedTurnRequestIdentity): Promise<DistributedRequestStatus>;
  wait(
    request: DistributedTurnRequestIdentity,
    options: DistributedWaitOptions,
  ): Promise<DistributedRequestStatus>;
  events(options: { afterEventId?: string; limit: number }): Promise<DistributedEventPage>;
  prune(batchSize: number): Promise<DistributedPruneResult>;
  /**
   * Recovery is a deliberate compare-and-set. It only clears a durable
   * outcome-unknown quarantine when the caller supplies the observed fence.
   */
  /** Does not fence a non-cooperative external worker; terminate it before recovery. */
  recover(threadId: string, expectedFence: number, reason: string): Promise<LeaseResult>;
  beginDrain(): Promise<LeaseResult>;
  health(): Promise<DistributedCoordinatorHealth>;
  close(): Promise<void>;
}

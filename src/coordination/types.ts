/**
 * Durable, fenced admission for a single logical agent. The coordinator stores
 * identifiers, a one-way request binding hash, and one bounded sanitized replay
 * result. Callers must never put prompts, peer data, credentials, or raw
 * provider failures in these records.
 */
import type {
  DistributedCoordinationResultConfig,
  DistributedCoordinationRetentionConfig,
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
  compatibility: DistributedCoordinatorCompatibility;
}

export interface DistributedCoordinatorCompatibility {
  protocolVersion: number;
  protocolFingerprint: string;
  configurationFingerprint: string;
}

export interface DistributedTurnRequest {
  requestId: string;
  threadId: string;
  source: DistributedSourcePolicy;
  /** SHA-256 (or equivalent) of canonical trusted request identity/body. */
  bindingHash: string;
}

export interface DistributedTurnLease {
  namespace: string;
  requestId: string;
  threadId: string;
  sourceId: string;
  instanceId: string;
  /** Monotonically increasing per-thread fencing token. */
  fence: number;
  expiresAt: number;
}

export interface DistributedReplayResult {
  body: Uint8Array;
  contentType: "application/json";
}

export type AdmitResult =
  | { status: "admitted" }
  | { status: "adopted" }
  | { status: "joined"; state: CoordinationRequestState }
  | {
      status: "rejected";
      reason:
        | "global-capacity"
        | "incident-capacity"
        | "source-capacity"
        | "thread-capacity"
        | "thread-quarantined"
        | "draining";
    }
  | { status: "conflict" }
  | { status: "unavailable" };

export type ClaimResult =
  | { status: "acquired"; lease: DistributedTurnLease }
  | { status: "waiting" }
  | { status: "terminal"; state: Exclude<CoordinationRequestState, "queued" | "active"> }
  | { status: "quarantined" }
  | { status: "conflict" }
  | { status: "unavailable" };

export type LeaseResult =
  | { status: "ok"; lease?: DistributedTurnLease }
  | { status: "outcome-unknown" }
  | { status: "rejected"; reason: "invalid-result" | "result-too-large" }
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
  heartbeatQueued(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): Promise<LeaseResult>;
  abandon(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): Promise<LeaseResult>;
  claim(request: DistributedTurnRequest): Promise<ClaimResult>;
  /**
   * Cooperative local cancellation for the currently owned queue/lease.
   * Database ownership and fencing remain authoritative.
   */
  ownedSignal(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): AbortSignal;
  /** Must be called immediately before work that could cause an external effect. */
  markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult>;
  heartbeat(lease: DistributedTurnLease): Promise<LeaseResult>;
  complete(lease: DistributedTurnLease, result: DistributedReplayResult): Promise<LeaseResult>;
  fail(lease: DistributedTurnLease): Promise<LeaseResult>;
  markOutcomeUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<LeaseResult>;
  status(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): Promise<DistributedRequestStatus>;
  wait(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
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

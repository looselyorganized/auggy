/**
 * Durable, fenced admission for a single logical agent. The coordinator stores
 * identifiers and a one-way request binding hash only; callers must never put
 * prompt, peer, credential, or result content in these records.
 */
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
  maxConcurrent: number;
  maxQueued: number;
  /** Maximum waiting requests for one canonical thread. */
  maxQueuedPerThread: number;
  leaseMs: number;
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

export type AdmitResult =
  | { status: "admitted" }
  | { status: "joined"; state: CoordinationRequestState }
  | {
      status: "rejected";
      reason:
        | "global-capacity"
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
  | { status: "stale" }
  | { status: "unavailable" };

export interface DistributedCoordinatorHealth {
  status: "healthy" | "draining" | "unavailable";
  active: number;
  queued: number;
  quarantined: number;
}

export interface DistributedTurnCoordinator {
  admit(request: DistributedTurnRequest): Promise<AdmitResult>;
  claim(request: DistributedTurnRequest): Promise<ClaimResult>;
  /** Must be called immediately before work that could cause an external effect. */
  markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult>;
  heartbeat(lease: DistributedTurnLease): Promise<LeaseResult>;
  complete(lease: DistributedTurnLease): Promise<LeaseResult>;
  fail(lease: DistributedTurnLease): Promise<LeaseResult>;
  cancel(request: Pick<DistributedTurnRequest, "requestId" | "bindingHash">): Promise<LeaseResult>;
  /**
   * Recovery is a deliberate compare-and-set. It only clears a durable
   * outcome-unknown quarantine when the caller supplies the observed fence.
   */
  /** Does not fence a non-cooperative external worker; terminate it before recovery. */
  recover(threadId: string, expectedFence: number, reason: string): Promise<LeaseResult>;
  setDraining(draining: boolean): Promise<LeaseResult>;
  health(): Promise<DistributedCoordinatorHealth>;
}

/**
 * Narrow persistent boundary for one complete Auggy turn. The payload is
 * intentionally private: list operations never return it.
 */
export const DURABLE_JOB_PAYLOAD_VERSION = 1 as const;

export type DurableJobState =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export interface DurableJobPayload {
  version: typeof DURABLE_JOB_PAYLOAD_VERSION;
  /** Trusted application-defined data; never exposed from list(). */
  value: unknown;
}

export interface DurableJobSummary {
  id: string;
  state: DurableJobState;
  attempt: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  availableAt: number;
  cancelRequested: boolean;
  incident?: { id: string; version: number; reasonCode: string };
}

export interface DurableJobRecord extends DurableJobSummary {
  payload: DurableJobPayload;
  result?: unknown;
  errorCode?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DurableJobLease {
  job: DurableJobSummary;
  token: string;
  expiresAt: number;
}

export interface DurableJobStore {
  submit(input: {
    idempotencyKey: string;
    /** Canonical trusted binding; changing it for a reused key is rejected. */
    binding: unknown;
    payload: DurableJobPayload;
    availableAt?: number;
  }): { status: "created" | "joined"; job: DurableJobSummary };
  claim(input: { workerId: string; leaseMs: number }): DurableJobLease | null;
  markExecutionStarted(input: { jobId: string; token: string }): DurableJobSummary;
  heartbeat(input: { jobId: string; token: string; leaseMs: number }): DurableJobSummary;
  /** Requeues a fenced lease before execution was durably started. */
  releaseUnstarted(input: {
    jobId: string;
    token: string;
    errorCode: string;
    availableAt?: number;
  }): DurableJobSummary;
  complete(input: { jobId: string; token: string; result: unknown }): DurableJobSummary;
  failDefinite(input: {
    jobId: string;
    token: string;
    errorCode: string;
    retryAt?: number;
  }): DurableJobSummary;
  markOutcomeUnknown(input: {
    jobId: string;
    token: string;
    reasonCode: string;
  }): DurableJobSummary;
  cancel(input: { jobId: string; expectedVersion: number; reasonCode?: string }): {
    status: "canceled" | "cancellation_requested" | "unchanged" | "not_found" | "version_conflict";
    job?: DurableJobSummary;
  };
  recoverInterrupted(): { requeued: number; quarantined: number };
  reconcile(input: {
    jobId: string;
    expectedVersion: number;
    disposition: "retry" | "cancel" | "confirm_completed";
    evidence: string;
  }): { reconciled: boolean; job?: DurableJobSummary };
  get(jobId: string): DurableJobRecord | null;
  list(input?: { limit?: number; state?: DurableJobState }): DurableJobSummary[];
  prune(input?: { before?: number; limit?: number }): number;
  close(): void;
}

export interface SqliteDurableJobStoreOptions {
  dbPath: string;
  now?: () => number;
  jobId?: () => string;
  leaseToken?: () => string;
  incidentId?: () => string;
}

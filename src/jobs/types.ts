/**
 * Narrow persistent boundary for one complete Auggy turn. The payload is
 * intentionally private: list operations never return it.
 */
export const DURABLE_JOB_PAYLOAD_VERSION = 1 as const;

/**
 * Persisted error codes are deliberately closed. Callers must map private
 * provider or application failures to one of these stable, non-secret codes
 * before they reach the durable store.
 */
export const DURABLE_JOB_ERROR_CODES = [
  "admission-canceled",
  "admission-failed",
  "admission-rejected",
  "invalid-payload",
  "shutdown-before-execution",
  "execution-failed",
  "attempt-limit-exceeded",
] as const;

export type DurableJobErrorCode = (typeof DURABLE_JOB_ERROR_CODES)[number];

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
  payload: DurableJobPayload;
  token: string;
  expiresAt: number;
}

/**
 * Trusted declarative definition for a recurring complete turn. Binding and
 * payload are deliberately write-only: operator listings never expose them.
 */
export interface DurableJobScheduleDefinition {
  id: string;
  cron: string;
  binding: unknown;
  payload: DurableJobPayload;
  enabled?: boolean;
}

/** Redacted schedule state suitable for operator control output. */
export interface DurableJobScheduleSummary {
  id: string;
  cron: string;
  revision: number;
  version: number;
  configEnabled: boolean;
  operatorPaused: boolean;
  enabled: boolean;
  nextFireAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DurableScheduleMaterializationResult {
  materialized: number;
  /** Number of due schedules left untouched because the bounded tick ended. */
  remaining: number;
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
    errorCode: DurableJobErrorCode;
    availableAt?: number;
  }): DurableJobSummary;
  /** Terminally rejects a fenced lease before execution was durably started. */
  rejectUnstarted(input: {
    jobId: string;
    token: string;
    errorCode: DurableJobErrorCode;
  }): DurableJobSummary;
  complete(input: { jobId: string; token: string; result: unknown }): DurableJobSummary;
  failDefinite(input: {
    jobId: string;
    token: string;
    errorCode: DurableJobErrorCode;
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
  recoverExpiredLeases(): { requeued: number; quarantined: number };
  /** @deprecated Use recoverExpiredLeases; this method is also expired-only. */
  recoverInterrupted(): { requeued: number; quarantined: number };
  reconcile(input: {
    jobId: string;
    expectedVersion: number;
    disposition: "retry" | "cancel" | "confirm_completed";
    evidence: string;
  }): { reconciled: boolean; job?: DurableJobSummary };
  /** Operator-only CAS retry of a known definite failure. */
  retryFailed(input: { jobId: string; expectedVersion: number; availableAt?: number }): {
    retried: boolean;
    job?: DurableJobSummary;
  };
  /** Reconciles trusted declarative schedules without exposing their private data. */
  syncSchedules(
    definitions: readonly DurableJobScheduleDefinition[],
    input?: { now?: number },
  ): DurableJobScheduleSummary[];
  /** Atomically creates at most one coalesced occurrence per due schedule. */
  materializeDueSchedules(input?: {
    now?: number;
    limit?: number;
  }): DurableScheduleMaterializationResult;
  listSchedules(input?: { limit?: number }): DurableJobScheduleSummary[];
  pauseSchedule(input: { scheduleId: string; expectedVersion: number }): {
    paused: boolean;
    schedule?: DurableJobScheduleSummary;
  };
  resumeSchedule(input: { scheduleId: string; expectedVersion: number }): {
    resumed: boolean;
    schedule?: DurableJobScheduleSummary;
  };
  get(jobId: string): DurableJobRecord | null;
  getSummary(jobId: string): DurableJobSummary | null;
  list(input?: { limit?: number; state?: DurableJobState }): DurableJobSummary[];
  prune(input?: { before?: number; limit?: number }): number;
  pruneAudit(input?: { before?: number; limit?: number }): number;
  close(): void;
}

export interface SqliteDurableJobStoreOptions {
  dbPath: string;
  /** Disable automatic owned-schema migrations for observational/operator clients. */
  allowMigrations?: boolean;
  now?: () => number;
  jobId?: () => string;
  leaseToken?: () => string;
  incidentId?: () => string;
  maxTotalRecords?: number;
  /**
   * Maximum nonterminal jobs. A lease reserves this capacity until the job is
   * terminal, so requeues and reconciliation cannot overfill the queue.
   */
  maxQueuedRecords?: number;
  /** Sum of canonical payload and binding bytes admitted for stored jobs. */
  maxPrivateBytes?: number;
  /**
   * Fixed aggregate budget for private schedule definitions (8 MiB by
   * default). This is separate from job payload capacity because schedules
   * can exist before they materialize a job.
   */
  maxSchedulePrivateBytes?: number;
  /**
   * Maximum claims for one job. This also bounds per-job attempt and
   * reconciliation history because one reconciliation is possible per claim.
   */
  maxAttemptsPerJob?: number;
  /** Maximum retained reconciliation audit records across all jobs. */
  maxAuditRecords?: number;
  terminalRetentionMs?: number;
  auditRetentionMs?: number;
}

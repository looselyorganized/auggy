/**
 * Distributed-coordination topology contract.
 *
 * This module is intentionally descriptive: it lets future runtime
 * preflight code report the local state that must not be mistaken for
 * replica-safe state. It performs no connection, configuration lookup, or
 * enablement decision.
 */

export type DistributedCoordinationBlocker =
  | "process-local-fleet-admission"
  | "process-local-thread-serialization"
  | "unfenced-thread-history"
  | "process-local-idempotency-store"
  | "process-local-quarantine-and-health"
  | "process-local-mutable-stores"
  | "unfenced-delivery-outbox";

export type DistributedCoordinationPreflightBlocker =
  | "runtime-not-enabled"
  | DistributedCoordinationBlocker
  | "configured-augment-state-unverified";

export interface DistributedCoordinationPreflightReport {
  profile: "disabled";
  ready: false;
  blockers: readonly DistributedCoordinationPreflightBlocker[];
}

export class DistributedCoordinationStartupError extends Error {
  readonly code = "distributed-coordination-runtime-disabled" as const;
  readonly report: DistributedCoordinationPreflightReport;

  constructor(report: DistributedCoordinationPreflightReport) {
    super(`Distributed coordination cannot start: ${report.blockers.join(", ")}`);
    this.name = "DistributedCoordinationStartupError";
    this.report = report;
  }
}

export interface DistributedCoordinationTopology {
  /** Fleet-wide admission; the local keyed scheduler remains a per-process executor. */
  fleetAdmission: "process-local" | "shared-fenced";
  threadSerialization: "process-local" | "shared-fenced";
  threadHistory: "unfenced" | "fenced";
  idempotency: "process-local" | "shared";
  quarantineAndHealth: "process-local" | "shared";
  /** Budgets, replay ledgers, mutable memory, visitor state, and selected augment stores. */
  mutableStores: "process-local" | "shared-fenced";
  delivery: "process-local" | "shared-outbox";
}

/** Conservative representation of the current single-process runtime. */
export const PROCESS_LOCAL_COORDINATION_TOPOLOGY: Readonly<DistributedCoordinationTopology> =
  Object.freeze({
    fleetAdmission: "process-local",
    threadSerialization: "process-local",
    threadHistory: "unfenced",
    idempotency: "process-local",
    quarantineAndHealth: "process-local",
    mutableStores: "process-local",
    delivery: "process-local",
  });

/** Enumerate the fail-closed prerequisites that remain for replica safety. */
export function enumerateDistributedCoordinationBlockers(): DistributedCoordinationBlocker[] {
  const topology = PROCESS_LOCAL_COORDINATION_TOPOLOGY;
  const blockers: DistributedCoordinationBlocker[] = [];
  if (topology.fleetAdmission !== "shared-fenced") blockers.push("process-local-fleet-admission");
  if (topology.threadSerialization !== "shared-fenced") {
    blockers.push("process-local-thread-serialization");
  }
  if (topology.threadHistory !== "fenced") blockers.push("unfenced-thread-history");
  if (topology.idempotency !== "shared") blockers.push("process-local-idempotency-store");
  if (topology.quarantineAndHealth !== "shared") {
    blockers.push("process-local-quarantine-and-health");
  }
  if (topology.mutableStores !== "shared-fenced") blockers.push("process-local-mutable-stores");
  if (topology.delivery !== "shared-outbox") blockers.push("unfenced-delivery-outbox");
  return blockers;
}

/** Build fixed, secret-free evidence for the deliberately disabled profile. */
export function distributedCoordinationPreflightReport(options?: {
  configuredAugments?: boolean;
}): DistributedCoordinationPreflightReport {
  return Object.freeze({
    profile: "disabled" as const,
    ready: false as const,
    blockers: Object.freeze([
      "runtime-not-enabled" as const,
      ...enumerateDistributedCoordinationBlockers(),
      ...(options?.configuredAugments ? (["configured-augment-state-unverified"] as const) : []),
    ]),
  });
}

/**
 * Fail before any runtime-owned mutation whenever coordination is declared.
 * Keep this at CLI admission and inside defineAgent for embedding callers.
 */
export function assertDistributedCoordinationStartupAllowed(
  coordination: unknown,
  options?: { configuredAugments?: boolean },
): void {
  if (coordination === undefined) return;
  const report = distributedCoordinationPreflightReport(options);
  throw new DistributedCoordinationStartupError(report);
}

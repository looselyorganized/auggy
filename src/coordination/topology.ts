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
export const PROCESS_LOCAL_COORDINATION_TOPOLOGY: DistributedCoordinationTopology = {
  fleetAdmission: "process-local",
  threadSerialization: "process-local",
  threadHistory: "unfenced",
  idempotency: "process-local",
  quarantineAndHealth: "process-local",
  mutableStores: "process-local",
  delivery: "process-local",
};

/** Enumerate the fail-closed prerequisites that remain for replica safety. */
export function enumerateDistributedCoordinationBlockers(
  topology: DistributedCoordinationTopology = PROCESS_LOCAL_COORDINATION_TOPOLOGY,
): DistributedCoordinationBlocker[] {
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

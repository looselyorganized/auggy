/**
 * Distributed-coordination topology contract.
 *
 * This module is intentionally descriptive: it lets future runtime
 * preflight code report the local state that must not be mistaken for
 * replica-safe state. It performs no connection, configuration lookup, or
 * enablement decision.
 */

export type DistributedCoordinationBlocker =
  | "process-local-turn-scheduler"
  | "process-local-thread-serialization"
  | "unfenced-thread-history"
  | "process-local-idempotency-store"
  | "process-local-quarantine-and-health";

export interface DistributedCoordinationTopology {
  turnScheduler: "process-local" | "shared-fenced";
  threadSerialization: "process-local" | "shared-fenced";
  threadHistory: "unfenced" | "fenced";
  idempotency: "process-local" | "shared";
  quarantineAndHealth: "process-local" | "shared";
}

/** Conservative representation of the current single-process runtime. */
export const PROCESS_LOCAL_COORDINATION_TOPOLOGY: DistributedCoordinationTopology = {
  turnScheduler: "process-local",
  threadSerialization: "process-local",
  threadHistory: "unfenced",
  idempotency: "process-local",
  quarantineAndHealth: "process-local",
};

/** Enumerate the fail-closed prerequisites that remain for replica safety. */
export function enumerateDistributedCoordinationBlockers(
  topology: DistributedCoordinationTopology = PROCESS_LOCAL_COORDINATION_TOPOLOGY,
): DistributedCoordinationBlocker[] {
  const blockers: DistributedCoordinationBlocker[] = [];
  if (topology.turnScheduler !== "shared-fenced") blockers.push("process-local-turn-scheduler");
  if (topology.threadSerialization !== "shared-fenced") {
    blockers.push("process-local-thread-serialization");
  }
  if (topology.threadHistory !== "fenced") blockers.push("unfenced-thread-history");
  if (topology.idempotency !== "shared") blockers.push("process-local-idempotency-store");
  if (topology.quarantineAndHealth !== "shared") {
    blockers.push("process-local-quarantine-and-health");
  }
  return blockers;
}

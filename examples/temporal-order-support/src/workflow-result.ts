import type { OrderSupportActivityOutcome } from "./activities.js";

export type OrderRefundWorkflowResult =
  | { state: "ready-for-deterministic-refund"; auggyRunId: string }
  | {
      state: "manual-reconciliation-required";
      reason:
        | "auggy-auth-required"
        | "auggy-binding-conflict"
        | "auggy-canceled"
        | "auggy-failed"
        | "auggy-input-required"
        | "auggy-outcome-unknown"
        | "auggy-rejected";
    };

/** Deterministic mapping: only an exact completed Activity can advance. */
export function refundResultForOrderSupportOutcome(
  outcome: OrderSupportActivityOutcome,
): OrderRefundWorkflowResult {
  switch (outcome.state) {
    case "completed":
      return { state: "ready-for-deterministic-refund", auggyRunId: outcome.runId };
    case "auth-required":
      return { state: "manual-reconciliation-required", reason: "auggy-auth-required" };
    case "binding-conflict":
      return { state: "manual-reconciliation-required", reason: "auggy-binding-conflict" };
    case "failed":
      return { state: "manual-reconciliation-required", reason: "auggy-failed" };
    case "input-required":
      return { state: "manual-reconciliation-required", reason: "auggy-input-required" };
    case "rejected":
      return { state: "manual-reconciliation-required", reason: "auggy-rejected" };
    case "remote-canceled":
      return { state: "manual-reconciliation-required", reason: "auggy-canceled" };
    case "outcome-unknown":
      return { state: "manual-reconciliation-required", reason: "auggy-outcome-unknown" };
  }
}

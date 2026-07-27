import { proxyActivities, workflowInfo } from "@temporalio/workflow";

import type { OrderSupportActivities } from "./activities.js";
import { orderSupportActivityPolicy } from "./workflow-policy.js";
import {
  refundResultForOrderSupportOutcome,
  type OrderRefundWorkflowResult,
} from "./workflow-result.js";

export type { OrderRefundWorkflowResult } from "./workflow-result.js";

const { requestOrderSupportReview } = proxyActivities<OrderSupportActivities>(orderSupportActivityPolicy);

export interface OrderRefundWorkflowInput {
  /** Trusted application data, not target/auth/retry configuration. */
  orderId: string;
  refundId: string;
  amountCents: number;
  reasonCode: "duplicate" | "damaged" | "not_received";
}

/**
 * Temporal owns the durable business sequence. Auggy is one authenticated,
 * idempotent Activity within it; model output never decides whether money moves.
 */
export async function orderRefundWorkflow(input: OrderRefundWorkflowInput): Promise<OrderRefundWorkflowResult> {
  validateInput(input);
  const workflowId = workflowInfo().workflowId;
  if (!/^[A-Za-z0-9_-]{1,122}$/.test(workflowId)) {
    throw new Error("workflowId cannot be converted to a valid Auggy idempotency key");
  }
  const outcome = await requestOrderSupportReview({
    // Workflow IDs are created by src/start.ts with this bounded safe alphabet.
    // Activity retries and Workflow Task replays produce the exact same key.
    idempotencyKey: `auggy_${workflowId}`,
    threadId: `temporal_${workflowId}`,
    message: orderSupportMessage(input),
  });

  // A real payment/refund Activity belongs after this point. It receives this
  // deterministic decision from the Workflow, never free-form model text.
  return refundResultForOrderSupportOutcome(outcome);
}

function validateInput(input: OrderRefundWorkflowInput): void {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.orderId)) throw new Error("invalid orderId");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.refundId)) throw new Error("invalid refundId");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 10_000_000) {
    throw new Error("invalid amountCents");
  }
  if (input.reasonCode !== "duplicate" && input.reasonCode !== "damaged" && input.reasonCode !== "not_received") {
    throw new Error("invalid reasonCode");
  }
}

function orderSupportMessage(input: OrderRefundWorkflowInput): string {
  return [
    "A trusted order system is reconciling a refund.",
    `Order: ${input.orderId}`,
    `Refund: ${input.refundId}`,
    `Amount cents: ${input.amountCents}`,
    `Reason: ${input.reasonCode}`,
    "Summarize customer-facing support considerations. Do not authorize, execute, or alter the refund.",
  ].join("\n");
}

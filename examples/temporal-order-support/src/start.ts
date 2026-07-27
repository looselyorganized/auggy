import { Client, Connection } from "@temporalio/client";

import { readOperatorConfig } from "./operator-config.js";
import { orderRefundWorkflow, type OrderRefundWorkflowInput } from "./workflow.js";

async function main(): Promise<void> {
  const config = readOperatorConfig();
  const input = commandInput(process.argv.slice(2));
  const connection = await Connection.connect({
    address: config.temporal.address,
    apiKey: config.temporal.apiKey,
  });
  try {
    const client = new Client({ connection, namespace: config.temporal.namespace });
    await client.workflow.start(orderRefundWorkflow, {
      args: [input],
      taskQueue: config.temporal.taskQueue,
      // Bounded identifiers make the derived Auggy idempotency key valid.
      workflowId: `refund_${input.orderId}_${input.refundId}`,
    });
  } finally {
    await connection.close();
  }
}

function commandInput(args: string[]): OrderRefundWorkflowInput {
  const [orderId, refundId, amountCents, reasonCode] = args;
  if (!orderId || !refundId || !amountCents || !reasonCode || args.length !== 4) {
    throw new Error("usage: bun run start -- <order-id> <refund-id> <amount-cents> <duplicate|damaged|not_received>");
  }
  if (reasonCode !== "duplicate" && reasonCode !== "damaged" && reasonCode !== "not_received") {
    throw new Error("reason must be duplicate, damaged, or not_received");
  }
  return { orderId, refundId, amountCents: Number(amountCents), reasonCode };
}

void main();

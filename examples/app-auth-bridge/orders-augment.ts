import { defineAugment, defineRoute, defineTool, json } from "auggy";
import { z } from "zod";

const orders = [
  { id: "order_123", status: "ready" },
  { id: "order_456", status: "processing" },
] as const;

export function ordersAugment() {
  return defineAugment({
    name: "orders",
    type: "custom",
    httpRoutes: [
      defineRoute.get("/orders", {
        auth: "visitor.required",
        requires: { scope: "orders.read" },
        response: z.object({
          orders: z.array(z.object({ id: z.string(), status: z.string() })),
        }),
        handler: ({ auth }) => {
          const allowedOrderIds = readableOrderIds(auth.externalAuth?.grants);
          return json({ orders: orders.filter((order) => allowedOrderIds.has(order.id)) });
        },
      }),
      defineRoute.post("/orders/:id/refund", {
        auth: "visitor.required",
        params: z.object({ id: z.string() }),
        body: z.object({ reason: z.string() }),
        requires: { action: "refund.issue", resource: { param: "id" } },
        response: z.object({
          refundId: z.string(),
          orderId: z.string(),
        }),
        handler: ({ params }) => json({ refundId: `refund_${params.id}`, orderId: params.id }),
      }),
    ],
    tools: [
      defineTool({
        name: "refund_order",
        description: "Refund a customer order when the app has delegated a matching grant.",
        category: "commerce",
        input: z.object({
          orderId: z.string(),
          reason: z.string(),
        }),
        requires: {
          action: "refund.issue",
          resource: { input: "orderId" },
          constraints: { maxAmountCents: 5000 },
        },
        execute: async ({ orderId }) => `refund-started:${orderId}`,
      }),
    ],
  });
}

function readableOrderIds(
  grants: readonly { action: string; resource?: string }[] | undefined,
): Set<string> {
  return new Set(
    (grants ?? [])
      .filter((grant) => grant.action === "orders.read" && typeof grant.resource === "string")
      .map((grant) => grant.resource as string),
  );
}

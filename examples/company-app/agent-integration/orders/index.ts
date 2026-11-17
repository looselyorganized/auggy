import { defineAugment, defineRoute, defineTool, json, type RouteAuthContext } from "auggy";
import { z } from "zod";
import type { OrderPrincipal, OrdersService } from "./contracts";
import {
  createOrdersServiceClient,
  OrdersServiceError,
  orderSchema,
  refundSchema,
} from "./service-client";

const orderId = z.string().regex(/^order-[a-z0-9-]{1,64}$/);
const refundInput = z
  .object({
    orderId,
    amountCents: z.number().int().min(1).max(5000),
    reason: z.string().trim().min(1).max(256),
  })
  .strict();

/** Runtime claims are checked again at this owned domain boundary, for both interfaces. */
function authorizedPrincipal(
  auth: RouteAuthContext | undefined,
  action: string,
  resource: string,
  amountCents?: number,
): OrderPrincipal {
  if (
    auth?.mode !== "visitor" ||
    auth.state !== "recognized" ||
    !auth.externalAuth ||
    auth.principal.trustLevel !== "public" ||
    !auth.externalAuth.authzVersion
  )
    throw new OrdersServiceError(403);
  const claims = auth.externalAuth;
  const matching = claims.grants?.find(
    (grant) => grant.action === action && grant.resource === resource,
  );
  if (!matching || (action === "orders.read" && !claims.scopes?.includes("orders.read")))
    throw new OrdersServiceError(403);
  if (amountCents !== undefined) {
    const maximum = matching.constraints?.maxAmountCents;
    if (
      typeof maximum !== "number" ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 5000 ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 1 ||
      amountCents > maximum
    )
      throw new OrdersServiceError(403);
  }
  return {
    provider: claims.provider,
    subject: claims.subject,
    orgId: claims.orgId,
    grants: claims.grants ?? [],
    authzVersion: claims.authzVersion!,
  };
}

async function routeResult(operation: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await operation());
  } catch (error) {
    const status = error instanceof OrdersServiceError ? error.status : 503;
    return json(
      {
        error:
          status === 403
            ? "forbidden"
            : status === 409
              ? "operation_conflict"
              : "order_service_unavailable",
      },
      status,
    );
  }
}

export function ordersAugment(service: OrdersService) {
  return defineAugment({
    name: "orders",
    type: "custom",
    tools: [
      defineTool({
        name: "read_order",
        description: "Read one order explicitly delegated to this application user.",
        category: "orders",
        input: z.object({ orderId }).strict(),
        requires: [
          { scope: "orders.read" },
          { action: "orders.read", resource: { input: "orderId" } },
        ],
        execute: async ({ orderId }, context) =>
          JSON.stringify(
            await service.read(
              authorizedPrincipal(context?.auth, "orders.read", orderId),
              orderId,
              context?.signal,
            ),
          ),
      }),
      defineTool({
        name: "simulate_refund",
        description:
          "Record a synthetic refund simulation for an explicitly delegated order. No money moves.",
        category: "orders",
        input: refundInput,
        requires: { action: "orders.refund.simulate", resource: { input: "orderId" } },
        execute: async (input, context) => {
          const principal = authorizedPrincipal(
            context?.auth,
            "orders.refund.simulate",
            input.orderId,
            input.amountCents,
          );
          if (!context?.operationId) throw new OrdersServiceError(503);
          return JSON.stringify(
            await service.simulateRefund(
              principal,
              { ...input, operationId: context.operationId },
              context.signal,
            ),
          );
        },
      }),
    ],
    httpRoutes: [
      defineRoute.get("/orders/:id", {
        auth: "visitor.required",
        params: z.object({ id: orderId }),
        requires: [{ scope: "orders.read" }, { action: "orders.read", resource: { param: "id" } }],
        response: orderSchema,
        handler: ({ auth, params, signal }) =>
          routeResult(() =>
            service.read(authorizedPrincipal(auth, "orders.read", params.id), params.id, signal),
          ),
      }),
      defineRoute.post("/orders/:id/refund-simulations", {
        auth: "visitor.required",
        params: z.object({ id: orderId }),
        body: refundInput
          .omit({ orderId: true })
          .extend({ operationId: z.string().min(16).max(256) })
          .strict(),
        requires: { action: "orders.refund.simulate", resource: { param: "id" } },
        response: refundSchema,
        handler: ({ auth, params, body, signal }) =>
          routeResult(() =>
            service.simulateRefund(
              authorizedPrincipal(auth, "orders.refund.simulate", params.id, body.amountCents),
              { ...body, orderId: params.id },
              signal,
            ),
          ),
      }),
    ],
  });
}

/** Factory referenced by the generated project's YAML; no source executes at import. */
export default function createOrdersAugment() {
  return ordersAugment(
    createOrdersServiceClient({
      origin: process.env.ORDERS_SERVICE_URL,
      token: process.env.ORDERS_SERVICE_TOKEN,
    }),
  );
}

import {
  defineAugment,
  defineRoute,
  defineTool,
  json,
  type RouteAuthContext,
  type ToolExecuteContext,
  type ToolResult,
} from "auggy";
import { z } from "zod";
import {
  type AuthorizedActor,
  OrderSupportError,
  OrderSupportService,
  type OrderSupportServiceOptions,
} from "./domain";
import {
  ConfirmAddressChangeSchema,
  ConfirmAddressChangeToolSchema,
  ConfirmedAddressChangeResponseSchema,
  OrderParamsSchema,
  OrderResponseSchema,
  PrepareAddressChangeSchema,
  PreparedAddressChangeResponseSchema,
  PrepareAddressChangeToolSchema,
} from "./schemas";

export interface OrderSupportAugmentOptions extends OrderSupportServiceOptions {
  service?: OrderSupportService;
}

export default function orderSupport(opts: OrderSupportAugmentOptions = {}) {
  const service = opts.service ?? new OrderSupportService(opts);
  const inboundTextByTurn = new Map<string, string>();

  return defineAugment({
    name: "order-support",
    httpRoutes: defineRoute.group("/order-support", [
      defineRoute.get("/orders/:id", {
        auth: "visitor.required",
        params: OrderParamsSchema,
        response: OrderResponseSchema,
        handler: ({ auth, params }) => routeResult(() => ({ order: service.getOrder(routeActor(auth), params.id) })),
      }),
      defineRoute.post("/orders/:id/address-change/prepare", {
        auth: "visitor.required",
        params: OrderParamsSchema,
        body: PrepareAddressChangeSchema,
        response: PreparedAddressChangeResponseSchema,
        maxBodyBytes: 2_048,
        rateLimit: { maxPerMinute: 10 },
        handler: ({ auth, params, body }) =>
          routeResult(() => ({
            change: service.prepareAddressChange({
              actor: routeActor(auth),
              binding: "app",
              orderId: params.id,
              newAddress: body.newAddress,
            }),
          }), 201),
      }),
      defineRoute.post("/orders/:id/address-change/confirm", {
        auth: "visitor.required",
        params: OrderParamsSchema,
        body: ConfirmAddressChangeSchema,
        response: ConfirmedAddressChangeResponseSchema,
        maxBodyBytes: 2_048,
        rateLimit: { maxPerMinute: 10 },
        handler: ({ auth, body }) =>
          routeResult(() => ({
            result: service.confirmAddressChange({
              actor: routeActor(auth),
              binding: "app",
              changeId: body.changeId,
              confirmationPhrase: body.confirmationPhrase,
              humanInput: body.confirmationPhrase,
            }),
          })),
      }),
    ]),
    tools: [
      defineTool({
        name: "order_support_get_order",
        description: "Look up a demo order for the runtime-verified visitor or creator.",
        category: "orders",
        input: z.object({ orderId: z.string().trim().min(1).max(64) }),
        execute: async ({ orderId }, context) =>
          toolResult(() => ({ order: service.getOrder(toolActor(context), orderId) })),
      }),
      defineTool({
        name: "order_support_prepare_address_change",
        description: "Prepare an address change and return the exact phrase the verified human must send in a later turn.",
        category: "orders",
        input: PrepareAddressChangeToolSchema,
        execute: async ({ orderId, newAddress }, context) =>
          toolResult(() => ({
            change: service.prepareAddressChange({
              actor: toolActor(context),
              binding: chatBinding(context),
              orderId,
              newAddress,
            }),
          })),
      }),
      defineTool({
        name: "order_support_confirm_address_change",
        description: "Apply the prepared change only when the verified human sent the exact phrase in the current, later turn.",
        category: "orders",
        input: ConfirmAddressChangeToolSchema,
        execute: async ({ confirmationPhrase }, context) =>
          toolResult(() => ({
            result: service.confirmAddressChange({
              actor: toolActor(context),
              binding: chatBinding(context),
              confirmationPhrase,
              humanInput: inboundTextByTurn.get(turnKey(context)) ?? "",
            }),
          })),
      }),
    ],
    async onTurnStart(turn) {
      const payload = turn.trigger.payload as { parts?: Array<{ kind: string; text?: string }> };
      const text = (payload.parts ?? [])
        .filter((part) => part.kind === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      inboundTextByTurn.set(`${turn.threadId}:${turn.turnId}`, text);
    },
    async onTurnEnd(turn) {
      inboundTextByTurn.delete(`${turn.threadId}:${turn.turnId}`);
    },
  });
}

function routeActor(auth: RouteAuthContext): AuthorizedActor {
  if (auth.mode !== "visitor" || auth.state !== "recognized") {
    throw new OrderSupportError("verification_required", "A verified visitor is required.");
  }
  return { key: `visitor:${auth.visitorId}`, id: auth.visitorId, type: "verified_visitor" };
}

function toolActor(context: ToolExecuteContext | undefined): AuthorizedActor {
  const peer = context?.peer;
  if (peer?.trustLevel === "creator") {
    return { key: `creator:${peer.id}`, id: peer.id, type: "creator" };
  }
  if (peer?.trustLevel === "public" && peer.publicSubstate === "recognized") {
    return { key: `visitor:${peer.id}`, id: peer.id, type: "verified_visitor" };
  }
  throw new OrderSupportError(
    "verification_required",
    "Creator access or a verified visitor identity is required.",
  );
}

function chatBinding(context: ToolExecuteContext | undefined): string {
  if (!context?.threadId) {
    throw new OrderSupportError("verification_required", "A verified chat thread is required.");
  }
  return `chat:${context.threadId}`;
}

function turnKey(context: ToolExecuteContext | undefined): string {
  return `${context?.threadId ?? ""}:${context?.turnId ?? ""}`;
}

function routeResult(run: () => unknown, status = 200): Response {
  try {
    return json(run(), status);
  } catch (error) {
    if (error instanceof OrderSupportError) {
      const statusCode = error.code === "order_not_found" ? 404 : 409;
      return json({ error: error.code, message: error.message }, statusCode);
    }
    throw error;
  }
}

function toolResult(run: () => unknown): string | ToolResult {
  try {
    return JSON.stringify(run());
  } catch (error) {
    if (error instanceof OrderSupportError) {
      return {
        content: JSON.stringify({ status: "error", code: error.code, message: error.message }),
        isError: true,
      };
    }
    throw error;
  }
}

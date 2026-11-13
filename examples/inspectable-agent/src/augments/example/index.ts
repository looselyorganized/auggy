import { defineAugment, defineRoute, defineTool, json } from "auggy";
import { observeTool, observeTurnCompleted } from "../../observability";
import { orderLookupSchema, orderSchema } from "./schemas";
import { getOrder } from "./service";

export default function example() {
  return defineAugment({
    name: "example",
    category: "capabilities",
    tools: [
      defineTool({
        name: "example_get_order",
        description: "Read the status of a demo order. Only the agent creator may use this tool.",
        category: "orders",
        input: orderLookupSchema,
        async execute(input, context) {
          // Identity comes from the guarded runtime, never model-supplied arguments.
          if (context?.peer?.trustLevel !== "creator") {
            observeTool(context, "denied", null);
            return { content: "Creator authorization is required.", isError: true };
          }
          const order = getOrder(input);
          if (!order) {
            observeTool(context, "not-found", null);
            return { content: "Demo order not found.", isError: true };
          }
          const output = JSON.stringify(order);
          observeTool(context, "found", output);
          return output;
        },
      }),
    ],
    httpRoutes: [
      defineRoute.get("/example/orders/:orderId", {
        auth: "creator",
        params: orderLookupSchema,
        response: orderSchema,
        handler: ({ params }) => {
          const order = getOrder(params);
          return order ? json(order) : json({ error: "not-found" }, 404);
        },
      }),
    ],
    onTurnEnd: async (turn) => observeTurnCompleted(turn),
  });
}

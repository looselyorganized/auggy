import { orderLookupSchema, orderSchema, type DemoOrder } from "./schemas";

const order = Object.freeze(
  orderSchema.parse({
    orderId: "DEMO-1001",
    status: "ready-for-pickup",
    itemCount: 2,
  }),
);

/** A deterministic read-only demo. Replace this boundary with your system of record. */
export function getOrder(input: unknown): Readonly<DemoOrder> | null {
  const { orderId } = orderLookupSchema.parse(input);
  return orderId === order.orderId ? order : null;
}

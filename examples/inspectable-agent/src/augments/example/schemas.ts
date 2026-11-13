import { z } from "zod";

export const orderLookupSchema = z.object({ orderId: z.string().regex(/^DEMO-\d{4}$/) }).strict();
export const orderSchema = z
  .object({
    orderId: z.string().regex(/^DEMO-\d{4}$/),
    status: z.literal("ready-for-pickup"),
    itemCount: z.number().int().nonnegative(),
  })
  .strict();
export type DemoOrder = z.infer<typeof orderSchema>;

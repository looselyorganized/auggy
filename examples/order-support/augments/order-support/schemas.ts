import { z } from "zod";

export const OrderParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });

export const OrderSchema = z.object({
  orderId: z.string(),
  shippingAddress: z.string(),
  fulfillmentStatus: z.literal("processing"),
});

export const OrderResponseSchema = z.object({ order: OrderSchema });

export const PrepareAddressChangeSchema = z.object({
  newAddress: z.string().trim().min(10).max(300),
});

export const PrepareAddressChangeToolSchema = PrepareAddressChangeSchema.extend({
  orderId: z.string().trim().min(1).max(64),
});

export const PreparedAddressChangeSchema = z.object({
  status: z.literal("confirmation_required"),
  changeId: z.string(),
  orderId: z.string(),
  currentAddress: z.string(),
  proposedAddress: z.string(),
  confirmationPhrase: z.string(),
  expiresAt: z.string(),
});

export const PreparedAddressChangeResponseSchema = z.object({
  change: PreparedAddressChangeSchema,
});

export const ConfirmAddressChangeSchema = z.object({
  changeId: z.string().trim().min(1),
  confirmationPhrase: z.string().trim().min(1),
});

export const ConfirmAddressChangeToolSchema = z.object({
  confirmationPhrase: z.string().trim().min(1),
});

export const AddressChangeAuditSchema = z.object({
  auditId: z.string(),
  action: z.literal("shipping_address.changed"),
  actorType: z.enum(["creator", "verified_visitor"]),
  actorId: z.string(),
  orderId: z.string(),
  previousAddress: z.string(),
  updatedAddress: z.string(),
  changedAt: z.string(),
});

export const ConfirmedAddressChangeSchema = z.object({
  status: z.literal("success"),
  order: OrderSchema,
  audit: AddressChangeAuditSchema,
});

export const ConfirmedAddressChangeResponseSchema = z.object({
  result: ConfirmedAddressChangeSchema,
});

export type DemoOrder = z.infer<typeof OrderSchema>;
export type PreparedAddressChange = z.infer<typeof PreparedAddressChangeSchema>;
export type ConfirmedAddressChange = z.infer<typeof ConfirmedAddressChangeSchema>;

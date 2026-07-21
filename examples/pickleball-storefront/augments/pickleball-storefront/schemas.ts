import { z } from "zod";

export const ProductCategorySchema = z.enum(["paddle", "balls", "bag"]);
export const PlayStyleSchema = z.enum(["control", "balanced", "power"]);

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: ProductCategorySchema,
  summary: z.string(),
  priceUsd: z.number(),
  playStyle: PlayStyleSchema.optional(),
  level: z.enum(["beginner", "intermediate", "advanced", "all"]),
  accent: z.string(),
  inStock: z.boolean(),
});

export const ProductSearchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  category: ProductCategorySchema.optional(),
  playStyle: PlayStyleSchema.optional(),
  maxPriceUsd: z.coerce.number().positive().optional(),
});

export const ProductListResponseSchema = z.object({
  products: z.array(ProductSchema),
});

export const ProductParamsSchema = z.object({ id: z.string().trim().min(1) });
export const ProductResponseSchema = z.object({ product: ProductSchema });

export const CartItemInputSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.coerce.number().int().min(1).max(10),
});

export const CreateCartSchema = z.object({
  items: z.array(CartItemInputSchema).min(1).max(12),
});

export const CartItemSchema = z.object({
  product: ProductSchema,
  quantity: z.number().int().positive(),
  lineTotalUsd: z.number(),
});

export const CartSchema = z.object({
  id: z.string(),
  items: z.array(CartItemSchema),
  totalUsd: z.number(),
  currency: z.literal("USD"),
  status: z.literal("draft"),
});

export const CartResponseSchema = z.object({ cart: CartSchema });

export const PrepareCheckoutSchema = z.object({
  cartId: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
});

export const CheckoutSessionSchema = z.object({
  id: z.string(),
  cartId: z.string(),
  amountUsd: z.number(),
  currency: z.literal("USD"),
  status: z.literal("requires_confirmation"),
  confirmationUrl: z.string(),
  simulated: z.literal(true),
});

export const CheckoutResponseSchema = z.object({ checkout: CheckoutSessionSchema });

export type ProductSearch = z.infer<typeof ProductSearchSchema>;
export type CreateCartInput = z.infer<typeof CreateCartSchema>;
export type PrepareCheckoutInput = z.infer<typeof PrepareCheckoutSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Cart = z.infer<typeof CartSchema>;
export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;

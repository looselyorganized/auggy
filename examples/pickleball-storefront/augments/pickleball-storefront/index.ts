import { defineAugment, defineRoute, defineTool, json } from "auggy";
import { StorefrontError, StorefrontService } from "./domain";
import {
  CartResponseSchema,
  CheckoutResponseSchema,
  CreateCartSchema,
  PrepareCheckoutSchema,
  ProductListResponseSchema,
  ProductParamsSchema,
  ProductResponseSchema,
  ProductSearchSchema,
} from "./schemas";

export interface StorefrontAugmentOptions {
  service?: StorefrontService;
}

export default function pickleballStorefront(opts: StorefrontAugmentOptions = {}) {
  const service = opts.service ?? new StorefrontService();

  return defineAugment({
    name: "pickleball-storefront",
    httpRoutes: defineRoute.group("/storefront", [
      defineRoute.get("/products", {
        auth: "none",
        query: ProductSearchSchema,
        response: ProductListResponseSchema,
        rateLimit: { maxPerMinute: 120 },
        handler: ({ query }) => json({ products: service.searchProducts(query) }),
      }),
      defineRoute.get("/products/:id", {
        auth: "none",
        params: ProductParamsSchema,
        response: ProductResponseSchema,
        rateLimit: { maxPerMinute: 120 },
        handler: ({ params }) => safely(() => json({ product: service.getProduct(params.id) })),
      }),
      defineRoute.post("/carts", {
        auth: "visitor.optional",
        body: CreateCartSchema,
        response: CartResponseSchema,
        maxBodyBytes: 8_192,
        rateLimit: { maxPerMinute: 30 },
        handler: ({ body }) => safely(() => json({ cart: service.createCart(body) }, 201)),
      }),
      defineRoute.post("/checkout-sessions", {
        auth: "visitor.optional",
        body: PrepareCheckoutSchema,
        response: CheckoutResponseSchema,
        maxBodyBytes: 4_096,
        rateLimit: { maxPerMinute: 15 },
        handler: ({ body }) => safely(() => json({ checkout: service.prepareCheckout(body) }, 201)),
      }),
    ]),
    tools: [
      defineTool({
        name: "storefront_search_products",
        description: "Search the current pickleball catalog by need, category, play style, or budget.",
        category: "commerce",
        input: ProductSearchSchema,
        execute: async (input) => JSON.stringify({ products: service.searchProducts(input) }),
      }),
      defineTool({
        name: "storefront_create_draft_cart",
        description: "Create a draft cart from products the visitor has selected. This does not purchase anything.",
        category: "commerce",
        input: CreateCartSchema,
        execute: async (input) => safelyTool(() => ({ cart: service.createCart(input) })),
      }),
      defineTool({
        name: "storefront_prepare_checkout",
        description: "Prepare a simulated checkout handoff for an existing draft cart. This does not capture payment.",
        category: "commerce",
        input: PrepareCheckoutSchema,
        execute: async (input) => safelyTool(() => ({ checkout: service.prepareCheckout(input) })),
      }),
    ],
  });
}

function safely(run: () => Response): Response {
  try {
    return run();
  } catch (error) {
    if (error instanceof StorefrontError) {
      return json({ error: error.code, message: error.message }, 404);
    }
    throw error;
  }
}

function safelyTool(run: () => unknown): string {
  try {
    return JSON.stringify(run());
  } catch (error) {
    if (error instanceof StorefrontError) {
      return JSON.stringify({ status: "error", code: error.code, message: error.message });
    }
    throw error;
  }
}

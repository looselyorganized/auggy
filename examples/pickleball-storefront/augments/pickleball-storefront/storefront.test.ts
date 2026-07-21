import { describe, expect, test } from "bun:test";
import pickleballStorefront from "./index";
import { StorefrontService } from "./domain";

function route(
  augment: ReturnType<typeof pickleballStorefront>,
  method: "GET" | "POST",
  path: string,
) {
  const match = augment.httpRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!match) throw new Error(`Missing route ${method} ${path}`);
  return match;
}

function tool(augment: ReturnType<typeof pickleballStorefront>, name: string) {
  const match = augment.tools?.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing tool ${name}`);
  return match;
}

describe("pickleball-storefront", () => {
  test("exposes grouped routes with response schemas", () => {
    const augment = pickleballStorefront();
    expect(
      augment.httpRoutes?.map((candidate) => `${candidate.method} ${candidate.path}`),
    ).toEqual([
      "GET /storefront/products",
      "GET /storefront/products/:id",
      "POST /storefront/carts",
      "POST /storefront/checkout-sessions",
    ]);
    expect(
      augment.httpRoutes?.every((candidate) => candidate.responseJsonSchema !== undefined),
    ).toBe(true);
  });

  test("route and tool searches use the same catalog", async () => {
    const augment = pickleballStorefront();
    const searchRoute = route(augment, "GET", "/storefront/products");
    const response = await searchRoute.handler(
      new Request("http://localhost/storefront/products?playStyle=control&maxPriceUsd=160"),
      { signal: AbortSignal.timeout(1_000) },
    );
    const routeBody = (await response.json()) as { products: Array<{ id: string }> };

    const toolBody = JSON.parse(
      String(
        await tool(augment, "storefront_search_products").execute({
          playStyle: "control",
          maxPriceUsd: 160,
        }),
      ),
    ) as { products: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(routeBody.products.map((product) => product.id)).toEqual([
      "paddle-cove-control",
    ]);
    expect(toolBody.products).toEqual(routeBody.products);
  });

  test("a route-created cart can be handed to the model checkout tool", async () => {
    let sequence = 0;
    const service = new StorefrontService(() => String(++sequence));
    const augment = pickleballStorefront({ service });
    const createCart = route(augment, "POST", "/storefront/carts");
    const cartResponse = await createCart.handler(
      new Request("http://localhost/storefront/carts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { productId: "paddle-cove-control", quantity: 1 },
            { productId: "balls-court-six", quantity: 2 },
          ],
        }),
      }),
      { signal: AbortSignal.timeout(1_000) },
    );
    const { cart } = (await cartResponse.json()) as {
      cart: { id: string; totalUsd: number };
    };

    const checkout = JSON.parse(
      String(
        await tool(augment, "storefront_prepare_checkout").execute({ cartId: cart.id }),
      ),
    ) as { checkout: { cartId: string; status: string; simulated: boolean } };

    expect(cartResponse.status).toBe(201);
    expect(cart).toMatchObject({ id: "cart_1", totalUsd: 185 });
    expect(checkout.checkout).toMatchObject({
      cartId: "cart_1",
      status: "requires_confirmation",
      simulated: true,
    });
  });

  test("unknown products fail consistently", async () => {
    const augment = pickleballStorefront();
    const productRoute = route(augment, "GET", "/storefront/products/:id");
    const response = await productRoute.handler(
      new Request("http://localhost/storefront/products/missing"),
      {
        signal: AbortSignal.timeout(1_000),
        params: { id: "missing" },
        routePath: "/storefront/products/:id",
      },
    );
    const toolResult = JSON.parse(
      String(
        await tool(augment, "storefront_create_draft_cart").execute({
          items: [{ productId: "missing", quantity: 1 }],
        }),
      ),
    ) as { code: string };

    expect(response.status).toBe(404);
    expect(toolResult.code).toBe("product_not_found");
  });
});

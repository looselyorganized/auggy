import type {
  Cart,
  CheckoutSession,
  CreateCartInput,
  PrepareCheckoutInput,
  Product,
  ProductSearch,
} from "./schemas";

export class StorefrontError extends Error {
  constructor(
    readonly code: "product_not_found" | "product_unavailable" | "cart_not_found",
    message: string,
  ) {
    super(message);
  }
}

const PRODUCTS: readonly Product[] = [
  {
    id: "paddle-cove-control",
    name: "Cove Control 16",
    category: "paddle",
    summary: "A forgiving 16 mm paddle with a large sweet spot and soft touch at the kitchen.",
    priceUsd: 149,
    playStyle: "control",
    level: "beginner",
    accent: "#1f6f5f",
    inStock: true,
  },
  {
    id: "paddle-rally-balanced",
    name: "Rally Standard",
    category: "paddle",
    summary: "An all-court paddle balancing hand speed, spin, and put-away power.",
    priceUsd: 179,
    playStyle: "balanced",
    level: "intermediate",
    accent: "#e05d3f",
    inStock: true,
  },
  {
    id: "paddle-drive-power",
    name: "Drive Carbon 14",
    category: "paddle",
    summary: "A firmer elongated paddle for advanced players who generate pace from the baseline.",
    priceUsd: 219,
    playStyle: "power",
    level: "advanced",
    accent: "#252a34",
    inStock: true,
  },
  {
    id: "balls-court-six",
    name: "Court 40 Ball Pack",
    category: "balls",
    summary: "Six durable outdoor balls with consistent bounce in warm and cool conditions.",
    priceUsd: 18,
    level: "all",
    accent: "#d7e43f",
    inStock: true,
  },
  {
    id: "bag-weekender",
    name: "Baseline Weekender",
    category: "bag",
    summary: "A compact court bag with two paddle sleeves, ball storage, and a ventilated shoe bay.",
    priceUsd: 84,
    level: "all",
    accent: "#3c6e91",
    inStock: true,
  },
];

export class StorefrontService {
  private readonly carts = new Map<string, Cart>();

  constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}

  searchProducts(query: ProductSearch = {}): Product[] {
    const terms = query.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return PRODUCTS.filter((product) => {
      if (!product.inStock) return false;
      if (query.category && product.category !== query.category) return false;
      if (query.playStyle && product.playStyle !== query.playStyle) return false;
      if (query.maxPriceUsd !== undefined && product.priceUsd > query.maxPriceUsd) return false;
      if (terms.length === 0) return true;
      const haystack = [
        product.name,
        product.summary,
        product.category,
        product.playStyle,
        product.level,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  getProduct(id: string): Product {
    const product = PRODUCTS.find((candidate) => candidate.id === id);
    if (!product) throw new StorefrontError("product_not_found", "Product not found.");
    return product;
  }

  createCart(input: CreateCartInput): Cart {
    const items = input.items.map(({ productId, quantity }) => {
      const product = this.getProduct(productId);
      if (!product.inStock) {
        throw new StorefrontError("product_unavailable", `${product.name} is unavailable.`);
      }
      return {
        product,
        quantity,
        lineTotalUsd: money(product.priceUsd * quantity),
      };
    });
    const cart: Cart = {
      id: `cart_${this.createId()}`,
      items,
      totalUsd: money(items.reduce((sum, item) => sum + item.lineTotalUsd, 0)),
      currency: "USD",
      status: "draft",
    };
    this.carts.set(cart.id, cart);
    return cart;
  }

  prepareCheckout(input: PrepareCheckoutInput): CheckoutSession {
    const cart = this.carts.get(input.cartId);
    if (!cart) throw new StorefrontError("cart_not_found", "Draft cart not found.");
    const id = `checkout_${this.createId()}`;
    return {
      id,
      cartId: cart.id,
      amountUsd: cart.totalUsd,
      currency: "USD",
      status: "requires_confirmation",
      confirmationUrl: `http://localhost:3000/?checkout=${encodeURIComponent(id)}`,
      simulated: true,
    };
  }
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

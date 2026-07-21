# Pickleball Storefront

This is the flagship agent-native app-backend example. A conventional browser
storefront and the Auggy shopping agent use the same catalog, cart, and checkout
domain service through different adapters.

## What it proves

- Product pages call deterministic routes.
- The agent calls model-facing tools over the same domain service.
- The storefront includes a minimal visitor AG-UI chat over `/agent/run`.
- Route response schemas produce a typed browser client.
- Public chat is bounded by the `budgets` augment.
- The Auggy root redirects to the separately served storefront.
- Checkout is a deterministic handoff, not a model claim.

The example does not charge money or reserve inventory. Checkout sessions are
explicitly marked `simulated: true`; replace the domain adapter with Stripe,
Shopify, or another provider before treating checkout as real.

## Run

```bash
cd examples/pickleball-storefront
bun install
cp .env.example .env
bun run generate:client
auggy doctor
auggy run
```

In a second terminal:

```bash
cd examples/pickleball-storefront
bun run web
```

Open `http://localhost:3000`. Opening Auggy at `http://localhost:8088` redirects
to the same storefront. Set `ANTHROPIC_API_KEY` before using chat; the
deterministic storefront routes do not invoke a model.

## Route and tool pairs

| Shared capability | Deterministic route | Model-facing tool |
| --- | --- | --- |
| Catalog search | `GET /storefront/products` | `storefront_search_products` |
| Draft cart | `POST /storefront/carts` | `storefront_create_draft_cart` |
| Checkout handoff | `POST /storefront/checkout-sessions` | `storefront_prepare_checkout` |

Inspect or regenerate integration artifacts with:

```bash
auggy routes --json
auggy routes --openapi
auggy routes --client ts --target browser --out web/auggy-client.ts
```

## Test

```bash
bun test augments/pickleball-storefront/storefront.test.ts
```

# Concierge Example Requirements

> Archived 2026-07-06. This was the acceptance sketch before the current
> `examples/concierge/` app-backend slice existed. Use
> [`../../../examples/concierge/README.md`](../../../examples/concierge/README.md)
> for the current example.

> `examples/concierge/` is the v1.0 small-business concierge composition demo. The full agent-native app backend proof comes later.

## Why this split exists

The agent-native app backend roadmap has a real 1-8 implementation path:

1. Route visibility and hardening
2. Route builder
3. Typed route schemas
4. App request context
5. Expanded route auth and policy
6. Shared route/tool domain pattern
7. Manifest/OpenAPI/client generation
8. App templates

`examples/concierge/` must not force all of that into v1.0. Shipping the full
app-backend proof before those primitives exist would either over-scope launch
or create a one-off example that teaches patterns the runtime does not support
well yet.

So there are two tiers:

- **v1.0 concierge**: useful composition demo using primitives that exist now.
- **v1.x concierge-app / storefront**: full route/tool/component app-backend proof after the platform primitives land.

## v1.0: concierge composition demo

The v1.0 example should prove:

> Auggy can be configured into a useful domain agent with chat, knowledge, escalation, and deploy.

It should feel like a small-business concierge for a storefront, service business, or boutique operator. It should be concrete enough to understand, but small enough to maintain.

### Required primitives

Use only v1.0-ready primitives:

- `webTransport` for console/chat and deployable HTTP surface
- AG-UI chat via `/agent/run`
- `knowledge` for business policies, services, product notes, FAQ, or operating context
- `turnControl` for missing details
- `notify` for operator escalation
- Optional visitor-auth posture in docs/config comments, but no real email setup required for the happy path

Optional only if setup stays simple:

- `fileMemory` / scaffolded identity and learned behavior
- A tiny custom tool augment with hardcoded/stubbed data, if generated custom augment support is stable enough and does not require the app-backend route work

### Required experience

A developer should be able to:

1. Run the example locally.
2. Open the chat/console.
3. Ask domain questions answered from knowledge.
4. Trigger a `request_input` flow when required details are missing.
5. Trigger notify-to-operator escalation for a high-intent or handoff-worthy request.
6. Deploy or understand how deploy works from the example docs.

### Acceptable domain shape

Pick one simple shape:

- Boutique retail concierge
- Pickleball storefront concierge
- Field-service intake concierge
- Appointment/service concierge

Keep the source of truth simple:

- Markdown knowledge files
- Stubbed JSON/local data if needed
- No external commerce provider
- No real database requirement

### Explicit v1.0 non-goals

Do not require:

- Route builder
- Typed app route schemas
- App request context
- Expanded route auth/policy
- Route/tool shared scaffolds
- Route manifest or OpenAPI export
- Generated TypeScript client
- UI intents or component SDK
- Postgres
- Stripe/Shopify/Square checkout
- Inventory synchronization
- Production custom frontend

The v1.0 example is allowed to be chat-first. It does not need to prove deterministic API routes.

## v1.x: concierge-app / storefront proof

After the app-backend primitives land, build a fuller example or template that proves:

> deterministic app routes and agent-mediated tools can live in the same augment, backed by shared domain logic.

This can be `examples/concierge-app/`, `examples/storefront/`, or a later expanded version of `examples/concierge/`.

### Required app-backend proof

The v1.x version should support both entry modes.

App-first:

- Public homepage at `/`
- Product/service surface backed by deterministic routes
- Lead/quote/order draft route
- AG-UI chat available as support/concierge layer

Chat-first:

- Agent answers from knowledge
- Agent searches/recommends the same product/service data exposed by routes
- Agent saves a lead or quote request by calling a tool over the same domain logic as the route
- Agent can orchestrate route-backed UI intents or links if the experimental UI-intent path exists

### Required architecture

The domain augment should include:

- Shared domain function
- Deterministic HTTP route wrapping the domain function
- Model-callable tool wrapping the same domain function
- Zod schemas or equivalent validation
- Admin/doctor visibility when available
- Tests

Example acceptable routes/tools:

- Route: `GET /services`
- Tool: `service_search`
- Route: `POST /leads/create`
- Tool: `save_lead`

### UI intents

If included, UI intents should remain example-local until the contract is proven.

Acceptable:

- `service_card`
- `product_card`
- `lead_form`
- `checkout_handoff` only if checkout is a provider-hosted link, not a custom commerce engine

Rules:

- The agent emits structured data only.
- The frontend owns rendering.
- Component actions call deterministic routes.
- Unsupported UI intents degrade gracefully.

Do not introduce a stable component SDK in the example before the strategy work justifies it.

## Launch decision

For v1.0, ship the concierge composition demo only.

Do not charge through the 1-8 app-backend roadmap before launch unless the release goal explicitly changes from OSS v1 to app-backend platform launch.

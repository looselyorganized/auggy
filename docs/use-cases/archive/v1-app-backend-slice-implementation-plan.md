# v1.0 App Backend Slice Implementation Plan

> Archived 2026-07-06. This was an execution handoff for the initial
> app-backend slice. Current route/client/authz behavior lives in
> [`../../25-generated-route-clients.md`](../../25-generated-route-clients.md),
> [`../../26-delegated-authorization.md`](../../26-delegated-authorization.md),
> and the current roadmap.

> Handoff doc for implementing the smallest launch-worthy proof of Auggy as an agent-native app backend.

## Goal

Prove this before launch:

> A custom augment can expose deterministic HTTP routes and model-callable tools over shared domain logic, and operators can inspect the exposed routes.

This is **not** the full app-backend roadmap. It is a thin, future-compatible slice that makes the category believable without building a generic web framework.

## Product name

Call this:

**v1.0 App Backend Slice**

Do not call it:

- Full app-backend platform
- Route framework
- Component SDK
- Web framework
- Finished 1-8 roadmap

## Runtime facts at original slice start

Original primitives this slice built on:

- Augments already support `httpRoutes?: AugmentHttpRoute[]`.
- `webTransport` already collects and dispatches augment routes.
- Route auth is currently `auth: "bearer" | "none"`.
- Routes are currently exact-match `GET` and `POST`.
- Dispatcher already enforces body cap, timeout, route-level rate limit, and bearer auth for non-`none`.

Current runtime has since added route groups, path params, route manifests,
OpenAPI export, and visitor route auth (`visitor.optional` /
`visitor.required`). Treat this document as the original implementation plan,
not the current API reference.

Relevant files:

- `src/types.ts` — `AugmentHttpRoute`, `Augment`, route auth types
- `src/kernel/route-collector.ts` — route validation/collection
- `src/transports/web-transport.ts` — route dispatch
- `src/cli/commands/doctor.ts` — likely place for route inventory
- `src/helpers.ts` / `src/index.ts` — public helper exports
- `examples/concierge/` — new example

## Build now

### 1. Route inventory

Add operator visibility for registered augment routes.

Preferred minimum:

- `auggy doctor` lists augment HTTP routes when resolving an agent.

Acceptable fallback:

- startup output lists augment HTTP routes.

Each row should include:

- method
- path
- augment name
- auth mode
- warning marker for `auth: "none"`

Example output shape:

```text
Augment routes
  GET  /services       concierge-services   none   PUBLIC
  POST /leads/create   concierge-services   none   PUBLIC
```

For v1.0, this can be simple text. No route manifest required.

### 2. Tiny route helper

Add a small ergonomic wrapper over existing `httpRoutes`. This should compile to the current `AugmentHttpRoute` contract.

Target API direction:

```ts
import { defineRoute, json } from "auggy";

const routes = [
  defineRoute.get("/services", {
    auth: "none",
    query: ServiceSearchQuerySchema,
    handler: async ({ query }) => {
      return json(searchServices(query));
    },
  }),

  defineRoute.post("/leads/create", {
    auth: "none",
    body: CreateLeadSchema,
    handler: async ({ body }) => {
      return json(createLead(body), 201);
    },
  }),
];
```

Keep it intentionally small:

- `defineRoute.get(path, opts)`
- `defineRoute.post(path, opts)`
- `json(data, status?)`
- parse/validate query for `GET`
- parse/validate JSON body for `POST`
- return 400 on Zod validation failure

Do not build:

- path params
- nested routers
- middleware
- OpenAPI
- generated clients
- expanded auth
- route-level visitor identity

### 3. Minimal schema validation

Support only:

- `query` schema for `GET`
- JSON `body` schema for `POST`

Use Zod.

Behavior:

- invalid query/body -> `400`
- response should be JSON
- keep error body simple and non-leaky

Acceptable error shape:

```json
{ "error": "bad-request", "message": "Invalid request" }
```

Do not build response validation yet unless it is nearly free.

### 4. Minimal request context

Route helper handler context should include:

```ts
{
  request: Request;
  signal: AbortSignal;
  route: { method: "GET" | "POST"; path: string };
  query?: unknown;
  body?: unknown;
}
```

No full route identity work in v1.0.

Do not solve:

- visitor token resolution for arbitrary app routes
- agent identity on app routes
- creator-vs-visitor route auth beyond existing bearer/none
- CSRF/CORS framework

### 5. Keep auth simple

Only support current route auth:

- `auth: "bearer"`
- `auth: "none"`

Document that richer route auth is v1.x:

- `visitor.required`
- `agent.required`
- `creator`
- webhook signatures
- trust allowlists

### 6. Shared domain pattern

The example must show the durable pattern:

```text
domain.ts   # business logic
schemas.ts  # shared Zod schemas
index.ts    # augment factory: routes + tools call domain functions
```

Route and tool wrappers must call the same domain functions.

Example:

```ts
// domain.ts
export function searchServices(input: ServiceSearchQuery): ServiceResult[] {
  ...
}

// route wrapper
defineRoute.get("/services", {
  query: ServiceSearchQuerySchema,
  handler: async ({ query }) => json(searchServices(query)),
});

// tool wrapper
defineTool({
  name: "service_search",
  input: ServiceSearchQuerySchema,
  execute: async (input) => JSON.stringify(searchServices(input)),
});
```

## Concierge example

Create or update:

```text
examples/concierge/
```

Minimum domain:

- Small-business service or storefront concierge.
- Pick one concrete shape: boutique retail, pickleball storefront, field-service intake, or appointment concierge.

Required app-backend proof:

- `GET /services`
- `POST /leads/create`
- `service_search` tool
- `save_lead` tool
- shared `domain.ts`
- shared `schemas.ts`

Required Auggy composition:

- `webTransport`
- `knowledge`
- `turnControl`
- `notify` if practical without secrets; file/local destination is fine
- optional visitorAuth posture in docs/config comments, not required for happy path

Required user story:

1. Visitor can call `GET /services` directly.
2. Visitor can chat and ask for help choosing a service/product.
3. Agent calls `service_search`.
4. Agent can save a lead/quote request by calling `save_lead`.
5. Direct route `POST /leads/create` and tool `save_lead` use the same domain function.
6. High-intent lead triggers notify/operator escalation if practical.

## Tests

Add focused tests. Do not overbuild.

Route helper tests:

- `GET` query validation passes parsed query to handler.
- invalid query returns 400.
- `POST` JSON body validation passes parsed body to handler.
- invalid body returns 400.
- helper returns valid `AugmentHttpRoute`.

Doctor/inventory tests:

- route inventory includes method/path/augment/auth.
- `auth: "none"` route is visibly marked public.

Concierge example tests, if practical:

- domain search returns expected service.
- lead creation route and tool call same domain path or produce equivalent record.

## Non-goals before launch

Do not build:

- path params
- route groups beyond a thin helper
- expanded route auth modes
- visitor/customer auth for arbitrary app routes
- CORS/CSRF framework
- idempotency framework
- OpenAPI export
- TypeScript client generation
- component registry
- UI intents
- Postgres integration
- Stripe/Shopify/Square
- generic middleware
- production storefront frontend

## Acceptance criteria

This slice is done when:

- A custom augment can declare route helpers that compile to `httpRoutes`.
- A route can validate GET query or POST JSON body with Zod.
- A route can return JSON through a helper.
- Operator can inspect exposed augment routes.
- Public routes are clearly marked.
- `examples/concierge/` has at least one deterministic route.
- `examples/concierge/` has at least one tool over the same domain function.
- Docs call this the **v1.0 App Backend Slice**, not the finished platform.

## Rework budget

Expected future rework should stay low if this is built as a thin layer over future-shaped APIs.

Low-rework choices:

- Use Zod now.
- Keep helper names close to future route builder.
- Keep domain logic separate from route/tool wrappers.
- Keep auth explicit and document limits.
- Avoid example-only routing hacks.

High-rework choices to avoid:

- custom route parsing inside the example
- one-off helper APIs that will be replaced
- hardcoding route inventory only in `webTransport`
- teaching `auth: "none"` as suitable for customer-specific routes
- adding UI components before route/tool primitives are stable

## Suggested implementation order

1. Add route helper + tests.
2. Export helper from public API.
3. Add route inventory to doctor or startup.
4. Build concierge domain augment with shared domain/schema files.
5. Wire concierge agent config and knowledge.
6. Add README for the example explaining route vs tool.
7. Verify local run and focused tests.

Stop if the work starts pulling in expanded auth, generated clients, components, or database integrations.

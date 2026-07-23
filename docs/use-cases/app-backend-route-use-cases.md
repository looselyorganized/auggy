# App Backend Route Use Cases

> Practical route patterns developers should build when using Auggy as an agent-native app backend.

## Core idea

Routes are the deterministic rails. Tools are the agent's hands. Augments are
the business capability that owns both.

A developer using Auggy should build routes for anything that needs to be
repeatable, typed, auditable, fast, or state-changing. The agent should use
tools over the same domain logic when conversation, judgment, memory,
clarification, or escalation is useful.

The important product boundary is:

> Use `/agent/run` when the user needs conversation. Use a tool when the agent
> needs to perform a typed capability during conversation. Use a route when the
> app, frontend, webhook, outside service, or route-backed component needs
> deterministic behavior.

This is what turns Auggy from "chatbot plus API" into an agent-native app
backend: one augment can own catalog, search, checkout, booking, intake,
account lookup, policy, tools, admin visibility, memory, and notifications.

## Current route surface

The current route surface is intentionally small, but complete enough for
useful app-backend integrations:

- `GET` and `POST`
- Exact paths and full-segment path params such as `/orders/:id`
- `auth: "none"`, `"bearer"`, `"creator"`, `"visitor.optional"`,
  `"visitor.required"`, or `"agent.required"`
- Per-route body caps
- Per-route timeouts
- Per-route rate limits
- Request schema metadata for params, query, and JSON body
- Successful response schemas for generated-client `data` typing
- Ordered request and response media types preserved across manifests,
  OpenAPI, the console, and generated clients
- Delegated `requires` for app-minted scopes/grants on visitor routes
- Webhook signature policy metadata, with Stripe verification shipped
- Route manifest and OpenAPI-style inspection through `auggy routes`
- Self-contained generated TypeScript route clients through
  `auggy routes [name] --client ts [--target browser|server] [--out file]`

That is enough for many useful app primitives. It is not a full replacement for
Express, Fastify, Rails, Next.js, Supabase, Shopify, Stripe, or a general web
framework.

The disciplined pitch is:

> Custom augments can add small, policy-aware API surfaces beside the agent
> runtime.

## Route classes developers should build

| Route kind | Example routes | Typical auth | Why it wins with Auggy |
| --- | --- | --- | --- |
| Public discovery/read | `GET /catalog/search`, `GET /services`, `GET /products/:id`, `GET /policies/shipping` | `none` or `visitor.optional` | Frontends and outside agents can inspect real data without a model call. The chat agent uses matching tools for recommendation. |
| Lead and intake capture | `POST /leads/create`, `POST /quote-requests`, `POST /support/intake` | `none` or `visitor.optional` | Forms work normally; chat can collect missing fields and call a matching tool; high-intent cases can trigger `notify`. |
| Draft state | `POST /orders/draft`, `POST /cart/items`, `POST /quotes/draft`, `POST /appointments/hold` | `visitor.optional` or `visitor.required` | The model can prepare consequential actions without pretending they are complete. The route writes the draft. |
| Final handoff | `POST /checkout/create`, `POST /quotes/:id/accept`, `POST /appointments/:id/confirm` | `visitor.required` | Payment, booking, and acceptance happen through deterministic route-backed flows, not model text. |
| Account lookup | `GET /orders/:id`, `GET /account`, `GET /tickets/:id/status` | `visitor.required` | The agent can ask the visitor to verify first, then safely retrieve private state through the same domain logic. |
| Webhooks and callbacks | `POST /webhooks/stripe`, `POST /webhooks/agentmail`, `GET /visitor-auth/verify` | `webhook.signature("stripe", ...)` or `webhook.signature("svix", ...)`; providers without a verifier remain handler-verified | External systems update state without waking the model. Failures can notify the operator. |
| Operator/admin actions | `POST /catalog/sync`, `POST /leads/:id/notes`, `POST /admin/reindex` | `bearer` or `creator` | Creator-only maintenance and back-office actions. Auggy's bearer protects Auggy from the app server; a public app wrapper must still verify its own session, explicit operator role, Origin, and CSRF before attaching that bearer. |
| Route-backed UI components | `GET /availability`, `POST /slot-holds`, `POST /checkout/create` | Mixed | Chat can render a picker, card, form, or handoff, but the buttons call routes. The frontend renders UI; the model emits intent. |
| Agent-peer read/action API | `GET /.well-known/agent-card.json`, `GET /catalog/search`, `POST /carts/draft` | Public read; admitted agent or delegated visitor for action | Future Link/A2A commerce and delegation. Outside agents can discover, compare, and prepare drafts safely. |

## The route/tool/domain pattern

Business logic should live once, then routes and tools should wrap it
differently.

```ts
defineRoute.post("/leads/create", {
  auth: "visitor.optional",
  body: CreateLeadSchema,
  maxBodyBytes: 8192,
  rateLimit: { maxPerMinute: 10 },
  handler: ({ body, auth }) => json({ lead: saveLead(body, { auth }) }, 201),
});

defineTool({
  name: "save_lead",
  description: "Save a lead for creator follow-up.",
  category: "business",
  input: CreateLeadSchema,
  execute: async (input) => JSON.stringify({ lead: saveLead(input) }),
});
```

The route path is deterministic software. The tool path is agent-mediated. Both
should share validation, database access, audit rules, and operator policy.

The current concierge example demonstrates this directly:

- `GET /services` and `service_search` both call service search domain logic.
- `POST /leads/create` and `save_lead` both call lead capture domain logic.
- High-intent leads can hand off to `notify` for operator attention.

## Winning verticals

### Boutique retail or pickleball storefront

Routes:

```text
GET  /catalog/search
GET  /products/:id
POST /leads/create
POST /cart/draft
POST /checkout/create
GET  /orders/:id
POST /webhooks/stripe
```

Tools:

```text
catalog_search
recommend_products
create_draft_cart
lookup_order
save_lead
send_checkout_link
```

Why it works:

- Product pages stay fast and deterministic.
- A visitor can ask, "I am new. What paddle should I buy?"
- The agent searches the same catalog route/domain data the frontend uses.
- The agent can explain tradeoffs, create a draft cart, and hand off to a
  provider checkout route.
- Order lookup requires `visitor.required`.
- Stripe or Shopify webhooks update order state without a model call.

This is the clearest app-first and chat-first crossover. The same commerce
augment can power product pages, chat recommendations, draft cart creation,
order lookup, checkout handoff, and payment webhooks.

### Field-service dispatcher

Routes:

```text
GET  /services
GET  /coverage
POST /intake/create
POST /intake/:id/photo
GET  /availability
POST /appointments/hold
POST /appointments/:id/confirm
```

Tools:

```text
service_search
check_coverage
create_intake
hold_appointment
notify_dispatcher
```

Why it works:

- The agent can ask clarifying questions before a rigid form would know what to
  ask.
- The route layer owns intake records, uploaded evidence, slot holds, and
  booking state.
- Urgent cases can trigger `notify`.
- The frontend can still call availability and booking routes directly.
- The agent can move a messy visitor request into structured operational state.

This is strong for HVAC, cleaning, repair, landscaping, medical intake,
specialty consulting, and any business where the hard part is turning vague
visitor intent into dispatchable work.

### Appointment concierge

Routes:

```text
GET  /availability
POST /slot-holds
POST /bookings/confirm
POST /bookings/:id/cancel-request
```

Tools:

```text
find_slots
hold_slot
explain_booking_policy
request_confirmation
```

Why it works:

- Chat is often a better entrypoint than a scheduling form.
- Final booking must still be deterministic.
- A route-backed slot picker is safer than the model saying "you are booked."
- Calendar webhooks can update availability without involving the model.
- The agent can explain cancellation rules, collect preferences, and guide
  rescheduling.

The best version is a chat-first flow where the agent narrows intent, then
serves a route-backed slot picker. The component calls deterministic
availability and hold routes, returns confirmed state, and the agent continues
from that state.

### Quote and proposal workflow

Routes:

```text
POST /quote-requests
GET  /quote-requests/:id
POST /quotes/draft
POST /quotes/:id/accept
POST /webhooks/payment
```

Tools:

```text
create_quote_request
draft_quote
lookup_quote
explain_quote
notify_operator
```

Why it works:

- The agent collects messy requirements better than a static quote form.
- The route stores the durable request and draft quote.
- The operator can review or approve before sending.
- Quote acceptance happens through a route-backed confirmation flow.
- Payment completion comes from a provider webhook, not model text.

This is strong for agencies, trades, event vendors, custom manufacturing,
professional services, and B2B sales.

### Internal support and operations

Routes:

```text
GET  /assets/:id
POST /tickets/create
GET  /tickets/:id/status
POST /tickets/:id/notes
POST /tickets/:id/escalate
```

Tools:

```text
lookup_asset
create_ticket
summarize_ticket
escalate_ticket
```

Why it works:

- Employees chat naturally, but ticket state stays deterministic.
- The agent can summarize, triage, and route requests.
- `visitor.required` or a future `staff` trust tier can gate internal state.
- The route layer creates the ticket, writes notes, and records escalation.
- Admin visibility and audit matter more than generative polish.

This shape fits IT helpdesks, facilities teams, support desks, procurement, HR
ops, and internal platform teams.

### Customer support with verified lookup

Routes:

```text
POST /visitor-auth/request
GET  /visitor-auth/verify
GET  /orders/:id
GET  /returns/policy
POST /returns/draft
POST /tickets/create
```

Tools:

```text
request_auth
lookup_order
draft_return
create_support_ticket
explain_policy
```

Why it works:

- Public policy questions can be answered from knowledge and public routes.
- Account-specific state waits for visitor verification.
- The agent asks for authentication, then calls tools over the same private
  domain functions as `visitor.required` routes.
- The model can explain options, but refunds, return labels, credits, and
  escalations should be route-backed.

This is the safer version of an AI support agent: conversational surface,
deterministic state, explicit identity.

## Route-backed UI intents

Chat-first does not mean the model renders UI. The safer pattern is:

1. The agent decides a structured action is needed.
2. The agent returns a UI intent or route-backed link.
3. The frontend renders a known component.
4. The component calls augment routes.
5. The route returns confirmed state.
6. The chat thread receives the result.
7. The agent continues from confirmed state.

Useful initial component intents:

- `product_card`
- `product_picker`
- `service_card`
- `lead_form`
- `appointment_slot_picker`
- `checkout_handoff`
- `confirmation_form`
- `upload_form`

The frontend owns rendering. The agent emits structured data only. Unknown UI
intent types should degrade to text or be ignored.

## Agent-peer and delegated-agent routes

The longer-term route opportunity is not "any outside assistant can call any
Auggy site." Outside assistants need discovery and authorization.

Useful layers:

- Public discovery/read path: public catalog, policy, service, agent-card, and
  route manifest surfaces.
- Admitted agent-peer path: Link/A2A-style peer traffic with configured
  credentials and `trustLevel: "agent"`.
- Delegated app-auth path: shipped app-signed assertions let an app backend pass
  explicit scopes/grants from Supabase, Clerk, or custom auth into Auggy.
- Delegated visitor consent path: future scoped, revocable, short-lived visitor
  consent that lets a human authorize an outside agent to act on their behalf.

Safe flow:

1. User asks an outside assistant to find or prepare something.
2. The assistant discovers the Auggy app surface.
3. Public routes answer product, service, availability, sizing, policy, and
   return questions.
4. If account-specific state is needed, the user verifies, the app backend mints
   a scoped assertion, or a future consent flow grants scoped delegation.
5. The assistant can create a draft cart, booking hold, quote request, or
   checkout handoff.
6. Final purchase, booking, acceptance, or account change happens through a
   deterministic route with explicit auth and audit.

This is the safe version of "my agent talks to your agent." The model can
research, compare, negotiate within policy, and prepare actions, but routes
commit state.

## What not to put behind the model

Do not make the model the only path for:

- Payment capture
- Booking confirmation
- Refunds or credits
- Account lookup
- Password or auth state changes
- Inventory mutation
- Quote acceptance
- Contract acceptance
- Webhook processing
- Admin maintenance
- Durable audit writes

The model can help a visitor understand and prepare those actions. Routes should
complete them.

## Product implications

The strongest scaffolds should show the route/tool/domain pattern on day one:

```bash
auggy augment create catalog --with-route --with-tool --with-admin
auggy augment create transactions --with-route --with-tool --with-db
auggy augment create scheduling --with-route --with-tool --with-webhook
```

Generated augments should include:

- Shared domain function
- Route wrapper
- Tool wrapper
- Zod schemas
- Env validation
- Optional DB connection
- Optional admin info
- Tests
- Example-local UI intents when the template is chat-first or commerce-oriented

The "aha" should be visible in the scaffold: the frontend and the agent are not
two separate products. They are two entry modes into the same augment-owned
capability.

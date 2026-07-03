# App Backend Architecture Strategy

> How Auggy should evolve to support agent-native app backends without becoming a generic web framework.

## North star

Auggy should become the best runtime for apps where an agent is a first-class actor.

The goal is not to replace Express, Rails, Next.js, Supabase, Shopify, Stripe, or a general-purpose CMS. The goal is to make it natural to build applications where deterministic APIs, agent-mediated workflows, memory, identity, tools, admin controls, and operator policy are composed from the same modules.

The core product claim:

> Auggy owns the agent-native backend layer.

In that model, augments are not just tool bundles. They are app capability modules.

## Two first-class entry modes

Agent-native apps should support two equally valid entry modes.

### App-first

The visitor lands on a conventional app or website surface.

- Product pages call deterministic catalog routes.
- Checkout calls deterministic order or payment routes.
- Booking widgets call deterministic scheduling routes.
- Chat calls `/agent/run` when conversation is useful.
- The agent helps with recommendation, memory, clarification, escalation, and exception handling.

This is the familiar "site with agent" shape, but the agent is not bolted on. The same augments that power the app routes can also expose tools and context to the agent.

### Chat-first

The visitor lands directly in a chat experience.

- The visitor asks for what they want.
- The agent uses tools over the same domain logic that backs app routes.
- The agent can render, link to, or orchestrate deterministic components for authentication, purchase, booking, upload, and confirmation.
- Route-backed components complete consequential steps without relying on free-form model output.

This is not "send every operation through the model." It is a chat shell over deterministic app capabilities.

The principle:

> Chat can be the interface, but routes remain the rails.

Examples:

- Authentication: the agent calls `request_auth`, then the visitor completes `/visitor-auth/verify`.
- Purchase: the agent recommends products, then serves a Stripe, Shopify, or Square checkout link/component.
- Booking: the agent finds available slots, then renders a slot picker backed by scheduling routes.
- Order lookup: the agent requests verification, then calls a tool over the order domain logic.
- Upload: the agent asks for a photo, then provides an upload component backed by an intake route.
- Quote: the agent collects requirements, creates a draft quote, and asks the visitor to confirm in a route-backed UI.

The app-first and chat-first modes should use the same augment architecture. The difference is which surface initiates the flow.

## Augments as app capability modules

A serious app augment should be able to own:

- HTTP routes for deterministic app traffic
- Tools for agent-mediated traffic
- Component or UI intents for chat-first flows
- Context and memory for model state
- Admin surfaces for operator diagnostics and actions
- Lifecycle for DB setup, migrations, validation, and cleanup
- Policy for trust, rate limits, auth, idempotency, audit, and approval

This is the key architectural shape:

**One capability, multiple faces.**

Example: a `transactions` augment can serve `POST /transactions/create` for the frontend, expose `lookup_transaction` to the model, validate Postgres config at boot, show recent failures in admin, notify the operator on webhook failures, and apply different policy for public visitors, verified customers, agent peers, and creators.

The route path is deterministic software. The tool path is agent-mediated. Both should share the same domain logic.

In chat-first flows, there is often a third face:

- Component path: the agent emits or links to a route-backed UI component that lets the visitor complete a structured action.

For example, a product picker component can call catalog and cart routes, return the user's selection to the thread, and let the agent continue from confirmed state.

## What to add

### Route groups

The current `httpRoutes` contract is useful but intentionally narrow: exact `GET`/`POST` routes. To support real app development, add a route declaration layer that still compiles down to the existing safe dispatcher.

Possible shape:

```ts
defineAugment({
  name: "transactions",
  routes: routeGroup("/transactions", [
    route.post("/create", createTransaction),
    route.get("/:id", getTransaction),
  ]),
});
```

The route layer should support:

- Path groups
- Path params
- Query parsing
- JSON body parsing
- Response helpers
- Route-local config
- Route manifest generation

Keep it boring and explicit. Do not make it a full web framework.

### Typed route schemas

Routes should optionally declare schemas for:

- `params`
- `query`
- `body`
- `response`
- `errors`

Use Zod, matching Auggy's existing tool schema direction. This creates one validation style across tools and routes, and unlocks better DX:

- Runtime validation
- Generated route docs
- TypeScript client generation
- Safer route/tool shared domain functions
- Cleaner `auggy doctor` diagnostics

### App request context

Raw `Request` is too low-level for app augments. Add an `AppRequestContext` passed to route handlers.

Possible shape:

```ts
interface AppRequestContext {
  requestId: string;
  route: {
    method: string;
    path: string;
    params: Record<string, string>;
  };
  peer?: PeerIdentity;
  auth: RouteAuthState;
  logger: Logger;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}
```

Important distinction: routes are not chat turns. Many routes will have no `PeerIdentity`. But when visitor tokens, bearer credentials, or agent credentials are present, routes should resolve identity consistently with the rest of Auggy.

### Auth modes beyond `bearer` and `none`

For app backends, `auth: "bearer" | "none"` is too coarse. Evolve route auth into structured modes:

- `none`
- `creator`
- `visitor.optional`
- `visitor.required`
- `agent.required`
- `trust: ["creator", "agent"]`
- `webhook.signature`
- `custom`

Examples:

- `/orders/status` requires a verified visitor.
- `/stripe/webhook` requires Stripe signature verification.
- `/transactions/admin` requires creator trust.
- `/agent-api/search` requires admitted agent credentials.

This keeps security posture explicit at the route declaration site.

### Declarative policy before arbitrary middleware

Do not start by adding Express-style arbitrary global middleware. That becomes hard to reason about across augments.

Start with structured route policies:

- Auth
- CORS
- CSRF
- Rate limit
- Body limit
- Timeout
- Idempotency
- Audit
- Cache headers
- Webhook signature verification
- Approval requirements

Augment-local middleware can come later if real use cases require it. The initial product should make common policy visible and inspectable.

### Shared domain functions between routes and tools

This is the most important DX pattern.

Business logic should live once:

```ts
async function createDraftOrder(input: CreateDraftOrderInput, ctx: DomainContext) {
  // validate inventory, create draft, write audit event
}
```

Then routes and tools wrap it differently:

```ts
route.post("/orders/draft", {
  body: CreateDraftOrderSchema,
  auth: "visitor.required",
  handler: async ({ body, ctx }) => createDraftOrder(body, ctx),
});

defineTool({
  name: "create_draft_order",
  input: CreateDraftOrderSchema,
  execute: async (input, ctx) => createDraftOrder(input, toolDomainContext(ctx)),
});
```

The frontend gets deterministic API behavior. The agent gets a safe model-callable operation. The operator gets one audit trail.

For chat-first apps, the same domain function may also be wrapped by a component-backed interaction. The component should call routes, not ask the model to simulate a transaction in text.

The desired flow:

1. Agent decides a structured action is needed.
2. Agent returns a UI intent or route-backed link/component.
3. Component calls augment HTTP routes.
4. Route returns confirmed state.
5. Chat thread receives the result.
6. Agent continues with the confirmed state.

This keeps consequential operations deterministic while preserving chat as the primary interface.

### Agent-served components

Longer term, Auggy should support a small, explicit mechanism for chat-first components.

Possible shape:

- Tool returns structured UI intent.
- AG-UI client renders a known component.
- Component talks to augment HTTP routes.
- Component result is posted back into the thread.
- Agent continues from the result.

Initial component types should be conservative:

- Auth prompt
- Product picker
- Appointment slot picker
- File/photo upload
- Checkout handoff
- Confirmation form

Avoid creating a full generative UI framework. The value is deterministic, route-backed components that let the agent safely orchestrate app workflows from chat.

### UI intent staging

Formalizing agent-served components as a stable framework is a significant product surface. It would eventually require:

- Component registry
- Component schema validation
- AG-UI event integration
- Frontend renderer SDK
- Tool return conventions
- Component result protocol
- Auth and session propagation
- Route action binding
- Error and loading states
- Security model
- Docs, templates, and tests

Do not start there.

Start with **UI intents as data** in a vertical template. A tool or agent response can include a small, structured payload that the example chat client understands:

```ts
{
  content: "Here are three paddles I recommend.",
  ui: [
    {
      type: "product_card",
      props: {
        productId: "paddle-101",
        title: "Beginner Control Paddle",
        price: 89,
        imageUrl: "/catalog/images/paddle-101.jpg",
        buyPath: "/checkout/create"
      }
    }
  ]
}
```

The frontend owns rendering. The agent does not emit arbitrary HTML or JavaScript. Unknown UI intent types degrade to text or are ignored.

Initial component intents should be example-local:

- `product_card`
- `product_picker`
- `checkout_handoff`

Then graduate deliberately:

1. **Example-local convention**: storefront template supports a few hardcoded UI payloads. No global compatibility promise.
2. **Experimental UI intent contract**: structured tool results can carry `ui` payloads under an experimental namespace.
3. **Component registry**: augments can declare component schemas, while frontends still own rendering.
4. **AG-UI integration**: map UI intents onto AG-UI-compatible custom events or state/state-delta patterns.
5. **Stable SDK**: publish renderer helpers after real examples prove the contract.

The trap is making this generic too early. The first product value is not a universal component platform; it is proving that a chat-first Auggy can safely orchestrate deterministic app flows through route-backed UI.

### Route manifest, OpenAPI, and client generation

If Auggy is an app backend, operators and frontend developers need to know what API exists.

Generate:

- Route manifest
- OpenAPI-like JSON
- TypeScript client
- Security posture report
- Public route list
- Webhook route list

This should feed:

- `auggy doctor`
- `/admin`
- deployment output
- frontend scaffolds

#### TypeScript client generation first cut

Status: first cut shipped. It is a generated-client artifact, not a package
runtime export.

The generated client proves frontend consumption without pretending the route
system has a full response contract yet.

Implemented command:

```bash
auggy routes [name] --client ts --target browser
auggy routes [name] --client ts --target server --out src/auggy-client.server.ts
```

Public stance:

- Generate a self-contained TypeScript file first.
- Default to the browser target when `--target` is omitted.
- Do not add a reusable `createAuggyClient` export to the `auggy` package until
  generated clients have survived real examples.
- Treat this as a typed request client, not a full SDK.

Generated API shape:

```ts
const api = createAuggyClient({
  baseUrl: "https://zip.example.com",
  visitorToken: () => localStorage.getItem("visitorToken") ?? undefined,
  onVisitorToken: (token) => localStorage.setItem("visitorToken", token),
});

const result = await api.get("/services/:serviceId", {
  params: { serviceId: "gift-boxes" },
  query: { need: "birthday" },
});

if (result.ok) {
  const data = result.data; // typed when the route declares a success response schema
}
```

Use typed route-path literals (`api.get("/services/:id", ...)`) instead of
generated operation method names. The route path is already the public API, and
literal paths preserve autocomplete without creating naming churn around
`operationId`.

Target split:

- Browser target includes `none`, `visitor.optional`, and `visitor.required`
  routes. It omits bearer, creator, and `agent.required` routes and does not
  generate privileged credential config.
- Server target includes `none`, bearer/creator, and `agent.required` routes.
  It omits visitor-token routes and generates `bearerToken` and
  `agentCredentials` config for server-side/SSR callers.

Client config:

- `baseUrl`
- optional custom `fetch`
- browser target: optional `visitorToken`
- browser target: optional `onVisitorToken`
- server target: optional `bearerToken`
- server target: optional `agentCredentials`
- optional static/dynamic headers

Result model:

- Return `{ ok, status, data, response, visitorToken? }` for every HTTP status.
- Do not throw for non-2xx responses.
- Throw only for network failures or malformed response parsing.
- Parse JSON when the response content type is JSON; otherwise return text.
- Type success `data` when a route declares a response schema.
- Keep `data` as `unknown` for routes without response schemas.
- Keep non-2xx error payloads generic until Auggy has a stable route error
  protocol.

Input typing:

- Type path params, query, and JSON body from the route manifest's request JSON
  schemas.
- Keep JSON Schema support intentionally small: object properties, `required`,
  primitive scalars, arrays, nullable, and enums when easy.
- Degrade unsupported JSON Schema constructs to `unknown` instead of building a
  full JSON Schema compiler. Per-field unsupported-schema comments can come
  later if examples show they are needed.
- Append query arrays as repeated keys, matching the route helper's repeated
  query parsing behavior. Do not comma-join arrays.

Security posture:

- Browser examples should use `auth: "none"`, `visitor.optional`, or
  `visitor.required`.
- Bearer/creator and agent-auth routes are generated only for the server
  target. Generated comments and docs must state clearly: do not ship creator
  bearer tokens or agent credentials to browser code.

CLI behavior:

- `--json`, `--openapi`, and `--client` are mutually exclusive.
- `--target browser|server` applies only to `--client ts`.
- Browser is the default target if `--target` is omitted.
- Without `--out`, print generated TypeScript to stdout.
- With `--out`, write the file and create parent directories.
- Support only `--client ts` initially; reject other formats clearly.

Current tests cover:

- GET path params and required query input typing in generated output.
- POST JSON body input typing in generated output.
- Visitor-token request/response header handling.
- Bearer route generated warning/comment.
- Browser/server target filtering from route auth.
- Query arrays encoded as repeated keys.
- Fetch-like result behavior for non-2xx responses.
- CLI mutual exclusion and `--out` writing.
- Existing `--json` and `--openapi` behavior unchanged.

### App scaffolds

The "aha" should happen in the scaffold.

Useful commands:

```bash
auggy create pickleball --template storefront
auggy augment create transactions --with-route --with-tool --with-db
auggy augment create catalog --with-route --with-tool --with-admin
auggy augment create scheduling --with-route --with-tool --with-webhook
```

The generated augment should show the right pattern from day one:

- Domain function
- Route wrapper
- Tool wrapper
- Schema
- Env validation
- Optional DB connection
- Optional admin info
- Tests
- Example-local UI intents when the template is chat-first or commerce-oriented

## Capability extensions: Link, budgets, and visitorAuth

These extensions are the stronger version of the app-backend thesis. They are
not all launch promises. They show how Auggy's existing primitives can grow into
agent-native applications where humans, agents, and deterministic routes share
one runtime boundary.

### Link: agent-to-agent app backends

Current truth:

- `link` is a preview peer-to-peer A2A-style transport, separate from
  `webTransport`.
- It binds its own HTTP service, admits configured peers with bearer auth, and
  maps admitted peers to `trustLevel: "agent"`.
- Today its model-facing surface is small: `link_list` and text-only
  `link_send`.
- It is not yet open web discovery, a universal Claude integration, or a
  multi-merchant checkout network.

That current shape is still strategically important. It means an Auggy site can
eventually have two public surfaces:

- Browser/app surface: pages, routes, AG-UI chat, visitor auth.
- Agent peer surface: link/A2A endpoint, agent card, admitted peer identity,
  per-peer policy, and agent-trust budgets.

#### Scenario: "Tell Claude to buy shoes"

The corrected version is not "any Claude can magically call any Auggy site."
Claude, or any outside assistant, needs an entrypoint and an authorization
story.

Possible entrypoint layers:

1. **Public discovery/read path**: the merchant Auggy exposes public catalog
   routes, route manifest/OpenAPI, and an agent card. An outside assistant can
   read product and policy data without being trusted.
2. **Admitted agent-peer path**: the outside assistant speaks Link/A2A and
   presents configured credentials. The merchant Auggy sees it as an `agent`
   peer and applies agent-trust policy and budgets.
3. **Delegated visitor path**: a future `visitorAuth`-backed consent flow lets
   the human grant a third-party assistant a short-lived, scoped pass to act on
   the visitor's behalf. This should be route-scoped, revocable, budgeted, and
   unable to access creator credentials.

The safe flow:

1. User asks their assistant to find shoes.
2. The assistant discovers the merchant Auggy's public agent/app surface.
3. The merchant Auggy answers public product, sizing, shipping, and return
   questions from deterministic routes/tools.
4. If account-specific state is needed, the user grants a scoped delegated
   visitor pass or completes visitor auth directly with the merchant.
5. The assistant can create a draft cart or checkout handoff through
   deterministic routes.
6. Payment and final purchase happen through a route-backed checkout component
   or payment provider flow, not by the model saying "purchased" in text.

This is the key product boundary: agents can research, compare, fill carts,
negotiate within policy, and prepare handoffs. Consequential actions still land
on deterministic routes with explicit auth, audit, and user confirmation.

#### Scenario: one Auggy site shops across other Auggy sites

A visitor is on a pickleball Auggy site looking at paddles. The site agent says:

> I can also check partner stores for court shoes that match this setup.

With Link, the local Auggy could become an orchestrator:

1. Visitor gives consent for cross-site search.
2. Local Auggy calls configured partner Auggys via `link_send`.
3. Partner Auggys return structured recommendations, availability, prices, or
   checkout handoff URLs.
4. Local Auggy renders comparison UI intents in the same chat/session.
5. Visitor completes each checkout through the selling merchant's deterministic
   route/component, or through a future federated checkout augment.

What is true now: Link can connect configured Auggy peers and exchange
messages. What is future work: open partner discovery, product schemas,
cross-site consent, multi-merchant checkout, refunds/returns, attribution,
affiliate tracking, and liability/audit handling.

#### Other Link-backed app patterns

- **Internal specialist mesh**: support concierge delegates billing, bug, or
  security questions to specialized internal Auggys.
- **Operational marketplace**: a field-service Auggy asks supplier Auggys for
  part availability, subcontractor windows, or emergency coverage.
- **Procurement/RFP**: a buyer Auggy asks admitted vendor Auggys for quotes,
  with response deadlines and per-vendor spend caps.
- **Travel/event planning**: one concierge Auggy coordinates hotel, transport,
  venue, and ticketing agents, then returns route-backed booking handoffs.
- **Agent-facing support endpoint**: customer-side agents query a SaaS support
  Auggy for docs, status, invoice data, or ticket updates under scoped policy.

### Budgets: runtime work limits for app agents

Current truth:

- `budgets` is a preview kernel-level turn gate.
- It can cap turns and spend by trust level, including `public.anonymous`,
  `public.recognized`, and `agent`.
- It can reject a turn before the model runs.
- It injects a budget-aware preamble so the model can shorten or wrap up as a
  budget depletes.
- It is runtime spend guardrails, not provider-side billing control.

Correction: budgets do not directly control "what the agent can say" in a
semantic policy sense. They control how much work the agent can do and give the
model budget-aware instructions. Content restrictions still belong in identity,
skills, guardrail/policy augments, capability gates, and deterministic domain
logic.

Useful app-backend budget patterns:

- **Public concierge caps**: anonymous visitors get a small number of turns;
  recognized visitors get more; creators bypass.
- **Agent-peer caps**: incoming Link/A2A requests from other agents use
  `caps.agent` so partner agents cannot drain the runtime.
- **Per-partner quotas**: future budgets should split `agent` caps by admitted
  peer id, not only by trust tier.
- **Negotiation work caps**: limit how many turns or how much spend an agent
  can spend negotiating. Price/discount ceilings themselves must be enforced by
  the commerce/domain augment, not by model instruction alone.
- **Quote/estimate budgets**: a supplier Auggy can refuse requests that exceed
  a max analysis budget, or return "needs human review" when the request is too
  complex.
- **Task-level budget envelopes**: a requesting agent can attach a proposed
  budget, TTL, and max-depth. The receiving Auggy can accept, reject, or
  counter before doing work.
- **Cross-agent abuse control**: unknown or newly admitted agents get tiny caps;
  trusted partners get larger caps; revoked peers get no access.
- **Background/retry caps**: scheduled follow-ups, webhook recovery, and
  multi-agent retries should have their own budgets so background work cannot
  quietly consume all user-facing capacity.

Longer term, budgets can become part of the agent-to-agent protocol:

- "This request may spend up to $0.05 or 3 turns."
- "I can answer at summary depth within budget, or escalate for a deeper quote."
- "Partner X has exhausted today's quota; ask for operator approval."

That makes Auggy app backends safer to expose to other agents.

### visitorAuth: human identity, consent, and delegation

Current truth:

- `visitorAuth` is human visitor auth, not agent auth.
- It verifies email ownership with magic links.
- It promotes public-anonymous visitors to recognized visitor identities.
- It gives routes `visitor.optional` and `visitor.required` posture when wired
  through `webTransport`.
- It supports memory continuity when paired with `layeredMemory`.

In app backends, visitorAuth is the bridge between chat, routes, and customer
state:

- A chat-first flow can ask the visitor to verify before order lookup.
- An app-first flow can call `POST /visitor-auth/request` from a login form.
- Customer-specific routes can require `visitor.required`.
- The model sees compact verified-state context, not credentials.
- Tools and routes receive structured auth state, not a natural-language claim.

The deeper extension is **visitor-authorized delegation**.

For "Claude shops for me" or "my personal agent talks to this merchant Auggy,"
the human should not hand over a creator bearer token, raw browser cookie, or
long-lived visitor token. Instead, Auggy could mint a scoped delegation artifact:

- short-lived
- revocable
- bound to a visitor id
- scoped to route groups or actions
- capped by budgets
- optionally bound to a target agent identity
- unable to read private memory unless explicitly allowed
- visible in audit logs and console

This creates a clean separation:

- `visitorAuth` proves the human.
- `agentAuth` or Link proves the calling agent.
- Delegation policy says what that agent may do for that human.
- Routes and tools enforce the final action boundary.

That is the hardening needed before letting outside agents do anything more
than public catalog discovery.

### Design rules for these extensions

- Do not expose creator bearer tokens to browsers, visitors, or external
  agents.
- Do not let the model verify identity from chat claims.
- Do not let Link imply open access; admitted peer identity and public discovery
  are different surfaces.
- Do not let visitor identity automatically flow to partner agents. Share only
  scoped, consented, minimum necessary state.
- Do not treat budgets as billing guarantees; keep provider-side hard caps.
- Do not use budgets as the only safety layer for commerce or negotiation.
  Domain routes must enforce price, inventory, discount, refund, and approval
  policy.
- Do not let agent-to-agent text be the source of truth for purchases,
  bookings, auth, or money movement. Route-backed components and provider flows
  complete those actions.

## What not to build

### Do not build a website builder

Do not chase themes, drag-and-drop editing, CMS primitives, SEO suites, media libraries, or page builders. Auggy can serve a homepage and app surfaces, but it should not compete with Webflow, Squarespace, Shopify storefront themes, or Next.js.

### Do not build a full frontend framework

Make Auggy frontend-friendly, not frontend-owning.

Support:

- AG-UI chat endpoints
- Generated TypeScript clients
- CORS policy
- Route manifests
- Example React/Next integration
- Small route-backed component patterns for chat-first flows
- Experimental UI intent conventions after vertical examples prove them

Avoid:

- Owning routing/layout conventions
- Owning rendering architecture
- Owning CSS/theme systems
- Requiring one frontend stack
- Letting the model emit arbitrary HTML or JavaScript

### Do not build a full ORM or database platform

Support database-backed augments, env validation, migration hooks, and good examples. Let operators choose Drizzle, Kysely, Prisma, raw SQL, SQLite, Postgres, or managed services.

Auggy should make database use clear and safe inside an augment, not become the database abstraction.

### Do not build a generic auth provider

Auggy should own agent-native identity and trust posture:

- Creator
- Public anonymous
- Public recognized
- Agent peer
- Future staff/person tiers

It should integrate with external auth providers where needed, but not become a full OAuth/SSO product.

### Do not build a commerce engine

Build Stripe, Shopify, Square, and order-status augments. Do not build a replacement for them.

The Auggy-specific value is policy, agent mediation, memory, identity, escalation, and audit around commerce actions.

### Do not make every request agent-aware

Deterministic routes should stay deterministic unless the developer explicitly invokes the agent or exposes a tool.

This boundary is important for cost, latency, predictability, and operator trust.

## Architecture boundary

Build:

- Route declaration
- Typed validation
- Route groups and path params
- Auth and trust policy
- Visitor and agent identity resolution for routes
- Rate limits, body limits, timeouts
- Webhook support
- Idempotency support
- Route/tool shared capability pattern
- Route/tool/component shared capability pattern
- Admin and doctor visibility
- App-focused templates

Leave out:

- Generic web framework ambition
- Generic frontend framework
- Generic DB platform
- Generic auth provider
- Generic CMS
- Generic commerce engine
- Agent involvement in every request
- Free-form model simulation of consequential transactions

## Product phrasing

Use:

> Build agent-native apps, not chatbot wrappers.

Use:

> Deterministic APIs and agent-mediated workflows can live in the same augment.

Use:

> Auggy is the agent-native backend layer.

Use:

> Chat can be the interface, but routes remain the rails.

Avoid:

> Auggy is a website builder.

Avoid:

> Auggy replaces your app framework.

Avoid:

> Send every request to the agent.

Avoid:

> Let the model complete purchases, bookings, or auth flows only in text.

## Why this angle is strong

This framing makes Auggy useful before full multi-agent mesh, before self-extending agents, and before a large integration marketplace.

A small business app immediately needs:

- Public pages
- API routes
- Chat
- Visitor identity
- Data storage
- Email or notifications
- Admin visibility
- Deployment

Auggy can make those pieces feel coherent when the app's defining feature is an agent that can talk, remember, act, escalate, and coordinate safely.

That is the wedge: not a chatbot added to an app, but an app built around an agent-native runtime.

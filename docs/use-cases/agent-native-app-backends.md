# Agent-Native App Backends

> API augments let Auggy become an app backend, not only an agent backend.

## The revelation

The interesting part of "I want to build a pickleball site" is not that Auggy can answer pickleball questions. It is that an Auggy project can host normal app/API behavior and agent behavior in the same runtime.

The frontend does not need to send every request to the model. Some requests should be deterministic software:

- Create a lead
- Save a transaction
- Look up an order
- Receive a webhook
- Hold an appointment slot
- Generate a payment link
- Check inventory
- Update a customer profile

Those can be ordinary HTTP routes served by custom augments. The same augment can also expose model-callable tools over the same domain logic when the agent should participate in the workflow.

This creates a useful product thesis:

**Auggy is not just a chatbot runtime. Auggy can be an agent-native app backend.**

## Two entry modes

Agent-native apps can be app-first or chat-first.

### App-first

The visitor lands on a conventional website or app.

- Product pages call catalog routes.
- Checkout calls order and payment routes.
- Forms call lead or booking routes.
- Chat calls `/agent/run`.
- The agent helps when conversation, memory, judgment, or escalation matter.

### Chat-first

The visitor lands directly in chat.

- The visitor asks for what they want.
- The agent uses tools over the same domain logic that backs app routes.
- The agent can serve links or components for authentication, purchase, booking, upload, and confirmation.
- Consequential steps are completed through deterministic route-backed flows.

The principle:

> Chat can be the interface, but routes remain the rails.

This keeps chat-first apps from becoming free-form model simulations of transactions. The model can guide and orchestrate, while routes and components complete the durable work.

## The core pattern

One augment can have multiple faces:

- **HTTP face**: deterministic app/API routes for browser, webhook, and service traffic
- **Agent face**: tools the model can call during chat
- **Component face**: route-backed UI elements the agent can render or link to in chat
- **Context face**: scoped state injected before the model runs
- **Memory face**: durable records owned by the augment
- **Admin face**: operator diagnostics and actions
- **Lifecycle face**: boot validation, DB connection setup, migrations, cleanup

The same business capability can therefore be reached through two paths:

- Direct route path: frontend or webhook calls `POST /transactions/create`
- Agent-mediated path: visitor asks in chat, agent calls `create_transaction`

The route path is deterministic software. The tool path is agent-mediated. Both can share the same validation, database access, audit rules, and operator configuration.

In chat-first flows, the component path is the structured UI bridge between the agent and the deterministic route. The agent recommends, explains, and asks for confirmation; the component performs the exact action against augment routes and returns confirmed state.

## UI intents in chat

Chat-first does not require the model to render arbitrary UI. The safer pattern is for the agent or tool to emit a structured UI intent that the chat client knows how to render.

Example:

```json
{
  "type": "product_card",
  "props": {
    "productId": "paddle-101",
    "title": "Beginner Control Paddle",
    "price": 89,
    "imageUrl": "/catalog/images/paddle-101.jpg",
    "buyPath": "/checkout/create"
  }
}
```

The frontend owns the actual component. The UI intent names a known component and validated props. Button actions call deterministic augment routes such as `/cart/add` or `/checkout/create`; they do not ask the model to simulate a purchase in text.

Formalizing this fully would be a larger product surface: component registry, schemas, AG-UI integration, renderer SDK, result protocol, auth propagation, route bindings, loading/error states, and security rules. The first useful step should be smaller:

- Start with example-local UI intents in a vertical template.
- Support a few hardcoded components such as `product_card`, `product_picker`, and `checkout_handoff`.
- Degrade gracefully when a frontend does not support a UI intent.
- Let real use cases prove the contract before stabilizing it as an Auggy framework.

## Why this matters

Most AI app architectures split the system into pieces:

- Website frontend
- App backend
- Chatbot backend
- Workflow service
- Auth layer
- Database integration
- Admin tools
- Notification system

Auggy can collapse the agent-specific parts of that stack into one modular project. The result is not a generic web framework replacement. It is a runtime for apps where an agent is a first-class operator of the application.

That is a different category from:

- "Website with chatbot"
- "Agent backend behind a frontend"
- "MCP tools wired into an assistant"
- "Workflow automation behind forms"

The stronger category is:

**Agent-native apps: web applications whose API, memory, identity, tools, and operator surfaces are composed from augments.**

## Pickleball site example

A pickleball business wants a storefront and assistant.

The public frontend uses normal app requests:

- `GET /` shows the pickleball storefront.
- `POST /leads/create` saves a buyer lead.
- `POST /orders/create-draft` creates a draft order.
- `GET /catalog/search` returns deterministic catalog results.
- `POST /webhooks/stripe` receives payment events.

The chat uses AG-UI:

- `POST /agent/run` sends visitor messages into the Auggy turn loop.

The same commerce augment can expose tools:

- `catalog_search`
- `create_draft_order`
- `lookup_order`
- `save_lead`
- `send_payment_link`

Now the site can support both experiences:

- A React product page calls API routes directly.
- A visitor asks the agent for beginner paddle recommendations.
- The agent searches the catalog, explains tradeoffs, saves a lead, and asks the operator for approval before sending a discount.
- The agent can render a product picker or checkout handoff backed by catalog/order routes.
- A verified customer asks about an order, and the agent calls the order lookup tool.
- Stripe webhooks update the transaction store without involving the model.

The agent is not in the path for every request. It enters where conversation, judgment, memory, or escalation matter.

## Why augments are the right unit

An API route alone is too small. A tool alone is too small. A database adapter alone is too small.

The useful unit is the business capability:

**Transactions augment**

- Owns Postgres connection and migrations
- Serves `POST /transactions/create`
- Receives payment webhooks
- Exposes `lookup_transaction` to the agent
- Adds transaction status context for verified visitors
- Shows recent transaction health in admin
- Notifies the operator on failures
- Applies public/recognized/creator/agent policy differently

**Catalog augment**

- Serves product search routes for the frontend
- Exposes catalog search and recommendation tools to the agent
- Maintains a source catalog or sync job
- Injects compact catalog policy into context
- Gates wholesale pricing to verified or creator peers

**Scheduling augment**

- Serves availability routes for the frontend
- Exposes booking/hold tools to the agent
- Receives calendar webhooks
- Requires confirmation before final booking
- Notifies staff when a high-intent appointment appears

This is the architectural reason augments are more than tools: they let a domain capability own every surface it needs.

## Where MCP fits

MCP can still be useful inside this picture. A catalog augment could call an MCP server. A support augment could wrap a GitHub MCP server. A CRM augment could delegate reads to an existing MCP connector.

But MCP is not the app boundary.

The app boundary needs:

- HTTP routes
- Auth posture
- Visitor identity
- Agent identity
- Rate limits
- Body limits
- Webhooks
- Operator audit
- Tool exposure policy
- Runtime lifecycle

That is augment territory.

## Product implications

This points to a north star:

**Auggy should feel like the easiest way to build a small agent-operated web app.**

The default experience should make it natural to add:

- A public page
- An AG-UI chat surface
- A custom API route
- A database-backed augment
- A model-callable tool over that same data
- A visitor-auth flow
- An operator notification
- A deploy target

The product should not try to become a full website builder or general-purpose web framework. It should own the agent-native backend layer, then interoperate cleanly with custom frontends.

## What to make obvious in docs and DX

The key concept to teach:

> Not every frontend request goes through the agent. Use routes for deterministic app behavior and tools for agent-mediated behavior. Put both in an augment when they belong to the same capability.

Useful docs and scaffolds:

- "Build a custom API augment"
- "Add Postgres to an augment"
- "Expose the same capability as a route and a tool"
- "When to use `/agent/run` vs your own route"
- "How route auth differs from visitor identity" with the
  [delegated authorization bridge](../26-delegated-authorization.md)
- "How to handle webhooks without model calls"

Useful CLI affordances:

- `auggy augment create transactions --with-route --with-tool`
- `auggy augment create catalog --with-route --with-tool --with-admin`
- `auggy doctor` listing public augment routes, bearer routes, and reserved routes

## Extension thesis: humans, agents, and budgets

The same app-backend shape gets more distinctive when combined with `link`,
`budgets`, and `visitorAuth`.

- `link` can turn Auggy sites into agent-addressable backends for admitted
  agent peers. Today this is preview A2A-style peer traffic between configured
  agents, not open web discovery or universal Claude integration. The long-term
  opportunity is agent-to-agent commerce, support, procurement, and specialist
  delegation over explicit peer auth and route-backed actions.
- `budgets` can cap how much work public visitors, recognized visitors, and
  agent peers are allowed to trigger. It is not semantic content control or hard
  billing control; it is kernel-level work admission plus budget-aware model
  context. Commerce and negotiation limits still belong in deterministic domain
  policy.
- `visitorAuth` proves human identity and enables recognized visitor routes,
  memory continuity, and future visitor-authorized delegation. It should not be
  renamed into agent auth; future agent auth should be a sibling primitive.

The powerful future flow is a consented handoff:

1. A human proves identity with `visitorAuth`.
2. A human authorizes an outside agent or another Auggy with a scoped,
   revocable, short-lived delegation.
3. The outside agent speaks to an Auggy app backend through public routes,
   Link/A2A, or both.
4. Budgets cap the work allowed for that visitor, peer, or task.
5. Deterministic routes/components complete checkout, booking, account lookup,
   or quote acceptance.

This is the safe version of "my agent talks to your agent." The model can
research, negotiate within policy, and prepare actions, but the runtime verifies
identity and the routes commit state.

## Current constraint

The current route surface is intentionally narrow:

- Exact routes and full-segment path params
- `GET` and `POST`
- `auth: "bearer"`, `"creator"`, `"none"`, `"visitor.optional"`,
  `"visitor.required"`, or `"agent.required"`
- Per-route body cap
- Per-route timeout
- Per-route rate limit
- Webhook signature policy metadata in manifests and generated-client target
  filtering; `webhook.signature("stripe", ...)` is runtime verified, while
  other providers still need future verifier slices

That is enough for many app primitives, callbacks, and admin APIs. It is not yet a full Express/Fastify replacement. The pitch should stay disciplined:

> Custom augments can add small, policy-aware API surfaces beside the agent runtime.

## North star

Auggy's long-term wedge is not "chatbots for websites."

It is:

**A modular runtime for agent-native apps, where deterministic APIs and agent-mediated workflows are built from the same augments.**

That is what makes a pickleball site, a field-services dispatcher, a boutique retail concierge, or an internal support facility feel like one coherent system instead of a pile of integrations.

The architectural strategy for extending Auggy in this direction lives in [App Backend Architecture Strategy](./app-backend-architecture-strategy.md).

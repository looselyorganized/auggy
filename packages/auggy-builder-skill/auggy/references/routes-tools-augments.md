# Routes, Tools, And Custom Augments

Use a custom augment when the agent needs app-specific runtime behavior: an API
call, deterministic HTTP route, model-callable tool, webhook handler, storage
integration, or external service bridge.

Create one with:

```bash
auggy augment create <name>
```

Run this from the agent project. The command registers the augment in
`agent.yaml` and asks whether to add a separate runtime skill.

## Structure

Typical custom augment:

```text
augments/<name>/
  augment.yaml
  index.ts
  schemas.ts
  domain.ts
  <name>.test.ts

skills/<name>/
  SKILL.md        # optional usage guidance, not augment source
```

Keep business logic in `domain.ts` or ordinary functions. Routes and tools
should wrap that logic, not duplicate it.

For copyable starter files, inspect
`skills/auggy/assets/templates/custom-augment/`.

## Route/Tool/Domain Pattern

```ts
import { defineAugment, defineRoute, defineTool, json, webhook } from "auggy";
import { z } from "zod";

const ServiceParams = z.object({ id: z.string() });
const ServiceQuery = z.object({ q: z.string().optional() });
const Service = z.object({ id: z.string(), name: z.string() });
const LeadInput = z.object({
  email: z.string().email(),
  need: z.string().min(1),
});
const LeadResponse = z.object({ id: z.string(), saved: z.boolean() });

async function searchServices(query: z.infer<typeof ServiceQuery>) {
  return [{ id: "svc_haircut", name: query.q ?? "Haircut" }];
}

async function saveLead(input: z.infer<typeof LeadInput>) {
  return { id: "lead_123", saved: true, ...input };
}

export default function services() {
  return defineAugment({
    name: "services",
    type: "custom",
    httpRoutes: [
      defineRoute.get("/services", {
        auth: "none",
        query: ServiceQuery,
        response: z.object({ services: z.array(Service) }),
        rateLimit: { maxPerMinute: 60 },
        handler: async ({ query }) => json({ services: await searchServices(query) }),
      }),
      defineRoute.get("/services/:id", {
        auth: "visitor.optional",
        params: ServiceParams,
        response: Service,
        handler: async ({ params }) => json({ id: params.id, name: "Haircut" }),
      }),
      defineRoute.post("/leads/create", {
        auth: "visitor.optional",
        body: LeadInput,
        response: LeadResponse,
        maxBodyBytes: 8192,
        rateLimit: { maxPerMinute: 10 },
        handler: async ({ body }) => {
          const lead = await saveLead(body);
          return json({ id: lead.id, saved: true }, 201);
        },
      }),
      defineRoute.post("/webhooks/stripe", {
        auth: "none",
        policy: webhook.signature("stripe", { secretEnv: "STRIPE_WEBHOOK_SECRET" }),
        maxBodyBytes: 65536,
        handler: async ({ webhook }) =>
          json({ received: webhook?.provider === "stripe", event: webhook?.event }),
      }),
    ],
    tools: [
      defineTool({
        name: "service_search",
        description: "Search services by visitor need or keyword.",
        category: "business",
        input: ServiceQuery,
        execute: async (input) => JSON.stringify({ services: await searchServices(input) }),
      }),
      defineTool({
        name: "save_lead",
        description: "Save a lead for creator follow-up after enough detail is collected.",
        category: "business",
        input: LeadInput,
        execute: async (input) => JSON.stringify({ lead: await saveLead(input) }),
      }),
    ],
  });
}
```

## Route Options

- `auth`: `"none"`, `"visitor.optional"`, `"visitor.required"`, `"creator"`,
  `"bearer"`, or `"agent.required"`.
- `params`: Zod schema for `:path` params.
- `query`: Zod schema for URL query values.
- `body`: Zod schema for POST JSON body.
- `response`: Zod schema for successful JSON output. This types generated
  client success `data`.
- `requires`: delegated authorization scopes/grants enforced by Auggy.
- `policy`: webhook-signature policy such as `webhook.signature("stripe")`.
- `maxBodyBytes`, `timeoutMs`, `rateLimit`: deterministic safeguards.

## Route Classes

Build routes for:

- public discovery/read: `GET /catalog/search`, `GET /services`
- lead/intake capture: `POST /leads/create`, `POST /support/intake`
- draft state: `POST /orders/draft`, `POST /appointments/hold`
- final handoff: `POST /checkout/create`, `POST /quotes/:id/accept`
- account lookup: `GET /orders/:id`, `GET /account`
- webhooks: `POST /webhooks/stripe`
- operator actions: `POST /admin/reindex`

Use matching tools when the agent should mediate the same capability.

## Validation

After changes:

```bash
auggy augment test ./augments/<name>
auggy routes
```

If an app consumes the routes, regenerate clients. See
`skills/auggy/references/generated-clients.md`.

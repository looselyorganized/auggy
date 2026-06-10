# Concierge Example

This example starts from `auggy create concierge`, then adds `knowledge`, `notify`, and a local custom augment.

It demonstrates the v1.0 app-backend slice: one custom augment exposes deterministic HTTP routes and model-callable tools over the same domain logic.

## What it demonstrates

- `GET /services` for public service search
- `POST /leads/create` for public lead capture
- `service_search` for model-driven service lookup
- `save_lead` for model-driven lead capture
- Shared `domain.ts` and `schemas.ts`
- `knowledge` for local business context
- `notify` with a local file destination for high-intent escalation

## Run

```sh
bun install
auggy doctor
auggy run
```

Set `ANTHROPIC_API_KEY` in `.env` before chatting.

## Try the app routes

```sh
curl "http://localhost:8080/services?need=gift"

curl -X POST "http://localhost:8080/leads/create" \
  -H "content-type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","need":"A birthday gift package","timeline":"this week","budgetUsd":250}'
```

`auggy doctor` lists the custom routes and marks public routes (`auth: "none"` or
`auth: "visitor.optional"`) as public.

This example intentionally keeps app routes public. In production, prefer
`auth: "visitor.required"` for customer-specific data, `auth: "bearer"` for
creator/admin actions, and `auth: "none"` only for intentionally public routes
or external callbacks.

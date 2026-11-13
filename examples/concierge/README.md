# Concierge Example

This is a **legacy compatibility example** built from the earlier `auggy create`
layout, with referenced augment YAML and custom source under `augments/`. It
remains runnable; it does not represent the unreleased authoring scaffold.

New projects expose owned `src/index.ts`, `src/agent.ts`, `src/http.ts`, and
`src/turn.ts`, with one inline enabled graph in `agent.yaml` and new custom
modules under `src/augments/`. See [the current generated layout](../../README.md#what-gets-created)
and [the inspectable application reference](../inspectable-agent/README.md).
`auggy inspect` reports this example's actual legacy declarations. Before using
graph-changing commands, preview `auggy migrate`; application adoption is a
separate `--application` choice. Neither migration mode relocates existing custom
source. See [migration and recovery](../../docs/16-storage-layout.md#creation-migration-and-recovery).

The example demonstrates one custom augment exposing deterministic HTTP routes
and model-callable tools over the same domain logic.

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
cp .env.example .env
auggy doctor
auggy run
```

Set `ANTHROPIC_API_KEY` in `.env` before chatting. Set `AUGGY_WEB_TOKEN` to
any long local secret if you want to open `/console`.

## Try the app routes

```sh
curl "http://localhost:8080/services?need=gift"

curl -X POST "http://localhost:8080/leads/create" \
  -H "content-type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","need":"A birthday gift package","timeline":"this week","budgetUsd":250}'
```

`auggy doctor` lists augment routes and marks public routes (`auth: "none"` or
`auth: "visitor.optional"`) as public.

This example intentionally keeps app routes public with small body/rate caps.
In production, prefer
`auth: "visitor.required"` for customer-specific data, `auth: "bearer"` for
creator/admin actions, and `auth: "none"` only for intentionally public routes
or external callbacks.

For an existing-app login bridge with Supabase/Clerk-style session verification,
generated browser clients, and delegated route/tool authorization, see
[`../app-auth-bridge`](../app-auth-bridge/README.md).

# Auggy Mental Model

Auggy is a TypeScript framework/runtime for agent-native app backends. It is
not only a chat SDK and not only an LLM wrapper.

The core product idea:

- Use routes when software should decide.
- Use tools when the agent should mediate.
- Put shared domain logic behind both when they represent the same capability.
- Keep auth, authorization, route exposure, memory, rate limits, and operator
  posture as deterministic runtime behavior.

## Primitives

| Primitive | What it is | Use it for |
| --- | --- | --- |
| Augment | Runtime module mounted at boot | tools, routes, context, memory, transports, lifecycle hooks, policy |
| Route | Deterministic HTTP behavior | apps, webhooks, generated clients, server jobs, route-backed UI |
| Tool | Model-callable function | conversation-mediated lookup, drafting, intake, escalation, action |
| Skill | Markdown teaching file | when and how to use capabilities |
| Knowledge | Fetchable reference material | docs, FAQs, product facts, policies |
| Identity | Durable operator-authored behavior | persona, boundaries, non-negotiable rules |

Augments are infrastructure. Tools are mechanism. Skills are teaching.

## Why Agent-Native Backends Matter

In a normal app, teams often build a form route, a chat tool, a webhook handler,
and an admin job as separate surfaces. They drift:

- validation differs
- auth differs
- rate limits differ
- audit logging differs
- business logic gets copied
- chat can accidentally allow what the app route denies

In Auggy, an augment can own both faces of a capability:

```text
frontend / webhook / server job
  -> deterministic route
  -> shared domain function

agent conversation
  -> model-callable tool
  -> same shared domain function
```

That is the winning architecture when a product needs both normal app UX and
agent-mediated workflows.

## Route Or Tool

Choose a route when the caller already knows what it needs and the system
should respond predictably:

- catalog search
- availability lookup
- lead creation
- account lookup
- checkout handoff
- webhook receive
- admin reindex

Choose a tool when the agent needs to apply judgment:

- decide which catalog query to run
- ask clarifying questions before lead capture
- compare options
- draft a booking request
- escalate to the creator
- use memory and knowledge to tailor the action

Use both when the same capability should work from UI and conversation.

## What Auggy Should Not Replace

Do not frame Auggy as a replacement for Next.js, Supabase, Clerk, Rails,
Fastify, Shopify, Stripe, or Postgres. Auggy sits beside them when the app
needs an agent-native backend: deterministic routes and model-mediated tools
with shared runtime policy.

Keep existing auth providers, databases, frontends, and payment systems. Let
Auggy mediate agent behavior and own agent-facing runtime boundaries.

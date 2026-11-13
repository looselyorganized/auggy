# Auggy Mental Model

**Turn business operations into agent-ready capabilities.**

Auggy replaces one-off integration glue with TypeScript augments—controlled,
predictable interfaces that bundle identity, authorization, schemas, tools,
routes, and domain logic. The application remains the system of record.

The core product idea:

- project-owned TypeScript shows startup, HTTP dispatch and turn orchestration,
- a small installed kernel enforces guarded operations,
- augments package the capabilities around those turns,
- agent projects remain ordinary files and TypeScript,
- operators install only what a particular agent needs.

## Primitives

| Primitive | What it is | Use it for |
| --- | --- | --- |
| Agent | Portable configured project | identity, engine, skills, enabled augments |
| Application | Owned `src/index.ts`, `agent.ts`, `http.ts`, `turn.ts` | visible startup, request wiring and turn recipe |
| Kernel | Guarded turn runtime | identity, context, authorization, accounting, cancellation and settlement |
| Augment | Runtime module mounted at boot | tools, context, memory, transports, lifecycle, policy |
| Tool | Typed model-callable function | lookup, drafting, communication, action |
| Skill | Markdown teaching file | when and how to use capabilities |
| Knowledge | Fetchable reference material | docs, FAQs, product facts, policies |
| Identity | Durable operator-authored behavior | persona, boundaries, non-negotiable rules |

Augments are infrastructure. Tools are mechanism. Skills are teaching.

## A Turn

```text
src/index.ts prepares composition and starts the managed host
  -> src/agent.ts binds src/turn.ts to agent.yaml's enabled graph
  -> src/http.ts handles POST /agent/run through web.agentRun(originalRequest)
  -> maintained transport authenticates, validates and schedules the request
  -> src/turn.ts calls prompt, inference, tool and completion operations
  -> a built-in or src/augments/<name>/ adapter performs authorized work
  -> maintained transport returns the durable result
```

Open these files in a generated project; they are the code that executes.
`auggy inspect` reports declared paths and selected installed sources without
running code. The installed runtime and built-ins remain in `node_modules/auggy/src`.
A dependency update changes managed code, while engineers review changes needed
in their own execution recipe and capability adapters.

The runtime is turn-oriented. Optional Durable Jobs persist and schedule one
complete trusted turn on one replica; they do not checkpoint every model/tool
step or replace a durable business workflow engine or system of record.

## Choosing An Extension Point

Use identity for durable persona and safety boundaries.

Use a skill when the agent needs instructions or examples but no new runtime
capability.

Use knowledge when the agent needs reference material fetched on demand.

Use an existing augment for a supported capability such as memory, MCP,
Telegram, notifications, or visitor recognition.

Write a custom augment when the agent needs new tools, integrations, context,
policy, lifecycle behavior, or a transport.

Use preview shell access only when a narrower typed tool cannot solve the task.

## Optional Routes

Custom augments may also expose small deterministic HTTP routes for a frontend,
webhook, or server integration. Route manifests, generated clients, and
delegated app authorization are advanced preview capabilities.

Use a route when software already knows the exact operation it needs. Use a
tool when the model should mediate the operation during a conversation. They do
not need to duplicate each other.

Routes are optional. Auggy is not a replacement for Next.js, Fastify, Rails,
Postgres, an identity provider, or a durable workflow system.

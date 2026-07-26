# Auggy Documentation

Auggy is a small Bun/TypeScript runtime for building self-hosted agents from
composable augments. The kernel runs agent turns; augments add tools, memory,
transports, context, skills, policy, and integrations.

For installation and first-run instructions, start with the root
[`README.md`](../README.md).

## Start Here

- [Product North Star](./01-philosophy.md)
- [Architecture Overview](./02-architecture-overview.md)
- [Built-In Augments](./07-built-in-augments.md)
- [Agent Lifecycle](./08-agent-lifecycle.md)
- [Skills](./11-skills.md)
- [Storage Layout](./16-storage-layout.md)
- [Deploy](./18-deploy.md)
- [Console](./21-console.md)
- [Runtime State Recovery](./27-runtime-state-recovery.md)
- [Delivery and Operator Recovery](./28-delivery-and-operator-recovery.md)
- [Feature Status](./FEATURES.md)

## Mental Model

An Auggy project has four central concepts:

1. **Agent** — a portable project with identity, configuration, skills, and
   enabled augments.
2. **Kernel** — the fixed runtime that receives input, assembles context, calls
   a model, executes tools, and returns a turn result.
3. **Augment** — the single extension surface for tools, context, memory,
   transports, policy, routes, and lifecycle behavior.
4. **Peer** — the human, agent, or system interacting with the runtime.

The current runtime is turn-oriented. It does not yet provide durable workflow
execution or a persistent job queue.

## Source Authority

Use this order when documentation disagrees:

1. **Code in `src/`** defines current behavior.
2. **Numbered reference docs** explain the implemented architecture.
3. **`FEATURES.md`** summarizes current package status.
4. **Use-case documents** are exploratory and may describe optional or future
   applications of existing primitives.
5. **Plans, archived specs, research, and previews** preserve design context;
   they are not public product commitments.

## Runtime Invariants

- `agent.yaml` is the runtime source of truth for an agent project.
- `identity.md` contains stable operator-authored identity and boundaries.
- `skills/` contains model-readable instructions for using capabilities.
- `data/` contains mutable runtime and augment state.
- Secrets live in `.env` or provider-owned systems, not prompt-visible files.
- Authentication and authorization are deterministic runtime decisions; the
  model does not decide who a caller is or what they may do.
- Learned or peer-derived memory is not injected as operator-authored truth.
- Built-in and custom behavior use the same augment boundary.

## Reference Documentation

| Doc | What it covers |
| --- | --- |
| [Feature Status](./FEATURES.md) | Current core, add-on, and preview capability status |
| [01 Product North Star](./01-philosophy.md) | Product purpose, engineering value, ownership boundaries, and positioning |
| [02 Architecture Overview](./02-architecture-overview.md) | Module map and turn data flow |
| [03 Types](./03-types.md) | Shared runtime contracts |
| [04 Kernel](./04-kernel.md) | Turn loop, context allocation, history, and tool execution |
| [05 Memory Subsystem](./05-memory-subsystem.md) | Memory providers, registry, and tools |
| [06 Transports](./06-transports.md) | Transport contract and AG-UI web transport |
| [07 Built-In Augments](./07-built-in-augments.md) | Built-in augment catalog and configuration |
| [08 Agent Lifecycle](./08-agent-lifecycle.md) | `defineAgent`, handles, and lifecycle hooks |
| [09 Testing](./09-testing.md) | Test strategy and fixtures |
| [10 System Diagrams](./10-system-diagrams.md) | Runtime architecture diagrams |
| [11 Skills](./11-skills.md) | Skill folders and model-facing instructions |
| [12 Budgets](./12-budgets.md) | Preview spend guardrails |
| [13 Notify](./13-notify.md) | Outbound notification augment |
| [14 Telegram Transport](./14-telegram-transport.md) | Telegram setup and identity mapping |
| [16 Storage Layout](./16-storage-layout.md) | Agent project layout and runtime data |
| [17 Turn Control](./17-turn-control.md) | Input-required turns |
| [18 Deploy](./18-deploy.md) | Railway deployment and recovery |
| [19 Visitor Auth](./19-visitor-auth.md) | Email magic-link recognition |
| [20 Embedding](./20-embedding.md) | Browser and AG-UI integration |
| [21 Console](./21-console.md) | Creator console |
| [22 Agent Mail](./22-agent-mail.md) | AgentMail augment |
| [24 MCP](./24-mcp.md) | Local and remote MCP servers |
| [25 Generated Route Clients](./25-generated-route-clients.md) | Preview route manifests and clients |
| [26 Delegated Authorization](./26-delegated-authorization.md) | Preview app-session authorization bridge |
| [27 Runtime State Recovery](./27-runtime-state-recovery.md) | State inventory, offline volume bundles, restore fencing, and operator boundaries |
| [28 Delivery and Operator Recovery](./28-delivery-and-operator-recovery.md) | Replay, outcome-unknown, and creator recovery contracts by transport |

## Common Add-Ons

### Knowledge and memory

- [Memory Subsystem](./05-memory-subsystem.md)
- [Built-In Augments: Knowledge](./07-built-in-augments.md)
- [Visitor Auth](./19-visitor-auth.md)

### Tools and integrations

- [MCP](./24-mcp.md)
- [Notify](./13-notify.md)
- [AgentMail](./22-agent-mail.md)

### Channels

- [Web Transport](./06-transports.md)
- [Telegram Transport](./14-telegram-transport.md)
- [Embedding](./20-embedding.md)

## Advanced Preview: App Integration

Custom augments can expose small policy-aware HTTP routes beside the agent
runtime. The current preview includes route schemas, inspection, generated
TypeScript clients, and delegated app authorization.

These are optional integration capabilities, not the definition of every
Auggy project and not a replacement for a general application backend.

- [Generated Route Clients](./25-generated-route-clients.md)
- [Delegated Authorization](./26-delegated-authorization.md)
- [Examples Index](../examples/README.md)
- [Pickleball Storefront](../examples/pickleball-storefront/README.md)
- [Secure Order Support](../examples/order-support/README.md)
- [Field-Service Dispatch](../examples/service-dispatch/README.md)
- [Concierge Example](../examples/concierge/README.md)
- [App Auth Bridge Example](../examples/app-auth-bridge/README.md)

## Exploratory Material

`docs/use-cases/`, `docs/plans/`, and `docs/research/` contain useful rationale
and product exploration. Treat them as internal design material unless a
current reference document explicitly promotes a behavior.

## Operations

- [OSS Production Release Plan](./plans/production-readiness-roadmap-2026-07-24.md)
- [Releasing](./RELEASING.md)
- [Todos](./todos.md)

# Auggy Documentation

Auggy is a modular agent runtime for building self-hosted, long-running agents
and agent-native apps. This directory contains reference docs, operator guides,
strategy notes, historical plans, and research artifacts.

For install and first-run instructions, start with the root
[`README.md`](../README.md).

## Current strategy

The canonical product roadmap is [`ROADMAP.md`](./ROADMAP.md).

The current north star:

> Auggy is the agent-native backend layer: deterministic APIs,
> agent-mediated workflows, memory, identity, tools, operator controls, and
> policy composed from augments.

Supporting strategy notes:

- [Agent-Native App Backends](./use-cases/agent-native-app-backends.md)
- [App Backend Architecture Strategy](./use-cases/app-backend-architecture-strategy.md)
- [Agent-Native Websites](./use-cases/agent-native-websites.md)
- [Augments Over Tools: Use Cases](./23-augments-over-tools-use-cases.md)

## Reference docs

These docs should match the code in `src/`. If code and docs disagree, the code
is the source of truth and the docs should be fixed.

| Doc | What it covers |
| --- | --- |
| [01 Philosophy](./01-philosophy.md) | Why Auggy exists and what it does not try to be |
| [02 Architecture Overview](./02-architecture-overview.md) | Module map and turn data flow |
| [03 Types](./03-types.md) | Shared runtime contracts |
| [04 Kernel](./04-kernel.md) | Turn loop, allocator, capability table, history, tool selection |
| [05 Memory Subsystem](./05-memory-subsystem.md) | Memory providers, registry, memory bus, generic memory tools |
| [06 Transports](./06-transports.md) | Transport contract, web transport, AG-UI SSE |
| [07 Built-In Augments](./07-built-in-augments.md) | Built-in augment catalog and conventions |
| [08 Agent Lifecycle](./08-agent-lifecycle.md) | `defineAgent`, `AgentHandle`, lifecycle hooks, agent card |
| [09 Testing](./09-testing.md) | Test strategy and fixtures |
| [10 System Diagrams](./10-system-diagrams.md) | Architecture diagrams and system maps |
| [11 Skills](./11-skills.md) | Skill folders and model-facing skill surface |
| [12 Budgets](./12-budgets.md) | Budget augment and turn-gate cost controls |
| [13 Notify](./13-notify.md) | Outbound notification augment |
| [14 Telegram Transport](./14-telegram-transport.md) | Telegram transport setup and identity mapping |
| [16 Storage Layout](./16-storage-layout.md) | Agent project layout and deploy metadata |
| [17 Turn Control](./17-turn-control.md) | `request_input` and input-required turns |
| [18 Deploy](./18-deploy.md) | Railway deploy path and recovery |
| [19 Visitor Auth](./19-visitor-auth.md) | Email magic-link verification and visitor tokens |
| [20 Embedding](./20-embedding.md) | Visitor-side frontend/AG-UI integration primitives |
| [21 Console](./21-console.md) | Creator console surface |
| [22 Agent Mail](./22-agent-mail.md) | AgentMail augment |
| [24 MCP](./24-mcp.md) | MCP augment, local/remote servers, deploy posture |

## Use cases and product strategy

Use-case docs are exploratory but should stay grounded in real Auggy
primitives.

- [Use Cases Index](./use-cases/README.md)
- [Agent-Native App Backends](./use-cases/agent-native-app-backends.md)
- [App Backend Architecture Strategy](./use-cases/app-backend-architecture-strategy.md)
- [Agent-Native Websites](./use-cases/agent-native-websites.md)
- [Augments Over Tools: Use Cases](./23-augments-over-tools-use-cases.md)

## Plans

Plans are implementation-specific or historical. They are useful context, but
they are not the canonical roadmap.

- [OSS v1 DX Execution Plan](./plans/oss-v1-dx-execution-plan.md) — historical
  execution plan for v1 CLI/DX work.
- [Agent Project + Package Split Plan](./plans/agent-project-package-split.md)
  — historical/package-layout plan; remaining future work should be tracked in
  [`ROADMAP.md`](./ROADMAP.md).

## Operations

- [Todos](./todos.md) — small bugs, UX issues, and polish only.
- [Releasing](./RELEASING.md) — release process and checks.
- [Eval Testing Plan](./eval-testing-plan.md) — security eval harness design.

## Research and background

Research artifacts are dated inputs to design decisions. They are not always
current product commitments.

- [Research Provenance](./research/research-provenance.md)
- [Agent Eval Landscape 2026](./research/eval-landscape-2026-04-08.md)
- [Rust Hybrid Analysis](./research/rust-hybrid-analysis-2026-04-09.md)
- [Skill Folder Pattern](./research/skill-folder-pattern-2026-04-09.md)
- [Budget-Aware Agents](./research/budget-aware-agents-2026-04-24.md)
- [Twelve Papers on Agent Runtimes](./papers/2026-04-14-twelve-papers-on-agent-runtimes.md)

## Previews

`docs/previews/` contains static design experiments. Treat them as visual
exploration, not shipped contracts.

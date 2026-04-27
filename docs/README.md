# Auggy Reference Documentation

Auggy (`augment-1`) is a modular agent runtime in TypeScript/Bun. This directory holds the reference docs that describe what Auggy is, how it's built, and why each design decision was made.

These docs are written as a contract between the code and the people working on it — they should match what's in `src/` exactly. If you find a discrepancy, the code is the source of truth and the docs should be updated.

## Reading order

If you're new to the codebase, read in order. Each doc assumes the previous one.

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | [Philosophy](./01-philosophy.md) | Why Auggy exists, the design principles, what we explicitly *don't* build |
| 02 | [Architecture overview](./02-architecture-overview.md) | Module map, data flow through a turn, where each piece lives |
| 03 | [Types](./03-types.md) | The shared contract — every type that crosses module boundaries |
| 04 | [Kernel](./04-kernel.md) | The turn loop and its supporting machinery (allocator, capability table, history, tool selector, etc.) |
| 05 | [Memory subsystem](./05-memory-subsystem.md) | Provider contract, registry, bus, context synthesis, generic tools |
| 06 | [Transports](./06-transports.md) | Transport interface, AG-UI event protocol, kernel→AG-UI translation, SSE |
| 07 | [Built-in augments](./07-built-in-augments.md) | `fileMemory`, `supabaseMemory`, `webTransport`, `filesystem`, `webFetch`, `orgContext`, `bash` |
| 08 | [Agent lifecycle](./08-agent-lifecycle.md) | `defineAgent`, `AgentHandle`, the augment lifecycle hooks, agent card generation |
| 09 | [Testing](./09-testing.md) | Test strategy, fixtures, the `bun:test` runner, what to mock |
| 10 | [System diagrams](./10-system-diagrams.md) | Visual maps: three primitives, full architecture, filesystem layout, turn data flow, portable agent, codebase map |
| 11 | [Skills](./11-skills.md) | How skills work: progressive disclosure, the three-primitive model, SKILL.md convention, filesystem-as-loader |

### Additional docs

| Doc | Kind | Summary |
|-----|------|---------|
| [Eval testing plan](./eval-testing-plan.md) | Active plan | Design for the security eval harness in `tests/evals/`. |
| [Memory layer architecture brief](./memory-layer-architecture-brief.md) | Design brief | Layered memory (L0–LN) model — Mason prereq for memory-bus trust gating. |
| [Todos](./todos.md) | Working list | Open followups across the codebase. |
| [Plan 3 kickoff](./plan-3-kickoff.md) | Historical (superseded) | Original scope doc for the CLI + manifest work. Plan 3 shipped 2026-04-14. |

## Research artifacts

Investigations that inform design decisions. The eval landscape doc is a dated snapshot; the research provenance is a living reference.

| Doc | Kind | Summary |
|-----|------|---------|
| [Research provenance](./research/research-provenance.md) | Living reference | What papers we read, which decisions came from each, and how they shaped the runtime. The canonical answer to "why is the code like this?" |
| [Agent eval landscape 2026](./research/eval-landscape-2026-04-08.md) | Dated snapshot (2026-04-08) | OpenClaw's eval ecosystem (fragmented, narrow) vs practitioner consensus. Sources Plan 7's eval harness design. |
| [Rust hybrid analysis](./research/rust-hybrid-analysis-2026-04-09.md) | Dated snapshot (2026-04-09) | Thought experiment: Auggy in Rust. Trade-off analysis, bottleneck math, and the decision record for why we stay TypeScript. |
| [Skill folder pattern](./research/skill-folder-pattern-2026-04-09.md) | Design exploration (2026-04-09) | Augments adopt the SKILL.md + folder pattern for behavioral teaching alongside typed tools. |

## Code map

```
augment-1/
├── src/
│   ├── types.ts              # Every shared type lives here
│   ├── parts.ts              # A2A Part[] helpers
│   ├── helpers.ts            # defineAugment, defineTool
│   ├── tokenizer.ts          # createTokenizer
│   ├── http.ts               # Shared HTTP client (redirect security, body size cap)
│   ├── agent.ts              # defineAgent, AgentHandle
│   ├── agent-card.ts         # generateAgentCard
│   ├── index.ts              # Public API surface
│   │
│   ├── kernel/               # The runtime — turn execution + supporting infra
│   │   ├── turn-loop.ts
│   │   ├── context-allocator.ts
│   │   ├── capability-table.ts
│   │   ├── history-manager.ts
│   │   ├── lifecycle-manager.ts
│   │   ├── tool-selector.ts
│   │   ├── trace-emitter.ts
│   │   ├── transport-queue.ts
│   │   ├── timeout.ts
│   │   ├── output-validator.ts
│   │   └── preamble.ts
│   │
│   ├── memory/               # Memory provider subsystem
│   │   ├── types.ts
│   │   ├── registry.ts
│   │   ├── memory-bus.ts
│   │   ├── context-synthesis.ts
│   │   └── tools.ts
│   │
│   ├── transports/           # Transport implementations
│   │   ├── ag-ui-events.ts
│   │   └── web-transport.ts
│   │
│   ├── augments/             # Built-in augments (6)
│   │   ├── file-memory.ts
│   │   ├── supabase-memory.ts
│   │   ├── filesystem.ts
│   │   ├── filesystem-skill/ # SKILL.md + references for filesystem augment
│   │   ├── web-fetch.ts
│   │   ├── org-context.ts
│   │   └── bash.ts
│   │
│   ├── engines/              # ModelClient adapters (reasoning engines)
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── openrouter.ts
│   │   └── _shared/schema-normalize.ts
│   │
│   └── cli/                  # aug1 CLI (Plan 3)
│       ├── index.ts
│       ├── types.ts
│       ├── config-parser.ts
│       ├── augment-catalog.ts
│       ├── augment-resolver.ts
│       ├── engine-resolver.ts
│       ├── resolve-config.ts
│       ├── pid-registry.ts
│       ├── plist-generator.ts
│       ├── scaffold.ts
│       ├── skill-manifest.ts
│       └── commands/
│           ├── create.ts
│           ├── add.ts
│           ├── dev.ts
│           ├── start.ts
│           ├── stop.ts
│           ├── restart.ts
│           └── status.ts
│
└── tests/                    # bun:test test suite (537 tests across 42 files)
    ├── fixtures/             # mock-model, mock-augment, mock-supabase, temp-dir
    ├── kernel/
    ├── memory/
    ├── augments/
    ├── transports/
    ├── engines/
    ├── cli/
    ├── integration/
    └── evals/                # Security eval harness
```

## Status

As of 2026-04-16 (v0.1.1):

- **Plan 1 (kernel):** complete
- **Plan 2 (built-in augments):** complete
- **Plan 3 (CLI + manifest):** complete, shipped 2026-04-14
- **Augments:** 6 built-in (`fileMemory`, `supabaseMemory`, `filesystem`, `webFetch`, `orgContext`, `bash`)
- **Engines:** 3 (`anthropic`, `openai`, `openrouter`)
- **CLI commands:** `aug1 create | add | dev | start | stop | restart | status`
- **Tests:** 537 passing across 42 files
- **Type check:** clean (`bunx tsc --noEmit`)

For roadmap and project status, see [`lo/docs/auggy-plans-detail.md`](../../docs/auggy-plans-detail.md).

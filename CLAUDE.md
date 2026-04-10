# CLAUDE.md

## What this is

Auggy (`augment-1`) is a modular agent runtime in TypeScript/Bun. Agents are composed from swappable augments; the kernel manages context, tools, permissions, and lifecycle. Framework-agnostic by design — **not LORF-locked**.

**Status (2026-04-08):** Plan 1 (kernel) + Plan 2 (built-in augments) complete. 168 tests passing. See `docs/auggy-plans-roadmap.md`-equivalent at `lo/docs/auggy-plans-roadmap.md` (outside this repo) for the plan-by-plan roadmap.

## Commands

- `bun test` — Run the full test suite (Bun's built-in runner, Jest-compatible API).
- `bun test --watch` — Watch mode.
- `bun run tsc --noEmit` — Typecheck. Part of the gate before committing.
- `bun run scripts/hello.ts` — Run the hello-world test agent against real Anthropic Claude (requires `ANTHROPIC_API_KEY`).

`bun run test` also works (invokes the `test` script, which runs `bun test`).

## Reference documentation

**Read `docs/README.md` first.** It indexes a nine-part reference set written to match the current source:

| Doc | Covers |
|-----|--------|
| `docs/01-philosophy.md` | Why Auggy exists, design principles, what we explicitly don't build |
| `docs/02-architecture-overview.md` | Module map, data flow through a turn |
| `docs/03-types.md` | Every shared type in `src/types.ts` |
| `docs/04-kernel.md` | Turn loop + supporting machinery |
| `docs/05-memory-subsystem.md` | Provider contract, registry, bus, context synthesis, generic tools |
| `docs/06-transports.md` | Transport interface, AG-UI event protocol, SSE streaming |
| `docs/07-built-in-augments.md` | `fileMemory`, `supabaseMemory`, `webTransport`, `filesystem` |
| `docs/08-agent-lifecycle.md` | `defineAgent`, `AgentHandle`, lifecycle hooks |
| `docs/09-testing.md` | Test strategy, fixtures, what to mock |
| `docs/10-system-diagrams.md` | Visual maps: three primitives, full architecture, data flow, filesystem layout |
| `docs/11-skills.md` | How skills work: progressive disclosure, filesystem-as-loader, SKILL.md convention |

`docs/research/` holds dated research artifacts (e.g. `eval-landscape-2026-04-08.md`) that inform design decisions but aren't kept in sync with code.

## Code map

```
src/
├── types.ts              # All shared types (one file — intentional)
├── parts.ts              # A2A Part[] helpers
├── helpers.ts            # defineAugment, defineTool
├── tokenizer.ts          # Char-based token estimator
├── agent.ts              # defineAgent, AgentHandle
├── agent-card.ts         # generateAgentCard (A2A discovery)
├── index.ts              # Public API surface
│
├── kernel/               # Runtime components
│   ├── turn-loop.ts        # The main loop (~600 LOC, the largest file)
│   ├── context-allocator.ts
│   ├── capability-table.ts
│   ├── history-manager.ts
│   ├── lifecycle-manager.ts
│   ├── tool-selector.ts
│   ├── trace-emitter.ts
│   ├── transport-queue.ts
│   ├── timeout.ts
│   ├── output-validator.ts
│   └── preamble.ts
│
├── memory/               # Memory provider subsystem
│   ├── types.ts            # MemoryRegistry
│   ├── registry.ts         # buildRegistry + lookupProvider (conflict detection)
│   ├── memory-bus.ts       # wireMemoryBus — called by defineAgent
│   ├── context-synthesis.ts
│   └── tools.ts            # Four generic memory tools
│
├── transports/           # Transport implementations
│   ├── ag-ui-events.ts     # AG-UI event types + kernel→AG-UI translator
│   └── web-transport.ts    # Bun.serve + ReadableStream SSE
│
├── augments/             # Built-in augments
│   ├── file-memory.ts      # Static memory provider
│   ├── supabase-memory.ts  # Namespace memory provider
│   ├── filesystem.ts       # Multi-mount scoped file access (6 tools, realpath security)
│   └── filesystem-skill/   # SKILL.md + references/ for the filesystem augment
│
└── engines/              # ModelClient adapters (the "reasoning engines")
    └── anthropic.ts        # Anthropic Messages API adapter

tests/
├── fixtures/             # mock-model, mock-augment, mock-supabase, temp-dir
├── kernel/               # Per-kernel-component unit tests
├── memory/               # Memory subsystem tests
├── augments/             # Built-in augment tests (incl filesystem security tests)
├── engines/              # Engine adapter tests (message coalescing)
├── transports/           # Transport tests (incl CORS preflight, streaming, rate limit)
└── integration/          # Full-agent end-to-end tests

scripts/
├── hello.ts              # Hello-world composition (real Claude, file identity, web transport)
└── hello-identity.md     # Throwaway identity file for hello world
```

## Rules for working in this repo

1. **The kernel is finished.** Behavior changes go in augments, not in `src/kernel/`. Bug fixes to kernel files are fine; adding new kernel features requires explicit justification.
2. **Every shared type lives in `src/types.ts`** — do not scatter types across modules. One file is deliberate.
3. **Every module is a `create*` factory returning an object** — no classes, no `this`.
4. **Test gate before committing:** `bun test` (209 passing) + `bun run tsc --noEmit` (clean) must both pass.
5. **A2A-shaped types are load-bearing** — `Part[]`, `TaskState`, `AgentCard` follow A2A's shapes even though v1 doesn't speak A2A on the wire. Do not deviate.
6. **Never use `vitest`** — we migrated to `bun:test` in Plan 2. The import is `from "bun:test"`.
7. **Model adapters go in `src/engines/`** — not `src/models/` (see philosophy: the adapter is the reasoning engine, not the model itself).
8. **Reference docs in `docs/01-11-*.md` should match the code.** If you change behavior that's documented there, update the doc in the same PR.
9. **Skills are files, not code.** Don't boot-load SKILL.md into context. Skills live in a `skills/` directory mounted read-only via the filesystem augment. The model reads them on demand via `fs_read`. See `docs/11-skills.md`.
10. **Three primitives: augments (infrastructure), tools (mechanism), skills (teaching).** Don't conflate them. See `docs/10-system-diagrams.md §1`.

## Project identity

- `lo.yml` at the repo root declares `id: proj_718dcc89-9421-4199-917f-4a65911f3689` and `version: 0.1.0`
- Registered in the LORF Supabase projects table under slug `augment-1`
- Hosted at `github.com/looselyorganized/augment-1` (private)

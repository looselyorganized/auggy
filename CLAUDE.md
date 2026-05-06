# CLAUDE.md

## What this is

Auggy (`augment-1`) is a modular agent runtime in TypeScript/Bun. Agents are composed from swappable augments; the kernel manages context, tools, permissions, and lifecycle. Framework-agnostic by design — **not LORF-locked**.

**Status: v0.2.0 (2026-04-27, visitor-economics complete).** Plans 1 (kernel) + 2 (built-in augments) + 3 (CLI & manifest) complete. Layer 1 trust-aware capability table, security + quality eval suites, bashAugment, SSE token streaming, layeredMemory (peer-scoped episodic memory with provenance). Visitor-economics work (Phase 1b+1c+D1): three-level trust model (creator/agent/public + publicSubstate), TurnGateProvider 2PC contract, budgets augment (per-trust-level turn caps + dollar ceiling + BATS preamble), four-path identity resolution in web transport, Idempotency-Key dedup, bash defaults block shell_exec/run_script for public AND agent. 11 built-in augments, 3 engines, 1279 tests across 100 files. The `chat/` package ships the Auggy Local GUI (`auggy chat`) — a Vite/React SPA with a Bun proxy server that discovers running agents via PID manifests and proxies chat through to each agent's `/agent/run`; distributed as a versioned GitHub release artifact with first-run download + SHA256 verification. See `lo/docs/auggy-plans-detail.md` (outside this repo) for the plan-by-plan roadmap.

**PR α (DX foundation, post-v0.2.0):** augment-as-folder migration ([ADR-025](../docs/solutions/architecture/adr-025-augment-folder-and-skill-bundling.md)) — every built-in augment now lives at `src/augments/<name>/index.ts` with an optional colocated `skill/SKILL.md`; secure-by-default `auggy create` scaffold with baked-in security rules, `identity:` YAML shorthand, default `layeredMemory`, `file://` baseUrl support for orgContext, `auggy add-skill <augment>` command, and a boot-time skill validator. Sequencing: single-agent excellence (PR α/β/γ) ships before the multi-agent network layer per [ADR-026](../docs/solutions/architecture/adr-026-v1-single-agent-excellence-reorder.md).

## Commands

```bash
# CLI
auggy create <name>              # Scaffold a new agent (default: ~/.auggy/agents/<name>/)
auggy add <name>                 # Add augments to an existing agent
auggy add-skill <augment>        # Install an augment's bundled skill into an existing agent
auggy dev <name> [--config path] # Run agent in foreground (Ctrl-C stops)
auggy start <name>               # Install as launchd service (always-on)
auggy stop <name>                # Stop agent (either mode)
auggy restart <name>             # Stop + start
auggy status [name]              # Show running agents
auggy ls                         # List registered agents with status
auggy remove <name> [--yes]      # Delete an agent dir + clear index entry
auggy chat [--port N]            # Launch Local GUI for talking to running agents
auggy eval [name]                # Run portable security eval suite (default: bundled fixture)

# Development
bun test                         # Run full test suite (1279 tests across 100 files)
bun test --watch                 # Watch mode
bunx tsc --noEmit                # Typecheck (must pass before committing)
bun run scripts/hello.ts         # Hello-world agent (requires ANTHROPIC_API_KEY)
```

To use the CLI globally: `bun link` in this directory makes `auggy` available as a command.

## Reference documentation

The `docs/` directory carries operator-facing references for the augments and surfaces shipped in this worktree:

| Doc | Covers |
|-----|--------|
| `docs/02-architecture-overview.md` | Module map, data flow through a turn |
| `docs/06-transports.md` | Transport interface, AG-UI event protocol, SSE streaming |
| `docs/07-built-in-augments.md` | All 11 built-in augments + bundled-skill convention (filesystem / layeredMemory / webFetch / orgContext / bash / notify / turnControl ship `skill/`) |
| `docs/13-notify.md` | `notify` augment operator reference (destinations, rate limit, dedup) |
| `docs/14-telegram-transport.md` | `telegramTransport` operator reference (modes, identity resolution, deployment) |
| `docs/15-chat.md` | Auggy Local GUI (`auggy chat`) — proxy server + SPA architecture |
| `docs/16-storage-layout.md` | Where agents live on disk: `~/.auggy/agents/`, the index file, `--dir` override |
| `docs/17-turn-control.md` | `turnControl` augment + `request_input` semantics |

Architecture decisions live in `lo/docs/solutions/architecture/` (outside this repo). Two pillars for the current DX foundation: [ADR-025](../docs/solutions/architecture/adr-025-augment-folder-and-skill-bundling.md) (augment-as-folder + skill bundling) and [ADR-026](../docs/solutions/architecture/adr-026-v1-single-agent-excellence-reorder.md) (PR α/β/γ sequencing before link/Railway).

## Code map

```
src/
├── types.ts              # All shared types (one file — intentional)
├── parts.ts              # A2A Part[] helpers
├── helpers.ts            # defineAugment, defineTool
├── tokenizer.ts          # Char-based token estimator
├── http.ts               # Shared HTTP client (redirect security, body size cap)
├── agent.ts              # defineAgent, AgentHandle
├── agent-card.ts         # generateAgentCard (A2A discovery)
├── index.ts              # Public API surface
│
├── kernel/               # Runtime components (finished — no new features)
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
│   ├── visitor-token.ts    # Visitor-token issuance + verification
│   └── web-transport.ts    # Bun.serve + ReadableStream SSE
│
├── scaffold-templates/   # Files copied into scaffolded agents at create time
│   └── identity.md         # Identity preamble template (security rules + skill manifest placeholders)
│
├── augments/             # Built-in augments — every augment is a folder per ADR-025
│   ├── bash/
│   │   ├── index.ts        # Scoped shell execution (allowlist, cwd, timeout)
│   │   └── skill/SKILL.md
│   ├── budgets/
│   │   ├── index.ts        # Per-trust-level turn budgets + dollar ceiling (turn-gate 2PC)
│   │   ├── budget-store.ts, preamble.ts, types.ts
│   │   (no skill — augment provides only context() blocks)
│   ├── file-memory/
│   │   └── index.ts        # Static memory provider (no model-callable tools)
│   ├── filesystem/
│   │   ├── index.ts        # Multi-mount scoped file access (6 tools, realpath security)
│   │   └── skill/{SKILL.md, references/}
│   ├── layered-memory/
│   │   ├── index.ts        # Peer-scoped episodic memory augment (entry point)
│   │   ├── storage/{sqlite-store, supabase-store, types}.ts
│   │   └── skill/SKILL.md
│   ├── notify/
│   │   ├── index.ts        # Outbound messaging to operator-configured destinations
│   │   ├── adapters/{telegram, webhook}.ts
│   │   └── skill/SKILL.md
│   ├── org-context/
│   │   ├── index.ts        # Org knowledge (manifest + org_fetch; HTTP or file:// baseUrl)
│   │   └── skill/SKILL.md
│   ├── supabase-memory/
│   │   └── index.ts        # Namespace memory provider (frozen, kept for migration)
│   ├── telegram-transport/
│   │   ├── index.ts        # Telegram bot transport (polling/webhook)
│   │   └── polling.ts, webhook.ts
│   ├── turn-control/
│   │   ├── index.ts        # request_input — turn-end input gate
│   │   └── skill/SKILL.md
│   └── web-fetch/
│       ├── index.ts        # URL fetch with HTML→text, JSON passthrough
│       └── skill/SKILL.md
│
├── engines/              # ModelClient adapters (the "reasoning engines")
│   ├── anthropic.ts        # Anthropic Messages API adapter
│   ├── openai.ts           # OpenAI Chat Completions adapter
│   ├── openrouter.ts       # OpenRouter multi-provider adapter
│   └── _shared/
│       └── schema-normalize.ts  # Zod→JSON Schema normalization
│
└── cli/                  # auggy CLI (Plan 3)
    ├── index.ts            # Commander.js entrypoint
    ├── types.ts            # ParsedConfig, PidManifest, AugmentConfig
    ├── config-parser.ts    # YAML → env interpolation → validation → ParsedConfig (incl. `identity:` shorthand)
    ├── augment-catalog.ts  # Registry of built-in augments for create/add
    ├── augment-resolver.ts # AugmentConfig[] → Augment[] (built-in + custom)
    ├── engine-resolver.ts  # EngineConfig → ModelClient
    ├── resolve-config.ts   # Shared config path resolution
    ├── agent-index.ts      # ~/.auggy/agents.json index management
    ├── pid-registry.ts     # ~/.auggy/<name>.json atomic PID manifests
    ├── plist-generator.ts  # macOS launchd plist generation
    ├── model-picker.ts     # Interactive model selection helpers
    ├── scaffold.ts         # auggy create directory + template generation
    ├── scaffold-skills.ts  # Bundled-skill copy + identity manifest rendering (PR α task 4)
    ├── skill-manifest.ts   # Scan mounted skills/*/SKILL.md (used at runtime)
    ├── skill-validator.ts  # Boot-time validator: warn when tool-providing augment lacks a skill (PR α task 7)
    └── commands/
        ├── create.ts       # auggy create <name>
        ├── add.ts          # auggy add <name> (add augments to existing agent)
        ├── add-skill.ts    # auggy add-skill <augment> (install bundled skill post-scaffold; PR α task 8)
        ├── chat.ts         # auggy chat (Local GUI launcher)
        ├── dev.ts          # auggy dev (foreground runner, core lifecycle)
        ├── eval.ts         # auggy eval (portable security suite)
        ├── ls.ts           # auggy ls (list registered agents)
        ├── remove.ts       # auggy remove <name>
        ├── restart.ts      # auggy restart (stop + start)
        ├── start.ts        # auggy start (launchd install)
        ├── status.ts       # auggy status (list or detail)
        └── stop.ts         # auggy stop (SIGTERM or launchctl unload)

tests/                    # 1279 tests across 100 files
├── fixtures/             # mock-model, mock-augment, mock-supabase, temp-dir
├── kernel/               # Per-kernel-component unit tests
├── memory/               # Memory subsystem tests
├── augments/             # Built-in augment tests (incl filesystem security, web-fetch)
├── engines/              # Engine adapter tests (message coalescing)
├── transports/           # Transport tests (incl CORS preflight, streaming, rate limit)
├── integration/          # Full-agent end-to-end tests
├── cli/                  # CLI tests (config parser, resolvers, PID, plist, scaffold, manifest)
├── evals/                # Security eval harness (grader pipeline)
├── http.test.ts          # HTTP client tests (redirects, body size, auth stripping)
└── (augments/web-fetch.test.ts — entity decoding, script strip, JSON pass)

chat/                     # Auggy Local GUI (auggy chat) — Vite/React SPA + Bun proxy server
├── server.ts             # Bun.serve proxy: /api/agents discovery, /api/chat/<id> bearer-attaching forwarder, CSRF guard
├── src/
│   ├── App.tsx           # Root composition (picker + ChatWidget, Cmd+K / Esc shortcuts)
│   ├── main.tsx          # React entry
│   ├── components/       # AgentPicker, ChatWidget, MessageList, ToolCallView, ErrorBanner
│   ├── adapters/         # Source/Connection adapters (localPidSource, httpProxyConnection)
│   ├── lib/              # chat-store (localStorage history), parser (AG-UI SSE), bearer
│   └── state/            # React state hooks
├── tests/                # 70 tests (server, adapters, lib, state, integration)
├── index.html, vite.config.ts, tsconfig.json, eslint.config.js, package.json
└── dist/                 # Vite build output (gitignored; published as GitHub release artifact)

scripts/
├── hello.ts              # Hello-world composition (real Claude, file identity, web transport)
└── hello-identity.md     # Throwaway identity file for hello world
```

## Rules for working in this repo

1. **The kernel is finished.** Behavior changes go in augments, not in `src/kernel/`. Bug fixes to kernel files are fine; adding new kernel features requires explicit justification.
2. **Every shared type lives in `src/types.ts`** — do not scatter types across modules. One file is deliberate.
3. **Every module is a `create*` factory returning an object** — no classes, no `this`.
4. **Test gate before committing:** `bun test` (1279 passing) + `bunx tsc --noEmit` (clean) must both pass.
5. **A2A-shaped types are load-bearing** — `Part[]`, `TaskState`, `AgentCard` follow A2A's shapes even though v1 doesn't speak A2A on the wire. Do not deviate.
6. **Never use `vitest`** — we migrated to `bun:test` in Plan 2. The import is `from "bun:test"`.
7. **Model adapters go in `src/engines/`** — not `src/models/` (see philosophy: the adapter is the reasoning engine, not the model itself).
8. **Reference docs in `docs/` should match the code.** If you change behavior that's documented in `docs/02`, `06`, `07`, `13`, `14`, `15`, `16`, or `17`, update the doc in the same PR.
9. **Skills are files, not code.** Don't boot-load SKILL.md into context. Skills live in a `skills/` directory mounted read-only via the filesystem augment. The model reads them on demand via `fs_read`. See [ADR-025](../docs/solutions/architecture/adr-025-augment-folder-and-skill-bundling.md) and `lo/docs/solutions/patterns/critical-patterns.md §7`.
10. **Three primitives: augments (infrastructure), tools (mechanism), skills (teaching).** Don't conflate them. Augment-as-folder colocates them on disk without conflating semantics — see ADR-025 + critical-pattern §8.

## Project identity

- `lo.yml` at the repo root declares `id: proj_718dcc89-9421-4199-917f-4a65911f3689` and `version: 0.2.0`
- Registered in the LORF Supabase projects table under slug `augment-1`
- Hosted at `github.com/looselyorganized/augment-1` (private)

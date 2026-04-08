# CLAUDE.md

## Commands
- `bun test` — Run tests (Bun's built-in test runner, Jest-compatible API).
- `bun test --watch` — Watch mode
- `bun run test` also works — it invokes the `test` script which runs `bun test`.

## Architecture
Auggy (augment-1) is a modular agent runtime. See `docs/superpowers/specs/2026-04-02-augment-1-design.md` for the full spec.

- `src/types.ts` — all shared types
- `src/kernel/` — kernel components (context allocator, tool selector, etc.)
- `src/helpers.ts` — defineAugment, defineTool
- `src/agent.ts` — defineAgent, AgentHandle
- `tests/fixtures/` — mock model client, test augments

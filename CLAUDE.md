# CLAUDE.md

## Commands
- `bun run test` — Run tests (Vitest). **Do not use `bun test`** — wrong runner.
- `bun run test:watch` — Watch mode

## Architecture
Auggy (augment-1) is a modular agent runtime. See `docs/superpowers/specs/2026-04-02-augment-1-design.md` for the full spec.

- `src/types.ts` — all shared types
- `src/kernel/` — kernel components (context allocator, tool selector, etc.)
- `src/helpers.ts` — defineAugment, defineTool
- `src/agent.ts` — defineAgent, AgentHandle
- `tests/fixtures/` — mock model client, test augments

# CLAUDE.md

## Project Snapshot

Auggy is a Bun/TypeScript framework for agent-native app backends. One project
can serve deterministic HTTP routes, model-mediated workflows, and a creator
console, with memory, tools, knowledge, auth, notifications, deployment, route
clients, and delegated authorization composed as augments.

Current branch status is tracked in:

- `docs/README.md` — source authority and reference index
- `docs/FEATURES.md` — feature status matrix
- `docs/ROADMAP.md` — release roadmap

## Commands

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run smoke:release
```

CLI commands most relevant to preview work:

```bash
auggy create <name>
auggy run [name]
auggy doctor [name]
auggy routes [name] --json
auggy routes [name] --openapi
auggy routes [name] --client ts --target browser
auggy augment list
auggy augment add [name...]
auggy augment create <name>
auggy augment install <agent> <path>
auggy deploy
auggy logs
```

## Current Architecture

- `src/index.ts` is the public package surface.
- `src/types.ts` owns shared runtime types.
- `src/helpers.ts` owns `defineAugment`, `defineTool`, `defineRoute`, `json`,
  and `webhook`.
- `src/kernel/` owns the turn loop, context allocation, capability table, route
  collection, route manifests, and transport queue.
- `src/augments/` owns built-in runtime capabilities.
- `src/transports/` owns web transport, `/agent/run`, `/console`, AG-UI SSE,
  visitor tokens, admin/console static serving, and webhook policy helpers.
- `src/auth/` and `src/authz/` own external auth assertions and delegated route
  and tool authorization.
- `src/cli/` owns config parsing, scaffolding, model resolution, augment
  resolution, route artifact generation, deploy, doctor, and command wiring.
- Provider adapters live in workspace packages:
  `packages/anthropic`, `packages/openai`, `packages/openrouter`, and
  `packages/ollama`.
- Eval suites live in `packages/evals`.
- The creator browser surface is `/console`; the deleted standalone `chat/`
  package must not be referenced by new work.

## Working Rules

1. Prefer augment, CLI, transport, or docs changes over kernel changes.
2. Kernel changes require a concrete bug or boundary reason.
3. Keep shared public types in `src/types.ts`.
4. Keep modules as `create*` factories or plain functions; avoid classes.
5. Use `bun:test`, not Vitest.
6. Keep reference docs and examples aligned with code changes.
7. Do not bump package versions outside a release PR.
8. Do not publish npm packages from feature or cleanup work.
9. Public npm metadata must not point preview users at a private GitHub repo.
10. Generated route-client behavior is contract-sensitive; update fixtures/tests
    when changing route manifests, OpenAPI, or generated clients.

## Release Posture

The npm packages are public-preview software. The release PR is the only place
to move package versions and changelog entries into a numbered release.

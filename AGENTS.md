# Repository Guidelines

## Project Structure & Module Organization

Core runtime code lives in `src/`: `kernel/` owns turns, `augments/` contains
capabilities, `transports/` serves chat and the console, `jobs/` owns durable
single-turn work, `coordination/` contains the fail-closed PostgreSQL replica
foundation, and `cli/` implements operator commands. Provider adapters and
evals are under `packages/`. Console source is in `admin/src/` and its bundle
is `admin/dist/`. Tests mirror source areas in `tests/`; integrations and
reference material live in `examples/` and `docs/`.

## Build, Test, and Development Commands

- `bun install` installs runtime, provider, and console workspace dependencies.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run lint` checks source with Biome.
- `bun run test` runs the tracked runtime and console suites; use `bun test <path>` for a focused run.
- `cd admin && bun run dev` starts the console development server.
- `cd admin && bun test && bun run build` verifies and rebuilds console assets.
- `bun link` exposes the local `auggy` CLI for end-to-end development.
- `bun run smoke:release` exercises the packaged release path.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, double quotes, semicolons, and
trailing commas. Biome is the formatter and linter; run `bun run lint` before
submitting. Prefer factories and plain functions over stateful classes. Keep
public runtime contracts in `src/types.ts` and local types near their owner.
Built-in augments use `src/augments/<name>/index.ts`; tool-providing augments
should include `skill/SKILL.md`. Use camelCase for functions, PascalCase for
types/components, and kebab-case for CLI-facing slugs.

## Testing Guidelines

Use `bun:test`, never Vitest. Put runtime `*.test.ts` files in the matching
`tests/` subtree and console `*.test.tsx` files beside their owner in
`admin/src/`. Cover success, validation, authorization, and failures. Generated
route clients, manifests, OpenAPI, console payloads, coordination protocol
fingerprints, and stored-state migrations are contract-sensitive; update
fixtures and parity tests together.

## Architecture & Release Boundaries

Prefer augment, CLI, transport, or documentation changes over kernel changes;
kernel edits require a concrete bug or boundary reason. Keep reference docs and
examples aligned with public behavior. Do not bump package versions or publish
npm packages outside a release PR.

Preserve the product promise: “Turn business operations into agent-ready
capabilities.” Describe Auggy as replacing one-off integration glue with
TypeScript augments—controlled, predictable interfaces that bundle identity,
authorization, schemas, tools, routes, and domain logic. Augments remain the
ownership and security boundary: keep reusable logic behind narrow adapters,
make authorization explicit on every exposed interface, and never imply that
Auggy replaces application databases, durable workflows, or systems of record.

PostgreSQL coordination is an internal, disabled integration until its public
profile, operator tooling, and multi-process certification are complete. Keep
`settings.coordination` fail closed in ordinary startup, preserve the supported
single-replica SQLite path, and update compatibility fingerprints, migrations,
topology checks, tests, and status docs together when its contract changes.

## Commit & Pull Request Guidelines

Follow Conventional Commits used in history, for example
`feat(console): map capability safeguards` or `docs: refresh runtime guide`.
Keep commits scoped. Pull requests should explain the outcome, identify security
or compatibility effects, link relevant issues, and list verification commands.
Include screenshots for console changes.

## Security & Configuration

Keep secrets in `.env`; never commit credentials or expose them to model-visible
files. Authentication and authorization must remain deterministic runtime
decisions. Treat preview augments, shell execution, route policies, and mutable
memory as explicit security boundaries requiring tests and clear documentation.

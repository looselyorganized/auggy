# Repository Guidelines

This guide is for contributors to the Auggy runtime and CLI. The
[README](README.md) follows a user from installing the published package to
deploying an agent. The CLI also writes an `AGENTS.md` for each new application
from [its own template](src/scaffold-templates/application/AGENTS.md.template).

## Project Structure & Module Organization

- `src/application/` implements the managed application host and runner.
  `src/kernel/` runs turns, `src/transports/` serves chat and the operator
  Console, and `src/augments/` holds package-managed capabilities.
- `src/cli/` implements project creation, inspection, migration and deployment.
  [Application templates](src/scaffold-templates/application/) generate
  `src/main.ts` (startup), `src/http.ts` (HTTP mount), and `src/turn.ts`
  (turn program) in the user's project. The
  [custom augment generator](src/cli/scaffold-custom-augment.ts) writes
  application-owned code under `src/augments/<slug>/` and registers it in the
  project's root `agent.yaml`.
- `src/jobs/` owns durable single-turn work. `src/coordination/` holds the
  disabled PostgreSQL replica foundation. Provider adapters and evals live in
  `packages/`. The operator Console source is in `admin/src/` and ships from
  `admin/dist/`.
- Tests mirror runtime modules in `tests/`. See [examples](examples/README.md)
  for integrations and the [reference index](docs/README.md) for architecture
  and operations.

## Build, Test, and Development Commands

Use Bun 1.3.14 or newer. Run these commands from the repository root.

- `bun install` installs runtime, provider, and console workspace dependencies.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run lint` checks source with Biome.
- `bun run test` runs the tracked runtime and console suites; use `bun test <path>` for a focused run.
- `cd admin && bun run dev` starts the console development server.
- `cd admin && bun test && bun run build` verifies and rebuilds console assets.
- `bun link` exposes the local `auggy` CLI for end-to-end development.
- `bun run smoke:release` exercises the packaged release path.
- `bun run smoke:authoring` exercises project creation and editing through
  the packaged CLI. `bun run smoke:integration` covers portable deployment and
  application integration.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, double quotes, semicolons, and
trailing commas. Biome is the formatter and linter; run `bun run lint` before
submitting. Prefer factories and plain functions over stateful classes. Keep
public runtime contracts in `src/types.ts` and local types near their owner.
The `auggy/application` entry point exposes the managed application contract
through `src/application/public.d.ts`.
Built-in augments use `src/augments/<name>/index.ts`; tool-providing augments
should include `skill/SKILL.md`. Use camelCase for functions, PascalCase for
types/components, and kebab-case for CLI-facing slugs.

For product UI work, use the Auggy component registry and its shared theme
tokens before introducing local primitives or one-off styling. Console
consumers own generated registry source under `admin/src/components/ui/`. If a
needed primitive is missing, add it to the sibling `auggy-ui` registry first,
then sync it into the consumer with `shadcn add @auggy/<name>`.

## Testing Guidelines

Use `bun:test`, never Vitest. Put runtime `*.test.ts` files in the matching
`tests/` subtree and console `*.test.tsx` files beside their owner in
`admin/src/`. Cover success, validation, authorization, and failures. Generated
route clients, manifests, OpenAPI, console payloads, coordination protocol
fingerprints, and stored-state migrations are contract-sensitive; update
fixtures and parity tests together.

For scaffold changes, check the generated project as a consumer. Use
`tests/cli/scaffold-application.test.ts` for the application, and
`tests/cli/scaffold-custom-augment.test.ts` for custom augment files and inline
registration. Generated projects run their installed CLI with `bun run auggy`.
Use the exact published package when verifying commands advertised for a release.

## Architecture & Release Boundaries

Prefer augment, CLI, transport, or documentation changes over kernel changes;
kernel edits require a concrete bug or boundary reason. Keep reference docs and
examples aligned with public behavior. Do not bump package versions or publish
npm packages outside a release PR.

Keep the original request flowing through the managed HTTP adapter and retain
the guarded operations for inference and tool execution. An application owns
its generated source and copied skills. Package upgrades update the runtime
and bundled built-ins. Preserve user edits and supported older application
contracts when changing the host or generator. Keep CLI adoption of the new
application layout an explicit migration step.

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

# Repository Guidelines

## Project Structure & Module Organization

Core runtime code lives in `src/`: `kernel/` owns turns, `augments/` contains
built-in capabilities, `transports/` serves chat and the console, and `cli/`
implements operator commands. Provider adapters and evals are under `packages/`.
The React/Vite console is in `admin/src/`;
its checked-in production bundle is `admin/dist/`. Tests mirror source areas in
`tests/`. Use `examples/` for runnable integrations, `docs/` for current
reference material, and `scripts/` for utilities.

## Build, Test, and Development Commands

- `bun install` installs root and workspace dependencies.
- `bun run typecheck` runs strict TypeScript checking without emitting files.
- `bun run lint` checks supported source files with Biome.
- `bun test` runs the full `bun:test` suite; pass a path for focused runs, such
  as `bun test tests/cli/routes-client.test.ts`.
- `cd admin && bun run dev` starts the console development server.
- `cd admin && bun test && bun run build` verifies and rebuilds console assets.
- `bun link` exposes the local `auggy` CLI; use `auggy create`, `auggy doctor`,
  and `auggy run` for end-to-end development.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, double quotes, semicolons, and
trailing commas. Biome is the formatter and linter; run `bun run lint` before
submitting. Prefer factories and plain functions over stateful classes. Keep
public runtime contracts in `src/types.ts` and local types near their owner.
Built-in augments use `src/augments/<name>/index.ts`; tool-providing augments
should include `skill/SKILL.md`. Use camelCase for functions, PascalCase for
types/components, and kebab-case for CLI-facing slugs.

## Testing Guidelines

Use `bun:test`, never Vitest. Name tests `*.test.ts` and place them in the
matching `tests/` subtree. Cover success, validation, authorization, and failure
paths for behavioral changes. Generated route clients, manifests, OpenAPI, and
console payloads are contract-sensitive; update fixtures and parity tests
together.

## Commit & Pull Request Guidelines

Follow Conventional Commits used in history, for example
`feat(console): map capability safeguards` or `docs: refresh runtime guide`.
Keep commits scoped and avoid mixing unrelated cleanup. Pull requests should
explain the user-visible outcome, identify security or compatibility effects,
link relevant issues, and list verification commands. Include screenshots for
console changes and update reference docs when public behavior changes.

## Security & Configuration

Keep secrets in `.env`; never commit credentials or expose them to model-visible
files. Authentication and authorization must remain deterministic runtime
decisions. Treat preview augments, shell execution, route policies, and mutable
memory as explicit security boundaries requiring tests and clear documentation.

# Auggy v0.6.1

Create a project with `bunx auggy@0.6.1 create my-agent`. From its directory,
`bun run auggy run` opens local operator chat. The project owns its startup
in `src/main.ts`, HTTP adapter mount in `src/http.ts`, and turn in `src/turn.ts`.
Register built-ins and custom augments inline in the root `agent.yaml`.

## Application integration

A custom augment can expose typed tools and HTTP routes backed by the same
application service. Configure route authentication, tool permissions and
resource authorization for each entry point. Generate browser or server clients
for supported routes. See `references/routes-tools-augments.md`.

## Operating limits

Run a single replica with persistent SQLite state. PostgreSQL coordination is
disabled for ordinary startup. Jobs execute one turn. The Console is for
operators. Export a Docker build context or use the guided Railway deployment.

Enable preview augments deliberately. `bash` executes host commands, `budgets`
provides soft spending guardrails, and `link` connects configured peers. Set
hard spend limits with the provider.

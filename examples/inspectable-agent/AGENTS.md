# Auggy application development

This file guides coding assistants working on this application. The default
runtime does not load it into agent prompts. See [README.md](README.md) for setup
and operation. Keep this project-owned guide current as the application evolves.

## Trace execution

- `src/main.ts` prepares configuration, creates the model and augments, creates
  the agent, binds transports and starts the managed host. Its `createAgent`
  call selects `turnProgram` and the optional `onTurnFinalized` observer.
- `src/http.ts` mounts the conversation endpoint and delegates the original
  request to the maintained HTTP adapter. The adapter admits and schedules turns.
- `src/turn.ts` runs the selected turn program: internal work or prompt
  preparation, model inference, guarded tool execution, and completion.
- `src/augments/` holds this application's business capabilities. Installed
  built-ins and shared runtime code are inspectable in `node_modules/auggy/src/`.

## Put changes with their owner

- `agent.yaml` owns provider selection, settings and enabled augments. Keep
  it as the single capability graph when changing application orchestration.
- Edit `main.ts`, `http.ts` and `turn.ts` for application behavior. Keep startup
  stage order and managed cleanup intact; use finalization observers for telemetry.
- Add domain integrations behind narrow augment adapters. Validate inputs and
  enforce business authorization on every tool and route, including resource
  ownership. Existing databases and durable workflows remain systems of record.
- Use the project-local CLI (`./node_modules/.bin/auggy`) for inspection and
  augment authoring. See `README.md` for the example adapter and its authorization
  checks.
- Keep package-managed implementations in `node_modules` unchanged; implement
  application customizations in owned source and select dependencies in
  `package.json` and the lockfile.

## Preserve execution and data boundaries

- Pass original requests through the HTTP adapter and retain its fallback for
  health, console and augment routes. Preserve authentication, validation,
  streaming and durable delivery when changing a mount or adding a route.
- Use the guarded turn operations for inference and tools. Handle terminal
  results and preserve authorization, configured limits, cancellation, history
  settlement and accounting. Prompt instructions cannot grant authority.
- Keep identity and learned guidance in their existing configured files, and
  capability-use instructions in the configured skill sources. Keep credentials,
  private customer data and runtime state out of this guide and other
  model-visible instructions.
- Store secrets in the ignored `.env`; use placeholders in `.env.example`.
  Keep mutable runtime state in the configured data directory and redact logs.

## Verify changes

Use TypeScript and Bun. Follow the surrounding style and use `bun:test` for tests.

- `bun install` installs dependencies when setting up or changing them.
- `bun run typecheck` checks the application's public API usage.
- `bun test tests` runs the application tests; use `bun test <path>` for focused
  iteration. Cover changed validation, authorization and failure behavior.
- `bun start` runs the declared application. For startup, transport or lifecycle
  changes, also verify the affected startup, request or shutdown path locally.
  Prefer existing fixture providers for automated checks; scope verification to
  the change. Documentation-only edits need content and link checks.

## Project decisions

Record connected systems, domain-specific authorization rules and important
design decisions here as they become known. Link to deeper documentation and
keep this guide concise. Review changes to these instructions like source code.

This reference exposes a read-only lookup of fictional orders. Keep business
logic in `src/augments/example/service.ts` and preserve creator authorization
on both the tool and route. Setup instructions and observation formats are in
`README.md`.

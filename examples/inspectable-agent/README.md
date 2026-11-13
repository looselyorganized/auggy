# Inspectable agent

Open `src/index.ts` first. This reference is an ordinary Bun application with a
project-owned startup function, HTTP mount, composition and turn loop. Its example
augment turns one read-only order lookup into a tool and an authenticated route.
The data is fictional; a real application keeps its database and workflows behind
the service boundary in `src/augments/example/service.ts`.

## Run it

For a fresh repository checkout, first install the workspace and build the
console from the repository root:

```sh
bun install --frozen-lockfile
bun run build:admin
cd examples/inspectable-agent
```

This repository reference uses an explicit `workspace:../..` link to Auggy and a
local `file:` dependency on its Anthropic adapter. Its four provider `file:` overrides support Bun's resolution
of the source checkout's workspace dependencies. Remove those checkout-only
provider overrides when installing packed or published packages; retain the
reviewed security overrides. From this directory:

```sh
bun install
cp .env.example .env
```

Fill the three empty values in `.env`. Use your Anthropic credential. Generate an
identity with `aug1_` followed by a UUID, and a private bearer token, for example:

```sh
bun -e 'console.log("AUGGY_AGENT_ID=aug1_" + crypto.randomUUID()); console.log("AUGGY_WEB_TOKEN=" + crypto.randomUUID() + crypto.randomUUID())'
```

Keep the identity across restarts and upgrades. Give a separately deployed copy
its own identity and token. `.env` stays outside the model's context and version
control. Start through either entry path:

```sh
bun run start  # executes src/index.ts directly
bun run cli    # installed project CLI imports the same main function
```

Open `http://localhost:8080/console` and sign in with the bearer token. Ask:
“Look up demo order DEMO-1001 and summarize its status.” Port 8080 is configured
in `agent.yaml`; the installed transport owns listener behavior.

The creator-authenticated endpoints are:

| Request | Behavior |
| --- | --- |
| `POST /agent/run` | Message ingress and streamed turn events |
| `GET /example/orders/DEMO-1001` | Read the same demo service directly |

Use `Authorization: Bearer <your token>`. A message body is
`{"threadId":"order-demo","messages":[{"role":"user","content":"Look up demo order DEMO-1001"}]}`.
An `Idempotency-Key` on `POST /agent/run` enables the configured durable response
replay. Keep credentials out of query strings and source files.

## Trace the execution

1. `src/index.ts`: the managed runner calls `main`; `createHost` registers cleanup,
   `prepare` acquires ownership and resolves YAML, and `start` activates listeners.
2. `src/agent.ts`: selects the local turn program and finalization observer using
   the already configured provider and augment graph.
3. `src/http.ts`: mounts `POST /agent/run`. Its delegate applies the original
   request's authentication, limits, identity and streaming behavior. The fallback
   serves health, console and augment routes through the same transport.
4. `src/turn.ts`: prepares the prompt, calls inference, executes a guarded tool
   batch, refreshes context and completes the turn. This is executed application
   code. Change `maxInferences: 2` to `1` to stop after the first completed batch;
   terminal or unknown tool outcomes still take precedence.
5. `src/augments/example/index.ts`: checks creator authority for the tool and
   declares creator authentication for the route. Both use `schemas.ts` and
   `service.ts`. Invalid input cannot select another backend or gain authority.

`agent.yaml` is the sole enabled-augment list. Identity, budgets and web transport
remain installed implementations. Follow their imports under
`node_modules/auggy/src/cli/augment-resolver.ts` and
`node_modules/auggy/src/augments/` or `src/transports/web-transport.ts` when you need
the package internals. Managed turn guards live in `src/kernel/turn-session.ts`;
host lifecycle code lives in `src/application/host.ts`. The local files show where
those boundaries are called without copying a second runtime into the project.

## Inspect observations

The application emits sanitized JSON lines to stdout and four bounded files:

| File under `data/observability/` | Actual observation |
| --- | --- |
| `startup.jsonl` | Ready label, launch mode, bindings and source-navigation paths |
| `turns.jsonl` | Local recipe entry; returned-turn status, inference/token/cost counts and tool output hashes |
| `finalization.jsonl` | Runtime finalization, including thrown failures, history/accounting disposition and pending effects |
| `tools.jsonl` | Actual tool decisions and execution outcomes |

Thread references and tool outputs are SHA-256 digests. Prompts, arguments, order
bodies, credentials and raw error messages are omitted. Each file stops accepting
records at 1 MiB; each record is limited to 16 KiB. The application warns once per
unavailable/full channel and keeps business execution independent of diagnostics.
Archive the files before removing them when you need continued local diagnostics.

Startup source paths describe resolution and navigation; they are not an imported
module audit. The finalization observer runs before post-turn hooks, so its record
does not claim all detached work or delivery has finished. Failed inference can
produce a finalization record without a `turn.completed` record.

Ordinary creator requests to `/agent/run` use in-memory conversation history;
their configured idempotency responses survive restart. Console chat has its own
SQLite history path. Creator turns bypass budget reservations: an accounting
callback acknowledgement is not evidence of a persisted charge. Token and cost
summaries describe observed inference, including the number of unpriced steps.

## Validate and upgrade

```sh
bun run typecheck
bun test tests
```

These focused tests cover schemas, authorization, real HTTP lookup, managed loop
behavior, failure observations and bounded diagnostic writes. Installed-package
launch, source edits and upgrade acceptance are separately exercised by the
repository release harness.

This example's workspace link and `file:` dependency track the checkout. A published application
should declare explicit released versions of `auggy` and `@auggy/anthropic` and
retain the reviewed consumer overrides. Upgrade those dependencies and the lock
together, read release notes, then run the application checks. Built-in code
updates with the installed packages; the files in `src/` remain yours to review
and adapt for breaking contracts. This reference is not yet the `auggy create`
template or a migration of existing generated projects.

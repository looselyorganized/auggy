<p align="center">
  <img src="assets/auggy.png" alt="Auggy — a sketch of a modular robot with detachable arms, sensors, and accessories" width="220" />
</p>

<h1 align="center">Auggy</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/auggy"><img src="https://img.shields.io/npm/v/auggy?label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache-2.0 license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun runtime" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript" alt="TypeScript" />
</p>

Auggy is a small Bun/TypeScript runtime for building self-hosted agents from
composable augments.

The kernel runs agent turns. Augments add the tools, memory, transports,
context, skills, and policy your agent needs.

Auggy is in public preview. Pin exact versions for production work until
`1.0.0`.

## Quick Start

```bash
npm i -g auggy
auggy create my-agent
cd my-agent
auggy run
```

For a hosted model, add the provider key requested during setup to `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

When the agent starts, Auggy prints its local surfaces:

```text
Agent "my-agent" is live.

  Chat:     http://localhost:8080/console/chat
  Console:  http://localhost:8080/console
  Health:   http://localhost:8080/health
  Home:     http://localhost:8080/
```

You now have an ordinary TypeScript project you can inspect, edit, test, and
deploy.

## Why Auggy

Many agent frameworks decide in advance which memory system, tools, transport,
or orchestration model an agent should use. Auggy keeps the runtime small and
makes those choices replaceable.

```text
inbound message
      ↓
  transport
      ↓
 turn kernel ← context + memory
      ↓
    model ↔ typed tools
      ↓
 outbound response
```

The kernel knows how to run a turn:

1. identify the peer,
2. assemble context and history,
3. call the configured model,
4. execute validated tool calls,
5. emit events and return a result.

Everything around that turn is contributed by augments.

This gives you:

- a small runtime with an explicit turn lifecycle,
- typed tools with Zod schemas,
- swappable Anthropic, OpenAI, OpenRouter, and Ollama engines,
- composable memory, transports, skills, and policy,
- ordinary files and TypeScript instead of a hosted builder,
- a creator console, diagnostics, and Railway deployment,
- one extension surface for built-in and application-specific behavior.

Auggy is not currently a durable workflow engine, job queue, or replacement for
a general web framework. It is the runtime in which your agent receives context,
uses capabilities, and completes turns.

## What Gets Created

```text
my-agent/
  agent.yaml
  identity.md
  learned-behaviors.md
  package.json
  .env
  .env.example
  augments/
    filesystem/
      augment.yaml
    webFetch/
      augment.yaml
  skills/
  data/
    workspace/
```

`agent.yaml` is the runtime entry point. It selects the engine and lists enabled
augments in boot order.

`identity.md` contains operator-authored identity and boundaries.
`learned-behaviors.md` stores creator-approved operating guidance. Augment
configuration lives under `augments/`, skills are plain Markdown folders, and
mutable runtime data stays under `data/`.

Each agent has its own `package.json`, so its Auggy runtime and model adapter are
portable and version-pinned.

## The Default Agent

Fresh agents include a compact chat-ready set:

| Augment | Purpose |
| --- | --- |
| `fileMemory` | Loads identity and creator-approved learned behavior |
| `filesystem` | Provides scoped access to skills and the agent workspace |
| `webTransport` | Serves chat, console, health, and home pages |
| `webFetch` | Fetches public URLs and APIs with SSRF protection |
| `turnControl` | Lets the agent stop and request missing input |

List everything available:

```bash
auggy augment list
```

Add an augment interactively or by name:

```bash
auggy augment add
auggy augment add knowledge
auggy augment add layeredMemory notify
auggy augment add mcp telegramTransport
```

## Built-In Augments

### Core

Core augments make the default agent work and are installed by `auggy create`.

| Augment | What it adds |
| --- | --- |
| `fileMemory` | File-backed identity and learned behavior |
| `filesystem` | Named, scoped filesystem mounts |
| `webTransport` | HTTP/SSE chat and the operator console |
| `webFetch` | Public web and API fetching |
| `turnControl` | Explicit input-required turns |

### Stable add-ons

| Augment | Add it when you need... |
| --- | --- |
| `knowledge` | Local Markdown or API-backed reference material |
| `layeredMemory` | Peer-scoped episodic memory backed by SQLite |
| `visitorAuth` | Email magic-link recognition for returning visitors |
| `agentMail` | Policy-gated send/receive email with durable inbound recovery and outbound review |
| `notify` | Outbound alerts through file, webhook, Telegram, or AgentMail |
| `telegramTransport` | Bidirectional Telegram conversations |
| `mcp` | Tools exposed by local or remote MCP servers |

### Preview add-ons

Preview augments require deliberate setup and may still change before `1.0`.

| Augment | Status |
| --- | --- |
| `bash` | Scoped host execution; not a security sandbox |
| `budgets` | Turn and spend guardrails; not billing control |
| `link` | Configured agent-to-agent traffic; not an open agent mesh |

## Write A Custom Augment

From an agent project, create and install a local augment:

```bash
auggy augment create weather
```

Auggy writes `augments/weather/`, adds it to `agent.yaml`, and asks whether the
agent also needs a `skills/weather/SKILL.md` instruction pack.

A tool-providing augment is ordinary TypeScript:

```ts
import { defineAugment, defineTool } from "auggy";
import { z } from "zod";

export default function weather() {
  return defineAugment({
    name: "weather",
    tools: [
      defineTool({
        name: "weather_lookup",
        description: "Look up the current weather for a city.",
        category: "search",
        input: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          return `Weather lookup is not configured yet for ${city}.`;
        },
      }),
    ],
  });
}
```

An augment can also contribute context, memory, a transport, lifecycle hooks,
operator information, policy, or optional HTTP routes. The kernel does not need
to change when your agent gains a new capability.

## Identity, Skills, And Memory

Identity is durable operator-authored guidance. Skills teach the model how and
when to use capabilities. Memory stores information learned while operating.
Auggy keeps those concepts separate so retrieved or peer-derived content does
not silently become system authority.

Create a skill:

```bash
auggy skill create <name>
```

Add peer-scoped memory:

```bash
auggy augment add layeredMemory
```

Pair it with `visitorAuth` when returning browser visitors should retain a
recognized identity across sessions:

```bash
auggy augment add visitorAuth
auggy augment setup visitorAuth
```

## Connect External Tools With MCP

```bash
auggy augment add mcp
```

MCP server definitions live in `.mcp.json` at the agent root. Local stdio
servers work during local development; deployed agents should use remote HTTPS
servers or explicitly disable local-only servers in cloud environments.

```json
{
  "mcpServers": {
    "github": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_TOKEN}"
      }
    }
  }
}
```

Check the boundary before running or deploying:

```bash
auggy mcp doctor
auggy mcp doctor --cloud
```

Auggy fails a server closed on missing environment variables, duplicate exposed
tool names, invalid configuration, or cloud-unsafe stdio usage.

## Channels And Notifications

Talk to the same agent through Telegram:

```bash
auggy augment add telegramTransport
```

Send bounded outbound alerts:

```bash
auggy augment add notify
```

The default notification destination writes JSON Lines locally with no secrets.
Configure a webhook, Telegram, or AgentMail destination when you need real
delivery.

For model-callable email (outbound ships in `0.5.0`; durable inbound is in the
current unreleased source):

```bash
auggy augment add agentMail
auggy augment setup agentMail
```

## Advanced Preview: Routes And App Integration

Custom augments can register small policy-aware `GET` and `POST` routes beside
the agent runtime. Auggy can inspect their manifests, export an OpenAPI-shaped
description, and generate TypeScript clients.

```bash
auggy routes
auggy routes --openapi
auggy routes --client ts --target browser --out client.ts
```

Apps with an existing authentication provider can mint short-lived assertions
with explicit scopes and resource grants. Auggy can enforce those grants on
both routes and model-callable tools; the model never decides whether a caller
is authorized.

This surface is useful when an agent needs a small deterministic API boundary.
It does not make Auggy a general application backend or durable workflow
system. Treat generated clients and delegated app authorization as preview
capabilities while their APIs settle.

See:

- [Generated Route Clients](https://auggy.dev/docs/generated-route-clients)
- [Delegated Authorization](https://auggy.dev/docs/delegated-authorization)
- [Showcase Examples](https://auggy.dev/examples)
- [Pickleball Storefront](https://auggy.dev/examples/pickleball-storefront)
- [Secure Order Support](https://auggy.dev/examples/order-support)
- [Field-Service Dispatch](https://auggy.dev/examples/service-dispatch)
- [App Auth Bridge Example](https://auggy.dev/examples/app-auth-bridge)

## Deploy To Railway

```bash
auggy deploy
```

Auggy stages the current agent, pushes configured secrets, creates or links a
Railway service, mounts persistent data at `/app/data`, starts the deployment,
and verifies `/health` when deployment status is available.

Keep the service at **one replica** while it uses Auggy's SQLite stores. Console
chat history lives at `/app/data/console-chat.db` by default; the `/app/data`
volume is required for that history to survive deploys and restarts. A durable
volume is not a backup, so snapshot or back it up separately if the history is
important.

After the first deploy, the selected target is saved locally. Useful follow-up
commands:

```bash
auggy logs
auggy deploy --yes
```

## CLI Reference

| Command | What it does |
| --- | --- |
| `auggy create <name>` | Scaffold a standalone agent project |
| `auggy init [name]` | Initialize the current directory as an agent |
| `auggy run [name]` | Run locally and open chat |
| `auggy doctor [name]` | Check configuration, environment, dependencies, port, and skills |
| `auggy augment list` | Show core, stable, and preview augments |
| `auggy augment add [name...]` | Select or add built-in augments |
| `auggy augment create <name>` | Create and register a custom augment in the current agent |
| `auggy augment install <agent> <path>` | Import a custom augment authored elsewhere |
| `auggy skill create <name>` | Create a skill folder |
| `auggy skill add <name>` | Install or refresh a bundled skill |
| `auggy routes [name]` | Inspect preview routes and generate clients |
| `auggy mcp init/list/show/add-json/remove/doctor` | Manage MCP servers |
| `auggy models list [provider] --refresh` | Refresh the provider model list |
| `auggy deploy` | Deploy the current agent to Railway |
| `auggy logs` | Open Railway logs for a deployed agent |
| `auggy start` / `stop` / `restart` | Manage a background local agent |

## Requirements

- Node.js >= 20.17 is recommended for the npm dependency chain.
- Bun >= 1.2 is required at runtime.
- Railway deployment requires the Railway CLI and `railway login`.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Development

```bash
git clone <auggy-repository-url>
cd auggy
bun install
bun test
bunx tsc --noEmit
```

For a local CLI install from this checkout:

```bash
bun link
auggy --version
```

## Documentation

- [Documentation](https://auggy.dev/docs)
- [Quickstart](https://auggy.dev/docs/quickstart)
- [Augments](https://auggy.dev/docs/augments)
- [Memory](https://auggy.dev/docs/memory)
- [MCP](https://auggy.dev/docs/mcp)
- [Console](https://auggy.dev/docs/console)
- [Deploy](https://auggy.dev/docs/deploy)

## License

Apache-2.0

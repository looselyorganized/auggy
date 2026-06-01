<p align="center">
  <img src="assets/auggy.png" alt="Auggy — a sketch of a modular robot with detachable arms, sensors, and accessories" width="220" />
</p>

<h1 align="center">Auggy</h1>

<p align="center">
  <a href="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml"><img src="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/auggy"><img src="https://img.shields.io/npm/v/auggy?label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript" alt="TypeScript" />
  <a href="https://looselyorganized.xyz"><img src="https://img.shields.io/badge/by-LORF-red" alt="LORF" /></a>
</p>

Auggy is a modular agent runtime for building self-hosted, long-running AI
agents. Agents are composed from **augments**: swappable primitives for memory,
tools, transports, knowledge, notifications, and deployment.

Auggy supports multiple engine families out of the box: **Anthropic**,
**OpenAI**, **OpenRouter**, and **Ollama**. Pick one during `auggy create`;
change it later in `agent.yaml`.

The happy path is simple: create an agent, fill one `.env` key, run it, and
chat in the browser.

## Quick Start

```bash
npm i -g auggy
auggy create my-agent
cd my-agent
auggy run
```

`auggy create` scaffolds a standalone agent project and installs its local
runtime dependencies. The only required first-run edit for hosted engines is
the provider API key in `.env`.

```bash
# my-agent/.env
ANTHROPIC_API_KEY=sk-ant-...
```

When the agent starts, Auggy prints the local URLs:

```text
Agent "my-agent" is live.

  Chat:     http://localhost:8080/console/chat
  Console:  http://localhost:8080/console
  Health:   http://localhost:8080/health
  Home:     http://localhost:8080/
```

## Next Moves

List optional augments:

```bash
auggy augment list
```

Add a stable built-in augment:

```bash
auggy augment add knowledge
auggy augment add notify
auggy augment add telegramTransport
```

Create your own augment:

```bash
auggy augment create weather
```

Deploy to Railway:

```bash
auggy deploy
```

## What Gets Created

An Auggy agent is a normal project directory:

```text
my-agent/
  agent.yaml
  identity.md
  learned.md
  package.json
  .env
  .env.example
  augments/
  skills/
  data/
```

`agent.yaml` is the entry point. `.env` holds secrets. `skills/` holds markdown
instructions the agent can read. `augments/` is where custom local augments live.
Runtime code is installed through the agent's `package.json`, so each agent is
portable and pinned to the Auggy version it was created with.

## Core Concepts

**Engines** are model providers. A new agent can use Anthropic, OpenAI,
OpenRouter, or Ollama.

**Augments** are runtime capabilities. They add memory, tools, transports,
knowledge, notifications, auth, budgets, or custom behavior.

**Skills** are markdown instructions. Augments can install skills, and you can
create your own with:

```bash
auggy skill create <name>
```

## Built-In Path

Fresh agents include the core chat-ready set:

| Augment | Purpose |
| --- | --- |
| `fileMemory` | Loads `identity.md` and `learned.md` into context |
| `filesystem` | Gives the agent scoped file access |
| `webTransport` | Serves chat, console, health, and home pages |
| `webFetch` | Lets the agent fetch URLs and HTTP APIs |
| `turnControl` | Lets the agent pause and ask for clarification |

Stable add-ons:

| Augment | Add it when you want... |
| --- | --- |
| `knowledge` | Local markdown docs and API-backed knowledge sources |
| `notify` | Outbound notifications to an operator or service |
| `telegramTransport` | Bidirectional chat with the agent from Telegram |

Preview augments are visible in `auggy augment list`, but the default v1 path
keeps first run focused on local chat.

## Knowledge

```bash
auggy augment add knowledge
```

This creates:

```text
knowledge/
  sources.json
  local/
    manifest
    mission.md
    context.md
```

Edit, rename, or delete the starter markdown files. Add more files under
`knowledge/local/`, then list each endpoint in `knowledge/local/manifest`.
API-backed sources live in `knowledge/sources.json`.

## Notifications

```bash
auggy augment add notify
```

The default destination writes to `notifications.jsonl` so the augment works
locally with no secrets. For real delivery, edit `notify.destinations` in
`agent.yaml` and add any required secrets to `.env`.

## Telegram

```bash
auggy augment add telegramTransport
```

Then set:

```env
TELEGRAM_BOT_TOKEN=123456:...
TELEGRAM_CREATOR_USER_IDS=123456789
```

Use `@BotFather` to create a bot and `@userinfobot` to find your Telegram user
ID. Creator IDs are comma-separated numeric Telegram user IDs.

## Deploy To Railway

Auggy has a first-class Railway deploy path:

```bash
auggy deploy
```

Deploy stages the current agent, pushes `.env` secrets to Railway, creates or
links a service, mounts persistent data at `/app/data`, starts a build, waits
for Railway deployment status when available, then verifies `/health`.

Useful follow-ups:

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
| `auggy doctor [name]` | Check config, env, dependencies, port, and skills |
| `auggy augment list` | Show installed, stable, and preview augments |
| `auggy augment add <name>` | Add a built-in augment |
| `auggy augment create <name>` | Scaffold a custom local augment |
| `auggy augment install <path>` | Install a custom local augment |
| `auggy skill create <name>` | Create a skill folder |
| `auggy skill add <name>` | Reinstall a bundled augment skill |
| `auggy deploy` | Deploy the current agent to Railway |
| `auggy logs` | Open Railway logs for a deployed agent |
| `auggy start` / `stop` / `restart` | Manage a background local agent |

## Requirements

- Node.js >= 20.17 is recommended for the npm dependency chain.
- Bun >= 1.2 is required at runtime.
- Railway deploy requires the Railway CLI and `railway login`.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Development

```bash
git clone https://github.com/looselyorganized/augment-1.git
cd augment-1
bun install
bun test
bunx tsc --noEmit
```

For a local CLI install from this checkout:

```bash
npm pack
npm i -g ./auggy-*.tgz
```

## Documentation

- [Architecture overview](docs/02-architecture-overview.md)
- [Built-in augments](docs/07-built-in-augments.md)
- [Skills](docs/11-skills.md)
- [Deploy to Railway](docs/18-deploy.md)
- [Console](docs/21-console.md)
- [Reference docs](docs/README.md)

## License

Apache-2.0

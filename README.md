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
auggy augment add layeredMemory
auggy augment add visitorAuth
auggy augment add notify
auggy augment add mcp
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
    filesystem/
      augment.yaml
    webFetch/
      augment.yaml
  skills/
  data/
```

`agent.yaml` is the entry point: identity, engine, and enabled augment order.
Each enabled augment has config in `augments/<id>/augment.yaml`. `.env` holds
secrets. `skills/` holds markdown instructions the agent can read. Runtime code
is installed through the agent's `package.json`, so each agent is portable and
pinned to the Auggy version it was created with.

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
| `layeredMemory` | Repeat visitor memory backed by SQLite |
| `visitorAuth` | Email magic-link sign-in for recognized visitors |
| `agentMail` | Model-callable outbound email through AgentMail |
| `notify` | Outbound notifications to an operator or service |
| `telegramTransport` | Bidirectional chat with the agent from Telegram |
| `mcp` | Tools from local or remote MCP servers |

Preview augments (`bash`, `budgets`, `link`) are visible in
`auggy augment list`, but require deliberate setup because their production
policy surface is broader.

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

## Memory And Visitors

```bash
auggy augment add layeredMemory
auggy augment add visitorAuth
```

`layeredMemory` stores peer-scoped episodic memory in
`data/memory.db`. The agent can explicitly save stable preferences,
commitments, names, and recurring topics with:

```ts
memory_write({ topic: "preferences", content: "Sam prefers concise replies." })
```

The runtime derives the current peer label, so the model does not hand-build
visitor IDs or internal memory labels.

`visitorAuth` promotes an anonymous browser visitor into a recognized visitor
with an email magic link. Pair it with `layeredMemory` when you want "welcome
back" continuity across sessions.

Local testing uses console magic links. For production email delivery:

```bash
auggy agentmail setup visitorAuth
```

Deploy preflight blocks console magic links on Railway unless you explicitly
acknowledge that links will appear in service logs.

## Notifications

```bash
auggy augment add notify
```

The default destination writes to `notifications.jsonl` so the augment works
locally with no secrets. For real delivery, edit
`augments/notify/augment.yaml` and add any required secrets to `.env`.

## AgentMail

```bash
auggy augment add agentMail
```

Use this when the agent itself should send email through AgentMail with a
trust gate, recipient allowlist, rate limits, and audit history. If you only
need magic-link email for `visitorAuth`, use `auggy agentmail setup visitorAuth`
instead of adding the full `agentMail` augment.

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

## MCP

```bash
auggy augment add mcp
```

MCP servers live in `.mcp.json` at the agent root. `agent.yaml` enables the
augment; `.mcp.json` is the source of truth for server definitions. Auggy
discovers MCP tools at boot and exposes them as Auggy tools named
`mcp_<server>_<tool>`.

Local stdio MCP:

```json
{
  "mcpServers": {
    "smoke": {
      "type": "stdio",
      "command": "bun",
      "args": ["../augment-1/examples/mcp-stdio-server/server.ts"]
    }
  }
}
```

Remote HTTPS MCP for cloud agents:

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

Put secrets in `.env`, then check setup:

```bash
auggy mcp doctor
auggy mcp doctor --cloud
auggy doctor --cloud
```

Railway deploy blocks enabled `stdio` MCP servers by default. Use remote HTTPS
MCP for cloud, or mark local-only servers disabled for cloud:

```json
{
  "auggy": {
    "servers": {
      "smoke": {
        "cloud": "disabled"
      }
    }
  }
}
```

MCP is treated as an external trust boundary. Auggy fails a server closed on
missing env vars, duplicate exposed tool names, invalid config, or cloud-unsafe
stdio usage. Tool discovery, schemas, descriptions, concurrent calls, and
results are capped before they reach the model.

## Deploy To Railway

Auggy has a first-class Railway deploy path:

```bash
auggy deploy
```

Deploy stages the current agent, pushes `.env` secrets to Railway, creates or
links a service, mounts persistent data at `/app/data`, starts a build, waits
for Railway deployment status when available, then verifies `/health`.

When creating a new Railway project, Auggy selects from your existing Railway
workspaces and creates the project for you. For scripted deploys, pass
`--workspace <workspace-id-or-name>`.

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
| `auggy mcp init/list/show/add-json/remove/doctor` | Manage `.mcp.json` MCP servers |
| `auggy models list [provider] --refresh` | Fetch and save the latest provider model list |
| `auggy deploy` | Deploy the current agent to Railway |
| `auggy logs` | Open Railway logs for a deployed agent |
| `auggy start` / `stop` / `restart` | Manage a background local agent |

`auggy create` asks for the selected provider's API key before model selection.
If a key is provided, Auggy fetches and saves the latest provider model list.
If not, it uses saved models from a previous refresh or falls back to bundled,
known-priced choices.

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
- [Visitor Auth](docs/19-visitor-auth.md)
- [Agent Mail](docs/22-agent-mail.md)
- [MCP](docs/24-mcp.md)
- [Console](docs/21-console.md)
- [Reference docs](docs/README.md)

## License

Apache-2.0

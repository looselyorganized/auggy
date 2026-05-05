<p align="center">
  <img src="assets/auggy.png" alt="Auggy — a sketch of a modular robot with detachable arms, sensors, and accessories" width="220" />
</p>

<h1 align="center">Augment-1</h1>

<p align="center">
  <a href="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml"><img src="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/looselyorganized/augment-1/releases/latest"><img src="https://img.shields.io/badge/release-v0.2.0-blue" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript" alt="TypeScript" />
  <a href="https://looselyorganized.xyz"><img src="https://img.shields.io/badge/powered%20by-LORF-red" alt="LORF" /></a>
</p>

Auggy (augment-1) is a modular agent runtime in TypeScript/Bun, purpose-built for **persistent organizational interface agents** — long-running, memory-rich, organization-facing. Agents are composed from swappable **augments**; the kernel manages context, tools, permissions, and lifecycle. Open source, multi-engine, self-hostable.

**v0.2.0** — 11 augments, 3 engines, 1091+ tests. Agents boot from YAML, chat via AG-UI SSE, remember across restarts (peer-scoped layered memory), fetch URLs, pull org knowledge, escalate to the operator over webhooks or Telegram, run scoped shell commands, signal task completion, and enforce per-trust-level turn budgets + dollar ceilings via a 2PC turn-gate kernel capability.

## Where Auggy runs

Both local and cloud, first-class:

- **Local** — the default DX path. `aug1 dev <name>` for foreground; `aug1 start <name>` installs as a launchd service for always-on.
- **Cloud (Railway)** — for operators who don't want to own hardware. Per-service deployment with persistent volume (designed; ships at v1.0).

The runtime is the same in both topologies. Pick based on whether you want to run the agent on your own machine or on someone else's.

## Communication surfaces

| Direction | Mechanism |
|---|---|
| Visitor browser ↔ aug1 | `webTransport` — AG-UI SSE, four-path identity resolution, CORS, rate limiting |
| Operator/visitor ↔ aug1 (Telegram) | `telegramTransport` — bidirectional, polling or webhook |
| Operator ↔ aug1 (local GUI) | `aug1 chat` — Vite/React SPA + Bun proxy, discovers your running agents |
| aug1 → external systems | `notify` augment — webhook + Telegram adapters, rate-limited, named destinations |

aug1 ↔ aug1 (cross-agent A2A) is in active development. The destination network layer is **the Mesh** — a federated communication fabric for autonomous agents. The v1 entry ships as the **`link` augment** (peer-to-peer over AG-UI, mutual bearer auth, no central service). See [ADR-022](../docs/solutions/architecture/adr-022-mesh-destination-link-entry.md) for the destination + sequencing commitments. Operators can also build their own task or A2A protocols as augments.

## Quick start

```bash
# Install dependencies
bun install

# Create an agent (interactive augment selection)
aug1 create zip

# Configure secrets
cp zip/.env.example zip/.env
# Add your API key to zip/.env

# Run it
aug1 dev zip
```

## How it works

**Engines** drive the model call (one per agent). **Augments** plug in around it — context, tools, transport, memory (many per agent). Both are swappable via YAML.

Write a YAML config. The CLI resolves your augments, boots the kernel, and starts serving.

```yaml
id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c
name: zip
purpose: "Front-door agent"

engine:
  provider: anthropic           # or: openai, openrouter
  model: claude-sonnet-4-6

augments:
  - name: identity
    type: fileMemory
    options:
      label: self
      source: ./identity.md
      mutable: false
      origin: operator
      priority: required
      placement: system
      eviction: never

  - name: org
    type: orgContext
    options:
      baseUrl: ${ORG_CONTEXT_URL}

  - name: web
    type: webTransport
    options:
      port: 8080
      auth:
        type: bearer
        token: ${AUGGY_WEB_TOKEN}
```

## CLI

| Command | What it does |
|---------|-------------|
| `aug1 create <name>` | Scaffold agent directory (interactive augment selection) — defaults to `~/.auggy/agents/<name>/` |
| `aug1 add <name>` | Add augments to an existing agent |
| `aug1 dev <name>` | Run in foreground (Ctrl-C stops) |
| `aug1 start <name>` | Install as launchd service (always-on) |
| `aug1 stop <name>` | Stop a running agent |
| `aug1 restart <name>` | Stop and restart |
| `aug1 status [name]` | Show running agents |
| `aug1 ls` | List registered agents with status |
| `aug1 remove <name>` | Delete agent dir + clear index entry (refuses if running) |
| `aug1 chat [--port N]` | Launch the Local GUI to talk to running agents |

## Built-in augments

| Augment | What it provides |
|---------|-----------------|
| `fileMemory` | File-backed static memory (identity, notes, learned behaviors) |
| `layeredMemory` | Peer-scoped episodic memory with provenance (L0-L3 layers, SQLite or Supabase backend) |
| `filesystem` | Multi-mount scoped file access (6 tools, realpath security) |
| `webTransport` | AG-UI SSE chat transport (HTTP, four-path identity resolution, CORS, rate limiting, Idempotency-Key dedup) |
| `webFetch` | URL fetch with HTML-to-text and JSON passthrough |
| `orgContext` | Org knowledge via manifest API (org_fetch tool, read-only) |
| `notify` | Outbound operator messaging (webhook + Telegram adapters, per-peer rate limits, severity routing) |
| `telegramTransport` | Bidirectional Telegram chat transport (polling or webhook, four-path identity, ephemeral or durable peers) |
| `bash` | Scoped shell execution (allowlist, cwd, timeout; default `perTrustLevel` blocks `shell_exec`/`run_script` for public + agent) |
| `budgets` | Per-trust-level turn budgets + per-peer dollar ceiling via 2PC turn-gate (BATS-style budget-aware preamble + post-hoc cost commit) |
| `turnControl` | Task-completion signaling (`request_input` tool + `ToolResult.terminate` directive surfaced as `RUN_FINISHED.result.status`) |

## Engines

| Provider | Model examples | Config |
|----------|---------------|--------|
| `anthropic` | claude-sonnet-4-6, claude-opus-4-6 | `ANTHROPIC_API_KEY` env |
| `openai` | gpt-5, o3 | `OPENAI_API_KEY` env |
| `openrouter` | qwen/qwen3.5-397b-a17b, any model | `OPENROUTER_API_KEY` env |

## Custom augments

Export a factory function from a `.ts` file:

```typescript
import { defineAugment, defineTool } from "augment-1";
import { z } from "zod";

export default function myAugment(opts: { apiUrl: string }) {
  return defineAugment({
    name: "my-augment",
    capabilities: ["tools"],
    tools: [
      defineTool({
        name: "my_tool",
        description: "Does something useful",
        category: "search",
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const res = await fetch(`${opts.apiUrl}?q=${query}`);
          return await res.text();
        },
      }),
    ],
  });
}
```

Reference it in `agent.yaml`:

```yaml
augments:
  - name: my-augment
    type: custom
    source: ./augments/my-augment.ts
    options:
      apiUrl: ${MY_API_URL}
```

## Architecture

Three primitives, independent of each other:

- **Augments** — infrastructure (context, tools, transport, memory, lifecycle)
- **Tools** — mechanism (callable functions the model invokes)
- **Skills** — teaching (markdown files the model reads on demand)

The kernel (~1000 LOC) runs turns. Everything domain-specific is an augment.

See [`docs/`](docs/README.md) for the full reference documentation.

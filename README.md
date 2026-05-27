<p align="center">
  <img src="assets/auggy.png" alt="Auggy — a sketch of a modular robot with detachable arms, sensors, and accessories" width="220" />
</p>

<h1 align="center">Augment-1</h1>

<p align="center">
  <a href="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml"><img src="https://github.com/looselyorganized/augment-1/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/looselyorganized/augment-1/releases/latest"><img src="https://img.shields.io/badge/release-v0.3.1-blue" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/auggy"><img src="https://img.shields.io/npm/v/auggy?label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript" alt="TypeScript" />
  <a href="https://looselyorganized.xyz"><img src="https://img.shields.io/badge/powered%20by-LORF-red" alt="LORF" /></a>
</p>

Auggy (augment-1) is a modular agent runtime in TypeScript/Bun, purpose-built for **persistent organizational interface agents** — long-running, memory-rich, organization-facing. Agents are composed from swappable **augments**; the kernel manages context, tools, permissions, and lifecycle. Open source, multi-engine, self-hostable.

**v0.3.1 on npm (2026-05-12)** — 12 built-in augments, 3 engines, 1840 tests, end-to-end Railway deploy via `auggy deploy <name> --to railway`. Agents boot from YAML, chat via AG-UI SSE, remember across restarts (peer-scoped layered memory with post-turn fact extraction), verify visitors via email magic links, fetch URLs, pull org knowledge, escalate to the operator, run scoped shell commands, and enforce per-trust-level turn budgets + dollar ceilings via a 2PC turn-gate kernel capability.

## Quick start

```bash
# Install the CLI globally (requires Bun: https://bun.sh/install)
npm i -g auggy

# Create an agent (interactive augment selection)
auggy create zip

# Configure secrets
cp zip/.env.example zip/.env
# Add your API key to zip/.env

# Run locally (foreground)
auggy dev zip

# Or install as a launchd service (macOS, always-on)
auggy start zip

# Or deploy to the cloud (requires Railway CLI + `railway login`)
auggy deploy zip --to railway
```

The `auggy` binary requires [Bun](https://bun.sh) at runtime. The package
ships TypeScript sources; Bun executes them directly without a build step.

> For local development against an in-progress branch, use the workspace install:
> `git clone …augment-1 && cd augment-1 && bun install && bun link`.
> The `auggy` binary lands on PATH the same way as the published package.

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
    type: manifest
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
| `auggy create <name>` | Scaffold agent directory (interactive augment selection) |
| `auggy add <name>` | Add augments to an existing agent |
| `auggy dev <name>` | Run in foreground (Ctrl-C stops) |
| `auggy start <name>` | Install as launchd service (always-on) |
| `auggy stop <name>` | Stop a running agent |
| `auggy restart <name>` | Stop and restart |
| `auggy status [name]` | Show running agents |

## Built-in augments

| Augment | What it provides |
|---------|-----------------|
| `fileMemory` | File-backed static memory (identity, notes, learned behaviors) |
| `layeredMemory` | Peer-scoped episodic memory with provenance (L0-L3 layers, SQLite or Supabase backend) |
| `filesystem` | Multi-mount scoped file access (6 tools, realpath security) |
| `webTransport` | AG-UI SSE chat transport (HTTP, four-path identity resolution, CORS, rate limiting, Idempotency-Key dedup) |
| `webFetch` | URL fetch with HTML-to-text and JSON passthrough |
| `manifest` | Org knowledge via manifest API (manifest_fetch tool) |
| `notify` | Outbound operator messaging (webhook + Telegram adapters, per-peer rate limits) |
| `bash` | Scoped shell execution (allowlist, cwd, timeout; default `perTrustLevel` blocks `shell_exec`/`run_script` for public + agent) |
| `budgets` | Per-trust-level turn budgets + per-peer dollar ceiling via 2PC turn-gate (BATS-style budget-aware preamble + post-hoc cost commit) |

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

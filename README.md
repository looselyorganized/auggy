# Auggy

A modular agent runtime in TypeScript/Bun. Agents are composed from swappable **augments** — the kernel manages context, tools, permissions, and lifecycle. Framework-agnostic by design.

**v0.1.0** — 6 augments, 3 engines, 406 tests. Agents boot from YAML, chat via AG-UI SSE, remember across restarts, fetch URLs, pull org knowledge, and escalate to the operator.

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
| `aug1 create <name>` | Scaffold agent directory (interactive augment selection) |
| `aug1 add <name>` | Add augments to an existing agent |
| `aug1 dev <name>` | Run in foreground (Ctrl-C stops) |
| `aug1 start <name>` | Install as launchd service (always-on) |
| `aug1 stop <name>` | Stop a running agent |
| `aug1 restart <name>` | Stop and restart |
| `aug1 status [name]` | Show running agents |

## Built-in augments

| Augment | What it provides |
|---------|-----------------|
| `fileMemory` | File-backed static memory (identity, notes, learned behaviors) |
| `supabaseMemory` | Supabase-backed namespace memory (episodic, visitor profiles) |
| `filesystem` | Multi-mount scoped file access (6 tools, realpath security) |
| `webTransport` | AG-UI SSE chat transport (HTTP, bearer auth, CORS, rate limiting) |
| `webFetch` | URL fetch with HTML-to-text and JSON passthrough |
| `orgContext` | Org knowledge via manifest API (org_fetch + org_escalate tools) |

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

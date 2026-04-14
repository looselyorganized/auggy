# Auggy

A modular agent runtime in TypeScript/Bun. Agents are composed from swappable **augments** — the kernel manages context, tools, permissions, and lifecycle. Framework-agnostic by design.

## Quick start

```bash
# Install dependencies
bun install

# Create an agent
auggy create zip

# Configure it
vim zip/agent.yaml
echo "ANTHROPIC_API_KEY=sk-ant-..." > zip/.env

# Run it
auggy dev zip
```

## How it works

Write a YAML config. The CLI resolves your augments, boots the kernel, and starts serving.

```yaml
id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c
name: zip
purpose: "Front-door agent"

engine:
  provider: anthropic
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
| `auggy create <name>` | Scaffold agent directory |
| `auggy dev <name>` | Run in foreground (Ctrl-C stops) |
| `auggy start <name>` | Install as launchd service (always-on) |
| `auggy stop <name>` | Stop a running agent |
| `auggy status [name]` | Show running agents |

## Built-in augments

| Augment | What it provides |
|---------|-----------------|
| `fileMemory` | File-backed static memory (identity, notes, learned behaviors) |
| `supabaseMemory` | Supabase-backed namespace memory (episodic, visitor profiles) |
| `filesystem` | Multi-mount scoped file access (6 tools, realpath security) |
| `webTransport` | AG-UI SSE chat transport (HTTP, bearer auth, CORS, rate limiting) |
| `webFetch` | URL fetch with HTML-to-text and JSON passthrough |

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

## Status

Plans 1 (kernel), 2 (built-in augments), and 3 (CLI) are complete. 310 tests passing. See the [roadmap](../docs/auggy-plans-roadmap.md) for what's next.

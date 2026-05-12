# 02 — Architecture Overview

> Module map, data flow through a single turn, where each piece lives.

## High-level shape

```
                              ┌────────────────────┐
                              │  Peer (human, agent│
                              │  system, MCP, etc.)│
                              └──────────┬─────────┘
                                         │
                                         ▼
                       ┌─────────────────────────────────┐
                       │       Transport Augment         │
                       │   (e.g. webTransport: AG-UI)    │
                       │                                 │
                       │  identify() ──▶ PeerIdentity    │
                       │  POST /agent/run ──▶ trigger    │
                       └────────────────┬────────────────┘
                                        │ kernel.handleInbound(trigger, {onEvent})
                                        ▼
                       ┌─────────────────────────────────┐
                       │       Transport Queue           │
                       │  rate limit, queue depth,       │
                       │  concurrency cap                │
                       └────────────────┬────────────────┘
                                        │ enqueue → handler(trigger)
                                        ▼
                  ┌────────────────────────────────────────┐
                  │              TURN LOOP                 │
                  │                                        │
                  │  1. emit run_started                   │
                  │  2. append inbound to history          │
                  │  3. fire onTurnStart hooks             │
                  │  4. run augment context() pipeline     │
                  │  5. select tools (capability table)    │
                  │  6. assemble prompt (allocator)        │
                  │  7. ┌─────────────────────────────┐    │
                  │     │  inference loop (≤ 10×):    │    │
                  │     │   - model.complete(prompt)  │    │
                  │     │   - if tool_use:            │    │
                  │     │     validate, exec parallel │    │
                  │     │     append to history       │    │
                  │     │     loop                    │    │
                  │     │   - if end_turn: emit msg,  │    │
                  │     │     emit run_finished, exit │    │
                  │     └─────────────────────────────┘    │
                  │  8. validate output (flag, don't block)│
                  │  9. eager compaction                   │
                  │  10. fire onTurnEnd hooks              │
                  └────────────────┬───────────────────────┘
                                   │ TurnResult
                                   ▼
                          (back to transport)
                                   │
                                   ▼
                          (response to peer)
```

Every box that touches the model also reports through the same `onEvent` callback. Every component in the loop is a separate file in `src/kernel/`. The loop itself is `src/kernel/turn-loop.ts`.

## Module responsibilities

### `src/types.ts`
The single source of truth for every shape that crosses a module boundary. Everything in this file is a `type` or `interface` — there is no runtime code in `types.ts`. If two modules need to agree on a shape, that shape lives here.

See [03-types.md](./03-types.md) for the full type catalog.

### `src/agent.ts`
Defines `defineAgent(config, model) → AgentHandle`. This is the primary entry point users call. Internally it:
1. Wires the memory bus (`wireMemoryBus`) to synthesize context for memory providers and add the synthetic `memory-bus` augment with the four generic memory tools.
2. Generates the agent card from the *effective* config (with the synthetic augment included).
3. Constructs a `LifecycleManager` and a `TurnLoop`.
4. Returns an `AgentHandle` with `start()`, `stop()`, `health()`, `card()`, and `inject()`.

`start()` boots all augments, registers transports (each gets its own `TransportQueue` and a `TransportKernel` view onto the runtime), and starts the idle timer.

### `src/agent-card.ts`
`generateAgentCard(config) → AgentCard`. Walks the augment list and produces a JSON document conforming to the A2A Agent Card shape: provider, purpose, capabilities (memory/transport detected from augments), skills (tool name+description+category from every augment's tools), interfaces, extensions.

### `src/kernel/`
The runtime. Each file is one component with one responsibility. See [04-kernel.md](./04-kernel.md) for details on each.

| File | Responsibility |
|------|---------------|
| `turn-loop.ts` | Orchestrates a single turn end-to-end. The largest file in the kernel (~600 LOC). |
| `context-allocator.ts` | Takes augment context blocks + history + tool definitions and assembles them into an `AssembledPrompt` within a token budget, evicting low-priority blocks first. |
| `capability-table.ts` | Tracks which tools are exposed, which require approval, which are blocked, and per-augment + global tool-call counters. |
| `history-manager.ts` | Per-thread message log. Knows how to walk backwards from newest within a token budget, keep `tool_use`/`tool_result` pairs atomic, and compact when over threshold. |
| `tool-selector.ts` | Filters tools through `capabilityTable.canExpose` and converts them to `ToolDefinition[]` for the model. (Two-phase selection deferred — v1 mounts all <25 tools.) |
| `lifecycle-manager.ts` | Boots augments in order, runs `onShutdown` in reverse, manages the idle timer, reports health. |
| `transport-queue.ts` | Per-transport queue: rate-limit per peer, max queue depth, concurrency cap. Returns synchronous rejection results when limits are exceeded. |
| `trace-emitter.ts` | Builds a `TurnTrace` over the course of a turn — context assembly, tool selection, inference steps, capability checks, output validation. |
| `timeout.ts` | `withTimeout(fn, ms)` — wraps a promise in a race against a timer. Used by augment context, tool execution, and shutdown. |
| `output-validator.ts` | Scans model output for suspicious patterns (e.g. fabricated tool names). v1 flags only — does not block. |
| `preamble.ts` | Builds the system preamble that gets prepended to every turn — trust info, hardening rules. |

### `src/memory/`
The memory subsystem. A separate concern from the kernel because memory is augment-territory — but memory has enough internal structure (registry, conflict detection, context synthesis, generic tools) that it deserves its own subdirectory.

| File | Responsibility |
|------|---------------|
| `types.ts` | `MemoryRegistry` interface (label → augment maps). |
| `registry.ts` | `buildRegistry(providers)` — three-pass conflict detection (static-static, namespace-namespace overlap, static-falls-under-namespace). `lookupProvider(registry, label)` for routing. |
| `memory-bus.ts` | `wireMemoryBus(augments)` — top-level helper called by `defineAgent`. Synthesizes `context()` for memory providers, builds the registry, creates the synthetic `memory-bus` augment with the four generic tools and a per-turn budget. |
| `context-synthesis.ts` | `synthesizeContextFor(aug)` — wraps a memory provider augment so it has a `context()` function that automatically retrieves blocks from `read()` (static) or `search(query)` (namespace). |
| `tools.ts` | `createMemoryTools(registry)` — returns the four generic memory tools (`memory_read`, `memory_write`, `memory_search`, `memory_list`) with a shared per-turn budget. |

See [05-memory-subsystem.md](./05-memory-subsystem.md) for the full picture.

### `src/transports/`
Transport implementations and shared transport infrastructure.

| File | Responsibility |
|------|---------------|
| `ag-ui-events.ts` | AG-UI event types (the wire format for the chat protocol), constructor helpers, `translateKernelEvent(ke)` (kernel event → AG-UI events), `serializeSSE(event)`. |
| `web-transport.ts` | The built-in HTTP transport. Exposes `POST /agent/run` (AG-UI SSE), `GET /health`, `GET /.well-known/agent-card.json`. Uses Bun.serve and ReadableStream for true streaming. |

See [06-transports.md](./06-transports.md) for the transport contract and the AG-UI protocol details.

### `src/augments/`
Built-in augments. This directory is intentionally small — only augments that are clearly load-bearing for the LORF use case live here. Application-specific augments live in the application's repo.

| File | Responsibility |
|------|---------------|
| `file-memory/` | `fileMemory(opts)` — static memory provider backed by a single file. Loads at boot, optionally writes back. Used for identity (`mutable: false`) and self-notes (`mutable: true`). |
| `supabase-memory/` | `supabaseMemory(opts)` — namespace memory provider backed by a Supabase table. Insert + ILIKE search + label-prefix isolation. |
| `layered-memory/` | `layeredMemory(opts)` — peer-scoped episodic memory with L0–L3 provenance tiers (SQLite or Supabase backend). Includes background fact-extraction (`autoSave`). |
| `filesystem/` | `filesystem(opts)` — multi-mount scoped file access (6 tools, realpath-based sandbox). Bundled `skill/SKILL.md` shipped alongside. |
| `web-fetch/` | `webFetch(opts)` — URL fetch with HTML→text conversion and JSON passthrough. Uses the shared `src/http.ts` client. |
| `org-context/` | `orgContext(opts)` — org knowledge augment (manifest + `org_fetch`). HTTP or `file://` baseUrl. |
| `skills/` | `skills(opts)` — model-facing skill surface (ADR-030). Scans a configured `dir:` and emits a single system-placement context block listing each mounted skill from its SKILL.md frontmatter. |
| `notify/` | `notify(opts)` — outbound messaging augment (webhook + Telegram adapters, per-peer rate limits). |
| `bash/` | `bash(opts)` — scoped shell execution (allowlist, working dir, timeout). |
| `turn-control/` | `turnControl(opts)` — `request_input` for hand-off prompts. |
| `budgets/` | `budgets(opts)` — per-trust-level turn budgets + dollar ceiling (SQLite-backed). |
| `visitor-auth/` | `visitorAuth(opts)` — email magic-link verification (`request_auth` tool + `/visitor-auth/verify` HTTP route). |
| `telegram-transport/` | `telegramTransport(opts)` — Telegram bot transport. |

See [07-built-in-augments.md](./07-built-in-augments.md).

### `src/engines/`
Model client adapters. Each engine is a `createXxxModel(opts) → ModelClient` factory that normalizes a provider's API onto the kernel's `ModelClient` contract.

| File | Responsibility |
|------|---------------|
| `anthropic.ts` | Anthropic Messages API adapter. |
| `openai.ts` | OpenAI Chat Completions adapter (handles message coalescing). |
| `openrouter.ts` | OpenRouter multi-provider adapter. |
| `_shared/schema-normalize.ts` | Zod → JSON Schema normalization used by all engines. |

Engines are a reasoning-engine concern, not a model-metadata concern — see [01-philosophy.md](./01-philosophy.md) for why the directory is named `engines/` and not `models/`.

### `src/cli/` — the `auggy` CLI (Plan 3)
Turns Auggy from "write a `main.ts`" into "configure a YAML file and run `auggy start`." Each file is one concern.

| File | Responsibility |
|------|---------------|
| `index.ts` | Commander.js entrypoint. |
| `types.ts` | `ParsedConfig`, `PidManifest`, `AugmentConfig`, etc. |
| `config-parser.ts` | YAML → env interpolation → validation → `ParsedConfig`. |
| `augment-catalog.ts` | Registry of built-in augments available to `auggy create / add`. |
| `augment-resolver.ts` | `AugmentConfig[]` → `Augment[]` (built-in + custom). |
| `engine-resolver.ts` | `EngineConfig` → `ModelClient`. |
| `resolve-config.ts` | Shared config path resolution. |
| `pid-registry.ts` | `~/.auggy/<name>.json` atomic PID manifests. |
| `plist-generator.ts` | macOS launchd plist generation. |
| `scaffold.ts` | `auggy create` directory + template generation. |
| `scaffold-skills.ts` | Identity-template rendering + bundled-skill copy helpers. |
| `skill-frontmatter.ts` | YAML frontmatter parser for SKILL.md files (agentskills.io standard). |
| `skill-validator.ts` | Boot-time validator: warns when a tool-providing augment lacks a mounted skill. |
| `commands/create.ts` | `auggy create <name>` — interactive scaffold. |
| `commands/add.ts` | `auggy add <name>` — add augments to an existing agent. |
| `commands/dev.ts` | `auggy dev <name>` — foreground runner (core lifecycle). |
| `commands/start.ts` | `auggy start <name>` — install as launchd service. |
| `commands/stop.ts` | `auggy stop <name>` — SIGTERM or `launchctl unload`. |
| `commands/restart.ts` | `auggy restart <name>` — stop + start. |
| `commands/status.ts` | `auggy status [name]` — list or detail view. |

### `src/parts.ts`, `src/helpers.ts`, `src/tokenizer.ts`, `src/http.ts`
Small utility modules.

- `parts.ts` — `extractText(parts)`, `textPart(text)`, `dataPart(data)`. The A2A `Part[]` shape requires helpers to convert between text-only and the polymorphic content type.
- `helpers.ts` — `defineAugment(spec)`, `defineTool(spec)`. These are pass-throughs that exist purely for type inference (so users get autocomplete on partial specs). They're not factories — they don't add behavior.
- `tokenizer.ts` — `createTokenizer()` returns a `{count(text)}` object. v1 uses a simple character-divided-by-4 estimate. Real tokenization is a model-specific concern that should live in the `ModelClient` adapter.
- `http.ts` — shared HTTP client used by `webFetch` and `orgContext`. Enforces redirect security (same-origin on auth redirects), body size cap, and auth-header stripping on cross-origin redirects.

### `src/index.ts`
The public API surface. Re-exports everything users should be able to import. If a symbol isn't in `index.ts`, it's an internal detail.

## Data flow through a turn

This is what happens when a peer sends a message via the web transport.

### 1. The peer sends an HTTP request

```
POST /agent/run
Authorization: Bearer <token>
x-peer-id: visitor-001
x-peer-kind: human
Content-Type: application/json

{ "messages": [{ "role": "user", "content": "are you open?" }] }
```

### 2. The transport authenticates and identifies

`webTransport.handleAgentRun` checks the bearer token, builds a `PeerIdentity` from `x-peer-*` headers (via `transport.identify()`), parses the body, and constructs a `TurnTrigger`:

```ts
{
  type: "message",
  turnId: crypto.randomUUID(),
  threadId: ...,
  timestamp: ...,
  source: "web",
  peer: { id: "visitor-001", kind: "human", trustLevel: "public", ... },
  payload: {
    parts: [{ kind: "text", text: "are you open?" }],
    sourceAugment: "web",
    peer: ...,
    timestamp: ...,
  }
}
```

### 3. The transport opens an SSE stream and calls the kernel

```ts
const stream = new ReadableStream({
  start(controller) {
    const onEvent = (ke) => {
      for (const e of translateKernelEvent(ke)) {
        controller.enqueue(serializeSSE(e));
      }
    };
    kernel.handleInbound(trigger, { onEvent }).then(...).finally(() => controller.close());
  }
});
return new Response(stream, { headers: { "content-type": "text/event-stream" } });
```

The HTTP response is now an open SSE stream. Every event the kernel emits will be written to the stream as a `data: {...}\n\n` frame and flushed to the client immediately.

### 4. The transport queue gates the request

The transport's `concurrency`/`maxQueueDepth`/`rateLimitPerPeer` settings live in the queue. If the request is rejected (rate limit, queue full), the queue returns a `TurnResult` with `status: "rejected"` and the transport synthesizes a `RUN_ERROR` (code: `REJECTED`) + `RUN_FINISHED` event pair into the SSE stream and closes it.

If accepted, the request enters the actual turn loop.

### 5. The turn loop runs

(Each numbered step is explained in detail in [04-kernel.md](./04-kernel.md). This is the high-level sketch.)

1. **Emit `run_started`** with turnId, threadId, contextId, taskId.
2. **Append inbound to history** — extract text from `parts`, push as a `user` message into the per-thread `HistoryManager`.
3. **Fire `onTurnStart` hooks** — every augment that has one runs. The synthetic `memory-bus` augment uses this to reset its per-turn budget.
4. **Run augment context pipeline** — sequentially, every augment with a `context()` function gets called. The result is `ContextBlock[]`. Required augments that throw abort the turn; non-required augments that throw are skipped.
5. **Build preamble** with peer identity and trust info.
6. **Select tools** — capability table filters out `neverExpose` tools and converts the rest to `ToolDefinition[]` for the model.
7. **Assemble prompt** — the allocator takes `(contextBlocks, history, toolDefinitions)` and produces an `AssembledPrompt` within the token budget. Lower-priority blocks get evicted first.
8. **Inference loop:**
   - Call `model.complete(prompt)`.
   - If `finishReason === "end_turn"` (or no tool calls): emit `text_message`, emit `run_finished`, return.
   - Else for each tool call: validate (capability table + Zod schema), execute in parallel via `Promise.all`, emit `tool_call_started`, `tool_call_args`, `tool_call_result` events, append `tool_use`/`tool_result` pairs to history.
   - Loop back to inference. Cap at 10 iterations.
9. **Validate output** (v1: flag in trace, don't block).
10. **Return `TurnResult`** with `status`, `response`, `toolCalls`, `trace`.

### 6. The transport flushes the final events

After `kernel.handleInbound` resolves, the transport closes the ReadableStream. The client has now received the full sequence of AG-UI events for the turn.

### 7. Eager compaction + onTurnEnd hooks

After the turn returns, `defineAgent` runs `historyManager.compact()` against the configured strategy (`truncate` by default), then fires every augment's `onTurnEnd` hook (non-blocking — failures are swallowed).

## Lifecycle: from boot to shutdown

```
defineAgent(config, model)              ← user code
   │
   ▼
agent.start()                            ← user code
   │
   ├─ wireMemoryBus(augments)            ← agent.ts (already happened in defineAgent)
   ├─ generateAgentCard(effectiveConfig) ← agent.ts
   ├─ lifecycle.boot()                   ← lifecycle-manager.ts
   │    └─ for each augment: aug.onBoot?.()
   │       (fileMemory loads its file, supabaseMemory does nothing,
   │        webTransport starts Bun.serve)
   │
   ├─ for each transport augment:
   │    ├─ create TransportQueue(spec.concurrency, spec.maxQueueDepth, spec.rateLimitPerPeer)
   │    ├─ create TransportKernel { handleInbound, onOutbound, getAgentCard }
   │    └─ aug.transport.register(transportKernel)
   │       (webTransport just stores the kernel reference for later)
   │
   └─ start idle timer (5min by default; calls aug.onIdle?.() on each augment)

(time passes; turns happen via transport.handleInbound)

agent.stop()                             ← user code
   │
   ├─ stop idle timer
   └─ lifecycle.shutdown()
        └─ for each augment in REVERSE order: aug.onShutdown?.() (with 5s timeout)
           (webTransport stops Bun.serve)
```

## Where invariants live

| Invariant | Enforced by |
|-----------|-------------|
| Memory labels are unique across all providers | `buildRegistry` in `src/memory/registry.ts` (throws at boot) |
| Token budget is never exceeded | `context-allocator.ts` (drops blocks before returning prompt) |
| `tool_use` and `tool_result` messages stay paired | `history-manager.ts` (atomic append + atomic eviction) |
| Tools without `canExpose` permission are never sent to the model | `capability-table.ts` + `tool-selector.ts` |
| Tools that exceed per-augment limits are denied | `capability-table.ts` |
| Non-required augment failures don't abort turns | `turn-loop.ts` (try/catch around context, with `if (aug.required)` rethrow) |
| Required augment failures DO abort turns | `turn-loop.ts` (same try/catch, opposite branch) |
| Rate-limited / queue-rejected turns get a terminal SSE event | `web-transport.ts` (checks `result.status === "rejected"`) |
| Memory tool calls don't exceed per-turn budget | `memory/tools.ts` (`checkBudget()`) AND `capability-table.ts` (per-augment limit set in `memory-bus.ts`) |

If you're reading code and asking "what stops this from happening?", one of these files has the answer.

## What runs concurrently vs sequentially

- **Augment context pipeline:** sequential. Each augment's `context()` runs after the previous. This is intentional — augments may depend on prior context (and can opt in via `receivesPriorContext: true`).
- **Tool execution within a single inference step:** parallel. `Promise.all` over all validated tool calls.
- **Multiple inferences in one turn:** sequential (you can't call the model in parallel — each call needs the previous tool results in history).
- **Multiple turns from different peers:** controlled by the transport's queue. `concurrency` defaults to 1 — turns are serialized within a transport. Bumping `concurrency` lets multiple turns from different peers run simultaneously.
- **`onTurnEnd` hooks:** fire-and-forget. They don't block the response.

## What you should read next

- If you need to understand the *types* people pass around: [03-types.md](./03-types.md).
- If you need to understand the *runtime mechanics*: [04-kernel.md](./04-kernel.md).
- If you need to understand *memory*: [05-memory-subsystem.md](./05-memory-subsystem.md).
- If you need to understand *protocols / chat / discovery*: [06-transports.md](./06-transports.md).

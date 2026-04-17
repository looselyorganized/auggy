# 10 — System Diagrams

> Visual maps of Auggy's architecture, components, and data flow.

---

## 1. The Three Primitives

How augments, tools, and skills relate — and what each one is for.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  OPERATOR CONFIGURES                                                │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                      AUGMENTS                               │    │
│  │  Composable units mounted at defineAgent() time.            │    │
│  │  Each augment provides some combination of:                 │    │
│  │                                                             │    │
│  │   context()  ──► prompt blocks every turn                   │    │
│  │   tools[]    ──► callable functions for the model           │    │
│  │   transport  ──► inbound/outbound message channel           │    │
│  │   memory     ──► labeled state (static or namespace)        │    │
│  │   lifecycle  ──► boot / shutdown / turnStart / turnEnd      │    │
│  └─────────────────────────────────────────────────────────────┘    │
│        │                                                            │
│        │ provides                                                   │
│        ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                       TOOLS                                 │    │
│  │  Single callable functions. Name + schema + execute.        │    │
│  │  The model sees them in its tool list and calls them.       │    │
│  │                                                             │    │
│  │   memory_read({ label })     fs_read({ path })              │    │
│  │   memory_write({ label })    fs_write({ path, content })    │    │
│  │   memory_search({ query })   fs_list({ path })              │    │
│  │   memory_list()              fs_search({ path, pattern })   │    │
│  │                              fs_mkdir({ path })             │    │
│  │                              fs_remove({ path })            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  MODEL READS ON DEMAND                                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                       SKILLS                                │    │
│  │  Markdown files on disk. Teaching, not code.                │    │
│  │  The model reads them via fs_read when it needs guidance.   │    │
│  │                                                             │    │
│  │   skills/memory/SKILL.md          ← "when to write vs      │    │
│  │   skills/memory/references/...       search, examples"      │    │
│  │   skills/filesystem/SKILL.md      ← "check size before     │    │
│  │   skills/escalation/SKILL.md         read, mount perms"     │    │
│  │                                                             │    │
│  │  Progressive disclosure:                                    │    │
│  │   Level 1: Manifest in context (~100 tokens, always)        │    │
│  │   Level 2: SKILL.md body (2-5K tokens, on demand)           │    │
│  │   Level 3: References (variable, deeper demand)             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  Augments are INFRASTRUCTURE.                                       │
│  Tools are MECHANISM.                                               │
│  Skills are TEACHING.                                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Full System Architecture

Everything that exists in a running Auggy agent and how the pieces connect.

```
                         ┌─────────────────────────┐
                         │        PEER              │
                         │  (human, agent, system)  │
                         └────────────┬────────────┘
                                      │ HTTP POST /agent/run
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ TRANSPORT LAYER                                                          │
│                                                                          │
│  ┌──────────────────────────────────────────────────┐                    │
│  │  webTransport (AG-UI SSE)                        │                    │
│  │  ├── identify() → PeerIdentity                   │                    │
│  │  ├── bearer auth (timing-safe)                   │                    │
│  │  ├── CORS preflight (OPTIONS)                    │                    │
│  │  ├── POST /agent/run → ReadableStream SSE        │                    │
│  │  ├── GET /health                                 │                    │
│  │  └── GET /.well-known/agent-card.json            │                    │
│  └──────────────────────┬───────────────────────────┘                    │
│                         │                                                │
│  ┌──────────────────────▼───────────────────────────┐                    │
│  │  Transport Queue                                 │                    │
│  │  ├── concurrency cap (default 1)                 │                    │
│  │  ├── max queue depth (default 50)                │                    │
│  │  ├── rate limit per peer (with stale eviction)   │                    │
│  │  └── rejected → RUN_ERROR + RUN_FINISHED SSE     │                    │
│  └──────────────────────┬───────────────────────────┘                    │
│                         │ kernel.handleInbound(trigger, {onEvent})       │
└─────────────────────────┼────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ KERNEL (~1000 LOC — finished, not extensible)                            │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │                        TURN LOOP                                │     │
│  │                                                                 │     │
│  │  1. Emit RUN_STARTED ──────────────────────► onEvent callback   │     │
│  │  2. Append inbound to history                                   │     │
│  │  3. Fire onTurnStart hooks                                      │     │
│  │  4. Run augment context() pipeline (sequential)                 │     │
│  │  5. Build preamble (trust info + hardening rules)               │     │
│  │  6. Select tools (capability table filters)                     │     │
│  │  7. Assemble prompt (context allocator)                         │     │
│  │  8. ┌────────────────────────────────────┐                      │     │
│  │     │  Inference loop (≤ configurable N) │                      │     │
│  │     │  model.complete(prompt) ◄──────────┼──── ENGINE           │     │
│  │     │  if tool_calls:                    │                      │     │
│  │     │    validate (Zod + capability)     │                      │     │
│  │     │    execute (Promise.all + timeout) │                      │     │
│  │     │    emit TOOL_CALL_* ──────────────►│──► onEvent           │     │
│  │     │    append to history               │                      │     │
│  │     │    loop                            │                      │     │
│  │     │  if done:                          │                      │     │
│  │     │    emit TEXT_MESSAGE ──────────────►│──► onEvent           │     │
│  │     │    emit RUN_FINISHED ─────────────►│──► onEvent           │     │
│  │     └────────────────────────────────────┘                      │     │
│  │  9. Validate output (flag, don't block)                         │     │
│  │  10. Return TurnResult                                          │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  SUPPORTING COMPONENTS:                                                  │
│                                                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐      │
│  │  Context     │ │ Capability  │ │  History     │ │  Tool        │      │
│  │  Allocator   │ │ Table       │ │  Manager     │ │  Selector    │      │
│  │             │ │             │ │  (per thread)│ │              │      │
│  │ Priority    │ │ neverExpose │ │ Budget walk  │ │ Mount all    │      │
│  │ eviction,   │ │ approval    │ │ Atomic pairs │ │ below 25,    │      │
│  │ token       │ │ gates,      │ │ Compaction   │ │ filter via   │      │
│  │ budgeting   │ │ per-augment │ │ (truncate/   │ │ canExpose    │      │
│  │             │ │ call limits │ │  sliding)    │ │              │      │
│  │ LRU evict   │ │             │ │              │ │              │      │
│  │ at 500      │ │             │ │              │ │              │      │
│  │ threads     │ │             │ │              │ │              │      │
│  └─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘      │
│                                                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                       │
│  │  Lifecycle   │ │  Trace      │ │  Preamble   │                       │
│  │  Manager     │ │  Emitter    │ │  Builder    │                       │
│  │             │ │             │ │             │                       │
│  │ Boot/       │ │ Per-turn    │ │ Trust info  │                       │
│  │ shutdown    │ │ structured  │ │ + hardening │                       │
│  │ Idle timer  │ │ events      │ │ rules       │                       │
│  │ Health      │ │             │ │             │                       │
│  └─────────────┘ └─────────────┘ └─────────────┘                       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                          │
                          │ tools call into
                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ AUGMENT LAYER (operator-configured, composable)                          │
│                                                                          │
│  ┌─────────────────────┐  ┌─────────────────────┐                       │
│  │  fileMemory          │  │  supabaseMemory      │                      │
│  │  label: "self"       │  │  namespace: "episode" │                      │
│  │  source: identity.md │  │  client: supabase     │                      │
│  │  mutable: false      │  │  mutable: true        │                      │
│  │                      │  │                       │                      │
│  │  Provides:           │  │  Provides:            │                      │
│  │  • memory (static)   │  │  • memory (namespace) │                      │
│  │  • context (synth'd) │  │  • context (synth'd)  │                      │
│  └─────────────────────┘  └───────────────────────┘                      │
│                                                                          │
│  ┌─────────────────────┐  ┌─────────────────────┐                       │
│  │  memory-bus          │  │  filesystem           │                      │
│  │  (SYNTHETIC)         │  │                       │                      │
│  │                      │  │  mounts:              │                      │
│  │  Created by kernel   │  │  • skills (read-only) │                      │
│  │  from memory         │  │  • workspace (rw)     │                      │
│  │  providers           │  │  • repo (read-only)   │                      │
│  │                      │  │                       │                      │
│  │  Provides:           │  │  Provides:            │                      │
│  │  • tools:            │  │  • tools:             │                      │
│  │    memory_read       │  │    fs_read            │                      │
│  │    memory_write      │  │    fs_write           │                      │
│  │    memory_search     │  │    fs_list            │                      │
│  │    memory_list       │  │    fs_mkdir           │                      │
│  │  • onTurnStart       │  │    fs_remove          │                      │
│  │    (budget reset)    │  │    fs_search          │                      │
│  └─────────────────────┘  └───────────────────────┘                      │
│                                                                          │
│  ┌─────────────────────┐                                                 │
│  │  webTransport        │  (shown in transport layer above — lives here  │
│  │                      │   architecturally, renders there physically)   │
│  └─────────────────────┘                                                 │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                          │
                          │ model.complete(prompt)
                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ ENGINE LAYER                                                             │
│                                                                          │
│  ┌─────────────────────────────────────────┐                             │
│  │  createAnthropicEngine                  │                             │
│  │                                         │                             │
│  │  AssembledPrompt ──► Messages API       │                             │
│  │  Messages API    ──► ModelResponse      │                             │
│  │                                         │                             │
│  │  • System text assembly                 │                             │
│  │  • Message role coalescing              │                             │
│  │  • Tool schema normalization            │                             │
│  │  • Input type validation                │                             │
│  └─────────────────────────────────────────┘                             │
│                                                                          │
│  Future: createOpenAIEngine, createHuggingFaceEngine,                    │
│          createRoutingEngine (wraps multiple engines)                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Agent Filesystem Layout

Where everything lives on disk for a deployed agent.

```
zip/                                    ← agent root (Plan 3 defines convention)
│
├── agent.yaml                          ← agent config (Plan 3 — not built yet)
│
├── identity.md                         ← fileMemory source (label: "self")
│                                         loaded at boot, system placement
│
├── notes.md                            ← fileMemory source (label: "notes")
│                                         mutable, preamble placement
│
├── skills/                             ← skill folders (read-only fs mount)
│   ├── memory/
│   │   ├── SKILL.md                    ← teaches when/how to use memory tools
│   │   └── references/
│   │       └── provider-types.md       ← deep reference (loaded on demand)
│   │
│   ├── filesystem/
│   │   ├── SKILL.md                    ← teaches when/how to use fs tools
│   │   └── references/
│   │       └── mount-permissions.md
│   │
│   └── escalation/
│       └── SKILL.md                    ← teaches when to ping the operator
│
├── workspace/                          ← agent's mutable workspace (rw fs mount)
│   ├── notes/                            the agent creates and manages files here
│   │   └── 2026-04-10.md
│   └── drafts/
│       └── weekly-report.md
│
└── data/                               ← runtime data (traces, eval results)
    └── traces/                           future: Plan 7 eval harness writes here
```

**How the agent's defineAgent maps to this layout:**

```typescript
defineAgent({
  name: "zip",
  purpose: "LORF front-door agent",
  model: "claude-sonnet-4-5",
  augments: [
    // Identity (system prompt)
    fileMemory({
      label: "self",
      source: "./identity.md",          // ← reads from agent root
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    }),

    // Mutable self-notes
    fileMemory({
      label: "notes",
      source: "./notes.md",
      mutable: true,
      origin: "system",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    }),

    // Episodic memory
    supabaseMemory({
      namespace: "episode",
      client: supabase,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    }),

    // Filesystem access (skill folders + workspace)
    filesystem({
      mounts: [
        { name: "skills",    path: "./skills",    writable: false },
        { name: "workspace", path: "./workspace",  writable: true, deletable: true },
      ],
    }),

    // Web transport (AG-UI SSE)
    webTransport({
      port: 8080,
      auth: { type: "bearer", token: process.env.AUTH_TOKEN! },
      cors: { origins: ["https://looselyorganized.com"] },
      rateLimitPerPeer: { maxPerMinute: 30 },
    }),
  ],
}, anthropicEngine);
```

---

## 4. Data Flow — A Single Turn

What happens when a visitor sends a message, including where skills fit.

```
VISITOR                                                           AGENT
───────                                                          ─────

POST /agent/run
  { messages: [{ content: "remember I like coffee" }] }
  headers: authorization, x-peer-id
        │
        ▼
┌─ TRANSPORT ──────────────────────────────────────────────────────────┐
│  1. Bearer auth (timing-safe) ✓                                      │
│  2. identify() → PeerIdentity { id, kind, trustLevel }               │
│  3. Parse body → extract last message                                │
│  4. Build TurnTrigger { type: "message", parts: [...], peer }        │
│  5. Open ReadableStream for SSE response                             │
│  6. queue.enqueue(trigger, handler)                                  │
│     └─ rate limit check ✓                                            │
│     └─ queue depth check ✓                                           │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌─ KERNEL TURN LOOP ───────────────────────────────────────────────────┐
│                                                                      │
│  ► emit RUN_STARTED ──────────────────────────► SSE: data: {...}     │
│                                                                      │
│  ► append "remember I like coffee" to thread history                 │
│                                                                      │
│  ► onTurnStart hooks:                                                │
│    └─ memory-bus resets budget (calls: 0)                            │
│                                                                      │
│  ► context pipeline (sequential):                                    │
│    ├─ fileMemory("self"):                                            │
│    │   read("self") → "You are Zip, the LORF front-door agent..."   │
│    │   → ContextBlock { placement: "system", priority: "required" }  │
│    │                                                                 │
│    ├─ fileMemory("notes"):                                           │
│    │   read("notes") → "Previous notes: ..."                        │
│    │   → ContextBlock { placement: "preamble", priority: "normal" }  │
│    │                                                                 │
│    └─ supabaseMemory("episode"):                                     │
│        search("remember I like coffee") → [matching episodes]        │
│        → ContextBlock[] { placement: "preamble", origin: "peer-derived" }
│                                                                      │
│  ► build preamble (trust: authenticated, peer: visitor)              │
│                                                                      │
│  ► select tools: memory_read, memory_write, memory_search,          │
│    memory_list, fs_read, fs_write, fs_list, fs_mkdir, fs_remove,    │
│    fs_search (10 tools, all under 25 threshold)                      │
│                                                                      │
│  ► assemble prompt (allocator):                                      │
│    systemBlocks: [preamble + identity]                               │
│    contextBlocks: [notes + episodic results]                         │
│    messages: [thread history]                                        │
│    tools: [10 tool definitions]                                      │
│                                                                      │
│  ► INFERENCE CALL #1 ──────────────────────► Anthropic API           │
│    model returns:                                                    │
│      content: "I'll remember that for you."                          │
│      toolCalls: [{ name: "memory_write",                             │
│                    arguments: { label: "notes",                      │
│                                 content: "Visitor likes coffee" } }] │
│      finishReason: "tool_use"                                        │
│                                                                      │
│    ► validate: capability table ✓, Zod schema ✓                      │
│    ► execute: memory_write("notes", "Visitor likes coffee")          │
│      └─ fileMemory writes to ./notes.md on disk                      │
│    ► emit TOOL_CALL_START ────────────────────► SSE: data: {...}     │
│    ► emit TOOL_CALL_ARGS ─────────────────────► SSE: data: {...}     │
│    ► emit TOOL_CALL_RESULT ───────────────────► SSE: data: {...}     │
│    ► append tool_use + tool_result to history                        │
│                                                                      │
│  ► INFERENCE CALL #2 ──────────────────────► Anthropic API           │
│    model returns:                                                    │
│      content: "Got it — I'll remember you like coffee."              │
│      finishReason: "end_turn"                                        │
│                                                                      │
│    ► emit TEXT_MESSAGE_START ─────────────────► SSE: data: {...}     │
│    ► emit TEXT_MESSAGE_CONTENT ───────────────► SSE: data: {...}     │
│    ► emit TEXT_MESSAGE_END ───────────────────► SSE: data: {...}     │
│    ► emit RUN_FINISHED ──────────────────────► SSE: data: {...}     │
│                                                                      │
│  ► validate output (flag-only) ✓                                     │
│  ► compact history (if over 80% budget)                              │
│  ► fire onTurnEnd hooks (non-blocking, logged on error)              │
│                                                                      │
│  RESULT: { status: "completed",                                      │
│            response: { parts: [{ kind: "text", text: "Got it..." }]},│
│            toolCalls: [{ name: "memory_write", ... }],               │
│            trace: { ... } }                                          │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─ TRANSPORT ──────────────────────────────────────────────────────────┐
│  Stream closed. Visitor received 8 SSE events in real time.          │
│                                                                      │
│  ON DISK: ./notes.md now contains "Visitor likes coffee"             │
│  NEXT TURN: fileMemory("notes") context will include the new note   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. The Portable Agent — Multi-Org View

How the same agent plugs into different organizations.

```
┌─────────────────────────────────────────────────────┐
│  AGENT (portable — carries its own kernel)           │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Kernel (fixed, travels with agent)        │      │
│  │  turn loop, allocator, capability table,   │      │
│  │  history, tool selector, lifecycle, trace   │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Identity (agent's own — portable)         │      │
│  │  fileMemory("self") + personality + rules   │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  Engine (agent's own — portable)           │      │
│  │  createAnthropicEngine(...)                │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  ORG AUGMENTS (swappable per environment)  │      │
│  │                                            │      │
│  │  ┌── Currently mounted: LORF ───────────┐  │      │
│  │  │  spine-connector(lorf)               │  │      │
│  │  │  brain-connector(lorf)               │  │      │
│  │  │  registry-connector(lorf)            │  │      │
│  │  │  memory: lorf:episode:*              │  │      │
│  │  └──────────────────────────────────────┘  │      │
│  │                                            │      │
│  │  To switch orgs: unmount LORF augments,    │      │
│  │  mount Org-B augments. Kernel unchanged.   │      │
│  │                                            │      │
│  │  ┌── Alternative: Org B ────────────────┐  │      │
│  │  │  spine-connector(org-b)              │  │      │
│  │  │  brain-connector(org-b)              │  │      │
│  │  │  registry-connector(org-b)           │  │      │
│  │  │  memory: org-b:episode:*             │  │      │
│  │  └──────────────────────────────────────┘  │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 6. The Codebase Map

Where each component lives in `src/`.

```
augment-1/
├── src/
│   ├── types.ts ·················· ALL shared types (one file, intentional)
│   ├── parts.ts ·················· Part[] helpers (extractText, textPart, dataPart)
│   ├── helpers.ts ················ defineAugment, defineTool
│   ├── tokenizer.ts ·············· char/4 estimator (future: Rust native)
│   ├── agent.ts ·················· defineAgent → AgentHandle
│   ├── agent-card.ts ············· generateAgentCard (A2A discovery)
│   ├── index.ts ·················· public API surface
│   │
│   ├── kernel/ ··················· THE RUNTIME (finished, ~1000 LOC)
│   │   ├── turn-loop.ts ·········· main loop (~600 LOC, largest file)
│   │   ├── context-allocator.ts ·· priority eviction within token budget
│   │   ├── capability-table.ts ··· tool exposure + per-augment call limits
│   │   ├── history-manager.ts ···· per-thread messages, atomic pairs, LRU
│   │   ├── lifecycle-manager.ts ·· boot/shutdown/idle/health
│   │   ├── tool-selector.ts ······ mount all <25, filter via canExpose
│   │   ├── trace-emitter.ts ······ structured per-turn observability
│   │   ├── transport-queue.ts ···· concurrency, depth, rate limit + eviction
│   │   ├── timeout.ts ············ withTimeout (timer cleanup)
│   │   ├── output-validator.ts ··· flag suspicious output (don't block)
│   │   └── preamble.ts ··········· trust-aware system prompt prefix
│   │
│   ├── memory/ ··················· MEMORY SUBSYSTEM
│   │   ├── types.ts ·············· MemoryRegistry interface
│   │   ├── registry.ts ··········· buildRegistry (3-pass conflict detect)
│   │   ├── memory-bus.ts ·········· wireMemoryBus (creates synthetic augment)
│   │   ├── context-synthesis.ts ·· synthesizeContextFor (auto context())
│   │   └── tools.ts ·············· 4 generic memory tools + budget
│   │
│   ├── augments/ ················· BUILT-IN AUGMENTS (6)
│   │   ├── file-memory.ts ········ static provider (file-backed)
│   │   ├── supabase-memory.ts ···· namespace provider (Supabase-backed)
│   │   ├── filesystem.ts ········· multi-mount scoped file access
│   │   ├── web-fetch.ts ·········· URL fetch (HTML→text, JSON passthrough)
│   │   ├── org-context.ts ········ org manifest + fetch + escalate
│   │   └── bash.ts ··············· scoped shell execution
│   │
│   ├── augments/filesystem-skill/  FIRST SKILL FOLDER (ships with fs augment)
│   │   ├── SKILL.md ·············· teaches fs tool usage
│   │   └── references/
│   │       └── mount-permissions.md
│   │
│   ├── transports/ ··············· TRANSPORT IMPLEMENTATIONS
│   │   ├── ag-ui-events.ts ······· AG-UI types + kernel→AG-UI translator
│   │   └── web-transport.ts ······ Bun.serve + ReadableStream SSE
│   │
│   ├── engines/ ·················· MODEL CLIENT ADAPTERS (3)
│   │   ├── anthropic.ts ·········· Anthropic Messages API adapter
│   │   ├── openai.ts ············· OpenAI Chat Completions adapter
│   │   ├── openrouter.ts ········· OpenRouter multi-provider adapter
│   │   └── _shared/schema-normalize.ts
│   │
│   ├── cli/ ······················ aug1 CLI (Plan 3)
│   │   ├── index.ts ·············· Commander.js entrypoint
│   │   ├── config-parser.ts ······ YAML → ParsedConfig
│   │   ├── augment-catalog.ts ···· built-in registry for create/add
│   │   ├── augment-resolver.ts ··· AugmentConfig[] → Augment[]
│   │   ├── engine-resolver.ts ···· EngineConfig → ModelClient
│   │   ├── pid-registry.ts ······· ~/.auggy/<name>.json manifests
│   │   ├── plist-generator.ts ···· launchd plist generation
│   │   ├── scaffold.ts ··········· aug1 create templates
│   │   ├── skill-manifest.ts ····· scan skills/*/SKILL.md
│   │   └── commands/ ············· create, add, dev, start, stop, restart, status
│   │
│   └── http.ts ··················· shared HTTP client (redirect security)
│
├── tests/ ························ 537 TESTS across 42 files
│   ├── fixtures/ ················· mock-model, mock-augment, mock-supabase, temp-dir
│   ├── kernel/ ··················· per-component unit tests
│   ├── memory/ ··················· registry, synthesis, tools, bus tests
│   ├── augments/ ················· file-memory, supabase-memory, filesystem, web-fetch, bash
│   ├── transports/ ··············· ag-ui-events, web-transport (incl streaming)
│   ├── engines/ ·················· anthropic, openai, openrouter
│   ├── cli/ ······················ config, resolvers, PID, plist, scaffold, manifest
│   ├── integration/ ·············· full agent end-to-end
│   └── evals/ ···················· security eval harness (grader pipeline)
│
├── scripts/
│   ├── hello.ts ·················· hello world composition
│   └── hello-identity.md ········· throwaway identity file
│
├── docs/ ························· REFERENCE + RESEARCH docs
│   ├── 01-09 ····················· numbered reference series
│   ├── 10-system-diagrams.md ····· THIS FILE
│   └── research/ ················· dated research artifacts
│
├── CLAUDE.md ····················· project rules + code map
├── lo.yml ························ project identity (proj_718dcc89...)
├── package.json
└── tsconfig.json
```

---

## How to use these diagrams

- **Explaining Auggy to someone new?** Start with diagram 1 (three primitives), then 3 (filesystem layout), then 2 (full architecture).
- **Debugging a turn?** Follow diagram 4 step by step — it shows every phase with the exact event emissions.
- **Understanding org portability?** Diagram 5 shows what's portable vs what's swappable.
- **Finding code?** Diagram 6 maps every concept to its file path.

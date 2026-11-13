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
│  │   memory_write({ topic,      fs_write({ path, content })    │    │
│  │     content })               fs_list({ path })              │    │
│  │   memory_search({ query })   fs_search({ path, pattern })   │    │
│  │   memory_list()              fs_mkdir({ path })             │    │
│  │   memory_forget({ peerId })  fs_remove({ path })            │    │
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
│  │  Agent-wide Keyed Scheduler                      │                    │
│  │  ├── global active cap (default 4)               │                    │
│  │  ├── global/thread/source waiting caps           │                    │
│  │  ├── round-robin runnable thread selection       │                    │
│  │  ├── queued cancellation + quarantine + drain    │                    │
│  │  ├── source peer rate limits                     │                    │
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
│  │    memory_forget     │  │    fs_remove          │                      │
│  │                      │  │    fs_search          │                      │
│  │  • onTurnStart       │  │                       │                      │
│  │    (budget reset)    │  │                       │                      │
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

The unreleased authoring scaffold creates this project. Managed implementations
remain installed dependencies; source under the project `src/` is yours to edit.

```text
support-agent/
├── agent.yaml                   # application entrypoint + inline enabled graph
├── package.json                 # pinned local runtime/providers; start/test scripts
├── bun.lock                     # produced by dependency installation
├── tsconfig.json
├── README.md
├── .gitignore
├── .env                         # private credentials
├── .env.example                 # placeholders only
├── identity.md
├── skills/                      # model-visible instruction snapshots
├── src/
│   ├── index.ts                  # main: compose, configure HTTP, start
│   ├── agent.ts                  # configured augments + local turn recipe
│   ├── http.ts                   # POST /agent/run → guarded web.agentRun
│   ├── turn.ts                   # visible inference/tool decision loop
│   └── augments/README.md        # add project-owned business modules here
├── tests/application.test.ts     # deterministic recipe tests
├── data/                        # ignored runtime state
├── .auggy/operations/            # private migration/recovery receipts, when used
└── node_modules/auggy/src/       # installed runtime and built-in implementations
```

`src/agent.ts` binds the recipe to the augments declared in `agent.yaml`; it does
not maintain a second enabled list. `auggy inspect` reports the selected installed
runtime and declared source locations. Open `src/index.ts`, follow composition and
HTTP dispatch, then open `src/turn.ts` and the indicated built-in implementation.
Custom source hints are static navigation, not proof of an arbitrary call graph.

`auggy augment create orders` adds
`src/augments/orders/{index.ts,schemas.ts,service.ts,README.md}` and
`tests/augments/orders.test.ts`. Both its creator-only tool and HTTP route call the
same validated lookup service. Add `--with-skill` to create root
`skills/orders/SKILL.md`. Package upgrades leave these owned files unchanged.

Existing projects can convert only their configuration or explicitly adopt the
application source. See [migration and storage](./16-storage-layout.md).

---

## 4. Data Flow — A Single Turn

What happens when a visitor sends a message, including where skills fit.

```
VISITOR                                                           AGENT
───────                                                          ─────

POST /agent/run
  { messages: [{ content: "remember I like coffee" }] }
  headers: authorization or verified visitor/agent credentials
        │
        ▼
┌─ TRANSPORT ──────────────────────────────────────────────────────────┐
│  1. Bearer auth (timing-safe) ✓                                      │
│  2. verify credentials → PeerIdentity { id, kind, trustLevel }       │
│  3. Parse body → extract last message                                │
│  4. Build TurnTrigger { type: "message", parts: [...], peer }        │
│  5. Open ReadableStream for SSE response                             │
│  6. sharedScheduler.submit(threadId, sourcePolicy)                   │
│     └─ global/source/thread bounds + peer rate limit ✓               │
│     └─ round-robin runnable-thread selection ✓                       │
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
│  ► build preamble (trust: public/recognized, peer: visitor)          │
│                                                                      │
│  ► select tools: memory_read, memory_write, memory_search,          │
│    memory_list, fs_read, fs_write, fs_list, fs_mkdir, fs_remove,    │
│    fs_search (10 tools, all under 25 threshold)                      │
│                                                                      │
│  ► assemble prompt (allocator):                                      │
│    systemBlocks: [preamble + identity]                               │
│    contextBlocks: [notes + episodic results]                         │
│    messages: [thread history]                                        │
│    tools: [11 tool definitions]                                      │
│                                                                      │
│  ► INFERENCE CALL #1 ──────────────────────► Anthropic API           │
│    model returns:                                                    │
│      content: "I'll remember that for you."                          │
│      toolCalls: [{ name: "memory_write",                             │
│                    arguments: { topic: "preferences",                │
│                                 content: "Visitor likes coffee." } }]│
│      finishReason: "tool_use"                                        │
│                                                                      │
│    ► validate: capability table ✓, Zod schema ✓                      │
│    ► execute: memory_write({ topic, content })                       │
│      └─ layeredMemory writes to the current peer namespace           │
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
│  ► compact + durably commit history                                  │
│  ► dispatch outbound in keyed order                                  │
│  ► await onTurnEnd + scheduleAfterTurn (errors logged)               │
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

This is the **Auggy repository** map. The root npm package ships `src/` (including
runtime and built-in implementation source) and the built console at `admin/dist/`.
The repository's `packages/`, `tests/`, `docs/`, and console development source
are not included in that package. Provider packages install separately.

An agent can open the shipped implementation at `node_modules/auggy/src/`.
`auggy inspect` resolves the actual selected package instead of assuming a global
installation supplies execution.

```text
auggy/
├── src/
│   ├── index.ts                 # public API
│   ├── types.ts                 # public runtime contracts
│   ├── agent.ts                 # programmatic agent composition
│   ├── application/             # managed application host/runner
│   ├── kernel/
│   │   ├── turn-loop.ts         # session ownership and execution facade
│   │   ├── turn-session.ts      # guarded phases and settlement
│   │   ├── turn-program.ts      # default legacy turn recipe
│   │   └── keyed-turn-scheduler.ts
│   ├── augments/<name>/         # maintained factories and implementation helpers
│   ├── transports/             # HTTP/AG-UI adapter and route policies
│   ├── memory/                 # registry, context synthesis, generic tools
│   ├── jobs/                   # durable single-turn work
│   ├── coordination/           # internal, disabled replica foundation
│   ├── cli/
│   │   ├── index.ts            # operator command dispatch
│   │   ├── commands/           # create/run/inspect/migrate/etc.
│   │   └── authoring/          # raw graph, publication, migration, inspection
│   ├── scaffold-templates/     # application source copied at explicit creation
│   └── scaffold-starter-skills/# canonical builder teaching
├── packages/                   # provider adapters, evals, portable builder skill
├── admin/                      # console source and distributable assets
├── tests/                      # runtime/CLI contracts and integration evidence
└── docs/                       # architecture and operator guides
```

The maintained runtime keeps authentication, tool authorization, cancellation,
budget enforcement and settlement inside guarded operations. Application-owned
recipes choose the supported sequence; they are trusted TypeScript, not a sandbox.

---

## How to use these diagrams

- **Explaining Auggy to someone new?** Start with diagram 1 (three primitives), then 3 (filesystem layout), then 2 (full architecture).
- **Debugging a turn?** Follow diagram 4 step by step — it shows every phase with the exact event emissions.
- **Understanding org portability?** Diagram 5 shows what's portable vs what's swappable.
- **Finding code?** Diagram 6 maps every concept to its file path.

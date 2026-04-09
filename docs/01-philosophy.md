# 01 — Philosophy

> Why Auggy exists, the design principles it follows, and what we explicitly choose *not* to build.

## What problem this solves

Most agent frameworks bake one assumption deep into the runtime: that the framework's authors know what an agent needs. They ship a fixed set of features (memory, RAG, tool registries, planners, multi-step reasoning) and the application developer composes them. When the assumptions are right for your use case, this is fast. When they're wrong — when you need a different memory model, a different transport, a different way to compose context — you're fighting the framework.

Auggy starts from a different assumption: **the runtime doesn't know what you need.** It defines a small kernel that knows how to run a single turn of an agent — receive input, gather context, call a model, execute tools, return output — and a single primitive (the **augment**) that any feature plugs into. Memory is an augment. Transports are augments. Tools are augments. Identity is an augment. Logging, rate limiting, escalation, retrieval — all augments.

The kernel knows nothing about your domain. The augments know everything. This makes the framework agnostic to what you're building, but disciplined about *how* you build it.

## Core primitives

There are exactly four things that matter in Auggy:

1. **The augment.** A composable unit that can contribute context, expose tools, register a transport, or carry memory. Augments are the entire extensibility surface — there are no plugins, no middleware, no hooks layered on top. If you want the runtime to do something it doesn't already do, you write an augment.

2. **The kernel.** A small set of components (turn loop, context allocator, capability table, history manager, tool selector, lifecycle manager) that know how to assemble a prompt, run a model call, execute tools, and return a result. The kernel is `~1000 LOC`. It is intentionally not extensible — if you need something different, you add an augment, not a kernel feature.

3. **The model.** An interface (`ModelClient`) that the runtime uses to do inference. The runtime doesn't care which model — Anthropic, OpenAI, a local llama.cpp, a mock — as long as the interface is satisfied.

4. **The peer.** Whoever is talking to the agent. Could be a human via a web chat, another agent over A2A, a system trigger, an MCP client. Auggy uses the term "peer" deliberately: the runtime treats all callers structurally the same and uses `PeerIdentity` (with `kind` and `trustLevel`) to make policy decisions.

That's it. Everything else in the codebase is one of these four things, or supports them.

## Design principles

These principles aren't aspirational — they're the rules I follow when reading the code, and they're load-bearing for understanding why the architecture is shaped the way it is.

### 1. Augments compose; kernel does not extend

The kernel is finished. It will get bug fixes and probably gain a few hooks, but the *vocabulary* of what the kernel does is fixed: assemble context, select tools, call model, run tools, validate output, return result. New behavior comes from new augments, not from new kernel features. This is enforced by keeping the kernel surface small and the augment surface broad.

This is the inverse of how most frameworks evolve. Most frameworks accumulate features in the core because adding a kernel feature is the path of least resistance for the framework author. Auggy treats kernel additions as the path of *most* resistance — every kernel change has to be paid for in tests, documentation, and conceptual surface area. Augment additions are nearly free.

### 2. Framework-agnostic at the boundary, opinionated inside

At the *boundary* — what types you pass in, what protocol you speak — Auggy adopts standards instead of inventing them. Content uses A2A's `Part[]` shape. Discovery uses A2A's Agent Card shape. The chat transport speaks AG-UI's SSE event protocol. Task lifecycle uses A2A's `TaskState` enum.

Inside the kernel, opinionated decisions get made: turn-oriented (not task-oriented), sequential context pipeline (not parallel), pre-built capability table (not runtime checks), explicit token budget (not "fits in the window"). These choices are deliberate trade-offs explained in the relevant docs.

The principle: **adopt standard type shapes early; defer standard wire formats until you need interop.** Types are cheap to change before users exist. Wire formats are expensive once they're in production.

### 3. The kernel is turn-oriented, transports are task-oriented

A turn is one round-trip with the model, possibly involving tool calls. A task is a logical unit of work that may span many turns. The kernel runs turns; the transport translates between its protocol's task model (A2A tasks, AG-UI runs) and the kernel's turn model.

This split matters because most protocols (A2A especially) have task lifecycle states (`working`, `input-required`, `auth-required`) that don't map cleanly onto a single turn. Putting task management in the transport keeps the kernel small and lets each transport implement task semantics natively for its protocol.

### 4. Trust is structural, not aspirational

Every peer has a `trustLevel` (`operator`, `facility`, `authenticated`, `untrusted`). Every context block has an `origin` (`operator`, `system`, `peer-derived`). Peer-derived blocks get a `[PEER-DERIVED]` marker in the prompt. The system preamble explicitly tells the model that peer-derived content may contain adversarial instructions.

This isn't a security feature added later — it's baked into the type system from the kernel's first commit. You cannot accidentally leak peer input into a system prompt; the types will not let you misclassify it.

### 5. Composition over inheritance, files over classes

Most files in `src/` export `create*` factory functions, not classes. State is closed over by the factory and accessed via methods on the returned object. This is closer to ML/Lisp style than to the Java/C# OO patterns you'll see in most TS codebases.

Why: closure-based state has fewer footguns than `this`, makes the lifecycle of mutable state explicit, and produces objects that are trivially type-inferred without needing interfaces. The kernel never needs polymorphism; it needs explicit, composable state.

### 6. Errors are events, not exceptions

The kernel emits events for everything — `run_started`, `tool_call_*`, `text_message`, `run_finished`, `run_error`. Transports translate these into their wire protocol (AG-UI events, A2A task updates, etc.). Errors are part of the event stream, not a parallel exception channel.

This is why the kernel takes an `onEvent` callback rather than throwing — it gives transports a single, ordered, complete picture of what happened during a turn, including failures.

### 7. Test the boundary, mock the rest

The unit tests cover individual modules with mocked collaborators. The integration tests stand up a real agent with real built-in augments and a mocked model client and exercise the whole HTTP surface. The mock model is a fixture (`tests/fixtures/mock-model.ts`), not a feature flag — production code never branches on whether the model is mocked.

This keeps the mock surface tiny (one file, one interface) and makes integration tests honest: the only thing that's fake is the LLM call itself.

## What we explicitly do NOT build

These are deliberate omissions, not oversights. Several are documented as "deferred to future plans" and several are documented as "not in scope for Auggy."

### Not in scope ever

- **A planner.** Auggy doesn't have a "planner" component. The model plans by deciding which tools to call. Planning is what models are for.
- **A retrieval engine.** RAG is what `supabaseMemory` (or any similar augment) does. The kernel doesn't have a retrieval pipeline; memory providers do.
- **An orchestration layer.** No "agent graphs," no "DAGs," no "state machines." If you need multi-agent orchestration, that's the spine (Plan 4) or the chat UI (Plan 5), not the kernel.
- **A prompt template engine.** Context is assembled from typed `ContextBlock`s, not by string interpolation. Augments contribute blocks, the allocator concatenates them with provenance markers.
- **A "memory hierarchy" or eviction algorithm beyond priority sorting.** The allocator drops blocks when they don't fit, in priority order. There is no LRU, no recency boost, no relevance scoring inside the kernel. If you want smart eviction, write a smarter memory provider.
- **Auto-discovery of tools or augments.** Augments are explicitly listed in `defineAgent({ augments: [...] })`. There is no service locator, no DI container, no registry the kernel scans.

### Deferred to a later plan

- **Token-level streaming from the model.** The current `webTransport` streams *event-level* (RUN_STARTED, TEXT_MESSAGE_CONTENT delta as one chunk, etc.) but the model call is still buffered. True token streaming is a Plan 7+ enhancement.
- **Full A2A wire protocol.** Plan 2 ships A2A-shaped *types*; Plan 4+ ships A2A-shaped *messages on the wire*. The internal data already matches.
- **MCP server augment.** Plan 6.
- **Multi-vendor model routing.** A future augment.
- **Augment sandboxing (V8 isolates).** Only needed when third-party augments arrive.
- **Hot reload of augments.** Restart instead.
- **Persistent task state across process restarts.** v1 turns are in-memory. Persistence is a transport concern (the spine).

### Deferred to the operator

- **Choosing models.** Auggy doesn't have a "model registry" — you pass a `ModelClient` to `defineAgent`. If you want to swap models per-turn or per-tool, write a routing model client that wraps multiple underlying clients.
- **Deciding which augments to mount.** No auto-include of "common" augments. Every augment is explicit.
- **Auth and credentials.** Transports decide how to authenticate inbound requests. The kernel never sees credentials.

## Why TypeScript + Bun

- **TypeScript** because the contract between augments and kernel is structural and complex; static types catch most integration bugs at compile time. Tests only exist for the things types can't express (runtime behavior, protocol shape, lifecycle ordering).
- **Bun** because (a) it has a built-in HTTP server, test runner, and TypeScript loader with no toolchain assembly, (b) it's faster than Node for both startup and execution, and (c) the entire toolchain ships as one binary, which matters for deployment to constrained environments like a Mac Mini running 24/7.

The `bun:test` runner is used for the test suite. Vitest was originally chosen and removed in Plan 2 — see [09-testing.md](./09-testing.md) for the migration history and reasoning.

## What "augment" means etymologically

The name is from the Latin *augmentum* — "an increase, an addition." Each augment increases what the agent can do. The runtime starts with the absolute minimum (a kernel that can run a turn) and every augment is an addition. There is no "core" set of augments the runtime needs to function — `defineAgent({ name: "x", model: "...", augments: [] })` is a valid agent that can run a turn. It just won't do anything useful, because no augment has contributed any context, tools, or transport.

This is the central insight: **the runtime is the absence of features, and augments are the features.** When you read the code, every line in `src/kernel/` should be justified by being something every agent needs no matter what augments it has. If a kernel feature would only matter for *some* agents, it belongs in an augment, not the kernel.

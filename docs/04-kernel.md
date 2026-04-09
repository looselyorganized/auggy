# 04 — Kernel

> The runtime. Everything in `src/kernel/` plus `src/agent.ts`. The turn loop is the central piece; everything else is supporting infrastructure that the loop calls.

## What "kernel" means here

The kernel is the part of Auggy that knows how to **run a single turn**. It does not know what a chat is. It does not know what a session is. It does not know what an LLM is — it only knows that it has a `ModelClient` it can call. It does not know what your domain is.

The kernel is **finished**. It is intentionally not extensible. Bug fixes happen here; behavior changes happen in augments. If you find yourself wanting to add a feature to the kernel, the question to ask first is "could this be an augment instead?" Almost always the answer is yes.

The kernel is **~1000 lines of code total** across 11 files. The turn loop alone is about 600 lines. Every other file in `src/kernel/` is a small, focused component the loop uses.

## File-by-file

### `src/kernel/turn-loop.ts` — The main loop

The loop is one factory function (`createTurnLoop`) that returns an object with two methods: `executeTurn` and `getHistoryManager`. Everything else is internal state closed over by the factory.

`executeTurn` is what every turn goes through. It is intentionally a single long function with a strict ordering of phases. Splitting it into smaller functions would obscure the ordering and make the kernel harder to read, not easier. The phases are:

#### Phase 0 — Setup

```ts
const turnState: TurnState = { turnId, threadId, trigger, peer, ... };
const trace = traceEmitter.startTurn({...});
```

Every turn starts with a `TurnState` (the read-only view augments see) and a `TurnTrace` (the audit log being built up).

#### Phase 1 — Abort check + history append

```ts
if (signal?.aborted) return makeAbortResult();
const history = getOrCreateHistory(threadId);

if (trigger.type === "message" && "parts" in trigger.payload) {
  const text = extractText((trigger.payload as InboundMessage).parts);
  history.append({ role: "user", content: text, ... });
}
```

If the abort signal already fired, we don't even start. Otherwise we get the per-thread history manager and append the inbound message (extracted from `Part[]`) as a user message.

#### Phase 2 — `onTurnStart` hooks

```ts
for (const aug of augments) {
  if (aug.onTurnStart) {
    try { await aug.onTurnStart(turnState); }
    catch (err) {
      if (aug.required) {
        emitEvent({ kind: "run_error", ... });
        emitEvent({ kind: "run_finished", status: "failed" });
        return failedResult;
      }
    }
  }
}
```

Sequential, in declared order. Required augments that throw abort the turn. Non-required failures are swallowed.

The synthetic `memory-bus` augment uses this hook to reset its per-turn tool budget — see [05-memory-subsystem.md](./05-memory-subsystem.md).

#### Phase 3 — Emit `run_started`

```ts
emitEvent({ kind: "run_started", turnId, threadId, contextId, taskId });
```

This is the first event a transport will see for the turn. The web transport translates it directly to AG-UI's `RUN_STARTED`.

#### Phase 4 — Augment context pipeline

```ts
const contextBlocks: ContextBlock[] = [];
for (const aug of augments) {
  if (!aug.context) continue;
  try {
    const timeout = aug.constraints?.contextTimeoutMs ?? 5000;
    const priorContext = aug.receivesPriorContext ? [...contextBlocks] : undefined;
    const result = await withTimeout(() => aug.context!(turnState, priorContext), timeout);
    if (typeof result === "string") {
      contextBlocks.push({ source: aug.name, content: result, placement: "preamble", priority: "normal", ... });
    } else {
      contextBlocks.push(...result);
    }
  } catch (err) {
    if (aug.required) { /* abort turn */ }
    // non-required: skip and continue
  }
}
```

Sequential, in declared order. Each augment's `context()` runs with a 5-second timeout (overridable per augment via `contraints.contextTimeoutMs`). Augments that opt in via `receivesPriorContext: true` see the blocks contributed so far; otherwise they see nothing about other augments.

The shorthand `return "some string"` form is supported — strings are wrapped as `placement: "preamble"`, `priority: "normal"`, `provenance: "augment"` blocks.

Required failures abort the turn with `status: "failed"`. Non-required failures are swallowed and the augment contributes no context for this turn.

**Why sequential and not parallel:** because augments can depend on each other via `priorContext`. If they ran in parallel, the dependency would be undefined. The sequential pipeline is also easier to reason about for trust propagation — a peer-derived block contributed by augment A can be filtered/sanitized by augment B before reaching the model.

#### Phase 5 — Build preamble

```ts
const preamble = buildPreamble({ sourceAugment: trigger.source, peer });
```

`preamble.ts` constructs the system preamble — a fixed string with the trust-level info filled in for the current peer. The preamble is the first thing in `systemBlocks`.

#### Phase 6 — Allocator

```ts
const allocator = createContextAllocator({
  maxTokens: model.maxContextTokens,
  historyPercent: budgetConfig.historyPercent ?? 40,
  toolSchemaPercent: budgetConfig.toolSchemaPercent ?? 10,
  tokenizer,
  preamble,
});

const historyMessages = history.getHistory(historyBudget);
const toolSelection = selectTools(allTools, turnState, { canExpose: capabilityTable.canExpose });
let currentPrompt = allocator.assemble(contextBlocks, historyMessages, toolSelection.definitions);
```

The allocator is constructed *per-turn* (cheap — closure over config). It's given:
1. The augment context blocks (already gathered).
2. The history messages within their budget slice.
3. The tool definitions (after capability filtering).

It produces an `AssembledPrompt` with `systemBlocks`, `contextBlocks`, `assistantPreamble`, `messages`, `tools`, and an audit trail of evictions.

#### Phase 7 — Inference loop

```ts
capabilityTable.resetTurn();
const consecutiveFailures = new Map<string, number>();
let inferenceCount = 0;
const maxInferenceLoops = 10;

while (inferenceCount < maxInferenceLoops) {
  if (signal?.aborted) return makeAbortResult();
  inferenceCount++;
  const response = await model.complete(currentPrompt);
  // record inference in trace
  // append model content to history (always, even if tool calls follow)
  
  if (no tool calls || end_turn || max_tokens) {
    // emit text_message + run_finished, return success
  }
  
  // Phase 7a: Validate all tool calls (synchronous)
  // Phase 7b: Execute validated tools in parallel
  // Phase 7c: Append tool_use + tool_result pairs to history
  // Phase 7d: Check for terminate condition (consecutive validation failures)
  // Phase 7e: Rebuild prompt from updated history, loop
}
```

The inference loop is capped at **10 iterations**. The cap exists so a stuck model that keeps calling tools without ever producing a final answer doesn't run forever. When the cap is hit, the loop emits a generic "I've completed the available actions" message and returns success.

##### Tool call processing — three phases

Each iteration that produces tool calls runs three sub-phases:

**Phase 7a — Synchronous validation.** For each tool call:
1. Check the capability table (`canExecute`). If denied, push an error entry. If needs approval, push a "needs approval" error and skip. If allowed, proceed.
2. Look up the tool in `toolRegistry`. Unknown tool → error entry.
3. Run the Zod schema (`tool.input.safeParse(call.arguments)`). Failure → error entry, increment consecutive-failure counter for this tool name. If two consecutive failures of the same tool, set `terminateToolLoop = true` and break.
4. Success → push an `execute` entry with the validated input.

**Phase 7b — Parallel execution.** `Promise.all` over all entries:
- `error` entries return their pre-built error string.
- `execute` entries:
  1. Emit `tool_call_started` (with `toolCallId`, `toolName`, `augmentName`).
  2. Emit `tool_call_args` (with the parsed args).
  3. Run `withTimeout(() => tool.execute(input), toolTimeoutMs ?? 30000)`.
  4. Emit `tool_call_result` (with `output` and `isError`).
- All in parallel.

**Phase 7c — Append to history.** In iteration order (so the history reflects the order the model called the tools, not the order they finished):
- Push a `tool_use` message with `content: JSON.stringify(call)` and `toolCallId`.
- Push a `tool_result` message with `content: output` and the same `toolCallId`.
- If not an error, also push a `ToolCallRecord` to `toolCallRecords` and call `capabilityTable.recordToolCall(call.name)`.

The kernel uses `toolCallId` to match `tool_use` to `tool_result` in history — this is what lets the history manager keep them as atomic pairs even when compaction or budget walks fire.

##### Termination conditions

The inference loop exits via one of these paths:
1. **End of turn** — model returns `finishReason === "end_turn"` or no tool calls. Emit `text_message` + `run_finished`, return success.
2. **Context exhausted** — model returns `finishReason === "max_tokens"`. Same as above (we treat it as end-of-turn — the model couldn't finish but we're done).
3. **Two consecutive validation failures of the same tool** — set `terminateToolLoop`, do one more inference call without tools, return whatever the model says.
4. **Abort signal** — `makeAbortResult()` returns a `canceled` result with appropriate events.
5. **Hit `maxInferenceLoops`** — emit a generic message + `run_finished`, return success with `"I've completed the available actions."`

#### Phase 8 — Output validation (v1: flag only)

```ts
if (response.content) {
  const validation = validateOutput(response.content, [...toolNames, ...augmentNames]);
  if (validation.flagged) {
    trace.outputValidation = { flagged: true, reasons: validation.reasons };
  }
}
```

`output-validator.ts` scans the model's final text for things that look like fabricated tool calls (e.g. mentions of tool or augment names that suggest the model thinks it called them when it didn't). v1 records this in the trace; it does not block.

#### Phase 9 — Return

The full `TurnResult` is returned. The transport layer takes it from here.

### `src/kernel/context-allocator.ts` — Context allocator

A small, pure component (~125 LOC). Takes augment blocks + history + tools, produces `AssembledPrompt`. The interesting bit is the budget arithmetic:

```ts
const historyBudget = Math.floor(maxTokens * (historyPercent / 100));
const toolBudget = Math.floor(maxTokens * (toolSchemaPercent / 100));
const toolSchemaTokens = sum of JSON.stringify(tool).length / 4 for each tool;
const effectiveToolTokens = Math.max(toolSchemaTokens, toolBudget);
const contextBudget = max(0, maxTokens - historyBudget - effectiveToolTokens - preambleTokens);
```

This is the key insight: **tool schemas eat into the context budget when they're larger than their declared budget.** If you have 30 tools with verbose descriptions, they take more than the 10% allotted to them, and the context block budget shrinks accordingly. This stops augments from over-contributing context when there isn't room for it.

After computing `contextBudget`, the allocator:
1. Sorts blocks by priority order (`required`, `high`, `normal`, `low`, `evictable`).
2. Walks the sorted list, including blocks until adding the next would exceed the budget. Excluded blocks go into `evictions`.
3. Distributes included blocks into `systemBlocks` / `contextBlocks` / `assistantPreambleStrings` based on `placement`.
4. Wraps each block's content as `[AUGMENT CONTEXT: source]<peer-derived marker>\n<content>`.

`pipeline-only` blocks are always excluded from the model-facing arrays (they exist purely for downstream augments to read via `priorContext`).

### `src/kernel/capability-table.ts` — Capability table

A small but load-bearing component. The capability table is the single place that decides whether a tool can run. It is constructed once per turn loop (not per turn) and tracks per-turn counters.

```ts
const KERNEL_DEFAULT_MAX_TOOL_CALLS = 5;

createCapabilityTable(augments) → {
  canExpose(toolName, turnState): boolean;            // pre-flight: should this tool be in the model's tool list?
  canExecute(toolName, input, turnState): {           // post-call: can this tool actually run?
    allowed: true;
  } | {
    needsApproval: true; reason: string;
  } | {
    denied: true; reason: string;
  };
  recordToolCall(toolName): void;                     // bump counters
  resetTurn(): void;                                  // called by turn loop at the start of each turn
}
```

Construction walks the augment list and builds:
- A `Set<string>` of `neverExpose` tool names (never sent to the model)
- A `Set<string>` of `requiresHumanApproval` tool names
- A `Map<toolName, augmentName>` so `canExecute` can look up the owning augment for per-augment limit enforcement
- A `Map<augmentName, limit>` of per-augment maxToolCallsPerTurn (default 5 if unset)
- A computed `globalLimit` (sum of all augment limits, falling back to the default if no augment has tools)

`canExecute` checks (in order):
1. Global limit not exceeded
2. Per-augment limit for the owning augment not exceeded
3. Tool isn't in `requiresHumanApproval` (if it is, return `needsApproval`)
4. Otherwise: `allowed`

`recordToolCall` bumps the global counter and the per-augment counter. `resetTurn` clears both.

The `KERNEL_DEFAULT_MAX_TOOL_CALLS = 5` was the source of the P2 review finding: the synthetic `memory-bus` augment was getting silently capped at 5 even though its budget said 20. The fix was to set `constraints.maxToolCallsPerTurn` on the synthetic augment (`memory-bus.ts`).

### `src/kernel/history-manager.ts` — History manager

Per-thread message log. One instance per `threadId`. The turn loop creates them lazily via `getOrCreateHistory(threadId)`.

```ts
createHistoryManager({ threadId }) → {
  append(message): void;
  getHistory(tokenBudget): Message[];                                  // walk backwards within budget
  compact(tokenBudget, strategy: "summarize" | "truncate" | "sliding-window"): void;
  save(storage: Storage): Promise<void>;
  restore(storage: Storage): Promise<void>;
  totalTokens(): number;
}
```

**`getHistory(budget)`** walks backwards from the newest message, accumulating tokens until the next message would exceed the budget. The complication: `tool_use` and `tool_result` messages **must** stay paired. The walker handles this by:
- When it sees a `tool_result`, it includes the previous `tool_use` together (as an atomic pair) and accounts for both tokens at once.
- When it sees an unpaired `tool_use` (its `tool_result` was already excluded), it skips the `tool_use` too — it would be invalid history without its result.

The result is `messages.slice(startIndex)` — the kept slice in original order.

**`compact(budget, strategy)`** is called by the agent's `dispatchOutbound` after every turn. The threshold is `0.8 * budget` — compaction only kicks in when history is over 80% of the budget. Three strategies:
- `"truncate"` (and `"summarize"`, treated identically in v1) — drop oldest messages until under threshold, respecting atomic tool pairs.
- `"sliding-window"` — keep newest messages that fit within threshold, dropping the rest.

Both strategies preserve `tool_use`/`tool_result` atomicity. Orphaned `tool_result` messages (rare — would only happen if `tool_use` was already dropped) are dropped on sight.

**`save`/`restore`** use a `Storage` interface to persist history under `history:${threadId}`. Not used by anything in v1 — the runtime is in-memory.

### `src/kernel/lifecycle-manager.ts` — Lifecycle manager

Per-agent component that handles boot, shutdown, and the idle timer.

```ts
createLifecycleManager({ name, augments, model? }) → {
  boot(): Promise<void>;       // call onBoot on each augment in order; record failure
  shutdown(): Promise<void>;   // call onShutdown on each augment in REVERSE order with 5s timeout
  startIdleTimer(onIdle, intervalMs?): void;
  stopIdleTimer(): void;
  resetIdleTimer(): void;
  health(): AgentHealth;
}
```

**`boot()`** is fail-fast: if any augment's `onBoot` throws, the whole agent fails to start. The error message is wrapped to identify the augment: `Augment "name" failed to boot: <err>`.

**`shutdown()`** is best-effort: each augment's `onShutdown` runs in reverse order with a 5-second timeout (via `withTimeout`). Failures and timeouts are swallowed — we want to give every augment a chance to clean up, even if some fail.

**Idle timer:** the agent is supposed to call `lifecycle.resetIdleTimer()` after every turn (which `agent.ts` does in both `inject()` and the transport handler). The default interval is 5 minutes. When the timer fires, every augment with an `onIdle` hook runs. This is reserved for future use — memory consolidators, background indexers, etc.

**`health()`** reports the agent's status: `healthy` if everything's ok, `degraded` if any augment is degraded, `unhealthy` if any augment failed to boot or the model is unreachable. The model reachability check is a `model.countTokens("health check")` call — if it throws, the model is considered unreachable. (This is intentionally cheap and only catches "the model client is fundamentally broken," not "the API is having a bad day.")

### `src/kernel/transport-queue.ts` — Per-transport queue

Each transport gets its own queue. Constructed in `agent.ts` `start()`:

```ts
const queue = createTransportQueue({
  concurrency: aug.transport.concurrency ?? 1,
  maxQueueDepth: aug.transport.maxQueueDepth ?? 50,
  rateLimitPerPeer: aug.transport.rateLimitPerPeer,
});
```

The queue has one method: `enqueue(trigger, handler)`. The handler is `(trigger) → Promise<TurnResult>` — it's the function that actually runs the turn loop. The queue wraps it with:

1. **Rate limit check.** If `rateLimitPerPeer.maxPerMinute` is set and the peer has made that many requests in the last 60 seconds, return immediately with `status: "rejected"` and `errorResponse: "Rate limit exceeded..."`. The peer's request count is tracked in a `Map<peerId, timestamps[]>` that gets cleaned of old entries on each check.
2. **Queue depth check.** If `queue.length >= maxQueueDepth`, return immediately with `status: "rejected"` and `errorResponse: "Too many pending messages..."`.
3. **Enqueue.** Add to the internal queue, call `processNext()`, return a promise that resolves when the handler runs.

**`processNext()`** dequeues the next item if `activeCount < concurrency`, runs its handler, decrements `activeCount` on completion, and recurses to drain the queue.

Rejected results have `status: "rejected"`, `success: false`, and a fake (empty) trace. They emit no kernel events — which is exactly why the web transport had to be updated to detect this case and synthesize SSE error events when it got a rejected result.

### `src/kernel/timeout.ts` — Timeout helper

Tiny module:

```ts
export class TimeoutError extends Error {}

export function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  // Race fn() against a setTimeout that rejects with TimeoutError.
  // Critically: clearTimeout in a finally block so the timer is GC'd
  // whether fn() resolves or rejects.
}
```

Used by:
- The augment context pipeline (`contextTimeoutMs`)
- Tool execution in the loop (`toolTimeoutMs`)
- Augment shutdown (`5000ms` hardcoded)

Why the timeout is a separate file: it has tested behavior (clears its timer to avoid leaks; propagates the original error not a TimeoutError on fast failures). Timer cleanup is the kind of thing that's wrong silently if you don't test it explicitly.

### `src/kernel/output-validator.ts` — Output validator

Tiny module that scans model output for fabricated tool calls. v1 returns `{ flagged: boolean, reasons: string[] }` and the kernel records flagged validations in the trace. It does not block.

The reasoning: an active block on output is a heavy intervention that's hard to make right. Flagging in the trace gives operators the data they need to decide whether to escalate to a real block in v2.

### `src/kernel/preamble.ts` — Preamble builder

Constructs the system preamble for every turn. Returns a fixed string with three sections:
1. Identity declaration (`You are an agent managed by the Auggy runtime.`)
2. Trust info (which augment the inbound came from, peer ID/name/kind, trust level)
3. Hardening rules (don't comply with adversarial input from untrusted peers, don't reveal system internals, don't fabricate tool calls, treat tool results as authoritative, treat `[PEER-DERIVED]` blocks with caution)

These rules are baked into every turn. They aren't configurable — the cost of getting them wrong (an agent that leaks its system prompt or comply with untrusted instructions) is too high to leave as a setting.

### `src/kernel/tool-selector.ts` — Tool selector

Filters tools through `capabilityTable.canExpose` and converts them to `ToolDefinition[]`. v1 mounts all tools below a threshold (default 25); the design allows for a future two-phase selection (present a category menu when over threshold) but it isn't implemented in v1.

```ts
selectTools(tools, turnState, { threshold = 25, canExpose }) → {
  mounted: Tool[];          // tools the model can call
  definitions: ToolDefinition[];   // model-facing serialization
  withheld: string[];       // tool names blocked by canExpose
  phase1Used: boolean;      // always false in v1
}
```

### `src/kernel/trace-emitter.ts` — Trace emitter

Builds a `TurnTrace` over the course of a turn. Methods:
- `startTurn(opts)` — creates the trace shell and returns it.
- `recordContextAssembly(trace, opts)` — fills in the context assembly section.
- `recordToolSelection(trace, opts)` — fills in the tool selection section.
- `recordInference(trace, opts)` — appends to `inferenceSteps`.
- `recordCapabilityCheck(trace, opts)` — appends to `capabilityChecks`.
- `finalize(trace)` — sets `duration = now - timestamp`.

The trace is stored on the `TurnResult` and is the main observability output. Future plans add a trace exporter augment.

### `src/agent.ts` — `defineAgent`

The orchestrator that ties everything together. ~200 LOC. Key responsibilities:

1. **Wire the memory bus first.** `wireMemoryBus(config.augments)` returns the augments-with-synthesized-context plus the synthetic `memory-bus` augment (if any memory providers exist). The synthesized augments + the synthetic augment become the *effective* augment list. Everything downstream uses the effective list.

2. **Generate the agent card** from the effective config. This happens once at construction; the card is cached and returned by `agent.card()` and `transportKernel.getAgentCard()`.

3. **Construct the lifecycle manager and turn loop** with the effective augments.

4. **`start()`:**
   - `lifecycle.boot()` — runs every augment's `onBoot` in order.
   - For each transport augment: construct a `TransportQueue`, build a `TransportKernel` view (with `handleInbound`, `onOutbound`, `getAgentCard`), and `await aug.transport.register(transportKernel)`.
   - Start the idle timer.

5. **`handleInbound` (the function passed to each transport's `TransportKernel`):**
   - `queue.enqueue(trigger, handler)` where `handler` is the actual turn-execution function.
   - Inside the handler:
     - `lifecycle.resetIdleTimer()` (we got activity, push the idle timer back).
     - Call `turnLoop.executeTurn(trigger, threadId, { onEvent })`.
     - `dispatchOutbound(result, trigger)` — call the registered `onOutbound` callback for the target transport with each response message.
     - Eager compaction: `historyManager.compact(historyBudget, strategy)`.
     - Fire all `onTurnEnd` hooks fire-and-forget.
     - Return the `TurnResult`.

6. **`inject(trigger)`:** the back door. Bypasses the queue entirely — runs the turn loop directly. Used by tests and by augments that need to schedule internal work.

7. **`stop()`:** stops the idle timer, calls `lifecycle.shutdown()`.

## Why this shape

### Why one file for the whole turn loop

Splitting the turn loop into "phases as separate functions" was tried in early prototypes. The result was harder to read, not easier — because the *ordering* of phases is the most important thing about the loop, and breaking them apart hides the ordering.

The current shape (one long function with comments separating phases) treats the loop as what it is: a script that runs in a fixed order. You read it top to bottom and you understand exactly what happens.

### Why the kernel doesn't expose mid-loop hooks

There is no `onBeforeContext`, `onAfterToolCall`, `onBeforeInference`, etc. The temptation to add these is constant — they look like flexibility. But each one creates a place where augment code can break the loop in ways that are hard to debug.

Augments express their behavior via `context()`, `tools[]`, `transport`, `memory`, and the five lifecycle hooks. That's the whole interface. If you can't express what you need in those, the answer is usually "you don't actually need that" — and the rare time the answer is "the kernel needs a new hook," it gets added with explicit semantics and tests.

### Why event emission is via callback, not return value

The kernel could collect all events into an array and return them with the `TurnResult`. The reason it uses an `onEvent` callback instead is **streaming** — transports need to forward events to the wire as they happen, not after the turn finishes. Returning events would force the entire turn to buffer before the client sees anything, which defeats AG-UI's purpose.

The cost of the callback approach is one extra parameter on `executeTurn` and a default no-op (`() => {}`) when transports don't pass one. The benefit is that the web transport's `ReadableStream` can write each event as it arrives.

### Why the inference loop is capped at 10

A model that calls tools indefinitely without producing a final answer is either confused or has hit a logic bug. 10 iterations is enough for any realistic chain of dependent tool calls and small enough that a runaway loop doesn't burn budget for long. The cap is hardcoded; it's not configurable per agent.

### Why history is per-thread, not per-turn

Conversations span turns. Each turn's history starts with whatever the previous turn left behind (within the budget walk). This is the fundamental difference between a turn (one round trip) and a thread (a conversation).

`getOrCreateHistory(threadId)` lazily creates the manager on first use. There is no eviction policy for old threads in v1 — long-running agents will accumulate history managers in memory until restart. This is acceptable for the LORF use case (a small number of threads, restarts are cheap) and is the kind of thing a future "thread pruner" augment can address without touching the kernel.

### Why everything is closure-based, not classes

Two reasons:
1. **No `this` footguns.** Closure-based state is captured by the factory function and accessed by the methods on the returned object. There's no `this` to forget to bind, no inheritance hierarchy, no constructor-vs-method distinction.
2. **Type inference works better.** TS infers the type of an object literal returned from a factory; for a class, you have to declare an interface and a class that implements it (or use the class itself as the interface, which is more restrictive). The factory pattern produces tighter types with less ceremony.

The cost is no `instanceof` checks (you can't ask "is this thing a HistoryManager?"). The runtime never needs to ask that question — there's always exactly one place each kind of object comes from.

## What you should read next

- [05-memory-subsystem.md](./05-memory-subsystem.md) — how the memory bus integrates with the kernel.
- [06-transports.md](./06-transports.md) — the transport contract and how kernel events become wire events.
- [08-agent-lifecycle.md](./08-agent-lifecycle.md) — how `defineAgent` ties the kernel, lifecycle manager, and transports together.

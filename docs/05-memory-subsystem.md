# 05 — Memory Subsystem

> The memory provider contract, the registry, the bus, context synthesis, and the four generic memory tools. Everything in `src/memory/`.

## Why memory is its own subsystem

Memory is just augment-territory in principle — any augment can contribute context, so any augment can be "memory." But in practice memory has enough internal structure that putting it inline in every memory-providing augment would force every author to re-implement the same machinery: registering labels, detecting conflicts, exposing tools, building blocks from retrieved entries.

The memory subsystem exists to **factor out the common machinery** so authors of memory-providing augments only have to implement the part that's unique to their backend (file? database? Redis?). The contract they implement is `MemoryProviderSpec`. Everything else — wiring, conflict detection, generic tools, context synthesis — is provided by the bus.

The result: writing a new memory provider is ~50 LOC of backend-specific code. Both `fileMemory` and `supabaseMemory` are concrete proofs of the contract.

## The contract: `MemoryProviderSpec`

A memory provider is an augment that has a `memory` field of type `MemoryProviderSpec`. The spec is a discriminated union of two flavors:

### Static memory provider

```ts
export interface StaticMemoryProvider {
  owns: { kind: "static"; labels: string[] };
  defaults: MemoryDefaults;
  read: (label: string) => Promise<MemoryEntry | null>;
  write?: (label: string, content: string) => Promise<void>;
}
```

A static provider declares **a fixed list of labels it owns**. The label space is closed — the provider knows exactly which labels exist. This fits content with a known structure: identity files, configuration values, pinned notes.

`read(label)` is mandatory. The provider must know how to produce a `MemoryEntry` for any label in its `labels` list (or return `null` if the label doesn't exist yet, which is valid for write-able providers).

`write(label, content)` is optional. If present, the provider supports being written to via the generic `memory_write` tool. If absent, the provider is read-only.

**Example:** `fileMemory` is a static provider with one label (`opts.label`) that mirrors the contents of a single file.

### Namespace memory provider

```ts
export interface NamespaceMemoryProvider {
  owns: { kind: "namespace"; prefix: string };
  defaults: MemoryDefaults;
  search: (query: string) => Promise<MemoryEntry[]>;
  write?: (label: string, content: string) => Promise<void>;
  read?: (label: string) => Promise<MemoryEntry | null>;
  list?: () => Promise<string[]>;
}
```

A namespace provider declares **a prefix string** and owns every label that starts with that prefix. The label space is open — the provider can have any number of entries, named anything (as long as they begin with the prefix).

`search(query)` is mandatory. This is the main retrieval path: given a query string, return relevant entries. Both substring and semantic search are valid implementations — the contract doesn't care.

`read(label)`, `write(label, content)`, and `list()` are all optional:
- `read` lets the model fetch a specific entry by exact label.
- `write` enables the generic `memory_write` tool.
- `list` is reserved for a future "list namespace contents" tool.

**Example:** `supabaseMemory` is a namespace provider with `prefix: "episode:"` (or whatever the user configured) backed by a Supabase table with `(label, content, metadata, created_at)` columns. `search` does ILIKE on content; `read` does eq on label; `write` does insert.

### `MemoryDefaults`

```ts
export interface MemoryDefaults {
  mutable: boolean;
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  ttl?: "turn" | "session" | "persistent";
}
```

These are the values that `synthesizeContextFor` uses when wrapping retrieved entries into `ContextBlock`s. They're declared once at the provider level so individual entries don't have to carry them.

The `mutable: boolean` here is more than a flag — it's a declaration that gates how the provider's content can be marked. A static identity provider is `mutable: false`; a self-notes provider is `mutable: true`; an episodic memory store is `mutable: true` for new entries but the entries themselves are written once and never updated.

## `src/memory/types.ts` — `MemoryRegistry`

```ts
export interface MemoryRegistry {
  static: Map<string, Augment>;       // label → owning augment
  namespaces: Array<{ prefix: string; augment: Augment }>;
}
```

The registry is the in-memory map from labels to augments. Static labels are exact-match (`Map<string, Augment>`); namespaces are an ordered list (so longest-prefix-wins lookup is straightforward).

## `src/memory/registry.ts` — `buildRegistry` + `lookupProvider`

Three pure functions:

```ts
getMemoryProviders(augments): Augment[]                    // filter to memory-providing augments
buildRegistry(providers): MemoryRegistry                   // build registry, throw on conflicts
lookupProvider(registry, label): Augment | null            // route a label to its owner
```

### Conflict detection

`buildRegistry` does **three passes** over the providers and throws if any of them detects an overlap:

**Pass 1 — Static label conflicts.** Walk every static provider's labels. If any label is already owned by another provider, throw:
```
Memory label conflict: "self" is owned by both "identity-a" and "identity-b"
```

**Pass 2 — Namespace prefix overlap.** For every pair of namespace providers, check if either's prefix is a prefix of the other's. If so, throw:
```
Memory namespace conflict: "log:" (logger) overlaps with "log:user:" (user-logger)
```

This catches both `log:` containing `log:user:` and `log:user:` being contained by `log:`. Two distinct prefixes that don't have a shared root (`log:` and `episode:`) are fine.

**Pass 3 — Static under namespace.** For every static label, check if it falls under any namespace prefix. If so, throw:
```
Memory label conflict: static label "episode:special" (pinned-episode) falls under namespace "episode:" (episodic)
```

Why all three passes: each one catches a different class of mistake. Pass 1 catches "two augments claim the same fixed label." Pass 2 catches "two augments claim overlapping prefixes." Pass 3 catches "an augment pinned a label that falls inside another augment's namespace." Without all three, you can construct configurations that look fine at boot but produce undefined behavior at lookup time.

These checks run **at boot**, in `wireMemoryBus`. A misconfigured memory layout fails the agent immediately — it doesn't silently miscategorize content at runtime.

### `lookupProvider`

```ts
lookupProvider(registry, label) → Augment | null
```

Routes a label to its owning augment. Static labels win over namespaces. Among multiple matching namespaces, longest prefix wins.

Used by the four generic memory tools to figure out which provider to dispatch a request to.

## `src/memory/context-synthesis.ts` — `synthesizeContextFor`

```ts
synthesizeContextFor(aug: Augment): Augment
```

Wraps a memory provider augment with a `context()` function that automatically retrieves blocks from the provider's `read()` (static) or `search(query)` (namespace) and converts them into `ContextBlock`s using the provider's `defaults`.

This is what lets users write a memory provider without writing a `context()` function — the bus generates the context() for them. If an augment already has a `context()` function (because the author wants explicit control), `wireMemoryBus` skips the synthesis and uses the existing function as-is.

### Static synthesis

For a static provider, `context()` iterates every label in `owns.labels`, calls `read(label)`, and pushes any non-null entries.

### Namespace synthesis

For a namespace provider, `context()`:
1. **Only retrieves on message triggers.** `if (turn.trigger.type !== "message") return [];` — the query is the user's message, so non-message triggers (scheduled, event, continuation) get no episodic retrieval.
2. **Extracts the query from `payload.parts`** via `extractText(parts)`.
3. **Calls `search(query)`** and pushes the resulting entries.

If `search` throws, the error is rethrown for **required** augments (which abort the turn) and swallowed for non-required augments (which contribute no blocks for this turn). This matches the kernel's overall "required augments are load-bearing, non-required are best-effort" philosophy.

### Block construction

Each retrieved entry becomes a `ContextBlock` with:
- `source` = augment name (so `[AUGMENT CONTEXT: source]` markers identify it)
- `content` = entry.content
- `placement`, `priority`, `eviction`, `origin`, `ttl` = the provider's `defaults`
- `provenance` = `"memory"` (always)

Note that `metadata` from `MemoryEntry` is **not** transferred to the block — it's only available to code that calls `read()` or `search()` directly (e.g. via the generic tools).

## `src/memory/tools.ts` — Four generic memory tools

```ts
createMemoryTools(registry, opts) → Tool[]    // returns [memory_read, memory_write, memory_search, memory_list]
```

These four tools are mounted on the synthetic `memory-bus` augment (see below). They give the model a way to interact with memory at runtime:

### `memory_read(label: string)`

Routes the label to its owning provider via `lookupProvider`. If the provider is namespace-only and doesn't implement `read`, returns an error: `Error: Provider "name" does not support reading by label (use memory_search)`. Otherwise calls `provider.read(label)` and returns the entry as JSON, or `No entry found for label "..."` if `null`.

### `memory_write(label: string, content: string)`

Same routing. If the provider doesn't implement `write` (immutable), returns: `Error: Memory label "label" is immutable (owned by "name")`. Otherwise calls `provider.write(label, content)` and returns `Successfully wrote to "label"`.

### `memory_search(query: string, providers?: string[])`

Filters the registry's namespace providers (optionally restricted to a list of provider names), calls `search(query)` on each in parallel via `Promise.allSettled`, and returns a JSON array of `{ provider, entries }` results (or `{ provider, error }` for failures).

Note that this **only searches namespace providers** — static providers don't have `search`. If the model wants to read from a static provider, it uses `memory_read(label)`.

### `memory_list()`

Returns a JSON object with two arrays:
- `static` — every static label currently owned
- `namespaces` — every namespace prefix with a `*` suffix

This is the discovery tool — the model uses it to figure out what memory is available before issuing a `memory_read` or `memory_search`.

### Per-turn budget

All four tools share a single budget object:

```ts
interface MemoryToolBudget { calls: number; max: number; }
```

Every tool checks the budget at the start of `execute()`:

```ts
const checkBudget = (): string | null => {
  if (budget.calls >= budget.max) {
    return `Error: Memory operation budget exceeded (${budget.max} per turn)`;
  }
  budget.calls++;
  return null;
};
```

The budget is **reset by the synthetic augment's `onTurnStart` hook**. This means the per-turn cap holds across all four memory tools combined — the model can't read 20 things, then write 20 things, then search 20 things in one turn.

The budget cap is **20** by default, set in `wireMemoryBus({ maxPerTurn: 20 })`. The synthetic augment's `constraints.maxToolCallsPerTurn` is also set to 20 — see below for why both exist.

## `src/memory/memory-bus.ts` — `wireMemoryBus`

The top-level helper. Called by `defineAgent` before everything else.

```ts
wireMemoryBus(augments, opts?) → {
  augmentsWithSynthesizedContext: Augment[];
  syntheticToolsAugment: Augment | null;
  registry: MemoryRegistry;
  budget: MemoryToolBudget;
}
```

### What it does

1. **`getMemoryProviders(augments)`** — filter the augment list to those with a `memory` field.
2. **If no providers exist:** return the original augment list unchanged, with `syntheticToolsAugment: null`. The agent has no memory; no need for any of the bus machinery.
3. **`buildRegistry(providers)`** — construct the registry with all three conflict-detection passes. Throws if any conflict.
4. **Synthesize `context()` for providers that don't have one:** map over the augment list and replace each memory provider with `synthesizeContextFor(aug)`. Augments with a pre-existing `context()` are left untouched.
5. **Create the synthetic `memory-bus` augment:**
   ```ts
   {
     name: "memory-bus",
     capabilities: ["tools"],
     constraints: { maxToolCallsPerTurn: maxPerTurn },
     tools: createMemoryTools(registry, { budgetRef: budget }),
     onTurnStart: async () => { budget.calls = 0; },
   }
   ```
6. **Return the wiring** — the synthesized augment list, the synthetic augment, the registry, and the budget object.

### Why `constraints.maxToolCallsPerTurn` AND a separate budget

This is the source of the P2 review finding. Two different mechanisms enforce per-turn caps on memory tool calls:

1. **The capability table's per-augment counter** — `KERNEL_DEFAULT_MAX_TOOL_CALLS = 5` is applied to every augment unless overridden by `constraints.maxToolCallsPerTurn`.
2. **The memory bus's own `MemoryToolBudget`** — a counter that ticks up inside the tool's `execute()` function.

Originally only the budget existed, and the synthetic augment had no constraints. The capability table silently applied the default cap of 5, and memory tools started getting denied at the 6th call even though the budget said 20 were allowed. Codex caught this in review.

The fix: explicitly set `constraints.maxToolCallsPerTurn: maxPerTurn` on the synthetic augment so the capability table and the budget agree. Both mechanisms still exist because:
- The capability table is the kernel's enforcement layer (it works for all tools, not just memory)
- The budget is the memory subsystem's enforcement layer (it gives memory-tool-specific error messages, and is the right place to extend with per-tool sub-budgets if needed later)

Belt-and-suspenders, but with both belts visible and tested.

### How it's used by `defineAgent`

```ts
const wiring = wireMemoryBus(config.augments);
const effectiveAugments = wiring.syntheticToolsAugment
  ? [...wiring.augmentsWithSynthesizedContext, wiring.syntheticToolsAugment]
  : wiring.augmentsWithSynthesizedContext;
```

The synthetic augment is appended **at the end** of the augment list. This matters for the context pipeline order: every other augment's `context()` runs before the synthesized memory contexts, which run before any augments declared after memory providers in the user's config (there shouldn't be any in practice, but the order is well-defined).

The lifecycle manager will boot the synthetic augment last (it has no `onBoot`, so this is a no-op). The capability table will see it as an augment with 4 tools and a 20-call limit. The agent card's skills list will include all four memory tools.

## How it all fits together at runtime

1. **`defineAgent`** is called with `augments: [identity, episodic, webTransport]` (where `identity` is a `fileMemory(...)` and `episodic` is a `supabaseMemory(...)`).
2. **`wireMemoryBus`** runs:
   - Detects two memory providers: `identity` (static, owns `["self"]`) and `episodic` (namespace, owns `"episode:"`).
   - Builds the registry: `static = { "self" → identity }`, `namespaces = [{ prefix: "episode:", augment: episodic }]`.
   - No conflicts, so no throw.
   - Synthesizes `context()` for both augments (since neither has a manual `context`).
   - Creates the synthetic `memory-bus` augment with the four tools and the budget.
3. **`defineAgent`** continues with `effectiveAugments = [identity', episodic', webTransport, memory-bus]` (where `'` denotes the wrapped versions).
4. **`generateAgentCard`** walks the effective config and produces a card with `capabilities.memory: true`, `capabilities.transport: true`, and 4 memory tool skills (from `memory-bus.tools`).
5. **`agent.start()`** boots: `identity.onBoot()` reads the file into cache; `episodic` has no onBoot; `webTransport.onBoot()` starts Bun.serve; `memory-bus` has no onBoot.
6. **A peer sends a message via `/agent/run`**. The trigger flows into the turn loop.
7. **Phase 2 — `onTurnStart`:** `memory-bus.onTurnStart()` resets `budget.calls = 0`.
8. **Phase 4 — context pipeline:**
   - `identity.context(turnState)` (the synthesized one) calls `identity.memory.read("self")` and returns one block with the file contents at `placement: "system"`, `priority: "required"`.
   - `episodic.context(turnState)` (the synthesized one) extracts the user's message text and calls `episodic.memory.search(text)`. Returns however many blocks come back, all at `placement: "preamble"`, `priority: "normal"`.
   - `webTransport` and `memory-bus` have no `context()`, so they're skipped.
9. **Phase 6 — allocator:** assembles the prompt with identity in `systemBlocks`, episodic in `contextBlocks`.
10. **Phase 7 — inference loop:** the model gets a tools list that includes `memory_read`, `memory_write`, `memory_search`, `memory_list` (plus any other augment's tools — none in this example). It can call them; they route through the registry to the right provider.
11. **Tool calls:** if the model calls `memory_search({ query: "previous coffee chat" })`, the tool dispatches to every namespace provider's `search` (just `episodic` here) and returns results.

## What memory subsystem testing looks like

Tests live in `tests/memory/`:
- `registry.test.ts` (10 tests) — every conflict detection rule, lookup precedence
- `context-synthesis.test.ts` (8 tests) — static synthesis, namespace synthesis, error handling, message-trigger gating
- `tools.test.ts` (10 tests) — each of the four tools, the budget, error cases
- `memory-bus.test.ts` (6 tests) — the wiring helper, including the new `maxToolCallsPerTurn` test added after the P2 finding

Plus the augment-level tests (`tests/augments/file-memory.test.ts`, `tests/augments/supabase-memory.test.ts`) and the integration test (`tests/integration/full-agent.test.ts`) that exercises the whole memory subsystem end to end through the web transport.

## What's deliberately not in v1

- **Memory consolidation** (episodic → semantic on idle). Listed as Plan 7+ aspirational. Will run in `onIdle` hooks.
- **Vector / semantic search.** `supabaseMemory.search` uses ILIKE for substring matching — not embeddings. A future provider can implement `search` with pgvector and the rest of the bus stays the same (the `MemoryProviderSpec` contract is search-agnostic).
- **Budget per provider.** v1 has one shared budget across all four tools. A future enhancement could give each provider its own sub-budget (e.g. "this episodic store can only be queried 5 times per turn").
- **Memory "permissions" beyond mutable/immutable.** v1's `MemoryDefaults.mutable` is the only access control. A more sophisticated model would have read/write/append permissions per peer trust level. Not in scope for v1.
- **`memory_list` filtering.** v1 returns all labels and prefixes. Future could filter by category or by namespace.
- **`memory_search` ranking across providers.** v1 returns each provider's results separately. Future could merge and rerank.

These are all features that can be added without changing the existing contract. The contract is the load-bearing part — once it's right, the implementations are easier to swap.

# 05 — Memory Subsystem

> The memory provider contract, the registry, the bus, context synthesis, and the five generic memory tools. Everything in `src/memory/`.

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

`read(label)`, `write(label, content)`, `list()`, and provider-specific
destructive helpers such as `forget(peerId)` are optional:
- `read` lets the model fetch a specific entry by exact label.
- `write` enables the generic `memory_write` tool.
- `list` lets `memory_list` expose namespace contents when the provider
  supports it.
- `forget` lets `memory_forget` delete peer-scoped episodic entries for
  right-to-erasure flows.

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

Used by the generic memory tools to figure out which provider to dispatch a request to.

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
- `source` = augment name, retained for traces and evictions but not rendered
  into the model-facing prompt
- `content` = entry.content
- `placement`, `priority`, `eviction`, `origin`, `ttl` = the provider's `defaults`
- `provenance` = `"memory"` (always)

Note that `metadata` from `MemoryEntry` is **not** transferred to the block — it's only available to code that calls `read()` or `search()` directly (e.g. via the generic tools).

## `src/memory/tools.ts` — Five generic memory tools

```ts
createMemoryTools(registry, opts) → {
  tools: Tool[];                          // [memory_read, memory_write, memory_search, memory_list, memory_forget]
  onTurnEnd: (turnId: string) => void;    // primary budget cleanup
  onTurnStart: () => void;                // emergency cleanup backstop
}
```

These five tools are mounted on the synthetic `memory-bus` augment (see below). They give the model a way to interact with memory at runtime.

### Unified trust gate

Read, write, search, and list enforce the same trust rule before executing:

```
- Missing context        → DENY (fail-closed)
- origin "peer-derived"  → ALLOW (peer-scoped memory is open to all)
- trust ∈ {creator, agent} → ALLOW
- otherwise              → DENY (public, or any future level below agent)
```

For writes, a provider may additionally declare `writeTrustLevels`. This is an
allowlist layered on top of the origin rule. The scaffolded `learned` provider
uses `writeTrustLevels: ["creator"]`, so admitted agents and public peers cannot
change agent-global behavior even though creator and agent trust can normally
access non-peer memory. `memory_forget` has its own stricter destructive-action
gate.

Null peer (internal/scheduled triggers) is treated as creator trust per the convention from `effectiveTrustLevel` in capability-table.ts.

### `memory_read({ label })`

Routes the label to its owning provider via `lookupProvider`. Checks the trust gate against the provider's `defaults.origin`. If the provider is namespace-only and doesn't implement `read`, returns an error: `Error: Provider "name" does not support reading by label (use memory_search)`. Otherwise calls `provider.read(label)` and returns the entry as JSON, or `No entry found for label "..."` if `null`.

### `memory_write({ topic?, label?, provider?, content })`

Writes content to memory. For peer-scoped namespace memory, prefer the
topic-based form:

```ts
memory_write({
  topic: "preferences",
  content: "Sam prefers concise replies.",
})
```

`label` and `topic` are mutually exclusive. Namespace memory only accepts the
topic form so callers cannot forge another peer's internal label. When `topic`
is used, the runtime requires turn context and a current peer. It
finds the single writable namespace provider available to that peer and derives
a label from the provider namespace, the current peer id, and the normalized
topic. The model does not invent visitor IDs or internal labels. If multiple
writable namespace providers are visible, the tool returns an error naming the
candidates; retry with `provider`.

Exact label writes are still supported. The default `learned` label is for
creator-approved agent-global operating behavior, never visitor facts:

```ts
memory_write({ label: "learned", content: "..." })
```

For exact labels, routing is the same as `memory_read`: `lookupProvider` finds
the owning provider. If the provider doesn't implement `write` (immutable), the
tool returns `Error: Memory label "label" is immutable (owned by "name")`.
Then it checks the trust gate and the provider write allowlist before calling
`write`. Successful results begin with `PERSISTED`. Validation and authorization
failures return a structured tool error beginning with `NOT_PERSISTED`. A
provider exception returns `PERSISTENCE_UNKNOWN`, because a provider may have
committed before throwing. The kernel marks both as tool errors. Provider
exception details remain in server logs rather than being returned to the
model.

The synthetic memory-bus also emits a required, turn-scoped system block that
lists exact writable labels and whether current-peer topic memory is actually
available. This lets the model choose the right destination before attempting
a write.

### `memory_search({ query, providers? })`

Filters the registry's namespace providers — optionally restricted to a list of provider names, then by the trust gate (provider's origin must be readable by the current peer). Calls `search(query)` on each remaining candidate in parallel via `Promise.allSettled`, and returns a JSON array of `{ provider, entries }` results (or `{ provider, error }` for failures).

Note that this **only searches namespace providers** — static providers don't
have `search`. If the model wants to read from a static provider, it uses
`memory_read({ label })`.

### `memory_list()`

Returns a JSON object with two arrays, **filtered by what the current peer can access**:
- `static` — every static label currently owned and readable by the peer
- `namespaces` — every namespace prefix (with a `*` suffix) readable by the peer

This is the discovery tool — the model uses it to figure out what memory is available before issuing a `memory_read` or `memory_search`. Untrusted peers see only `peer-derived` providers; creator/agent peers see everything.

### `memory_forget({ peerId })`

Deletes all episodic entries for one peer across namespace providers that
implement `forget`. This is the right-to-erasure tool. It is always gated to
creator or agent trust, regardless of the provider's normal read/write origin.

The return shape is:

```json
{
  "status": "ok",
  "deleted": 12,
  "message": "Deleted 12 entries for peer \"vis_abc123\"."
}
```

If one provider fails but another succeeds, the status is `partial` and the
result includes an `errors` array.

### Per-turn budget

All five tools share a per-turn budget keyed by `turnId` from `ToolExecuteContext`:

```ts
const turnBudgets = new Map<string, number>();

function checkBudget(turnId: string): string | null {
  const calls = turnBudgets.get(turnId) ?? 0;
  if (calls >= maxPerTurn) {
    return `Error: Memory operation budget exceeded (${maxPerTurn} per turn)`;
  }
  turnBudgets.set(turnId, calls + 1);
  return null;
}
```

Concurrent turns get independent budgets — entries are isolated by `turnId`.

**Cleanup happens via two hooks:**

1. **Primary: `onTurnEnd(turnId)`** — called by the agent's onTurnEnd lifecycle for every completed turn (success, failure, or rejection). Removes that turn's entry from the map.
2. **Backstop: `onTurnStart()`** — emergency clear if the map exceeds 1000 entries (signals onTurnEnd hooks not firing — kernel/agent bug to investigate).

The budget cap is **20** by default, set in `wireMemoryBus({ maxPerTurn: 20 })`. The synthetic augment's `constraints.maxToolCallsPerTurn` is also set to 20 — see below for why both exist.

## `src/memory/memory-bus.ts` — `wireMemoryBus`

The top-level helper. Called by `defineAgent` before everything else.

```ts
wireMemoryBus(augments, opts?) → {
  augmentsWithSynthesizedContext: Augment[];
  syntheticToolsAugment: Augment | null;
  registry: MemoryRegistry;
}
```

### What it does

1. **`getMemoryProviders(augments)`** — filter the augment list to those with a `memory` field.
2. **If no providers exist:** return the original augment list unchanged, with `syntheticToolsAugment: null`. The agent has no memory; no need for any of the bus machinery.
3. **`buildRegistry(providers)`** — construct the registry with all three conflict-detection passes. Throws if any conflict.
4. **Synthesize `context()` for providers that don't have one:** map over the augment list and replace each memory provider with `synthesizeContextFor(aug)`. Augments with a pre-existing `context()` are left untouched.
5. **Create the synthetic `memory-bus` augment:**
   ```ts
   const { tools, onTurnEnd, onTurnStart } = createMemoryTools(registry, { maxPerTurn });
   {
     name: "memory-bus",
     capabilities: ["tools"],
     constraints: { maxToolCallsPerTurn: maxPerTurn },
     tools,
     onTurnStart: async () => { onTurnStart(); },     // emergency cleanup backstop
     onTurnEnd: async (turn) => { onTurnEnd(turn.turnId); },  // primary cleanup
   }
   ```
6. **Return the wiring** — the synthesized augment list, the synthetic augment, and the registry.

### Why `constraints.maxToolCallsPerTurn` AND a separate budget

This is the source of the P2 review finding. Two different mechanisms enforce per-turn caps on memory tool calls:

1. **The capability table's per-augment counter** — `KERNEL_DEFAULT_MAX_TOOL_CALLS = 5` is applied to every augment unless overridden by `constraints.maxToolCallsPerTurn`.
2. **The memory bus's own per-turn budget** — a `Map<turnId, number>` that tracks calls per turn inside the tool's `execute()` function.

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

The lifecycle manager will boot the synthetic augment last (it has no `onBoot`, so this is a no-op). The capability table will see it as an augment with 5 tools and a 20-call limit. The agent card marks memory as available; model-facing tool details stay in the tool schema, not in the public A2A skills list.

## How it all fits together at runtime

1. **`defineAgent`** is called with `augments: [identity, episodic, webTransport]` (where `identity` is a `fileMemory(...)` and `episodic` is a `supabaseMemory(...)`).
2. **`wireMemoryBus`** runs:
   - Detects two memory providers: `identity` (static, owns `["self"]`) and `episodic` (namespace, owns `"episode:"`).
   - Builds the registry: `static = { "self" → identity }`, `namespaces = [{ prefix: "episode:", augment: episodic }]`.
   - No conflicts, so no throw.
   - Synthesizes `context()` for both augments (since neither has a manual `context`).
   - Creates the synthetic `memory-bus` augment with the five tools and the budget.
3. **`defineAgent`** continues with `effectiveAugments = [identity', episodic', webTransport, memory-bus]` (where `'` denotes the wrapped versions).
4. **`generateAgentCard`** walks the effective config and produces a card with `capabilities.memory: true` and `capabilities.transport: true`.
5. **`agent.start()`** boots: `identity.onBoot()` reads the file into cache; `episodic` has no onBoot; `webTransport.onBoot()` starts Bun.serve; `memory-bus` has no onBoot.
6. **A peer sends a message via `/agent/run`**. The trigger flows into the turn loop.
7. **Phase 2 — `onTurnStart`:** `memory-bus.onTurnStart()` resets `budget.calls = 0`.
8. **Phase 4 — context pipeline:**
   - `identity.context(turnState)` (the synthesized one) calls `identity.memory.read("self")` and returns one block with the file contents at `placement: "system"`, `priority: "required"`.
   - `episodic.context(turnState)` (the synthesized one) lists the current peer's most recent entries, then extracts the user's message text and calls `episodic.memory.search(text)`. Duplicate entries are removed. Returned blocks keep each entry's own origin (`peer-derived` or `agent-derived`) and use the provider defaults for placement, priority, and eviction.
   - `webTransport` and `memory-bus` have no `context()`, so they're skipped.
9. **Phase 6 — allocator:** assembles the prompt with identity in `systemBlocks`, episodic in `contextBlocks`.
10. **Phase 7 — inference loop:** the model gets a tools list that includes `memory_read`, `memory_write`, `memory_search`, `memory_list`, `memory_forget` (plus any other augment's tools — none in this example). It can call them; they route through the registry to the right provider.
11. **Tool calls:** if the model calls `memory_search({ query: "previous coffee chat" })`, the tool dispatches to every namespace provider's `search` (just `episodic` here) and returns results.

## What memory subsystem testing looks like

Tests live in `tests/memory/`:
- `registry.test.ts` (10 tests) — every conflict detection rule, lookup precedence
- `context-synthesis.test.ts` — static synthesis, namespace synthesis, recent peer retrieval, deduplication, origin preservation, error handling, message-trigger gating
- `tools.test.ts` — each of the five tools, the budget, error cases
- `memory-bus.test.ts` (6 tests) — the wiring helper, including the new `maxToolCallsPerTurn` test added after the P2 finding

Plus the augment-level tests (`tests/augments/file-memory.test.ts`, `tests/augments/supabase-memory.test.ts`) and the integration test (`tests/integration/full-agent.test.ts`) that exercises the whole memory subsystem end to end through the web transport.

## What's deliberately not in v1

- **Memory consolidation** (episodic → semantic on idle). This belongs to the
  memory-layer architecture vision in the roadmap and would run through
  `onIdle` hooks.
- **Vector / semantic search.** `supabaseMemory.search` uses ILIKE for substring matching — not embeddings. A future provider can implement `search` with pgvector and the rest of the bus stays the same (the `MemoryProviderSpec` contract is search-agnostic).
- **Budget per provider.** v1 has one shared budget across all memory tools. A future enhancement could give each provider its own sub-budget (e.g. "this episodic store can only be queried 5 times per turn").
- **Fine-grained memory permissions.** v1 has immutable/mutable provider
  declarations plus the shared origin/trust gate described above. It does not
  yet have per-label read/write/append grants, per-principal grants, or
  operator-approved promotion rules.
- **`memory_list` category filtering.** v1 filters labels and prefixes by what
  the current peer can access. Future work could add category, namespace, or
  provider-specific filters for large memory layouts.
- **`memory_search` ranking across providers.** v1 returns each provider's results separately. Future could merge and rerank.

These are all features that can be added without changing the existing contract. The contract is the load-bearing part — once it's right, the implementations are easier to swap.

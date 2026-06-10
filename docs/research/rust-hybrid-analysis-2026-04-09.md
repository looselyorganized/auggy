# Thought Experiment: Auggy in Rust — Analysis and Hybrid Intervention Plan

**Date:** 2026-04-09
**Status:** Analysis complete. No action required until v1.0 conditions are met.
**Trigger for re-evaluation:** When model routing ships (Plan 8+ aspirational) AND context block count exceeds ~100 per turn.

---

## 0. Context

The operator asked: "what if we built augment-1 in Rust?" This document captures the full analysis — where Rust wins, where it loses, the precise math on when performance bottlenecks emerge, and the surgical hybrid intervention that would be the right response when they do.

**Bottom line (stated upfront):** Rust is the wrong choice for Auggy at this stage. The workload is I/O-bound, the augment interface is the product (and Rust makes it 3-5x harder to author augments), and development velocity was load-bearing for the research-grounded design. **But there is a precise future trigger** — switching to real tokenization at v1.0+ — where a surgical Rust native module for token counting becomes the right intervention. This document captures the math so the decision can be made from data when that trigger fires, not from memory.

---

## 1. Where Rust Wins

### 1.1 Memory footprint

| Metric | Bun (current) | Rust (hypothetical) |
|---|---|---|
| Idle process | ~50-100MB | ~2-10MB |
| 20 agents on one Mac Mini | 1-2GB | 40-200MB |
| 50 agents | 2.5-5GB | 100-500MB |

For a Mac Mini running 24/7 with many agents, the ~5-10x memory advantage is real. At 20+ agents, the Bun overhead starts to compete with the machine's available RAM for actual work.

**When this matters:** v1.0+ (multi-agent) if agents run as separate processes. If the future architecture hosts multiple agents in one process (MLFQ scheduling from AgentRM), the comparison shifts — one Bun process with 20 agent compositions uses less memory than 20 separate Bun processes.

### 1.2 Deploy artifact

| | Bun | Rust |
|---|---|---|
| Single binary | `bun build --compile` ~50MB+ (includes runtime) | `cargo build --release` ~5-30MB (static, no runtime) |
| Runtime dependency | Bun must be installed (or bundled) | None |
| Cross-compilation | Limited | `cargo build --target` for any supported triple |

Rust wins on artifact size and zero-dependency deployment. Marginal advantage — both produce single binaries. The Rust binary is smaller and truly standalone.

### 1.3 No garbage collector

Bun's V8 GC pauses are typically <5ms. Against LLM inference latency (1-30 seconds per turn), this is invisible. **But:** if token-level streaming arrives (Plan 8+ deferred), where the transport writes each token to the SSE stream as it arrives from the model, GC jitter at the ~1ms level becomes perceptible. Rust has no GC pauses — latency is predictable at every timescale.

**When this matters:** Only if token-level streaming ships AND the operator cares about sub-millisecond jitter in the SSE stream. Not a v1 concern.

### 1.4 Type system enforces more invariants

Examples of invariants Rust could enforce at compile time that TypeScript enforces only by convention:

| Invariant | TypeScript enforcement | Rust enforcement |
|---|---|---|
| `PeerDerived` origin blocks can't be placed in `system` | Convention in augment authors' code | Type-level restriction (enum + phantom types or newtype wrappers) |
| `TurnState` references don't outlive the turn | Convention | Lifetime parameter on the reference |
| Errors from `context()` are always handled | `try/catch` in the turn loop (optional) | `Result<T, E>` forces the caller to handle |
| Tool inputs match the declared schema | Runtime Zod validation | Compile-time type checking (though runtime validation is still needed for dynamic model output) |
| Two augments can't both write to the same history | Convention (single-threaded avoidance) | Borrow checker prevents shared mutable access |

**Honest assessment:** Every bug found in Auggy so far (5 kernel-fix batches + 5 Codex findings) was a logic bug or an API-shape bug — **none were type-system-expressible invariant violations.** TypeScript's type system is sufficient for the invariants that actually fail. Rust's stronger guarantees are insurance against failure modes we haven't hit.

### 1.5 Memory safety for untrusted augments

A buggy TypeScript augment running in the same V8 context can:
- Hold references to kernel state indefinitely (memory leak)
- Modify shared objects if the kernel accidentally passes a mutable reference
- Crash the process with an unhandled rejection
- Block the event loop with synchronous computation

A Rust kernel can't be corrupted by a buggy augment — ownership prevents uncontrolled access to kernel state. And **WASM-based augment loading gives sandboxing for free**: WASM modules have no direct filesystem access, no network without WASI, and can't reach into the host's memory.

**When this matters:** Plan 8+ aspirational — "Augment sandboxing (V8 isolates)." When third-party augments from untrusted authors arrive. Currently all augments are first-party (written by the operator or by us), so this is insurance, not a current need.

---

## 2. Where Rust Loses

### 2.1 The augment interface is the product — and Rust makes it harder

The design spec's core thesis: *"the interface between the kernel and augments is the product. If the interface is right, the ecosystem compounds."*

The same augment in both languages:

**TypeScript (12 lines):**
```typescript
export function myAugment(): Augment {
  return {
    name: "my-augment",
    context: async (turn) => [{
      source: "me", content: "hello",
      placement: "preamble", provenance: "augment",
      priority: "normal", eviction: "drop", origin: "system",
    }],
  };
}
```

**Rust (~30 lines):**
```rust
pub struct MyAugment;

#[async_trait]
impl Augment for MyAugment {
    fn name(&self) -> &str { "my-augment" }

    async fn context(
        &self,
        turn: &TurnState,
        _prior: Option<&[ContextBlock]>,
    ) -> Result<Vec<ContextBlock>> {
        Ok(vec![ContextBlock {
            source: "me".into(),
            content: "hello".into(),
            placement: ContextPlacement::Preamble,
            provenance: ContextProvenance::Augment,
            priority: ContextPriority::Normal,
            eviction: EvictionPolicy::Drop,
            origin: ContextOrigin::System,
            ttl: None,
            visibility: None,
            token_count: None,
        }])
    }
}
```

**3-5x more verbose.** Requires trait implementations, `Box<dyn Tool>` for dynamic dispatch, `.into()` conversions for every string, explicit `None` for every optional field, `Result<>` wrapping, lifetime annotations for any references to shared state.

**The audience that writes augments** — web developers connecting their agent to a database, data scientists adding a retrieval tool, operators customizing memory behavior — **knows TypeScript. Very few know Rust.** Making augment authorship require Rust understanding shrinks the potential author pool by an estimated ~90%.

The ecosystem compounds through augment contributions. Rust would slow that compounding to a crawl.

### 2.2 The workload is I/O-bound

Per-turn breakdown:

| Phase | Time (current) | What determines it |
|---|---|---|
| Context assembly | <5ms | String concat, token counting (char/4), sort |
| **Model inference** | **1,000-30,000ms** | **Network round trip to Anthropic/OpenAI** |
| Tool execution | 1-30,000ms | Depends on the tool (DB query, file I/O, API call) |
| SSE serialization | <1ms | JSON.stringify per event |
| History management | <1ms | Array push, backward walk |

**The kernel's CPU work is <10ms — less than 0.1% of a typical turn's wall-clock time.** Rust would make the 5ms kernel work run in 0.5ms. The turn still takes 5 seconds because that's how long the LLM takes to respond. The performance advantage exists in a part of the pipeline where it doesn't matter.

### 2.3 No official Anthropic Rust SDK

The `@anthropic-ai/sdk` npm package handles request construction, response parsing, error handling, retries, and streaming. In Rust, you'd write the engine adapter against `reqwest` + `serde_json` directly — implementing the Messages API request shape, the content block parsing (text vs tool_use), the tool_result folding, the stop_reason mapping, and the error handling yourself.

Same for Supabase — no Rust client exists. You'd use `sqlx` directly against Postgres or `postgrest-rs` against the REST API.

**Every augment that talks to an external service has more integration work in Rust.** The npm ecosystem has mature, maintained clients for almost everything an augment would connect to. The Rust ecosystem is growing but smaller.

### 2.4 Development velocity

Plans 1 and 2 were built in ~2 focused weeks. The research provenance doc shows that the speed of iteration — read a paper, implement the insight, test it, ship it — was load-bearing for the project's research-grounded design.

In Rust, the same work would take an estimated 4-8 weeks:
- Borrow checker friction on async closure patterns (the turn loop's `onEvent` callback, the transport's `register` closure, the memory bus's `synthesizeContextFor` wrapper)
- More boilerplate for every type, every trait impl, every test
- Compile-test cycle of 30-90 seconds (vs instant in Bun)
- Debugging async Rust (less tooling, harder stack traces)

The TDD workflow that built Plans 1 and 2 (168 tests, many written before the code) depends on fast feedback. `bun test` takes 400ms. `cargo test` for a project this size takes 30-90 seconds. That's a 75-225x slowdown on every test iteration.

### 2.5 Augment distribution is structurally harder

In TypeScript, augments are npm packages. Plan 3's CLI (`auggy start --config agent.yaml`) reads a config, calls `import()` to dynamically load augment packages, and starts the agent. This is trivial in TS.

In Rust, you choose between three distribution models, none ideal:

| Model | How it works | Problem |
|---|---|---|
| **Crate dependencies** | Augments listed in `Cargo.toml`, compiled into the binary | **Recompile the agent every time you add/remove an augment.** No hot-plug. No `auggy start --config` without a build step. |
| **Dynamic libraries** (.dylib/.so) | Augments compiled as shared libraries, loaded at runtime via `dlopen` | **Fragile ABI.** Augment compiled with Rust 1.80 may not work with kernel compiled with Rust 1.81. Non-idiomatic. Loses compile-time guarantees at the boundary. |
| **WASM modules** | Augments compiled to WASM, loaded via `wasmtime` or similar | **Sandboxed by default** (good for security). But constrained: no direct filesystem access, no network without WASI, performance overhead at the host-guest bridge, can't directly share Rust types (need serialization). |

TypeScript gives hot-pluggable augments via `import()` for free. The Plan 3 CLI depends on this — and it's not clear how the Rust equivalent would work without a build step or a fragile dynamic-linking story.

### 2.6 Compile times

| | Time | Impact |
|---|---|---|
| `bun test` (168 tests) | ~400ms | Instant feedback. Can run on every save. |
| `cargo test` (equivalent project) | 30-90 seconds | Noticeable pause. Breaks flow. Discourages frequent runs. |
| `cargo build --release` | 1-5 minutes | Blocks deployment iteration. |
| `bun run tsc --noEmit` (typecheck) | ~2 seconds | Fast. |
| `cargo check` (typecheck only) | 10-30 seconds | Slower but usable. |

The 75-225x test slowdown is the most impactful. TDD with a 90-second feedback loop is qualitatively different from TDD with a 400ms loop.

---

## 3. The Performance Bottleneck Math — Precisely When It Matters

The following analysis answers: at what scale does the context allocator or history manager become a measurable bottleneck (>50ms per turn), and what are the specific conditions that trigger it?

### 3.1 Context allocator — what it does per turn

1. **Token counting** — compute token count for each context block
2. **Priority sort** — sort blocks by priority enum order
3. **Budget walk** — walk sorted list, accumulate tokens, evict when over budget
4. **String assembly** — concatenate blocks into placement buckets with `[AUGMENT CONTEXT: source]` markers

### 3.2 Token counting is the decisive variable

Currently, token counting uses `Math.ceil(text.length / 4)` — **O(1) per block, regardless of text length.** This is fast at any scale.

Real tokenization (tiktoken, cl100k_base, o200k_base, SentencePiece) is **O(n) in text length.** The cost per 1,000 tokens of input text is approximately 0.5ms in a JavaScript tiktoken implementation.

| Blocks | Avg tokens/block | Total tokens to count | Time (JS tiktoken) | Time (Rust tiktoken-rs, ~5-10x faster) |
|---|---|---|---|---|
| 5 (Pre-v0) | 500 | 2,500 | ~1ms | <0.5ms |
| 20 (v0) | 500 | 10,000 | ~5ms | ~1ms |
| 50 (v0.5) | 500 | 25,000 | ~13ms | ~2ms |
| **100 (v1.0)** | **1,000** | **100,000** | **~50ms** | **~8ms** |
| 200 (v1.0+) | 1,000 | 200,000 | ~100ms | ~15ms |
| **500 (v1.5)** | **1,000** | **500,000** | **~250ms** | **~40ms** |

**The 50ms threshold is crossed at ~100 blocks with real tokenization.** The 250ms level (definitely user-perceptible) is reached at ~500 blocks. A Rust native tokenizer buys 5-10x, keeping the operation under 50ms until ~500+ blocks.

### 3.3 Other allocator operations — never the bottleneck

| Operation | 100 blocks | 500 blocks | 5,000 blocks |
|---|---|---|---|
| Priority sort (V8 TimSort) | ~0.2ms | ~1ms | ~10ms |
| Budget walk (linear) | <0.1ms | ~0.5ms | ~5ms |
| String assembly (500K chars) | ~3ms | ~5ms | ~10ms |

Even at 5,000 blocks (unrealistic for a single turn), sorting and walking stay under 15ms. **Token counting is the only operation that becomes a bottleneck.**

### 3.4 History manager — when it becomes a problem

**CPU (backward walk in `getHistory`):**

| Messages in thread | Walk time (V8) |
|---|---|
| 50 (Pre-v0) | <0.1ms |
| 500 (v0.5) | ~0.5ms |
| 5,000 (v1.0 long conversations) | ~2ms |
| 50,000 (v1.5 customer support) | ~10ms |

**The backward walk never becomes a CPU bottleneck.** Even at 50,000 messages per thread, it's 10ms.

**Memory (all threads held in-process):**

| Threads | Msgs/thread | Memory per thread (JS objects) | Total |
|---|---|---|---|
| 10 (Pre-v0) | 50 | ~50KB | ~500KB |
| 100 (v0.5) | 200 | ~200KB | ~20MB |
| 1,000 (v1.0) | 500 | ~500KB | ~500MB |
| 10,000 (v1.5) | 1,000 | ~1MB | **~10GB** |

**History is a memory problem, not a CPU problem.** At v1.5+ multi-tenant scale, thread memory competes with the machine's available RAM.

**The fix is pagination, not Rust.** The `HistoryManager` already has `save(storage)` and `restore(storage)` methods on its interface. Cold threads should be offloaded to storage and loaded on demand. Rust would use ~3-5x less memory per message (no GC overhead, no V8 object headers), buying ~3x more threads before hitting the same wall — but the real fix is pagination regardless of language.

### 3.5 Summary: when bottlenecks emerge

| Phase | Context blocks/turn | Thread count | Token counting | Status |
|---|---|---|---|---|
| **Pre-v0 (now)** | ~5 | ~10 | char/4 (O(1)) | **<5ms total. No bottleneck.** |
| **v0 (brain)** | ~20-30 | ~50 | char/4 | **<10ms. No bottleneck.** |
| **v0.5 (spine + retrieval)** | ~50 | ~100 | Probably still char/4 | **~10-15ms. No bottleneck.** May want to switch to real tokenization here if cross-model accuracy matters. |
| **v1.0 (multi-agent + model routing)** | **~100** | ~500 | **Real tokenization needed** (different models = different tokenizers) | **~50ms+ with JS tokenizer. This is the intervention point.** Rust native tokenizer drops it to ~8ms. |
| **v1.5 (multi-tenant)** | ~200-500 | ~5,000+ | Real tokenization | **~100-250ms with JS, ~15-40ms with Rust native.** Thread memory at ~5GB+. Pagination needed. |

### 3.6 The two trigger conditions (both must be true)

1. **You switch from char/4 to real tokenization** — because model routing requires cross-model token accuracy (different models have different tokenizers; char/4 is equally wrong for all of them, which is fine when there's only one model but not when you're routing between Haiku and Opus)
2. **Rich retrieval augments contribute 100+ context blocks per turn** — because the knowledge brain, episodic memory, and any graph-based retrieval are all mounted and contributing

**Conservatively, this is a v1.0 concern** — 6-12 months from now on the LORF roadmap. Before then, the intervention is premature (there's no bottleneck to fix).

---

## 4. The Surgical Hybrid Intervention

When Trigger 1 + Trigger 2 fire simultaneously, the right response is NOT "rewrite Auggy in Rust." It's a surgical native module:

### 4.1 What to build

A **Rust native tokenizer** exposed to Bun via FFI (Bun supports native modules via its C ABI or via N-API compatibility):

```
src/native/
└── tokenizer/
    ├── Cargo.toml           # Rust crate
    ├── src/lib.rs           # ~100 lines: wrap tiktoken-rs, expose countTokens
    └── build.rs             # Compile to .dylib/.so for the host platform
```

The Rust side wraps an existing tokenizer implementation (e.g. `tiktoken-rs` or `tokenizers` from Hugging Face) and exposes one function:

```rust
#[no_mangle]
pub extern "C" fn count_tokens(text: *const u8, text_len: usize, encoding: *const u8, encoding_len: usize) -> u32 {
    // ... wrap tiktoken-rs
}
```

The TypeScript side replaces `createTokenizer()`:

```typescript
// Before (current):
export function createTokenizer(): Tokenizer {
  return { count: (text) => Math.ceil(text.length / 4) };
}

// After (when the trigger fires):
import { dlopen, suffix } from "bun:ffi";
const lib = dlopen(`./native/tokenizer/target/release/libtokenizer.${suffix}`, {
  count_tokens: { args: ["ptr", "usize", "ptr", "usize"], returns: "u32" },
});

export function createTokenizer(encoding = "cl100k_base"): Tokenizer {
  return {
    count: (text) => {
      const buf = new TextEncoder().encode(text);
      const enc = new TextEncoder().encode(encoding);
      return lib.symbols.count_tokens(buf, buf.length, enc, enc.length);
    },
  };
}
```

### 4.2 What this changes

| Metric | Before (char/4) | After (JS tiktoken) | After (Rust native) |
|---|---|---|---|
| Accuracy | ±30% error | Exact | Exact |
| 100 blocks × 1K tokens | <1ms | ~50ms | ~8ms |
| 500 blocks × 1K tokens | <1ms | ~250ms | ~40ms |
| Lines of new code | 0 | ~200 (JS lib) | ~100 (Rust) + ~20 (TS bridge) |

### 4.3 What this does NOT change

- The augment interface stays TypeScript
- The turn loop stays TypeScript
- The capability table, history manager, lifecycle manager, transport queue — all stay TypeScript
- Augment authors never see the native module
- The `Tokenizer` interface is unchanged: `{ count(text: string): number }`
- Tests continue to work — the mock model's `countTokens` doesn't call the native module

**The intervention is invisible to every consumer of the public API.** It's a swap inside `createTokenizer()` and nothing else.

### 4.4 Why not rewrite more in Rust at that point

Because **nothing else is a bottleneck:**

| Component | Time at v1.0 scale | Fix needed? |
|---|---|---|
| Token counting | 50ms+ (with JS tiktoken) | **Yes — this is the bottleneck** |
| Priority sort | ~0.2ms | No |
| Budget walk | <0.1ms | No |
| String assembly | ~3ms | No |
| History backward walk | ~2ms | No |
| Capability table lookup | <0.1ms | No |
| SSE serialization | <1ms | No |
| Zod validation | ~2ms (20 tool calls) | No |

Rewriting the sort, the budget walk, or the history manager in Rust would save microseconds in components that take <1ms. The cost (FFI bridge complexity, two-language debugging, slower iteration) vastly exceeds the benefit. The tokenizer is the one operation where Rust's performance advantage maps to a real, measurable user-facing latency improvement.

---

## 5. The Full Rewrite Scenario — When It Would Be Justified

The analysis above assumes the LORF use case: a handful of agents, I/O-bound workload, first-party augments, TypeScript-savvy operators. A full Rust rewrite would be justified under **different conditions**:

### 5.1 Multi-tenant agent hosting (10,000+ agents)

If Auggy becomes a hosted platform where each customer deploys agents:
- Memory footprint per agent matters (5-10x with Rust)
- Process isolation matters (Rust's ownership model, or WASM sandboxing)
- Scheduling across agents matters (MLFQ from AgentRM)
- The operator audience shifts from "web developers" to "infrastructure engineers" who know Rust

### 5.2 Third-party augment sandboxing as a near-term non-negotiable

If the augment catalog (Plan 3) goes public before sandboxing (Plan 8+) is ready, the security gap is: untrusted augments run in the same V8 context as the kernel. V8 isolates (the TS answer) are heavy and complex. WASM (the Rust answer) is lighter and gives sandboxing for free.

### 5.3 Resource-constrained deployment targets

If agents need to run on edge devices, IoT hardware, or embedded systems where 50MB of RAM for a Bun process is untenable. Rust's 2-10MB footprint fits.

### 5.4 Latency-critical applications

If the agent runtime needs to meet hard real-time constraints (medical devices, autonomous vehicles, trading systems) where GC jitter is unacceptable at any level. The Blueprint Architecture paper (Koubaa, TechRxiv 2025) explicitly calls out HRT/SRT/DT latency classes — none of which matter for LORF's chat-based agents, but would matter for these use cases.

### 5.5 2+ year runway before needing ecosystem adoption

If there's enough time to build the Rust augment ecosystem from scratch before needing third-party contributions. At that point, the ergonomic cost of Rust augment authorship is amortized over a large enough userbase that good tooling (derive macros, proc macros, builder patterns) can smooth the rough edges.

**None of these conditions hold for LORF's current situation or the next 12 months of the roadmap.**

---

## 6. The Hybrid Option in Detail

For completeness, here's the full hybrid architecture — **not recommended now, but documented for future reference.**

### 6.1 Kernel in Rust, augments in TypeScript via WASM bridge

```
┌─────────────────────────────────┐
│  TypeScript Augments            │
│  (npm packages, import()able)   │
│  fileMemory, supabaseMemory,    │
│  webTransport, custom augments  │
└──────────────┬──────────────────┘
               │ WASM bridge (serialization boundary)
┌──────────────┴──────────────────┐
│  Rust Kernel (WASM host)        │
│  turn-loop, allocator,          │
│  capability-table, history,     │
│  tool-selector, lifecycle,      │
│  trace-emitter                  │
└─────────────────────────────────┘
```

**Advantages:**
- Memory safety for the kernel — augments can't corrupt kernel state
- WASM sandboxing for augments — free with the architecture
- Rust performance for the kernel — relevant when tokenization bottleneck appears
- TypeScript ergonomics preserved for augment authors

**Disadvantages:**
- Two languages to maintain (Rust kernel + TypeScript augments)
- Serialization at the WASM boundary adds latency (~0.1-1ms per crossing)
- Debugging across the bridge is painful (two debuggers, no shared stack traces)
- The type system advantage is partially lost at the boundary (need runtime validation for the serialized augment interface)
- The `Augment` interface becomes a wire protocol, not a TypeScript type — augments have to serialize their `ContextBlock[]`, `Tool[]`, etc. to cross the WASM boundary
- Development velocity drops for any kernel change (Rust compile + WASM compile + bridge test)
- The bridge itself is ~500-1000 lines of glue code that must be maintained

**Estimated effort:** 4-8 weeks to port the kernel + build the bridge + revalidate all 168 tests against the new architecture. This is NOT a weekend project.

### 6.2 TypeScript everything, Rust native module for tokenizer only (recommended when trigger fires)

```
┌─────────────────────────────────┐
│  TypeScript everything          │
│  (unchanged from current)       │
│                                 │
│  src/tokenizer.ts calls:        │
│  ┌──────────────────────────┐   │
│  │ Rust native tokenizer    │   │
│  │ via Bun FFI              │   │
│  │ (~100 LOC Rust)          │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

**Advantages:**
- Fixes the one bottleneck that matters (5-10x faster tokenization)
- One language for all augment-facing code
- ~100 LOC Rust + ~20 LOC TypeScript bridge
- The `Tokenizer` interface is unchanged — `{ count(text: string): number }`
- No architectural change — it's a module swap inside `createTokenizer()`
- Can be done in a day

**Disadvantages:**
- Rust toolchain needed in the build pipeline (cargo)
- Platform-specific native modules (.dylib on macOS, .so on Linux)
- Can't cross-compile the native module as easily as pure TS
- Bun FFI has some rough edges (buffer management, string encoding)

**Estimated effort:** 1-2 days including tests.

---

## 7. Recommendation

### Now (Pre-v0 through v0.5)

**Do nothing.** The kernel runs in <5ms per turn. There is no bottleneck. Writing Rust code for a problem that doesn't exist is premature optimization — and the opportunity cost (slower iteration, harder augment authoring) is real and ongoing.

### At v1.0 (when model routing ships AND context blocks exceed ~100/turn)

**Build the Rust native tokenizer module (§4).** ~100 LOC Rust, ~20 LOC TypeScript bridge, 1-2 days of work. Fixes the one operation that becomes a bottleneck. Everything else stays TypeScript. The intervention is invisible to augment authors.

**Measure first.** Before building the module, add timing instrumentation to `createContextAllocator` to confirm that token counting is actually the bottleneck in production (not something else we haven't anticipated). The math above is a projection, not a measurement.

### At v1.5+ (if multi-tenant hosting materializes)

**Re-evaluate the full hybrid (§6.1) based on production data.** If memory footprint per agent is the constraint, the WASM hybrid may be justified. But this is a v1.5+ decision — at least 12-18 months from now — and the landscape (Bun's evolution, WASM tooling maturity, Rust async ecosystem) will look different by then. Don't make this decision now.

### Never (unless conditions in §5 arise)

**Don't do a full Rust rewrite of Auggy.** The augment interface is the product, and Rust makes it 3-5x harder to author augments. The ecosystem won't compound. The I/O-bound workload doesn't benefit. The surgical hybrid (§4) captures the one place where Rust's performance matters without sacrificing everything else.

---

## 8. Decision Record

| Decision | Rationale | Revisit when |
|---|---|---|
| **Stay TypeScript/Bun** | I/O-bound workload; augment interface is the product; dev velocity is load-bearing; npm ecosystem vastly larger | Conditions in §5 materialize |
| **No Rust code in v1** | <5ms kernel work per turn; no measurable bottleneck | Real tokenization needed AND 100+ blocks/turn (v1.0 trigger) |
| **Plan: Rust native tokenizer at v1.0** | The one operation where Rust's 5-10x advantage maps to user-facing latency | Measure first — add timing instrumentation before building |
| **Defer full hybrid evaluation to v1.5+** | Multi-tenant memory footprint may justify WASM kernel; too early to decide | Production data from multi-tenant hosting exists |
| **Never do a full Rust rewrite** | Augment ecosystem won't compound in Rust | The target audience shifts from web developers to systems engineers (possible but unlikely for LORF) |

---

## 9. Sources

- AgentRM (arXiv:2603.13110) — MLFQ scheduling for multi-agent hosting scenario
- AgentCgroup (arXiv:2602.09345) — 56-74% of end-to-end latency is OS-level, not inference; tool-call-granularity resource management
- Blueprint Architecture (Koubaa, TechRxiv 2025) — HRT/SRT/DT latency classes for real-time agent systems
- `tiktoken-rs` — https://github.com/zurawiki/tiktoken-rs — Rust tiktoken implementation
- Bun FFI documentation — https://bun.sh/docs/api/ffi — native module loading from Bun
- `augment-1/docs/research/research-provenance.md` — research foundations that shaped the kernel architecture these performance projections are based on

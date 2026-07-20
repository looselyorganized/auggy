# Memory Layer Architecture — Planning Brief

> **Status:** Historical design brief, resolved 2026-04-23. Current runtime
> behavior is documented in [05-memory-subsystem.md](./05-memory-subsystem.md)
> and [07-built-in-augments.md](./07-built-in-augments.md).
>
> **Owner:** Michael
> **Resolved direction:** Build `layeredMemory` as the peer-scoped episodic
> memory layer first, with identity remaining operator-authored and immutable.
> **Scope:** Large — multi-session design + implementation project
>
> **Current-state note:** This brief preserves the problem statement that led
> to `layeredMemory`. Some "current" gaps below have since changed: the memory
> bus now has structural trust gates and `memory_forget`; `layeredMemory`
> provides peer-scoped episodic memory. The experimental mutable agent-global
> behavior store described below was subsequently removed from the scaffold
> and runtime conventions; it remains here only as historical context.

## The Problem

At the time this brief was written, Auggy's memory model was two-tier and ad
hoc:

| Tier | Provider | What it holds | Mutability | Placement |
|------|----------|---------------|------------|-----------|
| `fileMemory` (identity) | Static file | Agent identity, operator-authored rules | Immutable | system (preamble) |
| `fileMemory` (learned) | Static file | Agent self-notes from earlier turns | Mutable | context (demoted from preamble in Layer 1) |
| `supabaseMemory` (episodic) | Supabase namespace | Episodic entries from conversations | Mutable | context |

There's no principled hierarchy, no promotion/demotion rules, no per-layer trust gating, and no consolidation pipeline. Consequences:

1. **No memory-write trust gating.** Layer 1 deferred memory-bus `perTrustLevel` defaults because we couldn't answer "which writes should public peers be allowed to do?" without a label taxonomy. At the time, any peer could write to any label — the 2026-04-14 red-team incident ("visitor told Zip to remember him as the creator") was the canonical example.

2. **No consolidation.** Episodic entries accumulate without synthesis. No path from raw conversation facts → structured knowledge → identity-adjacent context. Mason's "Missing Memory Hierarchy" paper identifies this as the core gap in current agent memory systems.

3. **Conversation compaction is a hack.** The `compactionStrategy: "summarize"` placeholder compresses history by burning tokens on LLM summarization. This is a compression hack — the real solution is extracting key facts into structured memory and letting history truncate naturally. But that requires the hierarchy to exist.

4. **No peer-scoped retrieval.** `memory_search` returns entries from all peers. Visitor A's claims about visitor B can surface in visitor B's conversation. Cross-peer contamination is a known gap from the Layer 1 adversarial review.

5. **Mutable learned behavior placement was a security finding.** Codex adversarial review found that mutable learned behavior files loaded as privileged preamble/system-adjacent context were a privilege-escalation vector. The durable fix is not "prompt harder"; it is a hierarchy where promotion to high-privilege placement requires explicit consolidation or operator action.

## Research Grounding

| Source | Key insight |
|--------|------------|
| Mason, "The Missing Memory Hierarchy" | Agent memory needs L0 (scratch) → L1 (episodic) → L2 (semantic) → L3 (identity) with explicit promotion rules. Current systems flatten everything into one tier. |
| LORF research-memory-architecture.md | 21-paper survey covering memory consolidation, sycophancy, human-AI interaction. Papers 8-10 on sycophancy inform why memory writes must be structurally gated. |
| ALARA for Agents (arXiv:2603.20380) | Structural enforcement beats prompt-based for tool gating. Extends to memory: structural write gating per layer > prompt-based "don't write untrusted content to identity." |
| Layer 1 session (2026-04-16) | Established `perTrustLevel` on `AugmentConstraints` + `[AGENT-DERIVED]` markers. Memory-bus gating was explicitly deferred pending this hierarchy design. |
| Codex adversarial review | Mutable memory loaded as system-preamble is a privilege-escalation vector. The fix isn't only "demote learned behaviors" — it's "design a hierarchy where promotion to high-privilege placement requires explicit consolidation." |

## Design Directions

### Direction A: Layered memory with promotion rules

Four layers, each with distinct mutability, trust gating, placement, and eviction:

```
L0 — Scratch (per-turn)
  What: Working memory for the current turn. Tool call results, intermediate reasoning.
  Lifetime: Turn-scoped. Evicted at turn end.
  Mutability: Freely writable by the agent during the turn.
  Trust: Any peer's turn can populate it (it's the agent's working space).
  Placement: context, normal priority.

L1 — Episodic (per-conversation / per-peer)
  What: Facts extracted from conversations. "Visitor Alex works at DeepMind on alignment."
  Lifetime: Persistent across turns. Scoped to peer or conversation thread.
  Mutability: Writable by the agent (via memory_write or automatic extraction).
  Trust: Entries tagged with source peer's trust level. [PEER-DERIVED] on retrieval.
  Placement: context, normal priority.
  Retrieval: Peer-scoped by default — visitor A's entries don't surface for visitor B.

L2 — Semantic (consolidated knowledge)
  What: Synthesized facts promoted from L1 via consolidation (LLM or rule-based).
  Lifetime: Persistent. Not peer-scoped — agent-level knowledge.
  Mutability: Written only by the consolidation pipeline, not by direct memory_write.
  Trust: [AGENT-DERIVED]. Cannot override identity (L3).
  Placement: context, high priority.

L3 — Identity (operator-authored)
  What: Agent identity, behavioral rules, org knowledge.
  Lifetime: Permanent. Survives restarts.
  Mutability: Operator-only. Immutable from the agent's perspective.
  Trust: origin: operator. No [AGENT-DERIVED] or [PEER-DERIVED] markers.
  Placement: system (preamble), required priority, eviction: never.
```

**Promotion rules:**
- L0 → L1: Automatic or agent-initiated. Agent extracts facts from the turn and writes to episodic. Could be explicit (`memory_write`) or implicit (a post-turn hook that extracts key facts).
- L1 → L2: Consolidation pipeline. Runs on idle (`onIdle` hook) or on a schedule. LLM summarizes episodic entries into semantic facts. Requires operator approval OR a confidence threshold.
- L2 → L3: Manual only. Operator edits identity files. No automated promotion to identity.
- Demotion: L2 facts can be superseded (new consolidation overrides old). L1 entries can age out (retention policy). L3 is never demoted.

**Memory-write trust gating (deferred from Layer 1):**
- Public peers: can trigger L0 writes (scratch) and L1 writes (episodic,
  tagged with their peer ID and `[PEER-DERIVED]`). Cannot write to L2 or L3.
- Agent/creator peers: can write according to provider policy and current
  runtime gates.
- The agent itself: can write to L0, L1, L2 (via consolidation). Cannot write to L3.

### Direction B: Consolidation-first (skip L0, defer L2)

Start simpler: just L1 (episodic, peer-scoped) + L3 (identity, operator-only). No L0 scratch, no L2 semantic layer. The consolidation pipeline is deferred — episodic entries accumulate without synthesis, but they're peer-scoped and trust-tagged.

This is the minimum that closes the Layer 1 memory gaps:
- Peer-scoped retrieval (visitor A can't see visitor B's entries)
- Trust-tagged entries (`[PEER-DERIVED]` on all visitor-originated episodic entries)
- Identity remains immutable and operator-only

L0 and L2 ship later when the consolidation pipeline is designed.

### Direction C: Conversation compaction as the bridge

Don't redesign the memory architecture. Instead, implement `compactionStrategy: "summarize"` in the kernel (Option A from the earlier discussion — ~50 LOC, model injection into history manager). Use a cheap model (Haiku) for summaries. Conversations get longer without running out of context.

This doesn't solve any of the trust/scoping/consolidation problems but it does solve the immediate "conversations hit context limits" pain point.

**Not recommended as the long-term answer but viable as a bridge if conversations are hitting limits before the hierarchy ships.**

## Open Questions for the Design Session

1. **Consolidation trigger:** When does L1 → L2 happen? On idle? On a schedule? On a token threshold? Does the operator need to approve each consolidation, or is it autonomous with a confidence gate?

2. **Peer-scoped retrieval:** How does `memory_search` know which peer is asking? Does it filter by `peer.id`? What about searches that should cross peer boundaries (e.g., "what do I know about topic X from any conversation")?

3. **Schema changes:** Does `MemoryProviderSpec` need new fields? Does the memory-bus need a layer-aware routing table? Does `memory_write` need a `layer` parameter, or is layer assignment automatic based on the provider?

4. **Provider mapping:** Which existing providers map to which layers? Is `fileMemory` always L3? Is `supabaseMemory` always L1? Or can one provider serve multiple layers?

5. **Retention policy:** How long do L1 entries live? Is there a per-peer cap? A global cap? Time-based expiry? Or unlimited until the operator clears them?

6. **Consolidation model:** Which model runs the consolidation? The agent's primary model (expensive, high quality)? A dedicated cheaper model (Haiku)? A rule-based extractor (no LLM, just heuristics)?

7. **Interaction with Layer 1 trust gating:** Once the hierarchy exists, what are the exact `perTrustLevel` defaults for the memory-bus? Public → can write L1 but not L2/L3? Or public → can't write at all (consolidation pipeline handles L1 writes from conversation history automatically)?

8. **Migration:** How does the current two-tier setup (fileMemory + supabaseMemory) migrate to the hierarchy? Is it a breaking change to agent.yaml, or can it be additive?

9. **Eval coverage:** How do we measure memory quality? Recall accuracy (does the agent remember facts from 10 turns ago)? Contamination resistance (does visitor A's misinformation appear in visitor B's context)? Consolidation quality (does the L2 summary preserve the important facts)?

## What the Design Session Should Produce

1. **Current reference docs** — the layer taxonomy, provider mapping, promotion
   rules, trust gating per layer, and schema changes should be reflected in
   [05-memory-subsystem.md](./05-memory-subsystem.md) and
   [07-built-in-augments.md](./07-built-in-augments.md).
2. **Migration plan** — how current agents transition from two-tier to the hierarchy.
3. **Implementation plan** — phased, probably multi-session: (a) peer-scoped episodic with trust tags, (b) consolidation pipeline, (c) compaction integration, (d) eval coverage.
4. **Decision on Direction A vs B** — full hierarchy vs consolidation-first.
5. **Decision on compaction bridge** — ship `compactionStrategy: "summarize"` as an interim measure, or wait for the hierarchy.

## Related

- `lo/docs/research-memory-architecture.md` — 21-paper survey
- `auggy/docs/05-memory-subsystem.md` — current memory provider contract
- `auggy/src/memory/` — registry, bus, context-synthesis, tools

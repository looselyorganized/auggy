# Design Exploration: The Skill Folder Pattern for Auggy Augments

**Date:** 2026-04-09
**Status:** Design decided, not yet implemented. Requires: filesystem augment (built-in) + skill-loading convention.
**Trigger:** Operator asked whether Auggy agents should use SKILL.md files — the standard adopted by Claude Code, Codex, Gemini, and others.

---

## 0. The Problem

Auggy's typed tools tell the model **what it can call** (name, description, JSON schema) and **how to call it** (validated parameters, execute function). They do NOT tell the model:

- **When** to use this tool vs another
- **Why** this tool exists and what judgment to apply
- **Examples** of good usage (few-shot determinism)
- **Edge cases** and "do NOT" rules
- **Multi-step procedures** that chain tools together
- **Reference material** (API schemas, domain docs) the model might need mid-task

A tool description is 1-2 sentences. A complex capability (facility brain with 5 tools and nuanced retrieval judgment) needs structured teaching that tool descriptions can't carry. Without it, the model guesses — and the quality variance between "model that guesses" and "model that was taught" is the same variance the industry sees between shallow and deep SKILL.md files.

## 1. The Industry Pattern: Skill Folders

The AgentSkills standard (adopted by Claude Code, Codex, Gemini, and others) uses a folder structure:

```
skills/
└── facility-brain/
    ├── SKILL.md          # When/why/how to use this capability
    ├── references/       # Schemas, API docs, config examples
    ├── examples/         # Worked input → output pairs
    └── scripts/          # Multi-step executable procedures
```

The SKILL.md file has YAML frontmatter (name, description, trigger conditions) and a markdown body with usage instructions, examples, and constraints. The supporting directories provide depth that the SKILL.md alone can't carry — few-shot examples for determinism, reference material for accuracy, scripts for complex procedures.

The pattern works because it provides **structured teaching**: not just "here's a tool you can call" but "here's when to call it, here are examples of doing it right, here's what to check if something goes wrong, and here's a script for the common multi-step workflow."

## 2. Why Auggy Was Initially Designed Without Skills

The original reasoning: typed tools with Zod schemas are a better *mechanism* than "read a markdown file, then run a shell command." One hop instead of three, typed instead of prose, validated at runtime. Therefore SKILL.md files are redundant.

**This reasoning was half right.** Typed tools ARE a better mechanism. But mechanism and teaching are different layers:

| Layer | What it provides | SKILL.md | Typed Tool |
|---|---|---|---|
| **Mechanism** — how to invoke | CLI command with arguments | ✗ (prose, ambiguous) | ✓ (Zod schema, validated) |
| **Teaching** — when/why to invoke | Behavioral instructions, judgment criteria | ✓ | ✗ (1-2 sentence description only) |
| **Examples** — few-shot determinism | Worked input → output pairs | ✓ (in /examples or inline) | ✗ |
| **References** — domain knowledge | API schemas, config docs | ✓ (in /references) | ✗ |
| **Procedures** — multi-step workflows | Scripts chaining operations | ✓ (in /scripts) | ✗ (single operation only) |

Typed tools replaced the worst part of SKILL.md (the CLI invocation mechanism) but left the best parts unaddressed (teaching, examples, references, procedures). The result: Auggy agents have better mechanism than Claude Code but worse judgment.

## 3. The Design Decision

**An Auggy augment is: SKILL.md (behavioral teaching) + typed tools (mechanism) + context() (runtime knowledge).**

The skill folder pattern is adopted with modifications for Auggy's augment-based consumption model:

```
augments/
└── facility-brain/
    ├── index.ts          # defineAugment — typed tools + context() loads SKILL.md
    ├── SKILL.md          # behavioral teaching (when/why/how + inline examples)
    ├── references/       # schemas, API docs, config examples
    ├── examples/         # worked input → output pairs
    └── scripts/          # multi-step procedures
```

### How each piece is consumed

| Piece | How Auggy consumes it | When |
|---|---|---|
| **SKILL.md** | Boot-loaded by `onBoot()`, cached, returned as a `ContextBlock` by `context()` | Every turn (from cache) |
| **references/** | Accessible via a tool (e.g. `skill_reference({ name: "api-schema.json" })`) | On demand — model calls when it needs |
| **examples/** | Accessible via a tool or inline in SKILL.md for critical ones | On demand or always (author's choice) |
| **scripts/** | Either inline in SKILL.md as procedure descriptions, or as compound tools in `index.ts` | Depends on complexity |

### The critical difference from Claude Code

Claude Code agents can browse their filesystem — they can `cat references/api-schema.json` anytime. Auggy agents cannot browse by default. **This is why a filesystem augment is required** (see §5). Without it, the augment author must hardcode every file path in `index.ts`, and the SKILL.md can't say "check `references/` for the full spec" because the model has no way to do so.

## 4. Adversarial Findings and Mitigations

An adversarial pass was run against this design. Three significant findings, all with clean mitigations:

### 4.1 Context budget pressure at scale

**Problem:** If 15 augments each load a 1,800-token SKILL.md, that's 27,000 tokens of static teaching competing with dynamic context (memory retrieval, episodic search) that changes per turn. The allocator starts evicting dynamic content to preserve static teaching — exactly backwards.

**Mitigation:** Boot-load and cache SKILL.md content in `onBoot`. Return the cached block from `context()` with `priority: "evictable"`. Static teaching is present when there's room and gracefully yields to dynamic context under budget pressure. The teaching gets internalized by the model over the first few turns of a thread; losing it later is less impactful than losing fresh retrieval results.

### 4.2 Cross-runtime compatibility is partial

**Problem:** A Claude Code SKILL.md teaches `lorf brain recall --query "..."`. An Auggy SKILL.md would reference `brain_recall({ query })`. One file can't concretely teach both invocation syntaxes.

**Mitigation:** Accept that cross-runtime means **portable knowledge, not a portable file**. The behavioral teaching (when to use the brain, what order, what to avoid, domain judgment) transfers across runtimes. The invocation syntax is runtime-specific. The tool name (`brain_recall`) is the shared identifier — both runtimes use the same name, so teaching can reference it abstractly. If you need both a Claude Code skill and an Auggy augment, they share behavioral knowledge but have different mechanism sections.

### 4.3 Two sources of truth for tool behavior

**Problem:** The tool has a `description` field. The SKILL.md also describes the tool. They can drift.

**Mitigation:** Convention — SKILL.md teaches WHEN/WHY (behavioral judgment), tool description states WHAT/HOW (mechanical function). They complement, don't compete. SKILL.md must not restate tool descriptions.

### 4.4 Context ordering (flagged but not significant)

**Finding:** SKILL.md blocks may land far from their tools in the assembled prompt. Frontier models handle this well via the `[AUGMENT CONTEXT: augment-name]` markers already in place. Monitor, don't pre-solve.

## 5. The Filesystem Augment — A Prerequisite

The skill folder pattern requires the model to access files in `references/`, `examples/`, and `scripts/` on demand. Without filesystem access, either:
- The augment author hardcodes every file load in `index.ts` (fragile, inflexible)
- The SKILL.md references files the model can't read (broken teaching)
- All content is inlined into SKILL.md (bloats the file, kills structure)

**A built-in filesystem augment is required.** It should:
- Expose tools: `fs_read(path)`, `fs_write(path, content)`, `fs_list(directory)`
- Be opt-in per agent (not all agents need filesystem access)
- Scope access to the agent's own directory (security boundary — don't expose `/etc/passwd`)
- Ship alongside `fileMemory`, `supabaseMemory`, and `webTransport` as a built-in

```typescript
import { filesystem } from "augment-1";

const fs = filesystem({
  root: "./augments/facility-brain",  // scoped to this directory
  writable: false,                     // read-only by default
});

defineAgent({
  augments: [identity, facilityBrain, fs, webTransport],
}, model);
```

This closes the loop: the SKILL.md can say "check `references/brain-api-schema.json` for the full spec" and the model can actually call `fs_read("references/brain-api-schema.json")` to retrieve it.

### Why this is a built-in, not a user-written augment

Every agent that uses skill folders needs filesystem access. Making each author write their own `fs_read` tool is wasted effort and inconsistent interfaces. A built-in ensures consistent scoping, security boundaries, and tool naming.

## 6. The Loading Strategy

### SKILL.md — boot-loaded, cached, evictable

```typescript
let cachedSkill: string | null = null;

return {
  name: "facility-brain",
  
  onBoot: async () => {
    cachedSkill = await readFile("./SKILL.md", "utf-8");
  },
  
  context: async () => cachedSkill ? [{
    source: "facility-brain",
    content: cachedSkill,
    placement: "preamble",
    provenance: "augment",
    priority: "evictable",      // yields to dynamic content under pressure
    eviction: "drop",
    origin: "operator",
  }] : [],
  
  tools: [
    defineTool({ name: "brain_recall", ... }),
    defineTool({ name: "brain_capture", ... }),
  ],
};
```

### References/examples/scripts — on-demand via filesystem augment

The model reads supporting files only when it needs them, via the filesystem augment's `fs_read` tool. The SKILL.md tells the model what files exist and when to consult them:

```markdown
## References
- `references/brain-api-schema.json` — full API schema for brain_recall parameters
- `references/retrieval-strategies.md` — comparison of keyword vs semantic retrieval

## Examples  
- `examples/recall-project-status.md` — worked example of recalling project state
- `examples/capture-visitor-decision.md` — worked example of capturing a decision

Check these when unsure about parameter format or retrieval strategy.
Don't load them every turn — only when you need the specific detail.
```

The model reads this guidance in the SKILL.md (boot-loaded), and pulls individual files via `fs_read` only when the turn requires it. Context budget stays clean — references are on-demand, not always-loaded.

## 7. When to Include a SKILL.md (Not Every Augment Needs One)

**Include a SKILL.md when:**
- The augment has 3+ tools with non-obvious interaction patterns
- There are judgment calls the model needs guidance on (when tool A vs tool B)
- There are "do NOT" rules that aren't expressible in tool descriptions
- Multi-step workflows exist that chain multiple tools
- Domain-specific examples would improve accuracy

**Skip SKILL.md when:**
- The augment has 1-2 tools with self-explanatory descriptions
- The tool name + description is sufficient teaching (e.g. `memory_read("Read a memory block by label")`)
- No judgment is required — every call is obvious from context

**The rule of thumb:** if you'd tell a new team member "here's what you need to know before using this tool" for more than 30 seconds, it needs a SKILL.md.

## 8. What Needs to Be Built

| Item | Effort | Depends on | Priority |
|---|---|---|---|
| **Filesystem augment** (`src/augments/filesystem.ts`) | ~100 LOC, 1 day | Plan 2 (done) | High — load-bearing for skill pattern |
| **Skill-loading convention in docs** | Documentation | This doc | Medium — convention, not code |
| **`createSkillAugment()` helper** (optional) | ~50 LOC | Filesystem augment | Low — convenience, not required |
| **Update CLAUDE.md with skill folder convention** | Documentation | Convention finalized | Low |
| **Example skill-equipped augment** | 1 day | Filesystem augment | Medium — proves the pattern |

The filesystem augment is the gate. Everything else follows from it.

## 9. The Full Picture

```
An Auggy augment
├── SKILL.md          ← behavioral teaching (WHEN/WHY, loaded at boot)
├── references/       ← domain knowledge (on-demand via filesystem augment)  
├── examples/         ← few-shot determinism (on-demand or inline in SKILL.md)
├── scripts/          ← procedures (compound tools or inline descriptions)
└── index.ts          ← typed tools (WHAT/HOW) + context() + lifecycle hooks
```

- **SKILL.md** provides the judgment the industry's skill standard is built on
- **Typed tools** provide the mechanism that's better than CLI invocation
- **context()** mediates — boot-loads SKILL.md, surfaces it to the model
- **Filesystem augment** enables on-demand access to the supporting directories
- **The model gets both:** the determinism of a well-taught skill AND the precision of typed, validated tools

This is not either/or. It's **skills for judgment, typed tools for mechanism, and the augment as the composition primitive that holds both.**

## Related

- [01-philosophy.md](../01-philosophy.md) — the augment-as-single-primitive design that this pattern builds on
- [07-built-in-augments.md](../07-built-in-augments.md) — the filesystem augment will join fileMemory, supabaseMemory, and webTransport here
- [research/rust-hybrid-analysis-2026-04-09.md](./rust-hybrid-analysis-2026-04-09.md) — §4 discusses when context assembly becomes a bottleneck; SKILL.md loading adds to that budget
- ADR-001 (framework-agnostic) — SKILL.md files are the AgentSkills standard's Layer 3; Auggy's adoption of SKILL.md inside augments maintains compatibility with the broader ecosystem
- ADR-016 (three-protocol stack) — skills teach behavior within a single agent; they don't cross protocol boundaries

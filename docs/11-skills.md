# 11 — Skills

> How Auggy agents learn judgment about their tools. Skills are files the model reads on demand — not code, not boot-loaded context, not augments.

## The three primitives

Auggy agents have exactly three primitives. Understanding where each one starts and stops is load-bearing for working in this codebase.

| Primitive | What it is | Who creates it | When it's active |
|---|---|---|---|
| **Augment** | Composable unit mounted at `defineAgent` time. Provides tools, context, transport, memory, and/or lifecycle hooks. | Operator or augment author (TypeScript) | Always — mounted at boot, participates in every turn |
| **Tool** | A single callable function with a name, Zod schema, and execute function. The model sees it in its tool list. | Augment author (TypeScript, inside an augment) | Every turn — in the model's tool definitions |
| **Skill** | A markdown file on disk that teaches the model when/why/how to use tools. Not code. Not loaded at boot. | Augment author or operator (markdown file) | On demand — the model reads it via `fs_read` when it decides to |

**Augments are infrastructure. Tools are mechanism. Skills are teaching.**

They compose independently:
- Adding a skill doesn't change any augment
- Adding a tool doesn't require a skill
- Adding an augment doesn't require either

The boundary test: if you're unsure where something goes:
- "The model needs to **call** something" → **tool** on an augment
- "The model needs to **know** something every turn" → **context** on an augment
- "The model needs to **learn** when/how to use something" → **skill** (file on disk)
- "The operator wants to **add a capability**" → **augment**

## Progressive disclosure — how skills load

Skills follow a three-level loading model inspired by Claude Code's AgentSkills pattern:

### Level 1: Manifest (always in context, ~100 tokens)

The agent's identity file contains a short list of available skills:

```markdown
## Available skills
Read a skill guide with fs_read when you need guidance on your tools.

- `skills/memory/SKILL.md` — when/how to use memory_read, memory_write, memory_search, memory_list
- `skills/filesystem/SKILL.md` — when/how to use fs_read, fs_write, fs_list, fs_mkdir, fs_remove, fs_search
- `skills/escalation/SKILL.md` — when/how to escalate to the operator
```

The model sees "these skills exist." It does NOT get the full content. Cost: ~100 tokens regardless of how many skills are available.

### Level 2: SKILL.md body (on demand, 2-5K tokens)

When the conversation involves a capability the model wants guidance on, it reads the full skill:

```
Model calls: fs_read("skills/memory/SKILL.md")
Result: the full SKILL.md content enters the tool_result, which goes into history
```

The model now has the behavioral teaching for subsequent turns in this thread. Cost: 2-5K tokens, only when relevant. A turn that doesn't involve memory never loads the memory skill.

### Level 3: References (deeper on demand, variable)

SKILL.md files can reference supporting material:

```markdown
For the full mount permission matrix, see `references/mount-permissions.md`.
```

The model calls `fs_read("skills/filesystem/references/mount-permissions.md")` only if it needs the specific detail. Most turns never go this deep.

### Why progressive disclosure, not boot-loading

The alternative — loading every SKILL.md into context at boot — was evaluated and rejected:

- 15 skills × 1,800 tokens = 27,000 tokens of static teaching on every turn
- Competes with dynamic context (memory retrieval, episodic search) for the token budget
- The allocator evicts dynamic content to preserve static teaching — exactly backwards
- Most turns only need 0-1 skills, not all 15

Progressive disclosure solves this: the model — which has context about the actual conversation — decides what to load. Zero wasted tokens.

## The filesystem augment IS the skill loader

There is no separate skill-loading mechanism. No `createSkillAugment()` helper. No `skills` field on `AgentConfig`. No skill registry. No skill lifecycle.

Skills are files. The filesystem augment serves files. The model reads files via `fs_read`. That's the entire mechanism.

```typescript
// The operator mounts the skills directory as a read-only filesystem mount
filesystem({
  mounts: [
    { name: "skills", path: "./skills", writable: false },
    // ... other mounts ...
  ],
})
```

The agent's identity file lists the available skills (Level 1). The model reads them via `fs_read("skills/...")` when needed (Level 2). The model reads references via `fs_read("skills/.../references/...")` when needed deeper (Level 3).

This is why the filesystem augment is load-bearing for the skill pattern. Without it, the model has no way to read skill files. **If an agent needs skills, it needs the filesystem augment with a read-only mount pointing at the skills directory.**

## The skill folder convention

Each skill lives in its own directory:

```
skills/
├── memory/
│   ├── SKILL.md                 ← the teaching (when/why/how + examples)
│   └── references/
│       └── provider-types.md    ← deep reference (model reads on demand)
│
├── filesystem/
│   ├── SKILL.md
│   └── references/
│       └── mount-permissions.md
│
└── escalation/
    └── SKILL.md                 ← simple skills may not need references/
```

### What goes in a SKILL.md

A good SKILL.md teaches judgment — when to use which tool, with what approach, and what to avoid. It follows the AgentSkills standard format:

```markdown
---
name: memory
description: When/how to use memory_read, memory_write, memory_search, memory_list
---

# Memory Tools

## When to use each tool

| Situation | Tool | Example |
|---|---|---|
| Need specific labeled content | memory_read | `memory_read("self")` for identity |
| Need to find something by content | memory_search | `memory_search("coffee")` for relevant episodes |
| Need to persist something | memory_write | `memory_write("notes", "Visitor likes coffee")` |
| Need to see what's available | memory_list | Check labels before reading |

## Common mistakes

| ❌ Wrong | ✅ Correct |
|----------|-----------|
| memory_search when you know the label | memory_read with the exact label |
| Writing to an immutable label | Check memory_list — immutable labels don't accept writes |
| Searching with very long queries | Keep search queries to key phrases |

## Workflow: remembering visitor preferences

1. Visitor mentions a preference ("I like coffee")
2. Call memory_list to check if "notes" label exists and is writable
3. Call memory_read("notes") to see current notes
4. Call memory_write("notes", existing + new preference)
5. Confirm to visitor: "I'll remember that"
```

### What goes in references/

Supporting material the model consults when it needs depth:
- API schemas
- Configuration format documentation
- Detailed edge-case catalogs
- Worked examples that are too long for the SKILL.md body

Keep references under ~5K tokens each. The model reads them in full via `fs_read`, so oversized reference files waste context.

### What goes in scripts/ (future)

Bash or Python scripts the model can execute for deterministic multi-step procedures. Requires a shell augment (not yet built) to execute. The SKILL.md teaches what the script does and when to run it; the shell augment provides the execution mechanism.

## When to include a SKILL.md

**Include one when:**
- The augment has 3+ tools with non-obvious interaction patterns
- There are judgment calls (when tool A vs tool B)
- There are "do NOT" rules that tool descriptions can't carry
- Multi-step workflows exist that chain tools
- Domain-specific examples would improve accuracy

**Skip when:**
- 1-2 tools with self-explanatory descriptions
- The tool name + description is sufficient (e.g., `memory_read("Read a memory block by label")`)
- No judgment is required

**The rule of thumb:** if you'd explain to a new team member "here's what you need to know before using this" for more than 30 seconds, it needs a SKILL.md.

## What skills are NOT

- **Not augments.** Skills don't provide tools, context, transport, or lifecycle hooks. They're text the model reads.
- **Not code.** Skills don't execute. They teach. (Scripts inside skills ARE code, but they require a shell augment to execute — the skill just describes when to use them.)
- **Not always-loaded context.** Skills are NOT in the system prompt, NOT boot-loaded, NOT returned by `context()`. They're files the model reads on demand.
- **Not required.** An agent can function without any skills. The tools still work — the model just guesses when to use them based on tool descriptions alone.

## How skills interact with history

When the model calls `fs_read("skills/memory/SKILL.md")`, the result is a `tool_result` message in the thread's history. This means:

1. **The skill content persists in history** for subsequent turns in the same thread — the model doesn't need to re-read it every turn
2. **History compaction may evict it** — if the history budget is tight, the compaction strategy may drop the old skill read. The model can re-read it if needed.
3. **Different threads load different skills** — each thread's history is independent, so thread A might have the memory skill loaded while thread B doesn't

This is the right behavior: the skill is available when relevant and naturally yields when the thread's history needs the space for more recent content.

## What you should read next

- [10-system-diagrams.md §1](./10-system-diagrams.md) — the visual diagram of all three primitives
- [07-built-in-augments.md](./07-built-in-augments.md) — the filesystem augment that serves as the skill loader
- [research/skill-folder-pattern-2026-04-09.md](./research/skill-folder-pattern-2026-04-09.md) — the design exploration with adversarial findings

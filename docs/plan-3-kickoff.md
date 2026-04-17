# Plan 3 Kickoff — CLI & Manifest System

> **Status: superseded / historical (2026-04-14).** Plan 3 shipped in v0.1.1 — CLI, manifest, engines, and 3 new augments are all live. This file is kept as the original scoping document; for current state read [`README.md`](./README.md), [`02-architecture-overview.md`](./02-architecture-overview.md), and the project `CLAUDE.md`. Do not treat the "current state" section below as accurate.

**Use this document to brief a new Claude Code session on Plan 3. It contains everything needed to start scoping and building without losing context from prior sessions.**

---

## What Auggy is (30-second version)

Auggy (`augment-1`) is a modular agent runtime in TypeScript/Bun. Agents are composed from swappable **augments** (identity, memory, tools, transports, filesystem). The kernel (~1000 LOC) manages turns — everything domain-specific is an augment. The runtime is portable across organizations — org infrastructure (brain, spine, registry) is just augments the agent mounts.

**Three primitives:** augments (infrastructure), tools (mechanism), skills (teaching via files the model reads on demand).

**Current state:** Plans 1 (kernel) and 2 (built-in augments) are complete. 209 tests, adversarially hardened, proven end-to-end against Claude Sonnet 4.5 via the hello world script. Four built-in augments ship: `fileMemory`, `supabaseMemory`, `webTransport` (AG-UI SSE), `filesystem` (multi-mount, 6 tools).

---

## What Plan 3 is

**The structural gate for operational deployment.** Plan 3 turns Auggy from "write a TypeScript `main.ts`" into "configure a YAML file and run `auggy start`." Every plan after this (spine, chat UI, MCP, evals) depends on it.

**Core deliverables:**
- `auggy create <name>` — scaffold a new agent directory
- `auggy start [--config path]` — start an agent from a config file
- `auggy stop` — graceful shutdown
- `auggy status` — health, augments, model reachability
- Config file format (YAML) — the source of truth for agent composition
- Agent directory convention — where identity, skills, workspace, augments live
- Augment catalog — how augments are discovered and resolved from config names

---

## Files to read before starting

**Read in this order.** Each one adds a layer of context.

### 1. Project rules and code map
**`/Users/bigviking/Documents/github/projects/lo/augment-1/CLAUDE.md`**
The project's own rules, commands, code map, and 10 numbered constraints. Read this first — it's what every session loads.

### 2. The full roadmap with Plan 3's current scope
**`/Users/bigviking/Documents/github/projects/lo/docs/auggy-plans-roadmap.md`**
Search for "## Plan 3" — has the scope, open design questions, dependencies, and what Plan 3 does NOT build. Also read the TL;DR table at the top for the full plan sequence and the LORF-phase mapping.

### 3. Philosophy — why Auggy is shaped the way it is
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/01-philosophy.md`**
The design principles, the portable agent vision (org infrastructure is augments), what we explicitly don't build. Plan 3's config format must preserve these principles — especially "the kernel is finished" and "augments are the single extensibility primitive."

### 4. Skills — how they work and what Plan 3 must support
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/11-skills.md`**
Skills are files the model reads on demand, not boot-loaded context. Plan 3's `auggy create` should generate the `skills/` directory. The config format should NOT have a `skills:` field — skills are a directory convention, not a config concern.

### 5. System diagrams — the visual map
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/10-system-diagrams.md`**
Diagram 3 (Agent Filesystem Layout) is the most relevant for Plan 3 — it shows the directory convention Plan 3 needs to create and manage. Diagram 6 (Codebase Map) shows where new CLI code would live.

### 6. Built-in augments — what the config file needs to wire
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/07-built-in-augments.md`**
Four built-ins with their configuration interfaces: `fileMemory` (label, source, mutable, origin, priority, placement, eviction), `supabaseMemory` (namespace, client, table, mutable, origin, priority, placement, eviction), `webTransport` (port, auth, cors, rateLimitPerPeer), `filesystem` (mounts array with name, path, writable, deletable, maxReadSize, maxWriteSize). The config file format must be able to express all of these.

### 7. Agent lifecycle — what `auggy start` needs to orchestrate
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/08-agent-lifecycle.md`**
The `defineAgent` → `start()` → runtime → `stop()` flow. Plan 3's CLI is the orchestrator that calls this sequence based on the config file.

### 8. Types — the AgentConfig interface the CLI constructs
**`/Users/bigviking/Documents/github/projects/lo/augment-1/src/types.ts`**
Search for `AgentConfig` (line ~422). This is what the CLI must construct from the YAML config: `name`, `purpose`, `model`, `augments[]`, `operators?`, `contextBudget?`, `compactionStrategy?`, `maxInferenceLoops?`.

### 9. The hello world script — the current "main.ts" pattern
**`/Users/bigviking/Documents/github/projects/lo/augment-1/scripts/hello.ts`**
This is what Plan 3 replaces. Instead of this TypeScript composition, the operator writes a YAML config and runs `auggy start`. Study what hello.ts does and how the config file would express the same composition declaratively.

### 10. The three-protocol stack decision
**`/Users/bigviking/Documents/github/projects/lo/docs/solutions/architecture/adr-016-three-protocol-stack.md`**
AG-UI for chat, A2A for agent-to-agent, MCP for tool exposure. Plan 3's config needs to let the operator declare which transports to mount. The three-protocol separation is a hard constraint.

### 11. The portable agent decision
**`/Users/bigviking/Documents/github/projects/lo/docs/solutions/architecture/agent-portable-org-augments-20260409.md`**
Agents plug into orgs by mounting org augments. Plan 3's config should support org-scoped augment groups (e.g., `auggy start --org lorf` selects LORF's augments vs `auggy start --org other`). This is a design question, not a requirement — but it's in scope for Plan 3 to at least consider.

### 12. Research provenance — why decisions were made
**`/Users/bigviking/Documents/github/projects/lo/augment-1/docs/research/research-provenance.md`**
If the session needs to understand WHY a specific architectural choice was made (e.g., "why 25 tools as the threshold?", "why per-augment tool call limits?"), every decision traces back to a specific paper or source here.

---

## Architectural constraints Plan 3 must follow

These are non-negotiable commitments from prior sessions. Each has a source doc:

1. **The kernel is finished.** Plan 3 builds the CLI, not new kernel features. (`docs/01-philosophy.md`)

2. **Augments are the single extensibility primitive.** The config file expresses augment compositions, not framework features. No `skills:` config field, no `brain:` config field — these are augments. (`docs/01-philosophy.md`, critical pattern #5)

3. **Skills are files, not code.** `auggy create` generates a `skills/` directory. The model reads skills on demand via `fs_read`. No boot-loading, no skill registry, no `createSkillAugment()`. (`docs/11-skills.md`, critical pattern #7)

4. **Three primitives are independent.** Augments (infrastructure), tools (mechanism), skills (teaching). Don't conflate them in the config format. (critical pattern #8)

5. **Three-protocol non-overlap.** The config lets the operator mount transports, but AG-UI is for chat, A2A is for agent-to-agent, MCP is for tool exposure. No "unified transport" config. (`adr-016-three-protocol-stack.md`, critical pattern #6)

6. **Org infrastructure is augments.** The config should naturally support multi-org — mounting LORF's spine + brain vs another org's. (`agent-portable-org-augments-20260409.md`, critical pattern #5)

7. **Trust is structural.** The trust model (operator/facility/authenticated/untrusted) is per-peer, per-transport. The config format should let operators declare trust levels on transports. (`docs/01-philosophy.md §4`)

8. **No hardcoded limits.** Unlike OpenClaw's 7-file bootstrap / 20K char cap. `defineAgent({ augments: [...] })` accepts any number. The config format must not introduce artificial limits. (`research-provenance.md §1.12`)

---

## Open design questions for Plan 3

These were flagged in the roadmap but not resolved. The Plan 3 session should make decisions on each:

1. **Config file format.** YAML? TOML? JSON? YAML is the LORF default. Consider: does the config need to express conditional logic (if-else), or is it purely declarative?

2. **Augment resolution.** The config says `fileMemory: { label: "self", source: "./identity.md" }`. How does the CLI resolve the string "fileMemory" to the actual `fileMemory` function? Options: (a) hardcoded built-in map, (b) npm package resolution (`augment-1/file-memory`), (c) local directory scan, (d) explicit import paths in the config.

3. **Engine resolution.** The config says `engine: anthropic` or `engine: { provider: anthropic, model: claude-sonnet-4-5 }`. Same resolution question. The `ModelClient` is the second argument to `defineAgent`.

4. **Agent directory convention.** Diagram 3 in `docs/10-system-diagrams.md` shows the proposed layout. Is this right? Does `auggy create` generate all of it?

5. **Skill manifest generation.** Should `auggy create` auto-generate the skill manifest in the identity file by scanning `skills/*/SKILL.md` frontmatter? Or is it manual?

6. **Shell augment.** Skills that teach bash procedures need a shell execution tool. Should this be a Plan 3 built-in? Scoped commands (allowlist), working directory, timeout.

7. **`auggy deploy`.** How far does Plan 3 go on deployment? Just `auggy start` (local process)? Or also `auggy deploy railway` / `auggy deploy launchd`?

8. **Process management.** Does `auggy start` run in the foreground, or does it daemonize? PID file? Restart on crash? Or defer to systemd/launchd/Docker?

9. **Multi-agent on one machine.** Can `auggy start` run multiple agents from one CLI invocation? Or is it one-agent-per-process with the operator managing multiple processes?

10. **Config validation.** How much validation happens at `auggy start` time? Just YAML syntax? Or full augment compatibility checking (e.g., "filesystem augment required because skills/ directory exists")?

---

## What success looks like for Plan 3

When Plan 3 is done, this should work:

```bash
# Create a new agent
auggy create zip
# → generates zip/ directory with agent.yaml, identity.md, skills/, workspace/

# Edit the config
vim zip/agent.yaml
# → declare name, model, augments, transports

# Write the identity
vim zip/identity.md
# → "You are Zip, the LORF front-door agent..."

# Add skills
vim zip/skills/memory/SKILL.md
# → "When/how to use memory tools..."

# Start the agent
auggy start --config zip/agent.yaml
# → agent boots, transports listen, ready for requests

# Check health
auggy status
# → agent: zip, status: healthy, augments: 5/5 ok, uptime: 3m

# Stop
auggy stop
# → graceful shutdown
```

No TypeScript written. No `main.ts`. No `bun run scripts/hello.ts`. Just config + files + CLI.

---

## What Plan 3 does NOT build

- Augment sandboxing (Plan 8+)
- Hot reloading (Plan 8+)
- Hosted augment catalog with signing (Plan 8+)
- The deploy mechanism for specific targets (Plan 5 covers Railway)
- The spine or any A2A transport (Plan 4)
- The chat UI (Plan 5)
- The eval harness (Plan 7)

---

## How to start the session

1. Read CLAUDE.md
2. Read this kickoff doc
3. Read the Plan 3 section of the roadmap (`lo/docs/auggy-plans-roadmap.md`)
4. Read `docs/11-skills.md` and `docs/10-system-diagrams.md` diagram 3
5. Skim `scripts/hello.ts` to see what the CLI replaces
6. Design the config file format (this is the first decision — everything else follows from it)
7. Build incrementally: config parser → `auggy start` → `auggy create` → `auggy status` → `auggy stop`

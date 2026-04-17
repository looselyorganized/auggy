# Auggy — Backlog

Running list of known bugs, UX issues, and small improvements discovered during real use. Not a roadmap — roadmap lives at `lo/docs/auggy-plans-roadmap.md`. This is the "grab one when you have a spare hour" list.

Format: `- [ ] [category] description (context: where/when found)`

---

## Bugs

- [x] ~~**[engine+transport] Token streaming in Anthropic engine + AG-UI delta events.**~~ — shipped: `messages.stream()` in Anthropic adapter with `onDelta` callback, `text_message_start`/`text_message_delta`/`text_message_end` KernelEvents, AG-UI translator routes deltas 1:1 to `TEXT_MESSAGE_CONTENT`. Turn loop emits start/delta/end with error cleanup (closes stream on error). Non-streaming engines backward compat via existing `text_message` triple.
- [x] ~~**[webTransport] Bun.serve idleTimeout.**~~ — shipped: `idleTimeout: 120` in `Bun.serve()`. Streaming keeps the pipe warm; this is the safety net for long tool executions.

## UX

- [ ] **[CLI]** Scaffold should create `.env` directly instead of `.env.example` + copy step. Two-step copy is friction; users hit "env var missing" errors on first boot.
- [ ] **[CLI]** `aug1 create` from wrong directory (e.g. `platform/`) scaffolds `platform/zip/` without warning. Should detect or ask "create zip here?".
- [ ] **[CLI]** Missing `aug1 remove <name>` command. Today you have to `rm -rf` the directory manually after a failed `aug1 create`.
- [ ] **[CLI]** Env var error messages list missing vars but don't say "add these to your .env" or show the file path.
- [ ] **[CLI]** `aug1 create` — replace the free-text model input with a `select()` dropdown of known models per provider (Claude Sonnet/Opus/Haiku, GPT-5/o3, OpenRouter top models), with "custom" option for typing a model slug. Currently operators have to know the exact model string.

## Polish

- [ ] **[org-context]** Retry-at-boot message says "running without org context" — should also say "lazy retry on first org_fetch" so operator doesn't restart unnecessarily.
- [ ] **[scaffold]** `agent.yaml` comments could include engine provider options (currently only shows anthropic as the default).

## Post-ship augments (separate roadmap entries, captured here for cross-reference)

- [x] ~~bashAugment~~ — shipped: `bash` augment with risk presets (scripts-only / restricted / standard / unrestricted), Layer 1 trust gating, named scripts, env sanitization. See `src/augments/bash.ts`.
- [ ] hooksAugment — PreToolUse/PostToolUse with Claw's exit-code contract
- [ ] compactHistory — LLM-summarize variant of compaction
- [ ] projectInstructions — AUGGY.md ancestor walk pattern
- [ ] Permission-mode ladder in agent.yaml
- [ ] researchAugment — web search + arxiv + document analysis for agents that need to look things up. Could wrap Brave/Tavily/Firecrawl; tools: `research_search`, `research_fetch_paper`, `research_summarize`. Progressive disclosure pattern.

## Aspirational (Plan 8+ / v2.0 Progressive Autonomy)

- [ ] **Self-extending agents** — agents can create their own augments and skills. Tools: `augment_create` (writes `.ts` file to `augments/` directory), `skill_create` (writes `SKILL.md`), `augment_install` (adds to agent.yaml, triggers restart). Blocks on: (1) hot-reload (Plan 8+ — today restart is required), (2) sandboxing to prevent escape (V8 isolates or similar), (3) operator approval flow for self-generated code (Layer 3 trust), (4) evals to measure whether self-generated augments actually improve agent quality (Plan 7). Significant feature — don't underestimate. Connects directly to v2.0 "Progressive Autonomy" in the LORF roadmap. Should be gated behind operator trust and a clear approval UX. Research: see `augment-1/docs/research/skill-folder-pattern-2026-04-09.md` for the self-authoring skill pattern.

---

When you fix something, remove the line. When you discover something, add it. If an item grows into a real project, move it to the roadmap.

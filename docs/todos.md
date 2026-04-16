# Auggy — Backlog

Running list of known bugs, UX issues, and small improvements discovered during real use. Not a roadmap — roadmap lives at `lo/docs/auggy-plans-roadmap.md`. This is the "grab one when you have a spare hour" list.

Format: `- [ ] [category] description (context: where/when found)`

---

## Bugs

- [ ] **[engine+transport] FAST-FOLLOW: Token streaming in Anthropic engine + AG-UI delta events.** Two symptoms, one root cause. (a) Model response renders all at once in the ChatWidget, not token-by-token. (b) "Stream interrupted: network error" mid-turn after a tool call completes (e.g. `org_fetch done` → cut before the final text streams). Root cause: `src/engines/anthropic.ts` calls `messages.create()` non-streaming; kernel waits for the full response then emits one `text_message` event; the SSE pipe carries that single chunk and sometimes hits proxy/keepalive timeout during the 5-15s model wait (correlates with the Bun.serve idleTimeout bug below). NOT a Layer 1 regression — pre-existing v0.1.0 gap; the milestone doc's "true streaming" referred to transport-layer ReadableStream (works), not model-side token streaming (absent). Fix touches four layers: (1) engine adapter → `messages.stream()` yielding content-block deltas including tool_use arg deltas; (2) kernel event types in `src/types.ts` → add `text_message_delta` / `tool_call_args_delta` variants, preserve `text_message` as the closed/final event for history; (3) AG-UI translator in `src/transports/ag-ui-events.ts` → map deltas to AG-UI `TEXT_MESSAGE_CONTENT` (partial) + `TEXT_MESSAGE_END` (close); (4) turn loop → emit deltas as they arrive, accumulate for history without blocking. Estimate 200-400 LOC + tests. Eval-suite interaction: deltas don't change grader outcomes (final text is identical once assembled) but DO affect `TurnTrace.inferenceSteps` latency metrics — streaming should improve time-to-first-token sharply while total turn latency is unchanged. Sequencing: wait for `security-eval-suite-auggy` to land first so we have regression coverage before touching the inference path. Out of scope: reasoning-block streaming (extended-thinking deltas), OpenAI / OpenRouter engine streaming (port the pattern after Anthropic lands; different delta shapes), retry-on-mid-stream-disconnect.
- [ ] **[webTransport]** `[Bun.serve]: request timed out after 10 seconds. Pass idleTimeout to configure.` — observed when calling a slow upstream (Railway cold start). Bun's default server idleTimeout is 10s; some `agent_run` turns legitimately exceed that. Fix: pass `idleTimeout` to `Bun.serve` in `src/transports/web-transport.ts`, probably 120s to match the proxy timeout. Note: this is the SAME timeout that makes the streaming bug above surface as "Stream interrupted" — fixing streaming makes this less acute but `idleTimeout` should still be bumped.

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

- [ ] bashAugment — scoped shell execution with allowlist + timeout
- [ ] hooksAugment — PreToolUse/PostToolUse with Claw's exit-code contract
- [ ] compactHistory — LLM-summarize variant of compaction
- [ ] projectInstructions — AUGGY.md ancestor walk pattern
- [ ] Permission-mode ladder in agent.yaml
- [ ] researchAugment — web search + arxiv + document analysis for agents that need to look things up. Could wrap Brave/Tavily/Firecrawl; tools: `research_search`, `research_fetch_paper`, `research_summarize`. Progressive disclosure pattern.

## Aspirational (Plan 8+ / v2.0 Progressive Autonomy)

- [ ] **Self-extending agents** — agents can create their own augments and skills. Tools: `augment_create` (writes `.ts` file to `augments/` directory), `skill_create` (writes `SKILL.md`), `augment_install` (adds to agent.yaml, triggers restart). Blocks on: (1) hot-reload (Plan 8+ — today restart is required), (2) sandboxing to prevent escape (V8 isolates or similar), (3) operator approval flow for self-generated code (Layer 3 trust), (4) evals to measure whether self-generated augments actually improve agent quality (Plan 7). Significant feature — don't underestimate. Connects directly to v2.0 "Progressive Autonomy" in the LORF roadmap. Should be gated behind operator trust and a clear approval UX. Research: see `augment-1/docs/research/skill-folder-pattern-2026-04-09.md` for the self-authoring skill pattern.

---

When you fix something, remove the line. When you discover something, add it. If an item grows into a real project, move it to the roadmap.

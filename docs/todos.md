# Auggy — Backlog

Running list of known bugs, UX issues, and small improvements discovered during real use. Not a roadmap — roadmap lives at `lo/docs/auggy-plans-detail.md`. This is the "grab one when you have a spare hour" list.

Format: `- [ ] [category] description (context: where/when found)`

---

## Bugs

- [x] ~~**[engine+transport] Token streaming in Anthropic engine + AG-UI delta events.**~~ — shipped: `messages.stream()` in Anthropic adapter with `onDelta` callback, `text_message_start`/`text_message_delta`/`text_message_end` KernelEvents, AG-UI translator routes deltas 1:1 to `TEXT_MESSAGE_CONTENT`. Turn loop emits start/delta/end with error cleanup (closes stream on error). Non-streaming engines backward compat via existing `text_message` triple.
- [x] ~~**[webTransport] Bun.serve idleTimeout.**~~ — shipped: `idleTimeout: 120` in `Bun.serve()`. Streaming keeps the pipe warm; this is the safety net for long tool executions.
- [x] ~~**[notify] Rate limiting + deduplication for outbound escalations.** Prevent operator-attention DoS. Per-peer/session cooldown on `notify` calls, deduplication window for similar summaries, circuit breaker on repeated abuse from the same peer. Tool-level rate limit, not transport-level. Surfaced during red-team session (2026-04-16). Shipped in Phase A (feat/notify-and-telegram-transport): `src/augments/notify.ts` rate-limits per peer with sliding window + dedup key.~~

## UX

- [ ] **[CLI]** Scaffold should create `.env` directly instead of `.env.example` + copy step. Two-step copy is friction; users hit "env var missing" errors on first boot.
- [ ] **[CLI]** `auggy create` from wrong directory (e.g. a sibling project's checkout) scaffolds `<wrong-dir>/<name>/` without warning. Should detect or ask "create here?".
- [ ] **[CLI]** Missing `auggy remove <name>` command. Today you have to `rm -rf` the directory manually after a failed `auggy create`.
- [ ] **[CLI]** Env var error messages list missing vars but don't say "add these to your .env" or show the file path.
- [ ] **[CLI]** `auggy create` — replace the free-text model input with a `select()` dropdown of known models per provider (Claude Sonnet/Opus/Haiku, GPT-5/o3, OpenRouter top models), with "custom" option for typing a model slug. Currently operators have to know the exact model string.

## Polish

- [ ] **[org-context]** Retry-at-boot message says "running without org context" — should also say "lazy retry on first org_fetch" so operator doesn't restart unnecessarily.
- [ ] **[scaffold]** `agent.yaml` comments could include engine provider options (currently only shows anthropic as the default).

## OSS launch — open questions

- [ ] **[docs] How do we document the user-facing API surface?** We don't have an "SDK" per se — `defineAgent`, `defineAugment`, `defineTool` plus the engines is a small surface. The `docs/01-12-*.md` reference set is contributor-facing, not user-facing. Decide between: (a) one `docs/00-api-reference.md` page that lists each public function with signature + one example (cheap, ~1 hour, ships with v0.2 public release), (b) auto-generated TypeDoc reference (medium, half-day), (c) a real docs site (Mintlify / Nextra / Starlight, hosted on a subdomain TBD, ~half-day, defer until v0.3+). Surfaced 2026-04-28 during OSS readiness audit.
- [ ] **[examples] Do we ship `examples/` clone-and-run agent templates?** `scripts/hello.ts` is a one-shot demo, not a starter template. Candidates if we do: `examples/slack-bot/`, `examples/cli-chat/`, `examples/research-agent/`, `examples/coding-agent/`. Cost: each example is a maintained reference that breaks when the API moves. Benefit: answers "how do I X?" before the issue is filed. Decide between: defer until the first issue asks for it, or seed with 2-3 at launch. Surfaced 2026-04-28 during OSS readiness audit.

## Post-ship augments (separate roadmap entries, captured here for cross-reference)

- [x] ~~bashAugment~~ — shipped: `bash` augment with risk presets (scripts-only / restricted / standard / unrestricted), Layer 1 trust gating, named scripts, env sanitization. See `src/augments/bash.ts`.
- [ ] hooksAugment — PreToolUse/PostToolUse with Claw's exit-code contract
- [ ] **Memory Layer Architecture** — L0-L3 hierarchy with promotion rules, per-layer trust gating, consolidation pipeline, peer-scoped retrieval. Supersedes compactHistory (compaction is a bridge, not the architecture). **Planning brief:** [`docs/memory-layer-architecture-brief.md`](./memory-layer-architecture-brief.md). Large multi-session project — design session first.
- [ ] projectInstructions — AUGGY.md ancestor walk pattern
- [ ] Permission-mode ladder in agent.yaml
- [ ] researchAugment — web search + arxiv + document analysis for agents that need to look things up. Could wrap Brave/Tavily/Firecrawl; tools: `research_search`, `research_fetch_paper`, `research_summarize`. Progressive disclosure pattern.

## Aspirational (Plan 8+ / v2.0 Progressive Autonomy)

- [ ] **Self-extending agents** — agents can create their own augments and skills. Tools: `augment_create` (writes `.ts` file to `augments/` directory), `skill_create` (writes `SKILL.md`), `augment_install` (adds to agent.yaml, triggers restart). Blocks on: (1) hot-reload (Plan 8+ — today restart is required), (2) sandboxing to prevent escape (V8 isolates or similar), (3) operator approval flow for self-generated code (Layer 3 trust), (4) evals to measure whether self-generated augments actually improve agent quality (Plan 7). Significant feature — don't underestimate. Connects directly to v2.0 "Progressive Autonomy" in the LORF roadmap. Should be gated behind operator trust and a clear approval UX. Research: see `augment-1/docs/research/skill-folder-pattern-2026-04-09.md` for the self-authoring skill pattern.

---

When you fix something, remove the line. When you discover something, add it. If an item grows into a real project, move it to the roadmap.

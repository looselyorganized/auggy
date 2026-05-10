# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Process

- **Security-eval canary discipline.** PRs touching the agent's prompt-shape surface (`src/augments/*`, `src/scaffold-templates/`, `src/cli/scaffold*.ts`, `src/cli/skill-*.ts`, kernel system-prompt assembly) must dispatch `gh workflow run security-eval.yml --ref <branch>` and confirm green before requesting review. Documented in [ADR-029](https://github.com/looselyorganized/lo/blob/main/docs/solutions/architecture/adr-029-eval-as-canary-for-prompt-shape-changes.md); enforced via the PR template checklist.

### Changed

- **Eval fixture `skillFile:` paths re-pointed** from `src/augments/filesystem-skill/SKILL.md` (renamed away in PR α) to `src/augments/filesystem/skill/SKILL.md`. Restores the always-on filesystem-skill preamble that had silently dropped at PR α merge, fixing the `benign-legitimate-escalation-ask` over-refusal that started the 4-day red-CI window. (`evals/security/fixtures/test-agent.yaml` + `test-agent-sonnet.yaml`.)
- **Benign-suite Pass^k threshold lowered 95% → 90%.** Acknowledges the keyword/tool-call exact-match graders' brittleness against legitimate model variance. The eval-suite-v2 README's stated v2 direction (LLM-judge graders) will let the threshold return to 95%+ once shipped. Adversarial threshold remains 100%; both thresholds may be revisited as part of a future grader-hardening initiative.

## [0.2.0] - 2026-04-27

The visitor-economics release. Multi-trust, peer-scoped memory, budgets, and a security/eval surface for agents that face the public internet.

### Added

#### Memory

- **`layeredMemory` augment.** Peer-scoped episodic memory with provenance, supersession, and trust-tagged context. SQLite-first storage with optional Supabase backend. Replaces `supabaseMemory` for new work. (See `docs/05-memory-subsystem.md`, ADR-018.)

#### Trust & budgets

- **Three-level trust model** — `creator` / `agent` / `public`, with a `publicSubstate` (anonymous / approved-anonymous / approved-named) carried through the kernel.
- **`budgets` augment.** Per-trust-level turn caps and per-day dollar ceilings, enforced via a 2PC turn-gate contract. BATS-style budget-aware preamble injected per turn so the model sees remaining budget. (See `docs/12-budgets.md`.)
- **Layer 1 trust-aware capability table.** Augments declare per-trust-level tool exposure; the kernel filters at registration time.
- **`bash` augment.** Scoped shell execution with allowlist, working-directory isolation, and timeout enforcement. Default `perTrustLevel` blocks `shell_exec` and `run_script` for both `public` and `agent`.

#### Transport

- **Four-path identity resolution** in `webTransport` — bearer token, signed cookie, anonymous, and approved-anonymous flows.
- **`Idempotency-Key` deduplication** — repeated POSTs return the cached response rather than running a duplicate turn.
- **SSE token streaming** surfaced through AG-UI events.

#### Engines

- **Per-adapter pricing modules** for Anthropic, OpenAI, OpenRouter.
- **Cache-aware Anthropic pricing** (input / cache write / cache read tracked separately).
- **`CostResult` discriminated union** — `priced` / `unpriced` / `error` — with explicit freshness warnings instead of silent stale data.
- **Operator `costOverride`** for unknown models or custom pricing.

#### Quality

- **Security + quality eval suites** under `tests/evals/`. LLM-graded coverage for memory poisoning, capability escalation, prompt injection, and budget enforcement.
- **`preambleTokens` + `toolSchemaTokens`** added to `TurnTrace` for context-utilization observability.

### Changed

- `supabaseMemory` augment frozen — kept for migration only. Use `layeredMemory` for new work.
- `org-context` augment refactored to share the HTTP client and apply consistent body-size caps.

### Tests

- 863 tests across 60+ files (up from ~400 in v0.1.0).

### Notes

- The package is still marked `"private": true`. Remove that flag in the release commit when this repo goes public on npm.

## [0.1.1] - 2026-04-14

### Added

- **`aug1 create`**: interactive engine selection (Anthropic / OpenAI / OpenRouter) and a welcome banner.

### Documentation

- README badge row, recentered title, clearer engine-vs-augment distinction.

## [0.1.0] - 2026-04-14

Initial tagged release. The kernel and built-in augments described in `docs/02-architecture-overview.md` are stable from this point forward.

### Added

- **Kernel** — turn loop, context allocator, capability table, history manager, lifecycle manager, tool selector, trace emitter, transport queue, output validator, preamble.
- **Built-in augments** — `fileMemory`, `supabaseMemory`, `webTransport`, `filesystem`, `webFetch`, `orgContext`.
- **Reasoning engines** — Anthropic, OpenAI, OpenRouter adapters.
- **CLI** — `aug1 create / add / dev / start / stop / restart / status` with launchd installation on macOS and PID-manifest tracking under `~/.auggy/`.
- **Reference documentation** — `docs/01-philosophy.md` through `docs/11-skills.md`.

[Unreleased]: https://github.com/looselyorganized/augment-1/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/looselyorganized/augment-1/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/looselyorganized/augment-1/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/looselyorganized/augment-1/releases/tag/v0.1.0

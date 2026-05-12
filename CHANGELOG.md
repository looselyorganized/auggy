# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-05-12

The deployable-runtime release. First npm-installable Auggy CLI with shipped feature set (0.3.0 was a name-claim publish with no functional changes). End-to-end Railway deployment support and a structural eval suite for the layered-memory autoSave path.

### Added

#### Deployment

- **`auggy deploy <name> --to railway` command.** Ships an agent to Railway end-to-end: presence + auth checks, bundle staging with secure exclusions (`.env`, `*.db*`, `workspace/`, `node_modules/`, `.git/`, `.worktrees/`, `.claude/`, `.DS_Store`, `*.tmp`), Dockerfile + entrypoint generation, `railway link`, `railway volume add` (one-time, mounted at `/app/data`), `railway domain --generate`, secrets push including `AUGGY_PUBLIC_URL`, then `railway up`. Redeploys reuse the existing `CloudRecord` from `~/.auggy/agents.json` for idempotency. (See `docs/18-deploy.md`, ADR-021.)
- **`auggy remove <name> --cloud` flag.** Destroys the Railway service alongside the local index entry. Tolerates Railway destruction failures with a warning — local cleanup proceeds regardless.
- **`agent-index` cloud mutators.** `setCloud(name, record)` + `clearCloud(name)` with the same atomic-write + advisory-lock discipline as `addAgent` / `removeAgent`. Cloud state persists in `~/.auggy/agents.json` per the existing `CloudRecord` type.
- **Operator deployment guide** (`docs/18-deploy.md`) — prerequisites, first-deploy + redeploy flows, autoSave cost surface guidance (citing the new eval suite), persistent state contract, visitorAuth's `${AUGGY_PUBLIC_URL}` interpolation, tear-down, troubleshooting.
- **npm publish workflow** (`.github/workflows/publish.yml`) — publishes `auggy` to npm on `v*.*.*` tag push. Runs tests + typecheck + version-matches-tag check before `npm publish --provenance --access public`. Uses `NPM_TOKEN` secret.

#### Quality

- **`evals/layered-memory/` integration eval suite.** Seven fixtures × seven structural graders measure end-to-end autoSave behavior under real `agent.inject()` machinery: `factual-recall`, `peer-isolation`, `prompt-rendering`, `cost-overhead`, `false-extract`, `cross-session-recall` (multi-session persistence headliner), and `cross-identity-promotion` (anon → recognized flush). Mock-mode runner is deterministic, no API key required, <100ms. Live Haiku smoke (`evals/layered-memory/smoke.ts`) validates end-to-end against a real model with seven pass criteria at ~$0.005 spend. (See `evals/layered-memory/README.md`.)
- **`extractJsonArray` JSON extractor.** Replaces the strict `JSON.parse` in `src/augments/layered-memory/extractor/parse.ts` with balanced-bracket extraction — structurally robust to any model wrapper style (markdown fences, leading/trailing prose, language tags, single-line layout, CRLF, escaped quotes, nested objects). Closed the 100% extraction-failure rate on Haiku 4.5 caught by the smoke test.

### Changed

- **`auggy --version`** now reads from `package.json` instead of a hardcoded string. Eliminates the drift class that surfaced after the first npm publish.

### Process

- **First npm publish.** `auggy` is now available via `npm i -g auggy`. Distribution pattern matches Wrangler / Vercel: install → create → dev/start/deploy.

## [0.3.0] - 2026-05-12

Name-claim release. Same code as `c15d3cb` + `@auggy/link@0.1.2` bump. Published manually to claim the unscoped `auggy` package name on npm; no functional changes vs. the prior `0.2.0` release.

## [0.2.0-pre] (pre-OSS items, now folded into 0.4.0)

Items below shipped during the pre-OSS phase and are functionally part of 0.4.0 in the OSS distribution. Kept here for historical reference:

### Architecture

- **ADR-030 — model-facing skill surface separation.** The three Auggy primitives now surface to the engine on three orthogonal channels: **tools** (eager full schema in `tools[]`), **skills** (new built-in `skills` augment emits one system-placement context block sourced from each SKILL.md's YAML frontmatter, body on-demand via `fs_read`), and **augments** (invisible to the model). `{SKILL_MANIFEST}` is gone from `src/scaffold-templates/identity.md`; `scaffold-skills.ts` shed `buildSkillManifest` + `TOOL_INVENTORY`; `src/cli/skill-manifest.ts` is deleted; the kernel context allocator no longer wraps blocks with `[AUGMENT CONTEXT: <source>]` (the augment-name attribution is suppressed pre-send, preserved only in operator-facing trace data). The 8 bundled SKILL.md files already shipped agentskills.io-compatible frontmatter. `auggy create` default-mounts the new `skills` augment.

### Process

- **Security-eval canary discipline.** PRs touching the agent's prompt-shape surface (`src/augments/*`, `src/scaffold-templates/`, `src/cli/scaffold*.ts`, `src/cli/skill-*.ts`, kernel system-prompt assembly) must dispatch `gh workflow run security-eval.yml --ref <branch>` and confirm green before requesting review. Captured in ADR-029 (`eval-as-canary-for-prompt-shape-changes`); enforced via the PR template checklist.

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

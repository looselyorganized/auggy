# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`docs/20-embedding.md` round-3 follow-up** (Pattern B dropped): the embedding doc now covers a single recipe — public visitor chat — because Auggy has exactly one auth concept (the operator bearer in `<agent-dir>/.env`) and no operator-account or framework integration to gate the previously-documented operator-only "Pattern B" proxy. Operator chat lives in `auggy chat` (Local GUI) and `telegramTransport` today, with `/admin` HTTP basic auth landing in G36. Added an operator-channels matrix near the top so adopters who came looking for "how do I chat with my own agent" find the right answer immediately. Also fixed a `decodeURIComponent` crash in the recipe's cookie helper (malformed `auggy-thread` cookies threw `URIError`; now caught and treated as "no cookie" so the proxy mints a fresh threadId instead of returning 500).

- **`docs/20-embedding.md` hardening pass** (codex round-2 follow-up): verify reverse-proxy now uses an explicit header allowlist (only `content-type` forwarded; cookies, authorization, and other frontend-session material stripped); the recipe proxy server-mints `threadId` and binds via signed HttpOnly cookie (browser-supplied threadId is IGNORED — closes the namespace-collision attack we'd documented but not mitigated); the proxy forwards `Idempotency-Key` with accurate docs on what the runtime actually dedups (budget reservations only, NOT turn results — the model is re-called on retry, tools re-execute). New env var `AUGGY_SESSION_SECRET` for the cookie signature (generate via `openssl rand -hex 32`). 3 regression tests added in `tests/integration/embedding-recipe.test.ts` (signed-cookie continuity, tampered-cookie rejection, idempotency truth).

- **`docs/20-embedding.md` — copy-paste recipe** for wiring a Next.js (or any server-rendered) chat surface to a running Auggy agent. Documents the public-visitor-chat flow (no bearer in proxy, `allowAnonymous: true` on agent, visitor-token rotation, visitorAuth upgrade with reverse-proxied verify route). Includes the corrected identity model (clarifies that `x-peer-id` is NOT used for identity), CORS clarification (it's a response-header signal, not an auth gate), cross-origin deployment guidance (reverse-proxy `/visitor-auth/verify` for shared-localStorage handoff), and a hardening checklist covering credential-leak and auth-workaround vectors. Verified end-to-end by `tests/integration/embedding-recipe.test.ts` (8 integration tests proving the documented claims hold against the real transport). (G1 — v1.0 concierge-readiness.)
- **`tests/integration/embedding-recipe.test.ts`** — integration suite that boots a real agent + small inline HTTP proxy and asserts that traffic without a bearer stays in `public/anonymous` → `public/recognized` (NOT creator), that the visitor-token rotation flow works end-to-end, that `x-peer-id` is ignored for identity, that signed-cookie threadId continuity holds, that tampered cookies are rejected, and that malformed `auggy-thread` cookies result in a fresh threadId rather than a 500. Regression guard against future doc changes that drift from the transport contract.
- **`chat/server.ts` malformed-path hardening.** The Local GUI proxy's `/api/chat/<id>` route now catches `URIError` from `decodeURIComponent` and returns 404 instead of surfacing a Bun.serve 500. Regression coverage in `chat/tests/server.test.ts`.
- **G36 design specification updated** in `docs/todos.md`. Operator chat via `/admin` route will use HTTP basic auth with the bearer (`AUGGY_WEB_TOKEN`) as the password (OpenHands-style). Native browser prompt, no framework dependency, no new credential or env var. Spec also pins: per-route rate-limit must be declared explicitly (NOT inherited from `webTransport`'s per-route mechanism), HTTPS mandatory in production (refuses plain HTTP on non-loopback interfaces), operators must configure `webTransport.trustedProxies` on cloud deploys or per-IP limits collapse, and the auth check lives in the admin augment handler (NOT in webTransport core, mirroring visitorAuth's per-route auth-extract pattern). Implementation lands with G36; this PR only updates the design spec.
- **`docs/19-visitor-auth.md`** cross-origin section added — explains why the verify route must be reverse-proxied when frontend and agent are on different origins, and links to `docs/20-embedding.md` for the recipe.

- **`visitorAuth` console-mail-client adapter** (G34 — v1.0 concierge-readiness). OSS adopters who haven't configured AgentMail can now exercise the full magic-link flow by setting `agentMail.transport: "console"` in `agent.yaml`. The console adapter prints the verify URL to the agent's stdout; the operator copies the link to their browser to complete verification. Apart from the delivery path, all visitor-auth semantics are identical (token TTL, single-use consumption, peer-id migration, revocation, `auggy visitors`). Documented at `docs/19-visitor-auth.md#console-mode-for-local-testing`.
- **`visitorAuth.allowConsoleInProduction` option** (default `false`). The console-mode admission gate fires when EITHER `NODE_ENV === "production"` OR `publicUrl` resolves to a publicly-reachable host (anything other than `localhost` / `127.x.x.x` / `10.x.x.x` / `172.16-31.x.x` / `192.168.x.x` / IPv6 loopback / link-local / `*.local`). Either condition rejects at boot — magic links would otherwise leak to runtime logs (Railway / Fly dashboards, log-shipping pipelines) where anyone with log access could harvest them. Operator sets `allowConsoleInProduction: true` to explicitly acknowledge the risk.
- **`visitorAuth` rejects `notifyOnFirstVerify` + `agentMail.transport: "console"`** at boot. The console adapter would silently consume the first-verify ledger entry without delivering the operator alert; subsequent switches to a real mail transport would not replay the missed notification. Either configure AgentMail or remove `notifyOnFirstVerify`.

- **`webTransport.allowAnonymous` option** (G3 — v1.0 concierge-readiness). Gates whether `/agent/run` accepts requests without a bearer token. Resolved at factory time across three precedence levels: explicit yaml value > `AUGGY_ALLOW_ANONYMOUS` env var (strict `"true"` / `"false"` only) > default rule (`process.env.NODE_ENV !== "production"`). Production deploys (Railway/Fly set `NODE_ENV=production`) are bearer-gated by default; local dev permits anonymous chat out of the box. A bearer that is PRESENT but invalid always returns 401 — never a silent downgrade to anonymous. Documented at `docs/06-transports.md#anonymous-posture`.
- **Boot-time operator log line** announcing the resolved `allowAnonymous` value AND its source (yaml / env / default). When `allowAnonymous=true` resolves via default or env AND the `visitor-auth` augment is not mounted, a startup warning fires explaining there is no upgrade path for anonymous visitors. Explicit yaml suppresses the warning (operator has signaled intent).
- **`src/config/resolve.ts` shared helper.** New `resolveConfigBool(yamlValue, envKey, defaultFn)` returns `ConfigResolution<T>` with both the resolved `value` and its `source`. Establishes the codebase pattern for operational settings — future settings (G36 admin dashboard, G37 `auggy config` CLI) plug into this layer.

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

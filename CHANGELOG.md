# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Structural AgentMail inbound provider boundary.** REST catch-up, WebSocket,
  and verified-webhook adapters now share concrete typed contracts and a
  validated canonical message envelope. Provider payloads fail closed on
  malformed IDs, timestamps, inbox substitution, or incoherent threads; no
  legacy `capabilities`/`supports` metadata is used.
- **Durable AgentMail inbound ledger.** Live events and complete REST catch-up
  pages are persisted before dispatch, deduplicated by inbox/message identity,
  and processed through renewable SQLite leases. Catch-up checkpoints advance
  atomically with their page and replay a timestamp overlap after restart;
  stale workers cannot acknowledge a newer claim. Database, WAL, and shared
  memory files are restricted to owner access.
- **Transport readiness phase.** `TransportSpec.ready()` now starts inbound
  listeners only after every mounted transport has registered its kernel
  handle, closing startup races for web, Telegram, Link, and future inbound
  channels.
- **Bounded workspace awareness for filesystem-backed agents.** A configured
  `workspace` mount now contributes a request-ranked, metadata-only file
  catalog to creator and agent turns. The catalog skips hidden paths, excluded
  directories, and symlinks; never auto-loads file contents; and guides the
  model to reuse canonical artifacts through the existing trust-gated
  filesystem tools. Operators can tune or disable it with
  `workspaceAwareness`.

### Removed

- **Redundant augment capability declarations.** Custom augments now describe
  their runtime shape only through concrete fields such as `tools`, `context`,
  `transport`, `memory`, routes, and lifecycle hooks. Remove
  `capabilities: [...]` from augment objects; runtime and console surfaces are
  inferred structurally. Agent Card capabilities, including Link's
  `agentCard.capabilities`, remain separate discovery metadata.

### Fixed

- **Agent startup is rollback-safe and webhook policies fail closed.** Boot,
  route validation, transport registration, and readiness failures now clean
  up attempted resources in reverse order while preserving the original
  error. Signature policies without an implemented verifier now fail startup
  instead of admitting unsigned requests.

## [0.5.0] - 2026-07-07

### Added

- **`auggy augment setup` now handles AgentMail-backed setup recipes.** `auggy augment setup agentMail` provisions/configures the `agentMail` augment itself, while `auggy augment setup visitorAuth` remains the production magic-link email path. Interactive `auggy augment add agentMail` / `visitorAuth` offers setup after local install; scripted and `--yes` flows stay local-only. Setup can reuse existing `.env` AgentMail credentials with `--mode env`, or create a stable inbox using an idempotent AgentMail `clientId`.
- **App-backend route foundation.** Augments can expose deterministic HTTP routes beside `/agent/run`, with route groups, path params, query/body parsing, response helpers, per-route body caps, timeouts, rate limits, schema metadata, route manifests, and OpenAPI export.
- **Generated TypeScript route clients.** `auggy routes [name] --client ts [--target browser|server] [--out file]` emits self-contained clients with typed route-path calls, target-based auth filtering, typed params/query/body inputs, typed success `data` from response schemas, visitor-token handling, external auth assertion forwarding, and fetch-like non-2xx result behavior.
- **Expanded route auth.** Route auth now covers `none`, `bearer`, `creator`, `visitor.optional`, `visitor.required`, and `agent.required`, with resolved route principals and browser/server generated-client filtering.
- **Webhook route policies.** Route policy metadata is preserved in manifests/OpenAPI/generated-client filtering, and `webhook.signature("stripe", ...)` verifies Stripe signatures before route dispatch.
- **Delegated authorization bridge.** Existing app sessions from Supabase, Clerk, Auth0-style, or custom middleware can mint short-lived Auggy external auth assertions. Auggy verifies audience/provider/TTL/signature, supports key rotation, can enforce replay protection with `jti`, and preserves compact external auth claims in route/tool context.
- **Route and tool `requires`.** `visitor.required` routes and protected model tools can require explicit delegated scopes or resource grants. Route resources can bind to path params; tool resources can bind to schema-validated tool input. Roles are preserved as context but do not satisfy authorization by themselves.
- **Delegated auth denial contract and audit hooks.** Route denials return pinned HTTP error bodies, protected-tool denials stay inside the model loop, and sanitized denial events can be observed without leaking them into AG-UI/SSE client output.
- **App-auth bridge example.** `examples/app-auth-bridge` proves a normal app backend verifying Supabase/Clerk-style sessions, minting `x-auggy-auth-assertion`, using a generated browser client, and enforcing route/tool delegated authorization.
- **Concierge route/tool example.** `examples/concierge` demonstrates the v1 app-backend pattern: deterministic routes and model-callable tools over shared domain logic.
- **Feature status index.** `docs/FEATURES.md` now tracks published, on-main, planned, preview, and vision work separately from the release roadmap.
- **0.5 public-preview launch checklist.** Package metadata, support paths, docs
  posture, and release tasks now explicitly support public npm packages while
  the source repository remains private during preview.

### Fixed

- **`auggy create` model refresh now treats saved model cache as fallback, not a stop sign.** If the operator provides a provider API key during create, Auggy attempts a live model refresh even when a saved cache already exists, writes the refreshed cache on success, and falls back to saved models on provider failure. Added `claude-fable-5` pricing so it no longer appears as `pricing unknown`.
- **Railway deploy DX hardened for v1.0.** First deploy now selects a Railway workspace before project/service, saved deploy targets are displayed by workspace/project/service name, plain `auggy deploy` asks before redeploying or retargeting, `auggy deploy --yes` remains the scripted redeploy path, and Railway preflight rejects non-`8080` web ports before a broken 502 deploy reaches Railway.

### Removed

- **`chat/` package deleted.** The standalone Local GUI (separate port 8090, agent picker, BEM CSS) is gone now that every agent serves its own operator surface at `/console`. `auggy chat` already opens `http://<agent>/console/chat` directly (#81). The only piece worth keeping — the AG-UI SSE parser — has been relocated to `admin/src/lib/ag-ui-parse/` (its sole consumer). The `@chat/*` path alias is removed from `admin/tsconfig.json` and `admin/vite.config.ts`. `docs/15-chat.md` is also deleted; the console doc at `docs/21-console.md` is now authoritative.
- **Dead console workbench modules removed.** The preview `/console` bundle now keeps the live Chat, Integrations, diagnostics, theme, toast, and confirmation surfaces only. Older unreachable React tabs for identity, skills, credentials, budget, security, and augments were removed from the admin source tree; backend JSON/action endpoints remain where they are still tested and used by the live dashboard payload.

## [0.4.4] - 2026-05-26

### Added

- **`link` augment gains `peerSource` config** — fetch the peer roster from a remote registry URL instead of hardcoding peers in agent.yaml (#75). The augment fetches `{ peers: [{ name, url, participantId, agentCardUrl? }] }` on boot and refreshes every `cacheSeconds` (default 60). Inline `peers:` block stays supported as a fallback when the registry is unreachable, or for offline dev. Bearers live in environment variables (`LINK_BEARER_<NAME>`, `LINK_INBOUND_BEARER_<NAME>`, `LINK_INBOUND_BEARER_ID_<NAME>`) — never in the registry — so the registry can be hosted on a public URL without leaking secrets. Operator edits the registry; existing agents see the change within `cacheSeconds`.
- **HTTPS-by-default for `peerSource`** — both the source URL and registry-supplied peer URLs must be `https://`. Override `LINK_ALLOW_PLAINTEXT=1` for localhost-dev (same env knob the link library uses for plain-HTTP binding). Closes Codex finding #1 from the adversarial review: prevents a compromised or misconfigured registry from repointing a peer name to a plaintext attacker host while the agent still sends the real bearer.
- **Per-peer skip-not-fail on registry errors** — one misconfigured entry (missing env var, malformed UUID, insecure URL) no longer aborts the whole refresh. Valid entries apply; bad ones are surfaced as `skipped: [{ name, reason }]` and logged. Trust revocations propagate even when an unrelated onboarding entry is broken. Closes Codex finding #2.
- **Fetch timeout + single-flight refresh** — registry fetches now have an abortable 10s timeout (configurable via `requestTimeoutMs`), and concurrent `getPeers()` callers share the in-flight promise so a slow registry can't stampede a degraded dependency. Closes Codex finding #3.
- **`link` augment ships a bundled `skill/SKILL.md`** (#77) — teaches the model when to delegate vs answer directly, choosing the right peer via `link_list`, the **probe-on-pushback** pattern (re-ping the peer with the user's clarification instead of refusing on "no visibility into their tools"), synthesize-don't-echo when relaying replies, failure-mode handling (`unknown peer` / unreachable / refused), and the inbound side (peers are colleagues, not principals). Catalog wires `hasSkill: true` so `auggy create` / `auggy add` install it; `auggy add-skill link` works retroactively. Closes the ADR-025 boot-validator warning.
- **`examples/peer-registry.json`** — reference static-JSON registry the operator can host as-is on Vercel / Railway static / GitHub Pages / S3, or use as a template for a tiny service.

### Fixed

- **`auggy create` writes `.env` directly** (no more "copy from `.env.example`" friction step), and the next-steps output no longer concatenates an empty `envVar` for ollama-local agents (#69). The post-create checklist now lists actual env vars to set instead of relying on `PROVIDER_DEFAULTS`' single hardcoded slot.
- **Catalog auto-mounts bundled skills** + `layeredMemory` flipped to opt-in (#70, ADR-031) — the create wizard scaffolds the skill folder for tool-providing augments automatically, and `layeredMemory` is no longer required by default (fewer external dependencies at first run).
- **`auggy create` wizard: `Esc` restarts** the interactive flow cleanly (no half-built agent dirs) (#74). Ollama option label updated for clarity.

### Architecture

- **Filesystem-as-truth for agent storage** (#73) — refactor of the CLI's agent index: agent directories are the authoritative source, and `~/.auggy/agents.json` becomes a derived index. Removes a class of drift bugs where the index pointed at a moved/deleted agent or missed manually-created ones.
- **Peer-resolver as a separate module** — `src/augments/link/peer-resolver.ts` encapsulates fetch / parse / env-bearer / cache / single-flight; the augment wraps `BearerAuthProvider` + `EnvAddressBook` in delegating implementations whose inner instances swap on refresh, so peer-state changes propagate to inbound auth + outbound routing without restarting the link HTTP server.

### Process

- **Codex adversarial review applied to link peer-directory v1** — three findings (one critical, two high) all closed before merge. The pre-1.0 OSS posture: significant features get an adversarial review pass, not just standard CI.

## [0.4.3] - 2026-05-20

### Added

- **`auggy create` prompts for local-or-remote Ollama** when the operator picks `ollama` as the engine provider. Local (default) wires `http://localhost:11434` with no auth. Remote prompts for a URL, then asks whether the remote requires a bearer token (Ollama Cloud + gated proxies do). When bearer is required, the scaffold drops `OLLAMA_API_KEY=` into `.env.example`.
- **`@auggy/ollama` engine adapter accepts `apiKey?: string`.** When set, forwarded as `Authorization: Bearer <apiKey>` on every Ollama request. Required for Ollama Cloud (ollama.com hosted) and self-hosted Ollama behind bearer-gated proxies. Local Ollama still works with no auth.
- **`engine-resolver` reads `OLLAMA_API_KEY` from env** when present and passes it to the engine adapter. Matches the env-driven pattern of the other providers.

## [0.4.2] - 2026-05-20

### Fixed

- **`auggy create` interactive engine picker now lists `ollama`.** The provider was wired through every other layer (`PROVIDER_DEFAULTS`, `PROVIDER_TO_PACKAGE`, `getModelChoices`, `@auggy/ollama` package on npm) since 0.4.0, but the inquirer prompt in `commands/create.ts` only offered anthropic / openai / openrouter. Operators wanting local-LLM scaffolds had to hand-edit the resulting `agent.yaml`. Now selectable inline as "ollama — local LLM (no API key, runs offline)".

## [0.4.1] - 2026-05-19

Hotfix: a fresh `npm i -g auggy@0.4.0` followed by ANY auggy command (even `auggy --version`) crashed at boot. Root cause: `src/cli/commands/eval.ts` statically imported from `../../../evals/security/run` — a path that pointed OUTSIDE the published tarball (the `files` array shipped `src` only, not `evals/`). Because Commander eagerly imports all subcommands at module load time, the missing `evals/` brought down the entire CLI.

### Fixed

- **`auggy --version` and every other command boot cleanly from npm install.** The eval module loads lazily at action time, and the eval suites themselves moved into a separate `@auggy/evals` workspace package (see *Architecture* below). End users running `auggy create / dev / chat / deploy` see no behavior change; users running `auggy eval` need to `npm i -g @auggy/evals` (the CLI emits a clear install hint if missing).

### Architecture

- **`evals/` → `packages/evals/`** — promoted from a repo-root dev-tools directory into a real workspace package published to npm as `@auggy/evals@0.4.1`. Mirrors the engine-adapter split shipped in 0.4.0: optional, opt-in, version-locked with `auggy` core. The package ships fixtures + graders + harness + runners for the security, auto-save, layered-memory, alara, modularity, and quality suites.
- **`auggy/internal/*` subpath exports** — exposes 10 additional internal paths so the `@auggy/evals` package can import auggy's internals (layered-memory store + extractor, CLI config/engine/augment resolvers, agent/helpers/types) without going through deep relative paths. Same convention as the pre-existing `auggy/internal/cost` etc. Path: `auggy/internal/{agent,helpers,types,cli/*,augments/layeredMemory/**}`.
- **Lazy import in `src/cli/commands/eval.ts`** — replaces the top-level static imports of `evals/security/run` + `evals/auto-save/run` with a `loadEvalsModule()` helper that dynamically imports `@auggy/evals` at action time. Missing-package state surfaces as a clear install hint instead of a module-load crash that takes down `auggy --version`.

### Process

- **`release-rehearsal.yml` gains a tarball-boot CI gate.** When a PR bumps `package.json.version`, CI now packs auggy + every engine package into local tarballs, installs auggy globally into an isolated prefix, and runs `auggy --version` + `auggy --help`. Catches the "import path resolves locally but breaks in the published tarball" class of bug — the exact failure mode 0.4.0 shipped with. Engine packages get their own pack to surface any path drift in scoped packages too.
- **`publish.yml` extended** to publish `@auggy/evals` alongside the engines (engines → evals → core, so the dependency order is satisfied on first install).

## [0.4.0] - 2026-05-19

The /admin-route + npm-engine-split release. Operators can now inspect and tune a running agent from a browser. Engine adapters move out of the core into their own npm packages (`@auggy/anthropic`, `@auggy/openai`, `@auggy/openrouter`, `@auggy/ollama`), all published alongside `auggy` itself.

### Added

#### `/admin` route (G36)

- **Built-in `/admin` route in `webTransport`** — single HTTP surface for the creator to inspect and tune any augment that declares an `adminInfo()` contract. Composable across augments: the route lives in `webTransport` and dispatches; each augment owns its block. HTTP Basic auth with the bearer as the password (no new credential); HTTPS-on-non-loopback gate (426 + SSH-tunnel guidance); per-(actionId, rowKey) CSRF (HMAC-SHA256 over `agentName|ts|actionId|rowKey`, 24h expiry, 60s future-skew tolerance); per-IP rate limit (60/min synthetic route-key `"admin"`); reserved paths block augment routes at `/admin` and under `/admin/*`. Opt-out via `webTransport.adminRoute: false` → 404, no signal that admin exists when disabled. Surface + composition documented at `docs/06-transports.md#the-admin-route-g36`.
- **`adminInfo()` + `adminActions` contract on the `Augment` type.** Augments opt into being dashboarded by returning an `AdminInfoBlock` of section primitives (`keyValue`, `table`, `status`, `eventStream` — the last reserved for the deferred Tier-2 telemetry pipeline). Action handlers live in `adminActions[id]`; the dispatcher coerces form inputs to the declared types, validates CSRF + auth, dispatches, and emits a structured audit log line. Boot-time `buildAdminActionRegistry` validates that every declared action has a matching handler AND that action ids are globally unique across augments.
- **Per-augment `adminInfo()` for 5 augments + 9 admin actions.**
  - `webTransport`: posture KV (allowAnonymous, publicFrontendUrl, port, trustedProxies). Actions: `posture-flip`, `posture-reset`.
  - `budgets`: daily cap + today's spend + per-peer table. Actions: `budget-cap-adjust`, `budget-cap-reset`.
  - `layered-memory`: retention-class counts + 50-most-recent-entries table. Action: `memory-erase` (per-peer row action).
  - `notify`: globalMaxPerHour + cooldown + dispatch ring buffer (last 50). Actions: `notify-test` (bypasses rate-limit + dedup), `notify-cap-adjust`, `notify-cap-reset`.
  - `visitor-auth`: mail transport + verified-visitors table + console-in-prod warning. Action: `visitor-revoke` (per-email row action).
- **`admin-overrides.json` persistence layer.** Three runtime-mutable knobs persist across restart at `<agentDir>/admin-overrides.json` (Zod-validated schema, 0o600 mode, atomic temp+rename + UUID-uniqued temp filename): `webTransport.allowAnonymous`, `budgets.dailyBudgetUsd`, `notify.globalMaxPerHour`. Each augment reads its override at construction time and applies it on top of yaml + env precedence; admin POSTs persist back via `writeOverrides()` BEFORE mutating the closure (S7 ordering — a write failure leaves agent state unchanged).
- **`docs/06-transports.md` operator reference** (~145 lines) for the /admin route — surface, opt-out, auth, HTTPS gate, CSRF model, rate limit, composition, persistence, audit log, reserved paths, operator curl workflow, v1 limits.
- **Per-augment `### Admin info (G36)` paragraphs** under each augment's section in `docs/07-built-in-augments.md`.
- **End-to-end CSRF round-trip integration test** (`tests/transports/admin/integration-csrf-roundtrip.test.ts`). Boots a real agent, parses the `_csrf` token from rendered HTML, POSTs it back to the action endpoint — the test that catches the regression class shipped briefly in the Phase 2 implementation (page-level CSRF token bound to `"__page"` failed validation per-action, returning 403 from every browser form submit).

#### Info endpoint (G2)

- **`GET /` returns an HTML info page when `publicFrontendUrl` is unset.** Replaces the previous 404 with a small unauthenticated response carrying the agent name, a link to `/.well-known/agent-card.json`, and a one-line "this is an Auggy agent backend — POST `/agent/run` or set `publicFrontendUrl`." When `publicFrontendUrl` IS set, GET / returns 302 to that URL (existing behavior preserved). `HEAD /` mirrors GET in both branches (same status code, same headers including `Content-Length` matching the GET body, body omitted) per RFC 9110 §9.3.2. `publicFrontendUrl` is validated once at agent boot — a malformed URL fails fast instead of returning a broken Location header per request.
- **`src/transports/info-page.ts`** — pure HTML renderer with escaped agent name, robots `noindex`, OG/Twitter meta. No CSS framework, no JS — single self-contained HTML response.

#### Ollama engine (G35)

- **`@auggy/ollama` package** — Ollama engine adapter for local LLM runners. No API key required. Drives the agent against a locally-running Ollama server (default `http://localhost:11434`; configurable for remote Ollama). Compatible with tool-capable models (llama3.2, qwen2.5, etc.). Selectable as the `ollama` provider during `auggy create`.

#### Package split

- **Engine adapters moved into separate npm packages**: `@auggy/anthropic`, `@auggy/openai`, `@auggy/openrouter`, `@auggy/ollama`. The auggy core no longer carries SDK dependencies; scaffolded agents declare the engine adapter as a direct dep alongside `auggy` itself. The engine resolver loads adapters via `importFromAgent` against the agent's `node_modules`, so an agent uses the engine version it was scaffolded against.
- **Publish workflow extended** (`publish.yml`) to publish all 5 packages — engines first (so a fresh `npm i -g auggy` followed by `auggy create` resolves engine deps), then core. Per-package version + already-published checks for idempotent retroactive-tag support.

#### Earlier in [Unreleased] (now part of 0.4.0)

- **`docs/20-embedding.md` primitives reference** for wiring a visitor-facing chat surface to a running Auggy agent. Documents the wire contract (POST `/agent/run` with AG-UI SSE response), the identity-path resolution of `webTransport.identify()` (creator / agent / public-recognized / public-anonymous), the visitor-token bootstrap + rotation flow (including TTL expiry semantics), and the visitorAuth verify endpoint. Deliberately ships **no copy-paste recipe** — visitor-side widgets are an adopter-application-layer concern (origin policy, CSRF gates, cookie domain, framework idioms) where Auggy's job is to expose clean primitives, not to ship a security-sensitive integration the adopter is supposed to copy. Replaces the deferred PR #50 "embedding recipe" direction; the recipe doc surfaced four rounds of codex findings about gaps at the adopter-app layer (CSRF / verify-page reverse-proxy / trust boundaries), all of which dissolved by reframing as primitives. Tested by `tests/integration/embedding-primitives.test.ts` (7 tests covering identity paths + visitorAuth upgrade flow + bearer-wins precedence). (G1 — v1.0 concierge-readiness.)
- **`tests/integration/embedding-primitives.test.ts`** — integration suite that boots a real agent and asserts: a valid bearer resolves to `creator` trust with `peer.id === "creator"` (Path 1); a present-but-invalid bearer returns 401 with no silent downgrade to anonymous (security claim about Path 1 failure mode); a request without bearer + bootstrap visitor-token resolves to `public/anonymous` with a fresh token in the response (Path 4); the rotated token resolves to `public/recognized` with a stable `peer.id` (Path 3); the visitorAuth upgrade flow (G34 console adapter) mints a `vis_<uuid>`; `x-peer-id` is ignored for identity regardless of request shape; **valid bearer + stale `x-visitor-token` resolves to creator** (bearer wins over invalid visitor-token; codex round-6 fix). Regression guard against runtime drift from the documented identity-path contract.
- **`webTransport` bearer-precedence fix** (codex round-6 finding) — `Path 1` (creator) now fires when `__bearerValidated && !__visitorPayload`, removing the previous `&& !headers["x-visitor-token"]` clause. Result: a valid bearer alongside a stale or malformed `x-visitor-token` resolves as creator instead of silently demoting to anonymous. The narrow "valid bearer + VALID visitor-token → recognized" case is preserved as an explicit operator-as-visitor opt-in (Path 3 fires because `__visitorPayload` is populated). Closes a real footgun for any future widget that forwards both headers. Doc table in `docs/20-embedding.md` updated; new pinning test in `embedding-primitives.test.ts`.
- **`webTransport` mint-suppression for bearer-credentialed requests** (codex round-6 follow-on, caught by self-adversarial pass) — the visitor-token mint logic at `web-transport.ts:678` previously issued a fresh `vis_<uuid>` in the response header whenever an invalid `x-visitor-token` was sent, regardless of bearer presence. After the bearer-precedence fix above, a bearer-credentialed request that landed on creator (Path 1) was STILL receiving a fresh visitor token in the response. A confused client that round-tripped that token into localStorage and re-sent it would silently demote the operator from creator (Path 1) to recognized (Path 3, via `__visitorPayload` populated by the now-valid token). Added `!hasBearerAttempt` to the mint condition; bearer-credentialed requests no longer receive a fresh visitor token. Closes the creator-to-visitor demotion loop. New assertion in `embedding-primitives.test.ts` test #7.
- **Test-suite refactor (no behavior change)** — 9 sites in `tests/transports/web-transport.test.ts` and 2 sites in `tests/integration/visitor-auth-flow.test.ts` previously relied on the `bearer + stale x-visitor-token → anonymous` runtime convention as a shortcut to test anonymous flows with bearer-admitted requests. These now drop the bearer and rely on `allowAnonymous` defaulting true in the test environment (`NODE_ENV !== "production"`). Cleaner test setup; no production code or test semantics changed.
- **`chat/server.ts` malformed-path hardening.** The Local GUI proxy's `/api/chat/<id>` route now catches `URIError` from `decodeURIComponent` and returns 404 instead of surfacing a Bun.serve 500. Regression coverage in `chat/tests/server.test.ts`. (Extracted from the closed PR #50 branch — durable runtime hardening unrelated to the embedding recipe.)

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
- **`extractJsonArray` JSON extractor.** Replaces the strict `JSON.parse` in `src/augments/layeredMemory/extractor/parse.ts` with balanced-bracket extraction — structurally robust to any model wrapper style (markdown fences, leading/trailing prose, language tags, single-line layout, CRLF, escaped quotes, nested objects). Closed the 100% extraction-failure rate on Haiku 4.5 caught by the smoke test.

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
- `manifest` augment refactored to share the HTTP client and apply consistent body-size caps.

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
- **Built-in augments** — `fileMemory`, `supabaseMemory`, `webTransport`, `filesystem`, `webFetch`, `manifest`.
- **Reasoning engines** — Anthropic, OpenAI, OpenRouter adapters.
- **CLI** — `aug1 create / add / dev / start / stop / restart / status` with launchd installation on macOS and PID-manifest tracking under `~/.auggy/`.
- **Reference documentation** — `docs/01-philosophy.md` through `docs/11-skills.md`.

[Unreleased]: https://github.com/looselyorganized/auggy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/looselyorganized/auggy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/looselyorganized/auggy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/looselyorganized/auggy/releases/tag/v0.1.0

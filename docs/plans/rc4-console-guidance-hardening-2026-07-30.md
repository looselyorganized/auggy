# RC.4 Console and Guidance Hardening Contract

Date: 2026-07-30
Status: normative implementation and acceptance contract
Base: `origin/main` at `d892314`
Branch: `fix/rc4-console-guidance-hardening`
Worktree: `/private/tmp/auggy-rc4-hardening`

## Purpose and release boundary

This plan closes four observed RC.3 failures without including horizontal
replica work:

1. Console traffic can exhaust a shared rate-limit bucket, returning `429` for
   chat, JavaScript, and CSS and leaving a blank page after refresh.
2. Visitor-identity failures can be requested repeatedly during ordinary
   Console lifecycle events.
3. A fresh agent can answer a custom-augment question without reading its
   canonical skill and invent a stale layout and API.
4. The Skills screen exposes content provenance as `bundled`, which users read
   as installation timing.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

- Work MUST remain in this dedicated worktree based on `main`. The dirty
  `production/horizontal-replica-readiness` checkout MUST remain untouched.
- This branch MUST NOT bump versions, tag, publish, or include horizontal
  replica work. RC.4 publication is a separate release step after this fix is
  merged and verified.
- Existing Console component-registry primitives, generated artifacts, and
  Tailwind conventions MUST be reused. No parallel UI system or one-off styling
  primitive may be introduced.
- Every slice starts with a regression that fails for the observed behavior,
  receives a focused adversarial review, passes its focused tests, lint, and
  typecheck, and is committed before the next slice is integrated.

## Traced blast radius

### Console availability and authentication

The outer `admin` limiter in `src/transports/web-transport.ts` currently counts
all `/console*` traffic before routing or authentication. Its bucket therefore
combines login traffic, authenticated APIs, chat, polling, HTML, JavaScript,
and CSS. The Console itself polls dashboard and thread state, so normal use can
consume the bucket without fast typing. Once exhausted, asset requests receive
empty `429` responses instead of their expected MIME types, causing the blank
refresh.

Affected systems include the web transport boundary, login/session/HTTP Basic
authentication, proxy-aware caller IP selection, static asset delivery,
security headers, Console polling, chat, release smoke, and transport tests.

### Visitor identity

The visitor-identity endpoint returns a generic `503` both when no resolver is
configured and when a configured resolver fails. The client does not settle or
back off that state, so remount, focus, CSRF refresh, or dashboard lifecycle
events can repeat requests. This is not the cause of the outer `429`, but it
amplifies Console traffic and obscures the actual configuration state.

Affected systems include the admin route contract, generated/client API types,
the Console provider lifecycle, error presentation, and browser tests.

### Agent guidance

The installed canonical reference already specifies `auggy augment create`,
`augments/<name>/{augment.yaml,index.ts,...}`, and a separate optional
`skills/<name>/SKILL.md`. The observed model answer did not read that reference;
it called only `auggy_self_info` and `auggy_self_catalog`, then invented the old
raw-object API. Current YAML eval tests validate files and metadata, not actual
behavior. The canonical material also needs a complete authorization checklist
covering route authentication, delegated requirements, and per-trust tool
visibility. Self-info currently reports a null runtime version in the packed RC.

Affected systems include the self-inspection tools, starter skill and portable
mirror, reference/templates, skill activation contract, eval fixtures and
parity tests, scaffolded agents, and packed-release behavior.

### Skill provenance

`bundled`, `modified`, and `manual` describe byte provenance in
`admin-skills.ts`; they cannot establish whether a skill existed at scaffold
time or was installed later. The raw internal terms are displayed directly in
the Skills UI and echoed in public documentation. No installation ledger exists,
so the product MUST not imply installation timing.

Affected systems include admin response types, view builders, Skills UI tests,
runtime documentation, and matching auggy-site terminology.

## Slice 1: Regression contracts

Before production changes, focused tests MUST demonstrate these failures:

- More than 60 authenticated Console requests, including dashboard/thread
  polling, MUST NOT prevent subsequent HTML, JavaScript, CSS, API, or chat
  responses.
- Failed password and invalid HTTP Basic attempts MUST still be rate-limited by
  effective caller IP with `Retry-After` and `Cache-Control: no-store`.
- Successful authentication MUST NOT consume a failed-authentication budget.
- An unavailable visitor-identity feature MUST settle instead of being retried
  on focus, remount, or dashboard refresh; transient failure MUST use bounded
  retry behavior.
- Custom-augment guidance MUST reject an augment-local `SKILL.md`, the legacy
  raw-object API, and an authorization-free public route example.
- Skill provenance output MUST use semantic ownership/content terms and MUST
  not claim when a skill was installed.

Acceptance: each test fails for the intended reason on the base commit and is
owned by the subsystem it protects rather than by a screenshot-specific test.

## Slice 2: Console security and availability boundary

- Static assets and successfully authenticated Console traffic MUST NOT share
  a brute-force limiter with failed authentication.
- Password login attempts and invalid HTTP Basic/session authentication MUST be
  rate-limited by effective caller IP. A valid credential/session MUST not be
  penalized by normal polling or asset requests.
- Limiter state MUST be bounded or lazily expired so unique spoofed/untrusted
  caller inputs cannot grow process memory without limit.
- Host, HTTPS/loopback, trusted-proxy, origin, CSRF, body-size, CLI-ticket, and
  session-cookie protections MUST retain their current fail-closed behavior.
- All `429` responses MUST be `no-store`, include a valid `Retry-After`, and
  avoid credential detail.
- Authenticated HTML, fingerprinted JavaScript, and CSS MUST retain exact MIME
  types and security headers after sustained polling, multi-tab use, and reload.
- Release smoke or an equivalent packed-artifact test MUST exercise sustained
  Console traffic before verifying the SPA and its assets.

Acceptance: the sustained-traffic regression passes; invalid credentials are
still throttled; login, session, Basic auth, and CLI ticket tests remain green.

## Slice 3: Visitor-identity resilience

- “Feature not configured” MUST be distinguishable from a transient resolver
  failure without exposing internals.
- The Console MUST treat not-configured as terminal for the mounted session and
  MUST not request again on focus, remount, CSRF refresh, or dashboard polling.
- Transient failures MAY retry only with an explicit bounded policy and MUST
  not form an immediate render/effect loop. Manual retry MAY be exposed using
  existing components if product value justifies it.
- Missing tokens MUST issue zero identity requests. Tokens and resolved
  credentials MUST never be logged, persisted in unsafe browser storage, or
  rendered in errors.
- Authentication and authorization failures MUST remain distinct from service
  availability failures and fail closed.

Acceptance: backend contract tests and fake-timer/component lifecycle tests
prove zero retry amplification while preserving a successful resolution path.

## Slice 4: Canonical self-guidance and authorization

- `auggy_self_info` MUST report the exact running package version in source,
  packed, and installed execution paths.
- A custom-augment recommendation MUST point to the canonical reference and
  exact CLI command and MUST describe the separate runtime and optional skill
  paths.
- Public examples MUST use `defineAugment`, `defineTool`, `defineRoute`, and
  Zod schemas. The legacy raw-object example MUST not remain in a scaffolded or
  agent-readable source.
- Guidance MUST make the three authorization decisions explicit: route caller
  authentication, delegated `requires` scopes/grants, and per-trust tool
  visibility constraints. It MUST not imply that including an auth field alone
  authorizes tools.
- The self-skill MUST require reading the canonical reference before giving
  implementation details and MUST state uncertainty when the read is absent.
- Starter and portable skill mirrors MUST remain byte-identical where parity is
  required; templates, reference docs, eval assertions, and generated fixtures
  MUST change together.
- A cold-agent behavioral check MUST reject: `SKILL.md` inside the augment,
  old APIs, invented installed capability, and an authorization-free privileged
  route.

Acceptance: deterministic unit/parity/eval tests pass, packed smoke observes the
version, and a recorded cold-agent conversation produces the canonical layout,
API, and authorization checklist.

## Slice 5: Semantic skill provenance

- Public API/UI terminology MUST describe what can be proven:
  `Auggy-provided`, `Customized Auggy skill`, or `User-created`.
- Owning augment and installation state MUST remain separate fields/concepts.
  The UI MUST not claim scaffold-time versus later installation.
- Reset/edit/action semantics MUST remain unchanged and be based on actual
  packaged provenance, not the display label.
- Available-but-not-installed skills MUST use the same semantic vocabulary.
- Runtime docs and auggy-site public/machine-readable content MUST align. Site
  work, if required, MUST use its own clean `main` worktree and companion PR.

Acceptance: response contract, view-model, and component tests cover all three
provenance states and an augment added after scaffold is never labeled in a way
that implies it was initially bundled.

## Slice 6: Integration, adversarial review, and PR

The exact final head MUST pass:

- `bun run typecheck`
- `bun run lint`
- tracked runtime and Console test inventory
- `bun run test`
- `cd admin && bun test && bun run build`
- `bun run smoke:release`
- isolated packed installation and Console boot/health/assets/login/chat smoke
- `git diff --check`

The orchestrator MUST then adversarially review:

- failed-password and invalid-Basic brute force, trusted/untrusted proxy IPs,
  stale sessions, CLI-ticket replay, multi-tab polling, and asset reloads;
- unavailable/transient visitor identity and remount/focus behavior;
- stale custom-augment syntax, missing auth decisions, reference-read evidence,
  mirror parity, and runtime-version truthfulness;
- provenance claims across Console, docs, and site.

Each coherent slice MUST be committed with a scoped Conventional Commit. The
final PR MUST state security and compatibility effects, list exact verification
evidence, include Console screenshots when presentation changes, and leave
versioning/publication for a separate RC.4 release PR.

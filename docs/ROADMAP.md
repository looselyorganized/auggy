# Auggy Roadmap

This is the canonical product roadmap. It separates current shipped behavior
from release candidates and future bets. Use [`FEATURES.md`](./FEATURES.md) for
the compact feature/status matrix.

## Release Framing

- **Latest stable release:** `0.5.0`, distributed through npm's `latest` tag.
  It includes the
  app-backend foundation, durable AgentMail inbound/review, the security-audit
  remediation, keyed turn scheduling, Telegram conflict recovery, CI
  test-surface enforcement, and a fail-closed distributed-coordination
  foundation.
- **Immediate release plan:** operate the published `0.5.0` public OSS path,
  prioritize release-blocking regressions and adopter evidence, and ship
  focused `0.5.x` fixes without expanding the supported topology. See the
  [OSS Production Release Plan](./plans/production-readiness-roadmap-2026-07-24.md).
- **Pre-1.0 cadence:** do not jump straight from `0.5.x` to `1.0.0`. Ship useful
  `0.x` releases as the app-backend surface hardens.
- **`1.0.0`:** the OSS GA line. It should mean the docs, examples, release
  process, and first-run/operator experience are defensible, not that every
  strategic feature below exists.

The old "v1.1/v1.2/v1.3" labels are now pre-1.0 candidates. SemVer `1.1+` is
reserved for after `1.0.0`.

The `docs/todos.md` file is the operational backlog for bugs and small polish.
Roadmap features live here. Active implementation plans belong in `docs/plans/`;
completed plans are removed once their durable decisions reach reference docs.

---

## 0.5.0 — OSS Production Preview

Status: **stable public-preview release**.

The release includes:

- Deterministic augment HTTP routes beside `/agent/run`.
- Route groups, exact paths, full-segment path params, query/body parsing,
  response helpers, body caps, timeouts, and per-route rate limits.
- Route schemas for params, query, body, and successful JSON responses.
- Route manifests, OpenAPI export, and route inspection through `auggy routes`.
- Generated TypeScript route clients with browser/server targets, target-based
  auth filtering, typed inputs, typed success data from response schemas,
  visitor-token handling, external auth assertion forwarding, and fetch-like
  non-2xx result behavior.
- Route auth modes: `none`, `bearer`, `creator`, `visitor.optional`,
  `visitor.required`, and `agent.required`.
- Webhook policy metadata and runtime Stripe/Svix signature verification.
- Delegated authorization bridge for Supabase/Clerk/custom app sessions:
  external assertions, explicit scopes/grants, route `requires`, protected-tool
  `requires`, input/param-bound resource grants, key rotation, denial audit
  hooks, and replay protection.
- App-auth bridge example proving generated browser clients, existing app
  sessions, route authorization, and protected tool authorization together.
- Concierge example proving shared route/tool/domain logic.
- `auggy doctor` route posture checks for custom augment routes.
- Portable Auggy builder skill sources and evals for coding-agent guidance.
- Basic `auggy augment create <name>` scaffolding with a typed tool, test, and
  optional skill.
- Provider-native AgentMail reply drafts, WebSocket wake-up, offline message
  catch-up, exact-key connection, and persistent-volume admission.
- Repository-wide security remediation, bounded turn scheduling, Telegram
  conflict recovery, and complete tracked-test inventory enforcement.
- A fail-closed PostgreSQL coordination foundation that remains disabled until
  the complete replica contract exists.

### Immediate reliability work after RC testing

- **Telegram polling latency — completed for RC.12:** safe update intake is
  decoupled from complete model-turn execution while durable replay claims,
  conflict quarantine, bounded scheduling, same-thread ordering, and shutdown
  cancellation remain enforced. The incident and verified boundary are
  captured in [Telegram latency and cross-channel
  context](./plans/telegram-latency-and-cross-channel-context-2026-08-13.md).
- **Cross-channel operational references:** let the same currently verified
  creator resolve bounded recent AgentMail activity from Console or Telegram
  without merging channel transcripts or treating Layered Memory as operation
  truth. This remains the next implementation slice after the transport fix;
  see the same [incident and context plan](./plans/telegram-latency-and-cross-channel-context-2026-08-13.md).
- **Auggy Activity Index:** build a minimized, typed, authorized projection of
  meaningful augment activity backed by transactional producer outboxes. It
  must remain separate from provider/domain truth, audit telemetry, Layered
  Memory, and executable behavior policy. See the adversarially reviewed
  [Activity Index architecture](./plans/activity-index-architecture-2026-08-13.md).

The cross-channel retrieval and Activity Index items are post-`0.5.0`
architecture work, not hidden requirements for the supported RC.12 behavior.

---

## 0.6.0 Candidate — App-Builder DX

Goal: make the app-backend pattern obvious without requiring users to reverse
engineer examples.

- Public installation/distribution UX for the existing Auggy Builder Skill for
  Claude, Codex, Cursor, and similar coding agents.
- `auggy augment create <name> --with-route --with-tool` scaffolds a custom
  augment with a domain function, route wrapper, tool wrapper, schema, tests, and
  env validation.
- Optional scaffold flags for `--with-db`, `--with-admin`, and `--with-webhook`
  once the base route/tool scaffold is boring.
- "Build a custom API augment" guide.
- "Expose the same capability as a route and a tool" guide.
- "Add Postgres to an augment" guide that lets users bring Drizzle, Kysely,
  Prisma, raw SQL, Supabase, or managed Postgres without making Auggy an ORM.
- Storefront/service/intake app templates only if they can stay small and
  maintained.
- Generated-client stability policy after 2-3 real templates survive API churn.

---

## 0.7.0 Candidate — Operator Visibility

Goal: operators can inspect, audit, and debug what an agent is doing without
querying SQLite or reading logs by hand.

- `auggy spend` for budget/spend inspection by trust tier.
- `auggy memory <agent> [--peer X]` for memory audit and erasure verification.
- Route/audit inspector surfaces for delegated authorization denials and route
  posture.
- `auggy notify test <destination>` CLI path, separate from the existing admin
  action.
- `auggy deploy logs <agent>` plus post-deploy health verification.
- Additional `/console` developer surfaces only where CLI output is not enough.

---

## 0.8.0 Candidate — Channel Expansion

Goal: build on the durable AgentMail channel shape without widening the runtime
faster than its audit and recovery model.

- Operational soak and provider-compatibility testing for AgentMail WebSockets,
  durable message catch-up, provider-native drafts, and send reconciliation.
- A verified webhook or provider event-history path if AgentMail exposes the
  message-addressable delivery-lifecycle replay needed for offline recovery.
- Additional webhook verifiers after Stripe and Svix, likely GitHub.
- Provider recipes for common app auth bridges beyond the current Supabase and
  Clerk examples.
- Slack/SMS/voice candidates only after the shipped AgentMail channel shape is
  proven in production.

---

## 0.9.0 Candidate — GA Hardening

Goal: reach `1.0.0` without changing the core product thesis again.

- End-to-end first-run walkthrough: create, run, chat, route, visitor auth,
  memory, notify, generated client, deploy, and recovery paths.
- API reference for the current public framework surface.
- Security/adversarial review pass for browser auth, route exposure, generated
  clients, delegated assertions, webhooks, and deploy posture.
- Public examples verified from a fresh clone.
- Release process, provenance, package boot, and CI checks proven against a
  publish candidate.

---

## 1.0.0 — OSS GA

`1.0.0` should ship when:

- A new developer can understand the product from docs and examples.
- The current public API surface is stable enough to support SemVer.
- App-backend route/client/authz behavior is documented as current runtime, not
  strategy.
- The package release pipeline has already survived at least one pre-1.0
  release after the app-backend foundation.

`1.0.0` does not require the agent mesh, generic app templates, packaged chat
widget, staff auth, or multi-operator identity.

---

## Post-1.0 Candidates

These should be ordered by adopter signal after GA.

- Packaged embeddable chat widget or Web Component.
- API reference site or TypeDoc pipeline if the markdown reference docs stop
  scaling.
- Multi-operator/team auth: per-teammate operator identity, audit attribution,
  scoped console authority, bearer rotation/migration, and clear separation
  from product-facing delegated app users.
- Staff/person auth tier for internal apps if delegated `public.recognized`
  users plus app-minted scopes/grants prove insufficient.
- More cloud deploy targets beyond Railway.
- Cross-augment dependency model if real projects expose silent ordering/version
  problems.
- Hooks augment (`PreToolUse` / `PostToolUse`) with an explicit approval/audit
  model.
- Research augment and other higher-level integration augments.

---

## 2.0+ — Directional Vision

These are not commitments. They are strategic bets that should remain cheap
because the current primitives point in the right direction.

### Agent-to-Agent Mesh

Status: **Coming soon.** Auggy is not currently a production A2A implementation.
The generic payload served from `/.well-known/agent-card.json` is Auggy runtime
metadata, not a current A2A Agent Card, and the `link` augment is a legacy
A2A-v0.2 preview rather than a supported interoperability surface.

The existing `agent` trust tier, agent-shaped route auth, preview peer traffic,
budgets, and A2A-shaped internal types are useful implementation primitives.
They do not constitute protocol compatibility. Agent-to-agent support is ready
to leave "Coming soon" only when all of these acceptance criteria are met:

- Emit a current A2A 1.0 Agent Card with the required schema, supported
  interfaces, task capabilities, and authentication declarations.
- Publish only explicit, sanitized, opt-in capabilities. Internal/model-facing
  tools and operator metadata must never become public by implication.
- Implement authenticated peer discovery and task exchange, including clear
  identity and credential-rotation boundaries.
- Enforce scoped peer permissions, budgets, and durable audit records instead
  of treating every authenticated peer as universally trusted.
- Pass independent protocol-conformance and cross-implementation
  interoperability tests, not only Auggy-to-Auggy tests.
- Provide an explicit migration and removal path for the generic legacy card
  payload and the `link` augment's v0.2 wire format and discovery URL.

### Delegated Human Consent

The current delegated authorization bridge lets an app backend mint explicit
scopes/grants for Auggy. A future consent product lets a human authorize an
outside assistant or another Auggy to act on their behalf with short-lived,
revocable, route-scoped permissions.

### Multi-Agent Facility

Facility/hub products become natural after mesh primitives exist: a front-door
agent routes work to specialized agents, while the operator sees shared audit,
budgets, memory boundaries, and cross-agent handoff state.

### Memory Layer Architecture

The current memory subsystem is useful but not the final long-term memory
architecture. Future work can add layered memory promotion, consolidation,
semantic retrieval, and stronger operator curation and promotion flows.

### Self-Extending Agents

Agents that create augments or skills need hot reload, sandboxing, operator
approval, and evals before they are safe. Keep this as a research direction, not
a near-term launch blocker.

---

## Notes on This Doc

- Do not add shipped items as permanent graveyard entries. Move shipped behavior
  to `FEATURES.md`, current reference docs, examples, and the changelog.
- Promote items across release candidates only when there is adopter signal,
  security need, or a dependency unlock.
- If a roadmap item needs implementation detail, write a plan. Keep this file
  readable enough to answer "where are we?" quickly.

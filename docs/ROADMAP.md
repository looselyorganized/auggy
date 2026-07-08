# Auggy Roadmap

This is the canonical product roadmap. It separates current shipped behavior
from release candidates and future bets. Use [`FEATURES.md`](./FEATURES.md) for
the compact feature/status matrix.

## Release Framing

- **Latest published release:** `0.4.4`.
- **Current `main`:** `0.5.0` release candidate. The app-backend foundation has
  landed on `main` and package metadata is prepared, but it has not yet been
  published to npm.
- **Pre-1.0 cadence:** do not jump straight from `0.4.x` to `1.0.0`. Ship useful
  `0.x` releases as the app-backend surface hardens.
- **`1.0.0`:** the OSS GA line. It should mean the docs, examples, release
  process, and first-run/operator experience are defensible, not that every
  strategic feature below exists.

The old "v1.1/v1.2/v1.3" labels are now pre-1.0 candidates. SemVer `1.1+` is
reserved for after `1.0.0`.

The `docs/todos.md` file is the operational backlog for bugs and small polish.
Roadmap features live here. Implementation plans belong in `docs/plans/` or
`docs/superpowers/plans/`; completed plans should be archived.

---

## 0.5.0 — App-Backend Foundation

Status: **on `main`, package metadata prepared, not yet published**.

What has landed:

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
- Webhook policy metadata and runtime Stripe signature verification.
- Delegated authorization bridge for Supabase/Clerk/custom app sessions:
  external assertions, explicit scopes/grants, route `requires`, protected-tool
  `requires`, input/param-bound resource grants, key rotation, denial audit
  hooks, and replay protection.
- App-auth bridge example proving generated browser clients, existing app
  sessions, route authorization, and protected tool authorization together.
- Concierge example proving shared route/tool/domain logic.
- `auggy doctor` route posture checks for custom augment routes.

Release tasks:

- Publish public npm packages while keeping the source repository private during
  preview.
- Keep npm provenance off and private GitHub repository metadata out of package
  manifests until the source repo is public.
- Run release rehearsal and package boot checks.
- Confirm docs still make shipped, preview, and planned work easy to distinguish.

---

## 0.6.0 Candidate — App-Builder DX

Goal: make the app-backend pattern obvious without requiring users to reverse
engineer examples.

- Auggy Builder Skill for Claude, Codex, Cursor, and similar coding agents:
  an installable companion skill that teaches agents to explain Auggy, scaffold
  projects, create augments, generate route clients, wire app auth safely, and
  run validation. See the
  [Auggy Builder Skill Plan](./plans/auggy-builder-skill-plan.md).
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

## 0.8.0 Candidate — Channels and Provider Hardening

Goal: extend the runtime beyond browser chat while keeping inbound events
auditable and deterministic.

- AgentMail inbound hardening: receive mail as a real inbound channel, catch up
  after downtime, and choose polling/WebSocket/webhook transport based on the
  audit model.
- Additional webhook verifiers after Stripe, likely GitHub and Svix-style HMAC
  providers.
- Provider recipes for common app auth bridges beyond the current Supabase and
  Clerk examples.
- Slack/SMS/voice candidates only after AgentMail proves the inbound channel
  shape.

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
- Multi-operator creator identity and audit attribution.
- Staff/person auth tier for internal apps.
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

Auggy already has an `agent` trust tier, agent-shaped route auth, `link` preview
peer traffic, agent cards, budgets, and A2A-shaped internal types. The long-term
mesh adds peer discovery, signed identity, scoped delegation, per-peer policy,
and budgeted route-backed actions.

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
peer-scoped retrieval, and stronger operator promotion flows.

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

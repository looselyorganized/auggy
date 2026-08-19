# Auggy Roadmap

This is the single source of direction for Auggy. It defines what the project
is for, what `1.0.0` means, and the releases between here and there. When any
other document — plan, ADR, skill, `CLAUDE.md`, changelog prose — disagrees
with this page, this page wins and the other document is stale.

Status snapshot: latest stable is `0.5.0`, published 2026-08-19 (promoted from
`0.5.0-rc.12` plus the Railway console fix, #222).
`docs/todos.md` remains the operational backlog for bugs and small polish;
`docs/FEATURES.md` remains the feature/status matrix.

---

## What Auggy is for

Auggy is a small, self-hosted TypeScript runtime for **one org-facing agent**
that can act on behalf of a business without the model becoming the security
boundary. The runtime — not the model — decides who the caller is, what trust
level they hold, which tools exist, and which actions require confirmation.

The proving use case is a **small-business visitor concierge**: recognize a
returning visitor, remember them, answer from the business's own knowledge,
perform one protected action (look up an order, change an address) behind an
explicit confirmation gate, and escalate to a human when needed. If Auggy does
that end to end, from docs, for someone who is not us, the runtime is doing its
job. Everything else is secondary until that is true.

---

## What `1.0.0` means

`1.0.0` is a **promise plus evidence**, not a feature list. It ships when all
four of these are true:

1. **Stability.** `defineAugment`, `defineTool`, `defineRoute`, the agent
   project layout, the `agent.yaml` schema, the CLI, on-disk storage formats,
   and the health/deploy contract are covered by SemVer, with a written
   deprecation and migration policy that has been exercised at least once.
2. **Evidence.** At least three people outside the project run Auggy; at least one of
   them has filed an issue or PR; and at least one stranger has completed the
   first-run path from the docs alone.
3. **Operability.** Docker and Railway are both supported paths; backup and
   restore have been rehearsed on a real deployment; the security-response
   process in `SECURITY.md` has been exercised at least once.
4. **One complete use case.** The visitor concierge works end to end — visitor
   recognition, memory, knowledge, one protected action with confirmation,
   escalation — with a public demo and docs a new developer can follow.

### What `1.0.0` is not

`1.0.0` does **not** require multi-replica or PostgreSQL coordination, a
workflow engine, the agent mesh, every model provider, every channel, or a
hosted product. Those are demand-driven: they enter the roadmap when a user
asks, not before.

---

## Releases between here and `1.0.0`

Each release has one goal and one exit criterion. A release ships when its exit
criterion is met — not when it feels hardened. Scope is fixed on the day work
starts; anything discovered mid-release goes into the next one.

### 0.5.0 — the runtime (shipped)

The kernel, trust model, built-in augments, app-backend routes and delegated
authorization, durable single-turn jobs, AgentMail, and Railway deploy. Bug
fixes only on `0.5.x`. The per-augment `augment.yaml` authoring layout is
superseded in `0.6.0`.

### 0.6.0 — the tree

**Goal:** a new user scaffolds a project, understands the tree, runs it in
Docker or on Railway, and the docs match.

Release plan with entry conditions, work items, order, and ledger:
[`docs/plans/release-0.6.0-the-tree-2026-08-18.md`](./plans/release-0.6.0-the-tree-2026-08-18.md).

- Central YAML v2 project authoring (one strict `agent.yaml`, `SOUL.md`,
  `AGENTS.md`, TypeScript only for custom augments) and `auggy migrate project`.
  This is the direction recorded in ADR
  `2026-08-16-central-yaml-agent-project-authoring`; the earlier
  TypeScript-project-definition plan is superseded and its worktree is salvage
  only.
- Public docs rewritten for the new layout (site, `llms.txt`, `api-reference.json`,
  README, examples, builder skill).
- Generic Docker path: the existing Dockerfile generator decoupled from the
  Railway volume contract (`AUGGY_DATA_DIR`), exposed to operators.
- `create`/`init` non-interactive flags (`--provider`, `--model`, `--yes`);
  Ollama model selection honors installed models; `augment remove --yes`.
- Metadata honesty: `engines` reflects the Bun runtime requirement; the
  `settings.coordination` startup refusal names its remedy; README CLI table
  matches `auggy --help`.

**Exit criterion:** release smoke green on a fresh machine, including a
scaffolded project that typechecks, boots in Docker, and matches the published
docs.

### 0.7.0 — the visitor

**Goal:** the proving use case is real and visible.

- A deployable visitor-facing chat example (widget or minimal page) wired to
  `/agent/run` with visitor recognition — the reference implementation the docs
  currently decline to ship.
- Embeddings-backed retrieval for `knowledge` (and optionally memory), so a
  real FAQ/catalog works.
- The concierge example completed end to end: recognize → remember → answer →
  protected action with confirmation → escalate.
- Public demo deployment and a "build a visitor concierge in 30 minutes" guide.

**Exit criterion:** a stranger follows the guide and reaches a working,
deployed concierge. Then Auggy is launched publicly.

### 0.8.0 and later — what real users break

Scope is set by the first outside users, not by us. Candidate items are held in
`docs/todos.md` until a user asks. `1.0.0` follows when the four conditions
above are true — there is no fixed version number that becomes `1.0.0`.

---

## Rules

1. **One direction document.** This page. Plans in `docs/plans/` are
   implementation detail for one release and are deleted when it ships. ADRs
   record decisions, not direction.
2. **Scope freezes on day one.** New work goes to the next release.
3. **Exit criteria, not hardening.** A release ships when its criterion is met.
   Release candidates exist to find regressions in the criterion, not to add
   scope.
4. **Integrations use the vendor SDK.** No ground-up protocol clients. One
   user-visible outcome is the definition of done; time-box the work.
5. **Demand-driven breadth.** Providers, channels, deploy targets, and
   coordination are added when someone outside the project asks.

---

## Agent-to-Agent Mesh

Status: **not on the path to 1.0.** Auggy is not a production A2A
implementation. The payload served from `/.well-known/agent-card.json` is
Auggy runtime metadata, not an A2A Agent Card, and the `link` augment is a
preview, not a supported interoperability surface.

The Console's agent-to-agent card stays "coming soon" until all of the
following are met:

- Emit a current A2A Agent Card with the required schema, supported interfaces,
  task capabilities, and authentication declarations.
- Publish only explicit, sanitized, opt-in capabilities; internal tools and
  operator metadata never become public by implication.
- Authenticated peer discovery and task exchange with clear identity and
  credential-rotation boundaries.
- Scoped peer permissions, budgets, and durable audit records.
- Independent protocol-conformance and cross-implementation interoperability
  tests, not only Auggy-to-Auggy.
- An explicit migration and removal path for the legacy card payload and the
  `link` augment's v0.2 wire format.

Longer-range ideas previously listed here — delegated human consent,
multi-agent facility, memory-layer architecture, self-extending agents — are
recorded in git history (`docs/ROADMAP.md` before 2026-08-18). They are not
Auggy roadmap items.

---

## Superseded by this page

- The previous `docs/ROADMAP.md` (0.6–0.9 candidate sequence, post-1.0
  candidates, 2.0+ vision) — see git history.
- The "What remains for 1.0" section of
  `docs/plans/production-readiness-roadmap-2026-07-24.md`.
- The Auggy v1.0 definition in `lo/CLAUDE.md` (now a pointer to this page).
- `docs/plans/typescript-agent-project-definition-migration-2026-08-14.md`
  (superseded by the 2026-08-16 central-YAML ADR).

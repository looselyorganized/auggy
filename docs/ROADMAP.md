# Auggy Roadmap

The prioritized feature list. Three horizons:

- **v1.0** — what blocks the OSS launch. Locked, focused, shipped first.
- **v1.x** — launch polish + features added based on adopter signal after launch. Order will reorder; the items are stable.
- **v2.0+** — directional vision. Not commitments. The shape of the product two horizons out.

The `docs/todos.md` file is the *operational* backlog (bugs, small UX,
polish). Roadmap features live here, not there. If something here grows
to need a spec, the spec goes in `docs/superpowers/specs/` and the
plan in `docs/superpowers/plans/`.

---

## v1.0 — Ship gate

What has to ship for the OSS launch to be defensible. Each item must
be done before v1.0 cuts. Items are not just CLI niceties — they're
the production-readiness story.

- **[walkthrough]** Run end-to-end DX walkthrough — `auggy create → run → chat → visitor-auth → memory → notify → deploy`. Includes error-path coverage, security-eval check, observability spot-check, all surfaces actually used by a fresh operator. *Currently active; the gate everything else defers to.* (G8)
- **[console]** Chat-first `/console` surface. `/console` redirects to `/console/chat`; the first screen is chat plus a compact Details dialog for agent identity, URLs, engine, transport summary, and copy diagnostics. Config/admin tabs are deferred until adopter signal proves they belong in the browser. Per `docs/21-console.md`.
- **[chat]** Minimal info endpoint at `GET /` when no `publicFrontendUrl` is set. Replaces the current 404 with a small HTML response (agent name, public-safe purpose, creator console link, "this is an Auggy agent backend" tagline). (G2 revised)
- **[examples]** `examples/concierge/` — vertical web-channel example (boutique store website chat + stubbed inventory + visitor-auth + notify-to-operator). Demonstrates the augment composition pattern with a concrete domain that maps to the v1.0 thesis. (G7)
- **[deploy]** Verify `auggy deploy <name>` works end-to-end on a fresh adopter machine. Doc the limits, the manual steps that remain, the recovery path on failure.
- **[release-process]** Publish `auggy` v1.0 on npm with notes. Tag the release. Confirm the chat-dist artifact pipeline / admin-dist packaging works in CI for the first GA.

**Note on security-eval expansion:** Deferred to v1.0 ship + post-OSS-launch. The current 10-case eval (from 2026-04-16 red-team) runs nightly as drift monitoring. New eval cases wait for adopter feedback to drive the corpus — writing them against a moving baseline produces constant rewrite cycles.

---

## v1.x — Launch polish + adopter-signal-driven

Items that ship in the weeks after v1.0 launch. **Order is not
committed** — adopter signal reorders the list. Pick the next item
based on which friction got loudest in the first 50 adopters.

### Operator surfaces (CLI + console)

- **[console]** Additional `/console` developer surfaces, driven by adopter signal. Candidates: Memory browser, trace/event inspector, manifest viewer, skills editor, credentials editor.
- **[budgets]** `auggy spend` command — current spend by trust tier from CLI. Today operators query SQLite directly. (G9)
- **[budgets]** Budget-threshold notify integration — fire `notify` at 80% / 100% of `dailyBudgetUsd`. (G10)
- **[memory]** `auggy memory <agent> [--peer X]` — inspect/audit memory entries from CLI. Visually distinguishes agent-derived from creator-confirmed facts. Required for right-to-erasure verification. (G14)
- **[org-context]** `auggy fact <agent> "..."` for adding org-context entries without editing files. (G23)
- **[deploy]** `auggy deploy logs <agent>` + post-deploy `/health = 200` verification. (G25/G26)

### Setup experience

- **[create]** Notify destination prompt inline during `auggy create` (mirror the orgContext conditional-prompts pattern). (G17 revised)
- **[notify]** `auggy notify test <destination>` validator — operator verifies a destination works without triggering the agent. (G19)
- **[setup-experience]** Augment setup wizards — automate cross-system bootstrap. Tiers: (1) trivially automatable (random-hex secrets, agent-name defaults), (2) API-integrated (AgentMail create-inbox, Telegram getMe at setup time), (3) deployment-platform-aware (`RAILWAY_PUBLIC_DOMAIN` auto-derives `AUGGY_PUBLIC_URL`), (4) third-party signups (documented walkthrough only). Per-augment `setup()` hook in the catalog.

### Augments + engine

- **[engines]** Ollama adapter `tool_call.id` preservation for parallel/multi-tool turns. Single-tool-per-turn works today; multi-tool may mis-attribute results. (G35-followup)
- **[observability]** Augment telemetry export pipeline. Generalize `src/kernel/trace-emitter.ts` into a typed event bus. Initial sinks: in-memory ring buffer (consumed by admin SPA event-stream tabs), OTel exporter, Supabase outbox. Event-taxonomy waits for adopter feedback. (~2-3 weeks)
- **[link]** Mesh-vs-tunnel design resolution (npm-bundled mesh vs explicit per-peer config). (G4)
- **[trust]** `staff` (intermediate) trust tier between creator and public. Needed for HVAC-dispatcher-style scenarios. (G13)
- **[creator-identity]** Multi-operator distinguishing — today single shared bearer = single "creator." (G11)

### Console route hardening (G36-followups)

- **[console]** Audit-log rejected POSTs (CSRF failure / unknown action id / input-coercion failure). Currently silent; masks probing.
- **[console]** Reset-action collision uniqueness — make all three registration paths throw on duplicate IDs.
- **[console]** Pre-auth `/console` rate limit splits from post-auth bucket (today shared, vulnerable to NAT-DOS).
- **[console]** Unknown-action POST returns JSON body instead of empty 404.
- **[console]** Tighten `isLoopback` IPv4 regex (`^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$`).

### OSS / community

- **[docs]** API reference surface for `defineAgent` / `defineAugment` / `defineTool` / engines. Decide between (a) one `docs/00-api-reference.md`, (b) auto-generated TypeDoc, (c) a real docs site (Mintlify / Nextra / Starlight). v1.0 ships without; pick mid-v1.x.
- **[examples]** Ship `examples/` clone-and-run agent templates if adopter friction warrants. Candidates: `slack-bot`, `cli-chat`, `research-agent`. Cost: each example is maintained reference that breaks when APIs move.
- **[architecture]** Cross-augment dependency model. visitorAuth + webTransport + layered-memory have coordination gaps today (G36 ADRs cover specifics). Investigate: declared `requires` field on `Augment`? Topological resolver pass? Compatibility matrix? Spec needs to handle silent failures, version skew, circular coupling.

### Embeddable widget

- **[chat-widget]** Publish `@auggy/chat-widget-react` (+ optional `@auggy/next` route helper) and/or a Web Component embed. v1.0 ships primitives reference only (`docs/20-embedding.md`). Packaged widget shape benefits from real adopter feedback (LORF site first). (G1 packaged + G37 ui-kit)

### Augment expansions

- **[hooks]** hooksAugment — PreToolUse/PostToolUse with Claw's exit-code contract.
- **[org-context]** Naming + mode-signal clarity (`baseUrl: file://` default vs catalog description saying "API"). (G21 + G22)
- **[memory]** Row-count cap on layeredMemory entries (today `retentionDays: 90` is time-only). Verify with monitoring before adding. (G15)
- **[deploy]** Other cloud targets beyond Railway (Fly, Render, custom Docker). (G24)
- **[research-augment]** `researchAugment` — web search + arxiv + document analysis. Wraps Brave/Tavily/Firecrawl; tools: `research_search`, `research_fetch_paper`, `research_summarize`. Progressive disclosure pattern.
- **[project-instructions]** `AUGGY.md` ancestor walk pattern (analogous to `CLAUDE.md`).
- **[permission-mode-ladder]** Permission-mode ladder in agent.yaml (extending the trust-tier model with named operator-control modes).

---

## v2.0+ — Aspirational / vision

Where the product goes after v1.0 ships and a few hundred adopters
tell us what they actually use. Not commitments; directional.

The thesis: today's agent landscape has two unbuilt gaps that
auggy's substrate uniquely addresses.

### Inbound from humans across channels

Most LLM-powered agents are pull-mode (visit a chat UI and type) or
programmatic (devs hit APIs). Push-mode from humans via existing
channels (email, Slack DM, Telegram, SMS, voice routing) is rare.
AgentMail-as-startup exists exactly because this gap exists.

Auggy's path: `agentMail` augment (in progress) + `telegramTransport`
(shipped) + future SMS/voice transports = "your agent listens to
your customers on the channels they already use."

### Agent-to-agent mesh inside an org

No major LLM agent stack today supports two Claudes / Codex's / agents
talking to each other inside an org. The "fleet" or "swarm" of
specialized agents that coordinate via handoff is unbuilt. Customer
Support agent → Fraud agent → Finance agent isn't a thing yet because
the auth model, budget bleed problem, discovery, and routing are all
unsolved.

Auggy's substrate uniquely addresses this:

- Trust tiers (`agent` tier exists distinct from `creator`/`public`)
- Per-trust-tier budgets (agent A can't drain B's wallet)
- Visitor-auth substrate extends naturally to agent-identity tickets
- `link` augment + peer-resolver = peer discovery + signed transport
- A2A-shape types already in the kernel

This is the **v2.0 wedge**. Wait for the agents-in-the-wild signal
before building the mesh, but invest now in the primitives (link,
peer-directory, agent-identity) that make it cheap when the time
comes.

### Self-extending agents (Progressive Autonomy)

Agents that create their own augments and skills. Tools:
`augment_create` (writes `.ts` file to `augments/`), `skill_create`
(writes `SKILL.md`), `augment_install` (adds to agent.yaml, triggers
restart). Blocks on:

1. Hot-reload (today restart is required)
2. Sandboxing to prevent escape (V8 isolates or similar)
3. Operator approval flow for self-generated code (Layer 3 trust)
4. Evals to measure whether self-generated augments actually improve
   agent quality

Significant feature. Connects to LORF's v2.0 "Progressive Autonomy"
thesis. Gated behind operator trust + a clear approval UX.

### Memory layer architecture

L0–L3 hierarchy with promotion rules, per-layer trust gating,
consolidation pipeline, peer-scoped retrieval. Supersedes today's
compactHistory (compaction is a bridge, not the architecture). A
multi-session project — design session first. Brief in
`docs/memory-layer-architecture-brief.md` (local-only).

### Native commerce + integration augments

The auggy-as-platform thesis: each major integration is an augment.
Stripe, Calendly, Linear, Slack, GitHub, Notion. Pick 3-5 to ship
excellently; let community contribute the rest.

This is the **commerce wedge**: "your agent + native commerce" —
operators deploying agents that actually book, charge, dispatch.
Highest monetization potential (commerce flows have margin).

### A2A wire compatibility

Auggy's internal types are already A2A-shaped (Part[], TaskState,
AgentCard). When the A2A protocol stabilizes (Google + others), make
the agent card discoverable + the run endpoint A2A-compatible.
Forward-looking bet; adoption timeline unclear.

### Multi-agent facility / hub

LORF-thesis: Zip as the front door to a facility of specialized
agents. Concierge agent at the front door routes to internal agents
(scheduling, fulfillment, support). Cross-agent visibility, shared
operator surface, audit trail across the swarm.

This is downstream of the **agent mesh** primitives above. When mesh
ships, the facility layer becomes a natural product.

---

## Notes on this doc

- Items added in v1.x or v2.0+ require justification (adopter
  signal, strategic bet, dependency unlock). Items added to v1.0
  require the corresponding spec doc (`docs/superpowers/specs/`).
- When an item ships, remove it from this doc. The git history
  remembers; the roadmap shouldn't become a graveyard.
- Reorder within a horizon freely. Order between horizons is
  load-bearing — don't promote items across without justification.

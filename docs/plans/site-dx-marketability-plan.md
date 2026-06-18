# Site DX And Marketability Plan

## Objective

Turn the Auggy site into a developer conversion surface: a visitor should
understand Auggy in 10 seconds, run it in 5 minutes, and see proof that Auggy
can power a real app backend.

## Phase 1: Launch Polish

Scope: 0.5-1 day

- Replace old `looselyorganized/augment-1` links with `looselyorganized/auggy`.
- Align public product naming around **Auggy**. Avoid **Augment-1** except for
  historical or internal context.
- Update homepage/docs metadata to the safer positioning:
  `Bun/TypeScript framework for agent-native app backends`.
- Audit header, footer, mobile nav, Open Graph, sitemap, robots, and docs links.
- Remove or soften brittle model-name claims on the engines page.

Acceptance:

- `rg "augment-1|looselyorganized/augment-1"` only returns intentional
  historical references.
- Every GitHub CTA points to `looselyorganized/auggy`.

## Phase 2: Homepage Conversion Pass

Scope: 1-2 days

Update `augment-1-site/src/app/page.tsx`.

New first viewport:

- Concrete headline.
- Quickstart terminal visible above the fold.
- Short "what you get" output: `/console/chat`, `/console`, `/health`, `/`.
- Primary CTA: "Start building".
- Secondary CTA: "Read the README".

Move the strongest differentiator higher:

- "One capability. Two faces."
- Deterministic route face: app/API/webhook behavior.
- Agent tool face: model-mediated workflow.

Acceptance:

- A developer can answer: what is this, how do I install it, why is it
  different, and what does it boot?

## Phase 3: Docs UX

Scope: 2-4 days

Make `/docs` a real developer landing page, not just a link hub.

Sections:

- Quickstart
- Core concepts: agents, augments, engines, skills, routes, tools
- Guides: add knowledge, add MCP, deploy, custom augment
- Reference: CLI, `agent.yaml`, built-in augments
- Examples
- Security and cost model

Keep `/docs/quickstart` focused on one clean happy path:

```bash
npm i -g auggy
auggy create my-agent
cd my-agent
auggy run
```

Acceptance:

- New users do not need to bounce between site and README to complete first
  run.
- README remains authoritative, but site docs are enough to start.

## Phase 4: Recipes

Scope: 2-3 days

Add a `/recipes` page with 3 developer-targeted use cases:

- Support portal with knowledge and visitor memory.
- Booking/service intake backend with routes and tools.
- Internal operator agent with MCP, notify, and Telegram.

Each recipe:

- What it builds.
- What augments it uses.
- Commands.
- Files created.
- Deploy path.
- Link to example source.

Acceptance:

- Developers see a path from "agent runtime" to an app they might actually
  build.

## Phase 5: Dogfood Auggy On The Site

Scope: 3-6 days

Keep Next.js as the frontend. Add an Auggy backend powering a live docs
assistant.

Auggy agent:

- `knowledge`: README, docs, examples, site copy.
- `webTransport`: `/agent/run`.
- `notify`: alert operator on failed install/deploy questions.
- `mcp`: optional GitHub/npm/docs lookup.
- `visitorAuth`: later, only if useful.
- Provider-side spend cap required.

Site integration:

- Add an "Ask Auggy" widget.
- Add a "Powered by Auggy" section explaining the assistant is an actual Auggy
  agent.
- Link to its config/source as a reference implementation.

Acceptance:

- The site demonstrates Auggy by using Auggy.
- `/console` gives the team operator visibility.
- The assistant can answer install, augment, deploy, and troubleshooting
  questions from local docs.

## Phase 6: Proof And Trust

Scope: 1-2 days

Add developer trust signals:

- Self-hosted by default.
- Secrets stay in `.env`.
- MCP treated as an external trust boundary.
- Provider spend caps recommended.
- Apache-2.0.
- CI/npm/version badges.
- Security policy link.

Add lightweight metrics:

- Clicks on quickstart.
- GitHub clicks.
- Docs assistant questions.
- Failed install/deploy topics via `notify`.

## Recommended Order

1. Link/name cleanup.
2. Homepage conversion.
3. Docs landing + quickstart.
4. Recipes.
5. Live Auggy-powered assistant.
6. Trust/metrics polish.

The dogfooding piece is the strategic unlock. The site should not just describe
Auggy; it should be the smallest convincing Auggy-powered app.

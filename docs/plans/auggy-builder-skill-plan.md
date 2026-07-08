# Auggy Builder Skill Plan

## Goal

Create an installable agent companion skill for Claude, Codex, Cursor, and
similar coding agents so a user can ask their agent to understand, install,
configure, extend, validate, and deploy Auggy without the agent rediscovering
the framework from scratch. The runtime-bundled `skills/auggy/SKILL.md` is the
canonical core of this companion skill; external editor skills should extend
that source rather than fork Auggy's mental model.

The skill should make an agent effective at two jobs:

- **Builder:** scaffold Auggy projects, create augments, add routes/tools,
  generate clients, wire app frontends, and run validation.
- **Explainer:** communicate Auggy's full architecture clearly enough that the
  user understands when to use routes, tools, memory, auth, augments, and
  operator surfaces.

This is an app-builder DX artifact, not a runtime primitive. It should improve
first-run success and reduce misuse of Auggy's architecture.

## Product Position

Name: **Auggy Builder Skill**.

One-line description:

> A companion skill that teaches coding agents how to build agent-native app
> backends with Auggy.

The skill should position Auggy as a TypeScript framework/runtime for
agent-native app backends, not merely an SDK or chat framework.

Core mental model to preserve:

- Use **routes** when software should decide.
- Use **tools** when the agent should mediate.
- Put shared business logic behind both when they belong to one capability.
- Treat auth, authorization, memory trust, route exposure, and operator posture
  as deterministic runtime concerns, not model guesses.

## Package Shape

The portable skill package should be structured for progressive disclosure:

```text
auggy-builder/
  SKILL.md
  agents/
    openai.yaml
  references/
    mental-model.md
    cli-workflows.md
    routes-tools-augments.md
    generated-clients.md
    authz-memory-trust.md
    nextjs-integration.md
    troubleshooting.md
    release-0.5-surface.md
  scripts/
    detect-auggy-env.sh
    summarize-auggy-project.sh
    doctor-and-routes.sh
    generate-route-clients.sh
  assets/
    templates/
      custom-augment/
      nextjs-browser-client/
      nextjs-server-client/
      app-auth-bridge/
```

`SKILL.md` should stay short. It should be generated from or reviewed against
the bundled `src/scaffold-starter-skills/auggy/SKILL.md`, then tell the coding
agent which reference file to read based on the user's task instead of loading
every Auggy concept at once.

Current repo skeleton:

- `src/scaffold-starter-skills/auggy/` is canonical.
- `packages/auggy-builder-skill/auggy/` is the portable package copy.
- `examples/concierge/skills/auggy/` is the dogfooding example copy.
- `tests/skills/auggy-builder-package.test.ts` is the drift guard; update the
  canonical folder first, then resync the mirrors.

## Core Skill Rules

The skill should instruct coding agents to:

1. Detect whether the workspace is the Auggy repo, an Auggy agent project, or an
   app consuming Auggy.
2. Read `agent.yaml`, `package.json`, `.env.example`, existing `augments/`, and
   existing generated clients before editing.
3. Prefer Auggy CLI commands over hand-editing generated or scaffolded state.
4. Run `auggy doctor` after setup/configuration changes.
5. Run `auggy routes` after route changes.
6. Generate browser and server clients separately when an app consumes routes.
7. Never put creator bearer tokens, agent credentials, signing secrets, or
   provider API keys in browser code.
8. Treat runtime auth and authorization as deterministic Auggy/app-backend work,
   not as model judgment.
9. Keep learned memory separate from operator-authored truth.
10. Explain the "why" when choosing routes, tools, memory, or auth patterns.

## Workflow Coverage

### Install and First Run

The skill should guide an agent through:

- verifying Node and Bun
- installing Auggy from npm
- running `auggy create <name>` or `auggy init [name]`
- configuring provider keys
- running `auggy doctor`
- starting locally with `auggy run` or `auggy dev`
- opening `/console/chat`

### Custom Augment Development

The skill should guide an agent to:

- create local augment code under `augments/<name>/`
- keep domain logic separate from transport wrappers
- expose deterministic HTTP routes in `httpRoutes` with `defineRoute`
- expose model-callable tools in `tools` with `defineTool`
- add request/response schemas
- run focused tests when present
- inspect route posture with `auggy routes`

### Generated Route Clients

The skill should guide an agent to run:

```bash
auggy routes <agent> --client ts --target browser --out src/auggy-client.ts
auggy routes <agent> --client ts --target server --out src/auggy-client.server.ts
```

It should explain that generated `createAuggyClient` is emitted inside each
generated file. Browser and server clients are separate because their credential
surfaces and route sets are intentionally different.

### App Auth and Authorization

The skill should teach the agent to:

- use app-owned sessions from providers such as Supabase or Clerk
- mint short-lived Auggy external auth assertions on the app backend
- pass `x-auggy-auth-assertion` through generated browser clients
- use explicit scopes/grants and route/tool `requires`
- enable replay protection for high-risk sessions
- audit denied route/tool authorization paths

### Troubleshooting

The skill should include playbooks for:

- missing provider API keys
- missing Bun or incompatible Node
- `EADDRINUSE`
- route collisions
- public/private route posture warnings
- invalid custom augment modules
- generated client target mistakes
- missing app-auth assertions
- Railway deploy failures

## Thin CLI Scripts

Scripts should be wrappers around existing CLI behavior, not hidden alternate
implementations.

Minimum scripts:

- `detect-auggy-env.sh`: print detected package manager, Bun/Node versions,
  whether `auggy` is installed, whether `agent.yaml` exists, and recommended
  next commands.
- `summarize-auggy-project.sh`: print agent name, installed augments, custom
  augment folders, generated clients, and relevant `.env.example` keys.
- `doctor-and-routes.sh`: run `auggy doctor` and `auggy routes` for a named
  agent/config.
- `generate-route-clients.sh`: generate browser and server clients to provided
  output paths.

Scripts should be optional conveniences. The skill must still be useful when an
agent cannot execute shell scripts.

## Platform Adapters

The canonical artifact should be a portable Agent Skill directory. Platform
adapters can wrap the same content:

- **Codex:** installable skill folder with `SKILL.md`, `agents/openai.yaml`,
  references, scripts, and templates.
- **Claude Code:** same skill structure, following the Agent Skills shape.
- **Cursor:** `.cursor/rules` adapter that points the agent at the same
  condensed mental model and selected reference files. Cursor support can start
  as experimental because rule loading differs from skill loading.

Do not fork the knowledge base per platform unless a platform requires a
different file format. Prefer one source skill with generated or copied adapters.

## Delivery Phases

### Phase 1 — MVP Skill

Create:

- `SKILL.md`
- `references/mental-model.md`
- `references/cli-workflows.md`
- `references/routes-tools-augments.md`
- `references/generated-clients.md`
- `references/troubleshooting.md`

Acceptance:

- A fresh agent can explain Auggy accurately.
- A fresh agent can create or initialize an Auggy project.
- A fresh agent can run doctor/routes and interpret the output.
- A fresh agent does not confuse routes, tools, augments, skills, and knowledge.

### Phase 2 — Builder Skill

Add:

- custom augment templates
- Next.js browser/server client snippets
- app-auth bridge reference
- `detect-auggy-env.sh`
- `doctor-and-routes.sh`
- `generate-route-clients.sh`

Acceptance:

- A fresh agent can add a custom route/tool augment to a small app.
- A fresh agent can generate browser/server clients and wire them safely.
- A fresh agent can debug common first-run errors without guessing.

### Phase 3 — Auth-Aware Skill

Add:

- Supabase/Clerk/custom-session assertion recipes
- delegated authorization examples
- route/tool grant examples
- replay-protection guidance
- denial/audit explanation

Acceptance:

- A fresh agent can protect a route and tool using app-owned auth.
- A fresh agent keeps signing secrets server-side.
- A fresh agent can explain allowed and denied behavior to the user.

### Phase 4 — Distribution

Add:

- install instructions on `auggy.dev`
- docs link from the root README
- Codex and Claude install instructions
- Cursor rules adapter
- a packaged artifact or repo path users can install from

Acceptance:

- A user can install the companion skill and ask their coding agent to set up
  Auggy in a fresh project.
- The skill's installation path does not depend on access to the private source
  repository.

### Phase 5 — Forward Evals

Run fresh-agent evaluations against prompts such as:

- "Create an Auggy concierge backend."
- "Add Auggy to my Next.js app and call a route from React."
- "Add a route and a tool over the same booking capability."
- "Protect this route with my app's Supabase auth."
- "Generate route clients and explain browser versus server usage."
- "Debug why my Auggy agent will not start."
- "Explain Auggy to my engineering team."

Each eval should capture:

- commands run
- files edited
- user-facing explanation quality
- security mistakes
- whether `auggy doctor` and `auggy routes` were used appropriately

## Non-Goals

- Do not make the skill a replacement for the CLI.
- Do not make the skill depend on unpublished/private repo paths.
- Do not teach agents to authorize users by trusting chat text.
- Do not hide privileged credentials in generated browser examples.
- Do not make the skill load the entire docs tree for every task.

## Roadmap Placement

This belongs in the `0.6.0` App-Builder DX candidate. A minimal MVP skill may
ship alongside the `0.5.0` public preview as launch support, but it should not
block npm publication unless the DX walkthrough shows that agents routinely
misbuild Auggy without it.

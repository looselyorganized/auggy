---
name: auggy
description: Build and troubleshoot self-hosted Auggy agents that run business operations through controlled TypeScript custom augments with tools, routes, identity, authorization, domain logic, memory, transports, skills, MCP, deployment, and optional app-integration routes.
allowedTrustLevels:
  - creator
---

# Auggy Build-Out Coach

Use this skill when the creator asks what this agent is, what it can do, what
to add next, or how to build a workflow with Auggy.

This bundled skill is the canonical Auggy companion skill for the agent itself.
External Claude, Codex, Cursor, and similar coding-agent skills should reuse
this folder instead of forking Auggy's mental model.

This is creator-facing guidance. Do not expose secrets, do not edit files,
install packages, or change deployment config unless the creator asks, and do
not claim a capability is installed unless you can observe it from current
tools, mounted skills, self-inspection, or explicit user-provided context.

## First Move

For any "what can you do?" or "how do I build X?" request:

1. If `auggy_self_info` is visible, call it first to inspect sanitized runtime
   inventory.
2. If the creator asks what to add for a goal and `auggy_self_recommend` is
   visible, call it before advising.
3. Check visible tools, mounted skill names, and current runtime context.
4. If a reference below matches the request, read it with `fs_read` before
   giving detailed guidance.
5. If live project state is not available, say so plainly and answer from the
   default Auggy project model.
6. Recommend the smallest extension point that solves the goal.
7. Give concrete commands or file paths only after naming the tradeoff.

Do not pretend to inspect `agent.yaml`, `augments/*`, `.mcp.json`, `.env`, or
generated clients unless those files are available through a mounted tool or
the creator pasted their contents. A fresh scaffold normally exposes `skills/`
and `data/workspace/`, not the full project root.

## Reference Map

Read the matching reference before answering in depth:

| Creator asks about | Read |
| --- | --- |
| What Auggy is, why it matters, kernel and augment model | `skills/auggy/references/mental-model.md` |
| Install, create/init, provider keys, run, doctor, deploy | `skills/auggy/references/cli-workflows.md` |
| Custom augments, `httpRoutes`, `defineRoute`, `defineTool` | `skills/auggy/references/routes-tools-augments.md` |
| Generated browser/server route clients | `skills/auggy/references/generated-clients.md` |
| Creator/public/agent trust, visitor auth, Supabase/Clerk/custom app auth, memory placement | `skills/auggy/references/authz-memory-trust.md` |
| End-to-end protected app route/tool auth | `skills/auggy/references/app-auth-bridge-e2e.md` |
| Next.js app integration | `skills/auggy/references/nextjs-integration.md` |
| Missing keys, `EADDRINUSE`, route collisions, bad custom augment modules, deploy failures | `skills/auggy/references/troubleshooting.md` |
| What is safe in the 0.5 preview | `skills/auggy/references/release-0.5-surface.md` |
| Copyable starter files | `skills/auggy/assets/templates/` |
| Optional shell helpers for coding agents | `skills/auggy/scripts/` |

If `fs_read` is unavailable, say that you cannot read the reference from this
surface and then give concise default guidance from this skill.

## What Auggy Is

Turn business operations into agent-ready capabilities. Auggy replaces one-off
integration glue with TypeScript augments—controlled, predictable interfaces
that bundle identity, authorization, schemas, tools, routes, and domain logic.
The application remains the system of record.

Underneath, a small TypeScript runtime executes the agent:

- **The kernel** runs turns: receive input, assemble context, call a model,
  execute validated tools, and return a result.
- **Augments** add runtime capabilities such as tools, memory, context,
  transports, lifecycle hooks, policy, skills, and operator diagnostics.
- **Tools** are typed, model-callable capabilities used during a turn.
- **Skills** are markdown teaching files the model reads on demand.
- **Knowledge** is reference material fetched when relevant.
- **Identity** is durable operator-authored persona, behavior, and safety
  policy.

Core rule: recommend the smallest augment or skill that gives the agent the
needed capability. Optional routes and app authorization are advanced preview
surfaces, not requirements for a normal Auggy project.

## Build-Out Decision Matrix

Use `auggy augment add` with no arguments to open the augment selector. Use
`auggy augment add <name...>` to add known augments in one command.

| Creator goal | Best extension point | Why |
| --- | --- | --- |
| Change who the agent is, voice, policy, refusal rules | `identity.md` | Durable behavior that should apply every turn |
| Teach a workflow or style | `auggy skill create <name>` | Instructions and examples, no runtime code |
| Add docs, FAQs, product facts, policies | `auggy augment add knowledge` | Reference material fetched only when relevant |
| Remember repeat visitors | `auggy augment add layeredMemory` | Peer-scoped memory backed by SQLite |
| Recognize visitors across sessions | `auggy augment add visitorAuth` | Email magic-link identity continuity |
| Notify creator or ops endpoint | `auggy augment add notify` | Outbound alerts with destination policy and rate limits |
| Send or receive email as the agent | `auggy augment add agentMail` | Policy-gated mail with durable inbound recovery and outbound review |
| Add external tool servers | `auggy augment add mcp` | Bridge MCP tools with trust policy |
| Chat over Telegram | `auggy augment add telegramTransport` | Bidirectional Telegram transport |
| Add app-specific tools or integrations | `auggy augment create <name>` | Custom runtime code owned by this agent |
| Expose optional frontend/server routes | `auggy routes --client ts` | Advanced preview: typed client generated from route manifests |
| Execute shell commands | `auggy augment add bash` | Preview host process execution; requires explicit creator intent |
| Track spend guardrails | `auggy augment add budgets` | Preview soft guardrails; provider hard caps still matter |
| Connect agents to each other | `auggy augment add link` | Preview mesh/A2A surface; not a default recommendation |

When unsure, choose the least powerful option: skill or knowledge before custom
code, custom code before broad shell access, and explicit creator approval
before preview augments.

## Common Answers

### "What can you do right now?"

Answer in three layers:

1. The agent's visible purpose and current tools.
2. Mounted skills you can read for deeper guidance.
3. Capabilities that are likely available only if their tools, skills, or
   self-inspection output are present.

If `auggy_self_info` is visible, use its output as source of truth. If you
cannot verify installed augments, avoid saying "I have visitorAuth" or "I have
notify"; say "Auggy can add ..." instead.

### "I want you to answer from my docs"

Recommend `knowledge` first:

```bash
auggy augment add knowledge
```

Then add markdown under `knowledge/local/` and list each endpoint in
`knowledge/local/manifest`. Do not paste large docs into `identity.md`.

### "I want you to remember people"

Inspect the live inventory first. Always distinguish an Auggy capability from
what is installed in this agent. If `layeredMemory` is absent, say:

> **Layered Memory — stable add-on, not installed in this agent.** Adds
> peer-scoped episodic memory backed by SQLite. Explicit topic-based writes
> work after installation; automatic extraction is off by default.

Then suggest:

```bash
auggy augment add layeredMemory
```

If it is already installed, say so and explain that peer facts use
`memory_write({ topic, content })`; do not recommend installing it again.

For cross-session visitor continuity, pair it with:

```bash
auggy augment add visitorAuth
```

Read `skills/auggy/references/authz-memory-trust.md` before explaining memory
trust, learned behavior, or app auth.

Existing projects can refresh this general guide with `auggy skill add auggy`.
The augment-specific memory teaching can be refreshed with
`auggy skill add layeredMemory` after that augment is installed.

### "I want a new route, API call, or app-specific tool"

Use:

```bash
auggy augment create <name>
```

Read `skills/auggy/references/routes-tools-augments.md` before giving code.
Reading this top-level `SKILL.md` is not enough for that request. Do not give
custom-augment file structure or code until that reference read succeeds. If
`fs_read` is unavailable or the read fails, provide only the command and
reference path, explain the limitation, and do not invent an implementation.
For starter files, inspect `skills/auggy/assets/templates/custom-augment/`.
After route changes, recommend:

```bash
auggy routes
auggy routes --json
auggy routes --openapi
```

If an app consumes those routes, also recommend generating browser/server
clients. Read `skills/auggy/references/generated-clients.md`.

### "I want to use Auggy from Next.js"

Read `skills/auggy/references/nextjs-integration.md`. Keep browser generated
clients in browser-safe code and server generated clients in server-only code.
Never ship creator bearer tokens, agent credentials, provider API keys, or
external auth signing secrets to the browser.
Treat publicly reachable route handlers as untrusted entry points: verify the
host application's session and explicit role before using a server client, and
enforce exact Origin plus session-bound CSRF for browser actions. Trusted jobs
should call the server client directly instead of routing through public HTTP.
For starter files, inspect `skills/auggy/assets/templates/nextjs-browser-client/`
and `skills/auggy/assets/templates/nextjs-server-client/`.

### "I already use Supabase, Clerk, Auth0, or custom auth"

Keep the app's auth system as the source of truth. The app backend verifies the
session, computes explicit scopes/grants, and mints a short-lived Auggy auth
assertion. Browser code forwards that assertion; it never sees the signing
secret. Read `skills/auggy/references/authz-memory-trust.md`.
For a complete route/tool walkthrough, also read
`skills/auggy/references/app-auth-bridge-e2e.md`.
For starter files, inspect `skills/auggy/assets/templates/app-auth-bridge/`.

### "I want to deploy"

Run local checks first:

```bash
auggy doctor
```

Then deploy:

```bash
auggy deploy
```

For cloud agents, use `auggy doctor --cloud` where relevant. Do not deploy
console magic-link visitor auth unless the creator accepts that links appear in
service logs.

### "Can you inspect or validate this project for me?"

If this is a coding-agent workspace with shell access, helper scripts are
available under `skills/auggy/scripts/`. Read
`skills/auggy/references/cli-workflows.md` first so the underlying CLI commands
are clear. Do not require these scripts when shell access is unavailable.

## Project Map

- `agent.yaml`: runtime entry point; identity, engine, model, settings, and
  enabled augment order.
- `augments/<id>/augment.yaml`: config for one enabled augment. Built-ins use
  `type: <augmentName>`. Custom augments use `type: custom` plus `source`.
- `augments/<id>/index.ts`: common entry point for custom augment code.
- `identity.md`: voice, purpose, boundaries, authorization-independent
  identity, and security rules.
- `learned-behaviors.md`: mutable creator-approved agent-global behavior, not
  visitor-specific memory.
- `skills/`: instruction packs the agent can read on demand.
- `knowledge/`: local and remote knowledge source config.
- `.mcp.json`: MCP server definitions.
- `.env`: local secrets. Never print secret values.
- `data/`: mutable runtime data and workspace files.

## Operating Rules

- Say when you are giving default Auggy guidance instead of live project state.
- Do not reveal `.env` values or ask the creator to paste secrets into chat.
- Do not write files, install packages, or change config unless asked.
- After changing config, skills, knowledge, or augments, recommend:

```bash
auggy doctor
auggy run
```

- After changing route-owning augments, recommend `auggy routes` and
  regenerating generated clients if an app imports them.
- Preview augments (`bash`, `budgets`, `link`) need explicit creator intent and
  clear warnings.
- If the creator asks whether something belongs in identity, skill, knowledge,
  or an augment, explain the tradeoff and recommend the smallest sufficient
  change.

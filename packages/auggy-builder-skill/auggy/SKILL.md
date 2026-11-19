---
name: auggy
description: Inspect a self-hosted Auggy agent, extend it with a custom augment or tool, and troubleshoot setup, execution, or deployment. Use when a creator asks what their agent can do or how to connect an application operation.
---

# Auggy Build-Out Coach

Use this skill when the creator asks what this agent is, what it can do, what
to add next, or how to build a workflow with Auggy.

Resolve references and assets relative to this SKILL.md. Inside Auggy, use
`fs_read` with the mount prefix `skills/auggy/` (for example,
`skills/auggy/references/routes-tools-augments.md`). In an external coding
agent, use its file reader and the directory containing this skill.

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
4. If a reference below matches the request, read it before
   giving detailed guidance.
5. If live project state is not available, say so plainly and answer from the
   default Auggy project model.
6. Recommend the smallest extension point that solves the goal.
7. Give concrete commands or file paths only after naming the tradeoff.

Do not pretend to inspect `agent.yaml`, `src/*`, `.mcp.json`, `.env`, or
generated clients unless those files are available through a mounted tool or
the creator pasted their contents. A fresh scaffold normally exposes `skills/`
and `data/workspace/`, not the full project root.

## Reference Map

Read the matching reference before answering in depth:

| Creator asks about | Read |
| --- | --- |
| What Auggy is, why it matters, kernel and augment model | `references/mental-model.md` |
| Install, create/init, provider keys, AgentMail setup, run, doctor, deploy | `references/cli-workflows.md` |
| Custom augments, `httpRoutes`, `defineRoute`, `defineTool` | `references/routes-tools-augments.md` |
| Generated browser/server route clients | `references/generated-clients.md` |
| Creator/public/agent trust, visitor auth, Supabase/Clerk/custom app auth, memory placement | `references/authz-memory-trust.md` |
| End-to-end protected app route/tool auth | `references/app-auth-bridge-e2e.md` |
| Next.js app integration | `references/nextjs-integration.md` |
| Missing keys, `EADDRINUSE`, route collisions, bad custom augment modules, deploy failures | `references/troubleshooting.md` |
| What v0.6.1 supports and where its limits are | `references/release-0.6.1.md` |
| Copyable starter files | `assets/templates/` |
| Optional shell helpers for coding agents | `scripts/` |

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
- **Tools** are typed operations an augment exposes for the model to call during a turn.
- **Skills** are markdown teaching files the model reads on demand.
- **Knowledge** is reference material fetched when relevant.
- **Identity** is durable operator-authored persona, behavior, and safety
  policy.

Core rule: recommend the smallest augment or skill that gives the agent the
needed capability. Optional routes and app authorization are advanced preview
surfaces, not requirements for a normal Auggy project.

## Build-Out Decision Matrix

Use `bun run auggy augment add` with no arguments to open the augment selector. Use
`bun run auggy augment add <name...>` to add known augments in one command.

| Creator goal | Best extension point | Why |
| --- | --- | --- |
| Change who the agent is, voice, policy, refusal rules | `identity.md` | Durable behavior that should apply every turn |
| Teach a workflow or style | `bun run auggy skill create <name>` | Instructions and examples, no runtime code |
| Add docs, FAQs, product facts, policies | `bun run auggy augment add knowledge` | Reference material fetched only when relevant |
| Remember repeat visitors | `bun run auggy augment add layeredMemory` | Peer-scoped memory backed by SQLite |
| Recognize visitors across sessions | `bun run auggy augment add visitorAuth` | Email magic-link identity continuity |
| Notify creator or ops endpoint | `bun run auggy augment add notify` | Outbound alerts with destination policy and rate limits |
| Send or receive email as the agent | `bun run auggy augment add agentMail` | Policy-gated mail with durable inbound recovery and outbound review |
| Add external tool servers | `bun run auggy augment add mcp` | Bridge MCP tools with trust policy |
| Chat over Telegram | `bun run auggy augment add telegramTransport` | Bidirectional Telegram transport |
| Add app-specific tools or integrations | `bun run auggy augment create <name>` | Custom runtime code owned by this agent |
| Expose optional frontend/server routes | `bun run auggy routes --client ts` | Advanced preview: typed client generated from route manifests |
| Execute shell commands | `bun run auggy augment add bash` | Preview host process execution; requires explicit creator intent |
| Track spend guardrails | `bun run auggy augment add budgets` | Preview soft guardrails; provider hard caps still matter |
| Connect agents to each other | `bun run auggy augment add link` | Preview mesh/A2A surface; not a default recommendation |

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
bun run auggy augment add knowledge
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
bun run auggy augment add layeredMemory
```

If it is already installed, say so and explain that peer facts use
`memory_write({ topic, content })`; do not recommend installing it again.

For cross-session visitor continuity, pair it with:

```bash
bun run auggy augment add visitorAuth
```

Read `references/authz-memory-trust.md` before explaining memory
trust, learned behavior, or app auth.

Existing projects can refresh this general guide with `bun run auggy skill add auggy`.
The augment-specific memory teaching can be refreshed with
`bun run auggy skill add layeredMemory` after that augment is installed.

### "I want the agent to use email"

Check whether `agentMail` is enabled. To add it, run
`bun run auggy augment add agentMail`. If setup was skipped, run
`bun run auggy augment setup agentMail`. Enter provider keys and verification codes
privately in the CLI. For setup modes, inbound mail, or credential recovery,
read `references/cli-workflows.md`.

### "I want a new route, API call, or app-specific tool"

Read `references/routes-tools-augments.md` before giving code or file layout.
If the reference cannot be read, identify the missing file and give the
scaffold command only:

```bash
bun run auggy augment create order-support
```

For a shipping-address change, the tool belongs to the order-support augment.
The application owns the order. Use the verified caller identity to check
which order they can change, and require confirmation of the proposed address
before the adapter calls the application's order service.

For starter files, see `assets/templates/custom-augment/`.
After route changes, recommend:

```bash
bun run auggy routes
bun run auggy routes --json
bun run auggy routes --openapi
```

If an app consumes those routes, also recommend generating browser/server
clients. Read `references/generated-clients.md`.

### "I want to use Auggy from Next.js"

Read `references/nextjs-integration.md`. Keep browser generated
clients in browser-safe code and server generated clients in server-only code.
Never ship creator bearer tokens, agent credentials, provider API keys, or
external auth signing secrets to the browser.
Treat publicly reachable route handlers as untrusted entry points: verify the
host application's session and explicit role before using a server client, and
enforce exact Origin plus session-bound CSRF for browser actions. Trusted jobs
should call the server client directly instead of routing through public HTTP.
For starter files, inspect `assets/templates/nextjs-browser-client/`
and `assets/templates/nextjs-server-client/`.

### "I already use Supabase, Clerk, Auth0, or custom auth"

Keep the app's auth system as the source of truth. The app backend verifies the
session, computes explicit scopes/grants, and mints a short-lived Auggy auth
assertion. Browser code forwards that assertion; it never sees the signing
secret. Read `references/authz-memory-trust.md`.
For a complete route/tool walkthrough, also read
`references/app-auth-bridge-e2e.md`.
For starter files, inspect `assets/templates/app-auth-bridge/`.

### "I want to deploy"

Run local checks first:

```bash
bun run auggy doctor
```

Then deploy:

```bash
bun run auggy deploy
```

For cloud agents, use `bun run auggy doctor --cloud` where relevant. Do not deploy
console magic-link visitor auth unless the creator accepts that links appear in
service logs.

### "Can you inspect or validate this project for me?"

If this is a coding-agent workspace with shell access, helper scripts are
available under `scripts/`. Read
`references/cli-workflows.md` first so the underlying CLI commands
are clear. Do not require these scripts when shell access is unavailable.

## Project Map

- `agent.yaml`: sole enabled-augment/configuration graph, including inline options
  and `application.entrypoint: ./src/main.ts`.
- `src/main.ts`: actual managed startup: prepare configuration, create model and
  augments, call `createAgent` with `turnProgram` and an optional `onTurnFinalized`
  callback, bind transports, configure HTTP, then start. YAML owns the enabled graph.
- `src/http.ts`: visible `POST /agent/run`, delegating the original request to the
  maintained authentication, validation and durable-delivery adapter. Its literal
  mount path is editable; console and metadata follow the selected mount.
- `src/turn.ts`: prompt, inference, tools, refresh, final answer and exhaustion.
- `src/augments/<name>/{index.ts,schemas.ts,service.ts}`: project-owned custom
  interfaces and business adapters; tests live in `tests/augments/`.
- `node_modules/auggy/src/`: installed guarded runtime and built-in implementations.
- `identity.md`: operator-authored identity and boundaries.
- `learned-behaviors.md`: creator-approved agent-global behavior, not visitor memory.
- `skills/`: model-visible instruction packs; no secrets or private receipts.
- `knowledge/`: local and remote reference sources; `.mcp.json`: MCP server definitions.
- `.env`: private local secrets; `data/`: mutable state and workspace files.
- `.auggy/`: private model metadata and operation receipts, excluded from deployment.

Use `./node_modules/.bin/auggy inspect` for passive navigation; partial output does not prove readiness.
Inspection does not execute TypeScript or infer custom HTTP mount paths.
The `auggy` executable disables Bun environment loading, automatic installation
and local configuration preloads during inspection. `bun run auggy routes` loads configuration and augment implementations.

For legacy referenced YAML, preview `bun run auggy migrate`, then explicitly apply after
review. `--application` separately adopts owned execution files, refuses collisions,
and requires a compatible installed runtime. It introduces the omitted application
timeout of 15 minutes; config-only conversion preserves legacy execution mode.
Changes affect the next launch. Never silently migrate, regenerate owned source,
move legacy custom modules, or treat a dependency update as approval to rewrite
project files. See `references/cli-workflows.md` for recovery.

## Operating Rules

- Say when you are giving default Auggy guidance instead of live project state.
- Do not reveal `.env` values or ask the creator to paste secrets into chat.
- Do not write files, install packages, or change config unless asked.
- After changing config, skills, knowledge, or augments, recommend:

```bash
bun run auggy doctor
bun run auggy run
```

- After changing route-owning augments, recommend `bun run auggy routes` and
  regenerating generated clients if an app imports them.
- Preview augments (`bash`, `budgets`, `link`) need explicit creator intent and
  clear warnings.
- If the creator asks whether something belongs in identity, skill, knowledge,
  or an augment, explain the tradeoff and recommend the smallest sufficient
  change.

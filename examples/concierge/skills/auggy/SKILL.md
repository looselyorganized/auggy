---
name: auggy
description: Help the creator understand, customize, and build out this Auggy agent with identity, skills, knowledge, augments, MCP, memory, notifications, and deploy.
allowedTrustLevels:
  - creator
---

# Auggy Build-Out Coach

Use this skill when the creator asks what this agent is, what it can do, what
to add next, or how to build a workflow with Auggy.

This bundled skill is the canonical Auggy companion skill for the agent itself.
The portable Claude/Codex/Cursor builder skill should reuse this mental model
and expand it with editor-specific scripts and templates rather than fork the
architecture.

This is creator-facing guidance. Do not expose secrets, do not edit files,
install packages, or change deployment config unless the creator asks, and do
not claim a capability is installed unless you can observe it from the current
tools, mounted skills, or explicit user-provided context.

## First Move

For any "what can you do?" or "how do I build X?" request:

1. If `auggy_self_info` is visible, call it first to inspect the sanitized
   runtime inventory.
2. If the creator asks what to add for a goal and `auggy_self_recommend` is
   visible, call it with the creator's goal before advising.
3. Check what else is actually available in the current conversation: visible
   tools, mounted skill names, and any runtime context you were given.
4. If a relevant mounted skill is listed, read it before saying you do not have
   documentation. For Auggy build-out questions, this `auggy` skill is the
   starting point.
5. If live project state is not available, say so plainly and give guidance
   based on the default Auggy project model.
6. Recommend the smallest extension point that solves the goal.
7. Give concrete next steps only after naming the tradeoff.

Do not pretend to inspect `agent.yaml`, `augments/*`, `.mcp.json`, or `.env`
unless those files are available through a mounted tool or the creator pasted
their contents. A fresh scaffold normally exposes `skills/` and
`data/workspace/`, not the full project root.

## Creator-Only Self Inspection

When the `auggy_self_*` tools are visible, use them instead of guessing:

- `auggy_self_info`: current sanitized inventory, installed augments, mounted
  skills, missing skill warnings, stable/preview catalog gaps, and agent
  metadata. This does not expose secrets.
- `auggy_self_catalog`: current built-in augment catalog with installed state.
- `auggy_self_recommend`: goal-to-extension recommendation for common build-out
  requests.

These tools are creator-only. If they are not visible, do not mention their
names to non-creator peers; answer from visible capabilities and default Auggy
guidance only.

## What Auggy Is

An Auggy agent is a Bun/TypeScript project composed from:

- **Identity**: `identity.md`, loaded as durable operator-authored behavior and
  safety rules.
- **Augments**: runtime capabilities mounted at boot. They can add tools,
  transports, memory, context, routes, admission gates, and lifecycle hooks.
- **Tools**: callable functions exposed by augments to the model.
- **Skills**: markdown guides in `skills/<name>/SKILL.md`. Skills teach when
  and how to use capabilities; they do not add runtime code by themselves.
- **Knowledge**: local or remote reference material fetched on demand.
- **Data**: mutable runtime state under `data/`, including workspace files and
  SQLite databases.

Keep this boundary crisp: augments are infrastructure, tools are mechanism,
skills are teaching, knowledge is reference material, and identity is durable
persona/policy.

## Build-Out Decision Matrix

Use `auggy augment add` with no arguments to open the augment selector. Use
`auggy augment add <name...>` to add one or more known augments in a single
command.

| Creator goal | Best extension point | Why |
| --- | --- | --- |
| Change who the agent is, how it speaks, or what it must refuse | `identity.md` | Durable behavior that should apply every turn |
| Teach a repeatable workflow or style | `auggy skill create <name>` | Instructions and examples, no new runtime code |
| Add docs, FAQs, pricing, policies, or product facts | `auggy augment add knowledge` | Reference material fetched only when relevant |
| Remember repeat visitors | `auggy augment add layeredMemory` | Peer-scoped memory backed by SQLite |
| Recognize visitors across sessions | `auggy augment add visitorAuth` | Email magic-link identity continuity |
| Notify the creator or an ops endpoint | `auggy augment add notify` | Outbound alerts with destination policy and rate limits |
| Send email as the agent | `auggy augment add agentMail` | Model-callable outbound mail with recipient policy |
| Add external tool servers | `auggy augment add mcp` | Bridge MCP tools into Auggy with trust policy |
| Chat over Telegram | `auggy augment add telegramTransport` | Bidirectional Telegram transport |
| Call an app-specific API or add routes | `auggy augment create <name>` | Custom runtime code owned by this agent |
| Let a frontend/server job call agent backend routes | `auggy routes --client ts` | Typed route client generated from actual route manifests |
| Execute shell commands | `auggy augment add bash` | Preview host process execution; use only with explicit creator intent |
| Track runtime spend guardrails | `auggy augment add budgets` | Preview soft guardrails; provider hard caps still matter |
| Connect agents to each other | `auggy augment add link` | Preview mesh/A2A surface; not a default recommendation |

When unsure, choose the least powerful option: skill or knowledge before custom
code, custom code before broad shell access, and explicit creator approval
before preview augments.

## Common Recipes

### "What can you do right now?"

Answer in three layers:

1. The agent's visible purpose and current tools.
2. Mounted skills you can read for deeper guidance.
3. Capabilities that are likely available only if their tools or skills are
   present.

If `auggy_self_info` is visible, use its output as the source of truth and call
out any missing skill warnings.

If you cannot verify installed augments, avoid names like `visitorAuth` or
`notify` as current facts. Say "Auggy can add ..." instead of "I have ...".

### "I want you to answer from my docs"

Recommend knowledge first:

```bash
auggy augment add knowledge
```

Then add markdown under `knowledge/local/` and list each endpoint in
`knowledge/local/manifest`. Use clear endpoint descriptions; they are how the
model decides what to fetch.

Do not recommend pasting large docs into `identity.md`.

### "I want you to remember people"

Use:

```bash
auggy augment add layeredMemory
```

For cross-session visitor continuity, pair it with:

```bash
auggy augment add visitorAuth
```

`layeredMemory` stores peer-scoped memory in `data/memory.db`. Save stable
preferences, names, commitments, and recurring topics. Do not hand-build peer
labels; the runtime derives them.

### "I want you to alert me"

Use:

```bash
auggy augment add notify
```

The default destination writes to `notifications.jsonl`. For real delivery,
edit `augments/notify/augment.yaml` and add required secrets to `.env`.

Distinguish this from visitor verification email and AgentMail:

- `notify` is for alerts/status/escalation to configured destinations.
- `auggy augment setup visitorAuth` for visitorAuth magic-link email only.
- `auggy augment add agentMail` when the agent itself should send email as a
  model-callable capability with recipient policy and rate limits.

### "I want external tools"

Use MCP when a server exists:

```bash
auggy augment add mcp
auggy mcp doctor
```

Edit `.mcp.json`. Prefer remote HTTPS MCP servers for cloud deploys. Local
stdio MCP servers should be disabled for cloud or marked local-only.

If no MCP server exists and the integration is specific to this agent, create a
custom augment instead.

### "I need a new API call or app route"

Use a custom augment:

```bash
auggy augment create weather
```

Custom augments can expose HTTP routes, model-callable tools, or both. Put
shared business logic in normal TypeScript functions, then wrap it with:

- a route when software, a form, a webhook, a generated client, or a server job
  should call it deterministically
- a tool when the agent should decide whether, when, or how to mediate it

Use `httpRoutes` for routes and `tools` for model-callable tools:

```ts
import { defineAugment, defineRoute, defineTool, json, webhook } from "auggy";
import { z } from "zod";

const ServiceParams = z.object({ id: z.string() });
const ServiceQuery = z.object({ q: z.string().optional() });
const Service = z.object({ id: z.string(), name: z.string() });
const LeadInput = z.object({
  email: z.string().email(),
  need: z.string().min(1),
});
const LeadResponse = z.object({ id: z.string(), saved: z.boolean() });

async function searchServices(query: z.infer<typeof ServiceQuery>) {
  return [{ id: "svc_haircut", name: query.q ?? "Haircut" }];
}

async function saveLead(input: z.infer<typeof LeadInput>) {
  return { id: "lead_123", saved: true, ...input };
}

export default function services() {
  return defineAugment({
    name: "services",
    type: "custom",
    capabilities: ["tools"],
    httpRoutes: [
      defineRoute.get("/services", {
        auth: "none",
        query: ServiceQuery,
        response: z.object({ services: z.array(Service) }),
        rateLimit: { maxPerMinute: 60 },
        handler: async ({ query }) => json({ services: await searchServices(query) }),
      }),
      defineRoute.get("/services/:id", {
        auth: "visitor.optional",
        params: ServiceParams,
        response: Service,
        handler: async ({ params }) => json({ id: params.id, name: "Haircut" }),
      }),
      defineRoute.post("/leads/create", {
        auth: "visitor.optional",
        body: LeadInput,
        response: LeadResponse,
        maxBodyBytes: 8192,
        rateLimit: { maxPerMinute: 10 },
        handler: async ({ body, auth }) => {
          const lead = await saveLead(body);
          return json({ id: lead.id, saved: true }, 201);
        },
      }),
      defineRoute.post("/webhooks/stripe", {
        auth: "none",
        policy: webhook.signature("stripe", { secretEnv: "STRIPE_WEBHOOK_SECRET" }),
        maxBodyBytes: 65536,
        handler: async ({ webhook }) =>
          json({ received: webhook?.provider === "stripe", event: webhook?.event }),
      }),
    ],
    tools: [
      defineTool({
        name: "service_search",
        description: "Search services by visitor need or keyword.",
        category: "business",
        input: ServiceQuery,
        execute: async (input) => JSON.stringify({ services: await searchServices(input) }),
      }),
      defineTool({
        name: "save_lead",
        description: "Save a lead for creator follow-up after the agent has collected enough detail.",
        category: "business",
        input: LeadInput,
        execute: async (input) => JSON.stringify({ lead: await saveLead(input) }),
      }),
    ],
  });
}
```

Route option quick reference:

- `auth`: use `"none"` for public deterministic reads/forms,
  `"visitor.optional"` for mixed anonymous/signed-in visitor state,
  `"visitor.required"` for account data, `"creator"` or `"bearer"` for
  operator/server actions, and `"agent.required"` for admitted agent callers.
- `params`: Zod schema for `:path` params.
- `query`: Zod schema for URL query values on GET or POST.
- `body`: Zod schema for POST JSON body.
- `response`: Zod schema for successful JSON output; this types generated
  client `result.data`.
- `requires`: delegated authorization scopes/grants enforced by Auggy.
- `policy`: webhook-signature policy such as `webhook.signature("stripe")`.
- `maxBodyBytes`, `timeoutMs`, `rateLimit`: deterministic route safeguards.

After route changes, inspect the manifest:

```bash
auggy routes
auggy routes --json
auggy routes --openapi
```

If an app consumes the routes, generate separate clients:

```bash
auggy routes --client ts --target browser --out src/auggy-client.ts
auggy routes --client ts --target server --out src/auggy-client.server.ts
```

Browser clients include public and visitor routes. Server clients include
privileged bearer, creator, agent, and webhook-policy routes. `createAuggyClient`
is emitted into each generated file; do not import it from the `auggy` package
yet.

Keep tools narrow, typed, and well described. Test before installing:

```bash
auggy augment test ./augments/weather
```

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

## Project Map

- `agent.yaml`: runtime entry point; identity, engine, model, settings, and
  enabled augment order.
- `augments/<id>/augment.yaml`: config for one enabled augment. Built-ins use
  `type: <augmentName>`. Custom augments use `type: custom` plus `source`.
- `augments/<id>/index.ts`: common entry point for custom augment code that
  exports `defineAugment({ httpRoutes, tools, ... })`.
- `identity.md`: voice, purpose, boundaries, authorization-independent identity,
  and security rules.
- `learned-behaviors.md`: mutable agent-global operating guidance. Use it for
  creator-approved preferences about how the agent should behave. Do not use it
  for visitor-specific facts.
- `layeredMemory`: optional peer-scoped memory for facts about a specific
  visitor, creator, or repeat peer. Add it before promising cross-session
  personal memory.
- `skills/`: instruction packs the agent can read on demand.
- `knowledge/`: local and remote knowledge source config.
- `.mcp.json`: MCP server definitions.
- `.env`: local secrets. Never print secret values.
- `data/`: mutable runtime data and workspace files.

## Memory Decisions

- User-specific facts and preferences go to `memory_write({ topic, content })`
  only when a writable peer memory provider such as `layeredMemory` is
  installed.
- Creator-approved global operating preferences go to the exact `learned`
  memory label, which is backed by `learned-behaviors.md` in new projects.
- Identity, authority, hard safety rules, and security boundaries belong in
  `identity.md`, not learned behavior memory.
- If `memory_write({ topic, content })` says no writable current-peer provider
  exists, tell the peer the memory was not saved. Do not say you will remember
  it across sessions.

## Operating Rules

- Say when you are giving default Auggy guidance instead of live project state.
- Do not reveal `.env` values or ask the creator to paste secrets into chat.
- Do not write files, install packages, or change config unless asked.
- After changing config, skills, knowledge, or augments, recommend:

```bash
auggy doctor
auggy run
```

- After changing route-owning augments, also recommend `auggy routes` and
  regenerating browser/server clients if an app imports them.

- Preview augments (`bash`, `budgets`, `link`) need explicit creator intent and
  clear warnings.
- If the creator asks whether something belongs in identity, skill, knowledge,
  or an augment, explain the tradeoff and recommend the smallest sufficient
  change.

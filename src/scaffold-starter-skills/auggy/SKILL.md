---
name: auggy
description: Help the creator customize this Auggy agent: identity, config, augments, skills, knowledge, MCP, custom tools, and deploy.
---

# Auggy Project Guide

Use this skill when the creator asks how to customize this agent, add knowledge,
create skills, create augments, inspect project files, or deploy the agent.

This skill is for creator assistance. Do not expose secrets, do not edit files
unless the creator asks, and do not claim runtime capabilities that are not
enabled in `agent.yaml`.

## Project Map

- `agent.yaml`: runtime entry point. It declares the engine, model, settings,
  and enabled augment order.
- `augments/<id>/augment.yaml`: config for one enabled augment. Built-ins use
  `type: <augmentName>`. Custom augments use `type: custom` plus `source`.
- `identity.md`: the agent's voice, purpose, boundaries, and security rules.
  This is the best first edit for behavior/personality changes.
- `package.json`: agent-local runtime and provider dependencies.
- `.env`: local secrets and generated runtime values. Never read or print secret
  values unless the creator explicitly asks for a diagnostic.
- `.env.example`: names of required secrets without values.
- `skills/`: instruction packs the agent can read on demand. Skills teach the
  model how to use tools or follow domain workflows; they do not add runtime
  code by themselves.
- `augments/`: config for built-in augments plus source for custom local
  augments. Each enabled augment has `augments/<id>/augment.yaml`. Augments add
  runtime capabilities such as tools, transports, memory, and knowledge sources.
- `knowledge/`: local and remote knowledge source config, created by
  `auggy augment add knowledge`.
- `.mcp.json`: MCP server definitions, created by `auggy augment add mcp`.
- `data/`: mutable runtime data and workspace files. Treat it as local state.

## Fast Answers

If the creator asks "how do I change who you are?", point them to
`identity.md`.

If the creator asks "how do I add facts, docs, or product information?", suggest
the `knowledge` augment:

```bash
auggy augment add knowledge
```

If the creator asks "how do I configure an augment?", point them to:

```text
augments/<augment-id>/augment.yaml
```

After config changes, recommend:

```bash
auggy doctor
auggy run
```

If the creator asks "how do I see available augments?", use:

```bash
auggy augment list
```

If the creator asks "how do I send notifications?", suggest:

```bash
auggy augment add notify
```

Then edit `augments/notify/augment.yaml` for real delivery destinations.

If the creator asks "how do you remember repeat visitors?", suggest:

```bash
auggy augment add layeredMemory
```

Explain that `layeredMemory` stores peer-scoped memory in `data/memory.db`.
The agent should save stable preferences, names, commitments, and recurring
topics with `memory_write({ topic, content })`; the runtime derives the current
peer label.

If the creator asks "how do visitors sign in?", suggest:

```bash
auggy augment add visitorAuth
```

For local testing, visitorAuth prints console magic links. For production email
delivery, suggest:

```bash
auggy agentmail setup visitorAuth
```

This configures AgentMail credentials for magic-link delivery. Do not suggest
deploying console magic links to Railway unless the creator explicitly accepts
that verification links will be visible in service logs.

If the creator asks "how do you send email?", distinguish the two paths:

- `auggy agentmail setup visitorAuth` for visitorAuth magic-link email only.
- `auggy augment add agentMail` when the agent itself should send email as a
  model-callable capability with recipient policy and rate limits.

If the creator asks "how do I add MCP tools?", suggest:

```bash
auggy augment add mcp
auggy mcp doctor
```

Then edit `.mcp.json`. For cloud deploys, prefer remote HTTPS MCP servers over
local stdio servers. Local stdio servers may stay in `.mcp.json` if they are
marked `cloud: "disabled"` or `cloud: "localOnly"` under `auggy.servers`.

If the creator asks "how do I teach you a repeatable workflow?", suggest a
skill:

```bash
auggy skill create support-playbook
```

If the creator asks "how do I give you a new tool or API call?", suggest a
custom augment:

```bash
auggy augment create weather
```

If the creator asks "how do I run you?", use:

```bash
auggy run
```

If the creator asks "how do I deploy you?", use:

```bash
auggy deploy
```

## Editing Config

Use `agent.yaml` for project-level choices: agent identity, engine/provider,
model, global settings, and the ordered list of enabled augments.

Use `augments/<id>/augment.yaml` for per-augment config:

```yaml
type: webFetch
config:
  timeoutMs: 15000
```

For custom augments:

```yaml
type: custom
source: ./index.ts
config: {}
```

Put secrets in `.env` and reference them from config as `${NAME}`. After editing
config or `.env`, run `auggy doctor` before restarting.

## Editing Identity

Use `identity.md` for durable behavior:

- who the agent is
- how it should speak
- what it should prioritize
- what it must refuse or escalate
- product/domain-specific operating rules

Good guidance is concrete:

```md
## Operating style

- Ask one clarifying question when the request is ambiguous.
- Prefer short answers with a concrete next step.
- When discussing pricing, use the knowledge source before answering.
```

Avoid putting secrets, private keys, bearer tokens, or passwords in
`identity.md`.

## Adding Knowledge

Knowledge is for durable reference material that should be fetched on demand.
It is better than pasting large docs into `identity.md`.

Create the knowledge scaffold:

```bash
auggy augment add knowledge
```

The local source looks like this:

```text
knowledge/
  sources.json
  local/
    manifest
    mission.md
    context.md
```

Add a new local topic by creating a markdown file:

```text
knowledge/local/pricing.md
```

Then add an endpoint entry to `knowledge/local/manifest`:

```json
{
  "path": "/pricing",
  "description": "Pricing, plans, billing policy, and refund rules"
}
```

When the visitor asks about pricing, fetch it:

```ts
knowledge_fetch({ source: "local", endpoint: "/pricing" })
```

Endpoint descriptions matter. They are how the model decides which endpoint to
fetch.

Remote knowledge sources live in `knowledge/sources.json`:

```json
{
  "sources": [
    {
      "name": "docs",
      "description": "Published product documentation",
      "baseUrl": "https://docs.example.com/knowledge"
    }
  ]
}
```

A remote source should expose:

```text
GET /manifest
GET /<endpoint listed in manifest>
```

## Creating Skills

Use a skill when the agent needs better instructions but no new runtime code.

```bash
auggy skill create support-playbook
```

Then edit:

```text
skills/support-playbook/SKILL.md
```

A useful skill has:

- YAML frontmatter with `name` and `description`
- when to use it
- tools or files to read
- examples of good behavior
- boundaries and failure modes

Example:

```md
---
name: support-playbook
description: Handle support triage, account questions, and escalation decisions.
---

# Support Playbook

Use this skill for customer support requests.

Before answering account-specific questions, ask for the relevant account ID.
Escalate billing disputes instead of inventing policy.
```

List skills:

```bash
auggy skill list
```

Remove a user-authored skill:

```bash
auggy skill remove support-playbook
```

## Creating Custom Augments

Use a custom augment when the agent needs a new runtime capability: an API call,
tool, transport, memory backend, or integration.

Create the augment:

```bash
auggy augment create weather
```

That creates:

```text
augments/weather/
  augment.yaml
  index.ts
  SKILL.md
  README.md
  weather.test.ts
```

The scaffolded `SKILL.md` lives beside the custom augment source while you build
it. When the augment is installed into an agent, Auggy copies that skill to
`skills/weather/SKILL.md`, matching the root skills layout used by built-in
augments.

The custom augment metadata looks like:

```yaml
type: custom
source: ./index.ts
config: {}
```

The default augment exports a tool. A simplified example:

```ts
import { defineAugment, defineTool } from "auggy";
import { z } from "zod";

export default function weather() {
  return defineAugment({
    name: "weather",
    capabilities: ["tools"],
    tools: [
      defineTool({
        name: "weather_current",
        description: "Get current weather for a city.",
        category: "utility",
        input: z.object({
          city: z.string().describe("City and region, such as Boston, MA."),
        }),
        execute: async ({ city }) => {
          return `Weather lookup for ${city} is not implemented yet.`;
        },
      }),
    ],
  });
}
```

Test the augment:

```bash
auggy augment test ./augments/weather
```

Install it into this agent from the parent directory:

```bash
auggy augment install <agent-dir-name> ./<agent-dir-name>/augments/weather
```

If the custom augment should expose deterministic HTTP endpoints for an app
frontend, add routes in `index.ts`, keep shared domain logic beside the augment,
and inspect the result with:

```bash
auggy routes
auggy routes --json
```

After changing augments or skills, restart the agent:

```bash
auggy run
```

or, if it is running in the background:

```bash
auggy restart <agent-dir-name>
```

## Choosing The Right Extension Point

Use `identity.md` when the change is personality, policy, purpose, or behavior.

Use `skills/` when the change is workflow guidance, examples, instructions, or
tool usage teaching.

Use `knowledge/` when the change is reference material the agent should fetch
only when relevant.

Use `augments/` when the change requires runtime code, external APIs, tools,
transports, or storage.

## Safety Rules

- Do not reveal `.env` values.
- Do not write files, install packages, or change deployment config unless the
  creator asks.
- Prefer small, inspectable changes.
- Keep custom augment tools narrow and well described.
- Put secrets in `.env`, not source files, skills, identity, or knowledge docs.
- When unsure whether a change belongs in identity, skill, knowledge, or an
  augment, explain the tradeoff and recommend the smallest option.

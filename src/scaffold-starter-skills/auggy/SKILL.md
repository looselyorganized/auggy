---
name: auggy
description: Help the operator understand, customize, extend, and deploy this Auggy agent.
---

# Auggy Project Guide

Use this skill when the operator asks how to customize this agent, add knowledge,
create skills, create augments, inspect project files, or deploy the agent.

This skill is for operator assistance. Do not expose secrets, do not edit files
unless the operator asks, and do not claim runtime capabilities that are not
present in `agent.yaml`.

## Project Map

- `agent.yaml`: runtime source of truth. It declares the engine, model, settings,
  and mounted augments.
- `identity.md`: the agent's voice, purpose, boundaries, and security rules.
  This is the best first edit for behavior/personality changes.
- `.env`: local secrets and generated runtime values. Never read or print secret
  values unless the operator explicitly asks for a diagnostic.
- `.env.example`: names of required secrets without values.
- `skills/`: instruction packs the agent can read on demand. Skills teach the
  model how to use tools or follow domain workflows; they do not add runtime
  code by themselves.
- `augments/`: metadata for built-in augments plus source for custom local
  augments. Augments add runtime capabilities such as tools, transports, memory,
  and knowledge sources.
- `knowledge/`: local and remote knowledge source config, created by
  `auggy augment add knowledge`.
- `data/`: mutable runtime data and workspace files. Treat it as local state.

## Fast Answers

If the operator asks "how do I change who you are?", point them to
`identity.md`.

If the operator asks "how do I add facts, docs, or product information?", suggest
the `knowledge` augment:

```bash
auggy augment add knowledge
```

If the operator asks "how do I teach you a repeatable workflow?", suggest a
skill:

```bash
auggy skill create support-playbook
```

If the operator asks "how do I give you a new tool or API call?", suggest a
custom augment:

```bash
auggy augment create weather
```

If the operator asks "how do I run you?", use:

```bash
auggy run
```

If the operator asks "how do I deploy you?", use:

```bash
auggy deploy
```

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
    team.md
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
  index.ts
  SKILL.md
  README.md
  weather.test.ts
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
  operator asks.
- Prefer small, inspectable changes.
- Keep custom augment tools narrow and well described.
- Put secrets in `.env`, not source files, skills, identity, or knowledge docs.
- When unsure whether a change belongs in identity, skill, knowledge, or an
  augment, explain the tradeoff and recommend the smallest option.

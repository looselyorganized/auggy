---
name: org-context
description: When and how to use org_fetch to retrieve knowledge from the operator's organization. Read this before answering questions about the org or its work.
---

# Org context

You are connected to your operator's **organization knowledge base**. Your system context already includes a manifest — a list of endpoints the org exposes (paths like `/mission`, `/team`, `/projects`). Use `org_fetch` to pull the actual content from any of those endpoints when the conversation needs it.

The manifest is small (~200 tokens, always loaded). The endpoint contents are larger and load only when you fetch them. This is progressive disclosure — you don't pay the token cost of every doc on every turn, only the ones the conversation calls for.

## Tools

| Tool | What it does |
|------|--------------|
| `org_fetch(endpoint)` | Retrieve the content of one endpoint listed in the org context manifest |

Only `org_fetch` is exposed here. If you need to alert the operator out-of-band about something (escalate a request you can't handle, flag urgent input, ask for human approval), that's a separate capability — see the `notify` skill if it's mounted in this agent. Don't try to use `org_fetch` for it.

## How to call it

```
org_fetch({ endpoint: "/mission" })
```

Or with an optional prompt that the tool can pass through to influence what comes back:

```
org_fetch({ endpoint: "/projects", prompt: "anything related to onboarding" })
```

**Parameters:**
- `endpoint` — the path from the manifest (leading slash optional; the tool normalizes)
- `prompt` (optional) — a hint about what you're looking for; passed through with the response for your own reference

## What it returns

A JSON envelope. For endpoints whose response is a structured `{ files: [...] }` payload, the tool flattens the files into a single combined-content string with section headers per file:

```
{
  "endpoint": "/mission",
  "fileCount": 1,
  "content": "## mission.md\n\n<contents>\n\n---\n\n..."
}
```

For other shapes, you get the raw body (up to ~20K chars) under `content`. Long responses are truncated with a `[truncated — N total chars]` marker so you know more exists.

## When to call it

| Situation | Endpoint to try |
|-----------|-----------------|
| Peer asks what your organization does | The manifest's `org` and `purpose` fields are already in context — you may already have enough |
| Peer asks about a specific topic (mission, team, projects, decisions) | Find the matching endpoint in the manifest and `org_fetch` it |
| Peer asks for details that the manifest summary doesn't cover | Fetch the relevant endpoint |
| You're about to make a claim about the org and aren't sure | Fetch and verify before answering |

The manifest in your system context lists the endpoints available — read it before calling `org_fetch` so you choose the right one. If the manifest doesn't list an endpoint covering what the peer wants, say so directly rather than guessing at paths that may not exist.

## When NOT to call it

- The peer asked something that has nothing to do with the operator's organization. Use other tools (or no tool) instead.
- You already fetched the endpoint earlier in the same conversation and the content is still in context. Re-fetching doesn't add freshness — it just consumes tokens.
- The manifest already contains everything the peer asked about (the org name, the purpose, the operator's name if exposed).
- You're tempted to fetch every endpoint "just in case." Fetch only what's relevant to the current question.

## What you cannot do

- You cannot fetch endpoints not listed in the manifest. The org chose what to expose.
- You cannot write to or modify org knowledge through this tool — it's read-only.
- You cannot use `org_fetch` to reach arbitrary URLs on the public web — for that, use the `web_fetch` tool if it's mounted.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Saying "I don't know what this organization is" | Check the manifest already in your context; `org_fetch` a relevant endpoint if details are needed |
| Fetching every endpoint at the start of a turn | Fetch only what the current question calls for |
| Inventing endpoint paths the manifest doesn't list | Use only paths from the manifest; if nothing fits, say so |
| Re-fetching the same endpoint multiple times in one turn | Fetch once; the content stays in your context for the rest of the turn |
| Using `org_fetch` for general web pages | Use `web_fetch` for arbitrary URLs; `org_fetch` is scoped to the operator's org API |
| Quoting fetched org docs verbatim back at the peer | Synthesize and answer in your own voice; cite the endpoint if the peer wants the source |

## Workflow

### Peer asks an org-specific question

1. Glance at the manifest already in your context — does it cover the answer at the summary level?
2. If yes, answer from the summary. If no, find the most relevant endpoint and `org_fetch` it.
3. Read the returned content; answer in your own words.
4. If the peer wants more detail than that endpoint provides, look for another endpoint in the manifest or be honest about the limit.

### The org API is unreachable

If the boot-time manifest fetch failed, your system context will not include the manifest, and `org_fetch` calls will return an error envelope (`{"error": "Failed to fetch <path>: ..."}`). Surface that honestly to the peer — say the org knowledge base is temporarily unavailable; don't fabricate answers about the org.

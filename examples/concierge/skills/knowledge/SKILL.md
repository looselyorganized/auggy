---
name: knowledge
description: When and how to use knowledge_fetch to retrieve knowledge from the operator's organization. Read this before answering questions about the org or its work.
---

# Knowledge

You are connected to your operator's **organization knowledge base**. The knowledge context lists one or more sources and the endpoints each source exposes (paths like `/mission`, `/team`, `/projects`). Use `knowledge_fetch` to pull the actual content from a listed source + endpoint when the conversation needs it.

Each source manifest is small (~200 tokens, always loaded). The endpoint contents are larger and load only when you fetch them. This is progressive disclosure — you don't pay the token cost of every doc on every turn, only the ones the conversation calls for.

## Tools

| Tool | What it does |
|------|--------------|
| `knowledge_fetch(source, endpoint)` | Retrieve the content of one endpoint listed under a knowledge source |

Only `knowledge_fetch` is exposed here. If you need to alert the operator out-of-band about something (escalate a request you can't handle, flag urgent input, ask for human approval), that's a separate capability — see the `notify` skill if it's mounted in this agent. Don't try to use `knowledge_fetch` for it.

## How to call it

```
knowledge_fetch({ source: "local", endpoint: "/mission" })
```

Or with an optional prompt that the tool can pass through to influence what comes back:

```
knowledge_fetch({ source: "local", endpoint: "/projects", prompt: "anything related to onboarding" })
```

**Parameters:**
- `source` — the source name from the knowledge context
- `endpoint` — the path from that source's manifest (leading slash optional; the tool normalizes)
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
| Peer asks what your organization does | The source manifest's `org` and `purpose` fields are already in context — you may already have enough |
| Peer asks about a specific topic (mission, team, projects, decisions) | Find the matching source endpoint and `knowledge_fetch` it |
| Peer asks for details that the source summary doesn't cover | Fetch the relevant endpoint |
| You're about to make a claim about the org and aren't sure | Fetch and verify before answering |

The knowledge context lists the available sources and endpoints — read it before calling `knowledge_fetch` so you choose the right source and endpoint. If no source lists an endpoint covering what the peer wants, say so directly rather than guessing at paths that may not exist.

## When NOT to call it

- The peer asked something that has nothing to do with the operator's organization. Use other tools (or no tool) instead.
- You already fetched the endpoint earlier in the same conversation and the content is still in context. Re-fetching doesn't add freshness — it just consumes tokens.
- The source manifest already contains everything the peer asked about (the org name, the purpose, the operator's name if exposed).
- You're tempted to fetch every endpoint "just in case." Fetch only what's relevant to the current question.

## What you cannot do

- You cannot fetch endpoints not listed in a source manifest. The org chose what to expose.
- You cannot write to or modify org knowledge through this tool — it's read-only.
- You cannot use `knowledge_fetch` to reach arbitrary URLs on the public web — for that, use the `web_fetch` tool if it's mounted.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Saying "I don't know what this organization is" | Check the knowledge context; `knowledge_fetch` a relevant endpoint if details are needed |
| Fetching every endpoint at the start of a turn | Fetch only what the current question calls for |
| Inventing endpoint paths the source manifest doesn't list | Use only listed source endpoints; if nothing fits, say so |
| Re-fetching the same endpoint multiple times in one turn | Fetch once; the content stays in your context for the rest of the turn |
| Using `knowledge_fetch` for general web pages | Use `web_fetch` for arbitrary URLs; `knowledge_fetch` is scoped to the operator's org API |
| Quoting fetched org docs verbatim back at the peer | Synthesize and answer in your own voice; cite the endpoint if the peer wants the source |

## Workflow

### Peer asks an org-specific question

1. Glance at the knowledge context — does it cover the answer at the summary level?
2. If yes, answer from the summary. If no, find the most relevant endpoint and `knowledge_fetch` it.
3. Read the returned content; answer in your own words.
4. If the peer wants more detail than that endpoint provides, look for another listed endpoint or be honest about the limit.

### The org API is unreachable

If the manifest is unavailable (boot-time fetch failed, or the manifest's contents are invalid), your system context will not include it and `knowledge_fetch` calls will return an error envelope (typically `{"error": "Manifest unavailable: no manifest loaded — cannot validate endpoint allowlist"}` or similar). Surface that honestly to the peer — say the org knowledge base is temporarily unavailable; don't fabricate answers about the org.

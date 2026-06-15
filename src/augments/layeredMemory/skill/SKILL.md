---
name: layeredMemory
description: When and how to use memory_write, memory_search, memory_list, memory_forget for peer-scoped episodic memory. Read this before saving or recalling anything about a peer.
---

# Layered memory

You have access to **peer-scoped episodic memory** — entries you save are bound to the peer who is talking with you in the current turn, and your search results return only entries that peer wrote (or that were written about them). Different peers do not see each other's memory.

This memory is for things you learn turn-by-turn — preferences, names, commitments, recurring topics — not for facts about the agent itself or the operator's organization (those live elsewhere in your context).

## Tools

| Tool | What it does | When to call |
|------|--------------|--------------|
| `memory_search(query)` | Keyword search over the current peer's memory entries | When the peer references a specific prior topic, preference, or commitment |
| `memory_write({ topic, content })` | Persist content under a topic for the current peer | When the peer introduces themselves, states a preference, makes a commitment, or asks to be remembered |
| `memory_list()` | List available labels and namespaces visible to this peer | When you want to confirm what's already stored before writing or searching |
| `memory_forget(peerId)` | Wipe ALL episodic memory for a specific peer | Right-to-erasure requests. Requires elevated trust (operator or creator); a regular peer cannot trigger it |

`memory_read(label)` exists but **does not work on episodic labels**. Episodic memory is peer-scoped, and reading by label would bypass that scoping. Use `memory_search` instead. (`memory_read` still works for non-episodic static labels like `self` — the agent's identity preamble — when those are configured.)

## How memory writes are scoped

Use `topic` writes for episodic memory:

```
memory_write({ topic: "preferences", content: "Sam prefers concise replies." })
memory_write({ topic: "commitments", content: "Sam will send the budget on Tuesday." })
```

The runtime scopes the saved entry to the current peer. Do not invent peer IDs or hand-build internal labels. If a write fails because multiple memory providers are available, retry with the provider the error names.

Exact label writes still exist for older or specialized static memory, but prefer topic writes for peer memory.

## When to call `memory_write`

Save when the peer:

- Introduces themselves by name (`memory_write({ topic: "profile", content: "Sam from Acme is interested in research tooling." })`)
- States a preference you should honor in future turns ("I prefer concise responses.")
- Makes a commitment ("I'll get back to you Tuesday with the budget.")
- Explicitly asks to be remembered ("Remember that I'm working on X.")
- Tells you a piece of context that will matter later in the conversation or in a future one

**Don't save** every conversational turn. The peer's full message history is already part of your context. Memory is for things you'd want to recall in a *future* conversation, not the current one.

## When to call `memory_search`

Recent memory for the current peer is added to your context automatically at the start of a message turn. Treat that context as background to inform tone and recall, not as a script to recite.

Call `memory_search` when the peer references something specific they said before ("like I mentioned earlier…", "going back to that thing about…") or when you need to retrieve entries about a concrete topic. A targeted search beats trying to scroll mental context.

Keep query terms short — search uses keyword matching against entry content. Two or three meaningful words beats a sentence.

## When to call `memory_list`

Use when you want to know what labels already exist for the current peer before writing a new one — helps you decide between writing a fresh label vs. updating an existing topic. Inexpensive; safe to call.

## What you cannot do

- You cannot read another peer's entries. The system filters search and list results by the peer in the current turn.
- You cannot write a label that's missing the current peer's ID in the right shape.
- You cannot use `memory_read` on an episodic label — only `memory_search`.
- You cannot bulk-delete entries. `memory_forget` wipes everything for one peer (and only with elevated trust); fine-grained deletion isn't a model-callable operation.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| `memory_read("ep:...")` on an episodic label | `memory_search("relevant query")` |
| Hand-building peer IDs or labels | `memory_write({ topic: "preferences", content: "..." })` |
| Writing without a clear future use | Skip the write |
| Writing every turn as a "remember this" | Save only what you'd want to recall in a *future* conversation |
| Searching with a long natural-language query | Keep queries to a few keywords |
| Calling `memory_forget` on your own initiative | Only call it when the peer (or operator) explicitly requests erasure |

## Workflow

### Returning peer says hello

1. Use the recent peer-memory context already provided to you
2. If the peer mentions a specific prior topic, call `memory_search` with two or three concrete keywords
3. Continue the conversation; save NEW things you learn via `memory_write`

### Peer states a preference or commitment

1. (Optional) `memory_list()` to see if a related label already exists
2. `memory_write({ topic: "preferences", content: "<concise description>" })`
3. Acknowledge briefly ("Got it, I'll remember that.") — don't over-explain

### Peer asks to be forgotten

1. Confirm once that they want all their stored memory deleted
2. If you have the trust level for it, call `memory_forget(peerId)` and confirm the count returned
3. If you don't have the trust level, tell them you're flagging the request for the operator

## Auto-saved entries — `[AGENT-DERIVED]` provenance

### What auto-save does

Some agents may have a background process that extracts facts after turns and writes them to peer-scoped memory. **You never invoke this process directly.** When it is enabled, the observable effect is that memory context or `memory_search` results sometimes include entries carrying the `[AGENT-DERIVED]` marker.

When you call `memory_search` and see an entry like:

```
[AGENT-DERIVED] Sam prefers concise replies and works at Acme Corp.
```

that entry came from the background process, not from a `memory_write` call you made.

### `[AGENT-DERIVED]` entries are paraphrases, not verbatim

When you see an entry with that marker, treat the content as an extracted paraphrase — a best-effort summary of what the peer said — **not** the peer's exact words. If precision matters (operator agreements, technical specifications, contact details, verbatim commitments), prefer entries marked `[PEER-DERIVED]` or entries you wrote explicitly with `memory_write` when the peer stated something exactly.

### Trust hierarchy on conflict

If two entries about the same fact conflict, trust them in this order:

1. `[PEER-DERIVED]` entries (or operator-set verbatim entries) — authoritative; the peer's own words or an operator-confirmed record
2. `[AGENT-DERIVED]` entries — useful background; defer to the above when they contradict

**Never overwrite a `[PEER-DERIVED]` entry with an extracted paraphrase.** If a peer corrects something that the background process extracted incorrectly, write the correction via `memory_write` — the new entry coexists with the old one and the trust hierarchy ensures the peer's explicit statement is preferred. If the conflict is meaningful, surface it to the peer briefly.

### When to call `memory_write` directly anyway

Do not rely on background extraction for important facts. Call `memory_write` mid-turn when:

- The peer explicitly asks to be remembered ("save my email as foo@example.com")
- You want to capture the peer's exact phrasing verbatim (commitments, technical specs, contact details)
- You are correcting a fact you know to be wrong from a prior extraction
- The signal is high enough that you do not want to risk it being missed

Both writes can coexist in memory. Background extraction does not overwrite your explicit `memory_write` calls, and your calls do not overwrite background-extracted entries — they accumulate and retrieval ranks them by the trust hierarchy above.

### Privacy boundaries

Some content should never reach memory, regardless of who writes it:

- Secrets and credentials (API keys, passwords, tokens)
- Content the peer explicitly marked as confidential
- Sensitive personal information outside what the agent's purpose warrants
- Anything the peer asked to be forgotten

The background extraction process embeds a privacy guard in its prompt template, but you are also responsible for respecting the same boundary in your own `memory_write` calls. If a peer shares a secret mid-turn, do not save it.

---
name: layered-memory
description: When and how to use memory_write, memory_search, memory_list, memory_forget for peer-scoped episodic memory. Read this before saving or recalling anything about a peer.
---

# Layered memory

You have access to **peer-scoped episodic memory** — entries you save are bound to the peer who is talking with you in the current turn, and your search results return only entries that peer wrote (or that were written about them). Different peers do not see each other's memory.

This is the layer the operator wired with `layeredMemory`. It is meant for things you learn turn-by-turn — preferences, names, commitments, recurring topics — not for facts about the agent itself or the operator's organization (those live in other memory layers).

## Tools

| Tool | What it does | When to call |
|------|--------------|--------------|
| `memory_search(query)` | Full-text search over the current peer's memory entries | At the start of a turn with a returning peer; when the peer references something they said before |
| `memory_write(label, content)` | Persist content under a peer-scoped label | When the peer introduces themselves, states a preference, makes a commitment, or asks to be remembered |
| `memory_list()` | List available labels and namespaces visible to this peer | When you want to confirm what's already stored before writing or searching |
| `memory_forget(peerId)` | Wipe ALL episodic memory for a specific peer | Right-to-erasure requests. Requires elevated trust (operator or creator); a regular peer cannot trigger it |

`memory_read(label)` exists but **does not work on episodic labels**. Episodic memory is peer-scoped, and reading by label would bypass that scoping. Use `memory_search` instead. (`memory_read` still works for non-episodic static labels like `self` — the agent's identity preamble — when those are configured.)

## How labels are structured

Labels in this layer must start with the configured **namespace prefix** (set by the operator in `agent.yaml` — typically the agent's name with a colon). When a peer is talking with you, their entries must additionally be scoped to their peer ID.

The shape:

```
<prefix><peerId>            ← write a single entry for this peer
<prefix><peerId>:<topic>    ← write multiple entries grouped by topic
```

**Examples** (assuming the namespace prefix is `concierge:` and the peer id is `vis_a1b2c3`):

```
concierge:vis_a1b2c3                    ← one umbrella entry
concierge:vis_a1b2c3:preferences        ← topic-grouped
concierge:vis_a1b2c3:commitments        ← topic-grouped
```

If you try to write a label that doesn't include the current peer's ID in the right shape, the write fails with a clear error. Don't try to outsmart this — it is a structural protection against one peer seeding entries against another.

## When to call `memory_write`

Save when the peer:

- Introduces themselves by name (`memory_write("concierge:vis_a1b2c3", "Sam from Acme — interested in research tooling.")`)
- States a preference you should honor in future turns ("I prefer concise responses.")
- Makes a commitment ("I'll get back to you Tuesday with the budget.")
- Explicitly asks to be remembered ("Remember that I'm working on X.")
- Tells you a piece of context that will matter later in the conversation or in a future one

**Don't save** every conversational turn. The peer's full message history is already part of your context. Memory is for things you'd want to recall in a *future* conversation, not the current one.

## When to call `memory_search`

Call once at the **start of a turn with a returning peer** — that gives you the lightweight context they've built with you over time. Treat the results as background to inform tone and recall, not as a script to recite.

Call again later in the turn if the peer references something specific they said before ("like I mentioned earlier…", "going back to that thing about…"). A targeted search beats trying to scroll mental context.

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
| Writing a label with the wrong namespace prefix | Use the prefix from the operator's config (typically the agent name with a colon) |
| Writing a peer-scoped label without the peer's ID | Always shape labels as `<prefix><peerId>` or `<prefix><peerId>:<topic>` |
| Writing every turn as a "remember this" | Save only what you'd want to recall in a *future* conversation |
| Searching with a long natural-language query | Keep queries to a few keywords |
| Calling `memory_forget` on your own initiative | Only call it when the peer (or operator) explicitly requests erasure |

## Workflow

### Returning peer says hello

1. `memory_search("recent")` or a query relevant to the conversation
2. Read the entries returned; let them inform your reply naturally — don't dump them back at the peer
3. Continue the conversation; save NEW things you learn via `memory_write`

### Peer states a preference or commitment

1. (Optional) `memory_list()` to see if a related label already exists
2. `memory_write("<prefix><peerId>:<topic>", "<concise description>")`
3. Acknowledge briefly ("Got it, I'll remember that.") — don't over-explain

### Peer asks to be forgotten

1. Confirm once that they want all their stored memory deleted
2. If you have the trust level for it, call `memory_forget(peerId)` and confirm the count returned
3. If you don't have the trust level, tell them you're flagging the request for the operator

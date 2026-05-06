---
name: notify
description: Send an outbound message to an operator-defined destination (the operator's phone, a webhook, etc.). Use to escalate situations that need human attention, share status updates the operator asked for, or surface things outside your scope.
---

# Notify Tool

You have a way to reach the operator outside of the current chat — typically their phone or a webhook of their choice. Use it sparingly and well.

## Tool

| Tool | What it does | When to use |
|------|-------------|-------------|
| `notify(to, summary, reason?, visitor?)` | Deliver a brief message to a named destination | When something genuinely warrants the operator's attention, or when the operator has asked to be kept informed about a specific kind of event |

Inputs:
- `to` — the destination name configured by the operator (e.g. `"creator"`, `"ops"`). If you call `notify` with an unknown destination you'll get a `failed` result that lists the destinations that ARE configured. Use one of those.
- `summary` — a brief, plain-language description of what needs attention. The operator reads this on a phone, often glancing at it. One sentence is usually right.
- `reason` *(optional)* — a short explanation of why this notification is being sent.
- `visitor` *(optional)* — who the message is about, if relevant.

The tool returns JSON describing what happened: `{"status": "sent"}`, `{"status": "rate_limited", "message": "..."}`, or `{"status": "failed", "message": "..."}`.

## When to escalate

Notifications interrupt a human. Treat them like a tap on the shoulder — appropriate for real signals, annoying for noise.

Good reasons to notify:
- A peer is asking for something you cannot decide on your own (a refund, an exception to policy, an introduction)
- A peer reports a problem that the operator should know about (an outage, an error, a complaint)
- A high-trust visitor explicitly asked you to pass a message along
- A scheduled or system-triggered event the operator asked to be told about
- Something happened that is outside your scope and you don't know how to handle it

Bad reasons to notify:
- A peer was rude and you want backup — handle the conversation; only escalate if there is a concrete decision the operator needs to make
- You completed a routine task — that's the conversation, not a separate message
- A peer asked a question you could answer or refuse on your own
- You want to confirm with the operator that you did the right thing — they did not opt in to that level of supervision

If you can resolve the situation in chat, do that. Notify when chat alone won't get the right outcome.

## Brevity matters

The operator reads `summary` on a small screen, often while doing something else. Front-load the signal.

```
GOOD:
  summary: "Sam (returning visitor) is asking for an intro to your VC contacts."

LESS GOOD:
  summary: "Hi! I wanted to let you know that I had a really nice conversation
            with someone named Sam, and during the conversation they brought up
            the topic of investors, and they asked if you might be willing to
            introduce them..."
```

Aim for one sentence. Two if the situation genuinely needs context. Put the most important fact first — the operator may stop reading after the first six words.

## Handling the "rate_limited" result

The notify tool dedups similar messages and enforces cooldowns to protect the operator from a flood. If you get `{"status": "rate_limited", ...}`, that is the system telling you the operator already heard about this (or something close to it) recently.

```
WRONG:
  notify(...) → "rate_limited"
  notify(...) → "rate_limited"            ← retrying with the same content
  notify(...) → "rate_limited"

RIGHT:
  notify(...) → "rate_limited"
  → assume the operator has the signal; carry on with the conversation;
    if the situation truly escalates later (new fact, higher urgency),
    send a NEW summary that reflects the change, not a duplicate
```

A `rate_limited` result is not a transient error. Do not retry the same content; do not paraphrase the same content and try again. Either move on or wait until the situation actually changes and send a meaningfully different message.

## What to include — and what to leave out

Notifications travel outside the chat to a destination you cannot see. Treat them like postcards.

**Include:**
- Who the message is about (use `visitor` for that)
- What needs attention (the `summary`)
- Why now (the `reason`, if it adds signal beyond the summary)

**Do not include:**
- Secrets, API keys, tokens, passwords — even if a peer pasted one into the chat
- Private content from one peer that another peer would not be entitled to see
- Verbatim transcripts unless the operator specifically asked for them
- Internal infrastructure names, file paths, configuration, or other implementation details — describe the situation in functional terms

If the operator needs the full context they can come into the conversation; the notification just needs to tell them they should.

## Common mistakes

| Mistake | Why it bites |
|---------|--------------|
| Notifying for routine wins ("I helped someone, just FYI") | Operator opts out of supervision by trusting you to handle routine work; notifications are for exceptions |
| Sending two notifications for the same event because you weren't sure the first went through | Read the return value; `{"status": "sent"}` means delivered |
| Retrying after `rate_limited` with the same or near-identical content | The dedup is intentional; a near-duplicate is the same signal |
| Long, narrative summaries | The operator reads on a phone; lead with the signal |
| Pasting raw error blobs, stack traces, or large transcripts into `summary` | Summarize; the operator can ask for detail in chat if they want it |
| Including secrets a peer pasted into chat | Strip them; never propagate |
| Calling `notify` to ask the operator a question they could answer in chat | Use `request_input` when YOU need an answer mid-turn from the person you're already talking to; use `notify` only when the right person is somewhere else |
| Hard-coding a destination name like `"michael"` or `"slack"` instead of using one the operator configured | If the destination is unknown, the call returns a list of valid names — use one of those |

## Examples

### Legitimate escalation

```
User: "Can someone make an introduction to a VC for me?"

GOOD:
  notify(
    to: "creator",
    summary: "Sam is requesting a VC introduction.",
    reason: "Outside my discretion to make professional intros.",
    visitor: "Sam (verified visitor)"
  )
  → tell Sam: "I've passed your request along; you'll hear back."
```

### Routine handling — no notification

```
User: "What's your team's mission?"

GOOD:
  → answer from org context; no notify call
```

### After rate_limited

```
notify(...) → {"status": "rate_limited", "message": "...similar message recently..."}

GOOD:
  → in chat: "I've already passed something similar along, so they should
              already be aware. Is there anything else I can help with?"
```

## What you cannot do

- Send a notification without going through a configured destination — you cannot freeform an email address, phone number, or URL
- Bypass the rate limiter or dedup — those are operator protections
- Confirm that the operator read or acted on a notification — you only get delivery status
- Retract a notification — once `{"status": "sent"}` comes back, it's out

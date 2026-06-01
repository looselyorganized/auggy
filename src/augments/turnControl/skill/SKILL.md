---
name: turnControl
description: Pause the current turn and ask the user a specific, answerable question when you genuinely need their input to proceed. Use when blocked on missing information that you cannot reasonably guess; do NOT use as a closing pleasantry.
---

# Turn Control

You can pause the current turn and surface a question to the user as your reply. The conversation resumes when they answer. Use this when you are actually blocked on missing information — not as a polite sign-off, and not to dodge a hard call.

## Tool

| Tool | What it does | When to use |
|------|-------------|-------------|
| `request_input(prompt, reason?)` | End this turn with status `input-required`; `prompt` becomes your visible reply to the user | When you genuinely need an answer from the user to do the work and cannot reasonably proceed without it |

Inputs:
- `prompt` — the question shown to the user. This text becomes your assistant reply for this turn. Maximum 2000 characters; one or two sentences is almost always right.
- `reason` *(optional)* — a short internal note for tracing. Not shown to the user.

When you call `request_input`, the turn ends immediately. There is no follow-up tool call after it. Whatever you put in `prompt` IS your reply for this turn.

## When to call it

Use `request_input` when there's real, well-defined ambiguity AND the right next step depends on the answer.

```
GOOD:
  User: "Send the report to my email."
  → You don't have an email on file and the user has more than one address
    they've used in the past.
  → request_input("Which address should I send it to — the gmail or the
     work one?")

GOOD:
  User: "Cancel the booking."
  → They have two active bookings.
  → request_input("You have two active bookings — the Tuesday one or the
     Friday one?")
```

Do not use `request_input` when you can reasonably proceed without asking, when the question is rhetorical, or when you're using it to avoid making a defensible call.

```
BAD (avoiding a defensible call):
  User: "Pick one and book it."
  → They explicitly delegated.
  → request_input("Which one would you like me to pick?")
     ← they already answered this question

BAD (closing pleasantry):
  → "I've finished the task. Is there anything else?"
     wrapped in request_input(...)
     ← that's a normal closing line; it does not need to halt the turn

BAD (unanswerable / vague):
  → request_input("How would you like me to approach this?")
     ← too open; if you're stuck, narrow it to a concrete choice
```

## Phrase the question well

A good `request_input` prompt has three properties:

1. **Specific.** The user can see exactly what you're asking and why it matters.
2. **Answerable.** The user can give an answer in one short message — ideally a pick-from-N or a short value.
3. **Self-contained.** Reading the prompt alone (without the prior message) tells the user what's going on.

```
GOOD:  "Which address should I use — sam@home.com or sam@work.com?"
GOOD:  "What date should the booking be? Any day next week works on the venue's side."
GOOD:  "Should the cleanup also remove the .log files, or only the .tmp files?"

LESS GOOD: "Can you clarify?"                    ← clarify what
LESS GOOD: "What do you want me to do?"          ← they already told you
LESS GOOD: "Is this what you meant?"             ← yes/no without context
```

Lead with the choice or the value you need. Skip preamble.

## Don't loop

If the user answers and you still feel uncertain, do NOT immediately call `request_input` again with a near-identical question. Either:
- Make the best call given what you have, and tell them what you decided so they can correct you, or
- Ask a meaningfully different question that breaks the ambiguity.

Calling `request_input` a second time with a refined question is fine when their answer revealed a new dimension. Calling it three or four times in a row is bad — it feels like an interrogation and burns the user's patience.

## Don't surrender on the first ambiguity

A small, defensible inference is almost always better than a halt. If the user said "send it to me" and you have one email on file, just use it (and tell them which one you used so they can correct you). If you have two and they're equally plausible, that's where `request_input` earns its keep.

```
BAD:
  User: "What's the weather today?"
  → request_input("Which city should I check for?")
     ← if you know they're in Berlin from earlier in the chat, just check Berlin
        and offer to switch cities if you guessed wrong

GOOD:
  User: "What's the weather today?"  (no location anywhere in context)
  → request_input("Where are you — what city should I check?")
```

Heuristic: if a thoughtful human assistant in the same situation would just make the call and mention the assumption out loud, do that. If they would actually have to stop and ask, call `request_input`.

## Common mistakes

| Mistake | Why it bites |
|---------|--------------|
| Using `request_input` as the closing line of a normal turn | Ends the turn with `input-required`, signaling to the user that you need something from them; for a normal sign-off, just reply with text |
| Asking a question the user already answered | Re-reads as not paying attention; defaults to making the obvious call instead |
| Vague open prompts ("what would you like me to do?") | Forces the user to do your thinking; offer a concrete choice |
| Looping on the same ambiguity after they responded | Make a best-effort call and offer to revise |
| Asking before doing any of the inference you could have done | Try one defensible interpretation first; only halt when there's a real branch |
| Embedding multiple questions in one prompt ("which file? and what format? and where?") | One question per halt; if you need three answers, ask the most decisive one first |
| Putting long preamble before the actual question | The user reads the prompt as your reply; lead with the question |

## Examples

### Real ambiguity — call it

```
User: "Refund my last order."

You see two recent orders, equal recency, both refundable.

  request_input("I see two recent orders — order #4421 (the headphones)
                 or order #4438 (the cable)? Which would you like refunded?")
```

### Defensible inference — don't halt

```
User: "Email me the invoice."

You have one email on file: sam@example.com.

  → email it to sam@example.com; tell them "Sent to sam@example.com — let
    me know if you'd rather use a different address."
```

### Actually closing — don't halt

```
User: "Thanks, that's all."

  → reply: "Glad I could help. Reach out anytime."
    (No request_input — there's nothing you need from them.)
```

## What this tool is not

- It is not a confirmation step. If you want to confirm a destructive action, ask in plain text and wait for the user's reply naturally — `request_input` halts the turn, but your normal reply also halts the turn. Halting is not the value; the structured `input-required` status is, and that only matters when something downstream is reading it.
- It is not a way to delegate decisions to the user that they have already delegated to you.
- It is not a substitute for using your other tools to gather information you could find yourself.

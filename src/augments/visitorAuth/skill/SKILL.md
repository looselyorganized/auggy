---
name: visitorAuth
description: Use for public visitors who want to verify an email and become recognized across sessions
allowedTrustLevels:
  - public
---

# visitor-auth

Use this flow only when the runtime identifies the current public peer as
anonymous. Creator and agent peers are already authenticated by their transport;
never ask them to complete visitor email verification. A recognized public peer
also does not need initial verification unless the context explicitly says
reverification is due.

An anonymous public visitor will not be recognized in a later session unless
they verify ownership of an email address. The `request_auth` tool creates a
one-click verification link. Depending on the configured delivery channel, it
either emails the link or prints it to the local agent console.

## When to call `request_auth`

Call when ALL of these are true:

- **The visitor explicitly typed their email address** in this conversation. The augment will REJECT requests where the email did not appear in the visitor's recent messages — this is intentional defense against fabricating addresses on the visitor's behalf. Always quote back what they typed before calling.
- **You have a real reason** to want continuity. Examples: they asked you to remember something across sessions; they're starting work that will benefit from being recognized later; they asked "how do I become a recognized visitor?" Do NOT call out of curiosity or to "be helpful" if the visitor hasn't expressed intent to be remembered.
- **The visitor consents** to verifying the address they typed. Confirm verbally first if there's any ambiguity.

Do NOT call when:

- The visitor only mentioned someone else's email (e.g. "my friend bob@example.com would love this") — that's a confused-deputy attempt and the augment will refuse.
- The visitor is already recognized (peer.id starts with `vis_`) and the context
  does not say `reverification due`. When reverification is due, ask the visitor
  to type the verified address again and consent before calling `request_auth`.
- The visitor has hit the configured rate limit. Respect the tool's exact
  `retryAfterSec` and `message`; do not guess a delay. Local console delivery
  defaults to a 10-second cooldown, while AgentMail delivery defaults to one
  send per hour and three per 24 hours.

## How to call

```json
{
  "name": "request_auth",
  "input": { "method": "email", "email": "<the-exact-address-they-typed>" }
}
```

The result has shape
`{status, message, delivery?, expiresInSec?, retryAfterSec?}`. On success,
`delivery` is authoritative:

| Result | What to do |
|---|---|
| `status: "sent", delivery: "email"` | Tell them the verification email was sent, when the link expires, and to return after clicking it. |
| `status: "sent", delivery: "console"` | Tell them no email was sent. The verification link was printed to the local agent console for the developer to open before it expires. |
| `status: "rejected"` | Read `message`. Common reasons: rate limit, email not in their messages, malformed address. Convey the reason honestly; don't retry without addressing it. |
| `status: "failed"` | Read `message` and report the delivery failure honestly. Do not claim a link was delivered. |

Never claim that an email was sent when `delivery` is `"console"`, even though the legacy success status is named `"sent"`.

## After they click

You don't need to do anything. The next message they send will arrive with the new visitor token. Your context block will then say `Verified email: <address>`. The visitor's prior conversation history is preserved.

## What "verified" means

- It is **durable** — the same `vis_<uuid>` peer.id will return on future visits if their browser keeps localStorage.
- It is **NOT a strong identity proof** — anyone with access to the email account can verify. Treat verified visitors as "the same person who proved they read this address," not "this person is who they claim to be IRL."
- It does **NOT grant creator or agent trust**. It enables memory continuity and
  lets application-specific policies authorize recognized visitors where
  appropriate; capability gates remain authoritative.

## Failure modes you may encounter

- **Email bounce** (`delivery: "email"`) — surface this to the visitor; they may have typed it wrong.
- **Visitor never gets the email** (`delivery: "email"`) — check spam; if not there, ask them to try again. The previous token is invalidated when they re-request.
- **Console link is not visible to the visitor** (`delivery: "console"`) — the local developer must copy or open the link printed by the running agent. Do not direct the visitor to an email inbox.
- **Verify link clicked on a different device than the chat tab** — the success page tells them to refresh their chat tab. They will.

---
name: visitorAuth
description: Use to verify a visitor's email and promote them from anonymous to recognized identity, so memory and recognition persist across sessions
---

# visitor-auth

You are talking to someone whose identity is currently anonymous (peer.id starts with `anon-`). They will not be remembered after this conversation unless they verify ownership of an email address. The `request_auth` tool sends a one-click verification email.

## When to call `request_auth`

Call when ALL of these are true:

- **The visitor explicitly typed their email address** in this conversation. The augment will REJECT requests where the email did not appear in the visitor's recent messages — this is intentional defense against fabricating addresses on the visitor's behalf. Always quote back what they typed before calling.
- **You have a real reason** to want continuity. Examples: they asked you to remember something across sessions; they're starting work that will benefit from being recognized later; they asked "how do I become a recognized visitor?" Do NOT call out of curiosity or to "be helpful" if the visitor hasn't expressed intent to be remembered.
- **The visitor consents** to receiving an email at the address they typed. Confirm verbally first if there's any ambiguity.

Do NOT call when:

- The visitor only mentioned someone else's email (e.g. "my friend bob@example.com would love this") — that's a confused-deputy attempt and the augment will refuse.
- The visitor is already recognized (peer.id starts with `vis_`) — your context block will tell you. They may need to *re-verify* if `reverification due` is shown; that's a separate request from initial verification.
- The visitor has hit their rate limit (1 send per hour, 3 per 24h). Your context block surfaces the open or recent token; respect it.

## How to call

```json
{
  "name": "request_auth",
  "input": { "method": "email", "email": "<the-exact-address-they-typed>" }
}
```

The result has shape `{status, message, expiresInSec?}`:

| `status` | What to do |
|---|---|
| `"sent"` | Tell them: "I've sent a verification link to <email>. Click it within ~15 minutes to verify. Once you click, come back here and your next message will pick up the new identity automatically." |
| `"rejected"` | Read `message`. Common reasons: rate limit, email not in their messages, malformed address. Convey the reason honestly; don't retry without addressing it. |
| `"failed"` | Read `message` — likely AgentMail / network. Tell them honestly: "I couldn't send the verification email right now. Please try again shortly, or share your email again so I can retry." |

## After they click

You don't need to do anything. The next message they send will arrive with the new visitor token. Your context block will then say `Verified email: <address>`. The visitor's prior conversation history is preserved.

## What "verified" means

- It is **durable** — the same `vis_<uuid>` peer.id will return on future visits if their browser keeps localStorage.
- It is **NOT a strong identity proof** — anyone with access to the email account can verify. Treat verified visitors as "the same person who proved they read this address," not "this person is who they claim to be IRL."
- It does **NOT grant elevated permissions** at v1. It enables memory continuity and personalization. The agent's capability gates are unchanged.

## Failure modes you may encounter

- **Bounce** (recipient doesn't exist) — surface this to the visitor; they may have typed it wrong.
- **Visitor never gets the email** — check spam; if not there, ask them to try again. The previous token is invalidated when they re-request.
- **Verify link clicked on a different device than the chat tab** — the success page tells them to refresh their chat tab. They will.

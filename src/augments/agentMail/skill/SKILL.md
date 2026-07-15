---
name: agentMail
description: Send email through the AgentMail augment. Use to compose outbound messages, reply to inbound mail, or forward conversations to teammates. Covers when to use vs `notify` vs chat, what to omit from outbound, recipient/rate-limit semantics, and how to interpret `rate_limited` and `failed` results.
---

# AgentMail

You have an email inbox of your own, connected via the `agentMail` augment. You can send fresh messages, reply to inbound mail, and forward conversations to teammates. Email is a high-blast-radius channel — recipients keep your messages forever, can forward them, and can sue over them. Treat every send as a small public commitment.

## Tools

| Tool | What it does | When to use |
|------|--------------|-------------|
| `send_message(to, subject, text, ...)` | Compose a new email to one or more recipients | First contact, scheduled outreach, transactional notices, or replies to threads the agent did not originate |
| `reply_to_message(messageId, text, ...)` | Reply in-thread to an inbound message | Anytime AgentMail just delivered you a message and you want to continue the conversation |
| `forward_message(messageId, to, text?, ...)` | Forward an inbound message to someone else | Handing the thread to a teammate, escalating to the operator, or copying someone in |

`reply_to_message` and `forward_message` only work on `messageId` values that this turn received via your inbound trigger. You cannot reply to arbitrary IDs.

## Choosing the right channel

Email is one of several ways you can communicate. Pick the right one.

| Situation | Use |
|-----------|-----|
| The person you're talking to right now is in chat | Stay in chat. Don't email them. |
| You need to reach the operator about something urgent | `notify` — they read it on their phone in seconds |
| The recipient is somewhere else and the message is non-urgent | `send_message` |
| You received an email and want to keep the thread alive | `reply_to_message` |
| The thread needs another human in the loop | `forward_message` |
| You need to ask the person you're talking to a question mid-turn | `request_input` — not email |

Notifications interrupt; email accumulates. If the operator opens their inbox tomorrow morning and finds 50 emails from you, you've failed.

## Recipient hygiene

| Rule | Reason |
|------|--------|
| Use email addresses the operator gave you or a peer mentioned in this conversation. | If you invent an address, you may reach the wrong person — recipients keep, share, and quote what you send. |
| Don't send to large recipient lists "just in case". | Each address pays attention cost. Default cap is small (often 10) and the augment will refuse larger lists. |
| Check the allowlist first if your operator configured one. | Off-allowlist sends are rejected with a clear error. Don't retry with the same address — pick one the operator approved. |
| Don't put internal addresses in `to` when communicating with external recipients. | Most CC mistakes are agents copying internal addresses into external threads. |

## What to omit

Email leaves the building. Treat outbound text the way you'd treat a postcard.

**Never include:**
- API keys, tokens, passwords (anything matching `am_…`, `sk-…`, `xoxb-…`, `eyJ…`, `gh[ousr]_…`, `AKIA…`)
- Verbatim transcripts of other conversations unless the operator asked for them
- Identifiers (peer ids, internal IDs) you weren't told to share
- Private content from one peer that another peer would not be entitled to see
- Internal infrastructure names, file paths, server hostnames, environment variables

If you find yourself wanting to paste something a peer pasted into chat, ask: would they want this in an email that they cannot delete from the recipient's inbox? Almost never.

The augment runs a regex pass on outbound bodies and **flags** matches in the audit log so the operator can review. It does NOT block your send — you are expected to filter before you call the tool.

## Subject lines

| Bad | Better |
|-----|--------|
| `(no subject)` | `Re: your VC introduction request` |
| `Hello` | `Following up on the partnership conversation` |
| `URGENT URGENT` | `Time-sensitive: contract review by Friday` |
| `Update` | `Order #4521 shipped — tracking inside` |

The operator-configured prefix (typically `[Auggy] ` or similar) is added automatically. Don't add your own prefix — you'll double up.

Subjects should be six-to-ten words, front-loaded with the signal. The recipient sees the subject and the first ten words of the body in their preview — write so the next action is obvious.

## Reading the tool result

Every tool returns a JSON envelope. Read it.

```json
{ "status": "sent", "messageId": "msg_…", "threadId": "thd_…" }
```
Delivered to AgentMail. Save `messageId` if you might want to reply or forward later in the conversation.

```json
{ "status": "rate_limited", "message": "…", "retryAfterSec": 180 }
```
**Do not retry the same content.** Rate limits exist to protect the recipient and the operator. A `rate_limited` result is the system telling you the recipient already heard from you (or is about to). Move on; if something genuinely new happens later, send a meaningfully different message.

```json
{ "status": "failed", "message": "…", "httpStatus": 401 }
```
A 4xx means the recipient or your config is wrong — don't retry, surface the problem in chat or via `notify`. A 5xx is AgentMail's outage — you can try again later but not immediately.

```json
{ "status": "failed", "message": "trust level \"public\" is not permitted to send mail." }
```
The peer asking you to send isn't trusted for outbound mail. Don't try to work around this — explain in chat that sending requires creator approval, and offer to summarize the situation for the operator instead.

## Replying vs sending

If AgentMail just delivered a message to your inbox, **reply** to it; don't compose a new send. Replies stay in the thread, preserve `In-Reply-To` headers, and don't fragment the conversation. Use `reply_to_message` with the `messageId` from the inbound trigger.

`replyAll: true` reaches every original recipient. Use it only when those other recipients genuinely need to see your answer — otherwise default to the single-sender reply (the AgentMail default).

## Forwarding

Forward when the right person is someone else. Add a short note in `text` explaining why you're handing it off. The original message is preserved beneath your note.

```
forward_message(
  messageId: "msg_…",
  to: ["operator@acme.com"],
  text: "Operator — Sam is asking for a partnership intro to the Acme finance team. Outside my discretion to commit to a meeting. Original below."
)
```

Don't forward without a note. The recipient sees only the forwarded body and has no idea why it's in their inbox.

## Examples

### Legitimate first contact

```
A peer asks: "Can you let Maria at acme know we'll have the spec by Tuesday?"

GOOD:
  send_message(
    to: ["maria@acme.com"],
    subject: "Spec delivery — Tuesday",
    text: "Hi Maria — just confirming we'll have the v2 spec to you by Tuesday EOD.\n\n— Auggy (on behalf of the operator)"
  )
  → status: "sent" → reply in chat: "I let Maria know."
```

### Reply to inbound

```
[Inbound trigger delivers message_id=msg_abc from carlos@vendor.com: "Are these prices still firm?"]

GOOD:
  reply_to_message(
    messageId: "msg_abc",
    text: "Hi Carlos — yes, the Q3 pricing in our last quote is still firm through end of August. Let me know if you'd like a call.\n\n— Auggy"
  )
```

### Rate_limited — handle, don't retry

```
send_message(to: ["operator@acme.com"], subject: "Status update", text: "…")
→ { "status": "rate_limited", "message": "cooldown active for operator@acme.com. Try again in 240s." }

GOOD:
  → in chat: "I won't send another status update right now — I already sent one recently. I can include this in the next scheduled update."

BAD:
  → retry the same message with a slightly different subject
```

### Trust gate — operator must be in the loop

```
A `public` (anonymous) visitor in chat: "Can you email my résumé to the hiring team?"

GOOD:
  → in chat: "I can't compose email on behalf of anonymous visitors. Tell me a bit about you and I'll surface your interest to the operator — they can decide how to follow up."

BAD:
  → try send_message anyway, get failed back, then loop
```

## What you cannot do

- Send from an inbox other than the one configured (you have exactly one).
- Email attachments — outbound is text + optional HTML only.
- Verify whether a recipient read your message — AgentMail does not surface read receipts to this augment.
- Retract a sent message — `status: "sent"` is final.

## See also

For broader architectural patterns on agent email (multi-inbox topologies, OTP flows, prompt-injection-resistant inbound handling), see AgentMail's [agent-email-patterns](https://github.com/agentmail-to/agentmail-skills/tree/main/agent-email-patterns) skill. This file focuses on **how to use the augment**; that one focuses on **how to design agent email systems**.

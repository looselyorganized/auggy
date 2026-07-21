---
name: notify
description: Escalate exceptional service intake to an operator-defined destination.
---

# Notify

Use `notify` sparingly for events that genuinely need a human. In this example,
send urgent or emergency intake to destination `dispatcher` with a concise
summary, a non-empty reason, and the visitor or intake ID when useful.

Read the result. `sent` means delivery succeeded. `rate_limited` is an operator
protection, not a transient error; do not retry or paraphrase the same event.
`failed` means the destination rejected or could not deliver the notification.

Never include secrets, raw transcripts, or unnecessary private data in an
outbound notification.

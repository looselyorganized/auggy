---
name: visitorAuth
description: Verify anonymous public visitors by email before private order access.
allowedTrustLevels:
  - public
---

# Visitor authentication

Use `request_auth` only for an anonymous public visitor who explicitly typed
their own email address and consented to verification. Never call it for the
creator, an agent peer, or an already recognized visitor unless runtime context
says reverification is due.

The result's `delivery` field is authoritative. For `delivery: "console"`, say
that no email was sent and the local developer must open the verification link
printed in the Auggy terminal. Respect rejection messages and retry delays.

Verification proves access to an email inbox and creates durable visitor
continuity. It does not grant creator or agent trust.

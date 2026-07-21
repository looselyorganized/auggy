---
name: visitorAuth
description: Verify anonymous public visitors by email before appointment holds and confirmation.
allowedTrustLevels:
  - public
---

# Visitor authentication

Use `request_auth` only after an anonymous visitor explicitly types their own
email address and consents to verification. Do not verify creators, agent peers,
or already recognized visitors unless runtime context says reverification is
due.

The result's `delivery` field is authoritative. Local `delivery: "console"`
means no email was sent; the verification link was printed in the Auggy
terminal. Respect rejection messages and retry delays.

Verification establishes durable visitor continuity, not creator trust.

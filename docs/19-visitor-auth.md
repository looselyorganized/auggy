# `visitor-auth` — operator reference

`visitorAuth` is the email magic-link verification augment. It lets a public-anonymous visitor verify ownership of an email address and become public-recognized — same `vis_<uuid>` identity returns across sessions, memory continuity, etc. First member of the auth-augment family.

## What it adds to the agent

- Tool: `request_auth({method: "email", email})` — model-callable; sends the verification email.
- HTTP route: `GET /visitor-auth/verify?token=<uuid>` — public-unauthenticated; mounts on the agent's webTransport.
- Context block: per-turn summary of the active peer's verification state.
- SQLite store: `<agent-dir>/visitor-auth.db` — token + verified-visitor tables.

## Configuration

Add to `agent.yaml`:

```yaml
augments:
  - type: webTransport
    name: web
    options:
      port: 8080
      auth: { type: bearer, token: ${AUGGY_WEB_TOKEN} }
      visitorTokens:
        enabled: true
        signingKey: ${VISITOR_SIGNING_KEY}        # MUST match visitorAuth's signingKey
        ttlSeconds: 7776000                       # 90 days

  - type: visitorAuth
    name: visitor-auth
    options:
      publicUrl: ${AUGGY_PUBLIC_URL}              # e.g. https://zip.example.com
      dbPath: ./visitor-auth.db
      agentMail:
        apiKey: ${AGENTMAIL_API_KEY}
        inboxId: ${AGENTMAIL_INBOX_ID}
        subjectPrefix: "[Verify] "
      signingKey: ${VISITOR_SIGNING_KEY}          # SAME value webTransport uses
      rateLimit: { perHour: 1, perDay: 3 }        # per anonymous peer
      reverifyAfterDays: 90
      tokenTtlMinutes: 15
      layeredMemoryDbPath: ./memory.db            # null to disable peer-id migration
      # Optional: notify operator on first verify per email
      notifyOnFirstVerify:
        to: ops@example.com
        subjectPrefix: "[New verified visitor] "
```

## Required environment variables

| Variable | Why |
|---|---|
| `AGENTMAIL_API_KEY` | AgentMail bearer token (`am_*`) |
| `AGENTMAIL_INBOX_ID` | Inbox the verify email is sent FROM |
| `AUGGY_PUBLIC_URL` | Base URL operators reach the agent at; embedded in the magic link |
| `VISITOR_SIGNING_KEY` | HMAC key for visitor tokens; **MUST match** webTransport's value |

## Key constraints

- `visitorAuth.signingKey` and `webTransport.visitorTokens.signingKey` MUST be the same value. If they drift, visitor tokens minted by visitorAuth will fail webTransport's verification on the next request.
- `publicUrl` MUST point to a host where the agent's `/visitor-auth/verify` route is reachable from the public internet. If you're running behind a tunnel (ngrok, Cloudflare), use the tunnel URL; if you're running on Railway, use the Railway domain.
- Per-anonymous-peer rate limits are **in-memory only** — restart resets state. The verified_visitors UNIQUE-on-email constraint catches accidental double-verification.

## Operator commands

```bash
# List verified visitors
auggy visitors zip

# Hard-revoke a verified visitor (deletes verified_visitors row + cascades memory_forget)
auggy visitors zip --revoke alice@example.com
auggy visitors zip --revoke alice@example.com --yes      # non-interactive
```

If a revoke is interrupted (e.g., Ctrl-C between the visitor-auth UPDATE and the memory.db DELETE), simply re-run `auggy visitors <agent> --revoke <email>` — the command detects the already-revoked row and finishes the memory cascade idempotently.

## How verification works (operational view)

1. Visitor types email in chat (e.g., "I'm alice@example.com").
2. Agent decides to verify, calls `request_auth({method: "email", email: "alice@example.com"})`.
3. visitorAuth validates: email format, email-must-appear-in-recent-messages (defense against confused-deputy), per-peer rate limit (1/hr, 3/day).
4. Generates a UUID token. Writes a row to `visitor_auth_tokens` with 15-minute TTL. Sends email via `agentmail-client.ts` (direct, not through `notify`).
5. Visitor clicks link in email. GET hits `/visitor-auth/verify?token=<uuid>`.
6. Atomic `UPDATE visitor_auth_tokens SET consumed=1, consumed_at=? WHERE token=? AND consumed=0 AND expires_at > ?` — `changes()` decides single-use.
7. On consumed=1: mints HMAC-signed `vis_<uuid>` (same key webTransport uses; reuses an existing visitorId on re-verify so memory continuity survives), writes verified_visitors row, runs anonymous→recognized peer-id migration on memory.db, returns success HTML.
8. Success HTML stashes the token in localStorage + replaces URL via `history.replaceState`.
9. Chat tab listens for `storage` events, picks up new token, includes it as `x-visitor-token` on next request.
10. webTransport's identity Path 3 verifies the token, peer.id is now `vis_<uuid>`, peer.publicSubstate is `recognized`.

## Security posture

- **Confused-deputy defense (fix #4):** the augment refuses to send to an email that did not appear verbatim in one of the visitor's last 4 messages.
- **Rate-limit defense (fix #1):** 1 send per anonymous peer per hour, 3 per day. Per-IP per-route limit (60/min) layered above by webTransport.
- **Token leakage defense (fix #5):** verify-success page has `<meta name="referrer" content="no-referrer">`, zero external assets, runs `history.replaceState` on load to drop the token from the URL bar.
- **Token replay defense (fix #8):** atomic SQL consume; one row update returns success, all others return 410.
- **Long-term key compromise (fix #9):** 90-day reverification TTL on `verified_visitors`. Operator can revoke at any time.

## Out of scope at v1

- Other auth methods (SMS, OAuth, OIDC) — `request_auth.method` shape leaves room.
- Strong identity (KYC). Email-bound is durable, not strong.
- Cookie-based cross-tab handoff (only localStorage, same-origin).
- Operator-customizable verify-success HTML.
- HTML-bodied verify emails (plain-text only at v1).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "VISITOR_SIGNING_KEY is unresolved" at boot | `${VISITOR_SIGNING_KEY}` env var not set in `.env` | Set it; restart |
| Verify link returns 404 | Token isn't in the DB — most often visitorAuth wasn't running when the token was issued, or DB was deleted | Re-issue with a fresh `request_auth` |
| Verify link returns 410 "expired" | More than 15 minutes between send and click | Re-issue |
| Verify link returns 410 "consumed" | Token was already used (visitor double-clicked, or someone with the link beat them) | Re-issue |
| Visitor verifies but agent doesn't recognize them next visit | Cleared localStorage, or `VISITOR_SIGNING_KEY` rotated | Re-verify |
| `auggy visitors --revoke` errors "memory.db not found" | layeredMemory hasn't created its DB yet, or path mismatch | Check `layeredMemoryDbPath` in `agent.yaml` |

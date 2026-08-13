# Optional hosted MCP reads

The AgentMail augment does not need MCP. Its SDK-backed tools are the supported
path for mailbox reads, wake-up, catch-up, drafts, delivery, and recovery.

Do not expose hosted AgentMail MCP mutations for the same mailbox. Raw MCP
`send_message`, `reply_to_message`, `forward_message`, `create_draft`,
`update_draft`, `send_draft`, label updates, inbox administration, and delete
tools bypass Auggy's policy, review, rate limits, idempotency ledger, and
outcome-unknown reconciliation.

If an operator intentionally adds redundant MCP reads, all of these conditions
are mandatory:

1. The credential is already scoped to the one mounted AgentMail inbox.
2. The configuration uses an exact positive `allowedTools` list, so current and
   future mutation tools are absent by default.
3. `allowedTrustLevels` contains only `creator`.
4. Every call uses the exact mounted inbox ID. Auggy's generic MCP boundary
   filters tool names and trust levels, but it does not constrain an MCP tool's
   inbox argument.
5. Attachments still use `read_mail_attachment`; raw MCP attachment URLs bypass
   Auggy's bounded download and content checks.

Use `mcp-read-only.example.json` only when all five conditions hold. It reuses
the exact operator-provided `AGENTMAIL_API_KEY`; it does not create or rotate a
key. If the credential can access multiple inboxes, do not connect hosted MCP
to this agent.

MCP reads do not participate in inbound wake-up, offline catch-up, admission,
label policy, review, rate limits, or delivery recovery. Provider output remains
untrusted external content.

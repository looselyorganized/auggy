# Auggy Feature Status

This is the compact status index for current and planned Auggy capabilities.
When this disagrees with code, code wins and this file should be updated.

Status values:

- **Published** — available in the latest npm release.
- **On main** — implemented in this repository but not yet published.
- **Planned** — intended pre-1.0 work, not implemented.
- **Preview** — implemented enough to experiment with, but not the final shape.
- **Vision** — directional, not a commitment.

## Current Status Matrix

| Area | Status | Primary docs | Notes |
| --- | --- | --- | --- |
| Augment runtime and kernel | Published | [`02`](./02-architecture-overview.md), [`04`](./04-kernel.md), [`08`](./08-agent-lifecycle.md) | Core composition, lifecycle, tools, context allocation, and agent handles. |
| Web transport and AG-UI `/agent/run` | Published | [`06`](./06-transports.md), [`20`](./20-embedding.md) | Chat/runtime HTTP surface with visitor token primitives. |
| Console | Published | [`21`](./21-console.md) | Creator-facing chat surface and compact diagnostics. |
| Built-in memory providers | Published | [`05`](./05-memory-subsystem.md), [`07`](./07-built-in-augments.md) | File, layered, static knowledge, and Supabase-backed memory patterns. |
| Budgets | Preview | [`12`](./12-budgets.md) | Post-turn cost accounting and trust-tier admission. Budget-threshold notify integration has shipped, but budget enforcement remains spend guardrails rather than billing control. |
| Notify | Published | [`13`](./13-notify.md), [`07`](./07-built-in-augments.md) | Webhook, Telegram, AgentMail, and file-style diagnostic paths depending on config. |
| Railway deploy | Published | [`18`](./18-deploy.md) | Railway-first deploy flow with target selection and port preflight. |
| AgentMail setup | On main | [`22`](./22-agent-mail.md) | Setup recipes are in the unreleased line. Inbound hardening remains planned. |
| MCP augment | Published | [`24`](./24-mcp.md) | Local stdio and deploy-safe remote MCP posture. |
| Link peer traffic | Preview | [`07`](./07-built-in-augments.md), [`ROADMAP`](./ROADMAP.md) | Configured peer-to-peer A2A-style traffic, not open mesh/discovery. |
| Deterministic augment routes | On main | [`25`](./25-generated-route-clients.md), [`agent-native app backends`](./use-cases/agent-native-app-backends.md) | App/API routes beside `/agent/run`, owned by augments. |
| Route manifest and OpenAPI export | On main | [`25`](./25-generated-route-clients.md) | `auggy routes`, `--json`, and `--openapi` route artifacts. |
| Generated TypeScript route clients | On main | [`25`](./25-generated-route-clients.md) | Browser/server targets, typed inputs, typed success responses, visitor tokens, auth assertions. |
| Route auth modes | On main | [`19`](./19-visitor-auth.md), [`25`](./25-generated-route-clients.md), [`26`](./26-delegated-authorization.md) | `none`, `bearer`, `creator`, `visitor.optional`, `visitor.required`, `agent.required`. |
| Webhook route policies | On main | [`25`](./25-generated-route-clients.md), [`26`](./26-delegated-authorization.md) | Policy metadata plus runtime Stripe signature verification. More providers planned. |
| Delegated authorization bridge | On main | [`26`](./26-delegated-authorization.md), [`examples/app-auth-bridge`](../examples/app-auth-bridge/README.md) | App-owned auth/RBAC signs explicit scopes/grants; Auggy enforces route/tool `requires`. |
| Route/tool/domain app-backend pattern | On main | [`examples/concierge`](../examples/concierge/README.md), [`agent-native app backends`](./use-cases/agent-native-app-backends.md) | One domain capability can expose deterministic routes and model-callable tools. |
| Auggy Builder Skill | Planned | [`ROADMAP`](./ROADMAP.md), [`plan`](./plans/auggy-builder-skill-plan.md) | Companion skill for Claude, Codex, Cursor, and similar agents to explain, set up, extend, and validate Auggy projects. |
| App-builder route/tool scaffolds | Planned | [`ROADMAP`](./ROADMAP.md) | `auggy augment create --with-route --with-tool` and template work. |
| Operator route/audit visibility | Planned | [`ROADMAP`](./ROADMAP.md) | CLI/console inspection beyond current doctor and route reports. |
| Inbound AgentMail channel | Planned | [`22`](./22-agent-mail.md), [`ROADMAP`](./ROADMAP.md) | Outbound/setup exists; robust inbound channel is pre-1.0 candidate work. |
| Staff/person auth | Planned | [`use-cases/auth-strategy`](./use-cases/auth-strategy.md) | Internal-app trust tier between public visitor and creator. |
| Agent mesh / delegated consent | Vision | [`ROADMAP`](./ROADMAP.md), [`agent-native app backends`](./use-cases/agent-native-app-backends.md) | Builds on Link, agent route auth, delegated assertions, budgets, and route-backed actions. |

## Version Buckets

- **`0.4.4` published:** latest npm baseline.
- **`0.5.0` release candidate on `main`:** app-backend route/client/authz foundation; package metadata prepared, not yet published.
- **`0.6.x` candidate:** app-builder scaffolds, guides, and companion-agent skill.
- **`0.7.x` candidate:** operator visibility and audit surfaces.
- **`0.8.x` candidate:** inbound channels and provider hardening.
- **`0.9.x` candidate:** GA hardening.
- **`1.0.0`:** OSS GA threshold.

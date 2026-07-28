# Auggy Feature Status

This file describes the code that is published or currently present on `main`.
It is a status index, not a roadmap.

Status values:

- **Published** — available in the latest stable npm release.
- **RC** — included in the `0.5.0-rc.1` public candidate on npm's `next` tag.
- **Preview** — implemented for deliberate experimentation; its API or
  production posture may still change.
- **Unsupported** — deliberately unavailable; nearby foundations must not be
  mistaken for a usable production capability.

When this file disagrees with code, code wins.

## Core Runtime

| Capability | Status | Primary docs | Notes |
| --- | --- | --- | --- |
| Agent runtime and turn kernel | Published | [`02`](./02-architecture-overview.md), [`04`](./04-kernel.md), [`08`](./08-agent-lifecycle.md) | Context assembly, history, model calls, tool loops, events, and lifecycle hooks |
| Anthropic, OpenAI, OpenRouter, and Ollama engines | Published | [`02`](./02-architecture-overview.md), [`03`](./03-types.md) | One swappable engine per agent |
| Augment composition | Published | [`01`](./01-philosophy.md), [`07`](./07-built-in-augments.md) | One extension surface for tools, context, memory, transports, policy, routes, and lifecycle behavior |
| Typed tools | Published | [`03`](./03-types.md), [`04`](./04-kernel.md) | Zod inputs, generated JSON Schema, validation, and structured results |
| Skills | Published | [`11`](./11-skills.md) | Markdown instruction folders installed with agents and augments |
| Web transport and `/agent/run` | Published | [`06`](./06-transports.md), [`20`](./20-embedding.md) | HTTP/SSE chat through AG-UI-shaped events |
| Creator console | Published | [`21`](./21-console.md) | Chat-first per-agent browser surface with integration guidance |
| Console capability runtime map | RC | [`21`](./21-console.md) | Observed augments, routes, tools, memory, skills, reported safeguards, issues, and notes |
| CLI create/run/doctor lifecycle | Published | root [`README`](../README.md) | Scaffold, local operation, diagnostics, and background process commands |
| Railway deploy | Published | [`18`](./18-deploy.md) | Railway-first staging, secrets, persistent volume, and health verification |
| Keyed turn scheduling | RC | [`04`](./04-kernel.md), [`08`](./08-agent-lifecycle.md) | Bounded agent/source/thread admission and process-local outcome-unknown quarantine |
| Runtime-state inventory and fenced recovery | RC | [`27`](./27-runtime-state-recovery.md) | Offline single-replica volume bundles, verification, exact resume, and mandatory downstream reconciliation |
| Durable delivery and operator recovery | RC | [`28`](./28-delivery-and-operator-recovery.md) | Transport-specific replay contracts, durable AgentMail/notify incidents, and creator CAS recovery |
| Provider deadline and brownout isolation | RC | [`29`](./29-provider-resilience.md) | One bounded model attempt, explicit no-retry policy, cancellation, late-result fencing, and scheduler capacity release |
| Single-replica runtime load evidence | RC | [`30`](./30-single-replica-load-evidence.md) | Bounded real-runtime burst, tool, cancellation, fault, drain, restart, and soak evidence; no universal RPS claim |
| Compatibility and rollback contract | RC | [`31`](./31-compatibility-migrations-and-rollback.md) | Strict config admission, versioned artifacts/state, tested predecessor migrations, and full-state rollback |
| Durable single-turn jobs and UTC schedules | RC | [`33`](./33-durable-jobs.md) | Trusted application/operator submission, fenced SQLite execution, bounded restart recovery, and explicit outcome-unknown reconciliation; one replica only |
| Auggy Builder Skill | RC | [`11`](./11-skills.md) | Portable coding-agent guidance and evals; public installation UX remains roadmap work |
| Multiple replicas for one logical agent | Unsupported | [coordination report](./plans/distributed-coordination-implementation-report-2026-07-24.md) | Configuration fails closed; PostgreSQL coordinator foundation is not wired into runtime execution |

## Built-In Augments

| Augment or capability | Status | Primary docs | Notes |
| --- | --- | --- | --- |
| File memory | Published | [`05`](./05-memory-subsystem.md), [`07`](./07-built-in-augments.md) | Identity and creator-approved learned behavior |
| Filesystem | Published | [`07`](./07-built-in-augments.md) | Named scoped mounts for skills and workspace data |
| Web fetch | Published | [`07`](./07-built-in-augments.md) | Public HTTP fetching with SSRF protection |
| Turn control | Published | [`17`](./17-turn-control.md) | Explicit input-required turns |
| Knowledge | Published | [`07`](./07-built-in-augments.md) | Local Markdown and API-backed knowledge sources |
| Layered memory | Published | [`05`](./05-memory-subsystem.md), [`07`](./07-built-in-augments.md) | Peer-scoped episodic memory; SQLite default |
| Visitor auth | Published | [`19`](./19-visitor-auth.md) | Email magic-link recognition and visitor tokens |
| Notify | Published | [`13`](./13-notify.md) | File, webhook, Telegram, and AgentMail destinations |
| AgentMail outbound | Published | [`22`](./22-agent-mail.md) | Trust-gated model-callable send, reply, and forward tools |
| AgentMail inbound and outbound review | RC | [`22`](./22-agent-mail.md) | Polling/WebSocket/Svix delivery, REST catch-up, durable ledger, and creator review |
| Telegram transport | Published | [`14`](./14-telegram-transport.md) | Bidirectional Telegram conversations |
| MCP | Published | [`24`](./24-mcp.md) | Local stdio and remote HTTP MCP servers |
| Budgets | Preview | [`12`](./12-budgets.md) | Turn and spend guardrails, not billing control |
| Bash | Preview | [`07`](./07-built-in-augments.md) | Scoped host process execution, not a sandbox |
| Link | Preview | [`07`](./07-built-in-augments.md) | Configured peer traffic, not open discovery or an agent mesh |

## Advanced Preview Capabilities

| Capability | Status | Primary docs | Notes |
| --- | --- | --- | --- |
| Deterministic augment routes | RC | [`25`](./25-generated-route-clients.md) | Small GET/POST surfaces served beside the agent runtime |
| Route manifest and OpenAPI-shaped export | RC | [`25`](./25-generated-route-clients.md) | Inspection through `auggy routes` |
| Generated TypeScript route clients | RC | [`25`](./25-generated-route-clients.md) | Browser/server targets, typed successful responses, and declared request/response media types |
| Route auth modes | RC | [`19`](./19-visitor-auth.md), [`25`](./25-generated-route-clients.md) | Public, visitor, creator, bearer, and agent route postures |
| Webhook route policy | RC | [`25`](./25-generated-route-clients.md), [`26`](./26-delegated-authorization.md) | Policy metadata plus Stripe and Svix signature verification |
| Delegated app authorization | RC | [`26`](./26-delegated-authorization.md) | App-signed scopes/grants enforced on routes and tools |

These capabilities are usable, but they do not make Auggy a general web
framework, general workflow engine, or distributed job platform. The optional
Durable Jobs boundary persists one complete trusted turn; it does not
checkpoint or orchestrate multi-step business workflows.

## Package Snapshot

- Latest stable package: `0.4.4`.
- Public-preview candidate: `0.5.0-rc.1` on npm's `next` tag.
- Release plan: [`plans/production-readiness-roadmap-2026-07-24.md`](./plans/production-readiness-roadmap-2026-07-24.md).
- Source of truth: code in `src/`, followed by the numbered reference docs.

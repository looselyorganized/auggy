# Auggy 0.5 Preview Surface

0.5 is a public preview for building agent-native app backends in TypeScript.
It is useful now, but not a 1.0 stability promise.

## Ready To Demonstrate

- `auggy create`
- default `/console/chat`
- file memory for `identity.md` and `learned-behaviors.md`
- skill manifest plus on-demand `SKILL.md` reads
- custom augments
- `defineRoute` and `defineTool`
- route manifests, JSON, OpenAPI-style output
- generated TypeScript route clients
- browser/server route-client target split
- response schemas for successful route data
- visitor auth and visitor tokens
- external auth assertions for app-owned auth bridges
- delegated route/tool authorization with `requires`
- replay protection for external auth assertions
- Stripe webhook signature policy
- notify, agentMail outbound setup, knowledge, webFetch, MCP, Telegram
- Railway deploy path

## Preview Or Use With Care

- `bash`: host process execution, not a sandbox; creator-only intent required.
- `budgets`: soft runtime guardrails; provider hard caps still matter.
- `link`: early agent mesh/A2A direction.
- generated client helper shape: `createAuggyClient` is emitted per generated
  file and is not a package export yet.
- app-builder companion skill packaging: in progress.

## Not The Goal

Do not position Auggy 0.5 as:

- a replacement for Next.js, Supabase, Clerk, Stripe, Shopify, Rails, or
  Postgres
- a general-purpose identity provider
- a full API framework
- a fully stable 1.0 public API
- a public OSS repository during private preview

## Launch Posture

- npm package can be public.
- Source repo may remain private during preview.
- License is Apache-2.0.
- Public docs and support paths should be on `auggy.dev`.
- NPM publish should be the final launch step after the walkthrough.

# Auggy 0.5 Surface

0.5 is a public preview of Auggy's small TypeScript agent runtime. It is useful
now, but not a `1.0` stability promise.

## Ready To Demonstrate

- install, create, run, doctor, and deploy workflows,
- the default console chat,
- a fixed turn kernel with provider adapters,
- composable built-in and custom augments,
- typed tools,
- identity, learned behavior, skills, and scoped filesystem access,
- knowledge, web fetch, layered memory, and visitor recognition,
- notify, MCP, and Telegram,
- runtime-state backup and recovery plus optional durable single-turn jobs,
- Railway deployment.

## Application Integrations

- augment-owned GET/POST routes,
- route manifests and OpenAPI-shaped output,
- generated TypeScript route clients,
- delegated app authorization,
- Stripe webhook signature policy.
- provider-native AgentMail drafts, WebSocket wake-up, paginated offline
  message catch-up, exact-key existing-inbox connection, and explicit creator
  review.

These capabilities are optional and do not make Auggy a general app backend.

## Use With Care

- `bash`: host process execution, not a sandbox.
- `budgets`: soft runtime guardrails, not billing control.
- `link`: configured peer traffic, not an open agent mesh.
- generated client helper shape may change before `1.0`.

## Not In This Release

- checkpointed or multi-step workflow execution,
- a general persistent job queue,
- first-class artifact/image handling,
- a stable `1.0` public API.

## Launch Posture

- `0.5.0` is the stable npm release and remains public preview software.
- Source is public at `looselyorganized/auggy`.
- License is Apache-2.0.
- Public docs and support live on `auggy.dev`.
- Pin exact versions for production work.

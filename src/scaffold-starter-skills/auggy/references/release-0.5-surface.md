# Auggy 0.5 Preview Surface

0.5 is a public preview of Auggy's small TypeScript agent runtime. It is useful
now, but not a `1.0` stability promise.

## Ready To Demonstrate

- install, create, run, doctor, and deploy workflows,
- the default console chat,
- a fixed turn kernel with provider adapters,
- composable built-in and custom augments,
- typed tools,
- identity, skills, peer-scoped memory, and scoped filesystem access,
- knowledge, web fetch, layered memory, and visitor recognition,
- notify, published AgentMail outbound, MCP, and Telegram,
- Railway deployment.

## Advanced Preview

- augment-owned GET/POST routes,
- route manifests and OpenAPI-shaped output,
- generated TypeScript route clients,
- delegated app authorization,
- Stripe webhook signature policy.
- current-source AgentMail inbound (polling, WebSocket, or Svix webhook),
  durable catch-up, and outbound human review; these are not in the published
  `0.5.0` package yet.

These capabilities are optional and do not make Auggy a general app backend.

## Use With Care

- `bash`: host process execution, not a sandbox.
- `budgets`: soft runtime guardrails, not billing control.
- `link`: configured peer traffic, not an open agent mesh.
- generated client helper shape may change before `1.0`.

## Not In This Release

- durable workflow execution,
- a persistent job queue,
- first-class artifact/image handling,
- a stable `1.0` public API.

## Launch Posture

- npm package is public preview software.
- Source may remain private during preview.
- License is Apache-2.0.
- Public docs and support live on `auggy.dev`.
- Pin exact versions for production work.

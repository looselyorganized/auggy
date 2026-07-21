# Examples

The showcase examples each isolate a different reason to build a capability as
an Auggy augment instead of a standalone model tool.

## Showcase examples

### [Pickleball Storefront](./pickleball-storefront/README.md)

A browser storefront and shopping agent share catalog, draft-cart, and checkout
domain logic. This is the clearest proof of an Auggy app backend serving both
deterministic software and a model-mediated workflow. It includes a generated
TypeScript browser client and a small runnable frontend.

### [Secure Order Support](./order-support/README.md)

A verified visitor or creator can inspect an order and change its shipping
address through an expiring prepare/confirm protocol. The augment owns identity
checks, actor/thread binding, turn lifecycle evidence, replay prevention, and
audit output around the shared mutation.

### [Field-Service Intake And Dispatch](./service-dispatch/README.md)

A form or conversation creates the same structured service intake. The agent
can escalate urgent work through `notify`, while visitor-authenticated routes
and tools hold and confirm appointments under public chat budgets.

## Supporting patterns and fixtures

- [Concierge](./concierge/README.md) is the smallest route/tool/domain example.
  It remains useful when the showcase applications contain too much context.
- [App Auth Bridge](./app-auth-bridge/README.md) isolates delegated Supabase,
  Clerk, and custom-session authorization with generated clients.
- [MCP Stdio Server](./mcp-stdio-server/README.md) is a real local MCP server
  used by integration and release smoke tests.
- [`peer-registry.json`](./peer-registry.json) is a static Link peer-directory
  fixture, not a standalone application.

The showcase applications use in-memory business state unless their README says
otherwise. They demonstrate Auggy boundaries, not production databases,
payment processing, or distributed transaction guarantees.

# Use Cases

Exploratory product and architecture notes for ways Auggy can be applied in real organizations.

These docs are intentionally more market-facing than the core architecture references in `docs/`. They should still stay grounded in actual Auggy primitives: augments, transports, memory, trust tiers, budgets, skills, and agent-to-agent interfaces.

The canonical roadmap is [`../ROADMAP.md`](../ROADMAP.md). Use-case notes can
explore strategy, but roadmap commitments belong there.

## Current Notes

- [Agent-Native App Backends](./agent-native-app-backends.md): The primary product thesis for this folder. API augments make Auggy an app backend, not only an agent backend.
- [Agent-Native Backend Before And After](./agent-native-backend-before-after.md): Concrete old-vs-new backend examples showing where Auggy replaces ad hoc agent/backend glue while keeping existing frontend, auth, data, and provider stacks.
- [Agent-Native Backend Market Scan](./agent-native-backend-market-scan.md): Research-backed scan of system types, market examples, emerging architectures, caveats, and the exact replacement boundary for Auggy as a shared app/agent backend.
- [App Backend Architecture Strategy](./app-backend-architecture-strategy.md): How Auggy should evolve to support app-backend use cases without becoming a generic web framework.
- [App Backend Route Use Cases](./app-backend-route-use-cases.md): Practical route patterns and vertical use cases for deterministic APIs beside agent-mediated workflows.
- [Agent-Native Websites](./agent-native-websites.md): A subset of the app-backend thesis: Auggy agents as websites, not just chatbots embedded into websites.
- [Auth Strategy](./auth-strategy.md): Visitor, creator, agent, staff, webhook, and route-auth strategy for agent-native apps.

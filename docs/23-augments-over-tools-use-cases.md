# 23 — Augments Over Tools: Use Cases

> Why Auggy's augment architecture matters, where augments beat plain tools or MCP servers, and what kinds of company workflows this unlocks.

## The core distinction

Augments are not just tools with nicer packaging. A tool is an action the model may call during a turn. An augment is a runtime module that can contribute tools, memory, context, transports, auth, budgets, lifecycle hooks, queues, routes, outbound behavior, skills, and operator-facing diagnostics.

A tool answers: "Can the model call this function?"

An augment answers: "What runtime capability does this agent now have, and under what identity, trust, lifecycle, memory, transport, budget, and security policy does it operate?"

That distinction matters because many useful agent capabilities are not model-callable functions. A Telegram transport, visitor-auth route, memory provider, spend limiter, inbound email listener, or peer transport is not naturally "a tool." It is infrastructure.

## Why augments over tools

Plain tools are useful when the agent needs a discrete callable action. Augments are better when the capability needs to participate in the full agent runtime.

Augments can own:

- Boot and shutdown logic
- Per-turn context injection
- Memory read, write, search, and ownership
- Transport registration
- Peer identity resolution
- Trust-tier gates
- Tool exposure policy
- Rate limits and budgets
- HTTP routes
- Background listeners
- Operator notifications
- Auggy-provided skills and model-facing instructions
- Audit trails and console surfaces

The model does not need to see "augments" directly. As described in
[11-skills.md](./11-skills.md), Auggy separates the model-facing surfaces:

- **Tools**: callable schemas exposed to the engine
- **Skills**: compact instructions and operating procedures
- **Augments**: invisible runtime modules that contribute behavior

This keeps the prompt smaller while preserving stronger runtime structure.

## Where augments beat MCP servers

MCP is valuable when an agent needs to call external tools or read external resources through a client-mediated protocol. It is a good fit for stateless or on-demand capabilities such as fetching a GitHub issue, querying a database, searching a document index, or calling a SaaS API.

Augments are stronger when the capability needs to live inside the agent runtime.

### Inbound event delivery

MCP is mostly pull-oriented: the model or client calls tools and reads resources. Augments can listen independently and inject turns into the kernel only when something actually happens.

Examples:

- `telegramTransport` receives Telegram messages and creates `TurnTrigger`s.
- `agentMail` receives allowlisted or explicitly bounded-public email through
  polling, WebSocket, or verified webhook delivery and invokes the model only
  when its durable ledger has admitted work.
- Future Slack, SMS, voice, or queue transports can wake the agent on real events.

This avoids expensive empty polling loops. For email, for example, a scheduler-driven "check inbox" loop through MCP can run full LLM turns just to discover there is no mail. An augment can listen at the REST, webhook, or WebSocket layer and invoke the model only when there is work.

### Per-peer policy

Auggy augments run with access to `PeerIdentity`: peer kind, trust level,
public substate, thread, and organization metadata. That lets them enforce
different behavior for creators, public anonymous callers, public recognized
callers, staff, and agent peers.

Examples:

- `agentMail` can keep new sends and forwards creator-only while granting an
  exact admitted public email turn one creator-reviewed reply proposal.
- `budgets` can apply different spend ceilings by trust tier.
- `visitorAuth` can promote a public anonymous visitor to `public` + `recognized`.
- `filesystem` and `bash` can be scoped more tightly for public users than creators.

An MCP server generally does not own Auggy's current peer identity. It can expose a tool, but it does not naturally know whether the caller is the operator, a random visitor, a verified customer, or another agent.

### Transports are not tools

A web chat endpoint, Telegram bot, legacy peer link, or email inbox is an entrypoint into the agent, not a callable function.

Transport augments need to:

- Listen on a protocol
- Authenticate or identify the peer
- Translate protocol messages into `TurnTrigger`s
- Stream kernel events back out
- Register outbound callbacks
- Enforce queue depth, rate limits, and concurrency

MCP servers expose capabilities to a client. They do not replace the agent's inbound and outbound transport layer.

### Runtime context and memory ownership

Augments can add context before the model runs. Tools only appear if the model chooses to call them.

Examples:

- `fileMemory` injects identity into the system prompt.
- `layeredMemory` can retrieve peer-scoped memories automatically.
- `knowledge` can expose a source catalog while keeping fetches on demand.
- `skills` emits a compact list of mounted skills without stuffing every skill body into the prompt.

This lets Auggy keep model context smaller while still giving the runtime durable memory and structured retrieval behavior.

### Lifecycle and background work

Some capabilities need setup, validation, cleanup, polling, durable state, or policy maintenance.

Examples:

- `telegramTransport` validates admitted agents and manages polling or webhook lifecycle.
- `fileMemory` loads files at boot.
- `visitorAuth` owns a SQLite store and verification route.
- `budgets` owns persistent spend tracking.
- `agentMail` keeps audit and rate-limit state.

A plain tool cannot naturally own lifecycle. An MCP server can own its own process lifecycle, but it sits outside Auggy's runtime and cannot coordinate as directly with peer identity, queues, budgets, traces, or memory routing.

### Operator-side safety and audit

Augments can integrate with Auggy's trace events, capability table, console info blocks, trust gates, and rate limits. This matters for high-risk actions:

- Sending email
- Running shell commands
- Writing files
- Charging customers
- Booking appointments
- Dispatching staff
- Talking to other agents

For these, "the model has a tool" is insufficient. The runtime needs policy around who can trigger it, how often, with what arguments, and what gets recorded.

## Rule of thumb

Use an MCP server when the capability is primarily "model calls external tool."

Use an augment when the capability needs to participate in the agent runtime: identity, memory, context, transport, lifecycle, policy, trust, budget, inbound events, operator audit, or deployment state.

Augments are agent-native modules, not just tool endpoints.

## Example 1: Boutique retailer concierge

A small furniture or apparel retailer embeds an Auggy agent on its site and also connects it to Telegram for the owner.

### Augments available today

- `webTransport` for website chat
- `visitorAuth` for email verification
- `layeredMemory` for customer preferences and prior visits
- `knowledge` for policies, inventory notes, sizing guides, and shipping rules
- `notify` for escalation to staff
- `agentMail` for outbound follow-up emails
- `filesystem` for scoped access to product sheets or local order exports
- `budgets` for public caller spend limits

### Potential new augments

- `stripe` for payment links, refunds, and invoice lookup
- `shopify` or `square` for catalog and order access
- `calendly` for showroom appointments
- `returns` for return authorization workflows

### Novel capability

The same agent can treat anonymous visitors, public recognized customers, staff,
and the owner differently. An anonymous shopper can ask product questions. A
public recognized customer can get order-specific help. The owner on Telegram
can approve a discount, trigger a follow-up email, or ask "who needs attention
today?"

### Why this is hard with tools or MCP alone

A Shopify MCP server might expose catalog and order tools, but it does not naturally own visitor identity, magic-link verification, customer memory migration, public-vs-creator trust gates, outbound notifications, or the website and Telegram transport loops. Auggy can make "verify customer, recall preferences, check policy, escalate to owner, then send email" one coherent runtime workflow.

Product thesis: your store gets a persistent front-desk agent, not just a chat widget.

## Example 2: Field services dispatch agent

An HVAC, plumbing, electrical, or appliance repair company uses Auggy across customer chat, technician messaging, and owner oversight.

### Augments available today

- `webTransport` for customer requests
- `telegramTransport` for technicians and the owner
- `visitorAuth` to identify repeat customers
- `layeredMemory` for customer location, equipment history, and recurring issues
- `knowledge` for service policies, pricing bands, and warranty terms
- `notify` for urgent dispatch alerts
- `turnControl` for missing details
- `budgets` to prevent public abuse
- `agentMail` for appointment confirmations

### Potential new augments

- `calendar` for availability
- `dispatch` for technician assignment
- `crm` for customer records
- `maps` for drive-time estimates
- `quickbooks` for estimates and invoices
- `photo-intake` for customer-uploaded equipment photos

### Novel capability

The agent operates as a triage and coordination layer. A public visitor
describes a broken furnace. The agent asks for missing details, verifies email,
remembers equipment history, checks service rules, estimates urgency, and
notifies the dispatcher. An app-authenticated technician can message the same
agent from Telegram and get job context, but cannot access owner-only billing
controls. The owner can approve schedule changes or customer credits.

### Why this is hard with tools or MCP alone

This is not mainly a tool-calling problem. It needs channel-specific identity,
trust-tiered permissions, transport queues, persistent peer memory, operator
escalation, and policy-aware capability exposure. An MCP calendar or CRM server
helps, but it does not decide whether a public anonymous caller, public
recognized customer, technician, or owner should be allowed to perform the
action.

Product thesis: Auggy is the runtime for operational agents that safely cross the boundary from conversation into real-world work.

## Example 3: Software company internal agent mesh

A SaaS company runs several specialized Auggy agents:

- Support Concierge
- Bug Triage Agent
- Billing Agent
- Release Notes Agent
- Security Review Agent

### Augments available today or near-term

- `webTransport` for support console or embedded admin chat
- `telegramTransport` for operator and mobile coordination
- `knowledge` for product docs, runbooks, and policies
- `filesystem` for repo-local or ticket-export access
- `bash` for scoped diagnostics in safe environments
- `notify` for escalation
- `agentMail` for customer follow-up
- `budgets` for per-agent spend ceilings
- `link` for legacy A2A-v0.2 peer traffic (preview only)
- `skills` for specialized operating instructions per agent

### Potential new augments

- `github` for issues, PRs, and releases
- `linear` or `jira` for ticket workflows
- `slack` for team channels
- `sentry` or `datadog` for incident context
- `stripe` for billing and account status
- `peer-directory` for agent discovery
- `approval-gate` for human signoff on risky actions

### Novel capability

A support agent receives a customer issue. It verifies customer identity, checks account context, searches product knowledge, then routes the technical portion to the Bug Triage Agent through `link`. The Bug Triage Agent can inspect logs or repo context within its own budget and tool limits. If the issue is billing-related, the support agent routes to the Billing Agent. Each agent has its own identity, budget, tools, memory, and audit trail.

### Why this is hard with tools or MCP alone

MCP gives one model access to more tools. It does not naturally create an org-local mesh of agent peers with separate trust levels, budgets, identity, routing, transport, and audit boundaries. Auggy's architecture makes agents first-class peers, not just subroutines or tool collections.

Product thesis: Auggy can become the substrate for a company's internal agent facility: specialized agents that coordinate safely instead of one giant assistant with every permission.

## Common pattern

Across these examples, Auggy's advantage appears when the agent has to live in a company's real operating environment. Tools are enough for isolated actions. Augments matter when a capability needs runtime ownership: who is talking, through which channel, with what trust, memory, budget, policy, lifecycle, and audit trail.

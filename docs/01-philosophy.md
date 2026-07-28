# 01 — Product North Star

> **Give agents business capabilities—not backend access.**

Auggy runs business operations through TypeScript augments—controlled,
predictable interfaces to application systems. Each augment can keep identity
and authorization rules, typed schemas, tools, deterministic routes, and
domain logic together.

In technical terms, Auggy is a self-hosted agent for adding natural language to
real software without turning the model into the application, the security
boundary, or the system of record. It occupies the missing layer between an
LLM provider SDK and an engineering team’s existing services.

## The product thesis

A provider SDK can produce text and tool calls. It does not give a team a coherent, secure application architecture for:

- identifying the caller;
- assembling bounded context and history;
- deciding which capabilities that caller may use;
- validating and executing tool calls;
- handling memory, cancellation, quotas, and failures;
- supporting web, Telegram, or other transports consistently;
- tracing and testing the resulting behavior.

Without an agent runtime like Auggy's, every team eventually invents those pieces independently—usually as middleware, prompt conventions, callbacks, and one-off glue.

Auggy standardizes that agent-specific plumbing while leaving the actual application in the team’s control.

The most important separation is:

- The model interprets language, selects from already-authorized capabilities, and composes an answer.
- Deterministic code establishes identity, authorization, validation, budgets, side effects, and business invariants.

The model may propose an action. It never grants itself permission to perform it.

## The most valuable architectural idea

I do not think Auggy’s fundamental value is merely “a collection of augments.” It is the contract separating an unpredictable model loop from normal application engineering.

An augment can contribute tools, deterministic routes, context, memory, transport behavior, lifecycle hooks, constraints, or policy. That gives an engineering team one reviewable extension surface without requiring changes to the kernel.

More importantly, an application capability can expose the same domain operation in two ways:

```text
Existing UI/client ──> deterministic HTTP route ─┐
                                                 ├──> shared domain service
Model tool call ────> validated Auggy tool ──────┘
```

For example, order lookup can be called directly by an application screen or selected conversationally by the model. Both paths use the same identity checks, authorization rules, validation, and domain implementation.

That matters because:

- business rules are not duplicated in prompts and routes;
- the application does not have to invoke a model for deterministic operations;
- the model does not receive broader authority than the caller;
- frontend and backend teams can keep using ordinary API contracts;
- generated OpenAPI and route clients remain available;
- security reviewers can inspect the actual enforcement point.

This is much stronger than treating an agent as a chat endpoint connected to a bag of loosely controlled functions.

## Why an engineering team would adopt it

Auggy makes an agent behave like a normal software component.

A team gets:

- Ordinary TypeScript projects that can be reviewed, tested, versioned, and deployed using familiar practices.
- Typed, schema-validated tools instead of informal JSON conventions.
- One consistent turn lifecycle across model providers and transports.
- Explicit caller identity and structural capability authorization.
- Replaceable memory, model, transport, and storage implementations.
- Version-controlled identity, skills, policies, and operational instructions.
- Context budgeting and history management rather than uncontrolled prompt accumulation.
- Trace events, health information, diagnostics, and a creator console.
- A CLI and scaffolds for starting and validating agent projects.
- Provider portability and self-hosted data/control boundaries.
- Independent deployment and dependency pinning for each Auggy application.

The team spends less time rebuilding agent plumbing and more time implementing the capabilities that make its product useful.

The division of ownership is also sensible:

- Backend engineers expose existing domain services through secure augments.
- Frontend engineers use deterministic routes and generated clients where conversation is unnecessary.
- Product engineers shape the agent’s identity, skills, and conversational behavior.
- Security engineers review capability policies and deterministic enforcement points.
- The deploying team operates Auggy using its preferred infrastructure, databases, secrets, and observability systems.

## Where it fits in a real product

For an order-support agent, Auggy should not own orders, refunds, customer accounts, or payment state. The commerce application remains the system of record.

Auggy handles the interaction:

1. Authenticate or resolve the visitor.
2. Determine which order capabilities that visitor may access.
3. Supply relevant context to the model.
4. Let the model interpret the request.
5. Validate the selected operation.
6. Obtain deterministic confirmation when required.
7. Invoke the existing order service.
8. Return and trace the result.

Likewise, for a concierge, Auggy may interpret preferences and coordinate search or booking capabilities. The booking engine, inventory, payment system, and customer database remain external services.

If an action does not benefit from language interpretation, the application can call its deterministic route directly. The model is not a mandatory tollbooth.

## What Auggy is not

Auggy is not:

- a hosted multi-tenant agent platform;
- a customer-account or billing control plane;
- an identity provider;
- the application’s primary database;
- a generic web framework;
- a general-purpose durable workflow engine or distributed job platform;
- a replacement for Kubernetes, Railway, Fly.io, or another deployment platform;
- a mechanism for using prompts as authorization policy.

A “managed Auggy platform” would provision customer deployments, operate fleets, manage shared data and secrets, autoscale replicas, meter usage, provide tenant administration, and assume SLA/on-call responsibilities. That is materially different from the repository’s current purpose.

The implementer should continue to own:

- deployment and load balancing;
- business databases and systems of record;
- application authentication;
- secrets and network policy;
- backups and disaster recovery;
- domain-specific authorization;
- long-running multi-step workflows and distributed queues;
- operational SLOs.

Auggy should provide the contracts needed to integrate with those systems safely. It should not absorb all of them.

## Where the boundary should remain

The kernel should remain small and focused on executing a secure turn. Capabilities and integrations should normally live in augments. Infrastructure-specific coordination should use explicit adapters and interfaces.

Auggy can durably run or schedule one bounded, trusted background turn. If work
spans hours, crosses several independently recoverable business steps, waits
for human approval, or needs compensation, a workflow system should own it;
an Auggy activity or tool can be one step in that workflow.

If multiple replicas serve the same logical agent, Auggy needs clear shared coordination contracts for things such as deduplication, quotas, leases, and polling ownership. It does not need to become the load balancer, database service, or cluster orchestrator.

## My honest assessment of its value

Auggy is valuable when a team already has—or intends to build—a real application and wants natural language to become another secure interface to its capabilities.

Its strongest advantages are:

1. It prevents the model from becoming the architecture.
2. It makes agent behavior inspectable through conventional source code.
3. It lets deterministic application paths and conversational paths share domain logic.
4. It provides a stable extension contract without forcing one provider, transport, memory store, or hosting model.
5. It creates recognizable engineering and security boundaries around an otherwise probabilistic component.

It is less compelling for a throwaway chatbot, a purely deterministic CRUD application, a team wanting a no-code hosted builder, or a system whose main problem is durable workflow orchestration.

The product positioning is therefore:

> **Give agents business capabilities—not backend access.**
>
> Auggy runs business operations through TypeScript augments—controlled,
> predictable interfaces to your systems. Each augment bundles identity and
> authorization rules, typed schemas, tools, routes, and domain logic.

The recent security and distributed-coordination work supports that runtime promise. It was not inherently “platform work.” Some of it touched operational contracts required for serious self-hosting, but the product remains a self-hosted agent with an application runtime—not a managed platform.

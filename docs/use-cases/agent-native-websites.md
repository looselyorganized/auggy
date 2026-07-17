# Agent-Native Websites

> Auggy agents can be deployed as websites, not just embedded into websites.

This is a subset of the broader [Agent-Native App Backends](./agent-native-app-backends.md)
thesis. Websites are one public surface for the deeper pattern: augments can own
deterministic routes, agent-mediated tools, identity, memory, policy, and
operator controls in one project.

## The angle

The weak claim is: "Auggy can host a website." That is not very interesting. Lots of runtimes can serve HTML.

The stronger claim is:

**An Auggy can be the website.**

The public web surface, AG-UI chat runtime, identity system, memory layer, tools, operator controls, notifications, and future agent-to-agent auth can all live in one deployable agent project. The homepage at `/` is not just a marketing page with a chatbot bolted on. It is the front door to a long-running agent runtime.

This suggests a category:

- Agent-native websites
- Agent-operated websites
- Self-hosted agent websites
- A2A-ready websites

The most direct positioning:

> Auggy lets you deploy an agent as a website, not just embed an agent into a website.

## What changes

A normal website has pages, forms, APIs, auth, and maybe a chat widget.

An Auggy website can have:

- `/` as the public homepage or product surface
- `/agent/run` as an AG-UI compliant chat endpoint
- `/console/chat` as the creator/operator chat surface
- `/.well-known/agent-card.json` for agent card discovery
- `/visitor-auth/verify` for visitor magic-link verification
- Persistent visitor memory
- Trust-tiered capability gates
- Runtime-owned tools and actions
- Operator notifications and escalation
- Future agent-to-agent auth
- Future A2A or `link` mesh access

The site is not only content plus a chatbot. It is a live agent endpoint with a web frontend.

## Why this is different from a chatbot widget

Most current AI website patterns are:

- Website with embedded chat widget
- SaaS helpdesk bot
- Agent backend called by a frontend
- MCP-connected assistant
- Workflow automation behind forms

Auggy's shape is more integrated. The same deployable unit that serves the website also owns the agent runtime. That means the site can be personalized, stateful, action-capable, and channel-aware by construction.

For a small business, this is practical. They do not want to integrate a website, chatbot vendor, CRM workflow, notification system, and support inbox. They want one deployed thing that answers visitors, remembers customers, escalates to the owner, sends follow-ups, books jobs, and exposes a clean public surface.

## Why agent auth matters

Agent auth changes the website from "humans can talk to this agent" to "humans and other agents can safely interact with this site."

That creates a future primitive:

**Websites with authenticated agent visitors.**

Example: a customer's personal assistant visits a store's Auggy site and asks:

> Does this shop have a walnut dining table under 72 inches that can deliver to Brooklyn next week?

The store Auggy can recognize the caller as an agent peer, apply an `agent` trust tier, enforce budgets and rate limits, expose safe catalog/order tools, and return structured answers. Later, with stronger auth and permissions, the customer's agent could request a quote or start checkout.

That is hard to express as just tools. It is a web property with an agent-facing protocol and policy layer.

## Current Auggy pieces

Pieces that already support this direction:

- `webTransport` serves HTTP endpoints, AG-UI SSE chat, health, console, and agent card discovery.
- `visitorAuth` verifies visitors with email magic links and promotes anonymous visitors to recognized identities.
- `fileMemory` and `layeredMemory` give the site persistent identity and visitor memory.
- `knowledge` lets the site answer from operator-owned docs and API-backed sources.
- `notify` escalates to the operator or staff.
- `agentMail` sends and receives email with trust/sender policy, durable inbound
  recovery, outbound review, rate limits, and operator audit.
- `telegramTransport` gives the owner or staff a mobile operator channel.
- `budgets` constrains spend by trust level.
- `turnControl` lets the agent ask for missing user input instead of guessing.
- `link` points toward agent-to-agent interaction.

## Potential new augments

Agent-native websites become more compelling as commerce, scheduling, and operational augments land:

- `stripe` for payment links, invoices, subscriptions, refunds, and charge status
- `shopify` or `square` for catalog, inventory, and order workflows
- `calendly` or `calendar` for booking and availability
- `crm` for customer profile and relationship history
- `maps` for service area and drive-time estimates
- `slack` for team escalation
- `github`, `linear`, or `jira` for software support workflows
- `peer-directory` for agent discovery
- `approval-gate` for human signoff on risky actions

## Example: boutique retailer

The retailer's Auggy is both the website and the concierge.

- `/` is the public store homepage.
- `/agent/run` powers visitor chat.
- `/console/chat` is the owner/admin chat.
- `/visitor-auth/verify` handles customer verification.
- `knowledge` owns policies, product notes, sizing, care, and shipping details.
- `layeredMemory` remembers verified customer preferences.
- `notify` escalates discount requests or high-intent customers to the owner.
- `agentMail` sends follow-up emails.
- Future `stripe` or `shopify` augments handle payment links and order lookup.
- Future agent auth lets customer-side agents query inventory safely.

This is not a store website with a chatbot. It is a storefront operated by a runtime that can identify, remember, escalate, and act.

## Example: field services company

The company's Auggy is the public intake site and dispatch layer.

- `/` is the public booking/intake page.
- Visitor chat triages jobs.
- `visitorAuth` identifies repeat customers.
- `layeredMemory` remembers equipment, location, and prior service history.
- `knowledge` contains service rules, warranty terms, and pricing bands.
- `telegramTransport` connects technicians and the owner.
- `notify` escalates urgent jobs.
- Future `calendar`, `dispatch`, `maps`, and `quickbooks` augments coordinate scheduling, assignment, route estimates, and invoices.

The same runtime handles public anonymous visitors, public recognized customers,
technicians, and owners with different runtime identity and capability policy.

## Example: software company

The company's Auggy is the support/docs entrypoint and future agent-facing support endpoint.

- `/` is the support or docs landing page.
- Human users ask account and product questions through AG-UI chat.
- Verified customers get account-aware help.
- `knowledge` exposes product docs and runbooks.
- `agentMail` sends customer follow-ups.
- `notify` escalates to support or engineering.
- Future `github`, `linear`, `sentry`, `datadog`, and `stripe` augments connect engineering and billing workflows.
- Future `link` and agent auth let internal or partner agents route work into the right specialized agent.

This points toward a facility of specialized agents behind a public web surface, rather than one giant assistant with every permission.

## Product risk

The weak version of this idea sounds like "we also serve HTML." That is not defensible.

The strong version depends on making the frontend/runtime unity feel real:

- Scaffold a usable public homepage.
- Make AG-UI chat easy to embed there.
- Make visitor auth work cleanly.
- Expose agent card discovery.
- Support public, recognized, creator, and agent trust modes.
- Make operator escalation first-class.
- Add agent auth and `link` when ready.

If those pieces are real, the pitch has teeth.

## Thesis

Agent-native websites are web properties where the homepage, chat interface, visitor identity, agent runtime, memory, tools, and future A2A access are one coherent system.

That is different from embedding a chatbot into a site. The site itself is operated by the agent runtime.

The deeper platform pattern is covered in [Agent-Native App Backends](./agent-native-app-backends.md): deterministic API routes and agent-mediated tools can belong to the same augment, so Auggy can serve both the public web surface and the app backend behind it.

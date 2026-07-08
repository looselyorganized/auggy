# Agent-Native Backend Before And After

> Grounded examples of when Auggy is a strong backend choice, what it replaces, and what parts of the existing stack still remain.

Auggy does not replace your frontend, database, auth provider, payment provider,
or domain services. It replaces the agent/backend glue layer where routes,
tools, auth context, memory, transports, and model calls otherwise get stitched
together by hand.

The strongest cases are not "add a chatbot." They are cases where the same
business capability needs both deterministic software paths and model-mediated
paths.

## 1. Service Intake, Quotes, And Booking

### Old Stack

A typical stack:

```txt
Next.js or React frontend
API routes in Next/Fastify/Express/Rails
Postgres/Supabase/SQLite for leads
Google Calendar/Calendly for availability
Stripe for payment links
SendGrid/Twilio/Slack/Telegram for notifications
Separate LLM endpoint such as /api/chat
```

The frontend calls deterministic routes such as:

```txt
POST /leads
GET  /availability
POST /appointments/hold
```

The chat endpoint separately calls the model and exposes tools such as:

```txt
save_lead
search_services
hold_slot
```

Usually those tools re-wrap the same service functions the API routes already
use. Auth, rate limits, audit logs, and escalation policy often get duplicated
across route middleware, tool wrappers, and webhook handlers.

### New Stack With Auggy

Keep the frontend: Next.js, React, Remix, or another app framework.

Keep the data and services: Postgres/Supabase/SQLite, Google Calendar, Stripe,
CRM, email, SMS, Telegram, or whatever systems the business already uses.

Use Auggy as the agent-native backend runtime. A `booking` or `services`
augment owns deterministic routes:

```txt
GET  /services
POST /leads/create
GET  /availability
POST /appointments/hold
POST /checkout/create
POST /webhooks/stripe
```

The same augment exposes model tools over the same domain logic:

```txt
service_search
save_lead
find_slots
hold_appointment
send_payment_link
```

Then compose built-in augments around it:

```txt
webTransport     browser chat + HTTP routes
knowledge        policies, service descriptions, pricing notes
visitorAuth      public recognized caller identity
layeredMemory    repeat visitor preferences/history
notify           staff/operator escalation
agentMail        outbound follow-up email, where appropriate
```

### Why It Is Better

The win is not that Auggy magically books appointments. The win is that one
backend capability owns both paths:

```txt
frontend form -> POST /leads/create
chat intent   -> save_lead tool
```

Both can call the same `saveLead()` domain function, use the same schema, write
the same audit record, trigger the same notification rule, and enforce the same
route/tool policy. The model clarifies messy intent; deterministic routes
perform durable state changes.

This is safer because the model is not simulating bookings or payments in text.
It is less code because you avoid maintaining a separate chat tool backend
parallel to your API backend. It is more operable because public routes,
private routes, tools, memory, notifications, and auth posture are inspectable
as one runtime surface.

### Where Auggy Does Not Help

If the site is only static pages plus a contact form, Auggy is too much. A
normal form handler is simpler.

## 2. Authenticated SaaS Customer Support And Account Actions

### Old Stack

A SaaS app uses Clerk, Auth0, Supabase Auth, or custom sessions. The product
backend has API routes for orders, invoices, subscriptions, tickets, usage,
refunds, and similar account operations. The support assistant is added as a
separate chat endpoint.

Common pattern:

```txt
browser session -> app backend verifies Clerk/Auth0/Supabase
chat request    -> /api/chat
/api/chat       -> model call with tools
tools           -> internal API/service-token calls
```

Engineers then have to ensure every tool wrapper checks that the current user
can access `order_123`, `invoice_456`, or `workspace_abc`. If a route and a
model tool both refund an order, they often have parallel authorization checks.
One lives in app API middleware; the other lives in tool wrapper code.

### New Stack With Auggy

Keep Clerk/Auth0/Supabase/custom auth as the source of truth.

Your app backend verifies the normal app session and mints a short-lived Auggy
auth assertion containing narrow scopes/grants, for example:

```json
{
  "subject": "user_123",
  "scopes": ["orders.read"],
  "grants": [
    { "action": "refund.issue", "resource": "order_123" }
  ]
}
```

Browser code calls Auggy routes using a generated Auggy client, passing that
assertion. Chat also sends the assertion into `/agent/run`.

An `orders` augment owns deterministic routes:

```txt
GET  /orders
POST /orders/:id/refund
GET  /subscriptions/current
POST /tickets/create
```

The same augment owns model tools:

```txt
lookup_orders
refund_order
explain_subscription
create_support_ticket
```

The route and tool both declare authorization requirements:

```txt
POST /orders/:id/refund
requires: refund.issue on resource param "id"

refund_order tool
requires: refund.issue on input field "orderId"
```

### Why It Is Better

This is one of Auggy's strongest backend cases.

Clerk/Auth0/Supabase still handles authentication. Auggy does not replace it.
The app remains the authority on who the user is and what they are allowed to
do.

Auggy helps because the authorization boundary is shared by routes and tools.
The route binds permission to a path param. The tool binds permission to
validated tool input. That means `POST /orders/order_123/refund` and
`refund_order({ orderId: "order_123" })` can be protected by the same grant
model.

That is materially safer than "the model saw account context, so hopefully it
only calls the right tool." The model can ask for a refund, but Auggy enforces
whether the caller has a matching grant before the tool runs. The model does
not decide identity or authorization.

It also reduces duplicate code. Instead of implementing one authorization path
for REST handlers and another for LLM tools, route/tool auth requirements live
next to the capability. Your app backend still mints grants, but Auggy
consistently enforces them for both deterministic and model-mediated access.

### Where Auggy Does Not Help

If your assistant only answers public docs questions and never touches private
account state, normal RAG plus your existing chat endpoint may be enough.

## 3. Multi-Channel Operations Agent

### Old Stack

A small operations team has a website chat widget, a Telegram bot for the
owner, webhook handlers, cron jobs, notification scripts, and a separate LLM
endpoint.

The stack might be:

```txt
Next.js frontend
Express/Fastify API
Telegram bot process
Webhook endpoints
BullMQ/Temporal/cron worker
OpenAI/Anthropic chat endpoint
Postgres/Redis
Slack/Telegram/email notifications
```

Each entrypoint has its own auth assumptions. Website visitors are public. The
owner on Telegram is trusted. Webhooks are provider-signed. Internal jobs use
service credentials. The model/tool layer often has to rediscover those
distinctions manually.

### New Stack With Auggy

Keep the frontend, database, queue if needed, and external systems.

Use Auggy as the runtime that normalizes those entrypoints into one agent
backend:

```txt
webTransport        browser chat, HTTP routes, health, console
telegramTransport   owner/staff Telegram channel
notify              outbound operator alerts
visitorAuth         public caller recognition
knowledge           policies/runbooks/service info
custom dispatch     routes + tools for jobs/intake/assignment
custom quotes       routes + tools for quotes/proposals
custom tickets      routes + tools for support state
```

The custom `dispatch` augment might expose deterministic routes:

```txt
POST /intake/create
GET  /jobs/:id
POST /jobs/:id/assign
POST /webhooks/calendar
```

and model tools:

```txt
create_intake
lookup_job
suggest_assignment
notify_dispatcher
```

### Why It Is Better

The value is coordinated identity and capability exposure.

A public website visitor can create an intake request but cannot assign a
technician. A `public` + `recognized` caller can see their own job status. The owner on
Telegram can approve a schedule change. A webhook can update calendar state
without waking the model. The model sees only the tools available for the
current trust posture, and execution is checked again at runtime.

Without Auggy, teams usually build this as several small services plus a chat
endpoint, then pass identity/context around informally. Auggy gives you one
place where transports, peer identity, routes, tools, memory, rate limits,
budgets, and operator notifications meet.

This is not automatically more scalable than a hand-built service. The
performance benefit is mostly that deterministic route traffic does not need a
model call, and event/webhook traffic can stay deterministic unless the agent
actually needs to reason. The engineering benefit is cleaner separation: routes
for exact work, tools for agent-mediated work, augments as the ownership
boundary.

### Where Auggy Does Not Help

If all channels just append messages to a ticket queue and no model-mediated
action is needed, a conventional bot plus API is simpler.

## The Real Common Thread

Auggy becomes compelling when all of these are true:

1. You need deterministic API behavior.

   Forms, webhooks, frontend clients, generated clients, account lookups,
   booking holds, payments, and admin actions should not depend on a model.

2. You also need model-mediated behavior.

   The agent has to clarify intent, summarize, recommend, draft, search,
   escalate, or choose among typed actions.

3. Both paths touch the same domain capability.

   This is the important bit. If routes and tools are unrelated, Auggy is just
   another runtime. If they are two faces of the same capability, Auggy gives
   you a useful ownership boundary.

4. Auth and policy matter.

   Auggy is stronger when identity, trust level, delegated grants, route auth,
   tool auth, rate limits, budgets, and audit need to be applied consistently.
   This is the part engineers should care about most.

5. You want the model out of the critical path where it does not belong.

   Catalog search route? Deterministic. Stripe webhook? Deterministic. Refund
   explanation? Model can help. Refund execution? Deterministic policy and
   route/tool enforcement.

The principal-engineer version:

> Auggy is not replacing your app stack. It replaces the ad hoc layer where
> teams otherwise glue an LLM tool loop onto an existing backend and then
> duplicate auth, schemas, side effects, memory, routes, and operational
> controls around it.

That is why it is less compelling for plain CRUD apps: CRUD already has a good
ownership model in conventional frameworks.

It is less compelling for simple chatbots: a single `/api/chat` endpoint is
often enough.

It becomes a strong choice when the system is an app backend and an agent
backend at the same time.

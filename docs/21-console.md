# /console — Chat-First Operator Surface

The per-agent browser surface served at `GET /console` by agents that mount
`webTransport`.

## V1 Contract

`/console` is the fastest path to talking with one running agent. It is not a
dashboard, config editor, augment workbench, process manager, or fleet view.

The default route redirects to `/console/chat`.

Primary surface:

- Agent name
- Connection status
- Provider/model label when available from `agent.yaml`
- Chat transcript
- Message composer

Secondary surface:

- A compact Details dialog
- Purpose/description
- Agent UUID, copyable
- Runtime URL, copyable
- Agent card URL, copyable
- Health URL, copyable
- Mounted transport summary
- Augment count
- Copy diagnostics

The operator question this UI answers is: "Am I talking to the right agent, and
is it working?"

## Deliberately Excluded

These stay out of the v1 first-run console:

- Raw agent card JSON
- Full augment and tool schemas
- Credential editing
- Skill editing
- Budget internals
- Visitor/auth policy controls
- Process controls
- Cross-agent views

The CLI remains the control plane for create, configure, doctor, run, deploy,
logs, and augment installation.

## Auth

HTTP Basic auth. Username blank, password is the agent bearer
(`AUGGY_WEB_TOKEN` in the agent's `.env`). The same credential protects
`/agent/run`.

State-mutating endpoints additionally require a CSRF token bound to the
specific action. Chat uses a dedicated `console-chat` CSRF token because the
server attaches the bearer when proxying to `/agent/run`.

HTTPS is enforced on non-loopback hostnames. Loopback requests skip the bearer
check because shell access to the host already grants `.env` access.

## Implementation

Single-page React app at `/console`. Stack: React 19 + Vite + Tailwind +
Radix primitives. Source: `admin/`. Build output: `admin/dist/`.

The runtime serves static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`. The SPA consumes JSON endpoints under
`/console/api/*`; these endpoints remain available for future developer tools,
but they are not exposed as top-level v1 tabs.

## Operator Entry Points

- `auggy run <name>` boots the agent and opens `/console/chat`.
- `auggy dev <name> --open` is the lower-level equivalent.
- `auggy dev <name>` boots foreground without launching a browser.
- `auggy list` shows each agent's console URL alongside name and status.

## Deferred

- Dedicated config/admin workbench
- Memory browser
- Trace/event inspector
- Skill and credential editing
- Multi-agent/facility hub
- Browser-based create wizard

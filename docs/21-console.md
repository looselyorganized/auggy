# /console — Chat-First Operator Surface

The per-agent browser surface served at `GET /console` by agents that mount
`webTransport`.

## V1 Contract

`/console` is the fastest path to talking with one running agent. It is not a
dashboard, config editor, augment workbench, process manager, or fleet view.

The default route redirects to `/console/chat`.

Primary surfaces:

- Chat transcript and message composer
  - GitHub-flavored Markdown rendering for assistant/user messages, including
    tables, task lists, fenced code, headings, blockquotes, links, and inline
    emphasis
  - Copyable Markdown transcript for debugging the visible conversation,
    including rendered messages, visible tool calls, and assistant errors
- Integrations/status view for the agent's current runtime surfaces
  - Built-in web endpoints and which ones are safe to open directly
  - Public discovery posture (`publicIntegration`, `/agent`, agent card)
  - Read-only web auth posture (`allowAnonymous`, CORS, visitor tokens, external auth)
  - TypeScript request example first, cURL smoke-test example second
  - Live augment HTTP route manifest summary
  - CLI commands for route JSON, OpenAPI, and generated clients
- Capabilities runtime map
  - Mounted augments grouped by runtime role
  - Routes, tools, memory providers, and auth posture by owner
  - Warnings for public/auth/schema mismatches derived from live state

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

The operator questions this UI answers are: "Am I talking to the right agent?",
"is it working?", and "what can this running agent do right now?"

## Deliberately Excluded

These stay out of the v1 first-run console:

- Raw agent card JSON
- Full augment and tool schemas
- Credential editing
- Skill editing
- Budget internals
- Visitor/auth policy editing beyond the current public discovery toggle
- Process controls
- Cross-agent views

The CLI remains the control plane for create, configure, doctor, run, deploy,
logs, and augment installation.

## Auth

HTTP Basic auth. Username blank, password is the agent bearer
(`AUGGY_WEB_TOKEN` in the agent's `.env`). The same bearer is accepted by
`/agent/run` for creator-authorized chat, but the transport may also allow
anonymous, visitor-token, or external-auth traffic depending on configuration.

State-mutating endpoints additionally require a CSRF token bound to the
specific action. Chat uses a dedicated `console-chat` CSRF token because the
server attaches the bearer when proxying to `/agent/run`.

Chat Markdown rendering does not enable raw HTML, does not render remote images,
and blocks unsafe link protocols such as `javascript:`, `data:`, `vbscript:`,
and `file:`.

HTTPS is enforced on non-loopback hostnames. Loopback requests skip the bearer
check because shell access to the host already grants `.env` access.

## Implementation

Single-page React app at `/console`. Stack: React 19 + Vite + Tailwind +
Radix primitives. Source: `admin/`. Build output: `admin/dist/`.

The runtime serves static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`. The current SPA exposes Chat,
Integrations, and Capabilities as top-level sections.

`/console/api/dashboard` returns the agent card, agent metadata, augment
summaries, tool inventory, web posture state, the live route manifest
summary/entries, CSRF tokens, skill snapshots, and raw admin blocks used by
current or future developer tools.

Older unreachable React tabs for identity, skills, credentials, budget,
security, and augments have been removed from the preview bundle. The backend
dashboard/action APIs remain where they are still tested and feed the live
dashboard payload or future developer tools; they are not promoted to top-level
`0.5` console product surfaces.

## Operator Entry Points

- `auggy run <name>` boots the agent and opens `/console/chat`.
- `auggy dev <name> --open` is the lower-level equivalent.
- `auggy dev <name>` boots foreground without launching a browser.
- `auggy list` shows each agent's console URL alongside name and status.

## Deferred

- Dedicated config workbench
- Memory browser
- Trace/event inspector
- Skill and credential editing
- Multi-agent/facility hub
- Browser-based create wizard

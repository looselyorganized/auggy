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
- Integrations view organized by caller
  - **Browser application** first, with posture-aware authentication guidance,
    a browser-safe AG-UI example, CORS state, and browser-callable app routes
  - **Server application** with server-only bearer guidance and AG-UI examples
    that read the credential from the environment
  - **Agent-to-agent** labeled **Coming soon** until the A2A acceptance criteria
    in [`ROADMAP.md`](./ROADMAP.md#agent-to-agent-mesh) are met
  - Live augment HTTP route manifest summary, kept distinct from chat over
    `/agent/run`
  - CLI commands for route JSON, OpenAPI, and generated route clients
- Capabilities runtime map
  - An observed snapshot of the currently mounted runtime, not a declaration of
    everything an agent was intended to support
  - Mounted augments grouped by runtime role, with owner-scoped routes, tools,
    memory surfaces, installed or available skills, and reported access controls
  - **Issues** for errors and warnings that may prevent a surface from working;
    **Notes** for incomplete metadata or non-blocking observations
  - Access controls describe controls the runtime reports as configured. Their
    presence is not a blanket claim that an augment, route, or deployment is
    secure
  - Connection strings, client generation, CORS, and authentication setup stay
    on Integrations; Capabilities links there when configuration work is needed

Secondary surface:

- A compact Details dialog
- Purpose/description
- Agent UUID, copyable
- Runtime URL, copyable
- Health URL, copyable
- Mounted transport summary
- Augment count
- Copy diagnostics

Connection and generated-client guidance lives on the Integrations page. The
Capabilities page intentionally avoids repeating credentials, connection URLs,
raw schemas, and authorization constraint objects.

The operator questions this UI answers are: "Am I talking to the right agent?",
"is it working?", and "what can this running agent do right now?"

## Deliberately Excluded

These stay out of the v1 first-run console:

- Raw agent card JSON
- Full augment and tool schemas
- Credential editing
- Skill editing
- Budget internals
- Visitor/auth policy editing beyond disabling an already-published legacy
  discovery surface
- Process controls
- Cross-agent views

The CLI remains the control plane for create, configure, doctor, run, deploy,
logs, and augment installation.

## Auth

On non-loopback hosts, `/console` uses HTTP Basic auth with a blank username and
the agent bearer as the password (`AUGGY_WEB_TOKEN` in the agent's `.env`). The
same bearer is accepted by `/agent/run` for creator-authorized chat, but the
transport may also allow anonymous, visitor-token, or external-auth traffic
depending on configuration. Loopback console requests skip the bearer check
because shell access to the host already grants access to the local `.env`.

State-mutating endpoints additionally require a CSRF token bound to the
specific action. Chat uses a dedicated `console-chat` CSRF token because the
server attaches the bearer when proxying to `/agent/run`.

Chat Markdown rendering does not enable raw HTML, does not render remote images,
and blocks unsafe link protocols such as `javascript:`, `data:`, `vbscript:`,
and `file:`.

## Conversation Storage

With the console enabled, CLI-started agents persist console conversations to
`<agentDir>/data/console-chat.db` by default. This project-local file survives
browser refreshes and local agent restarts as long as the agent directory is
retained.

On Railway, persistence requires a volume mounted at the directory
**`/app/data`**. The default database is the exact path
**`/app/data/console-chat.db`** inside that volume. The generated Railway
entrypoint fails closed unless Railway advertises
`RAILWAY_VOLUME_MOUNT_PATH=/app/data` and that path is a real mounted
directory; it never creates an ephemeral `/app/data` fallback.

Configure a different path under the web transport augment, or opt into
ephemeral process memory explicitly:

```yaml
type: webTransport
config:
  consoleChat:
    dbPath: null # explicit opt-out: refresh/restart durability is disabled
```

Relative paths resolve from the agent directory locally. In a Railway runtime,
they are confined to `/app/data`; absolute paths outside `/app/data` are
rejected during deploy preflight and again by the runtime resolver.

### Restart, scaling, and backup contract

- Completed conversations, unread state, titles, and model history survive a
  process restart. A run that was active during a crash or restart is recovered
  as interrupted rather than left permanently streaming.
- Keep the Railway service at **exactly one replica**. The SQLite-backed console
  has one process/one writer semantics; mounting the same database from multiple
  replicas is unsupported and can produce contention or inconsistent runtime
  ownership. Move chat state to a shared database before horizontal scaling.
- A Railway volume provides restart durability, not an independent backup.
  Include `console-chat.db` in the agent's backup and restore plan. Do not copy
  only the main database while the agent is writing: stop the agent first, then
  copy the database and any `console-chat.db-wal` / `console-chat.db-shm`
  siblings together, or use a storage snapshot with an equivalent consistency
  guarantee. Test restoration before relying on the backup.
- Deleting a thread removes it from the SQLite database. External backups and
  snapshots are the recovery boundary; the volume itself has no trash, and the
  console has no built-in point-in-time restore.

HTTPS is enforced on non-loopback hostnames.

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

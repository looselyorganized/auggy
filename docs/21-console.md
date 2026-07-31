# /console — Chat-First Operator Surface

The per-agent browser surface served at `GET /console` by agents that mount
`webTransport`.

## V1 Contract

`/console` is the fastest path to talking with one running agent. It also
provides a focused Mail action center when one or more `agentMail` instances
are mounted. It is not a general config editor, augment workbench, process
manager, or fleet view.

The default route redirects to `/console/chat`.

Primary surfaces:

- Chat transcript and message composer
  - GitHub-flavored Markdown rendering for assistant/user messages, including
    tables, task lists, fenced code, headings, blockquotes, links, and inline
    emphasis
  - Copyable Markdown transcript for debugging the visible conversation,
    including rendered messages, visible tool calls, and assistant errors
- Mail action center, present only when AgentMail reports a supported
  metadata projection
  - One explicit mailbox selector when multiple instances are mounted
  - Inbox address, inbound/runtime posture, pending review, and
    creator-attention queues
  - Creator-authenticated, on-demand detail drawers for message and draft
    content; bodies and approval fingerprints are not embedded in the
    dashboard snapshot
  - Row-bound approve/send, revise/send, reject, and dismiss decisions, plus
    explicit sent/not-sent and handled/no-effect reconciliation for ambiguous
    outcomes, with stale-state handling
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

## Auth and browser boundary

`/console` always requires authentication, including on loopback. The first-party
login page accepts the agent bearer (`AUGGY_WEB_TOKEN` in the local `.env` or
deployment secret) and sets an HTTP-only session cookie. HTTP Basic with a
blank username and the same bearer as the password remains available for
operator automation. The bearer is
also accepted by `/agent/run` for creator-authorized chat, but that route may
separately allow anonymous, visitor-token, or external-auth traffic.

`auggy run` and `auggy console` request a random, process-local browser ticket
using explicit Basic authentication. The ticket expires after 30 seconds, is
consumed once, and is exchanged for the same HTTP-only session cookie before the
browser is redirected to `/console/chat`. The permanent bearer never appears in
the browser URL. Remote ticket requests require HTTPS; direct loopback HTTP is
the only exception. If the exchange is unavailable, the CLI opens the normal
login page. For a local agent it points to `AUGGY_WEB_TOKEN` in the agent's
`.env`; for Railway it points to the service variable, normally synced from
that `.env` by `auggy deploy`.

The branded login is generated as three fixed, registry-authored HTML documents
and one fingerprinted stylesheet. It has no JavaScript dependency. If that
generated bundle is absent or invalid, the server returns a semantic native
form with the same password and fixed-error behavior. Only the exact
manifest-listed stylesheet is public before authentication; the manifest,
HTML variants, login JavaScript, and main Console assets are not.

The console validates the exact Host and Origin before authentication. Local
origins for `localhost`, `127.0.0.1`, and `::1` on the configured port are
allowed automatically. Public deployments must configure exact
`consoleSecurity.allowedOrigins`; a valid `AUGGY_PUBLIC_URL` contributes its
origin automatically. Forwarding headers are accepted only from an immediate
peer in `trustedProxies`; deployment-platform environment variables never grant
proxy trust.

State-mutating endpoints additionally require a CSRF token bound to the exact
augment instance, action, and row identity. The legacy action-only endpoint
remains usable only when an action ID has one mounted owner; collisions fail
with a conflict instead of dispatching by registration order. Chat uses a
dedicated `console-chat` CSRF token because the server attaches the bearer when
proxying to `/agent/run`.

All console responses deny framing with CSP `frame-ancestors 'none'` and
`X-Frame-Options: DENY`. Logout is POST-only and requires authentication,
same-origin validation, and a dedicated CSRF token.

The console refuses to follow symlinks below the agent directory when managing
`agent.yaml`, identity, `.env`, or installed skills. Replace intentionally
symlinked managed files with regular in-workspace files, or manage them outside
the console. On macOS and Linux, the first managed-file operation pins the
canonical agent directory and all subsequent traversal is descriptor-relative;
replacing an ancestor cannot redirect reads or mutations. Managed-file
operations fail closed on unsupported operating systems. Run the agent as a
dedicated, least-privileged user and do not grant hostile processes direct write
access to its agent directory.

On Windows, the authenticated console, chat, and runtime views still start, but
identity, credential, skill, and other agent-file management remains
unavailable because the descriptor-relative POSIX boundary cannot be provided.
Use ordinary project tooling for those files rather than weakening the console
boundary.

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

The authenticated dashboard payload includes a `runtime` object containing
bounded process-local capacity, outcome, timing, kernel response-delivery,
thread-recovery, shutdown, and memory signals. It is returned with
`Cache-Control: no-store`. The object contains no
customer identifiers or content and resets after a runtime restart. The
console is a viewer for these signals, not a metrics store or alerting system.

- Completed conversations, unread state, titles, and model history survive a
  process restart. A run that was active during a crash or restart is recovered
  as interrupted rather than left permanently streaming.
- Persisted thread ownership includes the resolved organization when external
  authentication supplies one. Schema versions 2 and 3 migrate atomically.
  Legacy bound rows have no organization and remain accessible only to the
  same no-organization identity; they are never treated as organization
  wildcards. An organization-bearing identity must begin a new thread instead
  of silently adopting a legacy row.
- Keep the Railway service at **exactly one replica**. The SQLite-backed console
  has one process/one writer semantics; mounting the same database from multiple
  replicas is unsupported and can produce contention or inconsistent runtime
  ownership. Move chat state to a shared database before horizontal scaling.
- A Railway volume provides restart durability, not an independent backup.
  `auggy state backup` includes `console-chat.db` in the stopped-runtime volume
  bundle, verifies the copied SQLite state, and restores only behind the
  reconciliation fence. See [Runtime State Recovery](./27-runtime-state-recovery.md).
- Deleting a thread removes it from the SQLite database. External backups and
  snapshots are the recovery boundary; the volume itself has no trash, and the
  console has no built-in point-in-time restore.

HTTPS is enforced on non-loopback hostnames.

## Implementation

Single-page React app at `/console`. Stack: React 19 + Vite + Tailwind +
Radix primitives. Source: `admin/`. Build output: `admin/dist/`.

The runtime serves static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`. The current SPA exposes Chat,
Integrations, and Capabilities as top-level sections, plus Mail when the
dashboard contains at least one supported AgentMail projection.

`/console/api/dashboard` returns the agent card, agent metadata, augment
summaries, tool inventory, web posture state, the live route manifest
summary/entries, target-aware CSRF tokens, skill snapshots, and admin blocks.
AgentMail blocks may add a versioned `projection.kind: "mail"` list view.
That projection is intentionally content-minimized: it can contain bounded
sender/correspondent, subject, timestamps, status, and same-origin detail
paths, but not a message body, draft body, HTML, or approval fingerprint.
Detail endpoints require creator authentication and return `Cache-Control:
no-store`.

Skill snapshots report content provenance separately from installation state
and owning augment:

| Provenance | What the runtime can prove |
| --- | --- |
| `auggy-provided` | The installed bytes match the skill shipped by the running Auggy package. |
| `customized-auggy-skill` | Auggy ships a skill at this path, but the installed bytes differ. |
| `user-created` | The running Auggy package has no skill source at this path. |

The Console displays these as **Auggy-provided**, **Customized Auggy skill**,
and **User-created**. It does not infer whether a skill was present when the
agent was scaffolded or added later; no installation-history ledger exists.
Available skills use `auggy-provided`, while `fromAugmentType` independently
identifies the owning augment.

Older unreachable React tabs for identity, skills, credentials, budget,
security, and augments have been removed from the preview bundle. The backend
dashboard/action APIs remain where they are still tested and feed the live
dashboard payload or future developer tools; they are not promoted to top-level
`0.5` console product surfaces.

## Operator Entry Points

- `auggy run <name>` boots the agent and opens `/console/chat` already signed in.
- `auggy console <name>` opens an already-running local agent or its saved Railway
  deployment already signed in. Add `--cloud` to prefer Railway when both exist.
- `auggy dev <name> --open` is the lower-level local equivalent.
- `auggy dev <name>` boots foreground without launching a browser.
- `auggy list` shows each agent's console URL alongside name and status.

## Deferred

- Dedicated config workbench
- Memory browser
- Trace/event inspector
- Skill and credential editing
- Multi-agent/facility hub
- Browser-based create wizard

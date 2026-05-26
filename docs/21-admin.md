# /admin — Operator Workbench

The per-agent operator surface served at `GET /admin` by every agent that
mounts the `webTransport` augment. One agent = one `/admin`.

## Scope

`/admin` is **per-agent**. There is no cross-agent dashboard, no central
hub, no fleet view. Operators with multiple local agents open multiple
browser tabs — one per agent's port. `auggy list` surfaces the URLs.

A multi-agent surface is a *post-link* concern (facility/hub, owned by
Zip), not a v1.0 deliverable.

## Auth

HTTP Basic auth. Username blank, password is the agent's bearer
(`AUGGY_WEB_TOKEN` in the agent's `.env`). Same credential the operator
uses on `/agent/run`. The browser caches it per origin so the operator
logs in once per tab.

State-mutating actions additionally require a CSRF token bound to the
specific `(actionId, rowKey)` tuple — page-shared tokens are rejected.
See `src/transports/admin/admin-csrf.ts`.

HTTPS is enforced on non-loopback hostnames. Hitting `/admin` over
plaintext HTTP from a non-loopback address returns `426 Upgrade Required`
with guidance.

## Surface

Single-page React app at `/admin`. Stack: React 19 + Vite + Tailwind +
shadcn (Radix primitives). Source: `admin/`. Build output: `admin/dist/`.
The runtime serves the SPA's static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`.

The SPA consumes JSON endpoints under `/admin/api/*`. Endpoint shape is
package-locked: `admin/dist/` ships inside the same release as the auggy
runtime, so the JSON contract is always in lockstep with the SPA build.
No API versioning prefix in v1; add it only if the packaging ever splits.

## Tabs

v1.0 surfaces a fixed set of tabs. Tab list and feature boundaries are
owned by the SPA's `App.tsx`. Each tab maps to one or more `/admin/api/*`
endpoints and to one or more augment `adminInfo()` blocks.

**Principle:** tabs answer operator questions, not data sources. Add a
tab when the operator has a distinct question to ask; don't add a tab
because a new data shape exists. Memory + budgets + traces are different
lenses on "what is this agent doing?" — consolidate into one Inspect
view unless operators repeatedly ask for them separately.

## Augment contract

Augments expose admin surfaces via the `adminInfo()` method on the
`Augment` type (see `src/types.ts` — `AdminInfoBlock`). Each block
declares:

- `sections[]` — read-only views (`keyValue`, `table`, `status`)
- `actions[]` — operator-invokable mutations (form-shaped inputs, CSRF
  required, audit-logged)

The SPA renders these uniformly. Adding a new admin capability means
extending the augment's `adminInfo()`, not editing the SPA.

## What's NOT in /admin

- **Cross-agent views.** One agent per surface. Multi-agent is link-era.
- **Process control** (`start`/`stop`/`restart`). Those stay in the CLI
  because they cross trust boundaries (launchd, signals).
- **`auggy create`.** Scaffolding is operator-local; the agent that would
  host /admin doesn't exist yet.
- **Headless / no-JS fallback.** Operators without a browser use
  `auggy dev` and the agent's other endpoints directly.

## Operator entry points

- `auggy run <name>` — boots the agent and opens `/admin` in the
  operator's default browser. The happy-path command.
- `auggy dev <name>` — boots the agent foreground without launching a
  browser. For headless / scripted use.
- `auggy list` — shows each agent's `/admin` URL alongside name + status.

## Deferred

- Multi-agent / facility hub (post-link)
- SPA-driven `auggy create` wizard (CLI is good enough for v1.0)
- API versioning (only needed if `admin/dist/` packaging splits from the
  runtime)
- Cross-operator collaboration / multi-seat

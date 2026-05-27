# /console — Operator Workbench

The per-agent operator surface served at `GET /console` by every agent that
mounts the `webTransport` augment. One agent = one `/console`.

## Scope

`/console` is **per-agent**. There is no cross-agent dashboard, no central
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

HTTPS is enforced on non-loopback hostnames. Hitting `/console` over
plaintext HTTP from a non-loopback address returns `426 Upgrade Required`
with guidance.

## Surface

Single-page React app at `/console`. Stack: React 19 + Vite + Tailwind +
shadcn (Radix primitives). Source: `admin/`. Build output: `admin/dist/`.
The runtime serves the SPA's static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`.

The SPA consumes JSON endpoints under `/console/api/*`. Endpoint shape is
package-locked: `admin/dist/` ships inside the same release as the auggy
runtime, so the JSON contract is always in lockstep with the SPA build.
No API versioning prefix in v1; add it only if the packaging ever splits.

---

## Tabs (v1.0)

Seven tabs. Each owns one operator question. No tab is named after an
augment; tabs are named for the question the operator is asking.

| # | Tab | Operator question | Backing augments |
|---|---|---|---|
| 1 | **Chat** | "Talk to the agent." | webTransport (kernel SSE surface) |
| 2 | **Identity** | "Who is this agent?" | fileMemory@system (identity.md) |
| 3 | **Skills** | "What does it know how to do?" | skills runtime mount + per-augment SKILL.md files |
| 4 | **Credentials** | "What secrets does it hold?" | env vars (cross-cutting) |
| 5 | **Budget** | "What can it spend?" | budgets |
| 6 | **Security** | "Who can interact with it?" | webTransport.auth + visitorAuth.visitors |
| 7 | **Augments** | "What's plumbed in?" | composition + all augments |

### Tab visibility

The sidebar is rendered from `/console/api/augments`, not from a hardcoded
route list. **Tab visibility maps to installed augments**:

- Tabs whose backing augment(s) aren't installed are hidden from the sidebar.
- Direct URL access to a hidden tab renders a "not installed — visit
  Augments to add it" message rather than an empty form.
- Identity is effectively always visible (the `identity:` shorthand
  synthesizes a fileMemory@system entry at parse time).
- Skills is always visible (the skills mount is auto-mounted runtime
  infrastructure per ADR-030).
- Credentials is always visible (env vars always exist).
- Augments is always visible.
- Chat appears when webTransport is present (i.e., always for a
  browser-reachable agent — if webTransport isn't mounted, /console
  itself isn't served, so the question is moot).
- Budget appears when `budgets` is in agent.yaml.
- Security appears when webTransport's auth posture is exposed OR
  visitorAuth is installed.

### The rule

Every augment has exactly **one home**. No augment's options live in
two places.

---

## Augments tab contract

The **Augments tab is the registry — not an editor**. It owns
composition, status, and add/remove. Per-augment options have one of two
homes depending on whether the augment is **promoted** (has a dedicated
operator-question tab):

- **Promoted augment row** (e.g., budgets, visitor-auth): shows type,
  instance name, healthy/error status, and a `Configured in [Tab] ↗`
  link. No inline edit affordance.
- **Unpromoted augment row** (e.g., webFetch, bash, notify, manifest,
  fileMemory@learned, layeredMemory, filesystem, telegramTransport):
  shows type, instance name, healthy/error status, and expandable
  inline options. Edits write back to agent.yaml; the runtime
  hot-reloads if the augment supports it, otherwise prompts for a
  restart.

Composition actions (add augment, remove augment, reorder) live here
**for every augment**, including promoted ones. The Budget tab edits
budget caps; if the operator wants to *uninstall* budgets entirely,
they go to Augments. Composition is a separate concern from
configuration.

---

## Skills tab contract

The **Skills tab owns the knowledge catalog** — the `.md` files
mounted at `<agent-dir>/skills/`. This is distinct from Augments by
construction: augments are hardware, skills are teaching.

Lifecycle differences:

- Mounting the `bash` augment gives the agent shell access (potentially
  dangerous capability).
- Mounting bash's SKILL.md teaches the agent *how to use shell well*
  (quality / safety guidance).

The boot-time validator (ADR-025) warns when a tool-providing augment
has no skill mounted. **The Skills tab is where the operator resolves
that warning.**

The tab shows:

- All mounted skills, grouped by source (augment-bundled vs.
  operator-added)
- Install affordance for augment-bundled skills not yet mounted
  (wraps `auggy add-skill`)
- View/edit affordance for operator-added skills (custom `.md` files
  in `skills/`)

---

## Augment → home mapping

Every augment maps to exactly one home. This table is the source of
truth for what goes where. Updates to it require a docs change in this
file.

| Augment | Operator config | Status | Home |
|---|---|---|---|
| `fileMemory@system` (identity) | path (default `./identity.md`) | file contents | **Identity** |
| `fileMemory@learned` | path | file contents | **Augments** row |
| `layeredMemory` | retention, namespace | entry count, recent peers | **Augments** row |
| `filesystem` | additional mounts | mount list, RO/RW | **Augments** row |
| `skills` | (none — auto-mount) | mounted skill list | **Skills** |
| `webTransport` | port, allowAnonymous | listening URL | **Security** (auth posture) + Chat header (URL) |
| `webFetch` | allowed-hosts | recent fetches | **Augments** row |
| `bash` | allowed-commands, cwd | recent invocations | **Augments** row |
| `manifest` | baseUrl, refresh interval | last sync | **Augments** row |
| `supabaseMemory` | (frozen) | — | hidden (legacy) |
| `budgets` | per-tier caps, dailyBudgetUsd | current spend, transactions | **Budget** |
| `notify` | destinations[], default policy | recent sends | **Augments** row |
| `telegramTransport` | bot token (Credentials), allowed chats | polling status | **Augments** row + **Credentials** (token) |
| `turnControl` | (none — model-driven) | — | hidden |
| `visitorAuth` | verified visitors, reverify TTL | visitor list | **Security** (visitors) |
| `link` | peer config (deferred) | — | future (peer-directory work) |

---

## Promotion policy

When a new augment ships, it appears as a row in the **Augments** tab
with its tunable options inline. **Promotion to a dedicated top-level
tab is not automatic.** Promotion requires all three of:

1. **Frequency.** Operator interacts with this concern weekly or more.
2. **Distinct concern.** Doesn't fit any existing tab's question.
3. **Documented.** Add a section to this spec explaining what the new
   tab owns and why Augments-row treatment is insufficient.

Promotion is a deliberate spec change, not a default. If a new augment
clearly belongs inside an existing tab (e.g., an additional auth
augment goes under Security), update that tab's contract section here
and add the augment to the mapping table — no new tab needed.

### Worked example: AgentMail

If AgentMail ships as an augment for **outbound mail** (used by
visitor-auth verification + notify destinations):

- Operator config: apiKey (lives in **Credentials**), inboxId + default
  labels (lives in the augment's row in **Augments**)
- Status: recent sends, deliverability state (in **Augments** row)
- **Home: Augments row.** Doesn't meet the promotion bar — operators
  set credentials once at setup, the augment then operates invisibly.

If a separate **inbound mail triage** augment ships later (e.g., Zip's
operator-mail flow), that's a different shape — thread state, inbox
state machine, operator approval queue. *That* would warrant a
"Mailbox" tab. But it's a separate decision, made when that augment
exists. Not now.

---

## What's NOT in /console

- **Cross-agent views.** One agent per surface. Multi-agent is link-era.
- **Process control** (`start`/`stop`/`restart`). Stays in the CLI —
  crosses trust boundaries (launchd, signals).
- **`auggy create`.** Scaffolding is operator-local; the agent that
  would host /console doesn't exist yet.
- **Headless / no-JS fallback.** Operators without a browser use
  `auggy dev` and the agent's other endpoints directly.

---

## Operator entry points

- `auggy dev <name> --open` — boots the agent and opens `/console/chat`
  in the operator's default browser. The happy-path command.
- `auggy dev <name>` — boots the agent foreground without launching a
  browser. For headless / scripted use.
- `auggy list` — shows each agent's `/console` URL alongside name +
  status.

### Auth on loopback vs. remote

The console gates non-loopback requests behind HTTP Basic (`AUGGY_WEB_TOKEN`)
+ HTTPS. **Loopback requests (127.0.0.1, ::1) skip the bearer check** —
filesystem read on `.env` already grants the token, so the gate added
friction without protection. Remote access (cloud / LAN / SSH tunnel
to a different host) still requires the bearer.

---

## Deferred

- Multi-agent / facility hub (post-link)
- SPA-driven `auggy create` wizard (CLI is good enough for v1.0)
- API versioning at `/console/api/v1/*` (only needed if `admin/dist/`
  packaging splits from the runtime)
- Cross-operator collaboration / multi-seat
- A dedicated "Inspect" surface for memory browsing or trace history —
  deferred until operators ask for it; the Chat tab's tool-call /
  memory-op event stream covers the moment-to-moment "what's it
  doing?" question.

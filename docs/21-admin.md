# /admin — Operator Workbench

The per-agent operator surface served at `GET /admin` by every agent
that mounts `webTransport`. One agent = one `/admin`.

## Positioning

Auggy belongs in the **Pocketbase / Supabase / Convex lane**:
deployable backend platforms where the operator manages a running
instance via a bundled web admin. In that lane, admin UI is **table
stakes** — the operator's primary surface for managing their
deployment.

This is distinct from the LangChain / Hermes / CrewAI lane (pure SDK /
library, no bundled UI, operator lives in code) and from the OpenHands
lane (UI IS the product, full-featured workbench day one).

The relevant comparators ship admin UIs in their OSS v1.0:

- **Pocketbase v1.0**: 4 focused sections (Collections / Logs / Settings / Auth) — daily-use admin, nothing speculative.
- **Supabase**: Studio bundled with self-hosted distribution day one.
- **Convex**: dashboard ships GA.
- **Appwrite**: admin console day one.

Auggy at v1.0 ships the same way: a focused admin SPA with the daily-
use surface, not a 9-tab workbench full of placeholders.

## v1.0 SPA scope

**One tab: Chat.** That is the v1.0 admin SPA in its entirety.

```
/admin (SPA)
  ├─ Chrome (header + sidebar)
  │   ├─ Agent name + status + healthy/error indicator
  │   └─ (collapsed) agent-card details
  └─ Chat — talk to the agent, see tool calls + memory ops live
```

That's it. No Augments tab. No Skills tab. No Credentials tab. No
Identity tab. No Budget tab. No Security tab. No Memory browser. No
trace viewer. No manifest dump. **Every additional tab waits for
adopter signal** identifying which one to invest in next.

### Why one tab is enough

1. **The core operator action is "talk to the agent."** Local tire-
   kicking, deployed-instance validation, debugging an identity edit —
   all of them flow through chat. Chat is the daily driver.
2. **Pocketbase v1.0 discipline.** Pocketbase shipped with 4 sections,
   not 30. Auggy ships with 1 because chat is auggy's *one* certain
   daily-use case, the way Collections is Pocketbase's.
3. **Avoid the placeholder trap.** Ship 1 working tab, not 9 with 5
   stubs. Three placeholders signal "this product is half-built."
4. **Defer to signal, not taste.** Every tab we don't build is a tab
   we'll know the operator's actual need for, not the designer's
   speculation about it.

### What replaces what

| Surface today | v1.0 fate |
|---|---|
| G36 server-rendered admin (`/admin` HTML dashboard) | **Retired.** Its info (agent name, status, agent-card details) folds into the SPA's chrome. |
| `auggy chat` (standalone SPA on port 8090) | **Deprecated.** Its job folds into the SPA's Chat tab. Single operator surface, single port. |

`auggy chat`'s standalone code (`chat/server.ts`, `chat/src/*`) can be
removed once `/admin/chat` reaches parity. Timeline: same release.

## Auth

HTTP Basic auth. Username blank, password is the agent's bearer
(`AUGGY_WEB_TOKEN` in the agent's `.env`). Same credential the
operator uses on `/agent/run`. The browser caches it per origin so the
operator logs in once per tab.

For state-mutating endpoints (`POST /admin/api/chat/run`), a CSRF
token is also required, bound to the action — same substrate as the
G36 admin actions (see `src/transports/admin/admin-csrf.ts`).

HTTPS is enforced on non-loopback hostnames. Plaintext HTTP from a
non-loopback address returns `426 Upgrade Required`.

## Stack + packaging

React 19 + Vite + Tailwind + shadcn (Radix primitives). Source:
`admin/`. Build output: `admin/dist/`. The runtime serves the SPA's
static assets from `admin/dist/` via
`src/transports/admin/admin-static.ts`.

The SPA consumes JSON endpoints under `/admin/api/*`. Endpoint shape
is package-locked: `admin/dist/` ships inside the same release as the
auggy runtime, so the JSON contract is always in lockstep with the
SPA build. No API versioning prefix in v1.

## API surface (v1.0)

Minimal endpoint set to support the Chat tab:

- `GET /admin` → serve SPA
- `GET /admin/api/agent` → agent metadata (name, purpose, status,
  agent-card summary) for the chrome
- `POST /admin/api/chat/run` → SSE proxy that attaches the bearer
  server-side and streams AG-UI events from the kernel's `/agent/run`
- `GET /admin/api/chat/history?limit=N&before=ts` → paginated
  conversation history from `<agent-dir>/operator-chat.sqlite`
- `DELETE /admin/api/chat/history` → operator-initiated history reset

Existing G36 endpoints (`POST /admin/actions/<action>`) remain in
place for the substrate to grow against in v1.1+.

## Tab promotion (v1.1+)

A new tab is added to the SPA **only when adopter signal identifies
the operator-friction it solves.** Promotion requires:

1. **Concrete signal.** At least one adopter has expressed friction
   that a new tab would solve. "Operator X said they couldn't find Y"
   is the bar — not "I think operators will want Y."
2. **Distinct concern.** Doesn't fit inside the Chat tab or an
   existing tab.
3. **Documented.** Add a section to this spec explaining what the new
   tab owns, what augment(s) back it, and why it warrants a tab vs.
   inline UI within Chat.

Tabs that have NOT met the bar (and therefore won't ship in v1.0):
Augments, Skills, Credentials, Identity, Budget, Security, Memory,
Traces, Manifest. All of these are valid v1.1+ candidates IF an
adopter asks for them. None are auto-promoted.

This is the *defer-to-signal* principle. We don't decide what
operators need; they tell us.

## What stays in the codebase (forward-compat)

The G36 substrate stays:

- `src/transports/admin/` server modules (auth, CSRF, dispatcher,
  registry, ring buffer)
- `Augment.adminInfo()` contract on the `Augment` type
- Per-augment `adminInfo()` implementations (budgets, layered-memory,
  notify, visitor-auth, web-transport)
- Admin action handlers across those augments
- `src/types.ts` admin types (`AdminInfoBlock`, `AdminSection`,
  `AdminAction`, etc.)

When v1.1 adds (e.g.) a Budget tab, the budgets augment's
`adminInfo()` lights up automatically — the contract is forward-
compat. The SPA renders the tab; the backend doesn't need new code.

What gets retired in v1.0:

- `src/transports/admin/admin-renderer.ts` — server-side HTML
  renderer. Replaced by the SPA.
- `tests/transports/admin/admin-renderer.test.ts` — its test.
- `chat/server.ts`, `chat/src/*`, `chat/tests/*` — the standalone
  `auggy chat` package. Replaced by `/admin/chat` tab.
- `src/cli/commands/chat.ts` — the `auggy chat` CLI command.

## Operator entry points

- `auggy run <name>` — boots the agent and opens `/admin` in the
  operator's default browser. Lands on the SPA's Chat tab by default.
  The happy-path command.
- `auggy dev <name>` — boots the agent without launching a browser.
  Headless / scripted use.
- `auggy list` — shows each agent's `/admin` URL alongside name +
  status.

## What this doesn't do

`/admin` is a v1.0 surface for the operator. It is **not**:

- Visitor-facing. Visitors chat through `publicFrontendUrl` (BYO
  frontend), `@auggy/chat-widget` embedded in the operator's site
  (deferred — `docs/20-embedding.md` is the v1.0 primitives
  reference), or directly via `/agent/run` with visitor-auth bearer.
- A workbench for managing many agents. Per-agent only.
- A configuration editor. `agent.yaml` + `identity.md` + `.env` are
  edited in the operator's editor.

## Deferred (v1.1+ candidates)

Any of these may ship when adopter signal warrants:

- **Augments tab** — composition view, add/remove
- **Skills tab** — knowledge catalog
- **Credentials tab** — env var management
- **Identity tab** — identity.md viewer + editor
- **Budget tab** — caps + spend
- **Security tab** — auth posture + visitor management
- **Memory tab** — layered-memory browsing
- **Traces tab** — kernel trace event stream
- **Manifest tab** — agent-card viewer
- **`auggy admin <name>` CLI verb**
- **Cross-agent / facility hub** (post-link)
- **Embeddable visitor chat widget** (`@auggy/chat-widget-react`)
- **`webTransport.publicDir`** — auggy serving the operator's whole
  frontend
- **Remote-deploy passkey auth** — better mobile UX than HTTP Basic

Each is added only when adopter friction signals which one to build.

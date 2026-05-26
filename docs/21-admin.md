# /admin — Per-Agent Operator Surface

## What `/admin` is in v1.0

The **server-rendered HTML dashboard** shipped in G36 (PRs #59–#63,
2026-05-19). One per-agent, served at `GET /admin` by every agent that
mounts `webTransport`. HTTP Basic auth, no JavaScript, no SPA, no
client-side framework.

What it surfaces (built-in):

- Agent name + purpose (from the agent-card)
- Health / status line
- Per-augment sections rendered from each augment's `adminInfo()` —
  `keyValue`, `table`, `status` primitives
- State-mutating actions via HTML forms, CSRF-bound to
  `(actionId, rowKey)` tuples
- Footer notice about devtools exposure of bearer

Server modules: `src/transports/admin/`. Renderer:
`src/transports/admin/admin-renderer.ts`. The contract surface
(`AdminInfoBlock`, `AdminSection`, `adminAction`, etc.) lives in
`src/types.ts` — augments opt in by implementing `adminInfo()`.

## What `/admin` is NOT in v1.0

- Not a single-page app.
- Not a React/Vite/Tailwind/shadcn build.
- Not a multi-tab workbench with Chat / Budget / Security / Skills /
  Credentials / Identity / Augments routes.
- Not a JSON API at `/admin/api/*`.

That work exists on `feat/chat-ui-iteration` and is **deferred to v1.1+**.

## Why the SPA was cut (2026-05-26)

After building most of a 7-tab SPA on `feat/chat-ui-iteration`, the
work was cut from v1.0 scope. Rationale:

1. **Audience-positioning mismatch.** Auggy's v1.0 adopters are
   technical operators (CLI-comfortable, self-hosting). The OSS
   runtimes they're used to (LangChain, LangGraph, AutoGen, CrewAI OSS
   tier) ship no admin UI. Operators in this audience prefer editing
   `agent.yaml` in vim over filling YAML in a form. A SPA pushes
   auggy into "product" framing when its v1.0 positioning is
   "runtime + SDK."

2. **The demo is the chat, not the dashboard.** The shareable v1.0
   moment is `npm i -g auggy → auggy create → auggy run → chat works`.
   A polished admin SPA is the SaaS demo — different game.

3. **We were speculating on operator needs.** The 7-tab structure,
   the augment-to-home mapping, the Augments-as-registry vs editor
   call — all decided without adopter signal. Ship the runtime,
   watch what operators *actually* hit friction on, build the SPA
   for *that* in v1.1+.

4. **Code editor is a first-class operator tool.** `agent.yaml` is
   YAML, `identity.md` is markdown, `.env` is dotenv, `memory.sqlite`
   opens in DBeaver / `sqlite3` CLI. Every dev knows how to edit
   these. The G36 dashboard handles the operator's *read* needs (see
   what's running, current spend, current visitors); the editor
   handles config; CLI handles audited mutations.

5. **Maintenance tax.** React + Vite + Tailwind + shadcn + Radix is
   a perpetual dependency tree on a runtime project. That tax
   compounds against features that move the v1.0 adoption needle.

The G36 dashboard already satisfies the *minimum* operator-surface
need (visibility into a running agent). The SPA would have been a
nicer surface, not a structurally different one. Ship the working
dashboard, defer the polish.

## Browser chat in v1.0: `auggy chat`

Browser chat is **not** an `/admin` concern in v1.0. The bundled
chat surface is `auggy chat` — a separate browser SPA at
`localhost:8090` that:

- Discovers all running local agents via PID manifests
- Lists them in a picker (sidebar)
- Streams chat via SSE through a bearer-attaching proxy (browser
  never sees the bearer)
- Ships as the `chat-dist` GitHub release artifact, downloaded on
  first run

Operators talk to their agent via `auggy chat`. Operators inspect /
administer their agent via `/admin`. Two surfaces, two purposes,
both shipped, no overlap.

The earlier plan to deprecate `auggy chat` in favor of a unified
`/admin/chat` tab is **reversed** by this cut. `auggy chat` is the
v1.0 browser chat surface.

## Operator surface inventory (v1.0)

| Operator task | v1.0 affordance |
|---|---|
| Configure the agent | Edit `~/.auggy/agents/<name>/agent.yaml` in your editor |
| Edit identity | Edit `~/.auggy/agents/<name>/identity.md` |
| Rotate credentials | Edit `~/.auggy/agents/<name>/.env` |
| Adjust budget caps | Edit `agent.yaml` OR use the budget admin action at `/admin` |
| Revoke a visitor | `/admin` visitor table action, OR `auggy visitors <name> --revoke <email>` |
| Inspect memory | `sqlite3 ~/.auggy/agents/<name>/memory.sqlite` OR `/admin` memory section (read-only) |
| Talk to the agent (browser) | `auggy chat` (separate SPA on port 8090) |
| Talk to the agent (terminal) | Curl `/agent/run` directly, or BYO AG-UI client |
| See agent status | `auggy list` (CLI) OR `/admin` info panel |

## Auth model (v1.0)

`/admin` uses **HTTP Basic auth**, bearer-as-password. Username
blank, password is `AUGGY_WEB_TOKEN`. State-mutating actions
additionally require a CSRF token bound to `(actionId, rowKey)`. See
`src/transports/admin/admin-csrf.ts`.

HTTPS is enforced on non-loopback hostnames. Plaintext HTTP from a
non-loopback address returns `426 Upgrade Required`.

The `auggy chat` SPA is independent of `/admin` auth: it lives on a
separate port (8090 by default), proxies requests with the agent's
bearer attached server-side, and serves an unauthenticated origin to
the operator's local browser.

## What stays in the codebase

Everything from G36 is shipped and stays:

- `src/transports/admin/` — admin module (auth, CSRF, renderer,
  dispatcher, registry)
- `src/transports/admin/admin-renderer.ts` — server-side HTML renderer
- `Augment.adminInfo()` contract on the type
- Per-augment `adminInfo()` implementations on budgets, layered-memory,
  notify, visitor-auth, web-transport
- Admin action handlers across those augments
- Ring buffer + admin-overrides Zod schema + 0o600 atomic write

The forward-compat surfaces (`adminInfo()` contract, `eventStream`
section primitive declared but not yet rendered) remain in place for
the v1.1 SPA work to resume against without needing a re-architecture.

## What stays parked

On branch `feat/chat-ui-iteration`:

- `admin/` — Vite + React + Tailwind + shadcn SPA scaffold
- `src/transports/admin/admin-credentials.ts` — JSON endpoint for SPA
- `src/transports/admin/admin-identity.ts` — JSON endpoint for SPA
- `src/transports/admin/admin-skills.ts` — JSON endpoint for SPA
- Per-tab React components
- `scripts/dev-admin.ts` — SPA dev driver

That work is not abandoned — it's deferred. Resumes in v1.1+ when
adopter feedback identifies concrete admin friction the G36 dashboard
doesn't cover.

## Operator entry points

- `auggy run <name>` — boots the agent and opens its `/admin` page
  in the operator's default browser. The G36 dashboard renders;
  operator sees the read-only state + can take any admin actions
  that augments expose.
- `auggy dev <name>` — boots the agent without launching a browser.
  For headless / scripted use.
- `auggy chat` — separate browser SPA (port 8090) listing all running
  local agents. The v1.0 chat surface.
- `auggy list` — shows each agent's `/admin` URL alongside name +
  status.

## Deferred (v1.1+)

- The 7-tab SPA on `feat/chat-ui-iteration`
- `/admin/api/*` JSON endpoints for SPA consumption
- Per-augment SPA surfaces (memory browser, budget editor UI, etc.)
- `auggy admin <name>` CLI verb
- Inline operator chat at `/admin/chat` (originally a G36-followup;
  unnecessary while `auggy chat` exists)
- Cross-agent / facility hub (post-link)
- Remote-deploy chat (Railway/Fly) — today requires SSH-tunneling
  `auggy chat` or BYO UI via `publicFrontendUrl`

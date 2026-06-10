---
title: "G36 — Built-in /admin route + adminInfo() contract"
type: design
category: feature
date: 2026-05-19
status: approved
domain:
  - transports
  - web-transport
  - admin
  - oss-launch
relates_to:
  - lo/docs/superpowers/specs/2026-04-29-auggy-chat-design
  - 2026-05-19-g2-info-endpoint-design
roadmap_phase: pre-v0
---

## Context

G36 ships the operator-administration surface for Auggy v1.0 OSS. Per [`docs/todos.md`](../../todos.md) Tier 1 (revised 2026-05-19):

> **[admin]** `/admin` route + OpenHands-style HTTP basic auth, bearer-as-password... Built into `webTransport` (NOT a separate augment) — mirrors the G2 info-endpoint pattern... Augments opt into being dashboarded via a typed `adminInfo()` contract on the `Augment` type.

Today, operators administer their agent via:
- `auggy chat` Local GUI (localhost-only; requires SSH-tunneling for remote agents)
- Direct SQLite queries (for budgets, layered-memory)
- yaml edits + restart (for posture / cost-cap / notify-cap changes)

This is operator-hostile for any deployment that isn't on the same machine the operator owns. G36 fixes this by shipping a browser-accessible dashboard at `/admin` on every Auggy deployment — readable from anywhere with bearer-as-password, write-capable for the tunable knobs operators most need at runtime.

### Architectural decisions previously made (recorded for traceability)

The brainstorming conversation on 2026-05-19 settled the following before this spec was written:

1. **Built-in route, not an augment.** Mirrors G2's info-endpoint pattern (`src/transports/info-page.ts` dispatched from `web-transport.ts`). Reasoning: `/admin` is a *runtime-level operator affordance*, not a feature operators opt into. Every Auggy deployment should have it. Composability lives in *what the dashboard shows*, not in *whether the dashboard exists*.
2. **`adminInfo()` contract on the `Augment` type** for cross-augment composability. Augments declare what they expose; admin route iterates registered augments and asks each. No direct cross-augment imports.
3. **HTTP Basic auth, bearer-as-password.** Reuses `AUGGY_WEB_TOKEN` — no new credential. Native browser prompt via `WWW-Authenticate: Basic realm="auggy-admin <agent-name>"`. Bearer in `Authorization` header, never in URLs (avoids OpenClaw CVE-2026-25253 class by construction).
4. **Server-rendered HTML, no JS.** v1.0 admin page is static HTML rendered server-side. No external assets, no client-side fetch, no WebSocket. Browser cannot be tricked into auto-connecting to attacker URLs (also avoids OpenClaw CVE-2026-25253 by construction).
5. **Persistence layer for runtime overrides.** Operator changes to `allowAnonymous` / `dailyBudgetUsd` / `notify.globalMaxPerHour` persist across restart via `~/.auggy/<agent>/admin-overrides.json`. Restart-revert was rejected because restart drops in-flight turns, scheduled afterTurn jobs, in-memory rate-limit state, and per-augment recent-events ring buffers — operationally costly cost to pay for permanence.
6. **Operator chat in /admin deferred** to a separate post-v1.0 ticket (`G36-followup`, filed in Tier 2). v1.0 ships dashboard-only. Adopters wanting in-browser chat for remote agents wait for the follow-up.

## Goals

1. Every Auggy deployment has `/admin` available with no augment-mounting required.
2. Operator can read agent state from a browser: spend, memory entries, recent notifications, posture, verified visitors.
3. Operator can perform 6 specific actions at runtime without restart: notify test, erase peer memory, flip allowAnonymous, adjust dailyBudgetUsd, revoke verified visitor token, adjust notify globalMaxPerHour.
4. Runtime adjustments persist across agent restart.
5. Augments opt into being dashboarded by declaring a typed `adminInfo()` — admin route never reaches across augment boundaries.
6. Security posture matches the runtime's existing defaults: HTTPS-only on non-loopback, audit logged, CSRF-protected, rate-limited per-route.

## Non-goals

- **No inline operator chat at v1.0.** Filed as `G36-followup` in Tier 2. Server-side proxy + tiny inline JS pattern for the follow-up; v1.0 ships zero JS on the admin page.
- **No generic settings UI.** Only the 3 named runtime-tunable knobs (allowAnonymous / dailyBudgetUsd / globalMaxPerHour) ship. Other config edits go through agent.yaml + restart.
- **No per-augment custom widgets / raw-HTML escape hatch in `AdminSection`.** Typed primitives only. Future Tier-3 if adopter feedback demands.
- **No multi-page admin layout.** Single page renders all augment blocks stacked vertically.
- **No live updates / WebSocket / SSE on the admin page.** v1.0 is static; refresh-driven. Telemetry-backed live updates land via the deferred Tier-2 telemetry pipeline.
- **No multi-operator distinguishing.** Single creator role; everyone with the bearer is the same identity.

## Auth posture and visibility

### Auth model

- **HTTP Basic** in `Authorization: Basic base64(":" + bearer)` form. Empty username, bearer as password.
- **401 + `WWW-Authenticate: Basic realm="auggy-admin <agentName>"`** when missing or wrong credentials → browser auto-prompts.
- **Bearer comparison is timing-safe** (reuses `webTransport`'s existing `timingSafeEqual` helper).
- **HTTPS-only enforcement on non-loopback** — see security section below for the exact rule.
- **Per-route rate limit** to defeat brute-force against the basic-auth: 60 requests/min/IP via the existing `webTransport.checkRouteRateLimit` mechanism, applied to `/admin` and `/admin/action/*`.
- **CSRF protection** via HMAC tokens on every form (see HTML rendering section).

The bearer is never present in URLs, response bodies, or JS context. The browser handles `Authorization` header retention across the same browsing session (HTTP Basic semantics).

### Crawler / scraper / unfurl

`/admin` ships `<meta name="robots" content="noindex, nofollow">` (mirrors G2) and `Cache-Control: no-store, must-revalidate` (admin data is sensitive). No Open Graph tags — link previews of `/admin` shouldn't leak the agent name to messaging apps.

### Opt-out

Operators set `webTransport.adminRoute: false` in `agent.yaml` to disable /admin entirely. The route returns **`404 Not Found`** in this case (not `403`) — no signal that the route exists when disabled. Default: `true`.

## Architecture

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | modified | Add `AdminInfoBlock`, `AdminSection` (4 variants), `AdminAction`, `AdminActionInput`, `AdminRowAction`, `AdminActionResult` types. Add `adminInfo?: () => Promise<AdminInfoBlock>` and `adminActions?: Record<string, AdminActionHandler>` optional fields to `Augment` interface. |
| `src/lib/admin-overrides.ts` | **new** | Read/write/apply persistent override file `~/.auggy/<agent>/admin-overrides.json`. Zod schema validation. Atomic-rename writes (mirroring `cli/pid-registry.ts`). Exposes `readOverrides()`, `writeOverrides()`, `clearOverride()`, `applyOverridesTo()` helpers. |
| `src/lib/ring-buffer.ts` | **new** | Shared bounded-buffer utility (~50 LOC). Used by budgets / layered-memory / notify for their recent-events tracking. API: `create<T>(maxSize)`, `push(event)`, `snapshot()`, `clear()`. Forward-compat with the deferred Tier-2 telemetry pipeline. |
| `src/transports/admin/index.ts` | **new** | Main admin route handler. Dispatches `GET /admin` (page render), `POST /admin/action/<id>` (action handler), `POST /admin/action/<id>/row/<rowKey>` (row-scoped action). Validates auth + CSRF before delegating. Coerces form-string inputs to declared `AdminActionInput.type` (boolean/number) before calling the handler — coercion failure returns `{ ok: false, message: "invalid <name>: <reason>" }` without invoking the handler. Wraps the handler in try/catch — uncaught throws log to stderr, surface as `{ ok: false, message: "internal error" }`, and add an entry to the audit log. **Boot-time validation:** after `register()` completes and before serving the first request, iterate all augments' `adminInfo().actions` (and `rowActions` from table sections) and verify each declared `id` has a matching key in the augment's `adminActions`. Missing handler → throw at boot with `[admin] augment <name> declares action "<id>" but does not provide an adminActions handler.` This catches the runtime-bomb pattern at startup. |
| `src/transports/admin/admin-renderer.ts` | **new** | Pure-function HTML rendering. Page shell + per-section renderers (one per `AdminSection.kind`). Inline minimal CSS (mirrors G2's info-page rule). Escapes all interpolated values. Skips rendering of an `AdminInfoBlock` whose `sections` and `actions` are both empty/undefined — empty section shells aren't shown. Reads only from closure-supplied data (the `AdminInfoBlock` argument); never touches disk or augment internals directly. |
| `src/transports/admin/admin-auth.ts` | **new** | HTTP Basic decode, bearer comparison (timing-safe), HTTPS-on-non-loopback check, 401 + `WWW-Authenticate` emission, 426 + `Upgrade` emission for HTTPS-required cases. |
| `src/transports/admin/admin-collector.ts` | **new** | Iterates `kernel.getAugments()`, calls each augment's `adminInfo()` if implemented, returns ordered `AdminInfoBlock[]`. Skips augments without `adminInfo`. Catches per-augment errors so one broken augment doesn't take down the whole dashboard (renders an error status section in its place). |
| `src/transports/admin/admin-csrf.ts` | **new** | HMAC over `(agentName + bearer + timestamp)`. 1-hour expiry. `generateToken()` for renderer, `validateToken()` for action handler. |
| `src/transports/web-transport.ts` | modified | (1) Add `adminRoute?: boolean` to `WebTransportOptions` (default `true`). (2) Boot-load admin overrides via `admin-overrides.ts`. (3) Apply overrides to closure variables (`allowAnonymous`, etc.) before register completes. (4) Dispatch `GET /admin`, `POST /admin/action/*`, and `HEAD /admin` (returns `405 Method Not Allowed` with `Allow: GET, POST`) to the admin module. (5) Expose closure-mutation helpers for actions (`setAllowAnonymous(value: boolean): void`). (6) HTTPS-on-non-loopback gate before reaching the admin module. (7) Add `/admin` to the reserved-paths constant in the augment-route collision check — augments cannot register routes at `/admin` or `/admin/action/*`; collision throws at `agent.start()` per existing PR γ.1 pattern. (8) Add `isLoopback(ip: string): boolean` helper returning true for `127.0.0.0/8` and `::1`. |
| `src/augments/budgets/index.ts` + storage | modified | (1) Add `adminInfo()` returning spend/events sections. (2) Add private `getDaySpend()` + `getRecentEvents()` to budget-store. (3) Add `setDailyBudgetUsd(value)` mutator that updates closure + persists. (4) Wire ring-buffer for recent budget events. (5) Register `adminActions["budget-cap-adjust"]` handler. |
| `src/augments/layered-memory/index.ts` + storage | modified | (1) Add `adminInfo()` returning per-peer entry table. (2) Add private `listEntriesByPeer()` method (caps at 50 per peer for v1.0). (3) Register `adminActions["memory-erase"]` row-action that calls existing `forget(peerId)`. |
| `src/augments/notify/index.ts` | modified | (1) Add `adminInfo()` returning recent-dispatches table + globalMax KV. (2) Add `getRecentDispatches()` via ring-buffer. (3) Add `setGlobalMaxPerHour(value)` mutator. (4) Register `adminActions["notify-test"]` (bypasses rate-limit + dedup; flagged as test in adapter calls) and `adminActions["notify-cap-adjust"]`. |
| `src/augments/visitor-auth/index.ts` | modified | (1) Add `adminInfo()` returning verified-visitors table + status sections. (2) Register `adminActions["visitor-revoke"]` row-action via existing revocation-check store. |
| `docs/06-transports.md` | modified | New section documenting `/admin`: route shape, auth, opt-out flag, security model, persistence semantics. |
| `tests/transports/admin/` | **new** | Per-module unit tests + integration tests. |
| `tests/augments/*-admin-info.test.ts` | **new** | One per augment that implements adminInfo. |
| `tests/lib/admin-overrides.test.ts` | **new** | Round-trip, schema validation, precedence, atomic-write, corrupt-file fallback. |
| `tests/lib/ring-buffer.test.ts` | **new** | Push, snapshot, eviction, bounded behavior. |

Estimated ~25-30 files touched. Files in `src/transports/admin/` follow the existing single-responsibility-per-file pattern used by `src/transports/{web-transport.ts, info-page.ts, ag-ui-events.ts, visitor-token.ts}`.

## The contract types

```ts
// src/types.ts — additions

export interface AdminInfoBlock {
  /** Augment name; used as a stable identifier in audit logs + action dispatch. */
  augmentName: string;
  /** Human-readable section heading on the admin page (e.g., "Budgets", "Memory"). */
  title: string;
  /** Ordered list of sections rendered in the augment's block. */
  sections: AdminSection[];
  /** Optional augment-level actions (rendered as buttons / forms at the bottom of the block). */
  actions?: AdminAction[];
}

export type AdminSection =
  | {
      kind: "keyValue";
      rows: Array<{
        label: string;
        value: string;
        /** Optional annotation, typically the resolution source (e.g., "source: yaml"). */
        source?: string;
      }>;
    }
  | {
      kind: "table";
      columns: string[];
      rows: string[][];
      /** Optional per-row actions (rendered as buttons next to each row). */
      rowActions?: AdminRowAction[];
      /** Optional caption (e.g., "Showing 50 most recent of 234 total"). */
      caption?: string;
    }
  | {
      kind: "status";
      level: "ok" | "warn" | "error";
      message: string;
    }
  | {
      kind: "eventStream";
      events: Array<{
        timestamp: string;
        type: string;
        summary: string;
      }>;
      /** Optional caption (e.g., "Last 24 hours"). */
      caption?: string;
    };

export interface AdminAction {
  /** Stable identifier; used in form action URLs (`POST /admin/action/<id>`). */
  id: string;
  label: string;
  confirmRequired: boolean;
  /** Optional form inputs. Empty/undefined = button-only action. */
  inputs?: AdminActionInput[];
}

export interface AdminActionInput {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  required: boolean;
  default?: string;
  /** Optional helper text below the input. */
  helpText?: string;
}

export interface AdminRowAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  /**
   * Which column's value to pass as `rowKey` to the action handler.
   * E.g., if the table's first column is "peer", set rowKeyColumn: 0.
   */
  rowKeyColumn: number;
}

export interface AdminActionResult {
  ok: boolean;
  /** Human-readable message displayed as a flash on the redirected admin page. */
  message: string;
}

export type AdminActionHandler = (
  params: Record<string, string>,
) => Promise<AdminActionResult>;

export interface Augment {
  // ... existing fields
  /** Optional: declare what the admin dashboard should show for this augment. */
  adminInfo?: () => Promise<AdminInfoBlock>;
  /** Optional: handlers for the actions this augment declares in its adminInfo.actions. */
  adminActions?: Record<string, AdminActionHandler>;
}
```

### Section primitive rationale

- **`keyValue`**: static facts (current dailyBudgetUsd, allowAnonymous value + source, notify globalMax + source). Rendered as a definition list.
- **`table`**: variable-length rows (recent events, memory entries by peer, verified visitors). `rowActions` enables per-row buttons. Capped at 50 rows per table for v1.0 (caption shows total count when capped).
- **`status`**: traffic-light indicators (e.g., "visitor-auth: console mail in production" → `warn`).
- **`eventStream`**: time-series rows from each augment's ring buffer. Forward-compat: when the Tier-2 telemetry pipeline lands, the ring-buffer source swaps for a telemetry consumer without changing the section type.

### `adminActions` registration shape

Each augment's `adminInfo().actions` declares the action *id, label, confirmRequired, inputs*. The augment also provides `adminActions[id]` with the actual handler. The admin route dispatcher looks up `actionId` across all registered augments and routes to the right handler.

This decoupling lets the renderer be a pure function of `AdminInfoBlock[]` (no handler references in render output) while preserving augment ownership of action logic.

## Per-augment `adminInfo()` shapes

### `budgets`

```ts
adminInfo(): {
  augmentName: "budgets",
  title: "Budgets",
  sections: [
    { kind: "keyValue", rows: [
      { label: "Daily budget cap",   value: "$30.00", source: "/admin override (set 2026-05-19 16:42)" },
      { label: "Today's spend",      value: "$12.43" },
      { label: "Anonymous turns today", value: "47 / 100" },
    ]},
    { kind: "table", columns: ["Peer", "Trust", "Today's cost", "Turns"], rows: [
      ["creator",            "creator", "$8.20",  "12"],
      ["vis_abc...",         "public:recognized", "$3.10", "8"],
      ["anon-thread-xyz",    "public:anonymous",  "$1.13", "4"],
    ], caption: "Showing 3 peers (all peers shown — small N)" },
    { kind: "eventStream", events: [
      { timestamp: "16:42:01", type: "budget.turn_admitted",  summary: "creator $0.42" },
      { timestamp: "16:41:55", type: "budget.cap_denied",     summary: "anon-thread-q1 hit maxTurnsPerDay" },
      // ... 50 most recent
    ], caption: "Last 50 events" },
  ],
  actions: [
    {
      id: "budget-cap-adjust",
      label: "Adjust daily budget cap",
      confirmRequired: true,
      inputs: [{ name: "value", label: "New dailyBudgetUsd", type: "number", required: true, default: "30", helpText: "Persists across restart via admin-overrides.json. Reset by editing agent.yaml + clearing override." }],
    },
  ],
}
```

### `layered-memory`

```ts
adminInfo(): {
  augmentName: "layered-memory",
  title: "Memory",
  sections: [
    { kind: "keyValue", rows: [
      { label: "Total entries",     value: "1,247" },
      { label: "Operational",       value: "1,180" },
      { label: "Lesson",            value: "67" },
    ]},
    { kind: "table",
      columns: ["Peer", "Label", "Content (snippet)", "Retention", "Age"],
      rows: [/* 50 most recent across all peers */],
      rowActions: [{ id: "memory-erase", label: "Erase peer", confirmRequired: true, rowKeyColumn: 0 }],
      caption: "50 most recent entries across all peers",
    },
    { kind: "eventStream", events: [
      // recent writes / supersedes / forgets from ring buffer
    ], caption: "Last 50 events" },
  ],
}
```

Note: `memory-erase` is a row action that takes the peer name from column 0 and calls existing `forget(peerId)`.

### `notify`

```ts
adminInfo(): {
  augmentName: "notify",
  title: "Notify",
  sections: [
    { kind: "keyValue", rows: [
      { label: "Global cap per hour", value: "10", source: "/admin override" },
      { label: "Used this hour",      value: "3" },
      { label: "Cooldown ms",         value: "120000", source: "yaml" },
    ]},
    { kind: "table",
      columns: ["Time", "Destination", "Status", "Summary"],
      rows: [/* 50 most recent dispatches */],
      caption: "Recent dispatches",
    },
  ],
  actions: [
    {
      id: "notify-test",
      label: "Send test notification",
      confirmRequired: false,
      inputs: [
        { name: "destination", label: "Destination name", type: "text", required: true, helpText: "Must match a configured notify destination." },
        { name: "message",     label: "Message (optional)", type: "text", required: false, default: "Test from /admin", helpText: "Bypasses rate-limit + dedup. Adapter flagged 'test' in payload." },
      ],
    },
    {
      id: "notify-cap-adjust",
      label: "Adjust globalMaxPerHour",
      confirmRequired: true,
      inputs: [{ name: "value", label: "New globalMaxPerHour", type: "number", required: true, default: "5" }],
    },
  ],
}
```

### `visitor-auth`

```ts
adminInfo(): {
  augmentName: "visitor-auth",
  title: "Visitors",
  sections: [
    { kind: "keyValue", rows: [
      { label: "Active inbox",       value: "abc@inbox.agentmail.to" },
      { label: "Mail transport",     value: "console", source: "yaml" },  // warn-level status will fire if console+production
    ]},
    { kind: "status", level: "warn", message: "Mail transport is 'console' — magic links print to stdout. OK for dev; do not ship to production without switching to agentmail." },
    { kind: "table",
      columns: ["Peer ID", "Email", "Verified at"],
      rows: [/* verified visitors */],
      rowActions: [{ id: "visitor-revoke", label: "Revoke", confirmRequired: true, rowKeyColumn: 0 }],
    },
  ],
}
```

### `webTransport` (the transport itself)

`webTransport` is a transport-shaped augment (its `transport` field is the transport spec). It also implements `adminInfo()` for the posture row:

```ts
adminInfo(): {
  augmentName: "web",  // operator-configured runtime name
  title: "Posture",
  sections: [
    { kind: "keyValue", rows: [
      { label: "allowAnonymous", value: "true", source: "/admin override (set 16:38)" },
      { label: "publicFrontendUrl", value: "(unset)", source: "yaml" },
      { label: "Port", value: "8080" },
      { label: "Trusted proxies", value: "10.0.0.5" },
    ]},
    { kind: "status", level: "ok", message: "Listening on :8080 with HTTPS-required-on-non-loopback enforced." },
  ],
  actions: [
    {
      id: "posture-flip",
      label: "Flip allowAnonymous",
      confirmRequired: true,
      inputs: [{ name: "value", label: "allowAnonymous", type: "boolean", required: true, helpText: "Demo-mode on/off. Persists across restart." }],
    },
  ],
}
```

## Admin route handler

```ts
// src/transports/admin/index.ts (sketch)

export interface AdminContext {
  kernel: TransportKernel;
  bearer: string;             // for HTTP Basic comparison + CSRF HMAC key
  agentCard: AgentCard;
  agentDir: string;           // for admin-overrides.json path
  isLoopback: boolean;        // for HTTPS enforcement decision
}

export async function handleAdminRoute(req: Request, ctx: AdminContext): Promise<Response> {
  // 1. HTTPS enforcement on non-loopback
  if (!ctx.isLoopback && new URL(req.url).protocol !== "https:") {
    return new Response("HTTPS required for /admin on non-loopback addresses.", {
      status: 426,
      headers: { upgrade: "TLS/1.2", connection: "Upgrade" },
    });
  }

  // 2. HTTP Basic auth
  const auth = checkAdminAuth(req, ctx.bearer, ctx.agentCard.provider.name);
  if (auth.kind !== "ok") return auth.response;

  const url = new URL(req.url);

  // 3. GET /admin — render dashboard
  if (req.method === "GET" && url.pathname === "/admin") {
    const blocks = await collectAdminInfoBlocks(ctx.kernel);
    const csrf = generateCsrfToken(ctx);
    const flashMessage = url.searchParams.get("msg");
    return new Response(renderAdminPage(ctx.agentCard, blocks, csrf, flashMessage), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "x-robots-tag": "noindex, nofollow",  // also in meta tag; defense in depth
      },
    });
  }

  // 4. POST /admin/action/<id> — dispatch action
  const actionMatch = url.pathname.match(/^\/admin\/action\/([^/]+)(?:\/row\/([^/]+))?$/);
  if (req.method === "POST" && actionMatch) {
    return handleAdminAction(req, ctx, actionMatch[1]!, actionMatch[2]);
  }

  return new Response(null, { status: 404 });
}
```

### Action dispatch flow

```
POST /admin/action/notify-test
  → admin-route validates HTTPS (if non-loopback) + HTTP Basic + rate-limit + CSRF
  → admin-route coerces form-string inputs to declared types (string|number|boolean)
    → coercion failure → { ok: false, message: "invalid <name>: ..." } without invoking the handler
  → admin-route iterates kernel.getAugments() to find one whose adminActions["notify-test"] exists
  → admin-route invokes handler in try/catch:
    → try: notify.adminActions["notify-test"]({ destination, message })
      → notify runs the dispatch with rate-limit + dedup bypass; adapter receives test: true flag
      → returns AdminActionResult { ok: true, message: "Test sent to webhook-1 (took 312ms)" }
    → catch (any throw): logs to stderr + audit-log entry; surfaces as { ok: false, message: "internal error" }
  → admin-route logs the action result (audit) + redirects 302 to /admin?msg=<urlencode(message)>
  → on next GET /admin: renderer reads ?msg= and renders a flash banner
```

For row actions:

```
POST /admin/action/memory-erase/row/vis_abc123
  → same auth/CSRF/rate-limit checks (CSRF binds to actionId AND rowKey — see CSRF section)
  → finds layered-memory.adminActions["memory-erase"]
  → calls handler({ rowKey: "vis_abc123" })  // rowKey is a typed first-class param, not a generic input
  → handler calls existing layeredMemory.forget("vis_abc123")
  → returns AdminActionResult { ok: true, message: "Erased 12 entries for vis_abc123" }
  → audit log + redirect with flash
```

### Rate-limit integration

Admin uses a **synthetic route-key** `"admin"` (not the actual request path) when calling `webTransport.checkRouteRateLimit("admin", ip, 60)`. This makes the 60-req/min budget cover the entire admin surface — `/admin`, every `/admin/action/<id>`, and every `/admin/action/<id>/row/<rowKey>` — *combined* per IP. Otherwise the existing path-keyed mechanism would give each endpoint its own bucket and the "60 req/min" claim would be false.

## HTML rendering

Single page. Stacked sections. No JS. Inline CSS only (minimal). Same conventions as G2's info-page.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>{escape(agentName)} — admin</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.4; }
    h1 { margin-bottom: 0; }
    .meta { color: #666; font-size: 0.9em; margin-top: 0; }
    .flash-ok    { background: #d4edda; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; }
    .flash-error { background: #f8d7da; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; }
    section { border: 1px solid #ddd; padding: 1rem 1.5rem; margin-bottom: 1.5rem; border-radius: 4px; }
    section h2 { margin-top: 0; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    dd .source { color: #666; font-size: 0.85em; margin-left: 0.5rem; }
    table { width: 100%; border-collapse: collapse; }
    table caption { color: #666; font-size: 0.85em; text-align: left; margin-bottom: 0.5rem; }
    th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f4f4f4; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9em; }
    form { display: inline-flex; gap: 0.5rem; align-items: end; }
    form.action-form { margin-top: 0.75rem; }
    .status-ok    { background: #d4edda; padding: 0.5rem 0.75rem; border-radius: 4px; }
    .status-warn  { background: #fff3cd; padding: 0.5rem 0.75rem; border-radius: 4px; }
    .status-error { background: #f8d7da; padding: 0.5rem 0.75rem; border-radius: 4px; }
    button { padding: 0.4rem 0.8rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>{escape(agentName)}</h1>
  <p class="meta">admin · auggy v{packageVersion}</p>

  {if flashMessage: <div class="flash-ok">{escape(flashMessage)}</div>}

  {for each AdminInfoBlock:}
    <section>
      <h2>{escape(block.title)}</h2>
      {for each section in block.sections: render by kind}
      {for each action in block.actions: render as form}
    </section>
  {end}

  <footer>
    <p style="color: #666; font-size: 0.85em">
      Auggy v{version} · Admin credentials are visible in browser devtools; don't share screenshots that include the Network tab.
    </p>
  </footer>
</body>
</html>
```

### Per-section rendering

- **`keyValue`** → `<dl>` with `<dt>label</dt><dd>value<span class="source">source</span></dd>` rows
- **`table`** → `<table>` with `<thead>` columns + `<tbody>` rows; `<caption>` if present; per-row action buttons in a final column
- **`status`** → `<div class="status-{level}">message</div>`
- **`eventStream`** → `<table>` with timestamp / type / summary columns; same shape as `table` but with fixed columns

### Action forms

Each action renders as:

```html
<form class="action-form" action="/admin/action/{id}" method="POST"
      {if confirmRequired:}onsubmit="return confirm('Confirm: {label}?')"{/if}>
  <input type="hidden" name="_csrf" value="{csrfToken}">
  {for each input:}
    <label>
      {input.label}:
      <input type="{input.type=='boolean' ? 'checkbox' : input.type}"
             name="{input.name}"
             {if input.required:}required{/if}
             {if input.default:}value="{escape(input.default)}" {/if}>
    </label>
    {if input.helpText: <small>{input.helpText}</small>}
  {end}
  <button type="submit">{label}</button>
</form>
```

`onsubmit="return confirm(...)"` is the *only* JS allowed on the page — it's a one-line inline handler triggered by the browser's native `confirm()` dialog, no fetch / no async / no state. JS-disabled browsers degrade gracefully: the form just submits without confirmation, and the server-side action handler may require an extra `confirm: yes` hidden field if the action is destructive (defensive but not load-bearing).

Row actions render as buttons inside the table's row-action column, each its own mini-form.

## Persistence layer

`src/lib/admin-overrides.ts`:

```ts
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

const AdminOverridesV1 = z.object({
  version: z.literal(1),
  lastModified: z.string().datetime(),
  lastModifiedBy: z.string(),
  overrides: z.object({
    webTransport: z.object({
      allowAnonymous: z.boolean().optional(),
    }).optional(),
    budgets: z.object({
      dailyBudgetUsd: z.number().positive().optional(),
    }).optional(),
    notify: z.object({
      globalMaxPerHour: z.number().int().positive().optional(),
    }).optional(),
  }),
});

export type AdminOverrides = z.infer<typeof AdminOverridesV1>;

function overrideFile(agentDir: string): string {
  return join(agentDir, "admin-overrides.json");
}

export function readOverrides(agentDir: string | undefined): AdminOverrides | null {
  // S9 — agentDir unset or missing → silent fallback. No warn (debug log only).
  // Common when running from `bun run scripts/hello.ts` or other non-CLI launch paths.
  if (!agentDir || !existsSync(agentDir)) return null;
  const path = overrideFile(agentDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const result = AdminOverridesV1.safeParse(parsed);
    if (!result.success) {
      // S8 — per-field validation logging. Iterate zod issues; for each failed
      // field, log path + reason and skip that field. Preserve fields that DID
      // validate by walking the partial result.
      for (const issue of result.error.issues) {
        console.warn(
          `[admin-overrides] field ${issue.path.join(".")} failed validation: ${issue.message}. ` +
            `Falling back to yaml for this field. Other valid overrides still applied.`,
        );
      }
      // Best-effort: try to extract valid sub-fields by re-parsing the partial.
      // For v1.0 simplicity: if any field fails, return null (whole-file fallback).
      // Per-field salvage is a v1.1 refinement.
      return null;
    }
    return result.data;
  } catch (err) {
    // JSON parse error, IO error
    console.warn(
      `[admin-overrides] failed to read ${path}: ${(err as Error).message}. Falling back to yaml values for all overrides.`,
    );
    return null;
  }
}

export function writeOverrides(agentDir: string, overrides: AdminOverrides): void {
  const path = overrideFile(agentDir);
  const tmp = `${path}.tmp.${process.pid}`;
  // M4 — explicit 0o600 mode: file is readable only by the agent process user.
  // Prevents other users on multi-user hosts (shared dev box, certain Docker
  // setups) from reading the operator's runtime knob state.
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clearOverride(agentDir: string, path: ["webTransport", "allowAnonymous"] | ["budgets", "dailyBudgetUsd"] | ["notify", "globalMaxPerHour"]): void {
  const current = readOverrides(agentDir);
  if (!current) return;
  // Tighten the type narrowing for the nested clear
  // (implementation detail — small inline switch)
  // ...
  writeOverrides(agentDir, /* updated */);
}

export function applyOverridesTo(overrides: AdminOverrides | null, setters: {
  setAllowAnonymous: (v: boolean) => void;
  setDailyBudgetUsd: (v: number) => void;
  setNotifyGlobalMaxPerHour: (v: number) => void;
}): void {
  if (!overrides) return;
  if (overrides.overrides.webTransport?.allowAnonymous !== undefined) {
    setters.setAllowAnonymous(overrides.overrides.webTransport.allowAnonymous);
  }
  if (overrides.overrides.budgets?.dailyBudgetUsd !== undefined) {
    setters.setDailyBudgetUsd(overrides.overrides.budgets.dailyBudgetUsd);
  }
  if (overrides.overrides.notify?.globalMaxPerHour !== undefined) {
    setters.setNotifyGlobalMaxPerHour(overrides.overrides.notify.globalMaxPerHour);
  }
}
```

### Boot-time precedence

```
admin-override (disk)  >  yaml (agent.yaml)  >  env var  >  default rule
```

In `webTransport.register()`:

```ts
// 1. Resolve allowAnonymous from yaml/env/default (existing G3 logic)
const allowAnonymousResolution = resolveConfigBool(...);
let allowAnonymous = allowAnonymousResolution.value;

// 2. Apply admin overrides on top (NEW for G36)
const overrides = readOverrides(opts.agentDir);
if (overrides?.overrides.webTransport?.allowAnonymous !== undefined) {
  allowAnonymous = overrides.overrides.webTransport.allowAnonymous;
  // Update the resolution's source for /admin display:
  allowAnonymousResolution.source = "admin-override";
}

// 3. Same pattern for budgets.dailyBudgetUsd and notify.globalMaxPerHour
// (each augment's register hook calls applyOverridesTo with its setters)
```

The dashboard displays the *effective* value with the source annotation — operator can see at a glance whether a value comes from yaml or from an /admin override.

### Reset-to-yaml affordance

Each overridden value's row in the dashboard includes a "Reset to yaml" button that POSTs to `/admin/action/reset-override/row/<path>` — calls `clearOverride()` + restores the closure to the yaml-resolved value (re-runs the original `resolveConfigBool` for that field). This is the v1.0 way to revert an /admin change without restarting.

### Runtime discipline (S6, S7, O23)

- **Read once at boot, then closure is source of truth.** `admin-overrides.json` is read by `readOverrides()` once during `register()`. Subsequent dashboard renders read the **closure** (in-memory) values via `adminInfo()` — never touch the file again. An action that mutates a knob updates both the closure AND the file synchronously, then the next render reads the new closure value. This avoids any disk-vs-memory consistency window during normal operation.
- **Write order on mutating actions: file first, then closure.** The action dispatcher's flow for persistent mutations: (1) compute the new override payload, (2) `writeOverrides()` — if this fails, return `{ ok: false, message: "could not persist override; agent state unchanged" }` and **do not** mutate the closure. (3) Only after the file write succeeds, call the closure setter (`setAllowAnonymous(value)` etc.). This ordering guarantees: file write fails → no closure change → restart-safe; closure mutation fails after file write (shouldn't but defense in depth) → next restart reads the file and converges.
- **Last-write-wins concurrency semantics.** Two operators (or two browser tabs with the same bearer) submitting simultaneous adjustments to the same field overwrite each other. Atomic-rename prevents corruption; ordering is whichever rename hit the filesystem second. No merge logic, no optimistic-concurrency tokens at v1.0. Documented as expected behavior.

## Security model

| Concern | Mitigation |
|---|---|
| Bearer leak in URL / referrer | HTTP Basic puts bearer in `Authorization` header. Never URL, never body. Avoids OpenClaw CVE-2026-25253 class. |
| CSRF | HMAC token per form (see CSRF Token Shape below). Token binds to `(bearer, agentName, timestamp, actionId, rowKey?)` — when an action is row-scoped, the rowKey is part of the HMAC so an exfiltrated token for `memory-erase` on `vis_abc` cannot be replayed against `vis_xyz`. Token expires after **24 hours** (extended from 1 hour after adversarial review — reduces friction for operators returning to a left-open admin tab without meaningfully weakening the binding). Server validates token + timestamp + (rowKey if present) on POST. Each form gets a fresh token at page render. |
| Auto-connect-to-attacker | No JS, no WebSocket, no client-side fetch. Browser cannot be tricked into auto-sending the bearer to an attacker. Avoids OpenClaw CVE class by construction. |
| HTTPS enforcement on non-loopback | `/admin` returns `426 Upgrade Required` with `Upgrade: TLS/1.2` header if the request arrives via plain HTTP on a non-loopback address. Loopback IPs (`127.0.0.0/8`, `::1`) are exempt for dev. Detection via `isLoopback(ip)` helper added in `web-transport.ts`: returns true for `127.0.0.0/8` or `::1` (specifically: any string matching `/^127\./` or exactly `::1` after `normalizeIp` stripping the IPv4-mapped IPv6 prefix). The connection IP is what matters, not the Host header value (a request to `localhost:8080` from another host still has a non-loopback connection IP and gets the 426). The 426 response body is a short HTML+plain-text page explaining: *"`/admin` requires HTTPS on non-loopback addresses. Either: (1) configure HTTPS termination in front of this agent, (2) access via `http://127.0.0.1:<PORT>/admin` from the agent host, or (3) tunnel: `ssh -L <PORT>:127.0.0.1:<PORT> user@host`."* |
| 401 response body | Empty (zero-length). The `WWW-Authenticate: Basic realm="auggy-admin <agent-name>"` header is the only agent identity exposed pre-auth — required by the basic-auth flow. No additional context in the body. |
| Flash message in URL (`?msg=...`) | Server-controlled redirect target after a successful action; `msg` value originates from the augment's `AdminActionResult.message`. Rendered through the same HTML-escape path as all other interpolated values. An attacker who controls the redirect target would already have admin credentials, so injection into the flash banner is not a privilege-escalation path. Documented for defense-in-depth audit. |
| Audit log | Every action: `[admin] actor=creator ts=<ts> action=<id> result=<ok/fail> rowKey=<key|none> inputs=<sanitized> before=<value> after=<value>` to console.log AND to the calling augment's ring buffer (auto-visible in its eventStream section on subsequent /admin loads). |
| Browser autofill on shared machines | Footer notice: "Admin credentials are visible in browser devtools; don't share screenshots that include the Network tab." Acknowledged in threat model. Operator's responsibility (use separate browser profile). |
| URL-embedded credentials in shared screenshots | Not applicable — HTTP Basic auth header isn't in URLs. |
| Devtools exposure | Bearer is visible in `Authorization` header in devtools Network tab. Operator's responsibility per the footer notice. |
| Rate-limit on /admin (brute-force defense) | Per-IP combined budget across the entire `/admin*` surface: 60 req/min total per IP (not 60 per endpoint). Uses existing `webTransport.checkRouteRateLimit` mechanism with route-key `"admin"`. Returns 429 + `Retry-After` when exceeded. |
| Override file tampering | The override file is owned by the agent's user; `chmod 600` recommended (documented in docs/06-transports.md). File integrity not separately verified — operator-owned filesystem is the trust boundary. |

## CSRF token shape

```
token = base64url(HMAC-SHA256(
  secret = bearer,
  message = agentName + "|" + timestamp + "|" + actionId + "|" + (rowKey ?? ""),
)) + "." + timestamp
```

The timestamp is the token's issue time (Unix seconds, base 10). `rowKey` is the table-row identifier for row-scoped actions; empty string for augment-level actions. Server validates on POST:

1. Split token at "." → `(signature, timestamp)`
2. Check `now() - timestamp < 86400` (24-hr expiry — extended after adversarial review to reduce friction for operators returning to a left-open admin tab)
3. Determine `rowKey`: present in the URL path for row actions (`/admin/action/<id>/row/<rowKey>`), empty otherwise
4. Recompute `HMAC-SHA256(bearer, agentName + "|" + timestamp + "|" + actionId + "|" + (rowKey ?? ""))`
5. Constant-time compare against `signature` portion (reuses webTransport's existing `timingSafeEqual`)

This binds the token to:
- **The specific bearer** — can't reuse tokens from another agent or after the operator rotates `AUGGY_WEB_TOKEN`
- **The specific actionId** — token for `notify-test` can't be reused on `posture-flip`
- **The specific rowKey** (when present) — token for `memory-erase` on `vis_abc` can't be reused against `vis_xyz`
- **A 24-hour time window** — bounded enough for security, large enough for typical operator session patterns

Renderer issues one fresh token per form at every page render. A row's "erase peer" button gets a token bound to *that row's* peer ID. The augment-level "Send test notification" button gets a token with empty rowKey.

### Expired token UX

When the server rejects a token because `now() - timestamp >= 86400` (expired), it returns a graceful HTML response: *"Session expired — refreshing the page now..."* with `<meta http-equiv="refresh" content="0; url=/admin">` so the browser re-fetches `/admin`, gets fresh tokens, and the operator retries. The bearer is still cached by the browser (HTTP Basic session), so re-prompt isn't required — only the form token is refreshed.

## Tests

### Unit tests

| Test file | What it covers |
|---|---|
| `tests/lib/admin-overrides.test.ts` | Schema, round-trip, atomic write, corrupt-file fallback, missing-file fallback, precedence application, version mismatch handling |
| `tests/lib/ring-buffer.test.ts` | Push, snapshot, eviction, bounded behavior, concurrent push safety (insofar as single-threaded JS allows) |
| `tests/transports/admin/admin-auth.test.ts` | HTTP Basic decode (valid, malformed, empty). **Explicit case: empty username `Authorization: Basic <base64(":bearer")>` decodes correctly + the bearer-comparison succeeds — verifies Bun's parsing handles the empty-username form used by `curl -u :$TOKEN`** (S15). Bearer timing-safe comparison. 401 + WWW-Authenticate emission with empty body. HTTPS-on-non-loopback gate (loopback bypass for 127.x and ::1, non-loopback reject with 426 + Upgrade header + guidance body, hostname `localhost` resolving to 127.0.0.1 is still accepted because connection IP is loopback). |
| `tests/transports/admin/admin-csrf.test.ts` | Token generation. Validation cases: valid, expired (>24hr — uses fake-clock), wrong-action (token for `notify-test` rejected on `posture-flip`), wrong-bearer (rotated token rejected), tampered signature, tampered timestamp. **Row-scoped binding:** token issued for `memory-erase` row `vis_abc` REJECTED when submitted to `memory-erase` row `vis_xyz` — confirms M1 fix (rowKey is part of the HMAC). |
| `tests/transports/admin/admin-boot-validation.test.ts` | **Boot-time handler-completeness check (M5):** boot an augment that declares `adminInfo().actions[0].id = "missing-handler"` but doesn't include `"missing-handler"` in `adminActions`. Expect `agent.start()` to throw with the exact error: `[admin] augment <name> declares action "missing-handler" but does not provide an adminActions handler.` Also: same shape for row actions declared in table sections with missing handlers. Positive case: an augment with matching declarations + handlers boots cleanly. |
| `tests/transports/admin/admin-renderer.test.ts` | Each section type renders correctly; HTML escaping on all interpolated values; action forms include CSRF; row actions render in tables; flash message renders when present |
| `tests/transports/admin/admin-collector.test.ts` | Iterates augments, calls `adminInfo()`, handles augments without `adminInfo`, catches per-augment errors and renders status sections in their place |
| `tests/transports/admin/admin-route.test.ts` | GET /admin success path, POST /admin/action dispatch, 404 when adminRoute=false, 426 on HTTPS-required, 401 on missing/wrong bearer, 429 on rate-limit |
| Per-augment adminInfo tests (5) | One per augment: budgets, layered-memory, notify, visitor-auth, webTransport. Each asserts the expected `AdminInfoBlock` shape given specific augment state |

### Integration tests

| Test | What it covers |
|---|---|
| Full agent boot + GET /admin (loopback) | Without bearer: 401 + WWW-Authenticate. With basic-auth bearer: 200 + HTML containing all 5 augment blocks. |
| POST /admin/action/notify-test | Dispatches notify; bypasses rate-limit; adapter receives test flag; redirects with flash. |
| POST /admin/action/posture-flip | Writes admin-overrides.json; closure updated; subsequent GET /admin shows new value with `source: /admin override`. |
| Restart picks up override | Boot agent, flip allowAnonymous, restart agent, GET /admin shows the override is still applied. |
| POST /admin/action/budget-cap-adjust | Same shape; persists. |
| POST /admin/action/memory-erase/row/<peer> | Calls `forget(peer)`; entries gone on next GET. |
| Reset-to-yaml action | After an override, reset removes it from the file and restores closure to yaml-resolved value. |
| Boot with corrupt admin-overrides.json | Boot succeeds, warning logged, all overrides fall back to yaml. |
| `adminRoute: false` | GET /admin returns 404. POST /admin/action/* returns 404. |
| HTTPS-on-non-loopback test | Mock req with non-loopback IP + http scheme → 426 with Upgrade header. |
| CSRF token | Generated token validates; expired token rejected; wrong-action token rejected; tampered token rejected. |
| Rate-limit | After 60 requests in 60 seconds, /admin returns 429 + Retry-After. |
| One broken augment doesn't break the page | An augment's `adminInfo()` throws → renderer shows `status: error` block for that augment; other augments' blocks render normally. |

## Acceptance criteria

- [ ] All new TypeScript types exported from `src/types.ts`
- [ ] `bun test` passes — full suite plus new unit + integration tests
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` baseline preserved (0 errors, baseline warnings only)
- [ ] Manual smoke: `auggy create test-g36 && auggy dev test-g36` → `curl -u :$AUGGY_WEB_TOKEN http://localhost:8080/admin` returns the HTML dashboard
- [ ] Manual smoke: browser session → /admin → HTTP Basic prompt → enter bearer → dashboard renders → click "Send test notification" → form submits → flash banner shows success
- [ ] Manual smoke: flip allowAnonymous from /admin → restart agent → /admin shows the override is still active with `source: /admin override`
- [ ] Manual smoke: with `adminRoute: false` in yaml → /admin returns 404
- [ ] Manual smoke: corrupt admin-overrides.json → agent boots with warning logged, yaml values used
- [ ] `docs/06-transports.md` updated; section describes /admin auth, opt-out, persistence, security
- [ ] Adversarial review pass (`/codex:adversarial-review`) — fix any HIGH-severity findings before merge

## Open questions (deferred to implementation time)

- **Exact `webTransport.adminRoute` field placement in WebTransportOptions** — alongside `publicFrontendUrl` (both runtime-level affordance flags) seems right; verify during implementation.
- **Exact rate-limit number for /admin** — 60/min is the proposed default; if it's too restrictive for browsers loading multiple sub-requests (none expected with no-JS, but possible if an operator opens multiple tabs), bump to 120/min in the implementation phase.
- **Reset-to-yaml UX** — button per row vs single "Reset all overrides" button. v1.0 ships per-row buttons for granularity; revisit if too noisy.
- **Auggy admin CLI verb** — `auggy admin <name>` to open the browser at the agent's admin URL. Deferred to a separate v1.0 follow-up if time permits; not blocking.

## Out of scope (deferred)

- Inline operator chat in /admin (G36-followup, filed in Tier 2)
- Generic settings UI for any yaml field (only the 3 named runtime-tunable knobs ship)
- Per-augment custom widgets / raw HTML escape hatch
- Multi-page admin layout
- WebSocket-backed live updates (waits for the Tier-2 telemetry pipeline)
- Multi-operator distinguishing (G11, Tier 3)
- Persistent action history beyond the per-augment ring buffer
- Per-action authorization beyond "creator can do anything"
- `auggy admin <name>` CLI verb (optional v1.0 follow-up)
- Memory retention class promotion action (skipped per 2026-05-19 brainstorming — user chose not to include in v1.0)

## Risks + open questions

- **Risk: scope creep during implementation.** 6 actions + 5 adminInfo implementations + persistence layer + ring-buffer utility + HTML rendering + tests is a lot. Mitigation: strict adherence to YAGNI — no new section types, no escape hatches, no fancy widgets. Implementation plan breaks this into bite-sized tasks.
- **Risk: Bun behaviors on `Authorization: Basic` parsing or 426 status responses.** Verify in implementation: Bun should parse basic auth headers correctly and emit 426 with proper headers. Boot probe in tests.
- **Risk: admin-overrides.json contention.** Single-process JS; concurrent writes shouldn't happen. Atomic rename pattern handles the half-written-file case. Mitigation: well-understood pattern (mirrors `cli/pid-registry.ts`).
- **Open: action audit log granularity.** v1.0 ships console.log + ring buffer entries. Should there be a dedicated audit log file (`~/.auggy/<agent>/admin-audit.log`)? Deferred — file-based audit log is fine for v1.1+ if operators ask.
- **Open: should the override file have a per-field "expires at" timestamp** so operators can set "demo mode for 1 hour" overrides that auto-revert? Deferred. v1.0 ships permanent-until-cleared overrides. The Tier-2 telemetry pipeline can introduce time-bounded overrides later if needed.
- **Open: what happens if an augment's `adminInfo()` is slow** (e.g., layered-memory's listEntriesByPeer over a giant DB)? v1.0 caps at 50 rows per augment query — should be fast. If an augment's `adminInfo()` exceeds 1 second, log a warning. Watchdog timer optional, skip for v1.0.

## Hardcoded constants — risks acknowledged

- `60` requests/min rate limit on /admin — arbitrary. Bump in implementation if tests show it's restrictive.
- `1 hour` CSRF token expiry — arbitrary; OK for typical operator sessions.
- `50` rows per table — arbitrary cap; pagination is future scope.
- `admin-overrides.json` filename — convention; documented in docs/06-transports.md.

## Summary

G36 ships v1.0's operator administration surface as a built-in `/admin` route in `webTransport`. Server-rendered HTML, no JS, HTTP Basic auth, CSRF-protected. Augments opt into being dashboarded via a typed `adminInfo()` contract. Three runtime-tunable knobs persist via an admin-overrides.json file. The architecture parallels G2's info-endpoint pattern (`src/transports/admin/` module dispatched from `web-transport.ts`) and the shared utility (`src/lib/ring-buffer.ts`) forward-compats with the Tier-2 telemetry pipeline. Inline operator chat is deferred to G36-followup.

Estimated effort: ~8-10 days.

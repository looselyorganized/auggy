# G36 Phase 4 — Docs + Verification + Final PR

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land operator-facing reference docs for the new `/admin` route, run a real manual smoke against a scaffolded agent, address any adversarial-review findings, and open the Phase 4 PR closing out G36.

**Architecture:** No new code. Two doc files updated (`docs/06-transports.md`, `docs/07-built-in-augments.md`). One manual smoke. One adversarial-review pass. One PR.

**Tech Stack:** Markdown only. Smoke uses `auggy create`, `curl`, and Bun.

---

## Prerequisites

- PR #61 (Phase 3) merged to `main`.
- `feat/g36-phase-4-docs-verification` branched off the updated `main`.

If #61 hasn't merged yet, stop and wait. Phase 4 docs reference Phase 3 behavior — diverging from main while #61 is still open means rebase pain.

---

## File Structure

```
docs/
├── 06-transports.md            # Modified — new "G36 — /admin route" section
└── 07-built-in-augments.md     # Modified — per-augment "Admin info" paragraphs

docs/superpowers/plans/
└── 2026-05-19-g36-phase-4-docs-verification.md  # this file

(No new files. No code changes.)
```

The `/admin` section in `06-transports.md` lives alongside the existing transport reference content because `/admin` is a built-in route owned by `webTransport`, not a separate transport.

Per-augment `Admin info` paragraphs in `07-built-in-augments.md` slot into the existing per-augment section structure (one paragraph each under the augment's heading).

---

## Task 4.1: docs/06-transports.md — `/admin` route reference section

**Files:**
- Modify: `docs/06-transports.md` (insert new `## G36 — The /admin route` section)

**Where to place it:** After `## Augment-registered HTTP routes (PR γ.1)` (ends ~line 682) and before `## Multi-transport composition` (~line 684). Rationale: `/admin` is built-in (not augment-registered) but composes with augment-declared `adminInfo`, so it logically sits between the augment-routes section and the multi-transport section.

- [ ] **Step 1: Insert the /admin section**

Insert the following block immediately before the line `## Multi-transport composition`:

```markdown
## G36 — The `/admin` route

The built-in `/admin` route gives the creator a single HTTP surface for inspecting and tuning every augment that declares an `adminInfo()` contract. Composable across augments: the route lives in `webTransport` and dispatches; each augment owns its block.

### Surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Server-rendered dashboard (HTML). Composes one block per augment that declares `adminInfo()`. |
| POST | `/admin/action/<id>` | Augment-level action dispatch. CSRF-protected. |
| POST | `/admin/action/<id>/row/<rowKey>` | Row-scoped action (table rowActions, keyValue resetActions). |

`HEAD /admin` returns 405 with `Allow: GET, POST`. Any other method on an `/admin*` path returns 405 as well.

### Opt-out

Set `adminRoute: false` in `webTransport(opts)` to disable the surface entirely. When disabled, GET/POST against any `/admin*` path falls through to the 404 handler — there is no signal that an `/admin` route ever existed. Operators with a custom admin surface or security-conscious deploys can use this to suppress the bearer-as-password seam.

### Auth

HTTP Basic with the webTransport bearer as the password. Username is ignored:

```
authorization: Basic base64(":<bearer-token>")
```

A `WWW-Authenticate: Basic realm="auggy-admin <agent-name>"` header on 401 lets browsers prompt for credentials. Bearer comparison is timing-safe.

### HTTPS-on-non-loopback gate

When the caller IP is not loopback (not in `127.0.0.0/8`, not `::1`, not IPv4-mapped loopback), the route returns `426 Upgrade Required` with a body explaining how to either expose HTTPS or use an SSH tunnel. The gate fires BEFORE the bearer check, so an attacker probing over plain HTTP cannot learn whether the bearer is correct.

The body includes:

```
HTTPS required for /admin on non-loopback connections.

Options:
  1. Front the agent with an HTTPS reverse proxy (Railway, Fly, Caddy, nginx).
  2. SSH tunnel and access via localhost:
       ssh -L 8080:localhost:8080 <host>
       curl -u :$BEARER http://localhost:8080/admin
```

### CSRF

Every POST against `/admin/action/*` requires a `_csrf` token in the form body.

Tokens are HMAC-SHA256 over `<agentName>|<unix-ts>|<actionId>|<rowKey-or-empty>`, signed with the bearer. Format: `<base64url(sig)>.<unix-ts>`.

| Property | Behavior |
|---|---|
| Bearer rotation | invalidates all prior tokens |
| Action binding | a token for `posture-flip` will not validate against `posture-reset` |
| Row binding | a row-scoped token tied to `rowKey=vis_a` will not validate for `rowKey=vis_b` |
| Expiry | 24h; future-skew tolerance 60s |
| Replay | each token is single-use against its specific binding tuple |

Validation returns a rich result: `{valid: true}` or `{valid: false; reason: "expired" | "tampered" | "malformed"}`. **Expired** tokens return `200 OK` with an HTML meta-refresh back to `/admin` (graceful UX — the operator's session timed out, give them a fresh CSRF on reload). **Tampered** and **malformed** return `403`.

### Rate limiting

Per-IP combined rate limit across the entire `/admin*` surface: **60 requests / minute**, synthetic route-key `"admin"`. Defeats brute-force against HTTP Basic. Returns `429` with `Retry-After`. Honors `trustedProxies` for X-Forwarded-For (same machinery as augment-registered routes).

### Composition — the `adminInfo()` contract

Each augment that owns inspectable state declares two optional fields on the `Augment` interface:

```ts
interface Augment {
  // ... existing
  adminInfo?: () => Promise<AdminInfoBlock>;
  adminActions?: Record<string, AdminActionHandler>;
}
```

`adminInfo()` returns a block of section primitives:

- **`keyValue`** — labelled rows with optional `source` annotation (`yaml` / `env` / `/admin override`) and optional `resetAction`. Used for live posture display and operator-tunable knobs.
- **`table`** — columnar rows with optional `rowActions` (per-row buttons; rowKey extracted from a chosen column index).
- **`status`** — single-line status with `level: "ok" | "info" | "warn" | "error"`.
- **`eventStream`** — recent-events stream (currently rendered as a table; reserved for the deferred Tier-2 telemetry pipeline).

`adminActions[id]` is the handler invoked on POST. Returns `{ok, message}` for the redirect's flash.

At boot, `buildAdminActionRegistry` walks every mounted augment's `adminInfo()` declarations and constructs a global action registry. **Action ids must be globally unique across augments** — collisions throw at boot. Declared actions without a matching handler also throw at boot — the runtime-bomb pattern (handlers missing, only discovered at first POST) cannot occur.

### Persistence — `admin-overrides.json`

Three runtime-mutable knobs (Phase 3) persist across restart via `<agentDir>/admin-overrides.json`:

| Knob | Owning augment | Override action | Reset action |
|---|---|---|---|
| `allowAnonymous` | `webTransport` | `posture-flip` | `posture-reset` |
| `dailyBudgetUsd` | `budgets` | `budget-cap-adjust` | `budget-cap-reset` |
| `globalMaxPerHour` | `notify` | `notify-cap-adjust` | `notify-cap-reset` |

Schema is Zod-validated (`{version: 1, lastModified, lastModifiedBy, overrides: {...}}`). File is written atomically (temp + rename) with `0o600` mode. Each augment reads its override at construction time and applies it on top of yaml + env precedence; subsequent admin POSTs persist back via `writeOverrides()` BEFORE mutating the closure — S7 ordering ensures a write failure leaves agent state unchanged.

Resets clear the relevant field from the file (and the augment object key if the field was the last child); the augment re-resolves from yaml/env/default.

### Audit log

Every action POST emits a structured `console.log` line:

```
[admin] actor=creator action=<id> rowKey=<key|-> result=<ok|fail> message=<json-quoted>
```

Captured by Bun's stdout/stderr → operator-grep'able. A dedicated audit file is deferred (Tier-2 follow-up; the telemetry-exporter pattern in `lo/telemetry-exporter/` is the planned destination).

### Reserved paths

`/admin` and `/admin/` are reserved — augments cannot register routes there. The route collector enforces both exact path collisions AND a scoped prefix block (`/admin/*` cannot be claimed by augment routes). Without this, an augment could shadow the dispatcher.

### Operator workflow

```bash
# Set up agent with admin enabled (default)
auggy create my-agent
# Edit my-agent/agent.yaml: ensure webTransport.adminRoute: true (default)

# Start the agent
auggy dev my-agent

# Hit /admin (assuming bearer in $AUGGY_BEARER)
curl -u :$AUGGY_BEARER http://localhost:8080/admin

# From a remote host? SSH tunnel first (HTTPS gate blocks non-loopback over HTTP):
ssh -L 8080:localhost:8080 my-host
# Then curl as above.

# Flip the posture (requires CSRF — easiest via the rendered HTML form, not curl).
# For scripted use, generate the CSRF via the augment's exported helper and POST it.
```

### What's not in v1

- **Live updates** — the dashboard is request/response; no SSE or polling. Page refresh required to see new events. (Tier-2 telemetry pipeline.)
- **Pagination** — tables cap at 50 rows. Operators with more than 50 verified visitors / memory entries / peers-with-spend see only the most recent.
- **Operator chat surface** — chatting with the agent from `/admin` is filed as G36-followup (Tier-2). The Local GUI (`auggy chat`) remains the primary way to interact with running agents.
- **Multiple operators** — single bearer = single creator. Operator delegation is out of scope.
- **Action audit file** — `console.log` only.
```

- [ ] **Step 2: Verify the section renders + word-count is reasonable**

```bash
wc -l docs/06-transports.md
grep -c "^## G36" docs/06-transports.md  # should print 1
```

Expected: file grows by ~150-180 lines. Exactly one new `## G36` heading.

- [ ] **Step 3: Commit**

```bash
git add docs/06-transports.md
git commit -m "docs(transports): /admin route reference (G36 phase 4)"
```

---

## Task 4.2: docs/07-built-in-augments.md — per-augment `Admin info` paragraphs

**Files:**
- Modify: `docs/07-built-in-augments.md` (5 inline additions — one per augment that declares adminInfo)

For each of the 5 augments that gained adminInfo in Phase 3, add a short `### Admin info` subsection at the end of that augment's section. Each paragraph is ~50-80 words: what the block shows + what actions are available.

- [ ] **Step 1: Add `### Admin info` to webTransport — NOT in this file**

Skip — `webTransport` isn't documented in `07-built-in-augments.md` (it's a transport, covered by `06-transports.md` instead). Its adminInfo coverage already lives in Task 4.1.

- [ ] **Step 2: Add `### Admin info` under `## budgets`**

Open `docs/07-built-in-augments.md`. Find the `## budgets — Per-trust-level turn budgets` heading (line ~885). Append the following at the end of the budgets section (right before the next `##` heading):

```markdown
### Admin info

The `/admin` route renders a **Budgets** block with:

- **KV row** — daily cap (with `yaml` or `/admin override` source), today's total spend, active peer count.
- **Table** — per-peer spend + unpriced turn count for today (top 50 peers).
- **Actions** — `budget-cap-adjust` (POSTs a new daily cap; persists to `admin-overrides.json`) and `budget-cap-reset` (clears the override, restores the yaml value).

The closure variable backing the daily cap is mutated on flip, so the new cap takes effect on the NEXT prepare() — no restart required. Pass `agentDir` in the augment config to enable persistence.
```

- [ ] **Step 3: Add `### Admin info` under `## notify`**

Find the `## notify — Outbound messaging to operator-configured destinations` heading (line ~622). Append at the end of the notify section:

```markdown
### Admin info

The `/admin` route renders a **Notify** block with:

- **KV row** — global cap per hour (with override-source annotation), cooldown ms, configured destination count.
- **Table** — last 50 dispatch attempts from the augment's internal ring buffer (time, destination, status, summary snippet).
- **Actions** — `notify-test` (sends `[test] <message>` via the named destination, **bypassing rate-limit + dedup** — for diagnostic dispatch), `notify-cap-adjust` (overrides `globalMaxPerHour`), `notify-cap-reset` (restores yaml).

The override persists across restart when `agentDir` is set in the augment config.
```

- [ ] **Step 4: Add `### Admin info` under `## visitorAuth`**

Find `## visitorAuth — Email magic-link verification` (~line 1000). Append:

```markdown
### Admin info

The `/admin` route renders a **Visitors** block with:

- **KV row** — mail transport, inbox / console mode, public URL, agent binding.
- **Status section** — `warn` level when transport is `console` and `NODE_ENV=production` (operator-visible reminder that magic links print to logs).
- **Table** — verified visitors (email, verified-at, revoked) with a per-row `visitor-revoke` action. Revoke uses the email as the rowKey; calls `revokeByEmail` + `addRevokedVisitorId` so the denylist survives `unrevokeAndRotate`.
```

- [ ] **Step 5: Add `### Admin info` under `## layeredMemory`**

Find `## layeredMemory — Peer-scoped episodic memory` (~line 393). Append:

```markdown
### Admin info

The `/admin` route renders a **Memory** block with:

- **KV row** — total live entry count, retention-class breakdown (operational vs lesson), namespace prefix.
- **Table** — 50 most-recent live entries (peer, label, content snippet, retention class, age) with a per-row `memory-erase` action.
- **Erase semantics** — invokes `store.forget(peerId)` and reports the deletion count. Per-peer only; there is no "erase all" affordance (intentional — too easy to wipe everything by mistake).
```

- [ ] **Step 6: Sanity-check the additions**

```bash
grep -c "^### Admin info" docs/07-built-in-augments.md  # should print 4
```

Expected: 4 new `### Admin info` subsections (budgets, notify, visitorAuth, layeredMemory).

- [ ] **Step 7: Commit**

```bash
git add docs/07-built-in-augments.md
git commit -m "docs(augments): per-augment adminInfo paragraphs (G36 phase 4)"
```

---

## Task 4.3: Manual integration smoke against a scaffolded agent

**Goal:** Boot a real agent with all 5 admin-declaring augments mounted, drive `/admin` end-to-end with `curl`, verify every action does what its `adminInfo` says it does.

This is the most valuable verification in Phase 4. Don't skip it.

**Files:**
- None modified. This is an evidence-gathering task.

- [ ] **Step 1: Scaffold a smoke agent in a temp directory**

```bash
SMOKE_DIR=$(mktemp -d -t auggy-g36-smoke-XXXX)
echo "Smoke dir: $SMOKE_DIR"
```

The smoke agent should NOT live in `~/.auggy/agents/` — keep it scoped to the temp dir so cleanup is trivial. Set up the directory manually (skipping `auggy create` which is interactive):

```bash
mkdir -p "$SMOKE_DIR/agent"
cat > "$SMOKE_DIR/agent/agent.yaml" <<'YAML'
name: g36-smoke
model: anthropic://claude-sonnet-4-6
engines:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
identity: identity.md
augments:
  - web:
      port: 18080
      auth:
        type: bearer
        token: "smoke-bearer-please-rotate"
      allowAnonymous: false
      adminRoute: true
  - budgets:
      dbPath: budgets.db
      dailyBudgetUsd: 100
      caps:
        agent: { maxUsdPerDay: 50 }
        public:
          anonymous: { maxTurnsPerThread: 5 }
  - layeredMemory:
      backend: sqlite
      namespace: ep
      dbPath: memory.db
      autoSave: { enabled: false }
  - notify:
      destinations:
        - name: echo
          transport: webhook
          url: https://webhook.site/REPLACE_WITH_YOUR_BIN
  - visitorAuth:
      publicUrl: http://127.0.0.1:18080
      dbPath: visitor-auth.db
      agentMail: { transport: console }
      signingKey: smoke-signing-key-please-rotate
      layeredMemoryDbPath: null
YAML

cat > "$SMOKE_DIR/agent/identity.md" <<'MD'
# G36 smoke agent

A throwaway agent used to manually verify the /admin route.
MD
```

(If you don't have a `webhook.site` bin handy, leave the URL as `http://127.0.0.1:1/echo` — `notify-test` will return ok=false with "connection refused", which still exercises the dispatcher.)

- [ ] **Step 2: Boot the agent**

```bash
export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"  # confirm it's set
auggy dev g36-smoke --config "$SMOKE_DIR/agent/agent.yaml" &
AUGGY_PID=$!
sleep 3  # let it bind the port
```

Verify it's up:

```bash
curl -s http://127.0.0.1:18080/health
# Expect: JSON with status: "healthy"
```

- [ ] **Step 3: GET /admin renders all 5 blocks**

```bash
BEARER="smoke-bearer-please-rotate"
AUTH=$(printf ':%s' "$BEARER" | base64)
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
grep -c "Posture\|Budgets\|Memory\|Notify\|Visitors" /tmp/g36-smoke-admin.html
# Expect: at least 5 (one per augment's block title)
```

Open `/tmp/g36-smoke-admin.html` in a browser and confirm:
- All 5 augment blocks render
- The form for each action appears with a `_csrf` hidden input
- Reset buttons appear next to overridable rows
- Per-row "Erase peer" / "Revoke" buttons appear in tables

- [ ] **Step 4: Exercise posture-flip + reset**

```bash
# Extract the CSRF token from the rendered page (it's in a hidden input on every action form).
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')
echo "CSRF: $CSRF"

# Flip allowAnonymous: false → true
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF&value=true" \
  http://127.0.0.1:18080/admin/action/posture-flip
# Expect: 303

# Verify admin-overrides.json was written
cat "$SMOKE_DIR/agent/admin-overrides.json" | python3 -m json.tool
# Expect: overrides.webTransport.allowAnonymous = true

# Reload /admin and verify the source annotation shows "/admin override"
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin | grep -A2 allowAnonymous
# Expect: text containing "true" + source annotation containing "override"

# Reset (re-grab CSRF first — each render gets a fresh page-level token)
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF" \
  http://127.0.0.1:18080/admin/action/posture-reset
# Expect: 303

cat "$SMOKE_DIR/agent/admin-overrides.json" | python3 -m json.tool
# Expect: overrides.webTransport is missing OR allowAnonymous field is gone
```

- [ ] **Step 5: Exercise budget-cap-adjust + reset**

```bash
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')

# Set daily cap to $200
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF&value=200" \
  http://127.0.0.1:18080/admin/action/budget-cap-adjust
# Expect: 303

cat "$SMOKE_DIR/agent/admin-overrides.json" | python3 -m json.tool
# Expect: overrides.budgets.dailyBudgetUsd = 200

# Reset
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF" \
  http://127.0.0.1:18080/admin/action/budget-cap-reset
# Expect: 303
```

- [ ] **Step 6: Exercise notify-test**

```bash
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')

curl -sS -i \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF&destination=echo&message=hello+from+g36+smoke" \
  http://127.0.0.1:18080/admin/action/notify-test | head -5
# Expect: HTTP/1.1 303 with location header containing /admin?msg=

# Reload and check the recent-dispatches table
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin | grep -c '\[test\]'
# Expect: at least 1
```

If you used a real `webhook.site` URL, verify the test message landed there too.

- [ ] **Step 7: Exercise memory-erase (with a seeded entry)**

The smoke agent has no memory entries unless you exercise it. The simplest seed:

```bash
# Trigger a turn to populate state (requires bearer)
curl -sS -X POST \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}],"threadId":"smoke-1"}' \
  http://127.0.0.1:18080/agent/run > /tmp/g36-smoke-turn.txt
# Wait ~5s for the turn to complete + autosave to (potentially) fire

# Inspect /admin to see if any rows appeared in the Memory table
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin | grep -A1 '"Memory"' | head -5
```

If the table is empty (auto-save is disabled in the smoke config, so this is expected), exercise memory-erase against a known-empty peerId:

```bash
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF" \
  http://127.0.0.1:18080/admin/action/memory-erase/row/vis_nonexistent
# Expect: 303 with redirect message "Erased 0 entries..."
```

- [ ] **Step 8: Exercise visitor-revoke against an unknown email**

```bash
curl -sS -H "Authorization: Basic $AUTH" http://127.0.0.1:18080/admin > /tmp/g36-smoke-admin.html
CSRF=$(grep -oE 'name="_csrf" value="[^"]+"' /tmp/g36-smoke-admin.html | head -1 | sed 's/.*value="\([^"]*\)".*/\1/')

curl -sS -i \
  -H "Authorization: Basic $AUTH" \
  -X POST -d "_csrf=$CSRF" \
  http://127.0.0.1:18080/admin/action/visitor-revoke/row/ghost%40example.com | head -3
# Expect: 303 with redirect message indicating "not found or already revoked"
```

- [ ] **Step 9: Verify the HTTPS-on-non-loopback gate**

Pretend to be a non-loopback caller. The simplest test: bind webTransport to a non-loopback interface, then connect to it. Skip this step if you can't easily craft a non-loopback IP — the gate is unit-tested in `tests/transports/admin/admin-auth.test.ts`.

If you have a local non-loopback IP (e.g., your machine's LAN address):

```bash
# Restart the agent with port bound to all interfaces (Bun does this by default).
# Replace 192.168.x.y with your machine's LAN IP.
curl -sS -i -H "Authorization: Basic $AUTH" http://192.168.x.y:18080/admin | head -10
# Expect: HTTP/1.1 426 Upgrade Required with guidance body
```

- [ ] **Step 10: Verify rate limit kicks in**

```bash
# Hammer /admin 61 times in a minute
for i in $(seq 1 61); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Basic $AUTH" \
    http://127.0.0.1:18080/admin
done | sort | uniq -c
# Expect: ~60 of 200, ~1 of 429
```

- [ ] **Step 11: Verify the audit log lines appear**

In the terminal where `auggy dev` is running, grep for `[admin] actor=creator`:

```bash
# Each action POST above should have emitted exactly one line.
# Expected lines (one each):
#   [admin] actor=creator action=posture-flip rowKey=- result=ok message="allowAnonymous set to true"
#   [admin] actor=creator action=posture-reset rowKey=- result=ok message="allowAnonymous reset to yaml: false"
#   [admin] actor=creator action=budget-cap-adjust rowKey=- result=ok message="Daily budget cap updated to $200.00"
#   [admin] actor=creator action=budget-cap-reset rowKey=- result=ok message="Daily budget cap reset to yaml value"
#   [admin] actor=creator action=notify-test rowKey=- result=... message=...
#   [admin] actor=creator action=memory-erase rowKey=vis_nonexistent result=ok message="Erased 0 entries for vis_nonexistent"
#   [admin] actor=creator action=visitor-revoke rowKey=ghost@example.com result=fail message=...
```

- [ ] **Step 12: Clean up**

```bash
kill $AUGGY_PID
rm -rf "$SMOKE_DIR"
```

- [ ] **Step 13: Record findings**

If any step produced unexpected output, write a short note in this section AND open a follow-up ticket in `lo/augment-1/docs/todos.md` (don't fix it in Phase 4 — the PR is docs-only). If everything passed, no commit is needed for this task — the smoke is verification, not artifact.

---

## Task 4.4: Adversarial-review pass on the full G36 diff

**Files:**
- None modified by default. Findings classified as **Must fix** get fixed inline; **Should fix** opens a follow-up ticket; **Optional** is noted in the PR body.

- [ ] **Step 1: Run the adversarial review**

Dispatch via the Agent tool:

```
Agent({
  subagent_type: "codex:adversarial-review",
  description: "Adversarial review of G36 full diff",
  prompt: "Review the cumulative G36 diff across PRs #59 (Phase 1), #60 (Phase 2), #61 (Phase 3), and this branch (Phase 4 docs). Focus on:

    - Correctness of the /admin auth + CSRF + HTTPS-gate logic
    - Per-augment override persistence (admin-overrides.json) — atomicity, S7 ordering, schema validation
    - Composition correctness — buildAdminActionRegistry boot-time validation
    - Reserved-path enforcement (no augment can shadow /admin or /admin/*)
    - Rate limit math (60/min synthetic 'admin' route key)
    - SQL correctness in the new store methods (getDaySpend, listEntriesByPeer, countByRetentionClass)
    - Docs accuracy — does docs/06-transports.md G36 section match the code?

    Classify findings as Must fix / Should fix / Optional. Do not introduce new architecture unless required. Output should be terse and actionable.

    The branches are merged on origin; review against the latest main + this Phase 4 branch."
})
```

- [ ] **Step 2: Triage findings**

For each **Must fix** finding:
1. If it's a docs error in `06-transports.md` or `07-built-in-augments.md` — fix inline, commit.
2. If it's a code defect in code already merged via #59 / #60 / #61 — open a separate hotfix branch off main, NOT a Phase 4 fix (Phase 4 is docs).
3. If it's a code defect introduced by Phase 4 (there should be none — Phase 4 is docs-only) — fix inline.

For each **Should fix** finding: open a follow-up ticket in `docs/todos.md`. Reference the ticket in the Phase 4 PR body.

For each **Optional** finding: note in the PR body. No action required.

- [ ] **Step 3: Re-verify after any fixes**

```bash
bunx tsc --noEmit
bun run lint
bun test
```

Expected: clean across all three. If Phase 4 stayed docs-only, the test count should still be 2117 (or whatever it was at the start of Phase 4 — no new tests added).

---

## Task 4.5: Open the Phase 4 PR

**Files:**
- None modified. This is a PR-management task.

- [ ] **Step 1: Confirm Phase 3 (PR #61) has merged**

```bash
gh pr view 61 --json state --jq '.state'
# Expect: "MERGED"
```

If `OPEN`, wait. Phase 4 docs reference Phase 3 behavior — diverging from main while #61 is open creates rebase pain.

- [ ] **Step 2: Rebase Phase 4 branch onto updated main**

```bash
git fetch origin main
git rebase origin/main
```

If conflicts arise: most likely in `docs/06-transports.md` or `docs/07-built-in-augments.md`. Resolve favoring Phase 4 content (the new sections are additive — conflicts mean main moved an adjacent section).

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/g36-phase-4-docs-verification

gh pr create --title "docs(g36-phase-4): /admin route reference + verification" --body "$(cat <<'EOF'
## Summary

G36 Phase 4 — closes out the `/admin` route initiative.

Builds on PR #59 (foundation) + PR #60 (admin module) + PR #61 (per-augment adminInfo).

### Docs added

- `docs/06-transports.md` — new "## G36 — The `/admin` route" section covering surface, opt-out, auth, HTTPS-on-non-loopback gate, CSRF model, rate limiting, composition contract, persistence, audit log, reserved paths, operator workflow, v1 limits.
- `docs/07-built-in-augments.md` — per-augment `### Admin info` paragraphs under budgets, notify, visitorAuth, layeredMemory.

### Verification

Manual smoke against a scaffolded agent (see Phase 4 plan Task 4.3):

- ✅ GET /admin renders all 5 blocks
- ✅ posture-flip / posture-reset (writes + clears admin-overrides.json)
- ✅ budget-cap-adjust / budget-cap-reset
- ✅ notify-test dispatch
- ✅ memory-erase (against empty peerId)
- ✅ visitor-revoke (against unknown email)
- ✅ HTTPS-on-non-loopback gate returns 426
- ✅ Rate limit kicks in at 60/min
- ✅ Audit log lines emitted

### Adversarial review

Pass via `codex:adversarial-review` over the cumulative G36 diff. Findings classified as Must / Should / Optional. Must-fixes addressed inline (see commits). Should-fixes filed in `docs/todos.md`.

### Test count

- `bun test` — 2117/0 (unchanged from Phase 3 — docs-only)
- `bunx tsc --noEmit` — clean
- `bun run lint` — baseline preserved

## Test plan

- [ ] CI green
- [ ] Reviewer skim of new `## G36` section in 06-transports.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Enable auto-merge**

```bash
gh pr merge --auto --squash --delete-branch
```

- [ ] **Step 5: Announce + transition**

When the PR opens, summarize for the user:
- PR URL
- Outstanding follow-ups (anything filed in `docs/todos.md` during Phase 4)

After it merges, G36 is **complete** — the route ships in v1.0. Open follow-ups under `G36-followup`:
- Chat-in-/admin surface (Tier-2, already filed)
- Tier-2 telemetry pipeline (already filed)
- Anything new surfaced by the adversarial review

---

## End-of-phase verification (post-merge)

After Phase 4 merges:

- [ ] `git checkout main && git pull` — confirm 4 G36 PRs landed cleanly
- [ ] `bun test` on main — confirm 2117+ tests pass
- [ ] Skim the rendered `docs/06-transports.md` on GitHub — confirm the G36 section renders correctly (tables, code blocks, headings)
- [ ] Update `docs/todos.md` to mark G36 as complete in Tier 1
- [ ] If `lo/augment-1/CLAUDE.md` mentions Phase 3 status anywhere, bump it to "Phase 4 shipped, G36 complete"

## Risks + open questions

- **Risk: docs/06 section drifts from code.** The section quotes specific function names (`buildAdminActionRegistry`, `checkAdminAuth`, etc.) and behavioral details (24h CSRF expiry, 60/min rate limit, S7 ordering). If Phase 3's PR description differs from what actually shipped, the docs will be wrong. Mitigation: Task 4.3's manual smoke verifies the behaviors; Task 4.4's adversarial review checks the docs against code.
- **Risk: PR 61 still open when Phase 4 starts.** The plan explicitly gates on #61 merged. Don't skip this — the docs reference per-augment behavior added in #61.
- **Open: should we ship an `auggy admin` CLI verb?** Spec mentioned it. Currently deferred — operators interact with /admin via browser. Filing as G36-followup if not already filed.
- **Open: should we update `lo/CLAUDE.md` root file to mention G36 ships in v1.0?** Probably yes, but it's a separate concern (LORF-level doc, not augment-1-level). Defer to a separate commit unless trivial.

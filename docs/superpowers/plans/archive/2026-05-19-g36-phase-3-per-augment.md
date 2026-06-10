# G36 Phase 3 — Per-Augment `adminInfo()` + Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the empty `/admin` dashboard shipped in Phase 2 by adding `adminInfo()` + `adminActions` to **5 augments**: `webTransport`, `budgets`, `layered-memory`, `notify`, `visitor-auth`. Ships **9 admin actions** total (2 always-safe + 1 security + 3 convenience + 3 reset-to-yaml companions).

**Architecture:** Each augment grows internal query methods (e.g., `budgets.getDaySpend`, `layered-memory.listEntriesByPeer`) consumed by its own `adminInfo()` implementation. Persistent runtime knobs (`allowAnonymous`, `dailyBudgetUsd`, `notify.globalMaxPerHour`) get a `setX` + `resetX` pair that mutates the closure AND writes/clears the `admin-overrides.json` file. No cross-augment imports — admin's only entry to each augment is the `adminInfo()` contract from Phase 1.

**Tech Stack:** TypeScript / Bun runtime / `bun:test`. Phase 1 utilities (`createRingBuffer`, `readOverrides`, `writeOverrides`). Phase 2 contract types (`AdminInfoBlock`, `AdminSection`, `AdminAction`, `AdminActionHandler`).

**Depends on:** Phase 1 (foundation utilities + types) + Phase 2 (admin module + webTransport dispatch + reserved-paths) — both merged to main before Phase 3 starts.

**Branch:** `feat/g36-phase-3-per-augment` (already checked out off updated main).

**Spec:** `docs/superpowers/specs/2026-05-19-g36-admin-route-design.md` (local-only).

---

## File Structure (Phase 3)

| File | Status | What changes |
|---|---|---|
| `src/transports/web-transport.ts` | modified | Add `adminInfo()` returning posture KV (allowAnonymous + source, publicFrontendUrl, port, trustedProxies). Add `adminActions["posture-flip"]` + `adminActions["posture-reset"]`. Both update closure + write/clear `admin-overrides.json`. |
| `src/augments/budgets/budget-store.ts` | modified | Add `getDaySpend(day)` + `getRecentEvents(limit)` (backed by new ring buffer). Add `setDailyBudgetUsd(value)` + `resetDailyBudgetUsd()`. |
| `src/augments/budgets/index.ts` | modified | Wire ring buffer for budget events emitted at prepare/commit/cap-denied. Add `adminInfo()` returning KV + table + eventStream. Register `budget-cap-adjust` + `budget-cap-reset` actions. |
| `src/augments/layered-memory/storage/sqlite-store.ts` | modified | Add `listEntriesByPeer(peerId?, limit)` query (50-row cap). Add `countByRetentionClass()`. |
| `src/augments/layered-memory/index.ts` | modified | Add `adminInfo()` returning KV + table with row-action. Register `memory-erase` row action (calls existing `forget(peerId)`). |
| `src/augments/notify/index.ts` | modified | Add ring buffer for dispatches. Add `setGlobalMaxPerHour(value)` + `resetGlobalMaxPerHour()`. Add internal "test" dispatch path that bypasses rate-limit + dedup. Add `adminInfo()` returning KV + table + actions. Register `notify-test` + `notify-cap-adjust` + `notify-cap-reset`. |
| `src/augments/visitor-auth/storage/*` | modified | Add `listVerifiedVisitors(limit)` query. |
| `src/augments/visitor-auth/index.ts` | modified | Add `adminInfo()` returning KV + status + table with row-action. Register `visitor-revoke` row action. |
| `tests/augments/*-admin-info.test.ts` | **new** | One per augment that implements `adminInfo()`. Each tests both the `adminInfo` output shape AND the corresponding `adminActions` handlers. |
| `tests/transports/admin/integration-web-posture.test.ts` | **new** | End-to-end integration: boot real agent, hit `/admin`, verify webTransport's posture block renders, flip allowAnonymous, observe persistence + override file write. |

---

## Pre-Phase verification — what's actually queryable today

Before starting, verify the per-augment internals these tasks assume. (This survey was done at the start of G36 work; some method names may have drifted.)

- [ ] **Step 0a:** confirm `src/augments/budgets/budget-store.ts` exposes `getPeerUsage`, prepare/commit cycle, and statements: `selectDailyTotalStmt`, `selectPeerCostStmt`, `countActiveThreadStmt`, `countActiveDayStmt`, `countAnonRequestsSinceStmt`. New methods will compose these.

```bash
grep -n "selectDailyTotalStmt\|getPeerUsage\|prepareStmt\|countActiveThread" src/augments/budgets/budget-store.ts | head
```

- [ ] **Step 0b:** confirm `src/augments/layered-memory/storage/sqlite-store.ts` exposes `search`, `read`, `list`, `forget`, `supersede`. New method `listEntriesByPeer` returns recent entries with the columns documented in the spec.

```bash
grep -n "export\|forget(\|search(" src/augments/layered-memory/storage/sqlite-store.ts | head
```

- [ ] **Step 0c:** confirm `src/augments/notify/index.ts` exposes the rate-limit state (`peerLastNotify`, `recentSummaries`, `globalCountThisHour`, `destinationCountsThisHour`, `destinationLastNotify`) as augment-local closure state. New ring buffer captures dispatches.

```bash
grep -n "peerLastNotify\|globalCount\|recentSummaries" src/augments/notify/index.ts | head
```

- [ ] **Step 0d:** confirm `src/augments/visitor-auth/index.ts` exposes the storage interface for the visitor table + revocation-check callback. The augment will gain a `listVerifiedVisitors` method.

```bash
grep -n "revocationCheck\|verifiedVisitor\|export function visitorAuth" src/augments/visitor-auth/index.ts | head
ls src/augments/visitor-auth/storage/
```

If any of these surveys turns up something materially different from this plan's assumptions, STOP and report — do not improvise. The plan may need a small revision.

---

### Task 3.1: webTransport `adminInfo()` + posture-flip / posture-reset actions

**Files:**
- Modify: `src/transports/web-transport.ts`
- Test: `tests/transports/admin/integration-web-posture.test.ts` (new)

webTransport itself is the augment that owns the `allowAnonymous` knob. Its `adminInfo()` returns the posture row; its `adminActions` provide flip + reset.

**Key constraints:**
- `setAllowAnonymous` mutator already exists from Phase 2 (Task 2.6).
- The closure also has `allowAnonymousResolution` whose `.source` we mutated when overrides applied at boot.
- `posture-flip` MUST: (1) write `admin-overrides.json` first, (2) only then mutate closure (S7 ordering).
- `posture-reset` MUST: (1) clear the override-field from disk, (2) re-resolve from yaml/env/default, (3) mutate closure back.
- The augment returned by `webTransport(opts)` has `name: "web"`. The Phase 2 collector iterates kernel augments — but `webTransport` itself is registered as an augment. We need to verify the returned object includes `adminInfo` + `adminActions` fields so the collector finds them.

- [ ] **Step 1: Write failing integration test**

Create `tests/transports/admin/integration-web-posture.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webTransport } from "@/transports/web-transport";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "auggy-g36-p3-1-"));
}

function basicHeader(bearer: string): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

describe("webTransport adminInfo — posture row (G36 phase 3)", () => {
  it("GET /admin renders the webTransport posture block", async () => {
    const model = createMockModel();
    const port = 19310;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: basicHeader("test-token") },
      });
      expect(resp.status).toBe(200);
      const body = await resp.text();
      // Block heading
      expect(body).toContain("Posture");
      // Key-value row for allowAnonymous
      expect(body).toContain("allowAnonymous");
      // Posture-flip action is rendered as a form
      expect(body).toContain('action="/admin/action/posture-flip"');
    } finally {
      await agent.stop();
    }
  });

  it("POST /admin/action/posture-flip writes admin-overrides.json + mutates closure", async () => {
    const agentDir = tempAgentDir();
    const port = 19311;
    const model = createMockModel();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
      agentDir,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const csrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-flip",
      });

      const resp = await fetch(`http://127.0.0.1:${port}/admin/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf, value: "true" }).toString(),
      });
      expect(resp.status).toBe(303);
      expect(resp.headers.get("location")).toContain("/admin?msg=");
      await resp.text();

      // Override file written
      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport.allowAnonymous).toBe(true);

      // Subsequent GET /admin should reflect the override + source annotation
      const getResp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: basicHeader("test-token") },
      });
      const body = await getResp.text();
      // The value is now true (was false at boot). Phase 3 adminInfo formats this string.
      expect(body).toContain("true");
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("POST /admin/action/posture-reset clears the override and reverts to yaml", async () => {
    const agentDir = tempAgentDir();
    const port = 19312;
    const model = createMockModel();
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      allowAnonymous: false,
      agentDir,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      // First, set the override
      const flipCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-flip",
      });
      await fetch(`http://127.0.0.1:${port}/admin/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: flipCsrf, value: "true" }).toString(),
      });

      // Verify override file exists
      const overrideFile = join(agentDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);

      // Now reset
      const resetCsrf = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "posture-reset",
      });
      const resp = await fetch(`http://127.0.0.1:${port}/admin/action/posture-reset`, {
        method: "POST",
        headers: {
          authorization: basicHeader("test-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: resetCsrf }).toString(),
      });
      expect(resp.status).toBe(303);
      await resp.text();

      // Override field cleared from file (file may still exist but the field is absent)
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.webTransport?.allowAnonymous).toBeUndefined();
    } finally {
      await agent.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/transports/admin/integration-web-posture.test.ts`

Expected: FAIL — webTransport doesn't yet implement adminInfo / adminActions. Forms for posture-flip / posture-reset won't be in HTML. Action POSTs hit 404 (registry has no entry).

- [ ] **Step 3: Add `adminInfo` + `adminActions` to webTransport's returned Augment**

Open `src/transports/web-transport.ts`. Find the existing `return { name: "web", ... }` augment object at the end of `webTransport(opts)`. INSIDE the closure (above the return), add a helper that constructs the AdminInfoBlock + add the action handlers. Then expose them as fields on the returned object.

First, add closure helpers + a helper to write/clear specific override fields:

```ts
// (somewhere after `function setAllowAnonymous(...)` near the closure top)

import { writeOverrides, readOverrides as readOverrideFile } from "../lib/admin-overrides";
import type { AdminInfoBlock, AdminActionResult } from "../types";

async function persistAllowAnonymousOverride(value: boolean): Promise<void> {
  if (!opts.agentDir) {
    throw new Error("agentDir not configured; admin overrides cannot persist");
  }
  const current = readOverrideFile(opts.agentDir) ?? {
    version: 1 as const,
    lastModified: new Date().toISOString(),
    lastModifiedBy: "creator",
    overrides: {},
  };
  current.lastModified = new Date().toISOString();
  current.lastModifiedBy = "creator";
  current.overrides.webTransport = {
    ...current.overrides.webTransport,
    allowAnonymous: value,
  };
  writeOverrides(opts.agentDir, current);
}

async function clearAllowAnonymousOverride(): Promise<void> {
  if (!opts.agentDir) return;
  const current = readOverrideFile(opts.agentDir);
  if (!current) return;
  if (current.overrides.webTransport) {
    delete (current.overrides.webTransport as Record<string, unknown>).allowAnonymous;
    if (Object.keys(current.overrides.webTransport).length === 0) {
      delete (current.overrides as Record<string, unknown>).webTransport;
    }
  }
  current.lastModified = new Date().toISOString();
  current.lastModifiedBy = "creator";
  writeOverrides(opts.agentDir, current);
}

async function adminInfo(): Promise<AdminInfoBlock> {
  const sourceLabel =
    allowAnonymousResolution.source === "admin-override"
      ? "/admin override"
      : `${allowAnonymousResolution.source}${
          allowAnonymousResolution.source === "env"
            ? ` (AUGGY_ALLOW_ANONYMOUS=${process.env.AUGGY_ALLOW_ANONYMOUS})`
            : allowAnonymousResolution.source === "default"
              ? ` (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`
              : ""
        }`;
  return {
    augmentName: "web",
    title: "Posture",
    sections: [
      {
        kind: "keyValue",
        rows: [
          {
            label: "allowAnonymous",
            value: String(allowAnonymous),
            source: sourceLabel,
            ...(allowAnonymousResolution.source === "admin-override"
              ? { resetAction: { id: "posture-reset", label: "Reset to yaml" } }
              : {}),
          },
          {
            label: "publicFrontendUrl",
            value: opts.publicFrontendUrl ?? "(unset)",
          },
          { label: "Port", value: String(opts.port) },
          {
            label: "Trusted proxies",
            value: (opts.trustedProxies ?? []).join(", ") || "(none)",
          },
        ],
      },
    ],
    actions: [
      {
        id: "posture-flip",
        label: "Flip allowAnonymous",
        confirmRequired: true,
        inputs: [
          {
            name: "value",
            label: "allowAnonymous",
            type: "boolean",
            required: true,
            helpText:
              "Demo-mode on/off. Persists across restart via admin-overrides.json.",
          },
        ],
      },
    ],
  };
}

const adminActions = {
  "posture-flip": async (params: Record<string, string>): Promise<AdminActionResult> => {
    const value = params.value === "true";
    try {
      // S7 ordering: file first, then closure
      await persistAllowAnonymousOverride(value);
    } catch (err) {
      return {
        ok: false,
        message: `could not persist override: ${(err as Error).message}; agent state unchanged`,
      };
    }
    setAllowAnonymous(value);
    (
      allowAnonymousResolution as unknown as { source: string }
    ).source = "admin-override";
    return { ok: true, message: `allowAnonymous set to ${value}` };
  },
  "posture-reset": async (): Promise<AdminActionResult> => {
    try {
      await clearAllowAnonymousOverride();
    } catch (err) {
      return {
        ok: false,
        message: `could not clear override: ${(err as Error).message}`,
      };
    }
    // Re-resolve from yaml/env/default
    const reResolved = resolveConfigBool(
      opts.allowAnonymous,
      "AUGGY_ALLOW_ANONYMOUS",
      () => process.env.NODE_ENV !== "production",
    );
    setAllowAnonymous(reResolved.value);
    (
      allowAnonymousResolution as unknown as {
        source: typeof reResolved.source;
        value: boolean;
      }
    ).source = reResolved.source;
    return { ok: true, message: `allowAnonymous reset to yaml: ${reResolved.value}` };
  },
};
```

Then in the returned Augment object, add the fields:

```ts
return {
  name: "web",
  capabilities: [...],
  transport: { ... },
  // ... existing fields
  adminInfo,
  adminActions,
};
```

(The exact merge point depends on where the existing `return { name: "web", ... }` is — find it at the bottom of `webTransport(opts)`.)

- [ ] **Step 4: Run integration tests — expect pass**

Run: `bun test tests/transports/admin/integration-web-posture.test.ts`

Expected: PASS — 3 tests green.

- [ ] **Step 5: Typecheck + lint + full suite**

```bash
bunx tsc --noEmit
bun run lint
bun test
```

Expected: typecheck clean. Lint baseline preserved. All previous tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/admin/integration-web-posture.test.ts
git commit -m "feat(web-transport): adminInfo + posture-flip + posture-reset (G36 phase 3)"
```

---

### Task 3.2: budgets adminInfo + budget-cap-adjust + budget-cap-reset

**Files:**
- Modify: `src/augments/budgets/budget-store.ts` (new internal query methods + setter/reset)
- Modify: `src/augments/budgets/index.ts` (ring buffer for events, adminInfo, adminActions)
- Test: `tests/augments/budgets-admin-info.test.ts` (new)

`budgets` is the cost-tracking augment. Phase 3 adds:
- `getDaySpend(day)` → returns `{ totalUsd, byPeer: Array<{peerId, costUsd, turnCount}> }`
- `getRecentEvents(limit)` → returns ring-buffer of recent budget admissions / cap denials
- `setDailyBudgetUsd(value)` + `resetDailyBudgetUsd()` — closure mutator + admin-overrides persistence
- `adminInfo()` returning KV + table + eventStream
- `adminActions["budget-cap-adjust"]` + `adminActions["budget-cap-reset"]`

- [ ] **Step 1: Survey budgets internals**

Run:
```bash
grep -n "export function budgets\|dailyBudgetUsd\|opts\." src/augments/budgets/index.ts | head -20
grep -n "export function createBudgetStore\|prepare(\|commit(" src/augments/budgets/budget-store.ts | head -20
```

Identify: where `dailyBudgetUsd` is captured in closure; the budget-store's existing prepare/commit/cap-evaluation entry points (so we can hook ring-buffer emission); how `opts.agentDir` would flow in (likely needs new option, mirror webTransport).

- [ ] **Step 2: Write the failing budgets adminInfo + actions tests**

Create `tests/augments/budgets-admin-info.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgets } from "@/augments/budgets";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-2-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeBudgetsAugment(): Augment {
  return budgets({
    storage: { kind: "sqlite", path: join(tempDir, "budgets.db") },
    agentDir: tempDir,
    caps: {
      creator: {},
      agent: { maxUsdPerDay: 50 },
      "public:anonymous": { maxTurnsPerThread: 5, maxUsdPerDay: 10 },
      "public:recognized": { maxUsdPerDay: 25 },
    },
    dailyBudgetUsd: 100,
  });
}

describe("budgets adminInfo — shape", () => {
  it("returns a Budgets block with KV section showing daily cap + today's spend", async () => {
    const aug = makeBudgetsAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      expect(info).toBeDefined();
      expect(info?.title).toBe("Budgets");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      if (kv?.kind === "keyValue") {
        const labels = kv.rows.map((r) => r.label);
        expect(labels).toContain("Daily budget cap");
        expect(labels).toContain("Today's spend");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("declares budget-cap-adjust + budget-cap-reset actions", async () => {
    const aug = makeBudgetsAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      const actionIds = (info?.actions ?? []).map((a) => a.id);
      expect(actionIds).toContain("budget-cap-adjust");
      expect(aug.adminActions?.["budget-cap-adjust"]).toBeDefined();
      expect(aug.adminActions?.["budget-cap-reset"]).toBeDefined();
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("budgets adminActions — budget-cap-adjust", () => {
  it("persists dailyBudgetUsd override and updates closure", async () => {
    const aug = makeBudgetsAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["budget-cap-adjust"]?.({ value: "200" });
      expect(result?.ok).toBe(true);
      const overrideFile = join(tempDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.budgets.dailyBudgetUsd).toBe(200);

      // Subsequent adminInfo reflects the override
      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const dailyCap = kv.rows.find((r) => r.label === "Daily budget cap");
        expect(dailyCap?.value).toContain("200");
        expect(dailyCap?.source).toContain("override");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when value is not a positive number", async () => {
    const aug = makeBudgetsAugment();
    await aug.onBoot?.();
    try {
      // Dispatcher does input coercion; admin handler can assume value is a parseable number string.
      // The handler itself validates positivity.
      const result = await aug.adminActions?.["budget-cap-adjust"]?.({ value: "-50" });
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("budgets adminActions — budget-cap-reset", () => {
  it("clears the override + restores yaml value", async () => {
    const aug = makeBudgetsAugment();
    await aug.onBoot?.();
    try {
      await aug.adminActions?.["budget-cap-adjust"]?.({ value: "200" });
      const overrideFile = join(tempDir, "admin-overrides.json");
      expect(JSON.parse(readFileSync(overrideFile, "utf8")).overrides.budgets.dailyBudgetUsd).toBe(200);

      const result = await aug.adminActions?.["budget-cap-reset"]?.({});
      expect(result?.ok).toBe(true);

      // dailyBudgetUsd should no longer be in the override file
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.budgets?.dailyBudgetUsd).toBeUndefined();

      // adminInfo now shows the yaml value (100)
      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const dailyCap = kv.rows.find((r) => r.label === "Daily budget cap");
        expect(dailyCap?.value).toContain("100");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test tests/augments/budgets-admin-info.test.ts`

Expected: FAIL — `adminInfo` and `adminActions` don't exist on the budgets augment yet.

- [ ] **Step 4: Add `agentDir` option + internal query methods to budgets**

In `src/augments/budgets/budget-store.ts`, add new methods (find an appropriate insertion point near the existing query statements):

```ts
// Add to BudgetStore interface + factory:

export interface BudgetStore {
  // ... existing methods
  getDaySpend(day?: string): Promise<{
    totalUsd: number;
    byPeer: Array<{ peerId: string; costUsd: number; turnCount: number }>;
  }>;
  setDailyBudgetUsd(value: number): void;
  resetDailyBudgetUsd(): void;
  getDailyBudgetUsdValue(): number;
  getDailyBudgetUsdSource(): "yaml" | "override";
}

// In createBudgetStore implementation:

function isoDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

// Capture initial value + a mutable closure-tracked override-source flag.
const initialDailyBudgetUsd = config.dailyBudgetUsd ?? Number.POSITIVE_INFINITY;
let currentDailyBudgetUsd = initialDailyBudgetUsd;
let dailyBudgetSource: "yaml" | "override" = "yaml";

// At construction: apply admin-overrides (if any)
if (config.agentDir) {
  const overrides = readOverrides(config.agentDir);
  if (overrides?.overrides.budgets?.dailyBudgetUsd !== undefined) {
    currentDailyBudgetUsd = overrides.overrides.budgets.dailyBudgetUsd;
    dailyBudgetSource = "override";
  }
}

// New methods:
async function getDaySpend(day = isoDay()): Promise<{ totalUsd: number; byPeer: ... }> {
  // 1) totalUsd from selectDailyTotalStmt
  // 2) byPeer: iterate peer_daily_costs WHERE day = ? — add a new prepared statement
  // (precise SQL depends on the existing schema; mirror selectDailyTotalStmt)
  const total = selectDailyTotalStmt.get(day) as { total_cost_usd: number } | undefined;
  const rows = db.query(
    "SELECT peer_id, cost_usd, unpriced_turns FROM peer_daily_costs WHERE day = ?"
  ).all(day) as Array<{ peer_id: string; cost_usd: number; unpriced_turns: number }>;
  return {
    totalUsd: total?.total_cost_usd ?? 0,
    byPeer: rows.map((r) => ({
      peerId: r.peer_id,
      costUsd: r.cost_usd,
      turnCount: r.unpriced_turns, // approximation; refine to count(*) if needed
    })),
  };
}

function setDailyBudgetUsd(value: number): void {
  currentDailyBudgetUsd = value;
  dailyBudgetSource = "override";
}

function resetDailyBudgetUsd(): void {
  currentDailyBudgetUsd = initialDailyBudgetUsd;
  dailyBudgetSource = "yaml";
}

function getDailyBudgetUsdValue(): number { return currentDailyBudgetUsd; }
function getDailyBudgetUsdSource(): "yaml" | "override" { return dailyBudgetSource; }

// The existing cap-evaluation logic must now read `currentDailyBudgetUsd` instead of
// the captured-at-init value. Find the daily-ceiling check and update its reference.
```

- [ ] **Step 5: Wire a ring buffer for recent budget events**

Still in `budget-store.ts` (or in `index.ts` if events are emitted there):

```ts
import { createRingBuffer } from "../../lib/ring-buffer";

interface BudgetEvent {
  timestamp: string;
  type: "budget.turn_admitted" | "budget.cap_denied" | "budget.committed";
  summary: string;
}

const events = createRingBuffer<BudgetEvent>(100);

function emitEvent(type: BudgetEvent["type"], summary: string): void {
  events.push({
    timestamp: new Date().toISOString().slice(11, 19),
    type,
    summary,
  });
}

// Call emitEvent in:
//   - prepare() when cap admits: emitEvent("budget.turn_admitted", `${peerId} $${cost}`)
//   - prepare() when cap denies: emitEvent("budget.cap_denied", `${peerId} hit ${capReason}`)
//   - commit() when finalized: emitEvent("budget.committed", `${peerId} $${cost}`)

function getRecentEvents(limit = 50): BudgetEvent[] {
  return events.snapshot().slice(-limit);
}
```

- [ ] **Step 6: Add `agentDir` option + override-write helpers to budgets/index.ts**

In `src/augments/budgets/index.ts`:

```ts
import { writeOverrides, readOverrides } from "../../lib/admin-overrides";
import type { AdminInfoBlock, AdminActionResult } from "../../types";

// Add to BudgetsConfig:
export interface BudgetsConfig {
  // ... existing fields
  agentDir?: string;
}

// Inside `budgets(config)` factory, add helpers + adminInfo + adminActions:

async function persistDailyBudgetOverride(value: number): Promise<void> {
  if (!config.agentDir) {
    throw new Error("agentDir not configured; admin overrides cannot persist");
  }
  const current = readOverrides(config.agentDir) ?? {
    version: 1 as const,
    lastModified: new Date().toISOString(),
    lastModifiedBy: "creator",
    overrides: {},
  };
  current.lastModified = new Date().toISOString();
  current.lastModifiedBy = "creator";
  current.overrides.budgets = {
    ...current.overrides.budgets,
    dailyBudgetUsd: value,
  };
  writeOverrides(config.agentDir, current);
}

async function clearDailyBudgetOverride(): Promise<void> {
  if (!config.agentDir) return;
  const current = readOverrides(config.agentDir);
  if (!current) return;
  if (current.overrides.budgets) {
    delete (current.overrides.budgets as Record<string, unknown>).dailyBudgetUsd;
    if (Object.keys(current.overrides.budgets).length === 0) {
      delete (current.overrides as Record<string, unknown>).budgets;
    }
  }
  current.lastModified = new Date().toISOString();
  current.lastModifiedBy = "creator";
  writeOverrides(config.agentDir, current);
}

async function adminInfo(): Promise<AdminInfoBlock> {
  const spend = await store.getDaySpend();
  const recentEvents = store.getRecentEvents(50);
  const cap = store.getDailyBudgetUsdValue();
  const source = store.getDailyBudgetUsdSource();

  return {
    augmentName: "budgets",
    title: "Budgets",
    sections: [
      {
        kind: "keyValue",
        rows: [
          {
            label: "Daily budget cap",
            value: cap === Number.POSITIVE_INFINITY ? "(unlimited)" : `$${cap.toFixed(2)}`,
            source: source === "override" ? "/admin override" : "yaml",
            ...(source === "override"
              ? { resetAction: { id: "budget-cap-reset", label: "Reset to yaml" } }
              : {}),
          },
          { label: "Today's spend", value: `$${spend.totalUsd.toFixed(2)}` },
        ],
      },
      {
        kind: "table",
        columns: ["Peer", "Today's cost", "Turns"],
        rows: spend.byPeer.slice(0, 50).map((p) => [
          p.peerId,
          `$${p.costUsd.toFixed(2)}`,
          String(p.turnCount),
        ]),
        caption:
          spend.byPeer.length > 50
            ? `Showing 50 of ${spend.byPeer.length} peers`
            : `${spend.byPeer.length} peer(s) with spend today`,
      },
      {
        kind: "eventStream",
        events: recentEvents,
        caption: "Last 50 budget events",
      },
    ],
    actions: [
      {
        id: "budget-cap-adjust",
        label: "Adjust daily budget cap",
        confirmRequired: true,
        inputs: [
          {
            name: "value",
            label: "New daily cap (USD)",
            type: "number",
            required: true,
            helpText: "Persists across restart via admin-overrides.json.",
          },
        ],
      },
    ],
  };
}

const adminActions = {
  "budget-cap-adjust": async (params: Record<string, string>): Promise<AdminActionResult> => {
    const value = Number(params.value);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, message: `invalid value: must be a positive number (got ${params.value})` };
    }
    try {
      await persistDailyBudgetOverride(value);
    } catch (err) {
      return {
        ok: false,
        message: `could not persist override: ${(err as Error).message}; agent state unchanged`,
      };
    }
    store.setDailyBudgetUsd(value);
    return { ok: true, message: `Daily budget cap updated to $${value.toFixed(2)}` };
  },
  "budget-cap-reset": async (): Promise<AdminActionResult> => {
    try {
      await clearDailyBudgetOverride();
    } catch (err) {
      return {
        ok: false,
        message: `could not clear override: ${(err as Error).message}`,
      };
    }
    store.resetDailyBudgetUsd();
    return { ok: true, message: "Daily budget cap reset to yaml value" };
  },
};

// Return augment shape:
return {
  name: "budgets",
  // ... existing fields
  adminInfo,
  adminActions,
};
```

- [ ] **Step 7: Run budgets-admin-info tests — expect pass**

Run: `bun test tests/augments/budgets-admin-info.test.ts`

Expected: PASS — 5 tests green (shape, action declaration, persist, validation, reset).

- [ ] **Step 8: Verify existing budgets tests still pass**

Run: `bun test tests/augments/budgets`

Expected: all green. Adding adminInfo / adminActions / new query methods should not affect existing prepare/commit/cap-evaluation behavior. If any test fails, the new `currentDailyBudgetUsd` closure mutation isn't being read by the cap-check path — fix that wiring.

- [ ] **Step 9: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/augments/budgets/ tests/augments/budgets-admin-info.test.ts
git commit -m "feat(budgets): adminInfo + budget-cap-adjust + budget-cap-reset (G36 phase 3)"
```

---

### Task 3.3: layered-memory adminInfo + memory-erase row action

**Files:**
- Modify: `src/augments/layered-memory/storage/sqlite-store.ts` (new `listEntriesByPeer` + `countByRetentionClass`)
- Modify: `src/augments/layered-memory/index.ts` (adminInfo + adminActions)
- Test: `tests/augments/layered-memory-admin-info.test.ts` (new)

- [ ] **Step 1: Survey + write failing tests**

```bash
grep -n "export function createSqliteStore\|export function layeredMemory" src/augments/layered-memory/index.ts src/augments/layered-memory/storage/sqlite-store.ts | head
```

Create `tests/augments/layered-memory-admin-info.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layeredMemory } from "@/augments/layered-memory";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-3-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMemoryAugment(): Augment {
  return layeredMemory({
    storage: { kind: "sqlite", path: join(tempDir, "memory.db") },
  });
}

describe("layered-memory adminInfo — shape", () => {
  it("returns a Memory block with KV (counts) + table (entries) + rowAction memory-erase", async () => {
    const aug = makeMemoryAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Memory");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      const table = info?.sections.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      if (table?.kind === "table") {
        expect(table.rowActions?.map((r) => r.id)).toContain("memory-erase");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("KV section reports retention-class counts", async () => {
    const aug = makeMemoryAugment();
    await aug.onBoot?.();
    try {
      // Write a couple of entries
      const memoryProvider = aug.memory!;
      // ... existing memory-write API; depends on the augment's memory contract.
      // For simplicity, query storage directly via known methods.
      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const labels = kv.rows.map((r) => r.label);
        expect(labels).toContain("Total entries");
        expect(labels).toContain("Operational");
        expect(labels).toContain("Lesson");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("layered-memory adminActions — memory-erase", () => {
  it("calls forget(peerId) and reports the count", async () => {
    const aug = makeMemoryAugment();
    await aug.onBoot?.();
    try {
      // The memory-erase handler invokes the underlying store.forget(peerId)
      // and returns an AdminActionResult with the count.
      const result = await aug.adminActions?.["memory-erase"]?.({
        rowKey: "vis_test_peer",
      });
      expect(result?.ok).toBe(true);
      // Even when no entries existed, forget returns 0 and the action reports
      // "Erased 0 entries" — the action's job is just to invoke forget.
      expect(result?.message).toMatch(/erased/i);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when rowKey is missing", async () => {
    const aug = makeMemoryAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["memory-erase"]?.({});
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `bun test tests/augments/layered-memory-admin-info.test.ts`

Expected: FAIL — adminInfo/adminActions don't exist on layered-memory yet.

- [ ] **Step 3: Add `listEntriesByPeer` + `countByRetentionClass` to sqlite-store**

In `src/augments/layered-memory/storage/sqlite-store.ts`, add methods to the store interface + implementation. The exact SQL depends on the existing schema; below is a template:

```ts
// In MemoryStore interface:
export interface MemoryStore {
  // ... existing methods
  listEntriesByPeer(opts?: { peerId?: string; limit?: number }): Promise<StoreEntry[]>;
  countByRetentionClass(): Promise<{ operational: number; lesson: number; total: number }>;
}

// Implementation:
function listEntriesByPeer(opts: { peerId?: string; limit?: number } = {}): StoreEntry[] {
  const limit = opts.limit ?? 50;
  if (opts.peerId) {
    return db.query(
      `SELECT id, label, content, peer_id, trust_level, created_at, retention_class, is_verbatim
       FROM entries
       WHERE peer_id = ? AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(opts.peerId, Date.now(), limit) as StoreEntry[];
  }
  return db.query(
    `SELECT id, label, content, peer_id, trust_level, created_at, retention_class, is_verbatim
     FROM entries
     WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(Date.now(), limit) as StoreEntry[];
}

function countByRetentionClass(): { operational: number; lesson: number; total: number } {
  const rows = db.query(
    `SELECT retention_class, COUNT(*) AS n
     FROM entries
     WHERE superseded_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
     GROUP BY retention_class`,
  ).all(Date.now()) as Array<{ retention_class: string; n: number }>;
  let operational = 0;
  let lesson = 0;
  for (const r of rows) {
    if (r.retention_class === "operational") operational = r.n;
    if (r.retention_class === "lesson") lesson = r.n;
  }
  return { operational, lesson, total: operational + lesson };
}
```

(Note: the exact column names / table names depend on the current schema. The grep in Step 1 should reveal them.)

- [ ] **Step 4: Add `adminInfo` + `adminActions` to layered-memory's augment**

In `src/augments/layered-memory/index.ts`:

```ts
async function adminInfo(): Promise<AdminInfoBlock> {
  const counts = await store.countByRetentionClass();
  const entries = await store.listEntriesByPeer({ limit: 50 });

  return {
    augmentName: "layered-memory",
    title: "Memory",
    sections: [
      {
        kind: "keyValue",
        rows: [
          { label: "Total entries", value: String(counts.total) },
          { label: "Operational", value: String(counts.operational) },
          { label: "Lesson", value: String(counts.lesson) },
        ],
      },
      {
        kind: "table",
        columns: ["Peer", "Label", "Content (snippet)", "Retention", "Age"],
        rows: entries.map((e) => [
          e.peer_id ?? "(no peer)",
          e.label,
          (e.content ?? "").slice(0, 80),
          e.retention_class ?? "operational",
          formatAge(e.created_at),
        ]),
        rowActions: [
          {
            id: "memory-erase",
            label: "Erase peer",
            confirmRequired: true,
            rowKeyColumn: 0,
          },
        ],
        caption: `Showing ${entries.length} most recent entries`,
      },
    ],
  };
}

const adminActions = {
  "memory-erase": async (params: Record<string, string>): Promise<AdminActionResult> => {
    if (!params.rowKey) {
      return { ok: false, message: "memory-erase requires a rowKey (peer id)" };
    }
    const erased = await store.forget(params.rowKey);
    return { ok: true, message: `Erased ${erased} entries for ${params.rowKey}` };
  },
};

function formatAge(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
```

Wire `adminInfo` + `adminActions` into the returned augment object.

- [ ] **Step 5: Run tests — expect pass**

Run: `bun test tests/augments/layered-memory-admin-info.test.ts`

Expected: PASS — 4 tests green.

- [ ] **Step 6: Verify existing layered-memory tests still pass**

Run: `bun test tests/augments/layered-memory`

Expected: all green.

- [ ] **Step 7: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/augments/layered-memory/ tests/augments/layered-memory-admin-info.test.ts
git commit -m "feat(layered-memory): adminInfo + memory-erase row action (G36 phase 3)"
```

---

### Task 3.4: notify adminInfo + notify-test + notify-cap-adjust + notify-cap-reset

**Files:**
- Modify: `src/augments/notify/index.ts`
- Test: `tests/augments/notify-admin-info.test.ts` (new)

`notify` is the most action-heavy: 3 actions (test + adjust + reset). Internal additions: ring buffer for dispatches, setGlobalMaxPerHour/reset, internal "test" dispatch path that bypasses rate-limit + dedup.

- [ ] **Step 1: Survey + write failing tests**

```bash
grep -n "globalMaxPerHour\|globalCount\|export function notify" src/augments/notify/index.ts | head -20
```

Create `tests/augments/notify-admin-info.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "@/augments/notify";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-4-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeNotifyAugment(extraConfig: Record<string, unknown> = {}): Augment {
  return notify({
    destinations: [
      {
        name: "test-webhook",
        transport: "webhook",
        url: "http://127.0.0.1:1/test", // unreachable; failure path acceptable for shape tests
      },
    ],
    globalMaxPerHour: 5,
    agentDir: tempDir,
    ...extraConfig,
  });
}

describe("notify adminInfo — shape", () => {
  it("returns a Notify block with KV + table + 3 actions", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Notify");
      const actionIds = (info?.actions ?? []).map((a) => a.id);
      expect(actionIds).toContain("notify-test");
      expect(actionIds).toContain("notify-cap-adjust");
      // notify-cap-reset only appears as a resetAction on the keyValue row when overridden;
      // it's registered in adminActions regardless.
      expect(aug.adminActions?.["notify-cap-reset"]).toBeDefined();
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("notify adminActions — notify-test", () => {
  it("dispatches a test notification (bypass rate-limit + dedup)", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      // First call would normally be allowed; the test exercises the "test" path
      // which sets adapter.test = true (or similar marker) — adapter sees the flag.
      // For shape-only test, just verify the handler returns a result (might fail to send because URL is unreachable).
      const result = await aug.adminActions?.["notify-test"]?.({
        destination: "test-webhook",
        message: "from test suite",
      });
      expect(result).toBeDefined();
      // The dispatch may fail (unreachable URL) — both ok and ok=false are acceptable,
      // but the handler MUST return a result, not throw.
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when destination is unknown", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["notify-test"]?.({
        destination: "nonexistent",
        message: "x",
      });
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("notify adminActions — notify-cap-adjust + reset", () => {
  it("persists globalMaxPerHour and reflects in adminInfo", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "10" });
      expect(result?.ok).toBe(true);
      const parsed = JSON.parse(readFileSync(join(tempDir, "admin-overrides.json"), "utf8"));
      expect(parsed.overrides.notify.globalMaxPerHour).toBe(10);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("notify-cap-reset clears the override", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      await aug.adminActions?.["notify-cap-adjust"]?.({ value: "10" });
      const result = await aug.adminActions?.["notify-cap-reset"]?.({});
      expect(result?.ok).toBe(true);
      const parsed = JSON.parse(readFileSync(join(tempDir, "admin-overrides.json"), "utf8"));
      expect(parsed.overrides.notify?.globalMaxPerHour).toBeUndefined();
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("rejects negative or zero values", async () => {
    const aug = makeNotifyAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "-1" });
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `bun test tests/augments/notify-admin-info.test.ts`

Expected: FAIL — adminInfo/adminActions missing.

- [ ] **Step 3: Implement notify additions in `src/augments/notify/index.ts`**

Pattern mirrors budgets:

```ts
import { createRingBuffer } from "../../lib/ring-buffer";
import { readOverrides, writeOverrides } from "../../lib/admin-overrides";
import type { AdminInfoBlock, AdminActionResult } from "../../types";

export interface NotifyConfig {
  // ... existing fields
  agentDir?: string;
  globalMaxPerHour?: number;
}

export function notify(config: NotifyConfig): Augment {
  // ... existing state (peerLastNotify, recentSummaries, globalCountThisHour, ...)

  const initialGlobalMaxPerHour = config.globalMaxPerHour ?? 5;
  let currentGlobalMaxPerHour = initialGlobalMaxPerHour;
  let globalMaxSource: "yaml" | "override" = "yaml";

  // Apply admin-overrides at boot
  if (config.agentDir) {
    const overrides = readOverrides(config.agentDir);
    if (overrides?.overrides.notify?.globalMaxPerHour !== undefined) {
      currentGlobalMaxPerHour = overrides.overrides.notify.globalMaxPerHour;
      globalMaxSource = "override";
    }
  }

  // Ring buffer for recent dispatches
  interface DispatchRecord {
    timestamp: string;
    destination: string;
    status: "sent" | "rate_limited" | "failed";
    summary: string;
  }
  const dispatches = createRingBuffer<DispatchRecord>(100);

  function recordDispatch(record: DispatchRecord): void {
    dispatches.push(record);
  }

  // The existing rate-limit check should read `currentGlobalMaxPerHour` instead
  // of the captured-at-init value. Find that check + update its reference.

  // Internal test-dispatch path (bypasses rate-limit + dedup):
  async function dispatchTest(
    destinationName: string,
    summary: string,
  ): Promise<{ status: "sent" | "failed"; detail?: string }> {
    const dest = config.destinations.find((d) => d.name === destinationName);
    if (!dest) {
      return { status: "failed", detail: `unknown destination: ${destinationName}` };
    }
    try {
      // Call the adapter's deliver method directly; mark it as a test if the adapter
      // supports the flag (webhook adapter could add `?test=1` query, telegram could
      // prefix "[test] " etc — adapter-specific). For v1.0, the test path is
      // operator-flagged in the audit log only.
      const adapter = getAdapter(dest); // existing factory
      await adapter.deliver(dest, { summary, test: true });
      return { status: "sent" };
    } catch (err) {
      return { status: "failed", detail: (err as Error).message };
    }
  }

  // Persistence helpers (mirror webTransport + budgets pattern):
  async function persistNotifyOverride(value: number): Promise<void> {
    if (!config.agentDir) throw new Error("agentDir not configured");
    const current = readOverrides(config.agentDir) ?? {
      version: 1 as const,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {},
    };
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    current.overrides.notify = {
      ...current.overrides.notify,
      globalMaxPerHour: value,
    };
    writeOverrides(config.agentDir, current);
  }
  async function clearNotifyOverride(): Promise<void> {
    if (!config.agentDir) return;
    const current = readOverrides(config.agentDir);
    if (!current) return;
    if (current.overrides.notify) {
      delete (current.overrides.notify as Record<string, unknown>).globalMaxPerHour;
      if (Object.keys(current.overrides.notify).length === 0) {
        delete (current.overrides as Record<string, unknown>).notify;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(config.agentDir, current);
  }

  function setGlobalMaxPerHour(value: number): void {
    currentGlobalMaxPerHour = value;
    globalMaxSource = "override";
  }
  function resetGlobalMaxPerHour(): void {
    currentGlobalMaxPerHour = initialGlobalMaxPerHour;
    globalMaxSource = "yaml";
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const recentEvents = dispatches.snapshot().slice(-50);
    return {
      augmentName: "notify",
      title: "Notify",
      sections: [
        {
          kind: "keyValue",
          rows: [
            {
              label: "Global cap per hour",
              value: String(currentGlobalMaxPerHour),
              source: globalMaxSource === "override" ? "/admin override" : "yaml",
              ...(globalMaxSource === "override"
                ? { resetAction: { id: "notify-cap-reset", label: "Reset to yaml" } }
                : {}),
            },
            {
              label: "Cooldown (ms)",
              value: String(config.cooldownMs ?? 120_000),
              source: "yaml",
            },
          ],
        },
        {
          kind: "table",
          columns: ["Time", "Destination", "Status", "Summary"],
          rows: recentEvents.map((e) => [
            e.timestamp,
            e.destination,
            e.status,
            e.summary.slice(0, 80),
          ]),
          caption: "Recent dispatches",
        },
      ],
      actions: [
        {
          id: "notify-test",
          label: "Send test notification",
          confirmRequired: false,
          inputs: [
            { name: "destination", label: "Destination name", type: "text", required: true },
            {
              name: "message",
              label: "Message",
              type: "text",
              required: false,
              default: "Test from /admin",
            },
          ],
        },
        {
          id: "notify-cap-adjust",
          label: "Adjust globalMaxPerHour",
          confirmRequired: true,
          inputs: [
            { name: "value", label: "New value", type: "number", required: true },
          ],
        },
      ],
    };
  }

  const adminActions = {
    "notify-test": async (params: Record<string, string>): Promise<AdminActionResult> => {
      const dest = params.destination ?? "";
      const message = params.message || "Test from /admin";
      if (!dest) {
        return { ok: false, message: "destination is required" };
      }
      const result = await dispatchTest(dest, message);
      recordDispatch({
        timestamp: new Date().toISOString().slice(11, 19),
        destination: dest,
        status: result.status,
        summary: `[test] ${message}`,
      });
      if (result.status === "sent") {
        return { ok: true, message: `Test notification sent to ${dest}` };
      }
      return { ok: false, message: `Test failed: ${result.detail ?? "unknown error"}` };
    },
    "notify-cap-adjust": async (params: Record<string, string>): Promise<AdminActionResult> => {
      const value = Number(params.value);
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        return { ok: false, message: `invalid value: must be a positive integer (got ${params.value})` };
      }
      try {
        await persistNotifyOverride(value);
      } catch (err) {
        return { ok: false, message: `could not persist override: ${(err as Error).message}` };
      }
      setGlobalMaxPerHour(value);
      return { ok: true, message: `globalMaxPerHour set to ${value}` };
    },
    "notify-cap-reset": async (): Promise<AdminActionResult> => {
      try {
        await clearNotifyOverride();
      } catch (err) {
        return { ok: false, message: `could not clear override: ${(err as Error).message}` };
      }
      resetGlobalMaxPerHour();
      return { ok: true, message: "globalMaxPerHour reset to yaml value" };
    },
  };

  return {
    name: "notify",
    // ... existing fields
    adminInfo,
    adminActions,
  };
}
```

- [ ] **Step 4: Run notify-admin-info tests — expect pass**

Run: `bun test tests/augments/notify-admin-info.test.ts`

Expected: PASS — 5 tests green.

- [ ] **Step 5: Verify existing notify tests still pass**

Run: `bun test tests/augments/notify`

Expected: all green.

- [ ] **Step 6: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/augments/notify/ tests/augments/notify-admin-info.test.ts
git commit -m "feat(notify): adminInfo + notify-test + cap-adjust + cap-reset (G36 phase 3)"
```

---

### Task 3.5: visitor-auth adminInfo + visitor-revoke row action

**Files:**
- Modify: `src/augments/visitor-auth/storage/*` (add `listVerifiedVisitors`)
- Modify: `src/augments/visitor-auth/index.ts` (adminInfo + adminActions)
- Test: `tests/augments/visitor-auth-admin-info.test.ts` (new)

- [ ] **Step 1: Survey + write failing tests**

```bash
ls src/augments/visitor-auth/storage/
grep -n "export function visitorAuth\|revocationCheck\|verifiedVisitor" src/augments/visitor-auth/index.ts | head
```

Create `tests/augments/visitor-auth-admin-info.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "@/augments/visitor-auth";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-5-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeVisitorAuthAugment(): Augment {
  return visitorAuth({
    storage: { kind: "sqlite", path: join(tempDir, "visitor-auth.db") },
    signingKey: "test-signing-key",
    agentBinding: "test-agent",
    agentMail: { transport: "console" },
  });
}

describe("visitor-auth adminInfo — shape", () => {
  it("returns a Visitors block with KV + status + table + rowAction visitor-revoke", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Visitors");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      const table = info?.sections.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      if (table?.kind === "table") {
        expect(table.rowActions?.map((r) => r.id)).toContain("visitor-revoke");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("status section warns when mail transport is console", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      const status = info?.sections.find((s) => s.kind === "status");
      expect(status?.kind).toBe("status");
      if (status?.kind === "status") {
        // The exact level depends on NODE_ENV — production+console = warn,
        // dev+console = ok or info. Verify at least that mail-transport info appears.
        expect(status.message.toLowerCase()).toContain("console");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("visitor-auth adminActions — visitor-revoke", () => {
  it("calls the revocation store and reports the result", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["visitor-revoke"]?.({
        rowKey: "vis_test_peer",
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toMatch(/revoked/i);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when rowKey is missing", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["visitor-revoke"]?.({});
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `bun test tests/augments/visitor-auth-admin-info.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add `listVerifiedVisitors` to visitor-auth storage**

In `src/augments/visitor-auth/storage/<store-file>.ts` (file name depends on layout; survey Step 1 output):

```ts
export interface VisitorAuthStore {
  // ... existing methods
  listVerifiedVisitors(limit?: number): Promise<Array<{
    peerId: string;
    email?: string;
    verifiedAt: number;
  }>>;
  revokeVisitor(peerId: string): Promise<boolean>;
}

// Implementation (exact SQL depends on the schema):
function listVerifiedVisitors(limit = 50): Array<{ peerId: string; email?: string; verifiedAt: number }> {
  return db.query(
    `SELECT peer_id, email, verified_at
     FROM verified_visitors
     WHERE revoked_at IS NULL
     ORDER BY verified_at DESC
     LIMIT ?`,
  ).all(limit) as Array<{ peer_id: string; email?: string; verified_at: number }>;
}

function revokeVisitor(peerId: string): boolean {
  const r = db.query(
    `UPDATE verified_visitors SET revoked_at = ? WHERE peer_id = ? AND revoked_at IS NULL`,
  ).run(Date.now(), peerId);
  return r.changes > 0;
}
```

If a `verified_visitors` table doesn't exist (current schema may use a different name), adapt to the actual table — the Step 1 survey reveals it.

- [ ] **Step 4: Add `adminInfo` + `adminActions` to visitor-auth augment**

In `src/augments/visitor-auth/index.ts`:

```ts
async function adminInfo(): Promise<AdminInfoBlock> {
  const visitors = await store.listVerifiedVisitors(50);
  const isProd = process.env.NODE_ENV === "production";
  const consoleInProd = config.agentMail?.transport === "console" && isProd;

  return {
    augmentName: "visitor-auth",
    title: "Visitors",
    sections: [
      {
        kind: "keyValue",
        rows: [
          {
            label: "Mail transport",
            value: config.agentMail?.transport ?? "(unset)",
            source: "yaml",
          },
          {
            label: "Active inbox",
            value: config.agentMail?.inboxId ?? "(unset)",
          },
        ],
      },
      {
        kind: "status",
        level: consoleInProd ? "warn" : "ok",
        message: consoleInProd
          ? "Mail transport is 'console' in production — magic links print to stdout. Switch to 'agentmail' for production deployments."
          : `Mail transport is '${config.agentMail?.transport ?? "unset"}'.`,
      },
      {
        kind: "table",
        columns: ["Peer ID", "Email", "Verified at"],
        rows: visitors.map((v) => [
          v.peerId,
          v.email ?? "(no email)",
          new Date(v.verifiedAt).toISOString(),
        ]),
        rowActions: [
          {
            id: "visitor-revoke",
            label: "Revoke",
            confirmRequired: true,
            rowKeyColumn: 0,
          },
        ],
        caption: `Showing ${visitors.length} verified visitor(s)`,
      },
    ],
  };
}

const adminActions = {
  "visitor-revoke": async (params: Record<string, string>): Promise<AdminActionResult> => {
    if (!params.rowKey) {
      return { ok: false, message: "visitor-revoke requires a rowKey (peer id)" };
    }
    const revoked = await store.revokeVisitor(params.rowKey);
    if (!revoked) {
      return { ok: false, message: `visitor ${params.rowKey} not found or already revoked` };
    }
    return { ok: true, message: `Revoked ${params.rowKey}` };
  },
};

return {
  name: "visitor-auth",
  // ... existing fields
  adminInfo,
  adminActions,
};
```

- [ ] **Step 5: Run tests — expect pass**

Run: `bun test tests/augments/visitor-auth-admin-info.test.ts`

Expected: PASS — 4 tests green.

- [ ] **Step 6: Verify existing visitor-auth tests still pass**

Run: `bun test tests/augments/visitor-auth`

Expected: all green.

- [ ] **Step 7: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/augments/visitor-auth/ tests/augments/visitor-auth-admin-info.test.ts
git commit -m "feat(visitor-auth): adminInfo + visitor-revoke row action (G36 phase 3)"
```

---

## Phase 3 — End-of-phase verification

After all 5 tasks complete:

- [ ] **Full test suite**: `bun test` — should add ~25-35 new tests on top of Phase 2's 2095.
- [ ] **Typecheck**: `bunx tsc --noEmit` — clean.
- [ ] **Lint**: `bun run lint` — 0 errors, baseline preserved.
- [ ] **Manual integration smoke (most valuable verification)**: scaffold an agent with all 5 augments mounted, hit `/admin`, click through each action, verify:
  - Dashboard renders all 5 augment blocks
  - All 9 actions visible and clickable
  - Notify test action actually dispatches (use a webhook.site URL or local mock)
  - Memory-erase actually erases entries for a specific peer
  - Budget-cap-adjust actually persists + applies
  - Posture-flip actually changes runtime behavior (re-test that anonymous traffic gets through)
  - All reset actions clear the override + restore yaml values

## Phase 3 → Phase 4 handoff

After Phase 3 lands:
- 5 commits on the Phase 3 branch
- `/admin` dashboard renders 5 augment blocks with 9 actions
- Persistence layer fully exercised (3 knobs persist across restart)
- Audit log lines appear for every action

Phase 4 (docs + verification + final PR):
- Update `docs/06-transports.md` with the `/admin` section
- Run the spec's acceptance-criteria manual smokes
- Adversarial-review pass on the diff (`/codex:adversarial-review`)
- Open the v1.0-G36 PR against main, enable auto-merge

## Out-of-plan / known limits for Phase 3

- **Test mocks for augments without a real DB connection** — budgets + layered-memory + visitor-auth tests construct real SQLite instances in tempdir. This is slower than mocking the store but exercises the actual SQL paths. Trade-off accepted.
- **Notify-test adapter integration** — the test path's "destination unreachable" case is acceptable for unit tests. Real adapter calls are exercised in the existing notify tests + the Phase 3 manual smoke.
- **Visitor-revoke recovery** — once revoked, a visitor cannot un-revoke from /admin. Re-verification via magic-link is the path. (Out of scope for v1.0.)
- **No live updates** — dashboard requires page refresh. Phase 3 ships polled; the future Tier-2 telemetry pipeline can swap this for live event streams.
- **No pagination** — tables cap at 50 rows. Operators with more than 50 peers / entries see only the most recent. Pagination is a future feature.
- **Action audit log via console.log only** — no dedicated audit file. Deferred per spec.

## Risks + open questions for Phase 3

- **Risk: budgets cap-check wiring**. The new `currentDailyBudgetUsd` closure must be read by the existing cap-evaluation path. If the existing code captured the value at init time, the override won't take effect until restart. Mitigation: explicit unit test in budgets-admin-info confirming a flip + a subsequent prepare() respects the new cap. If not exercised by existing tests, add one.
- **Risk: visitor-auth schema mismatch**. The plan assumes a `verified_visitors` table. If the actual schema differs, Task 3.5 Step 3 SQL needs adjustment. Survey (Step 1) reveals the real schema before the test runs.
- **Risk: notify-test adapter flag**. The adapter API may not have a `test` flag. The Phase 3 implementation logs the audit-line marker; real adapter-side test handling is a Tier-2 follow-up.
- **Open: should webTransport's adminInfo include a "Last anonymous turn" timestamp** to help operators audit what posture currently allows? Deferred — single data point, adds complexity.
- **Open: should memory-erase support "all peers" (no rowKey)?** No — too easy to accidentally wipe everything. Per-peer only.

# G36 Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four foundational pieces that the G36 admin module depends on: a shared ring-buffer utility, the `AdminInfoBlock`/`AdminSection`/`AdminAction` type contract, the `admin-overrides.json` persistence module, and an `isLoopback()` helper.

**Architecture:** All four are leaf-level utilities (no cross-augment dependencies). They land in `src/lib/` (ring-buffer, admin-overrides), `src/types.ts` (the contract types), and `src/transports/web-transport.ts` (isLoopback as a new exported helper). Each is independently testable; together they unblock Phase 2 (the admin module).

**Tech Stack:** TypeScript / Bun runtime / `bun:test` / Zod (for the override-file schema; Zod is already a project dependency, see `tests/transports/web-transport.test.ts:2`).

**Spec reference:** `docs/superpowers/specs/2026-05-19-g36-admin-route-design.md` (local-only).

**Branch:** `feat/g36-admin-route` (already checked out off main).

---

## File Structure (Phase 1)

| File | Status | Responsibility |
|---|---|---|
| `src/lib/ring-buffer.ts` | **new** | Bounded ring buffer with `push`/`snapshot`/`clear`. Reused by budgets/layered-memory/notify in Phase 3 for their recent-events tracking. |
| `src/lib/admin-overrides.ts` | **new** | Read/write `~/.auggy/<agent>/admin-overrides.json` with Zod-validated schema, atomic rename + 0o600, per-field validation logging. |
| `src/types.ts` | modified | Add `AdminInfoBlock`, `AdminSection` union, `AdminAction`, `AdminActionInput`, `AdminRowAction`, `AdminActionResult`, `AdminActionHandler` types. Add optional `adminInfo?` and `adminActions?` fields on `Augment`. |
| `src/transports/web-transport.ts` | modified | Export `isLoopback(ip: string): boolean` for `127.0.0.0/8` + `::1`. (No dispatch changes yet — Phase 2 does that.) |
| `tests/lib/ring-buffer.test.ts` | **new** | Push, snapshot, eviction, boundedness. |
| `tests/lib/admin-overrides.test.ts` | **new** | Round-trip, atomic write, 0o600, corrupt-file fallback, per-field validation warning, missing-agentDir fallback. |
| `tests/transports/web-transport.test.ts` | modified | Add unit tests for `isLoopback`. |

---

### Task 1.1: Ring-buffer utility

**Files:**
- Create: `src/lib/ring-buffer.ts`
- Test: `tests/lib/ring-buffer.test.ts`

Bounded FIFO buffer. Push evicts oldest when full. Snapshot returns array copy in insertion order. Forward-compat shape: when telemetry pipeline lands (Tier-2), it can wrap this with the same `push/snapshot` API.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/ring-buffer.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createRingBuffer } from "@/lib/ring-buffer";

describe("ring-buffer", () => {
  it("starts empty", () => {
    const rb = createRingBuffer<number>(3);
    expect(rb.snapshot()).toEqual([]);
  });

  it("push then snapshot returns items in insertion order", () => {
    const rb = createRingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.snapshot()).toEqual([1, 2, 3]);
  });

  it("evicts oldest when capacity exceeded", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.snapshot()).toEqual([2, 3, 4]);
  });

  it("evicts multiple oldest when pushing many over capacity", () => {
    const rb = createRingBuffer<number>(2);
    [1, 2, 3, 4, 5, 6].forEach((n) => rb.push(n));
    expect(rb.snapshot()).toEqual([5, 6]);
  });

  it("snapshot returns a copy — mutations to the returned array don't affect the buffer", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    const snap = rb.snapshot();
    snap.push(99);
    expect(rb.snapshot()).toEqual([1, 2]);
  });

  it("clear empties the buffer", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.snapshot()).toEqual([]);
    rb.push(3);
    expect(rb.snapshot()).toEqual([3]);
  });

  it("works with object types", () => {
    const rb = createRingBuffer<{ id: string }>(2);
    rb.push({ id: "a" });
    rb.push({ id: "b" });
    rb.push({ id: "c" });
    expect(rb.snapshot().map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("throws on non-positive maxSize", () => {
    expect(() => createRingBuffer<number>(0)).toThrow();
    expect(() => createRingBuffer<number>(-1)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/lib/ring-buffer.test.ts`

Expected: FAIL with `Cannot find module '@/lib/ring-buffer'`.

- [ ] **Step 3: Implement ring-buffer**

Create `src/lib/ring-buffer.ts`:

```ts
/**
 * Bounded FIFO buffer used by augments for recent-events tracking.
 * Forward-compat shape: when the Tier-2 telemetry pipeline lands, the same
 * push/snapshot API can be backed by a kernel-level event bus consumer
 * without changing the augment's call sites.
 */
export interface RingBuffer<T> {
  push(item: T): void;
  snapshot(): T[];
  clear(): void;
}

export function createRingBuffer<T>(maxSize: number): RingBuffer<T> {
  if (maxSize <= 0) {
    throw new Error(`createRingBuffer: maxSize must be > 0 (got ${maxSize})`);
  }
  let items: T[] = [];

  return {
    push(item: T): void {
      items.push(item);
      if (items.length > maxSize) {
        items = items.slice(items.length - maxSize);
      }
    },
    snapshot(): T[] {
      return items.slice();
    },
    clear(): void {
      items = [];
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/lib/ring-buffer.test.ts`

Expected: PASS — 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ring-buffer.ts tests/lib/ring-buffer.test.ts
git commit -m "feat(lib): add shared ring-buffer utility (G36 phase 1)"
```

---

### Task 1.2: Admin contract types

**Files:**
- Modify: `src/types.ts`
- Test: typecheck only (no runtime test file — these are type definitions)

Adds the typed contract that augments and the admin module agree on. No runtime behavior; the test is that TypeScript compiles cleanly with the new types and that augments can declare `adminInfo` without errors.

- [ ] **Step 1: Add types to `src/types.ts`**

Open `src/types.ts`. Locate the `Augment` interface declaration (search: `export interface Augment`). Just BEFORE the `export interface Augment {` line, INSERT these declarations:

```ts
// ===========================================================================
// G36 — Admin route contract (built into webTransport; see
// docs/superpowers/specs/2026-05-19-g36-admin-route-design.md)
// ===========================================================================

/** A typed render block for an augment's section on /admin. */
export interface AdminInfoBlock {
  /** Stable identifier; used in audit logs + action dispatch. */
  augmentName: string;
  /** Human-readable heading. */
  title: string;
  /** Ordered sections rendered in the block. */
  sections: AdminSection[];
  /** Optional augment-level actions (rendered as forms at the bottom). */
  actions?: AdminAction[];
}

/** Section variants. The four primitives v1.0 supports. */
export type AdminSection =
  | {
      kind: "keyValue";
      rows: Array<{
        label: string;
        value: string;
        /** Optional annotation, e.g. "source: yaml". */
        source?: string;
        /** Optional reset-to-yaml affordance for rows with /admin-override source. */
        resetAction?: { id: string; label: string };
      }>;
    }
  | {
      kind: "table";
      columns: string[];
      rows: string[][];
      /** Optional per-row buttons. */
      rowActions?: AdminRowAction[];
      /** Optional caption (e.g., "Showing 50 of 234"). */
      caption?: string;
    }
  | {
      kind: "status";
      level: "ok" | "warn" | "error";
      message: string;
    }
  | {
      kind: "eventStream";
      events: Array<{ timestamp: string; type: string; summary: string }>;
      caption?: string;
    };

/** Augment-level action (rendered as a form). */
export interface AdminAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  inputs?: AdminActionInput[];
}

/** Form input declaration on an AdminAction. */
export interface AdminActionInput {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  required: boolean;
  default?: string;
  helpText?: string;
}

/** Per-row action button (rendered next to each row in a table section). */
export interface AdminRowAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  /** Which column's value to pass as `rowKey` to the action handler. */
  rowKeyColumn: number;
}

/** Result returned by an AdminActionHandler. */
export interface AdminActionResult {
  ok: boolean;
  /** Human-readable message displayed as flash on the redirected admin page. */
  message: string;
}

/**
 * Handler signature for adminActions[id]. The dispatcher coerces form inputs
 * to declared types (string/number/boolean) before calling the handler, so
 * params arrive typed-string but the handler can assume coercion succeeded.
 * For row actions, the rowKey is delivered in params under the key "rowKey".
 */
export type AdminActionHandler = (
  params: Record<string, string>,
) => Promise<AdminActionResult>;
```

Then, INSIDE the existing `Augment` interface (find `export interface Augment {`), ADD these two optional fields anywhere in the interface body near the other optional augment surface fields:

```ts
  /** G36 — optional admin dashboard block + actions. */
  adminInfo?: () => Promise<AdminInfoBlock>;
  adminActions?: Record<string, AdminActionHandler>;
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS — no errors. Types compile cleanly.

- [ ] **Step 3: Run the full test suite to catch any incidental breakage**

Run: `bun test`

Expected: All existing tests pass (~2012). No new tests added in this task.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add AdminInfoBlock contract for G36 (phase 1)"
```

---

### Task 1.3: admin-overrides persistence module

**Files:**
- Create: `src/lib/admin-overrides.ts`
- Test: `tests/lib/admin-overrides.test.ts`

Reads + writes the override file with Zod-validated schema, atomic rename, 0o600 file mode, per-field validation logging, and silent fallback when agentDir is unset.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/admin-overrides.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readOverrides,
  writeOverrides,
  type AdminOverrides,
} from "@/lib/admin-overrides";

function makeTempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "auggy-admin-overrides-test-"));
}

function makeOverrides(partial: Partial<AdminOverrides["overrides"]> = {}): AdminOverrides {
  return {
    version: 1,
    lastModified: new Date().toISOString(),
    lastModifiedBy: "creator",
    overrides: partial,
  };
}

describe("admin-overrides — read", () => {
  it("returns null when agentDir is undefined", () => {
    expect(readOverrides(undefined)).toBeNull();
  });

  it("returns null when agentDir does not exist", () => {
    expect(readOverrides("/nonexistent/path/should/not/exist")).toBeNull();
  });

  it("returns null when admin-overrides.json does not exist", () => {
    const dir = makeTempAgentDir();
    try {
      expect(readOverrides(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a valid overrides file", () => {
    const dir = makeTempAgentDir();
    try {
      const sample = makeOverrides({ budgets: { dailyBudgetUsd: 30 } });
      writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(sample));
      const read = readOverrides(dir);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null + warns on corrupt JSON", () => {
    const dir = makeTempAgentDir();
    const warn = spyOn(console, "warn");
    try {
      writeFileSync(join(dir, "admin-overrides.json"), "{not valid json");
      expect(readOverrides(dir)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      warn.mockRestore();
    }
  });

  it("returns null + warns per-field on schema mismatch", () => {
    const dir = makeTempAgentDir();
    const warn = spyOn(console, "warn");
    try {
      const bad = {
        version: 1,
        lastModified: new Date().toISOString(),
        lastModifiedBy: "creator",
        overrides: {
          budgets: { dailyBudgetUsd: "thirty" }, // wrong type
        },
      };
      writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(bad));
      expect(readOverrides(dir)).toBeNull();
      // Per-field warning fired with the field path
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("overrides.budgets.dailyBudgetUsd"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      warn.mockRestore();
    }
  });
});

describe("admin-overrides — write", () => {
  it("writes a valid overrides file", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides({ notify: { globalMaxPerHour: 10 } }));
      const path = join(dir, "admin-overrides.json");
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.overrides.notify.globalMaxPerHour).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes with 0o600 file mode", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides());
      const path = join(dir, "admin-overrides.json");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write then read round-trips", () => {
    const dir = makeTempAgentDir();
    try {
      const original = makeOverrides({
        webTransport: { allowAnonymous: false },
        budgets: { dailyBudgetUsd: 25.5 },
        notify: { globalMaxPerHour: 7 },
      });
      writeOverrides(dir, original);
      const read = readOverrides(dir);
      expect(read?.overrides.webTransport?.allowAnonymous).toBe(false);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(25.5);
      expect(read?.overrides.notify?.globalMaxPerHour).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomic rename: no .tmp file remains after a successful write", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides());
      const tmpFiles = require("fs").readdirSync(dir).filter((f: string) => f.includes(".tmp"));
      expect(tmpFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrite replaces previous content", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides({ budgets: { dailyBudgetUsd: 10 } }));
      writeOverrides(dir, makeOverrides({ budgets: { dailyBudgetUsd: 99 } }));
      const read = readOverrides(dir);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/lib/admin-overrides.test.ts`

Expected: FAIL with `Cannot find module '@/lib/admin-overrides'`.

- [ ] **Step 3: Implement admin-overrides**

Create `src/lib/admin-overrides.ts`:

```ts
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";

/**
 * Schema for the persistent admin-overrides file. Stored at
 * `~/.auggy/<agentName>/admin-overrides.json`. Updated atomically (temp file
 * + rename) with mode 0o600. Read once at agent boot; the closure values
 * are the runtime source of truth thereafter.
 *
 * v1.0 supports three runtime-tunable knobs:
 *   - webTransport.allowAnonymous
 *   - budgets.dailyBudgetUsd
 *   - notify.globalMaxPerHour
 *
 * Adding a new override field is a schema migration — bump the version
 * number and add a per-version branch here.
 */
const AdminOverridesV1Schema = z.object({
  version: z.literal(1),
  lastModified: z.string().datetime(),
  lastModifiedBy: z.string(),
  overrides: z.object({
    webTransport: z
      .object({ allowAnonymous: z.boolean().optional() })
      .optional(),
    budgets: z
      .object({ dailyBudgetUsd: z.number().positive().optional() })
      .optional(),
    notify: z
      .object({ globalMaxPerHour: z.number().int().positive().optional() })
      .optional(),
  }),
});

export type AdminOverrides = z.infer<typeof AdminOverridesV1Schema>;

function overrideFilePath(agentDir: string): string {
  return join(agentDir, "admin-overrides.json");
}

/**
 * Read the override file. Returns null when:
 *   - agentDir is undefined (no scaffold-aware launch path)
 *   - agentDir doesn't exist
 *   - the file doesn't exist
 *   - the file is corrupt JSON (warn logged)
 *   - the file fails schema validation (per-field warnings logged)
 *
 * For v1.0 simplicity: on schema validation failure, the whole file is
 * discarded. Per-field salvage (preserve valid fields, drop invalid ones)
 * is a v1.1 refinement.
 */
export function readOverrides(agentDir: string | undefined): AdminOverrides | null {
  if (!agentDir || !existsSync(agentDir)) return null;
  const path = overrideFilePath(agentDir);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(
      `[admin-overrides] failed to parse ${path}: ${(err as Error).message}. ` +
        `Falling back to yaml values for all overrides.`,
    );
    return null;
  }

  const result = AdminOverridesV1Schema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      console.warn(
        `[admin-overrides] field ${issue.path.join(".")} failed validation: ${issue.message}. ` +
          `Falling back to yaml for this field.`,
      );
    }
    console.warn(
      `[admin-overrides] discarding entire override file due to validation errors. ` +
        `Per-field salvage is a v1.1 refinement.`,
    );
    return null;
  }

  return result.data;
}

/**
 * Write the override file atomically with mode 0o600.
 * Pattern: write to a temp file, then rename to the final path. Rename is
 * atomic on POSIX filesystems, so concurrent readers never observe a
 * partially-written file.
 *
 * The 0o600 mode means only the agent process user can read the file —
 * protects the operator's runtime knob state on multi-user hosts (shared
 * dev boxes, certain Docker setups).
 */
export function writeOverrides(agentDir: string, overrides: AdminOverrides): void {
  const path = overrideFilePath(agentDir);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/lib/admin-overrides.test.ts`

Expected: PASS — 11 tests green.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin-overrides.ts tests/lib/admin-overrides.test.ts
git commit -m "feat(lib): add admin-overrides persistence module (G36 phase 1)"
```

---

### Task 1.4: isLoopback helper in web-transport

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Adds an `isLoopback(ip: string): boolean` helper used by Phase 2's admin-auth module to enforce HTTPS on non-loopback addresses.

- [ ] **Step 1: Write the failing tests**

Find the existing `describe` block in `tests/transports/web-transport.test.ts` that tests `normalizeIp` (search for `normalizeIp returns null for null/undefined/empty input` — that block exists). After that block, ADD a new describe block at the same level:

```ts
describe("isLoopback", () => {
  it("returns true for 127.0.0.1", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
  });

  it("returns true for any 127.0.0.0/8 address", () => {
    expect(isLoopback("127.0.0.0")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("127.255.255.254")).toBe(true);
  });

  it("returns true for ::1", () => {
    expect(isLoopback("::1")).toBe(true);
  });

  it("returns true for IPv4-mapped loopback (::ffff:127.0.0.1)", () => {
    // After normalizeIp strips the prefix, it should still resolve to loopback
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for non-loopback IPv4", () => {
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("8.8.8.8")).toBe(false);
  });

  it("returns false for non-loopback IPv6", () => {
    expect(isLoopback("::2")).toBe(false);
    expect(isLoopback("fe80::1")).toBe(false);
    expect(isLoopback("2001:db8::1")).toBe(false);
  });

  it("returns false for empty / null / undefined / non-IP input", () => {
    expect(isLoopback("")).toBe(false);
    expect(isLoopback("not-an-ip")).toBe(false);
    expect(isLoopback("localhost")).toBe(false); // hostname, not IP
  });
});
```

Then ADD `isLoopback` to the existing import line at the top of the file (find: `import { normalizeIp, webTransport } from "@/transports/web-transport"`):

```ts
import { isLoopback, normalizeIp, webTransport } from "@/transports/web-transport";
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/web-transport.test.ts -t "isLoopback"`

Expected: FAIL with `isLoopback is not exported from "@/transports/web-transport"`.

- [ ] **Step 3: Implement isLoopback in web-transport.ts**

Open `src/transports/web-transport.ts`. Find the existing `export function normalizeIp(...)` declaration. IMMEDIATELY AFTER `normalizeIp`'s closing brace, INSERT:

```ts
/**
 * Returns true iff `ip` is a loopback address (127.0.0.0/8 or ::1).
 *
 * Strips the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`) before
 * the check, so `::ffff:127.0.0.1` is correctly classified as loopback.
 *
 * G36 uses this to gate HTTPS enforcement on /admin: loopback connections
 * are exempt for dev (operator on the same machine); non-loopback connections
 * over plain HTTP get 426 Upgrade Required.
 */
export function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const norm = normalizeIp(ip);
  if (!norm) return false;
  if (norm === "::1") return true;
  return /^127\./.test(norm);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/web-transport.test.ts -t "isLoopback"`

Expected: PASS — 7 tests green.

- [ ] **Step 5: Run the full web-transport test suite to check for regressions**

Run: `bun test tests/transports/web-transport.test.ts`

Expected: All previously-passing tests still pass; 7 new tests green.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): add isLoopback helper (G36 phase 1)"
```

---

## Phase 1 — End-of-phase verification

After Tasks 1.1 through 1.4 are complete:

- [ ] **Run the full test suite + typecheck + lint**

```bash
bun test
bunx tsc --noEmit
bun run lint
```

Expected:
- `bun test` — full suite passes (was 2012 baseline + ~26 new tests = ~2038).
- `bunx tsc --noEmit` — clean.
- `bun run lint` — baseline preserved (0 errors, ~29 warnings + 1 info).

- [ ] **No PR yet.** Phase 1 commits stay on `feat/g36-admin-route` and accumulate. Phase 2 builds on top. The full G36 PR opens at the end of Phase 4.

  **Rationale:** Phase 1 alone doesn't ship anything visible to operators — these are utilities. Opening a "foundation only" PR would invite review on partial functionality. Better to land the full G36 surface in one PR with all phases committed in order, so reviewers can trace the build-up sequence.

  Optional: if any phase grows beyond expectations, revisit the single-PR plan and split. For now, single PR.

---

## Out-of-plan / known limits for Phase 1

- **Per-field schema salvage** (preserve valid fields when one is invalid) is deferred to v1.1. v1.0 discards the whole override file on validation failure. Documented as a known limit in `admin-overrides.ts`'s doc comment.
- **Atomic-rename portability** — `renameSync` is atomic on POSIX filesystems (Linux, macOS). Windows has different semantics but Auggy doesn't ship to Windows in v1.0; not exercised in tests.
- **`ring-buffer.ts` doesn't track eviction events** — when an item is evicted because the buffer is full, no callback fires. If a future consumer needs eviction notification, add it then.
- **`isLoopback` doesn't handle every IPv6 form** — e.g., `0:0:0:0:0:0:0:1` (canonical long form of `::1`) is NOT classified as loopback by the current regex. Bun's `requestIP` returns `::1` in the short form on macOS + Linux, so this isn't a real-world concern. If it bites, expand the check.

---

## Phase 1 → Phase 2 handoff

When Phase 1 is complete:
- All four files (`ring-buffer.ts`, `admin-overrides.ts`, `src/types.ts`, `web-transport.ts`) committed
- 4 commits on `feat/g36-admin-route` ahead of main
- Tests green, typecheck clean, lint baseline

Phase 2 (admin module + webTransport dispatch) consumes:
- `createRingBuffer` from Task 1.1
- `AdminInfoBlock` / `AdminSection` / `AdminAction` / `AdminActionHandler` types from Task 1.2
- `readOverrides` / `writeOverrides` / `AdminOverrides` from Task 1.3
- `isLoopback` from Task 1.4

Begin Phase 2 by reading `docs/superpowers/plans/2026-05-19-g36-phase-2-admin-module.md`.

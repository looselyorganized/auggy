# G36 Phase 2 — Admin Module + webTransport Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the admin route into webTransport. After Phase 2, `GET /admin` returns an authenticated empty dashboard (no augment blocks yet — those land in Phase 3), `POST /admin/action/*` dispatches to handlers, and `webTransport.adminRoute: false` opts out cleanly.

**Architecture:** Six new files under `src/transports/admin/` (auth, csrf, collector, renderer, index, plus the action-input-coercion helper used by the dispatcher). One kernel-interface change (`TransportKernel.getAugments()`). webTransport modifications: option flag, boot-load overrides, dispatch routing, HEAD/405, `/admin` reserved-paths, boot-time handler validation. Phase 3 will populate the dashboard by adding `adminInfo()` to specific augments.

**Tech Stack:** TypeScript / Bun runtime / `bun:test` / Web Crypto API (for HMAC). No new runtime dependencies.

**Depends on:** Phase 1 (`ring-buffer.ts`, `admin-overrides.ts`, contract types, `isLoopback`).

**Branch:** Phase 1 PR (#59) will have merged before Phase 2 starts; branch from updated main as `feat/g36-phase-2-admin-module`.

---

## File Structure (Phase 2)

| File | Status | Responsibility |
|---|---|---|
| `src/transports/admin/admin-auth.ts` | **new** | HTTP Basic decode, bearer comparison (timing-safe), HTTPS-on-non-loopback gate, 401 + `WWW-Authenticate` emission, 426 + `Upgrade` emission with guidance body. |
| `src/transports/admin/admin-csrf.ts` | **new** | HMAC token generation + validation. Format: `base64url(HMAC-SHA256(bearer, agentName + "|" + ts + "|" + actionId + "|" + rowKey)) + "." + ts`. 24-hour expiry. |
| `src/transports/admin/admin-collector.ts` | **new** | Iterates `kernel.getAugments()`, calls `adminInfo()` on those that implement it, catches per-augment errors as status sections, returns ordered `AdminInfoBlock[]`. |
| `src/transports/admin/admin-renderer.ts` | **new** | Pure HTML rendering. Page shell + per-section renderers (keyValue, table, status, eventStream). Inline minimal CSS. HTML-escapes all interpolated values. Skips empty blocks. |
| `src/transports/admin/admin-coerce.ts` | **new** | Coerces form-string inputs to declared `AdminActionInput.type` (boolean/number/text). Returns `{ ok: true; values } | { ok: false; field; reason }`. |
| `src/transports/admin/index.ts` | **new** | Main route handler. Composes auth + rate-limit + CSRF + input coercion + dispatch. Boot-time `buildAdminActionRegistry(augments)` validates declarations AND builds the dispatch registry. Audit log via `console.log`. |
| `src/types.ts` | modified | Add `getAugments(): readonly Augment[]` to `TransportKernel` interface. |
| `src/agent.ts` | modified | Implement `getAugments()` on the `TransportKernel` view passed to transports. |
| `src/transports/web-transport.ts` | modified | (1) Add `adminRoute?: boolean` to options (default `true`). (2) `setAllowAnonymous` mutator + admin-override boot-load. (3) Dispatch `GET /admin`, `POST /admin/action/*`, `HEAD /admin → 405` with rate-limit gate. (4) Add `/admin` exact + `/admin/` prefix to reserved-paths. (5) Build action registry at boot via `buildAdminActionRegistry`. |
| `tests/transports/admin/*.test.ts` | **new** | Per-module unit tests (5 files). |
| `tests/transports/web-transport.test.ts` | modified | Integration tests for dispatch, opt-out, HEAD/405. |

---

### Task 2.1: admin-auth

**Files:**
- Create: `src/transports/admin/admin-auth.ts`
- Test: `tests/transports/admin/admin-auth.test.ts`

HTTP Basic decode + timing-safe bearer comparison + HTTPS-on-non-loopback gate. Returns a structured result the caller maps to 200 / 401 / 426.

- [ ] **Step 1: Write the failing tests**

Create `tests/transports/admin/admin-auth.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { checkAdminAuth } from "@/transports/admin/admin-auth";

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function makeReq(headers: Record<string, string>, url = "http://localhost:8080/admin"): Request {
  return new Request(url, { headers });
}

describe("admin-auth — HTTPS gate", () => {
  it("returns 426 when non-loopback caller uses http://", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://my-agent.fly.dev/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("https-required");
    if (result.kind === "https-required") {
      expect(result.response.status).toBe(426);
      expect(result.response.headers.get("upgrade")).toBe("TLS/1.2");
    }
  });

  it("allows loopback caller over plain http", () => {
    const result = checkAdminAuth({
      req: makeReq({ authorization: basicHeader("", "test-token") }, "http://127.0.0.1:8080/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("ok");
  });

  it("allows non-loopback caller over https://", () => {
    const result = checkAdminAuth({
      req: makeReq({ authorization: basicHeader("", "test-token") }, "https://my-agent.fly.dev/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("ok");
  });
});

describe("admin-auth — HTTP Basic", () => {
  it("returns 401 + WWW-Authenticate when no Authorization header", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://127.0.0.1:8080/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("www-authenticate")).toBe(
        'Basic realm="auggy-admin zip"',
      );
    }
  });

  it("401 response body is empty", async () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://127.0.0.1:8080/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      const body = await result.response.text();
      expect(body).toBe("");
    }
  });

  it("accepts empty-username basic auth (curl -u :token form)", () => {
    const result = checkAdminAuth({
      req: makeReq({ authorization: basicHeader("", "test-token") }, "http://127.0.0.1:8080/admin"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("ok");
  });

  it("accepts non-empty-username basic auth (curl -u admin:token form)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("admin", "test-token") },
        "http://127.0.0.1:8080/admin",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("ok");
  });

  it("rejects wrong bearer with 401", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "wrong-token") },
        "http://127.0.0.1:8080/admin",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      expect(result.response.status).toBe(401);
    }
  });

  it("rejects malformed Authorization header (non-Basic) with 401", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: "Bearer test-token" },
        "http://127.0.0.1:8080/admin",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("unauthorized");
  });

  it("rejects malformed base64 in Basic header with 401", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: "Basic not-valid-base64!@#" },
        "http://127.0.0.1:8080/admin",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("unauthorized");
  });

  it("HTTPS gate fires before HTTP Basic check (non-loopback http with valid bearer still 426)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "test-token") },
        "http://my-agent.fly.dev/admin",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("https-required");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/admin/admin-auth.test.ts`

Expected: FAIL with `Cannot find module '@/transports/admin/admin-auth'`.

- [ ] **Step 3: Implement admin-auth**

Create `src/transports/admin/admin-auth.ts`:

```ts
import { isLoopback } from "../web-transport";

export interface AdminAuthContext {
  req: Request;
  bearer: string;
  agentName: string;
  callerIp: string;
}

export type AdminAuthResult =
  | { kind: "ok" }
  | { kind: "https-required"; response: Response }
  | { kind: "unauthorized"; response: Response };

/**
 * Validate HTTP Basic auth on an /admin request + enforce HTTPS-on-non-loopback.
 *
 * Order of checks:
 *   1. HTTPS gate (loopback exempt; non-loopback http → 426 + guidance body)
 *   2. HTTP Basic decode + bearer compare (timing-safe)
 *
 * The 426 fires BEFORE the 401 — a misconfigured deployment (non-loopback,
 * plain HTTP, with a valid bearer) still gets pushed to HTTPS rather than
 * succeeding insecurely.
 */
export function checkAdminAuth(ctx: AdminAuthContext): AdminAuthResult {
  const url = new URL(ctx.req.url);

  // 1. HTTPS gate
  if (!isLoopback(ctx.callerIp) && url.protocol !== "https:") {
    const guidance = [
      `/admin requires HTTPS on non-loopback addresses.`,
      ``,
      `Options:`,
      `  1. Configure HTTPS termination in front of this agent.`,
      `  2. Access via http://127.0.0.1:${url.port || "8080"}/admin from the agent host.`,
      `  3. SSH tunnel: ssh -L ${url.port || "8080"}:127.0.0.1:${url.port || "8080"} user@host`,
    ].join("\n");
    return {
      kind: "https-required",
      response: new Response(guidance, {
        status: 426,
        headers: {
          upgrade: "TLS/1.2",
          connection: "Upgrade",
          "content-type": "text/plain; charset=utf-8",
        },
      }),
    };
  }

  // 2. HTTP Basic check
  const authHeader = ctx.req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("basic ")) {
    return unauthorized(ctx.agentName);
  }

  const b64 = authHeader.slice(6).trim();
  let decoded: string;
  try {
    decoded = atob(b64);
  } catch {
    return unauthorized(ctx.agentName);
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return unauthorized(ctx.agentName);
  const password = decoded.slice(colonIdx + 1);

  if (!timingSafeEqual(password, ctx.bearer)) {
    return unauthorized(ctx.agentName);
  }

  return { kind: "ok" };
}

function unauthorized(agentName: string): AdminAuthResult {
  return {
    kind: "unauthorized",
    response: new Response("", {
      status: 401,
      headers: {
        "www-authenticate": `Basic realm="auggy-admin ${agentName}"`,
      },
    }),
  };
}

const textEncoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/admin/admin-auth.test.ts`

Expected: PASS — 11 tests green.

- [ ] **Step 5: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: typecheck clean. Lint baseline preserved (29 warnings + 1 info, 0 errors). If new errors/infos appear, run `bunx @biomejs/biome format --write` on the new files and manually inspect any remaining diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/transports/admin/admin-auth.ts tests/transports/admin/admin-auth.test.ts
git commit -m "feat(admin): HTTP Basic auth + HTTPS-on-non-loopback gate (G36 phase 2)"
```

---

### Task 2.2: admin-csrf

**Files:**
- Create: `src/transports/admin/admin-csrf.ts`
- Test: `tests/transports/admin/admin-csrf.test.ts`

HMAC token generation + validation. Binds to `(bearer, agentName, actionId, rowKey?)`. 24-hour expiry.

- [ ] **Step 1: Write the failing tests**

Create `tests/transports/admin/admin-csrf.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  generateCsrfToken,
  validateCsrfToken,
} from "@/transports/admin/admin-csrf";

const bearer = "test-bearer-token";
const agentName = "zip";

describe("admin-csrf — generate + validate roundtrip", () => {
  it("validates a freshly-generated token for the same action + bearer", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(true);
  });

  it("validates a token with a rowKey when the rowKey matches", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    expect(result.valid).toBe(true);
  });
});

describe("admin-csrf — binding enforcement (returns reason: tampered)", () => {
  it("rejects a token for a different actionId with reason=tampered", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "posture-flip",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a token for a different bearer (after rotation)", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer: "different-bearer",
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a token for a different agentName", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName: "different-agent",
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a row-scoped token submitted with a different rowKey (M1 fix)", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_xyz",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a token issued without rowKey when submitted with a rowKey", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "memory-erase" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    expect(result.valid).toBe(false);
  });
});

describe("admin-csrf — expiry (returns reason: expired)", () => {
  it("rejects an expired token (>24 hours) with reason=expired", async () => {
    const expiredTs = Math.floor((Date.now() - 25 * 3600 * 1000) / 1000);
    const expiredToken = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: expiredTs,
    });
    const result = await validateCsrfToken({
      token: expiredToken,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  it("accepts a token issued just under 24 hours ago", async () => {
    const oldTs = Math.floor((Date.now() - 23 * 3600 * 1000) / 1000);
    const oldToken = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: oldTs,
    });
    const result = await validateCsrfToken({
      token: oldToken,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(true);
  });
});

describe("admin-csrf — tampering / malformed", () => {
  it("rejects a token with a tampered signature (reason=tampered)", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const [, ts] = token.split(".");
    const tampered = `tampered-signature-base64.${ts}`;
    const result = await validateCsrfToken({
      token: tampered,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a token with a future timestamp >60s ahead (reason=tampered)", async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 1000;
    const tampered = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: futureTs,
    });
    const result = await validateCsrfToken({
      token: tampered,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a malformed token (no dot separator) with reason=malformed", async () => {
    const result = await validateCsrfToken({
      token: "just-a-string-no-dot",
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed");
  });

  it("rejects a malformed token (non-numeric timestamp) with reason=malformed", async () => {
    const result = await validateCsrfToken({
      token: "signature.not-a-number",
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/admin/admin-csrf.test.ts`

Expected: FAIL with `Cannot find module '@/transports/admin/admin-csrf'`.

- [ ] **Step 3: Implement admin-csrf**

Create `src/transports/admin/admin-csrf.ts`:

```ts
/**
 * G36 CSRF token scheme. Format:
 *
 *   base64url(HMAC-SHA256(bearer, agentName + "|" + ts + "|" + actionId + "|" + rowKey?)) + "." + ts
 *
 * Binds the token to:
 *   - bearer  → can't reuse tokens after AUGGY_WEB_TOKEN is rotated
 *   - agentName → can't reuse tokens across different agents on the same browser
 *   - actionId → token for `notify-test` can't be replayed against `posture-flip`
 *   - rowKey (when present) → token for `memory-erase` on `vis_abc` can't be
 *     replayed against `vis_xyz` (closes the adversarial-review M1 finding)
 *
 * Timestamp is Unix seconds, base 10. Expiry: 24 hours from issuance.
 *
 * The HMAC is over a delimited string. `|` is the separator; values must not
 * contain it. agentName and actionId are operator-chosen identifiers (no
 * pipes); rowKey is a peer-id-like string also pipe-free. If we ever need to
 * accept user-input in the HMAC payload, switch to length-prefixed encoding.
 */

const CSRF_TTL_SECONDS = 24 * 3600;

export interface CsrfGenerateOpts {
  bearer: string;
  agentName: string;
  actionId: string;
  rowKey?: string;
  /** Internal: override timestamp (used by tests). */
  _timestamp?: number;
}

export interface CsrfValidateOpts {
  token: string;
  bearer: string;
  agentName: string;
  actionId: string;
  rowKey?: string;
}

/**
 * S7 fix — rich result so the caller can distinguish:
 *   - valid: token passes all checks
 *   - expired: HMAC fine, timestamp older than 24h → graceful "session
 *     expired, refreshing..." page (200 + meta-refresh), NOT 403
 *   - tampered: HMAC mismatch OR future-skew timestamp → 403 (real CSRF
 *     attack indicator)
 *   - malformed: structural parse failure → 403
 */
export type CsrfValidateResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "tampered" | "malformed" };

export async function generateCsrfToken(opts: CsrfGenerateOpts): Promise<string> {
  const ts = opts._timestamp ?? Math.floor(Date.now() / 1000);
  const message = `${opts.agentName}|${ts}|${opts.actionId}|${opts.rowKey ?? ""}`;
  const signature = await hmacSha256Base64Url(opts.bearer, message);
  return `${signature}.${ts}`;
}

export async function validateCsrfToken(opts: CsrfValidateOpts): Promise<CsrfValidateResult> {
  const dotIdx = opts.token.lastIndexOf(".");
  if (dotIdx < 0) return { valid: false, reason: "malformed" };
  const signature = opts.token.slice(0, dotIdx);
  const tsStr = opts.token.slice(dotIdx + 1);
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || String(ts) !== tsStr) {
    return { valid: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - ts >= CSRF_TTL_SECONDS) return { valid: false, reason: "expired" };
  // Future-skew tolerance: small window for clock drift; beyond that, treat
  // as tampering (an attacker fabricated a future timestamp to extend TTL).
  if (ts > now + 60) return { valid: false, reason: "tampered" };

  const message = `${opts.agentName}|${ts}|${opts.actionId}|${opts.rowKey ?? ""}`;
  const expected = await hmacSha256Base64Url(opts.bearer, message);

  if (!timingSafeStringEqual(signature, expected)) {
    return { valid: false, reason: "tampered" };
  }
  return { valid: true };
}

const enc = new TextEncoder();

async function hmacSha256Base64Url(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return base64urlEncode(new Uint8Array(sig));
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/admin/admin-csrf.test.ts`

Expected: PASS — 12 tests green.

- [ ] **Step 5: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: typecheck clean; lint baseline preserved.

- [ ] **Step 6: Commit**

```bash
git add src/transports/admin/admin-csrf.ts tests/transports/admin/admin-csrf.test.ts
git commit -m "feat(admin): HMAC CSRF tokens with rowKey binding (G36 phase 2)"
```

---

### Task 2.3: admin-collector + kernel.getAugments()

**Files:**
- Modify: `src/types.ts` — add `getAugments()` to `TransportKernel` interface
- Modify: `src/agent.ts` — implement `getAugments()` on the kernel view
- Create: `src/transports/admin/admin-collector.ts`
- Test: `tests/transports/admin/admin-collector.test.ts`

The collector iterates registered augments, calls each augment's `adminInfo()` if defined, and returns an ordered list of blocks. Per-augment errors are caught and converted to status sections so one broken augment doesn't break the whole page.

- [ ] **Step 1: Find the existing kernel-construction site in `src/agent.ts`**

Run: `grep -n "getAugmentRoutes\|TransportKernel" src/agent.ts | head -10`

Identify where the `TransportKernel` is built (likely a `const kernel: TransportKernel = { ... }` construction). You'll add `getAugments` there in Step 3.

- [ ] **Step 2: Add `getAugments` to the `TransportKernel` interface**

Open `src/types.ts`. Find the `TransportKernel` interface (search: `export interface TransportKernel`). ADD inside the interface body:

```ts
  /**
   * G36 — returns the live augment list for /admin's adminInfo collection
   * + boot-time action-handler validation. Immutable after agent.start().
   */
  getAugments(): readonly Augment[];
```

- [ ] **Step 3: Implement `getAugments` in `src/agent.ts`** (S5 — mutation safety via frozen snapshot)

Locate where the kernel object is constructed (Step 1 finding). Find the existing properties like `getAgentCard` and `getAugmentRoutes`. ADD a sibling property `getAugments`.

**S5 fix:** the implementation MUST return a snapshot (frozen and/or copied) — NOT a reference to the live internal augments array. Otherwise a buggy or hostile augment whose `adminInfo()` happens to mutate the array could corrupt downstream iteration in `collectAdminInfoBlocks`.

Two valid implementations:

```ts
// Option A: precompute the frozen snapshot once at kernel construction
const frozenAugments: readonly Augment[] = Object.freeze(augments.slice());
const kernel: TransportKernel = {
  handleInbound: ...,
  onOutbound: ...,
  getAgentCard: () => agentCard,
  getAugmentRoutes: () => collectedRoutes,
  getAugments: () => frozenAugments, // returns the frozen snapshot
};
```

```ts
// Option B: return a fresh frozen slice on each call
const kernel: TransportKernel = {
  ...
  getAugments: () => Object.freeze(augments.slice()),
};
```

Prefer **Option A** — augments are immutable after `agent.start()`, so the snapshot is correct for the kernel's lifetime; cached snapshot avoids per-call allocation.

If `augments` isn't in scope at the kernel-construction site, hoist it. The augments array is what `defineAgent(config)` received as `config.augments`.

- [ ] **Step 4: Verify the change typechecks**

Run: `bunx tsc --noEmit`

Expected: clean. If any transport mock in tests has its own `TransportKernel`-shaped object, it will now need `getAugments`. Find them via:

```bash
grep -rn "TransportKernel" tests/ src/ | grep -v "src/types.ts\|src/agent.ts"
```

For each test mock, add a stub: `getAugments: () => [],`.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `bun test`

Expected: pre-Phase-2 baseline pass count (or higher). No new failures from the kernel API change.

- [ ] **Step 6: Write the admin-collector tests**

Create `tests/transports/admin/admin-collector.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { collectAdminInfoBlocks } from "@/transports/admin/admin-collector";
import type { Augment, TransportKernel } from "@/types";

function mockKernel(augments: Augment[]): TransportKernel {
  return {
    handleInbound: async () => ({ status: "completed", events: [] }) as any,
    onOutbound: () => {},
    getAgentCard: () =>
      ({
        provider: { name: "zip" },
        capabilities: {
          streaming: false,
          pushNotifications: false,
          memory: false,
          transport: true,
        },
        skills: [],
        interfaces: ["HTTP+JSON"],
        extensions: {},
      }) as any,
    getAugmentRoutes: () => [],
    getAugments: () => augments,
  };
}

function mockAugment(overrides: Partial<Augment> = {}): Augment {
  return {
    name: "test-augment",
    ...overrides,
  };
}

describe("admin-collector", () => {
  it("returns empty list when no augments are registered", async () => {
    const blocks = await collectAdminInfoBlocks(mockKernel([]));
    expect(blocks).toEqual([]);
  });

  it("returns empty list when no augments declare adminInfo", async () => {
    const blocks = await collectAdminInfoBlocks(
      mockKernel([mockAugment({ name: "a" }), mockAugment({ name: "b" })]),
    );
    expect(blocks).toEqual([]);
  });

  it("collects blocks from augments that declare adminInfo", async () => {
    const aug = mockAugment({
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [{ kind: "status", level: "ok", message: "all good" }],
      }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([aug]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Test");
  });

  it("preserves augment registration order", async () => {
    const a = mockAugment({
      name: "a",
      adminInfo: async () => ({ augmentName: "a", title: "A", sections: [] }),
    });
    const b = mockAugment({
      name: "b",
      adminInfo: async () => ({ augmentName: "b", title: "B", sections: [] }),
    });
    const c = mockAugment({
      name: "c",
      adminInfo: async () => ({ augmentName: "c", title: "C", sections: [] }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([a, b, c]));
    expect(blocks.map((b) => b.title)).toEqual(["A", "B", "C"]);
  });

  it("renders an error status section when an augment's adminInfo throws", async () => {
    const broken = mockAugment({
      name: "broken",
      adminInfo: async () => {
        throw new Error("kaboom");
      },
    });
    const ok = mockAugment({
      name: "ok",
      adminInfo: async () => ({ augmentName: "ok", title: "OK", sections: [] }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([broken, ok]));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.augmentName).toBe("broken");
    expect(blocks[0]?.sections[0]).toMatchObject({
      kind: "status",
      level: "error",
    });
    expect(blocks[1]?.title).toBe("OK");
  });

  it("skips augments whose adminInfo returns falsy", async () => {
    const aug = mockAugment({
      name: "test",
      adminInfo: (async () => null) as () => Promise<any>,
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([aug]));
    expect(blocks).toEqual([]);
  });
});
```

- [ ] **Step 7: Run admin-collector tests — verify failure**

Run: `bun test tests/transports/admin/admin-collector.test.ts`

Expected: FAIL with `Cannot find module '@/transports/admin/admin-collector'`.

- [ ] **Step 8: Implement admin-collector**

Create `src/transports/admin/admin-collector.ts`:

```ts
import type { AdminInfoBlock, TransportKernel } from "../../types";

/**
 * Iterate registered augments and collect their AdminInfoBlocks for /admin
 * rendering. Augments without adminInfo are skipped. Augments whose adminInfo
 * throws are replaced with a status-error block — one broken augment can't
 * take down the whole dashboard.
 */
export async function collectAdminInfoBlocks(
  kernel: TransportKernel,
): Promise<AdminInfoBlock[]> {
  const augments = kernel.getAugments();
  const blocks: AdminInfoBlock[] = [];

  for (const aug of augments) {
    if (!aug.adminInfo) continue;
    try {
      const block = await aug.adminInfo();
      if (block) blocks.push(block);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[admin] augment "${aug.name}" adminInfo() threw: ${message}`,
      );
      blocks.push({
        augmentName: aug.name,
        title: aug.name,
        sections: [
          {
            kind: "status",
            level: "error",
            message: `Failed to load admin info: ${message}`,
          },
        ],
      });
    }
  }

  return blocks;
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `bun test tests/transports/admin/admin-collector.test.ts`

Expected: PASS — 6 tests green.

- [ ] **Step 10: Full test suite to catch any kernel-stub gaps**

Run: `bun test`

Expected: all green. If any test fails because a kernel mock lacks `getAugments`, add the stub there (`getAugments: () => [],`).

- [ ] **Step 11: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: typecheck clean; lint baseline.

- [ ] **Step 12: Commit**

```bash
git add src/types.ts src/agent.ts src/transports/admin/admin-collector.ts tests/transports/admin/admin-collector.test.ts
# add any test files updated with the getAugments stub:
git add tests/
git commit -m "feat(admin): kernel.getAugments() + admin-collector (G36 phase 2)"
```

---

### Task 2.4: admin-renderer

**Files:**
- Create: `src/transports/admin/admin-renderer.ts`
- Test: `tests/transports/admin/admin-renderer.test.ts`

Pure HTML rendering. Page shell + per-section renderers. CSRF token threaded through every form. HTML-escapes everything. Skips empty blocks.

- [ ] **Step 1: Write the failing tests**

Create `tests/transports/admin/admin-renderer.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { renderAdminPage } from "@/transports/admin/admin-renderer";
import type { AdminInfoBlock, AgentCard } from "@/types";

function card(name = "zip"): AgentCard {
  return {
    provider: { name },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
}

describe("admin-renderer — page shell", () => {
  it("returns valid HTML document", () => {
    const html = renderAdminPage({ card: card(), blocks: [], csrfToken: "tok" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes agent name in title and h1", () => {
    const html = renderAdminPage({ card: card("zip"), blocks: [], csrfToken: "tok" });
    expect(html).toContain("<title>zip — admin</title>");
    expect(html).toContain("<h1>zip</h1>");
  });

  it("includes robots noindex meta", () => {
    const html = renderAdminPage({ card: card(), blocks: [], csrfToken: "tok" });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("escapes agent name in title + h1", () => {
    const html = renderAdminPage({
      card: card("<script>alert(1)</script>"),
      blocks: [],
      csrfToken: "tok",
    });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("includes flash message when provided", () => {
    const html = renderAdminPage({
      card: card(),
      blocks: [],
      csrfToken: "tok",
      flashMessage: "Test sent successfully",
    });
    expect(html).toContain("Test sent successfully");
  });

  it("escapes flash message", () => {
    const html = renderAdminPage({
      card: card(),
      blocks: [],
      csrfToken: "tok",
      flashMessage: "<img onerror=\"alert(1)\" src=x>",
    });
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;img");
  });

  it("includes footer security notice", () => {
    const html = renderAdminPage({ card: card(), blocks: [], csrfToken: "tok" });
    expect(html).toContain("Admin credentials are visible in browser devtools");
  });
});

describe("admin-renderer — block rendering", () => {
  it("renders a block with title", () => {
    const block: AdminInfoBlock = {
      augmentName: "test",
      title: "Test Augment",
      sections: [{ kind: "status", level: "ok", message: "all systems go" }],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("<h2>Test Augment</h2>");
  });

  it("skips blocks with no sections and no actions", () => {
    const block: AdminInfoBlock = {
      augmentName: "empty",
      title: "Empty",
      sections: [],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).not.toContain("<h2>Empty</h2>");
  });

  it("renders multiple blocks in order", () => {
    const blocks: AdminInfoBlock[] = [
      { augmentName: "a", title: "Alpha", sections: [{ kind: "status", level: "ok", message: "a" }] },
      { augmentName: "b", title: "Beta", sections: [{ kind: "status", level: "ok", message: "b" }] },
    ];
    const html = renderAdminPage({ card: card(), blocks, csrfToken: "tok" });
    const alphaIdx = html.indexOf("Alpha");
    const betaIdx = html.indexOf("Beta");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
  });
});

describe("admin-renderer — sections by kind", () => {
  it("keyValue: renders rows as <dl>", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Daily budget", value: "$30" },
            { label: "Used today", value: "$12", source: "yaml" },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("<dt>Daily budget</dt>");
    expect(html).toContain("<dd>$30</dd>");
    expect(html).toContain("yaml");
  });

  it("keyValue: escapes label + value", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [{ label: "<bad>", value: "<also-bad>" }],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).not.toContain("<bad>");
    expect(html).toContain("&lt;bad&gt;");
  });

  it("table: renders header + body rows", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "table",
          columns: ["Peer", "Cost"],
          rows: [
            ["creator", "$8.20"],
            ["vis_abc", "$3.10"],
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("<th>Peer</th>");
    expect(html).toContain("<th>Cost</th>");
    expect(html).toContain("<td>creator</td>");
    expect(html).toContain("<td>$8.20</td>");
  });

  it("table: includes caption when provided", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "table",
          columns: ["c"],
          rows: [["v"]],
          caption: "Showing 1 of 1",
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("<caption>Showing 1 of 1</caption>");
  });

  it("status: renders with appropriate level class", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        { kind: "status", level: "warn", message: "watch out" },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("status-warn");
    expect(html).toContain("watch out");
  });

  it("eventStream: renders events as a table", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "eventStream",
          events: [
            { timestamp: "16:42:01", type: "budget.turn_admitted", summary: "creator $0.42" },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("16:42:01");
    expect(html).toContain("budget.turn_admitted");
    expect(html).toContain("creator $0.42");
  });
});

describe("admin-renderer — keyValue reset button (S6)", () => {
  it("renders reset button next to a keyValue row when resetAction is set", () => {
    const block: AdminInfoBlock = {
      augmentName: "budgets",
      title: "Budgets",
      sections: [
        {
          kind: "keyValue",
          rows: [
            {
              label: "Daily cap",
              value: "$30",
              source: "/admin override",
              resetAction: { id: "budget-cap-reset", label: "Reset to yaml" },
            },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok-x" });
    expect(html).toContain("budget-cap-reset");
    expect(html).toContain("Reset to yaml");
    expect(html).toContain('action="/admin/action/budget-cap-reset"');
    // CSRF token threaded through the reset form too
    expect(html.indexOf("tok-x")).toBeGreaterThan(0);
  });

  it("does not render reset button when resetAction is absent", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [
        {
          kind: "keyValue",
          rows: [{ label: "X", value: "Y" }],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).not.toContain("Reset to yaml");
    expect(html).not.toContain('class="reset-form"');
  });
});

describe("admin-renderer — actions + CSRF", () => {
  it("renders an augment-level action as a form with CSRF input", () => {
    const block: AdminInfoBlock = {
      augmentName: "notify",
      title: "Notify",
      sections: [],
      actions: [
        {
          id: "notify-test",
          label: "Send test notification",
          confirmRequired: false,
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "csrf-tok-123" });
    expect(html).toContain('action="/admin/action/notify-test"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="_csrf"');
    expect(html).toContain('value="csrf-tok-123"');
    expect(html).toContain("Send test notification");
  });

  it("renders action inputs as form fields", () => {
    const block: AdminInfoBlock = {
      augmentName: "budgets",
      title: "Budgets",
      sections: [],
      actions: [
        {
          id: "budget-cap-adjust",
          label: "Adjust daily budget",
          confirmRequired: true,
          inputs: [
            { name: "value", label: "USD", type: "number", required: true, default: "30" },
          ],
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain('name="value"');
    expect(html).toContain('type="number"');
    expect(html).toContain('value="30"');
    expect(html).toContain("required");
  });

  it("confirmRequired adds onsubmit confirm", () => {
    const block: AdminInfoBlock = {
      augmentName: "t",
      title: "T",
      sections: [],
      actions: [
        {
          id: "danger",
          label: "Dangerous Action",
          confirmRequired: true,
        },
      ],
    };
    const html = renderAdminPage({ card: card(), blocks: [block], csrfToken: "tok" });
    expect(html).toContain("onsubmit=");
    expect(html).toContain("confirm(");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/admin/admin-renderer.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement admin-renderer**

Create `src/transports/admin/admin-renderer.ts`:

```ts
import type {
  AdminActionInput,
  AdminInfoBlock,
  AdminSection,
  AgentCard,
} from "../../types";

export interface RenderAdminPageOpts {
  card: AgentCard;
  blocks: AdminInfoBlock[];
  csrfToken: string;
  flashMessage?: string;
}

const FOOTER_NOTICE =
  "Admin credentials are visible in browser devtools; don't share screenshots that include the Network tab.";

const CSS = `
  body { font-family: system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.4; }
  h1 { margin-bottom: 0; }
  .meta { color: #666; font-size: 0.9em; margin-top: 0; }
  .flash-ok { background: #d4edda; padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; }
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
  form.action-form { display: inline-flex; gap: 0.5rem; align-items: end; margin-top: 0.75rem; }
  .status-ok { background: #d4edda; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .status-warn { background: #fff3cd; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .status-error { background: #f8d7da; padding: 0.5rem 0.75rem; border-radius: 4px; }
  button { padding: 0.4rem 0.8rem; cursor: pointer; }
`.trim();

export function renderAdminPage(opts: RenderAdminPageOpts): string {
  const name = opts.card.provider.name || "this agent";
  const escapedName = escapeHtml(name);
  const flash = opts.flashMessage
    ? `\n  <div class="flash-ok">${escapeHtml(opts.flashMessage)}</div>`
    : "";

  const blocksHtml = opts.blocks
    .filter((b) => (b.sections.length > 0) || (b.actions && b.actions.length > 0))
    .map((b) => renderBlock(b, opts.csrfToken))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapedName} — admin</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>${escapedName}</h1>
  <p class="meta">admin · auggy</p>${flash}
${blocksHtml}
  <footer>
    <p style="color: #666; font-size: 0.85em">${escapeHtml(FOOTER_NOTICE)}</p>
  </footer>
</body>
</html>`;
}

function renderBlock(block: AdminInfoBlock, csrfToken: string): string {
  const sectionsHtml = block.sections.map((s) => renderSection(s, csrfToken)).join("\n");
  const actionsHtml = (block.actions ?? [])
    .map((action) => renderAction(action, csrfToken))
    .join("\n");

  return `  <section>
    <h2>${escapeHtml(block.title)}</h2>
${sectionsHtml}
${actionsHtml}
  </section>`;
}

function renderSection(section: AdminSection, csrfToken: string): string {
  switch (section.kind) {
    case "keyValue": {
      const rows = section.rows
        .map((r) => {
          const src = r.source ? ` <span class="source">${escapeHtml(r.source)}</span>` : "";
          const resetBtn = r.resetAction
            ? renderResetButton(r.resetAction, csrfToken)
            : "";
          return `      <dt>${escapeHtml(r.label)}</dt><dd>${escapeHtml(r.value)}${src}${resetBtn}</dd>`;
        })
        .join("\n");
      return `    <dl>\n${rows}\n    </dl>`;
    }
    case "table": {
      const caption = section.caption
        ? `      <caption>${escapeHtml(section.caption)}</caption>\n`
        : "";
      const head = `      <thead><tr>${section.columns
        .map((c) => `<th>${escapeHtml(c)}</th>`)
        .join("")}</tr></thead>`;
      const body = `      <tbody>${section.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      return `    <table>\n${caption}${head}\n${body}\n    </table>`;
    }
    case "status": {
      return `    <div class="status-${section.level}">${escapeHtml(section.message)}</div>`;
    }
    case "eventStream": {
      const head = `      <thead><tr><th>Time</th><th>Type</th><th>Summary</th></tr></thead>`;
      const body = `      <tbody>${section.events
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.timestamp)}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.summary)}</td></tr>`,
        )
        .join("")}</tbody>`;
      const caption = section.caption
        ? `      <caption>${escapeHtml(section.caption)}</caption>\n`
        : "";
      return `    <table>\n${caption}${head}\n${body}\n    </table>`;
    }
  }
}

function renderAction(
  action: { id: string; label: string; confirmRequired: boolean; inputs?: AdminActionInput[] },
  csrfToken: string,
): string {
  // M1 fix — generic confirm message instead of interpolating action.label
  // into JS. Action labels containing `'` or `"` would otherwise break the
  // inline onsubmit JS string (the HTML parser decodes &#39; → ' INSIDE the
  // attribute value before the JS sees it). Generic message is no worse for
  // UX (the button label is already visible) and removes the injection vector
  // entirely.
  const confirmAttr = action.confirmRequired
    ? ` onsubmit="return confirm('Confirm this action?')"`
    : "";
  const inputs = (action.inputs ?? [])
    .map((input) => {
      const type = input.type === "boolean" ? "checkbox" : input.type;
      const def = input.default !== undefined ? ` value="${escapeHtml(input.default)}"` : "";
      const req = input.required ? " required" : "";
      const help = input.helpText
        ? `<small>${escapeHtml(input.helpText)}</small>`
        : "";
      return `      <label>${escapeHtml(input.label)}: <input type="${type}" name="${escapeHtml(
        input.name,
      )}"${def}${req}></label>${help}`;
    })
    .join("\n");
  return `    <form class="action-form" action="/admin/action/${escapeHtml(
    action.id,
  )}" method="POST"${confirmAttr}>
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
${inputs}
      <button type="submit">${escapeHtml(action.label)}</button>
    </form>`;
}

// S6 fix — reset-to-yaml button rendered next to keyValue rows whose
// resetAction is set. The renderer doesn't know which rows came from
// admin-overrides vs yaml; the augment's adminInfo() implementation decides
// when to populate resetAction (Phase 3 work). Phase 2's renderer just
// honors the field.
function renderResetButton(
  reset: { id: string; label: string },
  csrfToken: string,
): string {
  return ` <form class="reset-form" action="/admin/action/${escapeHtml(
    reset.id,
  )}" method="POST" style="display:inline" onsubmit="return confirm('Confirm this action?')"><input type="hidden" name="_csrf" value="${escapeHtml(
    csrfToken,
  )}"><button type="submit">${escapeHtml(reset.label)}</button></form>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/admin/admin-renderer.test.ts`

Expected: PASS — ~18 tests green.

- [ ] **Step 5: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: typecheck clean; lint baseline.

- [ ] **Step 6: Commit**

```bash
git add src/transports/admin/admin-renderer.ts tests/transports/admin/admin-renderer.test.ts
git commit -m "feat(admin): HTML renderer for /admin dashboard (G36 phase 2)"
```

---

### Task 2.5: admin-coerce + admin/index handler + boot-time validation

**Files:**
- Create: `src/transports/admin/admin-coerce.ts` (input-type coercion helper)
- Create: `src/transports/admin/index.ts` (main route handler)
- Test: `tests/transports/admin/admin-route.test.ts` (handler tests)
- Test: `tests/transports/admin/admin-boot-validation.test.ts` (boot-validation tests)

Glues auth + CSRF + collector + renderer into a route handler. Adds boot-time validation that every declared action has a handler. Also implements the input-coercion helper used by the dispatcher.

- [ ] **Step 1: Write the coerce tests**

Create `tests/transports/admin/admin-route.test.ts` (the coerce tests live here too for compactness; split if it grows):

```ts
import { describe, expect, it } from "bun:test";
import { coerceInputs } from "@/transports/admin/admin-coerce";
import type { AdminActionInput } from "@/types";

const numberInput: AdminActionInput = {
  name: "value",
  label: "Value",
  type: "number",
  required: true,
};
const boolInput: AdminActionInput = {
  name: "flag",
  label: "Flag",
  type: "boolean",
  required: true,
};
const textInput: AdminActionInput = {
  name: "msg",
  label: "Msg",
  type: "text",
  required: false,
};

describe("admin-coerce", () => {
  it("coerces number string to typed string", () => {
    const r = coerceInputs([numberInput], { value: "42" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.value).toBe("42");
  });

  it("rejects non-numeric value for number input", () => {
    const r = coerceInputs([numberInput], { value: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("value");
      expect(r.reason).toMatch(/number/i);
    }
  });

  it("accepts 'true' / 'on' for boolean input", () => {
    expect(coerceInputs([boolInput], { flag: "true" }).ok).toBe(true);
    expect(coerceInputs([boolInput], { flag: "on" }).ok).toBe(true);
  });

  it("accepts 'false' / unset for boolean input", () => {
    expect(coerceInputs([boolInput], { flag: "false" }).ok).toBe(true);
    expect(coerceInputs([boolInput], {}).ok).toBe(true);
  });

  it("rejects required input when missing", () => {
    const r = coerceInputs([numberInput], {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("value");
  });

  it("optional text input is OK when missing", () => {
    const r = coerceInputs([textInput], {});
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement admin-coerce**

Create `src/transports/admin/admin-coerce.ts`:

```ts
import type { AdminActionInput } from "../../types";

export type CoerceResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; field: string; reason: string };

/**
 * Coerce form-string inputs to declared types. The dispatcher calls this
 * before invoking the action handler — coercion failure short-circuits the
 * dispatch with an AdminActionResult.ok=false.
 *
 * Returns string values (not typed) because all handler params arrive as
 * Record<string, string>. The coercion validates that the value PARSES into
 * the declared type; the handler is then free to convert (Number(value),
 * value === "true", etc.) knowing the parse will succeed.
 */
export function coerceInputs(
  inputs: AdminActionInput[],
  raw: Record<string, string | undefined>,
): CoerceResult {
  const values: Record<string, string> = {};

  for (const input of inputs) {
    const v = raw[input.name];

    if (v === undefined || v === "") {
      if (input.type === "boolean") {
        // Unset checkbox = false
        values[input.name] = "false";
        continue;
      }
      if (input.required) {
        return { ok: false, field: input.name, reason: "required" };
      }
      continue;
    }

    switch (input.type) {
      case "text":
        values[input.name] = v;
        break;
      case "number":
        if (!Number.isFinite(Number(v))) {
          return { ok: false, field: input.name, reason: `not a valid number: "${v}"` };
        }
        values[input.name] = v;
        break;
      case "boolean":
        if (v === "true" || v === "on" || v === "1") {
          values[input.name] = "true";
        } else if (v === "false" || v === "off" || v === "0") {
          values[input.name] = "false";
        } else {
          return {
            ok: false,
            field: input.name,
            reason: `not a valid boolean: "${v}" (expected true/false/on/off/1/0)`,
          };
        }
        break;
    }
  }

  return { ok: true, values };
}
```

- [ ] **Step 3: Run coerce tests**

Run: `bun test tests/transports/admin/admin-route.test.ts -t "admin-coerce"`

Expected: PASS — 6 tests green.

- [ ] **Step 4: Write the admin/index handler tests**

APPEND to `tests/transports/admin/admin-route.test.ts`:

```ts
import {
  buildAdminActionRegistry,
  handleAdminRoute,
  type AdminActionRegistry,
  type AdminRouteContext,
} from "@/transports/admin/index";
import type { Augment } from "@/types";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";

async function makeCtx(
  overrides: Partial<AdminRouteContext> & { augments?: Augment[] } = {},
): Promise<AdminRouteContext> {
  const { augments = [], ...rest } = overrides;
  // S8 — production code builds the registry once at boot via
  // buildAdminActionRegistry. Tests build it per-test to keep setup isolated.
  const actionRegistry: AdminActionRegistry = await buildAdminActionRegistry(augments);
  return {
    kernel: {
      handleInbound: async () => ({ status: "completed", events: [] }) as any,
      onOutbound: () => {},
      getAgentCard: () =>
        ({
          provider: { name: "zip" },
          capabilities: {
            streaming: false,
            pushNotifications: false,
            memory: false,
            transport: true,
          },
          skills: [],
          interfaces: ["HTTP+JSON"],
          extensions: {},
        }) as any,
      getAugmentRoutes: () => [],
      getAugments: () => augments,
    },
    bearer: "test-bearer",
    agentDir: undefined,
    callerIp: "127.0.0.1",
    actionRegistry,
    ...rest,
  };
}

function basicHeader(bearer: string): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

describe("handleAdminRoute — auth", () => {
  it("GET /admin without bearer → 401", async () => {
    const req = new Request("http://127.0.0.1:8080/admin");
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="auggy-admin zip"');
  });

  it("GET /admin with valid bearer → 200 + HTML", async () => {
    const req = new Request("http://127.0.0.1:8080/admin", {
      headers: { authorization: basicHeader("test-bearer") },
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>zip — admin</title>");
  });

  it("GET /admin from non-loopback over http → 426", async () => {
    const req = new Request("http://my-agent.fly.dev/admin");
    const res = await handleAdminRoute(req, await makeCtx({ callerIp: "10.0.0.5" }));
    expect(res.status).toBe(426);
    expect(res.headers.get("upgrade")).toBe("TLS/1.2");
  });
});

describe("handleAdminRoute — POST action dispatch", () => {
  it("POST /admin/action/<id> without CSRF → 403", async () => {
    const aug: Augment = {
      name: "test",
      adminActions: {
        "test-action": async () => ({ ok: true, message: "ok" }),
      },
    };
    const req = new Request("http://127.0.0.1:8080/admin/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(403);
  });

  it("POST /admin/action/<id> with valid CSRF dispatches handler", async () => {
    const aug: Augment = {
      name: "test",
      adminActions: {
        "test-action": async () => ({ ok: true, message: "fired" }),
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "test-action",
    });
    const req = new Request("http://127.0.0.1:8080/admin/action/test-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    // Successful action returns 303 See Other redirect to /admin?msg=...
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/admin?msg=");
    expect(res.headers.get("location")).toContain(encodeURIComponent("fired"));
  });

  it("POST /admin/action/<unknown-id> → 404", async () => {
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "unknown",
    });
    const req = new Request("http://127.0.0.1:8080/admin/action/unknown", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx());
    expect(res.status).toBe(404);
  });

  it("POST /admin/action/<id>/row/<rowKey> dispatches with rowKey", async () => {
    let receivedParams: Record<string, string> = {};
    const aug: Augment = {
      name: "memory",
      adminActions: {
        "memory-erase": async (params) => {
          receivedParams = params;
          return { ok: true, message: `erased ${params.rowKey}` };
        },
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const req = new Request("http://127.0.0.1:8080/admin/action/memory-erase/row/vis_abc", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(receivedParams.rowKey).toBe("vis_abc");
  });

  it("action handler throws → caught, returns ok=false flash", async () => {
    const aug: Augment = {
      name: "test",
      adminActions: {
        "broken-action": async () => {
          throw new Error("boom");
        },
      },
    };
    const csrf = await generateCsrfToken({
      bearer: "test-bearer",
      agentName: "zip",
      actionId: "broken-action",
    });
    const req = new Request("http://127.0.0.1:8080/admin/action/broken-action", {
      method: "POST",
      headers: {
        authorization: basicHeader("test-bearer"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const res = await handleAdminRoute(req, await makeCtx({ augments: [aug] }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(encodeURIComponent("internal error"));
  });
});
```

- [ ] **Step 5: Write the boot-validation tests**

Create `tests/transports/admin/admin-boot-validation.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildAdminActionRegistry } from "@/transports/admin/index";
import type { Augment } from "@/types";

describe("buildAdminActionRegistry", () => {
  it("returns empty registry when no augment declares adminInfo", async () => {
    const augments: Augment[] = [{ name: "test" }];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.size).toBe(0);
  });

  it("registers action handlers when adminInfo's declared actions all have handlers", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [{ id: "test-action", label: "Do it", confirmRequired: false }],
        }),
        adminActions: {
          "test-action": async () => ({ ok: true, message: "ok" }),
        },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.size).toBe(1);
    expect(registry.get("test-action")?.augmentName).toBe("test");
    expect(registry.get("test-action")?.isRowAction).toBe(false);
  });

  it("registers inputs from the action declaration", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [
            {
              id: "act",
              label: "X",
              confirmRequired: false,
              inputs: [
                { name: "n", label: "N", type: "number", required: true },
              ],
            },
          ],
        }),
        adminActions: { act: async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("act")?.inputs).toHaveLength(1);
    expect(registry.get("act")?.inputs[0]?.name).toBe("n");
  });

  it("registers row actions with isRowAction=true", async () => {
    const augments: Augment[] = [
      {
        name: "memory",
        adminInfo: async () => ({
          augmentName: "memory",
          title: "Memory",
          sections: [
            {
              kind: "table",
              columns: ["peer"],
              rows: [["a"]],
              rowActions: [
                { id: "erase", label: "Erase", confirmRequired: true, rowKeyColumn: 0 },
              ],
            },
          ],
        }),
        adminActions: { erase: async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("erase")?.isRowAction).toBe(true);
  });

  it("throws when adminInfo declares an action with no matching handler", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [],
          actions: [{ id: "missing", label: "Missing", confirmRequired: false }],
        }),
        adminActions: {},
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /augment "test" declares action "missing" but does not provide an adminActions handler/,
    );
  });

  it("throws when rowAction in a table section has no matching handler", async () => {
    const augments: Augment[] = [
      {
        name: "test",
        adminInfo: async () => ({
          augmentName: "test",
          title: "Test",
          sections: [
            {
              kind: "table",
              columns: ["id"],
              rows: [["a"]],
              rowActions: [
                { id: "row-missing", label: "Erase", confirmRequired: false, rowKeyColumn: 0 },
              ],
            },
          ],
        }),
        adminActions: {},
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /augment "test" declares action "row-missing" but does not provide an adminActions handler/,
    );
  });

  it("throws when two augments declare the same action id (O12 uniqueness)", async () => {
    const augments: Augment[] = [
      {
        name: "first",
        adminInfo: async () => ({
          augmentName: "first",
          title: "First",
          sections: [],
          actions: [{ id: "shared", label: "X", confirmRequired: false }],
        }),
        adminActions: { shared: async () => ({ ok: true, message: "" }) },
      },
      {
        name: "second",
        adminInfo: async () => ({
          augmentName: "second",
          title: "Second",
          sections: [],
          actions: [{ id: "shared", label: "Y", confirmRequired: false }],
        }),
        adminActions: { shared: async () => ({ ok: true, message: "" }) },
      },
    ];
    await expect(buildAdminActionRegistry(augments)).rejects.toThrow(
      /action id "shared" declared by multiple augments/,
    );
  });

  it("registers reset actions from keyValue sections", async () => {
    const augments: Augment[] = [
      {
        name: "budgets",
        adminInfo: async () => ({
          augmentName: "budgets",
          title: "Budgets",
          sections: [
            {
              kind: "keyValue",
              rows: [
                {
                  label: "Daily cap",
                  value: "$30",
                  resetAction: { id: "budget-reset", label: "Reset" },
                },
              ],
            },
          ],
        }),
        adminActions: { "budget-reset": async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.get("budget-reset")?.augmentName).toBe("budgets");
  });

  it("skips augment whose adminInfo throws (logs warning, doesn't fail boot)", async () => {
    const augments: Augment[] = [
      {
        name: "broken",
        adminInfo: async () => {
          throw new Error("kaboom");
        },
        adminActions: {},
      },
      {
        name: "ok",
        adminInfo: async () => ({
          augmentName: "ok",
          title: "OK",
          sections: [],
          actions: [{ id: "ok-action", label: "OK", confirmRequired: false }],
        }),
        adminActions: { "ok-action": async () => ({ ok: true, message: "" }) },
      },
    ];
    const registry = await buildAdminActionRegistry(augments);
    expect(registry.has("ok-action")).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests to verify failure**

Run: `bun test tests/transports/admin/admin-route.test.ts tests/transports/admin/admin-boot-validation.test.ts`

Expected: FAIL with module-not-found (`@/transports/admin/index`).

- [ ] **Step 7: Implement admin/index**

Create `src/transports/admin/index.ts`:

```ts
import type {
  AdminActionHandler,
  AdminActionInput,
  AdminActionResult,
  Augment,
  TransportKernel,
} from "../../types";
import { checkAdminAuth } from "./admin-auth";
import { coerceInputs } from "./admin-coerce";
import { generateCsrfToken, validateCsrfToken } from "./admin-csrf";
import { collectAdminInfoBlocks } from "./admin-collector";
import { renderAdminPage } from "./admin-renderer";

/**
 * S8 fix — action declaration registry. Built at boot time by
 * `buildAdminActionRegistry`. Replaces the runtime-bomb pattern (where
 * declared actions could lack handlers and only fail at first POST) AND
 * the double-adminInfo-call cost (where handleActionPost would invoke
 * adminInfo() again just to look up input coercion declarations).
 */
export interface AdminActionRegistryEntry {
  augmentName: string;
  handler: AdminActionHandler;
  inputs: AdminActionInput[];
  /** True for row-scoped actions (table rowActions). Affects URL parsing. */
  isRowAction: boolean;
}

export type AdminActionRegistry = ReadonlyMap<string, AdminActionRegistryEntry>;

export interface AdminRouteContext {
  kernel: TransportKernel;
  bearer: string;
  agentDir: string | undefined;
  callerIp: string;
  /** S8 — built once at boot by `buildAdminActionRegistry`. */
  actionRegistry: AdminActionRegistry;
}

const ACTION_ROUTE_RE = /^\/admin\/action\/([^/]+)(?:\/row\/([^/]+))?$/;

const EXPIRED_CSRF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session expired — redirecting</title>
  <meta http-equiv="refresh" content="0; url=/admin">
</head>
<body>
  <p>Session expired — refreshing the page now…</p>
  <p>If you are not redirected automatically, <a href="/admin">click here</a>.</p>
</body>
</html>`;

export async function handleAdminRoute(
  req: Request,
  ctx: AdminRouteContext,
): Promise<Response> {
  const url = new URL(req.url);
  const agentCard = ctx.kernel.getAgentCard();
  const agentName = agentCard.provider.name || "auggy";

  // Auth + HTTPS gate
  const auth = checkAdminAuth({
    req,
    bearer: ctx.bearer,
    agentName,
    callerIp: ctx.callerIp,
  });
  if (auth.kind === "https-required") return auth.response;
  if (auth.kind === "unauthorized") return auth.response;

  // GET /admin — render the dashboard
  if (req.method === "GET" && url.pathname === "/admin") {
    const blocks = await collectAdminInfoBlocks(ctx.kernel);
    const csrfToken = await generateCsrfToken({
      bearer: ctx.bearer,
      agentName,
      actionId: "__page",
    });
    const flashMessage = url.searchParams.get("msg") ?? undefined;
    const html = renderAdminPage({
      card: agentCard,
      blocks,
      csrfToken,
      flashMessage,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // POST /admin/action/<id>[/row/<rowKey>] — dispatch
  const actionMatch = url.pathname.match(ACTION_ROUTE_RE);
  if (req.method === "POST" && actionMatch) {
    return handleActionPost(req, ctx, actionMatch[1]!, actionMatch[2], agentName);
  }

  return new Response(null, { status: 404 });
}

async function handleActionPost(
  req: Request,
  ctx: AdminRouteContext,
  actionId: string,
  rowKey: string | undefined,
  agentName: string,
): Promise<Response> {
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  // S7 fix — CSRF validation distinguishes expired (graceful refresh) from
  // tampered/malformed (403).
  const csrfToken = form.get("_csrf") ?? "";
  const csrfResult = await validateCsrfToken({
    token: csrfToken,
    bearer: ctx.bearer,
    agentName,
    actionId,
    rowKey,
  });
  if (!csrfResult.valid) {
    if (csrfResult.reason === "expired") {
      // Browser auto-redirects to /admin, which renders fresh tokens.
      // Bearer (HTTP Basic) is still session-cached → no re-prompt needed.
      return new Response(EXPIRED_CSRF_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    // tampered or malformed → real CSRF attack indicator
    return new Response(null, { status: 403 });
  }

  // S8 fix — registry lookup replaces (a) the iterate-augments-for-handler
  // search and (b) the second adminInfo() call to retrieve input declarations.
  // Both now happen once at boot in buildAdminActionRegistry.
  const entry = ctx.actionRegistry.get(actionId);
  if (!entry) return new Response(null, { status: 404 });

  // Coerce inputs using the registered declaration
  const rawInputs: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (k !== "_csrf") rawInputs[k] = v;
  }
  const coerce = coerceInputs(entry.inputs, rawInputs);
  if (!coerce.ok) {
    return flashRedirect(`invalid ${coerce.field}: ${coerce.reason}`);
  }

  // Invoke handler, wrap in try/catch
  const params: Record<string, string> = { ...coerce.values };
  if (rowKey !== undefined) params.rowKey = rowKey;

  let result: AdminActionResult;
  try {
    result = await entry.handler(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] action ${actionId} threw: ${message}`);
    result = { ok: false, message: "internal error" };
  }

  // Audit log
  console.log(
    `[admin] actor=creator action=${actionId} rowKey=${rowKey ?? "-"} result=${
      result.ok ? "ok" : "fail"
    } message=${JSON.stringify(result.message)}`,
  );

  return flashRedirect(result.message);
}

function flashRedirect(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/admin?msg=${encodeURIComponent(message)}` },
  });
}

/**
 * S8 — Build the action-declaration registry at boot. Combines:
 *   1. Validation that every declared action has a matching handler
 *      (replaces the old validateAdminActions runtime-bomb check)
 *   2. Action-id uniqueness check across augments
 *   3. Registry construction so the request-time dispatcher doesn't need
 *      to re-call adminInfo() to find input declarations
 *
 * Throws on:
 *   - Declared action with no matching handler in adminActions
 *   - Same action-id declared by two different augments
 *
 * Skips augments whose adminInfo() throws at boot (logs warning); the
 * runtime collector will catch the throw and render an error block.
 */
export async function buildAdminActionRegistry(
  augments: readonly Augment[],
): Promise<AdminActionRegistry> {
  const registry = new Map<string, AdminActionRegistryEntry>();

  function register(
    augName: string,
    augActions: Record<string, AdminActionHandler> | undefined,
    actionId: string,
    inputs: AdminActionInput[],
    isRowAction: boolean,
  ): void {
    if (!augActions?.[actionId]) {
      throw new Error(
        `[admin] augment "${augName}" declares action "${actionId}" but does not provide an adminActions handler`,
      );
    }
    if (registry.has(actionId)) {
      const existing = registry.get(actionId)!;
      throw new Error(
        `[admin] action id "${actionId}" declared by multiple augments ("${existing.augmentName}" and "${augName}"); action ids must be globally unique`,
      );
    }
    registry.set(actionId, {
      augmentName: augName,
      handler: augActions[actionId],
      inputs,
      isRowAction,
    });
  }

  for (const aug of augments) {
    if (!aug.adminInfo) continue;
    let block;
    try {
      block = await aug.adminInfo();
    } catch (err) {
      console.warn(
        `[admin] augment "${aug.name}" adminInfo() threw during boot validation: ${
          err instanceof Error ? err.message : String(err)
        }. Skipping its action registration.`,
      );
      continue;
    }
    if (!block) continue;

    // Augment-level actions
    if (block.actions) {
      for (const a of block.actions) {
        register(aug.name, aug.adminActions, a.id, a.inputs ?? [], false);
      }
    }

    // Row actions from table sections + reset actions from keyValue sections
    for (const section of block.sections) {
      if (section.kind === "table" && section.rowActions) {
        for (const ra of section.rowActions) {
          register(aug.name, aug.adminActions, ra.id, [], true);
        }
      }
      if (section.kind === "keyValue") {
        for (const row of section.rows) {
          if (row.resetAction && !registry.has(row.resetAction.id)) {
            register(aug.name, aug.adminActions, row.resetAction.id, [], false);
          }
        }
      }
    }
  }

  return registry;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test tests/transports/admin/admin-route.test.ts tests/transports/admin/admin-boot-validation.test.ts`

Expected: PASS — all tests green.

- [ ] **Step 9: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: typecheck clean; lint baseline.

- [ ] **Step 10: Commit**

```bash
git add src/transports/admin/admin-coerce.ts src/transports/admin/index.ts tests/transports/admin/admin-route.test.ts tests/transports/admin/admin-boot-validation.test.ts
git commit -m "feat(admin): main route handler + boot-time validation (G36 phase 2)"
```

---

### Task 2.6: webTransport integration

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Wire the admin module into webTransport: add `adminRoute` option, dispatch GET/POST `/admin` + `/admin/action/*` (exact-match + scoped prefix, no startsWith leak), return 405 on HEAD, add `/admin` + `/admin/` to reserved-paths, build the action registry at boot via `buildAdminActionRegistry`. Also implements the `setAllowAnonymous` mutator + admin-overrides boot-load (used by Phase 3's webTransport adminInfo). Rate-limit per-IP across the entire `/admin*` surface (60/min) before dispatch.

- [ ] **Step 1: Write the failing integration tests**

Find the existing `webTransport / (root) route` describe block in `tests/transports/web-transport.test.ts`. AFTER that block, ADD:

```ts
describe("webTransport /admin route — basic dispatch (G36 phase 2)", () => {
  it("GET /admin without auth → 401", async () => {
    const model = createMockModel();
    const port = 19200;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/admin`);
      expect(resp.status).toBe(401);
      expect(resp.headers.get("www-authenticate")).toBe('Basic realm="auggy-admin zip"');
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("GET /admin with HTTP Basic bearer → 200 + HTML", async () => {
    const model = createMockModel();
    const port = 19201;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("<title>zip — admin</title>");
    } finally {
      await agent.stop();
    }
  });

  it("HEAD /admin → 405 with Allow: GET, POST", async () => {
    const model = createMockModel();
    const port = 19202;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, { method: "HEAD" });
      expect(resp.status).toBe(405);
      expect(resp.headers.get("allow")).toMatch(/GET/);
      expect(resp.headers.get("allow")).toMatch(/POST/);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("adminRoute: false → GET /admin returns 404", async () => {
    const model = createMockModel();
    const port = 19203;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      adminRoute: false,
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });

  it("augment cannot register route at /admin (reserved-paths collision)", async () => {
    const model = createMockModel();
    const port = 19204;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const conflicting: Augment = {
      name: "evil",
      httpRoutes: [
        {
          method: "GET",
          path: "/admin",
          auth: "none",
          handler: async () => new Response("evil"),
        },
      ],
    };
    const agent = defineAgent(
      { name: "zip", model: "mock", augments: [conflicting, aug] },
      model,
    );
    await expect(agent.start()).rejects.toThrow(/admin/i);
  });

  it("M3: /administrative falls through identically regardless of adminRoute setting", async () => {
    // adminRoute: true case
    const model1 = createMockModel();
    const aug1 = webTransport({ port: 19206, auth: { type: "bearer", token: "test-token" } });
    const agent1 = defineAgent({ name: "zip", model: "mock", augments: [aug1] }, model1);
    await agent1.start();
    let status1: number;
    try {
      const resp = await fetch(`http://127.0.0.1:19206/administrative`);
      status1 = resp.status;
      await resp.text();
    } finally {
      await agent1.stop();
    }

    // adminRoute: false case
    const model2 = createMockModel();
    const aug2 = webTransport({
      port: 19207,
      auth: { type: "bearer", token: "test-token" },
      adminRoute: false,
    });
    const agent2 = defineAgent({ name: "zip", model: "mock", augments: [aug2] }, model2);
    await agent2.start();
    let status2: number;
    try {
      const resp = await fetch(`http://127.0.0.1:19207/administrative`);
      status2 = resp.status;
      await resp.text();
    } finally {
      await agent2.stop();
    }

    // Both should be 404 (catch-all) — not 401 from admin auth-challenge.
    // If status1 === 401 here, the dispatch is using startsWith and leaks
    // adminRoute setting via the response code difference.
    expect(status1).toBe(404);
    expect(status2).toBe(404);
  });

  it("M4: 61st request in 60 seconds to /admin returns 429", async () => {
    const model = createMockModel();
    const port = 19208;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "zip", model: "mock", augments: [aug] }, model);
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      // Burst 60 requests; all should succeed
      const okPromises = Array.from({ length: 60 }, () =>
        fetch(`http://127.0.0.1:${port}/admin`, {
          headers: { authorization: `Basic ${basic}` },
        }),
      );
      const okResults = await Promise.all(okPromises);
      for (const r of okResults) {
        expect(r.status).toBe(200);
        await r.text();
      }
      // The 61st should be rate-limited
      const rl = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: `Basic ${basic}` },
      });
      expect(rl.status).toBe(429);
      expect(rl.headers.get("retry-after")).toBeDefined();
      await rl.text();
    } finally {
      await agent.stop();
    }
  });

  it("S7: expired CSRF token returns 200 + auto-refresh HTML (not 403)", async () => {
    const model = createMockModel();
    const port = 19209;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const handlerCalled = { count: 0 };
    const testAug: Augment = {
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [],
        actions: [{ id: "test-action", label: "X", confirmRequired: false }],
      }),
      adminActions: {
        "test-action": async () => {
          handlerCalled.count++;
          return { ok: true, message: "fired" };
        },
      },
    };
    const agent = defineAgent(
      { name: "zip", model: "mock", augments: [testAug, aug] },
      model,
    );
    await agent.start();
    try {
      const basic = Buffer.from(":test-token").toString("base64");
      // Generate a token bound to an expired timestamp
      const { generateCsrfToken } = await import("@/transports/admin/admin-csrf");
      const expiredTs = Math.floor((Date.now() - 25 * 3600 * 1000) / 1000);
      const expiredToken = await generateCsrfToken({
        bearer: "test-token",
        agentName: "zip",
        actionId: "test-action",
        _timestamp: expiredTs,
      });
      const resp = await fetch(`http://127.0.0.1:${port}/admin/action/test-action`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: expiredToken }).toString(),
      });
      // S7: graceful HTML page with meta-refresh, NOT 403.
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("Session expired");
      expect(body).toContain('http-equiv="refresh"');
      // Handler was NOT invoked
      expect(handlerCalled.count).toBe(0);
    } finally {
      await agent.stop();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/web-transport.test.ts -t "/admin route"`

Expected: FAIL (admin route not yet wired; 401 + HTML test will pass coincidentally if any earlier code 401s, but the HEAD/405 and adminRoute:false and reserved-path-collision tests will fail).

- [ ] **Step 3: Add `adminRoute` option to `WebTransportOptions`**

In `src/transports/web-transport.ts`, find the `WebTransportOptions` interface declaration. ADD:

```ts
  /**
   * G36 — opt-out flag for the built-in /admin route. Default: `true`.
   * When `false`, GET/POST /admin and POST /admin/action/* all return 404.
   * Useful for: embedded/headless deploys, operators with a custom admin,
   * security-conscious deploys that don't want HTTP-Basic-over-Bearer.
   */
  adminRoute?: boolean;
```

- [ ] **Step 4: Add `/admin` + `/admin/*` prefix to reserved-paths collision check (M2 + S9 fix)**

In `src/transports/web-transport.ts`, find the existing reserved-paths collision check. (Search: `reserved` or look at how `augmentRouteMap.set(...)` is followed by collision detection — should be in the register() function or in agent-startup code.)

The existing reserved-paths likely live in a constant like:

```ts
const RESERVED_PATHS = ["/", "/agent/run", "/health", "/.well-known/agent-card.json"];
```

**Replace with a two-tier check** — exact paths AND a prefix list — so augments cannot register at `/admin`, `/admin/action/notify-test`, or any other `/admin/*` path:

```ts
const RESERVED_EXACT_PATHS = [
  "/",
  "/agent/run",
  "/health",
  "/.well-known/agent-card.json",
  "/admin",
];
const RESERVED_PREFIXES = ["/admin/"]; // disallow anything under /admin/

function checkReservedPath(path: string): string | null {
  if (RESERVED_EXACT_PATHS.includes(path)) return path;
  for (const prefix of RESERVED_PREFIXES) {
    if (path.startsWith(prefix)) return prefix + "*";
  }
  return null;
}

// In the existing collision-check loop:
for (const r of augmentRoutes) {
  const reserved = checkReservedPath(r.path);
  if (reserved !== null) {
    throw new Error(
      `[web-transport] augment "${r.augmentName}" registered ${r.method} ${r.path}, ` +
        `but ${reserved} is reserved for the built-in route. Choose a non-reserved path.`,
    );
  }
}
```

S9 fix: without the prefix block, an augment could `httpRoutes: [{ path: "/admin/action/notify-test", ... }]` — boot would succeed silently, and at runtime the admin dispatch intercepts before the augment route fires, leaving the augment author with a dead route. The prefix block fires a boot-time error.

The integration test in Step 1's "augment cannot register route at /admin" verifies this works. Consider also adding a test case for `/admin/action/foo` collision:

```ts
it("augment cannot register route at /admin/action/* (M3+S9 reserved prefix)", async () => {
  const model = createMockModel();
  const aug = webTransport({ port: 19205, auth: { type: "bearer", token: "test-token" } });
  const conflicting: Augment = {
    name: "evil",
    httpRoutes: [
      {
        method: "POST",
        path: "/admin/action/notify-test",
        auth: "none",
        handler: async () => new Response("evil"),
      },
    ],
  };
  const agent = defineAgent(
    { name: "zip", model: "mock", augments: [conflicting, aug] },
    model,
  );
  await expect(agent.start()).rejects.toThrow(/admin/i);
});
```

- [ ] **Step 5: Add `setAllowAnonymous` mutator + boot-load overrides**

In `src/transports/web-transport.ts`, in the section where `allowAnonymous` is resolved (look for `allowAnonymousResolution` from G3 work):

```ts
// Existing G3 resolution (don't change):
const allowAnonymousResolution = resolveConfigBool(
  opts.allowAnonymous,
  "AUGGY_ALLOW_ANONYMOUS",
  () => process.env.NODE_ENV !== "production",
);
let allowAnonymous = allowAnonymousResolution.value;
```

After it, ADD:

```ts
// G36 — apply admin-overrides on top of yaml/env/default
import { readOverrides } from "../lib/admin-overrides";

const overrides = readOverrides(opts.agentDir);
if (overrides?.overrides.webTransport?.allowAnonymous !== undefined) {
  allowAnonymous = overrides.overrides.webTransport.allowAnonymous;
  // Future: track this in allowAnonymousResolution.source = "admin-override"
  // for the Phase 3 adminInfo display.
}

// Mutator used by Phase 3's posture-flip action.
function setAllowAnonymous(value: boolean): void {
  allowAnonymous = value;
}
```

Note: `opts.agentDir` may not exist on `WebTransportOptions` yet — the spec calls for it. Add it as an optional field if not present:

```ts
  /** G36 — path to the agent's directory for admin-overrides.json read/write. */
  agentDir?: string;
```

The CLI's `resolveConfig` should populate this from `~/.auggy/agents/<name>/` when scaffolded. If the CLI doesn't yet pass it, leave the field optional; readOverrides handles `undefined` gracefully (Phase 1 Task 1.3).

- [ ] **Step 6: Dispatch GET /admin, POST /admin/action/*, HEAD /admin from the main fetch handler**

In `src/transports/web-transport.ts`, find the main `Bun.serve({ fetch })` handler. After the existing `GET /` block (G2's info-endpoint dispatch) and BEFORE the agent-route handling, INSERT:

```ts
import {
  type AdminActionRegistry,
  buildAdminActionRegistry,
  handleAdminRoute,
} from "./admin/index";

// G36 — /admin route. Opt-out via adminRoute: false makes the route look
// like a 404 (no signal that admin exists when disabled). Exact-match on
// "/admin" + scoped prefix on "/admin/action/" — NOT startsWith("/admin")
// which would also match /administrative and leak the opt-out setting (M3 fix).
const adminEnabled = opts.adminRoute !== false;
const isAdminPath =
  url.pathname === "/admin" || url.pathname.startsWith("/admin/action/");

if (adminEnabled && isAdminPath) {
  if (req.method === "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }

  // M4 fix — rate-limit BEFORE handling. Per-IP combined budget across the
  // entire /admin* surface: 60 req/min via synthetic route-key "admin".
  // Spec mandate; defeats brute-force against HTTP Basic.
  const ip = getCallerIp(req, server, trustedProxies, xffOnUntrusted);
  const rl = checkRouteRateLimit("admin", ip, 60);
  if (!rl.allowed) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(rl.retryAfterSec) },
    });
  }

  return handleAdminRoute(req, {
    kernel,
    bearer: opts.auth.token,
    agentDir: opts.agentDir,
    callerIp: ip,
    actionRegistry,
  });
}
```

(`kernel`, `server`, `trustedProxies`, `xffOnUntrusted`, `checkRouteRateLimit` are existing closure-captured references / helpers — ensure they're in scope. `actionRegistry` is populated in `register()` via Step 7 below.)

- [ ] **Step 7: Boot-time action registry in `register()` (S8)**

In `src/transports/web-transport.ts`, near the top of the file with other module-level state, add a closure variable:

```ts
import {
  type AdminActionRegistry,
  buildAdminActionRegistry,
  handleAdminRoute,
} from "./admin/index";

// G36 — populated at register time. Empty Map until then.
let actionRegistry: AdminActionRegistry = new Map();
```

In the `register()` function (the kernel-handed-to-transport entry point), AFTER kernel is captured, build the registry:

```ts
register: async (k) => {
  kernel = k;
  // existing logic ...

  // G36 — build the action registry from declared adminInfo + adminActions.
  // buildAdminActionRegistry throws on:
  //   - declared action with no matching handler
  //   - same action-id declared by multiple augments
  // Surface fires at boot, not at first POST (M5).
  if (opts.adminRoute !== false) {
    actionRegistry = await buildAdminActionRegistry(k.getAugments());
  }
},
```

The dispatch block in Step 6 already passes `actionRegistry` into the admin route context.

- [ ] **Step 8: Run integration tests**

Run: `bun test tests/transports/web-transport.test.ts -t "/admin route"`

Expected: all 5 admin-dispatch tests pass.

- [ ] **Step 9: Run full test suite for regressions**

Run: `bun test`

Expected: all green. The agent-startup tests should still pass; new tests added; no regressions.

- [ ] **Step 10: Typecheck + lint**

```bash
bunx tsc --noEmit
bun run lint
```

Expected: clean; baseline preserved.

- [ ] **Step 11: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): dispatch /admin route + reserved paths + 405 HEAD (G36 phase 2)"
```

---

## Phase 2 — End-of-phase verification

After Tasks 2.1 through 2.6 are complete:

- [ ] **Full test suite**: `bun test` — should pass, with ~50-60 new tests added.
- [ ] **Typecheck**: `bunx tsc --noEmit` — clean.
- [ ] **Lint**: `bun run lint` — baseline preserved (0 errors).
- [ ] **Manual smoke**: boot any agent with the new code; `curl -u :$AUGGY_WEB_TOKEN http://localhost:8080/admin` should return an HTML dashboard with no augment blocks (Phase 3 will populate them) and a footer + meta tags.
- [ ] **Manual smoke**: `curl -I http://localhost:8080/admin` returns 405 with `Allow: GET, POST`.

## Phase 2 → Phase 3 handoff

When Phase 2 is complete:
- 6 new commits on the Phase 2 branch
- Admin route is wired but the dashboard renders empty (no augments declare `adminInfo` yet)
- Boot-time validation is active but vacuously passes (no actions declared)

Phase 3 (per-augment adminInfo + actions) consumes:
- `AdminInfoBlock` types from Phase 1
- `buildAdminActionRegistry` discipline from this phase (each augment must provide handlers for what it declares; action-ids are globally unique)
- `setAllowAnonymous` mutator (Phase 3's webTransport adminInfo posture-flip uses this)
- `readOverrides` / `writeOverrides` from Phase 1 (each augment with persistent knobs reads + writes through these)

Begin Phase 3 by writing `docs/superpowers/plans/2026-05-19-g36-phase-3-per-augment.md`.

## Out-of-plan / known limits for Phase 2

- **CSRF token for the GET /admin page itself** uses a sentinel `actionId="__page"`. Forms render with action-specific tokens. The `__page` token is essentially unused; reserve for future "refresh dashboard" CSRF if needed.
- **303 See Other** redirect for action completion (not 302) — chosen for explicit "method-changing redirect" semantics per RFC 7231 §6.4.4. Browsers follow with GET; the result is the same as 302 in practice but more semantically correct.
- **No CSRF validation for GET /admin** — only writes (POST) require CSRF. Reads are safe by HTTP semantics + the HTTP Basic gate.
- **No request-body size cap on /admin/action/* POST** — relying on Bun's default. Form inputs are small (numbers, booleans, short strings); a body-cap is over-engineering. Revisit if abuse patterns emerge.
- **Audit log uses console.log** — structured event in a single line. Dedicated audit-log file is a Tier-2 follow-up.
- **No active CSRF rotation** — token is generated fresh per page render; the operator's session uses the latest. Rotating tokens within a single page load (e.g., after every action) is out of scope; not needed for v1.0 single-operator scenarios.

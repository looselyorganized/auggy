# PR γ.1 — webTransport Route Extension Implementation Plan

> **✅ SHIPPED 2026-05-07** (PR γ.1, webTransport route registration). This plan is historical reference; not actionable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the augment system so any augment can register HTTP routes that the `webTransport` augment serves alongside its four built-in paths. This is the foundational primitive that unblocks PR γ.2 (`visitorAuth` magic-link verify endpoint) and any future augment that needs an inbound HTTP surface beyond `/agent/run`.

**Architecture:** Route collection happens **once** at `agent.start()`, after `lifecycle.boot()` succeeds and before the transport-registration loop begins, when every augment's `onBoot` has run and `httpRoutes` is fully populated. Routes are exposed to transports via a new `TransportKernel.getAugmentRoutes()` method returning a frozen array. `webTransport`'s fetch handler dispatches built-in paths first, then augment routes by exact (method, path) match, then 404. Path-collision detection (against built-in paths AND across augments) throws at `agent.start()` BEFORE any transport binds a port — fail-safe. Per-route security knobs (`auth: "bearer" | "none"`, optional sliding-window rate limit) are explicit per route; the **default** is `bearer` so auth-none is always an opt-in audit trail.

**Tech Stack:** TypeScript, Bun (`Bun.serve`), `bun:test`. Zero new runtime dependencies.

**Spec:** [`lo/docs/superpowers/specs/2026-05-06-pr-gamma-visitor-auth-magic-link-design.md`](../../../../docs/superpowers/specs/2026-05-06-pr-gamma-visitor-auth-magic-link-design.md) — see "Prerequisites — PR γ.1: webTransport route extension" section.

---

## Reference context for the engineer

Read these files first to understand the existing kernel surface this PR extends:

- `src/types.ts` — augment + transport contracts. The `Augment` interface (line ~667) and `TransportKernel` interface (line ~547) are extended in this PR.
- `src/agent.ts` (lines 79–181) — the `start()` flow. **Critical:** `lifecycle.boot()` is awaited at line 81; the transport-registration loop runs at lines 84–164. The route-collection wiring point sits between those two — after boot, before any transport binds.
- `src/transports/web-transport.ts` (lines 512–541) — the `Bun.serve` fetch handler. The dispatcher hardcodes four built-in routes today; this PR inserts augment-route dispatch between the built-ins and the 404 fallback.
- `src/kernel/lifecycle-manager.ts` — `boot()` runs every augment's `onBoot` in declaration order (errors propagate). The route-collection step does NOT run inside lifecycle; it runs in `agent.start()`.
- `tests/transports/web-transport.test.ts` — existing test patterns: a `mockKernel`, a real `Bun.serve` started by the test, `fetch()` against the port. Mirror this style for new tests.
- `tests/integration/full-agent.test.ts` — full-agent test fixtures (real defineAgent + mock model + real webTransport on a free port). Mirror for the integration consumer.

## Threat model & security defaults

This PR introduces a **new attack surface**: augments can now serve arbitrary HTTP. Hardening choices baked into the contract:

| Concern | Mitigation in this PR |
|---|---|
| **Augment shadows a built-in path** (e.g., registers `/agent/run` and intercepts AG-UI traffic) | Boot-time collision detection. Built-in paths reserved; collisions throw before any port binds. |
| **Two augments register the same path** (silent override) | Boot-time collision detection across augments; throws. |
| **Operator forgets to gate a route, gets unauthenticated traffic** | `auth` is a **required** field on `AugmentHttpRoute` — no implicit default. Operators write `auth: "bearer"` or `auth: "none"` deliberately. (Why required, not optional-defaulting-to-bearer: discoverability. Reading a route declaration tells you the auth mode at a glance.) |
| **Audit invisibility of `auth: "none"` routes** | Boot logs every `auth: "none"` route at `console.warn` level. Operators can't miss them. |
| **Augment route handler hangs** (Bun.serve has a 120s `idleTimeout` already, but slow handlers eat connection slots) | Per-route handler executes inside a 30s `Promise.race` timeout (configurable). Times out → 504 Gateway Timeout. |
| **Augment route handler throws** | Wrapped in try/catch. Returns 500 + opaque `{ "error": "internal" }` body. Original error logged via `console.error` with the route path for triage; never surfaced in the response. |
| **Route handler attempts to read very large request body** | Per-route optional `maxBodyBytes` (default 1 MB). The dispatcher reads `req` headers' `content-length`; over the cap → 413 before invoking the handler. Handlers that need bigger payloads opt in deliberately. |
| **Per-route abuse via flood** | Per-route optional `rateLimit: { maxPerMinute }`. In-memory sliding window. **Not per-peer** (auth-none routes have no peer); per-route global. Returns 429 with `Retry-After`. |
| **Method confusion** (GET on a POST-only route returns the wrong response) | Method must match exactly. Method mismatch → 405 with `Allow:` header. |
| **HTTPMethod surface** | v1 supports `GET` and `POST` only. PUT/DELETE/PATCH deferred — no current consumer needs them; reducing surface reduces audit cost. |

## Non-goals for this PR

These are deliberately out of scope; flag them in code comments where adjacent:

- Custom auth schemes beyond `bearer | none` (operators wrap handlers for OAuth/HMAC/etc.)
- WebSocket route registration (HTTP only)
- Multi-transport HTTP route routing (only `webTransport` consumes routes; future HTTP-capable transports declare opt-in)
- Path patterns / parameters (e.g., `/items/:id`) — exact match only at v1
- Streaming response support (SSE) — handlers return discrete `Response` objects; AG-UI's SSE stays exclusive to `/agent/run`
- Dynamic route registration after boot — routes are frozen at `agent.start()`
- Per-handler middleware chain — augments compose middleware in their own handler if they want it

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify (insert in transport section near line 568) | Add `HttpMethod` type, `AugmentHttpRoute` interface, and optional `httpRoutes` field on `Augment`. Extend `TransportKernel` with `getAugmentRoutes()`. |
| `src/kernel/route-collector.ts` | Create | Pure function `collectAugmentRoutes(augments) → { routes, errors }` — gathers, validates, freezes. Used by `agent.start()`. Tested in isolation. |
| `tests/kernel/route-collector.test.ts` | Create | Unit tests for collection + validation logic (reserved-path rejection, cross-augment collisions, empty inputs, method/path normalization). |
| `src/agent.ts` | Modify (~5 lines around line 81) | After `lifecycle.boot()`, call `collectAugmentRoutes` and stash the frozen array; expose via the per-transport `TransportKernel` object. Throw on collision before transport-registration loop. |
| `src/transports/web-transport.ts` | Modify (~30 LOC inserted in fetch handler around line 540, plus boot logging) | Consume `kernel.getAugmentRoutes()` at boot. Dispatch augment routes after built-ins, before 404. Wrap handlers in auth check, body-size check, timeout, try/catch. Log `auth: "none"` routes at boot. |
| `tests/transports/web-transport.test.ts` | Modify | Add tests for: augment-route dispatch (GET + POST), bearer auth pass/fail, auth-none works, method mismatch → 405, unknown path → 404, handler throws → 500, handler hangs → 504, body-size cap → 413, rate-limit → 429. |
| `tests/fixtures/test-route-augment.ts` | Create | Tiny fixture augment exposing one `GET /test/echo` route returning `{echo: <query>}`. Used by both transport unit tests and the full-agent integration test. |
| `tests/integration/full-agent.test.ts` | Modify | Add one end-to-end test: defineAgent with web + the fixture augment, agent.start(), fetch the route, assert response. Plus a negative test for cross-augment collision throwing at start(). |

---

## Task 1: Type definitions for `AugmentHttpRoute`

**Files:**
- Modify: `src/types.ts` — insert near line 568 (transport section), and extend `Augment` (line 667) + `TransportKernel` (line 547)

- [ ] **Step 1: Add `HttpMethod` type and `AugmentHttpRoute` interface**

In `src/types.ts`, find the comment `// === Transport (spec §3) ===` (around line 545). Insert AFTER the `TransportSpec` interface (which ends near line 568), BEFORE `// === Turn Gate (2PC admission) ===`:

```ts
// === Augment HTTP routes (PR γ.1) ===

/**
 * HTTP methods supported by augment-registered routes.
 *
 * v1 limits to GET + POST. PUT/DELETE/PATCH deferred — no current consumer
 * needs them, and a smaller surface reduces audit cost. Add on demand.
 */
export type HttpMethod = "GET" | "POST";

/**
 * Authentication mode for an augment-registered HTTP route.
 *
 * - `"bearer"` — the route inherits webTransport's bearer-token check (same
 *   token that gates `/agent/run`). Recommended default for any route that
 *   represents creator-driven action.
 * - `"none"` — the route accepts any caller. Opt-in only; required for
 *   public callbacks like email magic-link clicks (PR γ.2 visitorAuth) where
 *   the visitor can't supply a bearer token. Boot logs a warning per
 *   `auth: "none"` route so operators can't miss them.
 */
export type AugmentHttpRouteAuth = "bearer" | "none";

/**
 * One HTTP route registered by an augment. Routes are collected at
 * `agent.start()` AFTER `lifecycle.boot()` succeeds (so `onBoot`-populated
 * route lists are visible) and BEFORE any transport binds a port. Path
 * collisions (vs built-in paths or across augments) throw at `agent.start()`,
 * never silently override.
 */
export interface AugmentHttpRoute {
  method: HttpMethod;
  /**
   * Exact-match path. v1 does not support patterns or parameters.
   * Must start with `/`. Reserved paths (cannot be registered):
   *   - "/"
   *   - "/agent/run"
   *   - "/health"
   *   - "/.well-known/agent-card.json"
   * Convention: scope under `/<augment-name>/...` to make collisions unlikely.
   */
  path: string;
  /** Auth mode is required — no implicit default; forces deliberate choice. */
  auth: AugmentHttpRouteAuth;
  /**
   * Optional per-route handler timeout in milliseconds. Default 30_000.
   * Times out → 504. Independent from Bun.serve's connection idleTimeout.
   */
  timeoutMs?: number;
  /**
   * Optional max body bytes the dispatcher will accept. Default 1_048_576 (1 MB).
   * Over cap → 413 before the handler runs (checked via `content-length` header).
   */
  maxBodyBytes?: number;
  /**
   * Optional sliding-window rate limit per route (NOT per peer — auth-none
   * routes have no peer). Returns 429 with `Retry-After` when triggered.
   */
  rateLimit?: {
    maxPerMinute: number;
  };
  /**
   * The handler. Receives the raw Request, returns a Response. Errors thrown
   * are caught by the dispatcher and surfaced as 500 with an opaque body;
   * the actual error is logged with the route path for triage.
   */
  handler: (req: Request) => Promise<Response>;
}
```

- [ ] **Step 2: Add `httpRoutes?: AugmentHttpRoute[]` to `Augment`**

In the same file, find `export interface Augment` (around line 667). Insert AFTER `transport?: TransportSpec;` (line 675), BEFORE `memory?: MemoryProviderSpec;`:

```ts
  /**
   * HTTP routes the augment serves on any HTTP-capable transport (today: webTransport).
   * Collected at `agent.start()` after `onBoot` runs; immutable thereafter.
   * See `AugmentHttpRoute` for the contract.
   */
  httpRoutes?: AugmentHttpRoute[];
```

- [ ] **Step 3: Extend `TransportKernel` with `getAugmentRoutes()`**

In the same file, find `export interface TransportKernel` (around line 547). Add a new method after `getAgentCard()`:

```ts
export interface TransportKernel {
  handleInbound(
    trigger: TurnTrigger,
    options?: { onEvent?: KernelEventHandler },
  ): Promise<TurnResult>;
  onOutbound(callback: (peer: PeerIdentity, message: OutboundMessage) => Promise<void>): void;
  getAgentCard(): AgentCard;
  /**
   * Cross-augment HTTP routes collected at `agent.start()` after
   * `lifecycle.boot()`. Returns a frozen array — transports MUST NOT mutate.
   * Transports that don't speak HTTP simply ignore this method.
   */
  getAugmentRoutes(): readonly AugmentHttpRoute[];
}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bunx tsc --noEmit 2>&1 | grep -v "^chat/"`
Expected: PASS — these are additive type changes; nothing references them yet.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): AugmentHttpRoute + httpRoutes field + TransportKernel.getAugmentRoutes"
```

---

## Task 2: Route collector — pure validator/aggregator

**Files:**
- Create: `src/kernel/route-collector.ts`
- Create: `tests/kernel/route-collector.test.ts`

The collector is a pure function that takes the augment list, gathers `httpRoutes`, validates them against the reserved paths and against each other, and returns a frozen array. It throws nothing; it returns a `{ routes, errors }` shape and `agent.start()` decides whether to throw based on `errors.length`. This separation means the collector is exhaustively testable in isolation and the throw semantics live in `agent.start()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/kernel/route-collector.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { collectAugmentRoutes, RESERVED_PATHS } from "../../src/kernel/route-collector";
import type { Augment, AugmentHttpRoute } from "../../src/types";

function aug(name: string, routes: AugmentHttpRoute[]): Augment {
  return { name, httpRoutes: routes };
}

function route(method: "GET" | "POST", path: string, auth: "bearer" | "none" = "bearer"): AugmentHttpRoute {
  return { method, path, auth, handler: async () => new Response("ok") };
}

describe("collectAugmentRoutes", () => {
  test("returns empty array for augments with no httpRoutes", () => {
    const result = collectAugmentRoutes([{ name: "a" }, { name: "b" }]);
    expect(result.routes).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("collects routes from all augments preserving declaration order", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/a/x"), route("POST", "/a/y")]),
      aug("b", [route("GET", "/b/z")]),
    ]);
    expect(result.routes.map((r) => r.path)).toEqual(["/a/x", "/a/y", "/b/z"]);
    expect(result.errors).toEqual([]);
  });

  test("rejects routes whose path collides with a reserved built-in", () => {
    const result = collectAugmentRoutes([
      aug("hijack", [route("POST", "/agent/run")]),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("hijack");
    expect(result.errors[0]).toContain("/agent/run");
    expect(result.errors[0]).toContain("reserved");
  });

  test("rejects all four reserved paths", () => {
    for (const path of RESERVED_PATHS) {
      const result = collectAugmentRoutes([aug("a", [route("GET", path)])]);
      expect(result.errors[0]).toContain(path);
    }
  });

  test("rejects two augments registering the same (method, path)", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/shared")]),
      aug("b", [route("GET", "/shared")]),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("a");
    expect(result.errors[0]).toContain("b");
    expect(result.errors[0]).toContain("/shared");
  });

  test("allows the same path with different methods (GET + POST)", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/x"), route("POST", "/x")]),
    ]);
    expect(result.routes).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("rejects path that does not start with '/'", () => {
    const result = collectAugmentRoutes([aug("a", [route("GET", "no-slash" as any)])]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("must start with '/'");
  });

  test("rejects empty path", () => {
    const result = collectAugmentRoutes([aug("a", [route("GET", "")])]);
    expect(result.errors).toHaveLength(1);
  });

  test("collects multiple errors, does not stop at first", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/agent/run")]),
      aug("b", [route("GET", "/health")]),
      aug("c", [route("GET", "/x"), route("GET", "/x")]),
    ]);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  test("returned routes array is frozen (cannot be mutated by transports)", () => {
    const result = collectAugmentRoutes([aug("a", [route("GET", "/x")])]);
    expect(Object.isFrozen(result.routes)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/kernel/route-collector.test.ts`
Expected: FAIL with `Cannot find module '../../src/kernel/route-collector'`.

- [ ] **Step 3: Implement the collector**

Create `src/kernel/route-collector.ts`:

```ts
/**
 * Route collector — pure aggregator + validator for augment-registered HTTP routes.
 *
 * Called once at `agent.start()` after `lifecycle.boot()` so `onBoot`-populated
 * route lists are visible. Returns a frozen array of routes plus a list of
 * validation errors. The caller (`agent.start()`) is responsible for deciding
 * whether to throw based on `errors.length` — this module does not throw.
 *
 * Why a separate pure module: exhaustive validation is easier to test in
 * isolation than inside the start() flow, and reusing the same collector in
 * tests keeps the contract honest.
 */

import type { Augment, AugmentHttpRoute } from "../types";

/**
 * Paths reserved by webTransport. Augments that try to register these get
 * a validation error. Order matches webTransport's own dispatch order.
 */
export const RESERVED_PATHS: readonly string[] = Object.freeze([
  "/",
  "/agent/run",
  "/health",
  "/.well-known/agent-card.json",
]);

export interface CollectedRoute extends AugmentHttpRoute {
  /** Augment name that registered this route — for error messages and logging. */
  augmentName: string;
}

export interface CollectAugmentRoutesResult {
  /** Frozen array of valid routes, preserving augment declaration order. */
  routes: readonly CollectedRoute[];
  /** Human-readable error messages — one per validation failure. */
  errors: readonly string[];
}

export function collectAugmentRoutes(augments: readonly Augment[]): CollectAugmentRoutesResult {
  const routes: CollectedRoute[] = [];
  const errors: string[] = [];
  // (method, path) → first augment to register it; second registrant errors.
  const seen = new Map<string, string>();

  for (const aug of augments) {
    if (!aug.httpRoutes || aug.httpRoutes.length === 0) continue;

    for (const r of aug.httpRoutes) {
      // Path shape validation
      if (typeof r.path !== "string" || r.path.length === 0) {
        errors.push(
          `Augment "${aug.name}" registered an HTTP route with empty path.`,
        );
        continue;
      }
      if (!r.path.startsWith("/")) {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" — path must start with '/'.`,
        );
        continue;
      }

      // Reserved-path collision
      if (RESERVED_PATHS.includes(r.path)) {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" — that path is reserved by webTransport.`,
        );
        continue;
      }

      // Cross-augment collision (same method + same path)
      const key = `${r.method} ${r.path}`;
      const firstAug = seen.get(key);
      if (firstAug) {
        errors.push(
          `Augments "${firstAug}" and "${aug.name}" both registered HTTP route ${r.method} "${r.path}". Path collisions are not allowed.`,
        );
        continue;
      }
      seen.set(key, aug.name);

      routes.push({ ...r, augmentName: aug.name });
    }
  }

  return {
    routes: Object.freeze(routes) as readonly CollectedRoute[],
    errors: Object.freeze(errors) as readonly string[],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/kernel/route-collector.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/kernel/route-collector.ts tests/kernel/route-collector.test.ts
git commit -m "feat(kernel): route collector with reserved-path + cross-augment collision detection"
```

---

## Task 3: Wire route collection into `agent.start()`

**Files:**
- Modify: `src/agent.ts`
- Create: `tests/kernel/agent-route-wiring.test.ts`

`agent.start()` runs the collector after `lifecycle.boot()` succeeds. If errors exist, it throws BEFORE the transport-registration loop begins (so no port binds with broken state). The collected routes are exposed on each `TransportKernel` via the new `getAugmentRoutes()` method.

- [ ] **Step 1: Write the failing test**

Create `tests/kernel/agent-route-wiring.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test";
import { defineAgent } from "../../src/agent";
import type { Augment, AugmentHttpRoute, ModelClient } from "../../src/types";

function mockModel(): ModelClient {
  return {
    name: "mock",
    maxContextTokens: 100_000,
    complete: async () => ({
      finishReason: "end_turn",
      message: { role: "assistant", content: [{ kind: "text", text: "" }] },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as ModelClient;
}

function routeAug(name: string, routes: AugmentHttpRoute[]): Augment {
  return { name, httpRoutes: routes };
}

function r(method: "GET" | "POST", path: string): AugmentHttpRoute {
  return { method, path, auth: "bearer", handler: async () => new Response("ok") };
}

describe("agent.start() route wiring", () => {
  test("throws when two augments register the same route", async () => {
    const agent = defineAgent(
      {
        name: "test",
        purpose: "test",
        model: "mock",
        augments: [routeAug("a", [r("GET", "/x")]), routeAug("b", [r("GET", "/x")])],
      },
      mockModel(),
    );
    await expect(agent.start()).rejects.toThrow(/both registered HTTP route/);
  });

  test("throws when an augment registers a reserved path", async () => {
    const agent = defineAgent(
      {
        name: "test",
        purpose: "test",
        model: "mock",
        augments: [routeAug("hijack", [r("POST", "/agent/run")])],
      },
      mockModel(),
    );
    await expect(agent.start()).rejects.toThrow(/reserved/);
  });

  test("error message lists ALL collisions, not just the first", async () => {
    const agent = defineAgent(
      {
        name: "test",
        purpose: "test",
        model: "mock",
        augments: [
          routeAug("a", [r("GET", "/agent/run")]),
          routeAug("b", [r("GET", "/health")]),
        ],
      },
      mockModel(),
    );
    let err: Error | null = null;
    try {
      await agent.start();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("/agent/run");
    expect(err!.message).toContain("/health");
  });

  test("no augments with httpRoutes — start succeeds", async () => {
    const agent = defineAgent(
      { name: "test", purpose: "test", model: "mock", augments: [] },
      mockModel(),
    );
    await agent.start();
    await agent.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/kernel/agent-route-wiring.test.ts`
Expected: FAIL — currently `agent.start()` doesn't validate routes.

- [ ] **Step 3: Modify `src/agent.ts`**

At the top of `src/agent.ts`, add the import:

```ts
import { collectAugmentRoutes } from "./kernel/route-collector";
import type { CollectedRoute } from "./kernel/route-collector";
```

In the `start()` method (currently starts at line 79), insert the route-collection step IMMEDIATELY AFTER `await lifecycle.boot();` (line 81) and BEFORE the `for (const aug of effectiveAugments)` transport loop (line 84):

```ts
      if (started) throw new Error("Agent already started. Call stop() first.");
      await lifecycle.boot();

      // Collect augment-registered HTTP routes AFTER boot so onBoot-populated
      // route lists are visible, BEFORE any transport binds a port so a
      // collision can't leave the agent half-bound.
      const collected = collectAugmentRoutes(effectiveAugments);
      if (collected.errors.length > 0) {
        // Run shutdown to undo the boot side-effects we just performed
        // (otherwise SQLite handles, file watchers, etc. leak).
        try {
          await lifecycle.shutdown();
        } catch {
          // best-effort; original error wins
        }
        throw new Error(
          `Cannot start agent — augment HTTP route validation failed:\n  ` +
            collected.errors.join("\n  "),
        );
      }
      const augmentRoutes: readonly CollectedRoute[] = collected.routes;

      // Register transport augments
      for (const aug of effectiveAugments) {
```

In the `transportKernel` object literal (lines 92–162), add the new method alongside `handleInbound`, `onOutbound`, `getAgentCard`:

```ts
            getAgentCard() {
              return agentCard;
            },
            getAugmentRoutes() {
              return augmentRoutes;
            },
          };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/kernel/agent-route-wiring.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the broader kernel tests to confirm no regression**

Run: `bun test tests/kernel/ tests/integration/full-agent.test.ts`
Expected: PASS — agent.start()'s new validation step is no-op for existing tests (no augments declare httpRoutes yet).

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts tests/kernel/agent-route-wiring.test.ts
git commit -m "feat(agent): collect augment HTTP routes at start(), throw on validation errors"
```

---

## Task 4: Test fixture — `routeFixtureAugment`

**Files:**
- Create: `tests/fixtures/route-fixture-augment.ts`

Tiny augment used by webTransport tests (Task 5+) and the integration test (Task 11) to exercise the dispatch path end-to-end. Lives in fixtures so it doesn't pollute `src/`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/route-fixture-augment.ts`:

```ts
/**
 * Test fixture — minimal augment that registers a single HTTP route.
 * Used by tests/transports/web-transport.test.ts and
 * tests/integration/full-agent.test.ts to exercise augment-route dispatch
 * end-to-end without dragging in a real consumer (visitorAuth, etc.).
 *
 * Not exported from src/index.ts — this module exists only for tests.
 */

import type { Augment, AugmentHttpRoute, AugmentHttpRouteAuth, HttpMethod } from "../../src/types";

export interface RouteFixtureOptions {
  name?: string;
  method?: HttpMethod;
  path?: string;
  auth?: AugmentHttpRouteAuth;
  handler?: (req: Request) => Promise<Response>;
  rateLimit?: { maxPerMinute: number };
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Build a one-route augment for tests. Defaults to a `GET /test/echo` route
 * that returns `{echo: <query.msg ?? "">}` as JSON. All fields can be
 * overridden.
 */
export function routeFixtureAugment(opts: RouteFixtureOptions = {}): Augment {
  const route: AugmentHttpRoute = {
    method: opts.method ?? "GET",
    path: opts.path ?? "/test/echo",
    auth: opts.auth ?? "bearer",
    handler:
      opts.handler ??
      (async (req: Request) => {
        const url = new URL(req.url);
        const msg = url.searchParams.get("msg") ?? "";
        return new Response(JSON.stringify({ echo: msg }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  };
  return {
    name: opts.name ?? "route-fixture",
    httpRoutes: [route],
  };
}
```

- [ ] **Step 2: Sanity-check the fixture imports cleanly**

Run: `bunx tsc --noEmit 2>&1 | grep -v "^chat/"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/route-fixture-augment.ts
git commit -m "test(fixtures): routeFixtureAugment for augment-route dispatch tests"
```

---

## Task 5: webTransport — augment-route dispatch (happy path)

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

This task wires augment-route dispatch into `webTransport`'s fetch handler at the simplest level: read routes from `kernel.getAugmentRoutes()` at boot, dispatch by exact (method, path) match, run the handler, return its response. Auth, rate limit, body cap, timeout, and exception handling come in subsequent tasks — TDD discipline keeps each layer reviewable.

- [ ] **Step 1: Write the failing test**

The existing tests in `tests/transports/web-transport.test.ts` (see line 209+, `describe("webTransport HTTP server", ...)`) follow this concrete pattern:

```ts
const model = createMockModel({ response: "hello" });
const port = 18900;  // each test uses a unique port to avoid collisions
const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
await agent.start();
try {
  const resp = await fetch(`http://localhost:${port}/health`);
  // assertions
} finally {
  await agent.stop();
}
```

**Tests use a real `defineAgent` + real `webTransport` on a fixed port + real `fetch`** — full integration style, not kernel-mocking. This means augment-route tests just add the fixture augment to the augments list and let `agent.start()` wire everything end-to-end. No need to construct `CollectedRoute` objects manually.

Existing imports already in scope at the top of the file:
```ts
import { webTransport } from "@/transports/web-transport";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
```

Add this import too:
```ts
import { routeFixtureAugment } from "@tests/fixtures/route-fixture-augment";
```

Append a new `describe` block after the existing `describe("webTransport HTTP server", ...)` block:

```ts
describe("webTransport augment-registered routes", () => {
  it("dispatches GET requests to augment-registered routes", async () => {
    const model = createMockModel();
    const port = 18950;
    const aug = webTransport({ port, auth: { type: "bearer", token: "test-token" } });
    const fixture = routeFixtureAugment();
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [fixture, aug] },
      model,
    );
    await agent.start();
    try {
      const resp = await fetch(`http://localhost:${port}/test/echo?msg=hello`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { echo: string };
      expect(body.echo).toBe("hello");
    } finally {
      await agent.stop();
    }
  });
});
```

Pick a port number that doesn't collide with the existing tests in the file — they use 18900, 18901, etc. Use 18950+ for the new tests in this PR (Task 5–10 each get their own port).

NOTE: the existing test file uses `it()` not `test()` (BUN lets either work, but match the file's convention).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transports/web-transport.test.ts -t "dispatches GET to augment-registered routes"`
Expected: FAIL — webTransport doesn't dispatch augment routes yet.

- [ ] **Step 3: Update `mockKernel` (or equivalent) in the test file**

Find the existing mock kernel helper in `tests/transports/web-transport.test.ts` (search for `getAgentCard` or `handleInbound` to locate it). Add a `getAugmentRoutes` field that defaults to returning `[]` and accepts an override. This change is NEEDED for the new test AND keeps existing tests passing (since they don't pass a value, the default `[]` applies).

- [ ] **Step 4: Modify `src/transports/web-transport.ts`**

**Lifecycle note (critical):** in the existing code, `webTransport`'s `onBoot` starts `Bun.serve` BEFORE `transport.register(kernel, ...)` runs (per `src/agent.ts:81` then `:163`). So `kernel` is `null` during `onBoot`. Routes must be captured inside `register()`, not `onBoot`. The fetch handler reads from a closure-scoped `augmentRoutes` array that starts empty and gets populated by `register`. This matches the existing code's race-tolerance — the same window exists today for `kernel.handleInbound` access in `handleAgentRun`.

At the top of `webTransport(opts)` (around line 138-146), add closure-scoped state for routes alongside the existing `kernel`/`server`/`signingKey` declarations:

```ts
export function webTransport(opts: WebTransportOptions): Augment {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let kernel: TransportKernel | null = null;

  // PR γ.1 — augment-registered routes captured at register() time.
  // Empty until register fires; once populated, immutable for the server's lifetime.
  let augmentRoutes: readonly import("../kernel/route-collector").CollectedRoute[] = [];
  let augmentRouteMap: Map<string, typeof augmentRoutes[number]> = new Map();

  // ... existing maxMessageLength/visitorTokens/signingKey declarations stay ...
```

In the `transport.register` body (around line 226-229), add route capture and the operator audit warning:

```ts
  const transport: TransportSpec = {
    async register(k: TransportKernel, _augmentName: string) {
      kernel = k;
      augmentRoutes = k.getAugmentRoutes();
      augmentRouteMap = new Map();
      for (const r of augmentRoutes) {
        augmentRouteMap.set(`${r.method} ${r.path}`, r);
        // Operator-visible audit: log every auth: "none" route so an operator
        // grepping the boot log can spot unauthenticated surfaces.
        if (r.auth === "none") {
          console.warn(
            `[web-transport] augment "${r.augmentName}" registered ${r.method} ${r.path} with auth: "none" — public, unauthenticated.`,
          );
        }
      }
    },
    identify,
    concurrency: opts.concurrency ?? 1,
    maxQueueDepth: opts.maxQueueDepth ?? 50,
    rateLimitPerPeer: opts.rateLimitPerPeer,
  };
```

In the `Bun.serve` fetch handler (around line 524-541), insert augment-route dispatch AFTER the four built-in path checks and BEFORE the 404 fallback:

```ts
          if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
            return handleAgentCard();
          }

          // PR γ.1 — augment-registered routes. Dispatched by exact (method, path).
          const augmentRoute = augmentRouteMap.get(`${req.method} ${url.pathname}`);
          if (augmentRoute) {
            return augmentRoute.handler(req);
          }

          // Method-mismatch detection: if any registered augment route matches
          // the path but a different method, return 405 with Allow header.
          for (const r of augmentRoutes) {
            if (r.path === url.pathname && r.method !== req.method) {
              return new Response("Method Not Allowed", {
                status: 405,
                headers: { allow: r.method },
              });
            }
          }

          return new Response("Not Found", { status: 404 });
```

The 405 method-mismatch check uses a linear scan (`for (const r of augmentRoutes)`) rather than a second indexed lookup; expected n is small (typical augment registers 1-2 routes; total likely <10). Indexing optimizations can land if a real consumer registers 50+ routes.

- [ ] **Step 5: Run the new test + the full transport suite**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS — including all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): dispatch augment-registered routes (happy path)"
```

---

## Task 6: webTransport — bearer auth on augment routes

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Routes with `auth: "bearer"` reuse webTransport's existing bearer-token check. Routes with `auth: "none"` skip auth.

- [ ] **Step 1: Write the failing tests**

Append to `tests/transports/web-transport.test.ts`:

```ts
test("auth: bearer route rejects request without bearer token", async () => {
  const fixture = routeFixtureAugment({ auth: "bearer" });
  // ... start with augmentRoutes: [collected route] ...
  const res = await fetch(`${baseUrl}/test/echo?msg=x`); // no Authorization header
  expect(res.status).toBe(401);
});

test("auth: bearer route rejects wrong bearer token", async () => {
  const fixture = routeFixtureAugment({ auth: "bearer" });
  const res = await fetch(`${baseUrl}/test/echo?msg=x`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(res.status).toBe(401);
});

test("auth: none route accepts request without any bearer token", async () => {
  const fixture = routeFixtureAugment({ auth: "none" });
  const res = await fetch(`${baseUrl}/test/echo?msg=hi`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ echo: "hi" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/transports/web-transport.test.ts -t "auth"`
Expected: FAIL — bearer-route requests currently pass through unauthenticated; auth-none routes also work but for the wrong reason.

- [ ] **Step 3: Apply auth check before invoking handler**

The existing `webTransport` already has a private helper `isValidAuth(header: string): boolean` defined around line 236 — it compares against `Bearer ${opts.auth.token}` using `timingSafeEqual`. Reuse it directly; no need to extract or duplicate.

Modify the augment-route dispatch (in the fetch handler, the block you added in Task 5) to apply auth BEFORE invoking the handler:

```ts
          const augmentRoute = augmentRouteMap.get(`${req.method} ${url.pathname}`);
          if (augmentRoute) {
            if (augmentRoute.auth === "bearer") {
              const authHeader = req.headers.get("authorization") ?? "";
              if (!isValidAuth(authHeader)) {
                return new Response(JSON.stringify({ error: "unauthorized" }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                });
              }
            }
            // auth: "none" — no check; fall through to handler
            return augmentRoute.handler(req);
          }
```

`isValidAuth` is already in lexical scope inside the fetch handler (it's defined at module-function scope in `webTransport`). Just call it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS — including the three new auth tests AND all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): bearer auth on augment-registered routes; auth: none opt-in"
```

---

## Task 7: webTransport — handler exception → 500

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

If a handler throws, the dispatcher returns 500 with an opaque body and logs the actual error with the route path for triage. The original error never leaks to the response.

- [ ] **Step 1: Write the failing test**

Append:

```ts
test("handler that throws returns 500 with opaque body", async () => {
  const fixture = routeFixtureAugment({
    auth: "none",
    handler: async () => {
      throw new Error("internal kaboom");
    },
  });
  const res = await fetch(`${baseUrl}/test/echo`);
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ error: "internal" });
  expect(JSON.stringify(body)).not.toContain("kaboom"); // opaque
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transports/web-transport.test.ts -t "handler that throws"`
Expected: FAIL — exception currently propagates and Bun returns its own 500 with diagnostic body.

- [ ] **Step 3: Wrap handler invocation in try/catch**

```ts
          if (augmentRoute) {
            // ... auth check (keep as-is) ...
            try {
              return await augmentRoute.handler(req);
            } catch (err) {
              console.error(
                `[web-transport] augment "${augmentRoute.augmentName}" handler ${augmentRoute.method} ${augmentRoute.path} threw: ${(err as Error).message}`,
              );
              return new Response(JSON.stringify({ error: "internal" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }
          }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): augment-route handler exception isolation (500 opaque)"
```

---

## Task 8: webTransport — handler timeout (504)

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Handlers that exceed `route.timeoutMs ?? 30_000` get a 504 Gateway Timeout. The handler's promise is not cancelled (Bun.serve doesn't expose AbortSignal here, and forcing cancellation requires AbortController plumbing through the handler signature — out of scope for v1); the dispatcher just stops waiting and returns 504. Any outstanding work in the handler will continue but its eventual response is dropped.

- [ ] **Step 1: Write the failing test**

```ts
test("handler that exceeds timeoutMs returns 504", async () => {
  const fixture = routeFixtureAugment({
    auth: "none",
    timeoutMs: 50,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response("late");
    },
  });
  const res = await fetch(`${baseUrl}/test/echo`);
  expect(res.status).toBe(504);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transports/web-transport.test.ts -t "exceeds timeoutMs"`
Expected: FAIL.

- [ ] **Step 3: Implement timeout via Promise.race**

There's a `withTimeout` helper somewhere in the kernel — search `src/kernel/timeout.ts`. If it exists, reuse it. If it returns a sentinel rather than throwing, adapt accordingly.

```ts
import { withTimeout } from "../kernel/timeout";  // existing helper

// In the augment-route dispatch:
            try {
              const timeoutMs = augmentRoute.timeoutMs ?? 30_000;
              return await withTimeout(augmentRoute.handler(req), timeoutMs);
            } catch (err) {
              if ((err as Error).message?.includes("timeout")) {
                return new Response(JSON.stringify({ error: "timeout" }), {
                  status: 504,
                  headers: { "content-type": "application/json" },
                });
              }
              console.error(/* same as Task 7 */);
              return new Response(JSON.stringify({ error: "internal" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }
```

The `withTimeout` helper in `src/kernel/timeout.ts` may use a specific error shape — read it and adapt the catch's discriminator. If the helper is unavailable or has incompatible semantics, inline:

```ts
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("handler-timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

Then check `err.message === "handler-timeout"` for the 504 branch.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): augment-route handler timeout (504 default 30s)"
```

---

## Task 9: webTransport — body-size cap (413) + method mismatch (405)

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Two related correctness items. The body-size cap reads `content-length` and rejects oversized payloads BEFORE invoking the handler. Method mismatch (already partially in place from Task 5) returns 405 with `Allow:`.

- [ ] **Step 1: Write the failing tests**

```ts
test("POST request exceeding maxBodyBytes returns 413", async () => {
  const fixture = routeFixtureAugment({
    method: "POST",
    auth: "none",
    maxBodyBytes: 100,
    handler: async () => new Response("ok"),
  });
  const big = "x".repeat(200);
  const res = await fetch(`${baseUrl}/test/echo`, {
    method: "POST",
    body: big,
    headers: { "content-type": "text/plain" },
  });
  expect(res.status).toBe(413);
});

test("POST request without content-length is allowed under default cap", async () => {
  // Default maxBodyBytes is 1 MB; small chunked-encoded request fits.
  const fixture = routeFixtureAugment({
    method: "POST",
    auth: "none",
    handler: async (req) => new Response(await req.text()),
  });
  const res = await fetch(`${baseUrl}/test/echo`, {
    method: "POST",
    body: "small",
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("small");
});

test("GET request to a POST-only route returns 405 with Allow header", async () => {
  const fixture = routeFixtureAugment({ method: "POST", auth: "none" });
  const res = await fetch(`${baseUrl}/test/echo`); // GET on POST-only route
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/transports/web-transport.test.ts -t "413|405|content-length"`
Expected: FAIL on the body-size test (no cap check); 405 may already pass from Task 5.

- [ ] **Step 3: Implement body-size cap**

In the augment-route dispatch, BEFORE the handler call:

```ts
          if (augmentRoute) {
            // ... auth check ...

            const maxBodyBytes = augmentRoute.maxBodyBytes ?? 1_048_576;
            const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
            if (contentLength > maxBodyBytes) {
              return new Response(JSON.stringify({ error: "payload-too-large" }), {
                status: 413,
                headers: { "content-type": "application/json" },
              });
            }

            try {
              // ... timeout-wrapped handler call ...
            }
          }
```

Method-mismatch handling from Task 5 should already produce 405 — verify the test passes without further changes there.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): augment-route body-size cap (413) + method mismatch (405)"
```

---

## Task 10: webTransport — per-route rate limit (429)

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

In-memory sliding-window counter per route. **Not per peer** (auth-none routes have no peer); per route globally. Returns 429 with a `Retry-After` header (seconds until window slides).

- [ ] **Step 1: Write the failing test**

```ts
test("per-route rate limit returns 429 after maxPerMinute exceeded", async () => {
  const fixture = routeFixtureAugment({
    auth: "none",
    rateLimit: { maxPerMinute: 2 },
  });
  const res1 = await fetch(`${baseUrl}/test/echo?msg=1`);
  expect(res1.status).toBe(200);
  const res2 = await fetch(`${baseUrl}/test/echo?msg=2`);
  expect(res2.status).toBe(200);
  const res3 = await fetch(`${baseUrl}/test/echo?msg=3`);
  expect(res3.status).toBe(429);
  expect(res3.headers.get("retry-after")).toMatch(/^\d+$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/transports/web-transport.test.ts -t "rate limit"`
Expected: FAIL.

- [ ] **Step 3: Implement sliding window per route**

At the top of the augment-route block (alongside the route map), add a per-route counter:

```ts
      // Per-route rate-limit state — sliding-window timestamps per route key.
      const routeHits = new Map<string, number[]>();

      function checkRateLimit(routeKey: string, max: number): { allowed: boolean; retryAfterSec?: number } {
        const now = Date.now();
        const windowStart = now - 60_000;
        const hits = (routeHits.get(routeKey) ?? []).filter((t) => t > windowStart);
        routeHits.set(routeKey, hits);
        if (hits.length >= max) {
          const oldestInWindow = hits[0]!;
          const retryAfterMs = oldestInWindow + 60_000 - now;
          return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
        }
        hits.push(now);
        routeHits.set(routeKey, hits);
        return { allowed: true };
      }
```

In the dispatch:

```ts
            // ... auth check + body-size cap ...

            if (augmentRoute.rateLimit) {
              const routeKey = `${augmentRoute.method} ${augmentRoute.path}`;
              const rl = checkRateLimit(routeKey, augmentRoute.rateLimit.maxPerMinute);
              if (!rl.allowed) {
                return new Response(JSON.stringify({ error: "rate-limited" }), {
                  status: 429,
                  headers: {
                    "content-type": "application/json",
                    "retry-after": String(rl.retryAfterSec),
                  },
                });
              }
            }

            try {
              // ... timeout-wrapped handler ...
            }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/transports/web-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): per-route sliding-window rate limit (429 + Retry-After)"
```

---

## Task 11: Integration test — full agent with route fixture

**Files:**
- Modify: `tests/integration/full-agent.test.ts`

End-to-end validation: real `defineAgent` + real `webTransport` + the route fixture augment + a real HTTP fetch against the bound port. Plus a negative test for the start-time collision-throw.

- [ ] **Step 1: Read the existing integration test pattern**

Open `tests/integration/full-agent.test.ts`. Existing tests use `createMockModel` (from `@tests/fixtures/mock-model`) and fixed port numbers per test (similar to web-transport.test.ts's pattern: 18900, 18901, ...). Use 19500+ for the new tests in this PR to avoid collisions.

- [ ] **Step 2: Append integration tests**

Add the import at the top of `tests/integration/full-agent.test.ts`:

```ts
import { routeFixtureAugment } from "@tests/fixtures/route-fixture-augment";
```

Append a new `describe` block at the end of the file:

```ts
describe("full-agent: augment HTTP route extension", () => {
  it("bound webTransport serves a fixture augment route end-to-end", async () => {
    const model = createMockModel();
    const port = 19500;
    const agent = defineAgent(
      {
        name: "route-test",
        model: "mock",
        augments: [
          routeFixtureAugment({ auth: "none" }),
          webTransport({ port, auth: { type: "bearer", token: "t" } }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const res = await fetch(`http://localhost:${port}/test/echo?msg=integration`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { echo: string };
      expect(body.echo).toBe("integration");
    } finally {
      await agent.stop();
    }
  });

  it("agent.start() rejects when two augments register the same route", async () => {
    const model = createMockModel();
    const port = 19501;
    const agent = defineAgent(
      {
        name: "collision",
        model: "mock",
        augments: [
          routeFixtureAugment({ name: "a", path: "/dup" }),
          routeFixtureAugment({ name: "b", path: "/dup" }),
          webTransport({ port, auth: { type: "bearer", token: "t" } }),
        ],
      },
      model,
    );

    await expect(agent.start()).rejects.toThrow(/both registered HTTP route/);

    // Verify the port did NOT bind — a follow-up agent on the same port
    // should succeed without "address in use" errors.
    const followup = defineAgent(
      {
        name: "ok",
        model: "mock",
        augments: [webTransport({ port, auth: { type: "bearer", token: "t" } })],
      },
      model,
    );
    await followup.start();
    await followup.stop();
  });
});
```

If `createMockModel` and `webTransport`/`defineAgent` aren't already imported at the top of the file, add the imports — match the style of the file's existing import block.

- [ ] **Step 3: Run tests**

Run: `bun test tests/integration/full-agent.test.ts`
Expected: PASS — including pre-existing tests.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/full-agent.test.ts
git commit -m "test(integration): end-to-end augment route dispatch + collision guard"
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/06-transports.md`

Add a section on augment-registered routes so operators know what they're getting and what guarantees apply.

- [ ] **Step 1: Read existing structure**

Open `docs/06-transports.md`. Find the section that lists webTransport's built-in routes (probably near a "Built-in paths" or "Routing" subsection). The new section sits after the built-in routes, before any "Internals" or "Future work" section.

- [ ] **Step 2: Add the section**

Insert this content at the appropriate location:

````markdown
## Augment-registered HTTP routes (PR γ.1)

Augments can register HTTP routes that `webTransport` serves alongside its built-in paths. Routes are collected at `agent.start()` after every augment's `onBoot` runs and before any port binds — collisions throw early, never silently override.

### Declaring a route

In your augment, set the optional `httpRoutes` field:

```ts
import type { Augment } from "augment-1";

export function myAugment(): Augment {
  return {
    name: "my-augment",
    httpRoutes: [
      {
        method: "GET",
        path: "/my-augment/status",
        auth: "bearer",
        handler: async (req) =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          }),
      },
    ],
  };
}
```

### Auth modes

`auth` is **required** — no implicit default.

- `"bearer"` — the route inherits webTransport's bearer-token check. Use for any route that represents a creator-authenticated action.
- `"none"` — the route accepts any caller. Use ONLY for genuinely public callbacks (email click-backs, OAuth redirects). The boot log emits a `console.warn` per `auth: "none"` route so operators see the unauthenticated surfaces.

### Reserved paths

Augments cannot register these paths (collision throws at `agent.start()`):

- `/`
- `/agent/run`
- `/health`
- `/.well-known/agent-card.json`

Convention: scope routes under `/<augment-name>/...` to make collisions across third-party augments extremely unlikely.

### Per-route safety knobs

| Field | Default | Behavior |
|---|---|---|
| `timeoutMs` | 30,000 | Handler exceeding this returns 504. The handler's promise is not cancelled (continues running; result discarded). |
| `maxBodyBytes` | 1,048,576 (1 MB) | Request with `content-length` over the cap returns 413 before the handler runs. |
| `rateLimit.maxPerMinute` | (no limit) | Per-route sliding-window counter. Not per-peer — auth-none routes have no peer. Returns 429 with `Retry-After`. |

### Status codes

| Status | Trigger |
|---|---|
| 200 | Handler returned a 2xx Response. |
| 401 | `auth: "bearer"` route, missing/wrong bearer token. |
| 404 | No augment route matches the requested (method, path). |
| 405 | Augment registered the path for a different method. `Allow:` header lists the registered method. |
| 413 | Request `content-length` exceeded `maxBodyBytes`. |
| 429 | Per-route rate limit triggered. `Retry-After:` header set. |
| 500 | Handler threw. Body is opaque `{"error":"internal"}`; the actual error is logged to stderr with the route path. |
| 504 | Handler exceeded `timeoutMs`. |

### Limits

- HTTP only — no WebSocket route registration at v1.
- Methods: `GET` and `POST`. PUT/DELETE/PATCH not supported (no consumer needs them; smaller surface).
- Exact path match — no patterns (`/items/:id`) or prefix routes.
- No streaming response support — handlers return discrete `Response` objects. AG-UI's SSE stays exclusive to `/agent/run`.
- Routes are frozen at `agent.start()` — no dynamic add/remove during runtime.
- Per-route auth schemes are `bearer | none` only. For OAuth/HMAC/custom schemes, augments wrap their handler with the additional check.
````

- [ ] **Step 3: Commit**

```bash
git add docs/06-transports.md
git commit -m "docs(transports): augment-registered HTTP routes operator reference"
```

---

## Task 13: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full typecheck**

Run: `bunx tsc --noEmit 2>&1 | grep -v "^chat/"`
Expected: zero output.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all pass. Test-count delta: +10 (route-collector) + 4 (agent-route-wiring) + ~9 (web-transport: 1 dispatch + 3 auth + 1 throw + 1 timeout + 3 body/method) + 2 (rate limit) + 2 (integration) = **+30 new tests**. Baseline post-PR-#23/#24 was 1475; expect ~1505 after this plan.

- [ ] **Step 3: Smoke-test boot warnings**

Run a quick experiment: scaffold a throwaway agent with the route fixture using `auth: "none"` and observe the boot log shows the warning. (Optional; the test in Task 6 covers the behavior — this is just human-in-the-loop sanity.)

- [ ] **Step 4: Confirm git status clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

---

## Acceptance criteria

- [ ] `bun test` passes with the full new suite (~30 new tests).
- [ ] `bunx tsc --noEmit` passes clean.
- [ ] An augment can declare `httpRoutes` and `webTransport` serves them.
- [ ] Two augments registering the same `(method, path)` cause `agent.start()` to throw — no port binds.
- [ ] An augment registering a reserved path (`/agent/run`, `/health`, etc.) causes `agent.start()` to throw.
- [ ] `auth: "bearer"` routes return 401 without/with-wrong token; pass with the right token.
- [ ] `auth: "none"` routes accept unauthenticated traffic AND emit a boot warning.
- [ ] Handler throwing returns 500 with opaque body; original error appears only in stderr.
- [ ] Handler exceeding `timeoutMs` returns 504.
- [ ] Body over `maxBodyBytes` returns 413 before the handler runs.
- [ ] Method mismatch returns 405 with `Allow:` header.
- [ ] Per-route rate limit returns 429 with `Retry-After` after the threshold.
- [ ] `docs/06-transports.md` documents the contract: declaration, auth modes, reserved paths, status codes, limits.

---

## What this plan deliberately does NOT do

- **No WebSocket support.** HTTP only.
- **No path patterns or parameters.** Exact match only.
- **No PUT/DELETE/PATCH methods.** GET and POST only.
- **No streaming response support.** AG-UI's SSE stays bound to `/agent/run`.
- **No dynamic route add/remove after boot.** Routes are frozen.
- **No per-handler middleware chain.** Augments compose middleware in their handler if they want it.
- **No auth schemes beyond `bearer | none`.** OAuth/HMAC/custom are augment-wrapped.
- **No multi-transport HTTP route routing.** Only `webTransport` consumes routes; future HTTP-capable transports declare opt-in.
- **No request cancellation propagation.** Bun.serve doesn't expose AbortSignal in the fetch handler signature; timeouts return 504 but the handler's promise continues.
- **No per-route auth-token scoping.** A creator bearer token works on every `auth: "bearer"` route; per-route scoping (e.g., separate tokens per augment) is post-v1.
- **No telemetry / metrics export.** Logs only. OTel/metrics surfaces are post-v1 and live behind a separate seam.

---

## Threat-model checklist (engineer should verify mentally before merge)

For each item, confirm the implementation matches the contract:

- [ ] Reserved-path collision is checked at boot, not at dispatch time. (Dispatch-time check would let a buggy augment register a hijacking path that survives until the first request.)
- [ ] `auth: "none"` routes are logged at `console.warn` — operators reviewing logs can grep for them.
- [ ] Handler exceptions never leak to the response. The body is opaque `{"error":"internal"}` regardless of the actual error.
- [ ] Body-size cap is checked from `content-length` BEFORE the handler runs (not after `req.text()` reads all bytes). Otherwise an attacker streams 10 GB to exhaust memory before the cap kicks in.
- [ ] Rate-limit state survives across requests for the lifetime of the server, but is in-memory only (resets on restart). Document in operator docs.
- [ ] Per-route rate limit is independent from the transport-queue's `rateLimitPerPeer` (which gates `/agent/run` only).
- [ ] On collision throw, `lifecycle.shutdown()` runs to release boot-time side effects (SQLite handles, file watchers) before re-throwing.
- [ ] Routes are frozen — `Object.isFrozen(kernel.getAugmentRoutes())` is true. Transports cannot mutate.
- [ ] Method mismatch returns 405 with the registered method in `Allow:` (not just a generic 405).
- [ ] Built-in paths still work: `/agent/run`, `/health`, `/.well-known/agent-card.json`, optional `GET /`.

---

## Forward-compatibility notes

This PR establishes the augment-route extension primitive. PR γ.2 (visitorAuth) is the first real consumer. Future consumers may need:

1. **WebSocket route support** — likely a sibling field `Augment.wsRoutes?: AugmentWsRoute[]` with a parallel collection step. Don't pre-design.
2. **Path patterns** — when a real consumer needs `/items/:id`, add `pathPattern?: string` alongside `path`. Defer.
3. **Per-route logging hooks** — when telemetry lands. Defer.
4. **Custom auth schemes** — for OAuth/HMAC. Operators can wrap handlers today; a first-class auth-scheme registry can land later.

The contracts in this PR are deliberately narrow so each future extension is additive, not a refactor.

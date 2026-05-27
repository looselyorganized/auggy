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
  "/console",
]);

/**
 * G36 — Path prefixes reserved by webTransport. An augment registering ANY
 * path under one of these prefixes gets a validation error. Used for
 * `/console/action/*` so augments can't shadow the built-in dispatch.
 * (S9 fix from adversarial review.)
 */
export const RESERVED_PREFIXES: readonly string[] = Object.freeze(["/console/"]);

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
        errors.push(`Augment "${aug.name}" registered an HTTP route with empty path.`);
        continue;
      }
      if (!r.path.startsWith("/")) {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" — path must start with '/'.`,
        );
        continue;
      }

      // Reserved-path collision (exact match)
      if (RESERVED_PATHS.includes(r.path)) {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" — that path is reserved by webTransport.`,
        );
        continue;
      }

      // G36 / S9 — reserved-prefix collision (any path under a reserved prefix)
      const reservedPrefix = RESERVED_PREFIXES.find((prefix) => r.path.startsWith(prefix));
      if (reservedPrefix !== undefined) {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" — paths under "${reservedPrefix}" are reserved by webTransport.`,
        );
        continue;
      }

      // Auth-mode validation — reject unknown values at boot to prevent
      // fail-open dispatch on typos / dynamic-config bugs.
      if (r.auth !== "bearer" && r.auth !== "none") {
        errors.push(
          `Augment "${aug.name}" registered HTTP route ${r.method} "${r.path}" with invalid auth "${r.auth}" — must be "bearer" or "none".`,
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

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
  handler?: (req: Request, opts: { signal: AbortSignal }) => Promise<Response>;
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
      (async (req: Request, _opts: { signal: AbortSignal }) => {
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

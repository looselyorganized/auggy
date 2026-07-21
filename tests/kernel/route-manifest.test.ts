import { describe, expect, test } from "bun:test";
import { collectAugmentRoutes } from "../../src/kernel/route-collector";
import { createRouteManifest, summarizeRouteManifest } from "../../src/kernel/route-manifest";
import type { Augment, AugmentHttpRoute, AugmentHttpRouteAuth } from "../../src/types";

function aug(name: string, routes: AugmentHttpRoute[]): Augment {
  return { name, httpRoutes: routes };
}

function route(
  method: "GET" | "POST",
  path: string,
  auth: AugmentHttpRouteAuth = "bearer",
  extra: Partial<AugmentHttpRoute> = {},
): AugmentHttpRoute {
  return { method, path, auth, handler: async () => new Response("ok"), ...extra };
}

describe("route manifest", () => {
  test("creates stable manifest entries from collected routes", () => {
    const collected = collectAugmentRoutes([
      aug("catalog", [
        route("GET", "/catalog/:id", "none", {
          rateLimit: { maxPerMinute: 30 },
          requestJsonSchema: {
            params: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
          responseJsonSchema: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
        }),
      ]),
      aug("orders", [
        route("POST", "/orders/create", "bearer", {
          timeoutMs: 10_000,
          maxBodyBytes: 4096,
        }),
      ]),
    ]);

    expect(collected.errors).toEqual([]);

    const manifest = createRouteManifest(collected.routes);

    expect(manifest).toEqual([
      {
        method: "GET",
        path: "/catalog/:id",
        augmentName: "catalog",
        auth: "none",
        params: ["id"],
        public: true,
        security: "public",
        rateLimit: { maxPerMinute: 30 },
        requestJsonSchema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
        responseJsonSchema: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
        },
      },
      {
        method: "POST",
        path: "/orders/create",
        augmentName: "orders",
        auth: "bearer",
        params: [],
        public: false,
        security: "private",
        timeoutMs: 10_000,
        maxBodyBytes: 4096,
      },
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest[0])).toBe(true);
    expect(Object.isFrozen(manifest[0]?.params)).toBe(true);
    expect(manifest[0]?.requestMediaTypes).toBeUndefined();
    expect(manifest[0]?.responseMediaTypes).toBeUndefined();
  });

  test("copies and freezes only explicit media type metadata", () => {
    const requestMediaTypes = ["application/x-www-form-urlencoded", "application/json"];
    const responseMediaTypes = ["text/html", "application/json"];
    const collected = collectAugmentRoutes([
      aug("custom", [
        route("POST", "/custom", "none", {
          requestJsonSchema: { body: { type: "object" } },
          responseJsonSchema: { type: "object" },
          requestMediaTypes,
          responseMediaTypes,
        }),
      ]),
    ]);

    const manifest = createRouteManifest(collected.routes);
    expect(manifest[0]?.requestMediaTypes).toEqual(requestMediaTypes);
    expect(manifest[0]?.responseMediaTypes).toEqual(responseMediaTypes);
    expect(manifest[0]?.requestMediaTypes).not.toBe(requestMediaTypes);
    expect(manifest[0]?.responseMediaTypes).not.toBe(responseMediaTypes);
    expect(Object.isFrozen(manifest[0]?.requestMediaTypes)).toBe(true);
    expect(Object.isFrozen(manifest[0]?.responseMediaTypes)).toBe(true);
  });

  test("summarizes public and private route posture", () => {
    const collected = collectAugmentRoutes([
      aug("public", [route("GET", "/services", "none")]),
      aug("visitor-aware", [route("GET", "/recommendations", "visitor.optional")]),
      aug("visitor-private", [route("GET", "/orders/:id", "visitor.required")]),
      aug("private", [route("POST", "/orders/create", "bearer")]),
      aug("creator", [route("POST", "/admin/reindex", "creator")]),
      aug("agent", [route("GET", "/agent-api/search", "agent.required")]),
    ]);
    const manifest = createRouteManifest(collected.routes);

    expect(summarizeRouteManifest(manifest)).toEqual({
      totalRoutes: 6,
      publicRoutes: 2,
      privateRoutes: 4,
      publicRoutePaths: ["GET /services", "GET /recommendations"],
    });
    expect(manifest.find((route) => route.auth === "agent.required")).toMatchObject({
      public: false,
      security: "private",
    });
  });

  test("copies route policy metadata into manifest entries", () => {
    const policy = {
      kind: "webhook.signature" as const,
      provider: "stripe",
      secretEnv: "STRIPE_WEBHOOK_SECRET",
    };
    const collected = collectAugmentRoutes([
      aug("payments", [route("POST", "/webhooks/stripe", "none", { policy })]),
    ]);

    expect(collected.errors).toEqual([]);

    const manifest = createRouteManifest(collected.routes);

    expect(manifest[0]).toMatchObject({
      method: "POST",
      path: "/webhooks/stripe",
      auth: "none",
      public: true,
      security: "public",
      policy,
    });
    expect(manifest[0]?.policy).not.toBe(policy);
    expect(Object.isFrozen(manifest[0]?.policy)).toBe(true);
  });

  test("copies delegated authorization requirements into manifest entries", () => {
    const requires = [
      { scope: "orders.write" },
      {
        action: "refund.issue",
        resource: { param: "id" },
        constraints: { tenant: "lo", flags: ["customer-requested"] },
      },
    ] as const;
    const collected = collectAugmentRoutes([
      aug("orders", [
        route("POST", "/orders/:id/refund", "visitor.required", {
          requires,
        }),
      ]),
    ]);

    expect(collected.errors).toEqual([]);

    const manifest = createRouteManifest(collected.routes);

    expect(manifest[0]).toMatchObject({
      method: "POST",
      path: "/orders/:id/refund",
      auth: "visitor.required",
      requires,
    });
    const manifestRequires = manifest[0]!.requires as readonly {
      constraints?: { flags?: unknown };
    }[];
    expect(manifestRequires).not.toBe(requires);
    expect(Object.isFrozen(manifestRequires)).toBe(true);
    expect(Object.isFrozen(manifestRequires[1])).toBe(true);
    expect(Object.isFrozen(manifestRequires[1]!.constraints!.flags)).toBe(true);
  });
});

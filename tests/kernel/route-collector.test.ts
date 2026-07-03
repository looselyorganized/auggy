import { describe, test, expect } from "bun:test";
import {
  collectAugmentRoutes,
  RESERVED_PATHS,
  RESERVED_PREFIXES,
} from "../../src/kernel/route-collector";
import type { Augment, AugmentHttpRoute, AugmentHttpRouteAuth } from "../../src/types";

function aug(name: string, routes: AugmentHttpRoute[]): Augment {
  return { name, httpRoutes: routes };
}

function route(
  method: "GET" | "POST",
  path: string,
  auth: AugmentHttpRouteAuth = "bearer",
): AugmentHttpRoute {
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
    const result = collectAugmentRoutes([aug("hijack", [route("POST", "/agent/run")])]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("hijack");
    expect(result.errors[0]).toContain("/agent/run");
    expect(result.errors[0]).toContain("reserved");
  });

  test("rejects all reserved paths", () => {
    for (const path of RESERVED_PATHS) {
      const result = collectAugmentRoutes([aug("a", [route("GET", path)])]);
      expect(result.errors[0]).toContain(path);
    }
  });

  test("rejects routes under reserved prefixes", () => {
    for (const prefix of RESERVED_PREFIXES) {
      const path = `${prefix}custom`;
      const result = collectAugmentRoutes([aug("a", [route("GET", path)])]);
      expect(result.errors[0]).toContain(prefix);
      expect(result.errors[0]).toContain("reserved");
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

  test("rejects ambiguous parameterized routes with the same match shape", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/orders/:id")]),
      aug("b", [route("GET", "/orders/:orderId")]),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("overlapping");
    expect(result.errors[0]).toContain("/orders/:orderId");
  });

  test("rejects overlapping parameterized routes with different shapes", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/:section/new")]),
      aug("b", [route("GET", "/items/:id")]),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("overlapping");
    expect(result.errors[0]).toContain("/:section/new");
    expect(result.errors[0]).toContain("/items/:id");
  });

  test("allows parameterized routes that cannot match the same path", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/items/:id")]),
      aug("b", [route("GET", "/orders/:id")]),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.routes.map((r) => r.path)).toEqual(["/items/:id", "/orders/:id"]);
  });

  test("allows a specific static route next to a broader parameterized route", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/orders/new")]),
      aug("b", [route("GET", "/orders/:id")]),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.routes.map((r) => r.path)).toEqual(["/orders/new", "/orders/:id"]);
  });

  test("rejects invalid parameter segment shapes", () => {
    const result = collectAugmentRoutes([
      aug("a", [route("GET", "/orders/:")]),
      aug("b", [route("GET", "/orders/:bad-id")]),
      aug("c", [route("GET", "/orders/:id/:id")]),
    ]);

    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("invalid path parameter");
    expect(result.errors[1]).toContain("invalid path parameter");
    expect(result.errors[2]).toContain("duplicate path parameter");
  });

  test("allows the same path with different methods (GET + POST)", () => {
    const result = collectAugmentRoutes([aug("a", [route("GET", "/x"), route("POST", "/x")])]);
    expect(result.routes).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  test("allows creator, visitor, and agent route auth modes", () => {
    const result = collectAugmentRoutes([
      aug("creator", [route("POST", "/admin/reindex", "creator")]),
      aug("visitors", [
        route("GET", "/profile", "visitor.required"),
        route("GET", "/recommendations", "visitor.optional"),
      ]),
      aug("agents", [route("GET", "/agent-api/search", "agent.required")]),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.routes.map((r) => r.auth)).toEqual([
      "creator",
      "visitor.required",
      "visitor.optional",
      "agent.required",
    ]);
  });

  test("rejects path that does not start with '/'", () => {
    const result = collectAugmentRoutes([aug("a", [route("GET", "no-slash")])]);
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

  test("rejects routes with invalid auth values", () => {
    const r = (path: string, auth: unknown): AugmentHttpRoute => ({
      method: "GET",
      path,
      auth: auth as AugmentHttpRoute["auth"],
      handler: async () => new Response("ok"),
    });
    const result = collectAugmentRoutes([
      aug("a", [r("/a", "Bearer")]), // wrong case
      aug("b", [r("/b", "")]),
      aug("c", [r("/c", undefined)]),
    ]);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    for (const e of result.errors) {
      expect(e).toContain("invalid auth");
    }
  });
});

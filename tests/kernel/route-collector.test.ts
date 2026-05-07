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

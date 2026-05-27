import { describe, test, expect } from "bun:test";
import {
  PROVIDER_TO_PACKAGE,
  buildAgentPackageJson,
  mergePackageDeps,
  getAuggyVersion,
} from "../../src/cli/scaffold-package-json";
import type { CatalogEntry } from "../../src/cli/augment-catalog";

/**
 * Pure-function tests for the per-agent package.json builder. No filesystem
 * access — the builder takes inputs and returns JSON text.
 */

function makeEntry(partial: Partial<CatalogEntry>): CatalogEntry {
  return {
    label: partial.label ?? "test",
    tagline: partial.tagline ?? "test tagline",
    description: partial.description ?? "test entry",
    type: partial.type ?? "test",
    defaultName: partial.defaultName ?? "test",
    defaultOptions: partial.defaultOptions ?? {},
    required: partial.required ?? false,
    hasSkill: partial.hasSkill ?? false,
    envVars: partial.envVars,
    packageDeps: partial.packageDeps,
  };
}

describe("PROVIDER_TO_PACKAGE", () => {
  test("maps every provider to a @auggy/* adapter package", () => {
    expect(PROVIDER_TO_PACKAGE.anthropic).toBe("@auggy/anthropic");
    expect(PROVIDER_TO_PACKAGE.openai).toBe("@auggy/openai");
    expect(PROVIDER_TO_PACKAGE.openrouter).toBe("@auggy/openrouter");
  });
});

describe("buildAgentPackageJson", () => {
  test("writes name, private, type=module, and caret-pinned auggy + adapter deps", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      provider: "anthropic",
      augments: [],
    });

    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("auggy-agent-demo");
    expect(parsed.private).toBe(true);
    expect(parsed.type).toBe("module");
    expect(parsed.dependencies).toEqual({
      auggy: "^0.3.1",
      "@auggy/anthropic": "^0.3.1",
    });
  });

  test("merges packageDeps from selected augments", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      provider: "anthropic",
      augments: [
        makeEntry({ type: "link", packageDeps: { "@auggy/link": "^0.1.2" } }),
        makeEntry({
          type: "supabaseMemory",
          packageDeps: { "@supabase/supabase-js": "^2.103.0" },
        }),
      ],
    });

    const parsed = JSON.parse(text);
    expect(parsed.dependencies).toEqual({
      "@auggy/anthropic": "^0.3.1",
      "@auggy/link": "^0.1.2",
      "@supabase/supabase-js": "^2.103.0",
      auggy: "^0.3.1",
    });
  });

  test("ignores augments without packageDeps", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      provider: "openai",
      augments: [
        makeEntry({ type: "filesystem" }), // no packageDeps
        makeEntry({ type: "skills" }), // no packageDeps
      ],
    });
    const parsed = JSON.parse(text);
    expect(parsed.dependencies).toEqual({
      auggy: "^0.3.1",
      "@auggy/openai": "^0.3.1",
    });
  });

  test("output is deterministic — dependencies sorted alphabetically", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      provider: "openrouter",
      augments: [makeEntry({ packageDeps: { zod: "^4.0.0", "@auggy/link": "^0.1.2" } })],
    });
    // Match the literal string to pin the order. Sorted alphabetically:
    // @auggy/link, @auggy/openrouter, auggy, zod
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed.dependencies)).toEqual([
      "@auggy/link",
      "@auggy/openrouter",
      "auggy",
      "zod",
    ]);
  });

  test("ends with a trailing newline (Bun lockfile + git friendliness)", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      provider: "anthropic",
      augments: [],
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  test("agent name with hyphens/underscores becomes package name verbatim", () => {
    const text = buildAgentPackageJson({
      agentName: "my-test_agent",
      auggyVersion: "0.3.1",
      provider: "anthropic",
      augments: [],
    });
    expect(JSON.parse(text).name).toBe("auggy-agent-my-test_agent");
  });
});

describe("mergePackageDeps", () => {
  test("adds new packages and reports them in `added`", () => {
    const existing = JSON.stringify(
      {
        name: "auggy-agent-x",
        private: true,
        type: "module",
        dependencies: { auggy: "^0.3.1", "@auggy/anthropic": "^0.3.1" },
      },
      null,
      2,
    );

    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });

    expect(result.added).toEqual(["@auggy/link"]);
    const parsed = JSON.parse(result.text);
    expect(parsed.dependencies["@auggy/link"]).toBe("^0.1.2");
    // existing deps preserved
    expect(parsed.dependencies.auggy).toBe("^0.3.1");
    expect(parsed.dependencies["@auggy/anthropic"]).toBe("^0.3.1");
  });

  test("upgrading an existing package surfaces it in `added`", () => {
    const existing = JSON.stringify(
      {
        name: "auggy-agent-x",
        dependencies: { "@auggy/link": "^0.1.0" },
      },
      null,
      2,
    );
    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });
    expect(result.added).toEqual(["@auggy/link"]);
    expect(JSON.parse(result.text).dependencies["@auggy/link"]).toBe("^0.1.2");
  });

  test("re-applying the same dep is a no-op (empty `added`)", () => {
    const existing = JSON.stringify(
      {
        name: "auggy-agent-x",
        dependencies: { "@auggy/link": "^0.1.2" },
      },
      null,
      2,
    );
    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });
    expect(result.added).toEqual([]);
  });

  test("dependencies in the merged output are sorted alphabetically", () => {
    const existing = JSON.stringify(
      {
        name: "auggy-agent-x",
        dependencies: { zod: "^4.0.0", "@auggy/anthropic": "^0.3.1" },
      },
      null,
      2,
    );
    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });
    expect(Object.keys(JSON.parse(result.text).dependencies)).toEqual([
      "@auggy/anthropic",
      "@auggy/link",
      "zod",
    ]);
  });

  test("preserves non-dependency keys (name, private, type, scripts, etc.)", () => {
    const existing = JSON.stringify(
      {
        name: "auggy-agent-x",
        private: true,
        type: "module",
        scripts: { foo: "bar" },
        dependencies: { auggy: "^0.3.1" },
      },
      null,
      2,
    );
    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });
    const parsed = JSON.parse(result.text);
    expect(parsed.name).toBe("auggy-agent-x");
    expect(parsed.private).toBe(true);
    expect(parsed.type).toBe("module");
    expect(parsed.scripts).toEqual({ foo: "bar" });
  });

  test("handles a package.json with no dependencies field yet", () => {
    const existing = JSON.stringify({ name: "auggy-agent-x", private: true }, null, 2);
    const result = mergePackageDeps(existing, { "@auggy/link": "^0.1.2" });
    expect(result.added).toEqual(["@auggy/link"]);
    expect(JSON.parse(result.text).dependencies).toEqual({ "@auggy/link": "^0.1.2" });
  });
});

describe("getAuggyVersion", () => {
  test("reads version from auggy's own package.json", () => {
    const version = getAuggyVersion();
    // Must be a semver-shaped string. Specific value depends on package.json
    // state at test time; we assert shape not value to avoid coupling.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

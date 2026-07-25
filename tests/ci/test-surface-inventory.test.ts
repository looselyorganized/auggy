import { describe, expect, test } from "bun:test";
import {
  createBunTestInvocation,
  readGitTreeEntries,
  readTestSurfaceManifest,
  validateTestSurface,
  type GitTreeEntry,
  type TestSurfaceManifest,
} from "../../scripts/test-surface-inventory";

const regular = (path: string): GitTreeEntry => ({
  path,
  mode: "100644",
  stage: 0,
});

function minimalManifest(): TestSurfaceManifest {
  return {
    schema: 1,
    shards: [
      {
        id: "runtime",
        suite: "runtime",
        selectors: [{ kind: "tree", path: "tests/known" }],
      },
      {
        id: "console",
        suite: "admin",
        selectors: [{ kind: "tree", path: "admin/src" }],
      },
    ],
  };
}

describe("tracked CI test-surface inventory", () => {
  test("assigns every current runtime and console test exactly once", () => {
    const inventory = validateTestSurface(readGitTreeEntries(), readTestSurfaceManifest());
    const allFiles = inventory.shards.flatMap((shard) => shard.files);

    expect(inventory.runtimeFiles).toBeGreaterThanOrEqual(252);
    expect(inventory.adminFiles).toBeGreaterThanOrEqual(29);
    expect(allFiles).toHaveLength(inventory.runtimeFiles + inventory.adminFiles);
    expect(new Set(allFiles).size).toBe(allFiles.length);
    expect(inventory.shards.find((shard) => shard.id === "http")?.files).toEqual([
      "tests/http.test.ts",
    ]);
    expect(inventory.shards.find((shard) => shard.id === "base")?.files).toContain(
      "tests/agent.test.ts",
    );
    expect(inventory.shards.find((shard) => shard.id === "doctor")?.files).toEqual([
      "tests/cli/commands/doctor.test.ts",
    ]);
    expect(inventory.shards.find((shard) => shard.id === "operator")?.files).not.toContain(
      "tests/cli/commands/doctor.test.ts",
    );
  });

  test("automatically assigns additions inside known roots", () => {
    const entries = [
      regular("tests/known/current.test.ts"),
      regular("tests/new-root.test.ts"),
      regular("examples/new/example.spec.tsx"),
      regular("packages/adapter/new_test.js"),
      regular("admin/src/new/console_spec.jsx"),
    ];
    const manifest: TestSurfaceManifest = {
      schema: 1,
      shards: [
        {
          id: "base",
          suite: "runtime",
          selectors: [
            { kind: "children", path: "tests" },
            { kind: "tree", path: "tests/known" },
            { kind: "tree", path: "examples" },
            { kind: "tree", path: "packages" },
          ],
        },
        {
          id: "console",
          suite: "admin",
          selectors: [{ kind: "tree", path: "admin/src" }],
        },
      ],
    };

    const inventory = validateTestSurface(entries, manifest);
    expect(inventory.runtimeFiles).toBe(4);
    expect(inventory.adminFiles).toBe(1);
  });

  test("fails closed for a new unassigned test area", () => {
    const entries = [
      regular("tests/known/current.test.ts"),
      regular("tests/new-area/security.test.ts"),
      regular("admin/src/console.test.ts"),
    ];
    expect(() => validateTestSurface(entries, minimalManifest())).toThrow(
      /unassigned.*tests\/new-area\/security\.test\.ts/i,
    );
  });

  test("fails closed for a test-shaped file outside every declared suite root", () => {
    const entries = [
      regular("tests/known/current.test.ts"),
      regular("src/new-boundary/security.test.ts"),
      regular("admin/src/console.test.ts"),
    ];
    expect(() => validateTestSurface(entries, minimalManifest())).toThrow(
      /outside declared suite roots.*src\/new-boundary\/security\.test\.ts/i,
    );
  });

  test("recognizes Bun filename variants and ignores templates", () => {
    const entries = [
      regular("tests/known/a.test.ts"),
      regular("tests/known/b_test.js"),
      regular("tests/known/c.spec.tsx"),
      regular("tests/known/d_spec.jsx"),
      regular("tests/known/template.test.ts.txt"),
      regular("admin/src/console.test.ts"),
    ];
    const inventory = validateTestSurface(entries, minimalManifest());
    expect(inventory.shards[0]?.files).toEqual([
      "tests/known/a.test.ts",
      "tests/known/b_test.js",
      "tests/known/c.spec.tsx",
      "tests/known/d_spec.jsx",
    ]);
  });

  test("rejects duplicate and cross-suite ownership", () => {
    const entries = [regular("tests/known/current.test.ts"), regular("admin/src/console.test.ts")];
    const duplicate = minimalManifest();
    duplicate.shards.push({
      id: "other",
      suite: "runtime",
      selectors: [{ kind: "exact", path: "tests/known/current.test.ts" }],
    });
    expect(() => validateTestSurface(entries, duplicate)).toThrow(
      /multiple.*tests\/known\/current\.test\.ts/i,
    );

    const crossed = minimalManifest();
    crossed.shards[1]!.selectors = [{ kind: "exact", path: "tests/known/current.test.ts" }];
    expect(() => validateTestSurface(entries, crossed)).toThrow(
      /admin.*outside.*suite|outside.*admin/i,
    );
  });

  test("rejects stale selectors, exclusions, and empty required suites", () => {
    const entries = [regular("tests/known/current.test.ts"), regular("admin/src/console.test.ts")];
    const stale = minimalManifest();
    stale.shards[0]!.selectors.push({ kind: "tree", path: "tests/missing" });
    expect(() => validateTestSurface(entries, stale)).toThrow(/selector.*tests\/missing/i);

    const staleExclusion = minimalManifest();
    staleExclusion.shards[0]!.selectors[0]!.exclude = ["tests/known/missing.test.ts"];
    expect(() => validateTestSurface(entries, staleExclusion)).toThrow(/exclusion.*missing/i);

    const emptyAdmin = minimalManifest();
    expect(() => validateTestSurface([regular("tests/known/current.test.ts")], emptyAdmin)).toThrow(
      /admin\/src.*stale|admin.*empty|no tracked admin/i,
    );
  });

  test("requires an explicit policy for a tracked root with no tests yet", () => {
    const entries = [
      regular("tests/known/current.test.ts"),
      regular("packages/future/README.md"),
      regular("admin/src/console.test.ts"),
    ];
    const manifest = minimalManifest();
    manifest.shards[0]!.selectors.push({
      kind: "tree",
      path: "packages/future",
    });
    expect(() => validateTestSurface(entries, manifest)).toThrow(
      /selector.*packages\/future.*no tracked tests/i,
    );

    manifest.shards[0]!.selectors[1]!.allowEmpty = true;
    expect(validateTestSurface(entries, manifest).runtimeFiles).toBe(1);
  });

  test("rejects symlink and noncanonical test paths", () => {
    const manifest = minimalManifest();
    for (const entry of [
      { path: "tests/known/link.test.ts", mode: "120000", stage: 0 },
      regular("../tests/known/traversal.test.ts"),
      regular("/tests/known/absolute.test.ts"),
      regular("tests\\known\\backslash.test.ts"),
      regular("tests//known/duplicate.test.ts"),
      regular("tests/./known/dot.test.ts"),
      regular("tests/known/control\n.test.ts"),
      regular("tests/known/e\u0301.test.ts"),
    ]) {
      expect(() =>
        validateTestSurface(
          [regular("tests/known/current.test.ts"), regular("admin/src/console.test.ts"), entry],
          manifest,
        ),
      ).toThrow();
    }
  });

  test("rejects duplicate and case-fold-colliding tracked paths", () => {
    const manifest = minimalManifest();
    expect(() =>
      validateTestSurface(
        [
          regular("tests/known/current.test.ts"),
          regular("tests/known/current.test.ts"),
          regular("admin/src/console.test.ts"),
        ],
        manifest,
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateTestSurface(
        [
          regular("tests/known/Case.test.ts"),
          regular("tests/known/case.test.ts"),
          regular("admin/src/console.test.ts"),
        ],
        manifest,
      ),
    ).toThrow(/case/i);
  });

  test("builds exact argv invocations without shell interpolation", () => {
    const runtime = createBunTestInvocation(
      {
        id: "runtime",
        suite: "runtime",
        files: ["tests/known/space $value.test.ts"],
      },
      "/repo",
      "/bun",
    );
    expect(runtime).toEqual({
      cwd: "/repo",
      argv: [
        "/bun",
        "test",
        "--max-concurrency=1",
        "--timeout=30000",
        "--",
        "./tests/known/space $value.test.ts",
      ],
    });

    const admin = createBunTestInvocation(
      {
        id: "console",
        suite: "admin",
        files: ["admin/src/App.test.ts"],
      },
      "/repo",
      "/bun",
    );
    expect(admin.cwd).toBe("/repo/admin");
    expect(admin.argv.at(-1)).toBe("./src/App.test.ts");
  });
});

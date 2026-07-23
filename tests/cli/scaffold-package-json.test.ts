import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROVIDER_TO_PACKAGE,
  SCAFFOLD_SECURITY_OVERRIDES,
  buildAgentPackageJson,
  getAuggyPackageSpecifierOverride,
  getAuggyVersion,
  mergePackageDeps,
  resolveAuggyPackageSpecifierForCreate,
  resolveScaffoldPackageSpecifiersForCreate,
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
    stability: partial.stability ?? "stable",
    hasSkill: partial.hasSkill ?? false,
    envVars: partial.envVars,
    packageDeps: partial.packageDeps,
  };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "auggy-scaffold-package-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(parsed.overrides).toEqual(SCAFFOLD_SECURITY_OVERRIDES);
    expect(parsed.dependencies).toEqual({
      auggy: "^0.3.1",
      "@auggy/anthropic": "^0.3.1",
    });
  });

  test("can override only the auggy core specifier for local tarball smoke tests", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.3.1",
      auggyPackageSpecifier: "file:/tmp/auggy-0.3.1.tgz",
      provider: "anthropic",
      augments: [],
    });

    const parsed = JSON.parse(text);
    expect(parsed.dependencies).toEqual({
      auggy: "file:/tmp/auggy-0.3.1.tgz",
      "@auggy/anthropic": "^0.3.1",
    });
  });

  test("can override core and provider package specs as one local package set", () => {
    const text = buildAgentPackageJson({
      agentName: "demo",
      auggyVersion: "0.5.0",
      provider: "anthropic",
      augments: [],
      packageSpecifiers: {
        auggy: "file:/tmp/auggy-0.5.0.tgz",
        "@auggy/anthropic": "file:/src/packages/anthropic",
      },
    });

    expect(JSON.parse(text).dependencies).toEqual({
      auggy: "file:/tmp/auggy-0.5.0.tgz",
      "@auggy/anthropic": "file:/src/packages/anthropic",
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

describe("getAuggyPackageSpecifierOverride", () => {
  test("returns trimmed env override when present", () => {
    expect(
      getAuggyPackageSpecifierOverride({
        AUGGY_SCAFFOLD_AUGGY_SPEC: "  file:/tmp/auggy.tgz  ",
      } as NodeJS.ProcessEnv),
    ).toBe("file:/tmp/auggy.tgz");
  });

  test("ignores blank env override", () => {
    expect(
      getAuggyPackageSpecifierOverride({
        AUGGY_SCAFFOLD_AUGGY_SPEC: "   ",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe("resolveAuggyPackageSpecifierForCreate", () => {
  test("env override wins over local tarball discovery", () => {
    const root = tempDir();
    writeFileSync(join(root, "auggy-9.9.9.tgz"), "placeholder");

    expect(
      resolveAuggyPackageSpecifierForCreate({
        cwd: root,
        version: "9.9.9",
        env: { AUGGY_SCAFFOLD_AUGGY_SPEC: " file:/explicit/auggy.tgz " } as NodeJS.ProcessEnv,
      }),
    ).toBe("file:/explicit/auggy.tgz");
  });

  test("finds a packed auggy tarball in the current directory", () => {
    const root = tempDir();
    writeFileSync(join(root, "auggy-9.9.9.tgz"), "placeholder");

    expect(
      resolveAuggyPackageSpecifierForCreate({
        cwd: root,
        version: "9.9.9",
        env: {},
      }),
    ).toBe(`file:${join(root, "auggy-9.9.9.tgz")}`);
  });

  test("finds a packed auggy tarball in a parent directory", () => {
    const root = tempDir();
    const agentParent = join(root, ".auggy-dx-lab", "nested");
    mkdirSync(agentParent, { recursive: true });
    writeFileSync(join(root, "auggy-9.9.9.tgz"), "placeholder");

    expect(
      resolveAuggyPackageSpecifierForCreate({
        cwd: agentParent,
        version: "9.9.9",
        env: {},
      }),
    ).toBe(`file:${join(root, "auggy-9.9.9.tgz")}`);
  });

  test("returns undefined when no explicit override or nearby tarball exists", () => {
    expect(
      resolveAuggyPackageSpecifierForCreate({
        cwd: tempDir(),
        version: "9.9.9",
        env: {},
      }),
    ).toBeUndefined();
  });
});

describe("resolveScaffoldPackageSpecifiersForCreate", () => {
  function writePackage(dir: string, name: string, version: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  }

  test("coordinates core and provider directly from an Auggy source checkout", () => {
    const root = tempDir();
    const version = "9.9.9";
    writePackage(root, "auggy", version);
    writePackage(join(root, "packages", "anthropic"), "@auggy/anthropic", version);

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: join(root, "test-agent"),
        provider: "anthropic",
        version,
        env: {},
      }),
    ).toEqual({
      auggy: `file:${root}`,
      "@auggy/anthropic": `file:${join(root, "packages", "anthropic")}`,
    });
  });

  test("uses the linked source root when create runs outside the checkout", () => {
    const root = tempDir();
    const externalCwd = tempDir();
    const version = "9.9.9";
    writePackage(root, "auggy", version);
    writePackage(join(root, "packages", "anthropic"), "@auggy/anthropic", version);

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: externalCwd,
        sourceRoot: root,
        provider: "anthropic",
        version,
        env: {},
      }),
    ).toEqual({
      auggy: `file:${root}`,
      "@auggy/anthropic": `file:${join(root, "packages", "anthropic")}`,
    });
  });

  test("includes OpenAI when a local OpenRouter adapter depends on it", () => {
    const root = tempDir();
    const version = "9.9.9";
    writePackage(root, "auggy", version);
    writePackage(join(root, "packages", "openai"), "@auggy/openai", version);
    writePackage(join(root, "packages", "openrouter"), "@auggy/openrouter", version);

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: root,
        provider: "openrouter",
        version,
        env: {},
      }),
    ).toEqual({
      auggy: `file:${root}`,
      "@auggy/openai": `file:${join(root, "packages", "openai")}`,
      "@auggy/openrouter": `file:${join(root, "packages", "openrouter")}`,
    });
  });

  test("an explicit core tarball overrides source checkout discovery", () => {
    const root = tempDir();
    const version = "9.9.9";
    const coreTarball = join(root, "auggy.tgz");
    writePackage(root, "auggy", version);
    writePackage(join(root, "packages", "anthropic"), "@auggy/anthropic", version);
    writeFileSync(coreTarball, "placeholder");

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: root,
        sourceRoot: false,
        provider: "anthropic",
        version,
        env: {
          AUGGY_SCAFFOLD_AUGGY_SPEC: `file:${coreTarball}`,
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      auggy: `file:${coreTarball}`,
      "@auggy/anthropic": `file:${join(root, "packages", "anthropic")}`,
    });
  });

  test("ignores stale missing file overrides when linked source is available", () => {
    const root = tempDir();
    const version = "9.9.9";
    writePackage(root, "auggy", version);
    writePackage(join(root, "packages", "anthropic"), "@auggy/anthropic", version);

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: tempDir(),
        sourceRoot: root,
        provider: "anthropic",
        version,
        env: {
          AUGGY_SCAFFOLD_AUGGY_SPEC: "file:/deleted/auggy.tgz",
          AUGGY_SCAFFOLD_ENGINE_SPEC: "file:/deleted/auggy-anthropic.tgz",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      auggy: `file:${root}`,
      "@auggy/anthropic": `file:${join(root, "packages", "anthropic")}`,
    });
  });

  test("supports an explicit packed engine adapter outside a checkout", () => {
    const root = tempDir();
    const coreTarball = join(root, "auggy.tgz");

    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: root,
        sourceRoot: false,
        provider: "anthropic",
        version: "9.9.9",
        env: {
          AUGGY_SCAFFOLD_AUGGY_SPEC: `file:${coreTarball}`,
          AUGGY_SCAFFOLD_ENGINE_SPEC: " file:/packs/auggy-anthropic.tgz ",
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      auggy: `file:${coreTarball}`,
      "@auggy/anthropic": "file:/packs/auggy-anthropic.tgz",
    });
  });

  test("leaves provider resolution on semver for normal registry installs", () => {
    expect(
      resolveScaffoldPackageSpecifiersForCreate({
        cwd: tempDir(),
        sourceRoot: false,
        provider: "anthropic",
        version: "9.9.9",
        env: {},
      }),
    ).toEqual({});
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

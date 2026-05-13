import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../fixtures/temp-dir";
import {
  importFromAgent,
  MissingAgentDependencyError,
  MissingAgentManifestError,
} from "../../src/cli/import-from-agent";

/**
 * Test strategy
 *
 * We're proving the v0.3.2 contract: `importFromAgent` resolves the
 * specifier against `<agentDir>/node_modules`, honors ESM-only packages
 * (`"type": "module"` + `exports` map), and fails with explicit error
 * types when the manifest or dependency is missing.
 *
 * Fixtures use mkdtempSync + raw filesystem writes — no `bun install` —
 * so the tests are hermetic and runtime-independent.
 */

interface Fixture {
  path: string;
  cleanup: () => Promise<void>;
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await createTempDir();
});

afterEach(async () => {
  await fixture.cleanup();
});

function writeAgentManifest(agentDir: string): void {
  writeFileSync(
    join(agentDir, "package.json"),
    JSON.stringify(
      {
        name: "test-agent",
        private: true,
        type: "module",
        dependencies: {},
      },
      null,
      2,
    ),
  );
}

function installEsmPackage(
  agentDir: string,
  packageName: string,
  body: string,
  opts: { exports?: boolean } = {},
): void {
  const pkgDir = join(agentDir, "node_modules", packageName);
  mkdirSync(pkgDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    name: packageName,
    version: "0.0.1",
    type: "module",
    main: "./index.js",
  };
  if (opts.exports !== false) {
    manifest.exports = { ".": "./index.js" };
  }

  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(pkgDir, "index.js"), body);
}

function installScopedEsmPackage(
  agentDir: string,
  scope: string,
  name: string,
  body: string,
): void {
  const pkgDir = join(agentDir, "node_modules", scope, name);
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: `${scope}/${name}`,
        version: "0.0.1",
        type: "module",
        main: "./dist/index.js",
        exports: { ".": "./dist/index.js" },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(pkgDir, "dist"));
  writeFileSync(join(pkgDir, "dist", "index.js"), body);
}

describe("importFromAgent", () => {
  test("resolves and imports an ESM package from the agent's node_modules", async () => {
    writeAgentManifest(fixture.path);
    installEsmPackage(
      fixture.path,
      "fake-engine",
      `export const HELLO = "from agent dir";
       export function makeEngine() { return { kind: "fake", id: HELLO }; }
      `,
    );

    const mod = await importFromAgent<{
      HELLO: string;
      makeEngine: () => { kind: string; id: string };
    }>(fixture.path, "fake-engine");

    expect(mod.HELLO).toBe("from agent dir");
    expect(mod.makeEngine()).toEqual({ kind: "fake", id: "from agent dir" });
  });

  test("resolves an ESM package using the `exports` field (Codex #2 — @auggy/link shape)", async () => {
    writeAgentManifest(fixture.path);
    installScopedEsmPackage(
      fixture.path,
      "@auggy",
      "fake-link",
      `export const VERSION = "0.0.1-test";
       export class PeerClient {}
      `,
    );

    const mod = await importFromAgent<{ VERSION: string; PeerClient: new () => object }>(
      fixture.path,
      "@auggy/fake-link",
    );

    expect(mod.VERSION).toBe("0.0.1-test");
    expect(typeof mod.PeerClient).toBe("function");
    expect(new mod.PeerClient()).toBeInstanceOf(mod.PeerClient);
  });

  test("ignores packages installed in the CLI's node_modules — resolves only from the agent dir", async () => {
    writeAgentManifest(fixture.path);
    // Deliberately do NOT install the package in the agent dir. The CLI's
    // own node_modules has `openai`, `@anthropic-ai/sdk`, etc. — none of
    // those should be resolvable through this helper from the agent dir.
    await expect(importFromAgent(fixture.path, "openai")).rejects.toBeInstanceOf(
      MissingAgentDependencyError,
    );
  });

  test("returns distinct module instances for two different agent dirs", async () => {
    const second = await createTempDir();
    try {
      writeAgentManifest(fixture.path);
      writeAgentManifest(second.path);
      installEsmPackage(
        fixture.path,
        "fake-engine",
        `export const TAG = "first-dir";`,
      );
      installEsmPackage(
        second.path,
        "fake-engine",
        `export const TAG = "second-dir";`,
      );

      const first = await importFromAgent<{ TAG: string }>(fixture.path, "fake-engine");
      const last = await importFromAgent<{ TAG: string }>(second.path, "fake-engine");

      expect(first.TAG).toBe("first-dir");
      expect(last.TAG).toBe("second-dir");
    } finally {
      await second.cleanup();
    }
  });

  test("throws MissingAgentManifestError when <agentDir>/package.json is absent", async () => {
    // Agent dir exists (createTempDir created it) but no package.json was written.
    await expect(importFromAgent(fixture.path, "anything")).rejects.toBeInstanceOf(
      MissingAgentManifestError,
    );
  });

  test("MissingAgentManifestError message points at the boot-time migration path", async () => {
    let caught: unknown;
    try {
      await importFromAgent(fixture.path, "anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingAgentManifestError);
    const msg = (caught as Error).message;
    expect(msg).toContain(fixture.path);
    expect(msg).toContain("auggy dev");
    expect(msg).toContain("boot-time migration");
  });

  test("throws MissingAgentDependencyError when the specifier is not installed", async () => {
    writeAgentManifest(fixture.path);
    await expect(
      importFromAgent(fixture.path, "@auggy/never-installed"),
    ).rejects.toBeInstanceOf(MissingAgentDependencyError);
  });

  test("MissingAgentDependencyError message names the specifier and prescribes bun install", async () => {
    writeAgentManifest(fixture.path);
    let caught: unknown;
    try {
      await importFromAgent(fixture.path, "@auggy/never-installed");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingAgentDependencyError);
    const msg = (caught as Error).message;
    expect(msg).toContain("@auggy/never-installed");
    expect(msg).toContain(fixture.path);
    expect(msg).toContain("bun install");
  });

  test("MissingAgentDependencyError carries the underlying resolution error as `cause`", async () => {
    writeAgentManifest(fixture.path);
    let caught: MissingAgentDependencyError | undefined;
    try {
      await importFromAgent(fixture.path, "@auggy/never-installed");
    } catch (err) {
      caught = err as MissingAgentDependencyError;
    }
    expect(caught).toBeInstanceOf(MissingAgentDependencyError);
    expect(caught?.specifier).toBe("@auggy/never-installed");
    expect(caught?.agentDir).toBe(fixture.path);
    // The cause is whatever the runtime's resolver threw — shape may vary,
    // but it must be present so downstream callers can diagnose.
    expect((caught as { cause?: unknown }).cause).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectProjectRuntime, parseRuntimeCapabilities } from "../../src/cli/project-runtime";

let directory: string;
let project: string;
let runtime: string;
const capabilities = { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] } as const;

function updateManifest(update: Record<string, unknown>) {
  const path = join(runtime, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, ...update }));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "auggy-project-runtime-"));
  project = join(directory, "project");
  runtime = join(project, "node_modules/auggy");
  mkdirSync(join(runtime, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "auggy",
      version: "9.4.2",
      type: "module",
      engines: { bun: ">=1.3.14" },
      auggyRuntime: capabilities,
      bin: { auggy: "src/cli.ts" },
      exports: { "./application": "./src/application.ts" },
    }),
  );
  const sentinel = join(directory, "executed");
  const code = `await Bun.write(${JSON.stringify(sentinel)}, 'must not execute');\n`;
  writeFileSync(join(runtime, "src/cli.ts"), code);
  writeFileSync(join(runtime, "src/application.ts"), code);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("explicit project runtime selection", () => {
  test.each(["bun", "node"])(
    "falls through an unmatched nested %s export condition",
    (condition) => {
      updateManifest({
        exports: {
          "./application": {
            [condition]: { require: "./src/require.ts" },
            default: "./src/application.ts",
          },
        },
      });
      const expected = realpathSync(join(runtime, "src/application.ts"));
      expect(realpathSync(Bun.resolveSync("auggy/application", project))).toBe(expected);
      expect(inspectProjectRuntime(project, { applicationContract: 1 }).applicationPath).toBe(
        expected,
      );
      expect(existsSync(join(directory, "executed"))).toBe(false);
    },
  );

  test("an explicit null conditional export blocks the outer fallback", () => {
    updateManifest({
      exports: { "./application": { bun: null, default: "./src/application.ts" } },
    });
    expect(() => Bun.resolveSync("auggy/application", project)).toThrow();
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /application export/,
    );
    expect(existsSync(join(directory, "executed"))).toBe(false);
  });

  test("selects compatible local metadata without executing package code or comparing npm versions", () => {
    const selected = inspectProjectRuntime(project, { applicationContract: 1 });
    expect(selected.packageRoot).toBe(realpathSync(runtime));
    expect(selected.cliPath).toBe(realpathSync(join(runtime, "src/cli.ts")));
    expect(selected.applicationPath).toBe(realpathSync(join(runtime, "src/application.ts")));
    expect(selected.version).toBe("9.4.2");
    expect(selected.manifestSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.capabilities?.applicationContracts)).toBe(true);
    expect(existsSync(join(directory, "executed"))).toBe(false);
  });

  test("accepts an explicitly installed workspace link and canonical project path", () => {
    const linked = join(directory, "linked");
    mkdirSync(join(linked, "node_modules"), { recursive: true });
    writeFileSync(join(linked, "package.json"), "{}");
    symlinkSync(runtime, join(linked, "node_modules/auggy"));
    const alias = join(directory, "project-alias");
    symlinkSync(linked, alias);
    const selected = inspectProjectRuntime(alias, { applicationContract: 1 });
    expect(selected.projectDir).toBe(realpathSync(linked));
    expect(selected.packageRoot).toBe(realpathSync(runtime));
  });

  test("rejects ancestor resolution even when the ancestor has a valid Auggy install", () => {
    const child = join(project, "nested-app");
    mkdirSync(child);
    writeFileSync(join(child, "package.json"), "{}");
    expect(() => inspectProjectRuntime(child, { applicationContract: 1 })).toThrow(
      /install Auggy explicitly in this project/,
    );
  });

  test("requires valid project and package manifests without disclosing their contents", () => {
    updateManifest({ name: "other-package" });
    expect(() => inspectProjectRuntime(project)).toThrow(/valid local auggy package/);
    updateManifest({ name: "auggy" });
    for (const contents of ["null", "[]", '{"secret": "do-not-echo"']) {
      writeFileSync(join(project, "package.json"), contents);
      expect(() => inspectProjectRuntime(project)).toThrow(/valid local auggy package/);
      try {
        inspectProjectRuntime(project);
      } catch (error) {
        expect(String(error)).not.toContain("do-not-echo");
      }
    }
  });

  test("allows absent capability metadata only for legacy launch", () => {
    updateManifest({ auggyRuntime: undefined });
    expect(inspectProjectRuntime(project).capabilities).toBeNull();
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /does not support application contract 1/,
    );
  });

  test("does not downgrade malformed or future metadata to legacy", () => {
    for (const metadata of [
      null,
      [],
      {},
      { ...capabilities, schemaVersion: 2 },
      { ...capabilities, launcherProtocol: 2 },
      { ...capabilities, executable: "src/cli.ts" },
      { ...capabilities, applicationContracts: [] },
      { ...capabilities, applicationContracts: [1, 1] },
      { ...capabilities, applicationContracts: ["1"] },
      { ...capabilities, applicationContracts: [0] },
      { ...capabilities, applicationContracts: [1.5] },
    ]) {
      updateManifest({ auggyRuntime: metadata });
      expect(() => inspectProjectRuntime(project)).toThrow(/capability metadata/);
    }
    expect(parseRuntimeCapabilities({ ...capabilities, applicationContracts: [1, 2] })).toEqual({
      ...capabilities,
      applicationContracts: [1, 2],
    });
  });

  test("rejects a contract not supported by both this launcher and the selected package", () => {
    updateManifest({ auggyRuntime: { ...capabilities, applicationContracts: [2] } });
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /does not support application contract 1/,
    );
    expect(() => inspectProjectRuntime(project, { applicationContract: 2 })).toThrow(
      /does not support application contract 1/,
    );
  });

  test("enforces launcher and selected package Bun requirements", () => {
    expect(() => inspectProjectRuntime(project, { bunVersion: "1.3.13" })).toThrow(
      /Bun 1.3.14 or newer/,
    );
    expect(() => inspectProjectRuntime(project, { bunVersion: "bad-version" })).toThrow(
      /Bun 1.3.14 or newer/,
    );
    expect(inspectProjectRuntime(project, { bunVersion: "1.3.14" }).version).toBe("9.4.2");
    for (const engines of [
      undefined,
      {},
      { bun: 123 },
      { bun: "" },
      { bun: ">=999.0.0" },
      { bun: "garbage" },
      { bun: ">=1.3.14-." },
      { bun: ">=1.3.14-01" },
      { bun: ">=1.3.14+." },
      { bun: "1.3.*-foo" },
      { bun: ">=1.3.14 || garbage" },
    ]) {
      updateManifest({ engines });
      expect(() => inspectProjectRuntime(project)).toThrow(/declared Bun requirement/);
    }
  });

  test("accepts standard comparator, alternative, partial and release ranges", () => {
    for (const bun of [
      "^1.3.14",
      "~1.3.14",
      ">=1.3.14 <2.0.0",
      ">= 1.3.14 < 2.0.0",
      "1.3.x",
      "1.x",
      "*",
      "1.3.14 - 2.0.0",
      "9.0.0 || >=1.3.14",
      ">=1.3.14-rc.1+build.02",
    ]) {
      updateManifest({ engines: { bun } });
      expect(inspectProjectRuntime(project, { bunVersion: "1.3.14" }).version).toBe("9.4.2");
    }
  });

  test("rejects a project alias that redirects the declared application export", () => {
    writeFileSync(join(runtime, "src/alternate.ts"), "throw new Error('must not execute');\n");
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "auggy/application": ["./node_modules/auggy/src/alternate.ts"],
          },
        },
      }),
    );
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /CLI or application export/,
    );
  });

  test("honors declared Bun ESM export conditions without executing their targets", () => {
    updateManifest({
      exports: {
        "./application": {
          types: "./src/types.d.ts",
          bun: { import: "./src/application.ts", require: "./src/missing.ts" },
          default: "./src/missing.ts",
        },
      },
    });
    expect(inspectProjectRuntime(project, { applicationContract: 1 }).applicationPath).toBe(
      realpathSync(join(runtime, "src/application.ts")),
    );
    expect(existsSync(join(directory, "executed"))).toBe(false);
  });

  test("rejects CLI traversal, URLs, missing files and symlink escapes", () => {
    const outside = join(directory, "outside.ts");
    writeFileSync(outside, "export {};\n");
    symlinkSync(outside, join(runtime, "src/escape.ts"));
    for (const bin of [
      "../../../outside.ts",
      outside,
      "file:///tmp/cli.ts",
      "C:\\cli.ts",
      "src\\cli.ts",
      "src/cli.ts\0",
      "src/missing.ts",
      "src",
      "src/escape.ts",
    ]) {
      updateManifest({ bin: { auggy: bin } });
      expect(() => inspectProjectRuntime(project)).toThrow(/CLI or application export/);
    }
  });

  test("requires an explicit application export contained in the selected package", () => {
    updateManifest({ exports: undefined });
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /CLI or application export/,
    );
    const outside = join(directory, "outside.ts");
    writeFileSync(outside, "export {};\n");
    symlinkSync(outside, join(runtime, "src/outside.ts"));
    updateManifest({ exports: { "./application": "./src/outside.ts" } });
    expect(() => inspectProjectRuntime(project, { applicationContract: 1 })).toThrow(
      /CLI or application export/,
    );
  });

  test("rejects a package manifest symlink outside the canonical package", () => {
    const manifestPath = join(runtime, "package.json");
    const outside = join(dirname(project), "manifest.json");
    writeFileSync(outside, readFileSync(manifestPath));
    rmSync(manifestPath);
    symlinkSync(outside, manifestPath);
    expect(() => inspectProjectRuntime(project)).toThrow(/valid local auggy package/);
  });
});

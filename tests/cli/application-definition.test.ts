import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  parseApplicationDeclaration,
  readApplicationDefinition,
  resolveApplicationDefinition,
} from "../../src/cli/application-definition";
import { parseConfig } from "../../src/cli/config-parser";

let directory: string;
let project: string;
let configPath: string;
const declaration = { entrypoint: "./src/index.ts", contractVersion: 1 } as const;
const baseConfig = {
  id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
  name: "contract-agent",
  engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
  augments: [
    {
      name: "identity",
      type: "fileMemory" as const,
      options: {
        label: "self",
        source: "./identity.md",
        mutable: false,
        origin: "operator",
        priority: "required",
        placement: "system",
        eviction: "never",
      },
    },
  ],
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "auggy-application-definition-"));
  project = join(directory, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.ts"), "throw new Error('entry must not be imported');\n");
  writeFileSync(join(project, "identity.md"), "# Fixture identity\n");
  configPath = join(project, "agent.yaml");
  writeFileSync(configPath, stringify({ ...baseConfig, application: declaration }));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("application declaration preflight", () => {
  test("reads literal metadata without importing entry code or loading project env", () => {
    const envKey = `AUGGY_APPLICATION_TEST_${crypto.randomUUID().replaceAll("-", "_")}`;
    const sentinel = join(project, "imported");
    writeFileSync(join(project, ".env"), `${envKey}=must-not-load\n`);
    writeFileSync(
      join(project, "src/index.ts"),
      `await Bun.write(${JSON.stringify(sentinel)}, 'imported');\n`,
    );
    const definition = readApplicationDefinition(configPath)!;
    expect(definition.application).toEqual(declaration);
    expect(definition.entrypointPath).toBe(realpathSync(join(project, "src/index.ts")));
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.application)).toBe(true);
    expect(process.env[envKey]).toBeUndefined();
    expect(existsSync(sentinel)).toBe(false);
  });

  test("absent declaration remains legacy, while a present malformed declaration rejects", () => {
    writeFileSync(configPath, stringify(baseConfig));
    expect(readApplicationDefinition(configPath)).toBeUndefined();
    expect(parseConfig(configPath).application).toBeUndefined();
    for (const application of [
      null,
      [],
      "src/index.ts",
      {},
      { ...declaration, contractVersion: 2 },
    ]) {
      writeFileSync(configPath, stringify({ ...baseConfig, application }));
      expect(() => readApplicationDefinition(configPath)).toThrow(/application/);
    }
  });

  test("full parser retains the same opt-in declaration and existing legacy fields", () => {
    const parsed = parseConfig(configPath);
    expect(parsed.application).toEqual(declaration);
    expect(parsed.name).toBe(baseConfig.name);
    expect(parsed.engine.provider).toBe("anthropic");
    expect(parsed.augments).toEqual(baseConfig.augments);
  });

  test("rejects unknown fields and non-integer contract declarations", () => {
    for (const application of [
      { ...declaration, enabled: true },
      { ...declaration, contractVersion: "1" },
      { ...declaration, contractVersion: 1.5 },
      { ...declaration, contractVersion: true },
    ]) {
      expect(() => parseApplicationDeclaration(application)).toThrow(/application/);
    }
  });

  test("rejects absolute, URL, control, cross-platform and substituted paths", () => {
    for (const entrypoint of [
      "",
      " ./src/index.ts",
      "/tmp/index.ts",
      "file:///tmp/index.ts",
      "https://example.test/index.ts",
      "C:\\agent\\index.ts",
      "C:index.ts",
      "..\\index.ts",
      "./src/index.ts\0",
      "./src/index\n.ts",
      "${AUGGY_ENTRYPOINT}",
    ]) {
      expect(() => parseApplicationDeclaration({ ...declaration, entrypoint })).toThrow(
        /literal relative filesystem path/,
      );
    }
  });

  test("full parsing rejects entrypoint substitution before env interpolation", () => {
    writeFileSync(
      configPath,
      stringify({ ...baseConfig, application: { ...declaration, entrypoint: "${M3_ENTRY}" } }),
    );
    const previous = process.env.M3_ENTRY;
    process.env.M3_ENTRY = "./src/index.ts";
    try {
      expect(() => parseConfig(configPath)).toThrow(/literal relative filesystem path/);
    } finally {
      if (previous === undefined) delete process.env.M3_ENTRY;
      else process.env.M3_ENTRY = previous;
    }
  });

  test("rejects missing files, directories and lexical or symlink escapes", () => {
    writeFileSync(join(directory, "outside.ts"), "export {};\n");
    symlinkSync(join(directory, "outside.ts"), join(project, "src/escape.ts"));
    for (const entrypoint of ["./missing.ts", "./src", "../outside.ts", "./src/escape.ts"]) {
      expect(() =>
        resolveApplicationDefinition(configPath, { ...declaration, entrypoint }),
      ).toThrow(/regular file inside the project/);
    }
  });

  test("accepts an entry symlink contained within the selected project", () => {
    symlinkSync(join(project, "src/index.ts"), join(project, "entry.ts"));
    const definition = resolveApplicationDefinition(configPath, {
      ...declaration,
      entrypoint: "./entry.ts",
    });
    expect(definition.entrypointPath).toBe(realpathSync(join(project, "src/index.ts")));
  });

  test("keeps config-symlink paths anchored to the selected project, like augment paths", () => {
    const shared = join(directory, "shared.yaml");
    writeFileSync(shared, stringify({ ...baseConfig, application: declaration }));
    rmSync(configPath);
    symlinkSync(shared, configPath);
    const definition = readApplicationDefinition(configPath)!;
    expect(definition.projectDir).toBe(realpathSync(project));
    expect(definition.entrypointPath).toBe(realpathSync(join(project, "src/index.ts")));
    expect(parseConfig(configPath).application).toEqual(declaration);
  });

  test("invalid YAML errors do not disclose source excerpts or secret values", () => {
    const secret = "fixture-secret-do-not-echo";
    writeFileSync(configPath, `application: [${secret}\n`);
    let error: unknown;
    try {
      readApplicationDefinition(configPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("readable, valid YAML");
    expect((error as Error).message).not.toContain(secret);
  });
});

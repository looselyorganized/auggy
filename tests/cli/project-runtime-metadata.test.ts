import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import {
  inspectProjectRuntimeMetadata,
  ProjectRuntimeMetadataError,
} from "../../src/cli/project-runtime";

let directory: string;
let project: string;
let runtime: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "auggy-passive-metadata-"));
  project = join(directory, "project");
  runtime = join(project, "node_modules/auggy");
  mkdirSync(join(runtime, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), '{"private":true,"type":"module"}');
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "auggy",
      version: "9.4.2",
      engines: { bun: ">=1.3.14" },
      auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] },
      bin: { auggy: "src/cli.ts" },
      exports: { "./application": { types: "./src/public.d.ts", default: "./src/application.ts" } },
    }),
  );
  // Static package code is intentionally fatal if a supposedly passive reader imports it.
  writeFileSync(join(runtime, "src/cli.ts"), 'throw new Error("unexpected-cli-import");');
  writeFileSync(
    join(runtime, "src/application.ts"),
    'throw new Error("unexpected-application-import");',
  );
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function expectCode(action: () => unknown, code: ProjectRuntimeMetadataError["code"]) {
  try {
    action();
    throw new Error("expected passive metadata rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectRuntimeMetadataError);
    expect((error as ProjectRuntimeMetadataError).code).toBe(code);
    expect(String(error)).not.toContain("private-manifest-value");
  }
}

describe("bounded passive local runtime metadata", () => {
  test("finds real entry paths without imports, project aliases, or Bun resolution", () => {
    const resolver = spyOn(Bun, "resolveSync").mockImplementation(() => {
      throw new Error("passive metadata must not consult the module resolver");
    });
    try {
      writeFileSync(join(project, "tsconfig.json"), "private-manifest-value");
      const result = inspectProjectRuntimeMetadata(project);
      expect(result.packageRoot).toBe(realpathSync(runtime));
      expect(result.applicationPath).toBe(realpathSync(join(runtime, "src/application.ts")));
      expect(result.manifestSHA256).toMatch(/^[a-f0-9]{64}$/);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      resolver.mockRestore();
    }
  });

  test("distinguishes missing local dependencies from malformed metadata", () => {
    rmSync(join(runtime, "package.json"));
    expectCode(() => inspectProjectRuntimeMetadata(project), "missing-runtime");
    writeFileSync(join(runtime, "package.json"), '{"private-manifest-value":');
    expectCode(() => inspectProjectRuntimeMetadata(project), "invalid-metadata");
    rmSync(join(project, "package.json"));
    expectCode(() => inspectProjectRuntimeMetadata(project), "missing-project");
  });

  test.each(["project", "runtime"])("bounds and validates %s JSON before use", (selected) => {
    const path = join(selected === "project" ? project : runtime, "package.json");
    for (const bytes of [
      Buffer.from('{"secret":"private-manifest-value"'),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
      Buffer.from("[]"),
      Buffer.alloc(AUTHORING_LIMITS.documentBytes + 1, 32),
    ]) {
      writeFileSync(path, bytes);
      expectCode(() => inspectProjectRuntimeMetadata(project), "invalid-metadata");
    }
  });

  test("does not follow manifest symlinks or ancestor runtime installations", () => {
    const child = join(project, "nested");
    mkdirSync(child);
    writeFileSync(join(child, "package.json"), "{}");
    expectCode(() => inspectProjectRuntimeMetadata(child), "missing-runtime");
    const manifest = join(runtime, "package.json");
    const external = join(directory, "external.json");
    writeFileSync(external, readFileSync(manifest));
    rmSync(manifest);
    symlinkSync(external, manifest);
    expectCode(() => inspectProjectRuntimeMetadata(project), "invalid-metadata");
  });

  test("accepts an explicit package link while requiring contained entry files", () => {
    const linked = join(directory, "linked");
    mkdirSync(join(linked, "node_modules"), { recursive: true });
    writeFileSync(join(linked, "package.json"), "{}");
    symlinkSync(runtime, join(linked, "node_modules/auggy"));
    expect(inspectProjectRuntimeMetadata(linked).packageRoot).toBe(realpathSync(runtime));
    const outside = join(directory, "outside.ts");
    writeFileSync(outside, 'throw new Error("outside-import");');
    rmSync(join(runtime, "src/application.ts"));
    symlinkSync(outside, join(runtime, "src/application.ts"));
    expectCode(() => inspectProjectRuntimeMetadata(linked), "invalid-metadata");
  });

  test("retains legacy capability absence for a partial inspection report", () => {
    const path = join(runtime, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    delete manifest.auggyRuntime;
    writeFileSync(path, JSON.stringify(manifest));
    const result = inspectProjectRuntimeMetadata(project);
    expect(result.capabilities).toBeNull();
    expect(result.applicationPath).toBeNull();
    expectCode(
      () => inspectProjectRuntimeMetadata(project, { applicationContract: 1 }),
      "invalid-metadata",
    );
  });
});

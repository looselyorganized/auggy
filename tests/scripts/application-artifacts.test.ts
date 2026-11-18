import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applicationArtifact,
  buildDifferentVersionArtifact,
  buildSameVersionArtifact,
  preserveApplicationBaselineReference,
} from "../../scripts/release-smoke/application-artifacts";
import {
  applicationHash,
  inspectApplicationArtifact,
} from "../../scripts/release-smoke/application-consumer";
import {
  HISTORICAL_APPLICATION_RECIPE as recipe,
  INSPECTABLE_APPLICATION_RECIPE,
} from "../../scripts/release-smoke/application-recipe";

let root: string;
let source: string;
let output: string;
let verifiedFiles: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-baseline-reference-"));
  source = join(root, "source");
  output = join(root, "output");
  mkdirSync(output);
  verifiedFiles = {};
  for (const file of recipe.sourceFiles) {
    const archivedPath = `examples/inspectable-agent/${file}`;
    const path = join(source, archivedPath);
    const bytes =
      file === "agent.yaml"
        ? "application: { entrypoint: ./src/index.ts, contractVersion: 1 }\n"
        : `archived ${file}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    verifiedFiles[archivedPath] = applicationHash(bytes);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("current and pinned reference recipes keep their distinct owned entrypoints", () => {
  expect(INSPECTABLE_APPLICATION_RECIPE.entrypoint).toBe("src/main.ts");
  expect(INSPECTABLE_APPLICATION_RECIPE.sourceFiles).not.toContain("src/index.ts");
  expect(INSPECTABLE_APPLICATION_RECIPE.sourceFiles).not.toContain("src/agent.ts");
  expect(recipe.entrypoint).toBe("src/index.ts");
  expect(recipe.sourceFiles).toContain("src/agent.ts");
  expect(recipe.sourceFiles).not.toContain("src/main.ts");
  for (const edit of Object.values(INSPECTABLE_APPLICATION_RECIPE.edits)) {
    const source = readFileSync(
      join(import.meta.dir, "../../examples/inspectable-agent", edit.path),
      "utf8",
    );
    expect(source.split(edit.before)).toHaveLength(2);
  }
});

test("retains only verified pinned reference files independently of the temporary build tree", () => {
  const privatePath = join(source, "examples/inspectable-agent/node_modules/private.txt");
  mkdirSync(dirname(privatePath), { recursive: true });
  writeFileSync(privatePath, "installed bytes must stay behind");
  writeFileSync(join(source, "examples/inspectable-agent/.env"), "PRIVATE=never-copy");
  const retained = preserveApplicationBaselineReference(source, output, verifiedFiles);
  expect(Object.keys(retained.referenceFiles)).toEqual([...recipe.sourceFiles]);
  for (const file of recipe.sourceFiles) {
    expect(applicationHash(readFileSync(join(retained.referenceDir, file)))).toBe(
      verifiedFiles[`examples/inspectable-agent/${file}`]!,
    );
  }
  rmSync(source, { recursive: true });
  expect(readFileSync(join(retained.referenceDir, "agent.yaml"), "utf8")).toContain(
    "contractVersion: 1",
  );
  expect(existsSync(join(retained.referenceDir, "node_modules"))).toBe(false);
  expect(existsSync(join(retained.referenceDir, ".env"))).toBe(false);
});

test.each(["missing-hash", "changed-bytes", "linked-source"])(
  "rejects unverified baseline reference %s before publishing",
  (mode) => {
    const file = "examples/inspectable-agent/src/index.ts";
    if (mode === "missing-hash") delete verifiedFiles[file];
    if (mode === "changed-bytes") writeFileSync(join(source, file), "changed");
    if (mode === "linked-source") {
      rmSync(join(source, file));
      symlinkSync(join(source, "examples/inspectable-agent/src/agent.ts"), join(source, file));
    }
    expect(() => preserveApplicationBaselineReference(source, output, verifiedFiles)).toThrow();
    expect(existsSync(join(output, "reference"))).toBe(false);
  },
);

test.each(["same-version", "different-version"] as const)(
  "%s fixture changes only its declared manifest field and retains runtime source hashes",
  async (kind) => {
    const packageRoot = join(root, "packed-source/package");
    mkdirSync(join(packageRoot, "src/cli"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "auggy",
        version: "0.5.0",
        files: ["src"],
        exports: { "./cli": "./src/cli/index.ts" },
        auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1, 2] },
      }),
    );
    writeFileSync(
      join(packageRoot, "src/cli/index.ts"),
      'throw new Error("fixture source must not execute");\n',
    );
    writeFileSync(join(packageRoot, "src/types.ts"), 'export type Fixture = "unchanged";\n');
    const archive = join(root, "core.tgz");
    expect(
      Bun.spawnSync([
        "tar",
        "-czf",
        archive,
        "-C",
        dirname(packageRoot),
        "package/package.json",
        "package/src/cli/index.ts",
        "package/src/types.ts",
      ]).exitCode,
    ).toBe(0);
    const input = await applicationArtifact(archive, "auggy");
    const original = inspectApplicationArtifact(input);
    const build =
      kind === "same-version" ? buildSameVersionArtifact : buildDifferentVersionArtifact;
    const built = await build(input, join(root, kind));
    const changed = inspectApplicationArtifact(built);
    expect(built.sha256).not.toBe(input.sha256);
    expect(changed.version).toBe(kind === "same-version" ? "0.5.0" : "0.5.1");
    expect(changed.manifest).toEqual({
      ...original.manifest,
      ...(kind === "same-version"
        ? { auggyApplicationFixture: "same-version-global-cli" }
        : { version: "0.5.1" }),
    });
    const runtimeHashes = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).filter(([file]) => file !== "package.json"));
    expect(runtimeHashes(changed.fileHashes)).toEqual(runtimeHashes(original.fileHashes));
    const evidence = JSON.parse(
      readFileSync(
        join(
          root,
          kind,
          kind === "same-version" ? "same-version-fixture.json" : "version-fixture.json",
        ),
        "utf8",
      ),
    );
    expect(evidence).toMatchObject({
      status: "passed",
      published: false,
      sourceSHA256: input.sha256,
      cleanupUnknown: false,
    });
    await expect(
      build({ ...input, sha256: "0".repeat(64) }, join(root, "rejected")),
    ).rejects.toThrow("input changed");
    expect(existsSync(join(root, "rejected"))).toBe(false);
  },
);

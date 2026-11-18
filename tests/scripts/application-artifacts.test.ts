import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applicationArtifact,
  buildDifferentVersionArtifact,
  buildSameVersionArtifact,
} from "../../scripts/release-smoke/application-artifacts";
import { inspectApplicationArtifact } from "../../scripts/release-smoke/application-consumer";
import { INSPECTABLE_APPLICATION_RECIPE } from "../../scripts/release-smoke/application-recipe";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-application-artifacts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the current reference recipe identifies its owned entrypoint and edits", () => {
  expect(INSPECTABLE_APPLICATION_RECIPE.entrypoint).toBe("src/main.ts");
  expect(INSPECTABLE_APPLICATION_RECIPE.sourceFiles).not.toContain("src/index.ts");
  expect(INSPECTABLE_APPLICATION_RECIPE.sourceFiles).not.toContain("src/agent.ts");
  for (const edit of Object.values(INSPECTABLE_APPLICATION_RECIPE.edits)) {
    const source = readFileSync(
      join(import.meta.dir, "../../examples/inspectable-agent", edit.path),
      "utf8",
    );
    expect(source.split(edit.before)).toHaveLength(2);
  }
});

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

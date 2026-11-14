import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applicationHash } from "../../scripts/release-smoke/application-consumer";
import { verifyIntegrationArtifactSource } from "../../scripts/release-smoke/integration-artifact-source";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("all packed source is verified, including a helper outside the selected execution files", () => {
  const root = mkdtempSync(join(tmpdir(), "m5-packed-source-"));
  roots.push(root);
  const repo = join(root, "repo"),
    pack = join(root, "pack/package"),
    archive = join(root, "package.tgz");
  const source = {
    "package.json": '{"name":"auggy","version":"0.5.0"}',
    "src/index.ts": 'export { helper } from "./helpers";',
    "src/helpers.ts": "export const helper = true;",
  };
  const sourceFiles = Object.entries(source).map(([path, bytes]) => {
    for (const directory of [repo, pack]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), bytes);
    }
    return { path, sha256: applicationHash(bytes) };
  });
  const inspect = () => {
    const result = spawnSync(
      "tar",
      [
        "-czf",
        archive,
        "-C",
        dirname(pack),
        "package/package.json",
        "package/src/index.ts",
        "package/src/helpers.ts",
      ],
      { timeout: 5000 },
    );
    expect(result.status).toBe(0);
    return verifyIntegrationArtifactSource({
      repoRoot: repo,
      archive,
      packageName: "auggy",
      sourceFiles,
    });
  };
  expect(inspect().files).toHaveLength(3);
  writeFileSync(join(pack, "src/helpers.ts"), "export const helper = null;");
  expect(() => inspect()).toThrow("Packed file differs");
  copyFileSync(join(repo, "src/helpers.ts"), join(pack, "src/helpers.ts"));
  const omitted = spawnSync(
    "tar",
    ["-czf", archive, "-C", dirname(pack), "package/package.json", "package/src/index.ts"],
    { timeout: 5000 },
  );
  expect(omitted.status).toBe(0);
  expect(() =>
    verifyIntegrationArtifactSource({ repoRoot: repo, archive, packageName: "auggy", sourceFiles }),
  ).toThrow("incomplete");
});

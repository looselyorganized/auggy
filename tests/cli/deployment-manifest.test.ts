import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeploymentManifest, validateDeploymentManifest } from "../../src/cli/deploy/manifest";
import { deploymentManifestFixture } from "../fixtures/deployment-manifest";

const expected = {
  agentId: "aug1_11111111-1111-4111-8111-111111111111",
  agentName: "fixture",
  configPath: "agent.yaml",
};

test("deployment metadata is identity-bound and rejects inconsistent evidence groups", () => {
  const manifest = deploymentManifestFixture(expected);
  expect(validateDeploymentManifest(manifest, expected)).toEqual(manifest);
  for (const value of [
    { ...manifest, version: 2 },
    { ...manifest, agentId: "aug1_22222222-2222-4222-8222-222222222222" },
    { ...manifest, configPath: "other.yaml" },
    { ...manifest, selection: "http" },
    { ...manifest, evidence: "operator-declared" },
    { ...manifest, extra: "unexpected" },
    { ...manifest, lockfileSHA256: "b".repeat(64) },
    { ...manifest, generatedFiles: [] },
    { ...manifest, sourceFiles: [...manifest.sourceFiles].reverse() },
    {
      ...manifest,
      dependencyTarballs: [{ ...manifest.sourceFiles[0], path: "../dependency.tgz" }],
    },
    {
      ...manifest,
      dependencyTarballs: [{ ...manifest.sourceFiles[0], path: "auggy-deployment.json" }],
    },
    { ...manifest, dependencyTarballs: [{ ...manifest.sourceFiles[0], path: "package.json" }] },
    {
      ...manifest,
      profile: { kind: "http", port: 80, healthPath: "//outside.test/health", consolePath: null },
    },
  ])
    expect(() => validateDeploymentManifest(value, expected)).toThrow();
});

test("runtime metadata reads are bounded and reject external, symlink and hardlinked files", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-deployment-metadata-"));
  const project = join(root, "project");
  mkdirSync(project);
  const json = JSON.stringify(deploymentManifestFixture(expected));
  const file = join(project, "auggy-deployment.json");
  writeFileSync(file, json);
  try {
    expect(readDeploymentManifest(file, project, expected).agentId).toBe(expected.agentId);
    writeFileSync(join(root, "outside.json"), json);
    expect(() => readDeploymentManifest(join(root, "outside.json"), project, expected)).toThrow(
      /inside/,
    );
    symlinkSync(file, join(project, "linked.json"));
    expect(() => readDeploymentManifest(join(project, "linked.json"), project, expected)).toThrow();
    linkSync(file, join(project, "hardlinked.json"));
    expect(() => readDeploymentManifest(file, project, expected)).toThrow();
    rmSync(join(project, "hardlinked.json"));
    writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    expect(() => readDeploymentManifest(file, project, expected)).toThrow(/exceeds/);
    expect(() => readDeploymentManifest("", project, expected)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

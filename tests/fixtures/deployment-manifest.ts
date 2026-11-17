import {
  DEPLOYMENT_TOOLCHAIN,
  type DeploymentManifestV1,
  type DeploymentManifestExpectation,
} from "../../src/cli/deploy/contracts";

/** Descriptive metadata fixture; hashes here deliberately claim no image execution. */
export function deploymentManifestFixture(
  expected: DeploymentManifestExpectation,
): DeploymentManifestV1 {
  const sha256 = "a".repeat(64);
  return {
    version: 1,
    ...expected,
    profile: { kind: "none" },
    selection: "auto",
    evidence: "known-config",
    toolchain: DEPLOYMENT_TOOLCHAIN,
    packageJsonSHA256: sha256,
    lockfileSHA256: sha256,
    sourceFiles: [expected.configPath, "bun.lock", "package.json"]
      .sort()
      .map((path) => ({ path, sha256, bytes: 1, mode: 0o644 })),
    dependencyTarballs: [],
    generatedFiles: ["Dockerfile", "auggy-entrypoint.sh"].map((path) => ({
      path,
      sha256,
      bytes: 1,
      mode: 0o644,
    })),
  };
}

import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptedBuildEnvironment, runAcceptedBuildCommand } from "./accepted-main-artifacts";
import {
  applicationHash,
  assertInstalledApplicationArtifact,
  type PackedArtifactEvidence,
} from "./application-consumer";
import { INSPECTABLE_APPLICATION_RECIPE } from "./application-recipe";

/** Generated deployment and command-boundary proof; no hosted deploy is performed. */
export async function verifyApplicationDeployment(options: {
  repoRoot: string;
  consumer: string;
  workspace: string;
  core: PackedArtifactEvidence;
  evidenceDirectory: string;
}) {
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const local = assertInstalledApplicationArtifact(
    options.consumer,
    options.repoRoot,
    options.core,
    "auggy/cli",
  );
  const { stageBundle } = await import(
    pathToFileURL(join(local.packageRoot, "src/cli/deploy/bundle.ts")).href
  );
  const { generateDockerfile, generateEntrypoint } = await import(
    pathToFileURL(join(local.packageRoot, "src/cli/deploy/dockerfile.ts")).href
  );
  const staged = stageBundle({
    agentDir: options.consumer,
    agentName: "inspectable-agent",
  }) as string;
  const generated = {
    Dockerfile: generateDockerfile({ agentName: "inspectable-agent" }) as string,
    "auggy-entrypoint.sh": generateEntrypoint() as string,
  };
  const sourceHashes: Record<string, string> = {};
  let primary: unknown;
  let cleanupFailure = false;
  const report: Record<string, unknown> = {
    state: "running",
    scope: "generated deployment plus command-boundary tests",
    hostedDeploy: "not-performed",
  };
  try {
    for (const file of INSPECTABLE_APPLICATION_RECIPE.sourceFiles) {
      const source = readFileSync(join(options.consumer, file));
      if (applicationHash(readFileSync(join(staged, file))) !== applicationHash(source))
        throw new Error("Deployment staging changed application source");
      sourceHashes[file] = applicationHash(source);
    }
    for (const path of ["node_modules", ".env", "data", ".auggy"])
      if (existsSync(join(staged, path)))
        throw new Error("Deployment staging included excluded state");
    for (const [file, content] of Object.entries(generated))
      writeFileSync(join(options.evidenceDirectory, file), content, { mode: 0o600 });
    const env = acceptedBuildEnvironment(options.workspace);
    const tests = await runAcceptedBuildCommand({
      command: [
        process.execPath,
        "test",
        "tests/cli/deploy/dockerfile.test.ts",
        "tests/cli/deploy/bundle.test.ts",
        "tests/cli/deploy.test.ts",
      ],
      cwd: options.repoRoot,
      env,
    });
    const { stdout, stderr, ...testResult } = tests;
    writeFileSync(join(options.evidenceDirectory, "deployment-tests.log"), `${stdout}\n${stderr}`, {
      mode: 0o600,
    });
    if (tests.status !== "passed")
      throw new Error("Generated deployment or artifact-selection regression failed");
    const docker = await runAcceptedBuildCommand({
      command: ["docker", "version", "--format", "{{.Server.Version}}"],
      cwd: options.workspace,
      env,
      timeoutMs: 10_000,
    });
    if (docker.cleanupUnknown) throw new Error("Docker availability probe did not settle");
    Object.assign(report, {
      state: "passed",
      rows: ["L13-linux-generated", "L14-deploy-artifact"],
      installedCoreSHA256: options.core.sha256,
      sourceHashes,
      generatedHashes: Object.fromEntries(
        Object.entries(generated).map(([file, text]) => [file, applicationHash(text)]),
      ),
      testResult,
      containerExecution:
        docker.status === "passed"
          ? "not-executed; generated-files gate only"
          : "unavailable; Docker daemon probe failed",
      dockerProbe: {
        status: docker.status,
        exitCode: docker.exitCode,
        stdoutSHA256: docker.stdoutSHA256,
        stderrSHA256: docker.stderrSHA256,
      },
      artifactSelection:
        "unit-tested declared registry dependency unaffected by nearby tarball; explicit file tarball securely rebased; linked source rejected",
    });
  } catch (error) {
    primary = error;
    report.state = "failed";
  } finally {
    try {
      rmSync(staged, { recursive: true });
    } catch {
      cleanupFailure = true;
      report.state = "failed";
    }
    report.cleanupConfirmed = !cleanupFailure;
    report.retainedStaging = cleanupFailure ? staged : null;
    writeFileSync(
      join(options.evidenceDirectory, "application-deployment.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (primary) throw primary;
  if (cleanupFailure) throw new Error("Deployment staging cleanup failed");
  return report;
}

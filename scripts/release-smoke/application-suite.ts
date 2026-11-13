import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildAcceptedMainArtifacts,
  acceptedBuildEnvironment,
  runAcceptedBuildCommand,
} from "./accepted-main-artifacts";
import {
  applicationArtifact,
  buildApplicationBaseline,
  buildDifferentVersionArtifact,
} from "./application-artifacts";
import {
  APPLICATION_ROWS,
  applicationHash,
  type PackedArtifactInput,
} from "./application-consumer";
import { installApplicationConsumer } from "./application-install";
import { runApplicationCompatibility } from "./application-compatibility";
import { runInstalledApplicationLaunchd } from "./application-launchd";
import {
  INSPECTABLE_APPLICATION_RECIPE as recipe,
  INSPECTABLE_ORDER_OUTPUT as expectedToolOutput,
} from "./application-recipe";
import { runInstalledApplication } from "./application-runner";
import { runRetainedApplicationUpgrade } from "./application-upgrade";
import { runInstalledApplicationLifecycle } from "./application-lifecycle";
import { verifyApplicationDeployment } from "./application-deployment";

/** Full application acceptance; existing foundation/Link rehearsal remains separate. */
export async function runApplicationSuite(options: {
  repoRoot: string;
  candidateCore: string;
  candidateProvider: string;
  evidenceDirectory: string;
  foundationUpgradeEvidence?: string;
}) {
  const repoRoot = resolve(options.repoRoot);
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-application-suite-"));
  let passed = false;
  let failure: string | null = null;
  const results: Record<string, unknown> = {};
  const rows: Record<string, { status: string; evidence: string[]; note?: string }> =
    Object.fromEntries(APPLICATION_ROWS.map((row) => [row, { status: "pending", evidence: [] }]));
  const accept = (row: string, files: string[], note?: string) => {
    rows[row] = { status: "passed", evidence: files, ...(note ? { note } : {}) };
  };
  const report = (relative: string) => JSON.parse(readFileSync(join(evidence, relative), "utf8"));

  const install = (
    name: string,
    core: PackedArtifactInput,
    provider: PackedArtifactInput,
    legacy = false,
  ) =>
    installApplicationConsumer({
      repoRoot,
      workspace,
      name,
      core,
      provider,
      legacy,
      evidenceDirectory: join(evidence, "installs"),
    });
  const context = (name: string) => {
    const home = join(workspace, `home-${name}`);
    const temporaryDirectory = join(workspace, `tmp-${name}`);
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    return {
      repoRoot,
      home,
      temporaryDirectory,
      evidenceDirectory: join(evidence, name),
      recipe,
      expectedToolOutput,
    };
  };
  try {
    const core = await applicationArtifact(options.candidateCore, "auggy");
    const provider = await applicationArtifact(options.candidateProvider, "@auggy/anthropic");
    const baseline = await buildApplicationBaseline(
      repoRoot,
      join(evidence, "application-baseline"),
    );
    const legacyBuild = await buildAcceptedMainArtifacts({
      repositoryRoot: repoRoot,
      outputDirectory: join(evidence, "accepted-legacy"),
    });
    const legacyCore = await applicationArtifact(legacyBuild.core.path, "auggy");
    const legacyProvider = await applicationArtifact(legacyBuild.provider.path, "@auggy/anthropic");
    const unequalCore = await buildDifferentVersionArtifact(
      core,
      join(evidence, "different-version"),
    );
    const global = await install("global", baseline.core, baseline.provider);
    const fresh = await install("fresh", core, provider);
    const compatibility = await install("compatibility", core, provider);
    const legacy = await install("legacy", legacyCore, legacyProvider, true);
    const differentVersion = await install("different-version", unequalCore, provider);
    const launchd = await install("launchd", core, provider);
    const retained = await install("retained", baseline.core, baseline.provider);
    results.artifacts = {
      candidate: { core, provider },
      baseline,
      legacy: legacyBuild.source,
      differentVersion: unequalCore,
    };
    await runInstalledApplication({ ...context("fresh"), ...fresh, global });
    results.fresh = "passed";
    const freshReport = report("fresh/application-scenarios.json");
    if (freshReport.state !== "passed" || freshReport.cleanup !== "confirmed")
      throw new Error("Fresh application evidence is incomplete");
    for (const row of [
      "L01-launch-parity",
      "L02-startup-edit",
      "L03-http-edit",
      "L04-turn-edit",
      "L11-recovery",
    ]) {
      if (freshReport.pendingRows.includes(row)) throw new Error(`Missing installed proof: ${row}`);
      accept(row, ["fresh/application-scenarios.json"]);
    }
    await runInstalledApplicationLifecycle({ ...context("lifecycle"), ...fresh, global });
    const lifecycleReport = report("lifecycle/application-lifecycle.json");
    if (lifecycleReport.state !== "passed" || lifecycleReport.cleanup !== "confirmed")
      throw new Error("Lifecycle evidence is incomplete");
    accept("L10-lifecycle", ["lifecycle/application-lifecycle.json"]);

    await runApplicationCompatibility({
      ...context("compatibility"),
      ...compatibility,
      global,
      differentVersion,
      acceptedLegacy: { ...legacy, buildEvidencePath: legacyBuild.evidencePath },
    });
    results.compatibility = "passed";
    const compatibilityReport = report("compatibility/compatibility.json");
    if (
      compatibilityReport.status !== "passed" ||
      compatibilityReport.unsafeCleanup ||
      compatibilityReport.cleanupErrors.length
    )
      throw new Error("Compatibility evidence is incomplete");
    for (const row of ["L05-preflight", "L08-delegation", "L09-old-local-legacy"])
      accept(
        row,
        ["compatibility/compatibility.json"],
        row === "L05-preflight"
          ? "Older Bun tested through installed inspector injection; unsupported binary never executed"
          : undefined,
      );
    if (
      freshReport.scenarios["same-version-artifact-selection"]?.status !== "passed" &&
      freshReport.scenarios["same-version-artifact-selection"]?.state !== "passed"
    )
      throw new Error("Same-version selection evidence missing");
    if (
      !Object.entries(compatibilityReport.scenarios).some(
        ([key, value]) =>
          key.startsWith("L07-") && (value as { status: string }).status === "passed",
      )
    )
      throw new Error("Different-version selection evidence missing");
    accept(
      "L07-artifact-selection",
      ["fresh/application-scenarios.json", "compatibility/compatibility.json"],
      "Unpublished fixture artifacts; no released-version claim",
    );

    results.launchd = await runInstalledApplicationLaunchd({
      ...context("launchd"),
      ...launchd,
      global,
    });
    const launchReport = report("launchd/application-launchd.json");
    if (!launchReport.cleanupConfirmed || !["passed", "unavailable"].includes(launchReport.state))
      throw new Error("launchd result did not settle");
    rows["L12-macos-launchd"] = {
      status: launchReport.state,
      evidence: ["launchd/application-launchd.json"],
      note:
        launchReport.state === "unavailable"
          ? "Requires separately accepted actual macOS evidence"
          : "Actual macOS service executed",
    };
    results.deployment = await verifyApplicationDeployment({
      repoRoot,
      workspace,
      consumer: fresh.consumer,
      core: fresh.core,
      evidenceDirectory: join(evidence, "deployment"),
    });
    accept(
      "L13-linux-generated",
      ["deployment/application-deployment.json"],
      "Generated files and unit guards; container availability recorded separately",
    );
    accept(
      "L14-deploy-artifact",
      ["deployment/application-deployment.json"],
      "Command-boundary tests; no hosted deployment",
    );
    const boundaryTests = await runAcceptedBuildCommand({
      command: [
        process.execPath,
        "test",
        "tests/cli/import-from-agent.test.ts",
        "tests/cli/engine-resolver.test.ts",
        "tests/cli/commands/run.test.ts",
        "tests/cli/commands/dev.test.ts",
      ],
      cwd: repoRoot,
      env: acceptedBuildEnvironment(workspace),
    });
    const { stdout, stderr, ...boundaryResult } = boundaryTests;
    writeFileSync(join(evidence, "selector-browser-tests.log"), `${stdout}\n${stderr}`, {
      mode: 0o600,
    });
    if (boundaryTests.status !== "passed")
      throw new Error("Selector/browser boundary regressions failed");
    results.selectorBrowserTests = boundaryResult;
    accept(
      "L15-options-env",
      [
        "compatibility/compatibility.json",
        "selector-browser-tests.log",
        "launchd/application-launchd.json",
        "deployment/application-deployment.json",
      ],
      "Browser dispatch verified through injected opener; actual modes scoped by platform",
    );
    rows["L06-workspace-policy"] = {
      status: "partial",
      evidence: ["compatibility/compatibility.json", "selector-browser-tests.log"],
      note: "Packed Link gate remains required",
    };
    results.retained = await runRetainedApplicationUpgrade({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidence, "retained-upgrade"),
      retained,
      current: fresh,
      global,
      core,
      provider,
    });
    if (options.foundationUpgradeEvidence) {
      const foundationBytes = readFileSync(options.foundationUpgradeEvidence);
      const foundation = JSON.parse(foundationBytes.toString("utf8"));
      if (
        foundation.status !== "passed" ||
        foundation.failures.length ||
        foundation.phases.retainedOverride.candidateSHA256 !== core.sha256 ||
        foundation.phases.candidateTurn.status !== "passed" ||
        foundation.phases.linkSelected.runtime !== "passed" ||
        foundation.phases.linkFresh.runtime !== "passed"
      )
        throw new Error("Foundation and Link evidence does not certify this candidate");
      results.foundation = {
        path: options.foundationUpgradeEvidence,
        sha256: applicationHash(foundationBytes),
        coreSHA256: core.sha256,
      };
      accept("L16-retained-upgrade", ["retained-upgrade", options.foundationUpgradeEvidence]);
      accept("L06-workspace-policy", [
        "compatibility/compatibility.json",
        "selector-browser-tests.log",
        options.foundationUpgradeEvidence,
      ]);
    } else
      rows["L16-retained-upgrade"] = {
        status: "partial",
        evidence: ["retained-upgrade"],
        note: "Foundation retained-lock and packed Link gates remain required",
      };
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : "Application suite failed";
    throw error;
  } finally {
    if (passed) {
      try {
        rmSync(workspace, { recursive: true });
      } catch {
        passed = false;
        failure = "Suite workspace cleanup failed";
      }
    }
    writeFileSync(
      join(evidence, "application-suite.json"),
      `${JSON.stringify({ schemaVersion: 1, executionStatus: passed ? "passed" : "failed", matrixStatus: !passed ? "failed" : Object.values(rows).every((row) => row.status === "passed") ? "complete" : "incomplete", rows, results, failure, retainedWorkspace: passed ? null : workspace }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (!passed) throw new Error("Suite workspace cleanup failed; evidence retained");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !value ||
      ![
        "--repo-root",
        "--candidate-core",
        "--candidate-anthropic",
        "--evidence-dir",
        "--foundation-upgrade-evidence",
      ].includes(key) ||
      values[key]
    )
      throw new Error("Invalid application suite arguments");
    values[key] = value;
  }
  for (const key of ["--repo-root", "--candidate-core", "--candidate-anthropic", "--evidence-dir"])
    if (!values[key]) throw new Error(`Missing ${key}`);
  await runApplicationSuite({
    repoRoot: values["--repo-root"]!,
    candidateCore: values["--candidate-core"]!,
    candidateProvider: values["--candidate-anthropic"]!,
    evidenceDirectory: values["--evidence-dir"]!,
    foundationUpgradeEvidence: values["--foundation-upgrade-evidence"],
  });
}

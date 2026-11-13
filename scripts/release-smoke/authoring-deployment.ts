/** Generated source staging through the installed package; no container or hosted deployment. */
import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
} from "./application-consumer";
import {
  assertAuthoringCommandSucceeded,
  prepareAuthoringWorkspace,
  readAuthoringSource,
  runBoundedAuthoringCli,
  snapshotGeneratedAuthoringSources,
} from "./authoring-consumer";
import {
  AUTHORING_BOUNDS,
  AUTHORING_EXECUTION_FILES,
  type FileHashes,
  type GeneratedAuthoringConsumer,
} from "./authoring-contract";
import { readBoundedRegularFile } from "./bounded-file";
import { assertFreshGeneratedServiceState } from "./authoring-launchd";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export const GENERATED_DEPLOYMENT_EXCLUSIONS = [
  ".env",
  ".env.production",
  ".auggy",
  "data",
  "node_modules",
  "deployment-proof.sqlite",
  "deployment-proof.sqlite-wal",
  "deployment-proof.sqlite-shm",
] as const;

/** Both sides use contained, descriptor-bounded source readers. No recursive customer traversal. */
export function assertGeneratedDeploymentBundle(options: {
  consumer: string;
  staged: string;
  sourceFiles: readonly string[];
}): FileHashes {
  const { consumer, staged, sourceFiles } = options;
  check(
    sourceFiles.length <= AUTHORING_BOUNDS.sourceFiles &&
      new Set(sourceFiles).size === sourceFiles.length,
    "Generated deployment source allowlist must be bounded and unique",
  );
  check(
    ["agent.yaml", "package.json", ...AUTHORING_EXECUTION_FILES].every((file) =>
      sourceFiles.includes(file),
    ),
    "Generated deployment lacks its configuration or execution source contract",
  );
  let total = 0;
  const sourceHashes: Record<string, string> = {};
  for (const file of sourceFiles) {
    const original = readAuthoringSource(consumer, file),
      copied = readAuthoringSource(staged, file);
    total += original.byteLength + copied.byteLength;
    check(
      total <= AUTHORING_BOUNDS.totalSourceBytes * 2,
      "Generated deployment sources exceeded their total byte bound",
    );
    const hash = applicationHash(original);
    check(hash === applicationHash(copied), "Generated deployment changed owned source or assets");
    sourceHashes[file] = hash;
  }
  for (const file of GENERATED_DEPLOYMENT_EXCLUSIONS)
    check(
      !lstatSync(join(staged, file), { throwIfNoEntry: false }),
      "Generated deployment included private state, credentials or dependencies",
    );
  return sourceHashes;
}

export interface GeneratedDeploymentOptions {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  consumer: GeneratedAuthoringConsumer;
}

const CUSTOM_FILES = [
  "src/augments/deployment-capability/index.ts",
  "src/augments/deployment-capability/schemas.ts",
  "src/augments/deployment-capability/service.ts",
  "src/augments/deployment-capability/README.md",
  "tests/augments/deployment-capability.test.ts",
  "skills/deployment-capability/SKILL.md",
] as const;
const CANARIES = [
  ".env.production",
  ".auggy/deployment-proof-private",
  "data/deployment-proof.json",
  "node_modules/.deployment-proof-private",
  "deployment-proof.sqlite",
  "deployment-proof.sqlite-wal",
  "deployment-proof.sqlite-shm",
] as const;

export async function verifyGeneratedDeployment(options: GeneratedDeploymentOptions) {
  prepareAuthoringWorkspace(options.workspace);
  const repoRoot = realpathSync(options.repoRoot),
    consumer = realpathSync(options.consumer.consumer);
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    state: "running",
    cleanupConfirmed: false,
    scope: "actual generated source and asset staging through installed package",
    hostedDeployment: "not-performed",
    containerExecution: "not-performed",
    packageArtifactRebasing:
      "separate existing deployment boundary tests; this gate verifies source staging",
  };
  const write = () =>
    writeFileSync(
      join(evidence, "authoring-deployment.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  write();
  let staged: string | undefined, primary: unknown;
  const created: string[] = [];
  let commandCleanupConfirmed = true;
  let stagingAttempted = false;
  try {
    report.generatedState = assertFreshGeneratedServiceState(consumer);
    const original = snapshotGeneratedAuthoringSources({
      repoRoot,
      consumer,
      sourceFiles: options.consumer.sourceFiles,
    });
    assertOnlyApplicationEdits(options.consumer.installedSources, original, []);
    const local = assertInstalledApplicationArtifact(
      consumer,
      repoRoot,
      options.consumer.core,
      "auggy/cli",
    );
    for (const file of ["src/cli/deploy/bundle.ts", "src/cli/deploy/dockerfile.ts"]) {
      const expected = options.consumer.core.fileHashes[file];
      check(
        expected !== undefined &&
          applicationHash(
            readBoundedRegularFile(join(local.packageRoot, file), AUTHORING_BOUNDS.sourceBytes)
              .bytes,
          ) === expected,
        "Installed deployment module lacks exact packed source evidence",
      );
    }
    commandCleanupConfirmed = false;
    const create = await runBoundedAuthoringCli({
      entry: local.entry,
      args: ["augment", "create", "deployment-capability", "--with-skill"],
      cwd: consumer,
      workspace: options.workspace,
    });
    commandCleanupConfirmed = create.cleanupConfirmed;
    report.authoringCommand = create;
    assertAuthoringCommandSucceeded(create);
    const sourceFiles = [...options.consumer.sourceFiles, ...CUSTOM_FILES];
    const authored = snapshotGeneratedAuthoringSources({ repoRoot, consumer, sourceFiles });
    for (const file of AUTHORING_EXECUTION_FILES)
      check(
        authored[file] === original[file],
        "Custom authoring changed generated execution source",
      );
    for (const file of CANARIES)
      check(
        !lstatSync(join(consumer, file), { throwIfNoEntry: false }),
        "Deployment canary destination already exists",
      );
    check(lstatSync(join(consumer, ".env")).isFile(), "Generated secret file is missing");
    for (const file of CANARIES) {
      mkdirSync(dirname(join(consumer, file)), { recursive: true, mode: 0o700 });
      writeFileSync(join(consumer, file), "private-deployment-canary-never-bundled\n", {
        mode: 0o600,
        flag: "wx",
      });
      created.push(file);
    }
    const { stageBundle } = await import(
      pathToFileURL(join(local.packageRoot, "src/cli/deploy/bundle.ts")).href
    );
    const { generateDockerfile, generateEntrypoint } = await import(
      pathToFileURL(join(local.packageRoot, "src/cli/deploy/dockerfile.ts")).href
    );
    stagingAttempted = true;
    const output: unknown = stageBundle({ agentDir: consumer, agentName: "generated-deployment" });
    check(typeof output === "string", "Installed bundler did not return its staging directory");
    const resolved = realpathSync(output);
    check(
      dirname(resolved) === realpathSync(tmpdir()) &&
        basename(resolved).startsWith("auggy-deploy-generated-deployment-") &&
        resolved !== consumer,
      "Installed bundler returned an unexpected cleanup destination",
    );
    staged = resolved;
    const sourceHashes = assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles });
    const httpPath = join(staged, "src/http.ts"),
      httpBytes = readAuthoringSource(staged, "src/http.ts");
    let changedSourceRejected = false;
    try {
      writeFileSync(
        httpPath,
        Buffer.concat([httpBytes, Buffer.from("\n// unexpected deployed source\n")]),
      );
      try {
        assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles });
      } catch {
        changedSourceRejected = true;
      }
    } finally {
      writeFileSync(httpPath, httpBytes);
    }
    check(changedSourceRejected, "Deployment verifier accepted altered owned source");
    const turnPath = join(staged, "src/turn.ts"),
      turnBytes = readAuthoringSource(staged, "src/turn.ts");
    let missingSourceRejected = false;
    try {
      unlinkSync(turnPath);
      try {
        assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles });
      } catch {
        missingSourceRejected = true;
      }
    } finally {
      writeFileSync(turnPath, turnBytes, { mode: 0o600, flag: "wx" });
    }
    check(missingSourceRejected, "Deployment verifier accepted missing turn source");
    assertGeneratedDeploymentBundle({ consumer, staged, sourceFiles });
    const dockerfile: unknown = generateDockerfile({ agentName: "generated-deployment" });
    const entrypoint: unknown = generateEntrypoint();
    check(
      typeof dockerfile === "string" &&
        dockerfile.includes("COPY . /app") &&
        typeof entrypoint === "string" &&
        entrypoint.includes(
          'exec bun "$runtime_cli" dev "$1" --config /app/agent.yaml --internal-mode railway',
        ),
      "Installed deployment output does not carry source to the managed local launcher",
    );
    check(
      Buffer.byteLength(dockerfile) + Buffer.byteLength(entrypoint) <= AUTHORING_BOUNDS.sourceBytes,
      "Generated deployment files exceeded their bound",
    );
    writeFileSync(join(evidence, "Dockerfile"), dockerfile, { mode: 0o600 });
    writeFileSync(join(evidence, "auggy-entrypoint.sh"), entrypoint, { mode: 0o600 });
    Object.assign(report, {
      state: "passed",
      installedCoreSHA256: options.consumer.core.sha256,
      installedDeploymentModules: Object.fromEntries(
        ["src/cli/deploy/bundle.ts", "src/cli/deploy/dockerfile.ts"].map((file) => [
          file,
          options.consumer.core.fileHashes[file],
        ]),
      ),
      generatedSources: original,
      authoredSources: authored,
      sourceHashes,
      generatedFileHashes: {
        Dockerfile: applicationHash(dockerfile),
        entrypoint: applicationHash(entrypoint),
      },
      excludedPaths: GENERATED_DEPLOYMENT_EXCLUSIONS,
      negativeControls: {
        changedSourceRejected,
        missingSourceRejected,
        privateCanariesExcluded: true,
      },
    });
  } catch (error) {
    primary = error;
    report.state = "failed";
    report.failure =
      error instanceof Error ? error.message : "Generated deployment verification failed";
  } finally {
    const cleanupErrors: string[] = [];
    if (staged) {
      try {
        rmSync(staged, { recursive: true });
      } catch {
        cleanupErrors.push("staging-removal-failed");
      }
    }
    for (const file of created) {
      try {
        unlinkSync(join(consumer, file));
      } catch {
        cleanupErrors.push("canary-removal-failed");
      }
    }
    report.cleanupConfirmed =
      cleanupErrors.length === 0 &&
      commandCleanupConfirmed &&
      (!stagingAttempted || staged !== undefined);
    report.cleanupErrors = cleanupErrors;
    if (!report.cleanupConfirmed) {
      report.state = "failed";
      report.retainedStaging = staged ?? null;
    }
    write();
  }
  if (primary) throw primary;
  check(report.cleanupConfirmed, "Generated deployment cleanup was not confirmed");
  return report;
}

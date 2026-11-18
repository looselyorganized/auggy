import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acceptedBuildEnvironment,
  runAcceptedBuildCommand,
  validateAcceptedPackInventory,
} from "./accepted-main-artifacts";
import {
  applicationHash,
  APPLICATION_BOUNDS,
  inspectApplicationArtifact,
  type PackedArtifactInput,
} from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";
export async function applicationArtifact(
  path: string,
  packageName: string,
): Promise<PackedArtifactInput> {
  const selectedPath = resolve(path);
  const file = join(realpathSync(dirname(selectedPath)), basename(selectedPath));
  const { bytes } = readBoundedRegularFile(file, APPLICATION_BOUNDS.artifactBytes);
  const list = (flag: string) => {
    const result = spawnSync("tar", [flag, file], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8",
    });
    if (result.error || result.status !== 0 || result.signal)
      throw new Error("Cannot inventory bounded packed artifact");
    return result.stdout;
  };
  const inventory = validateAcceptedPackInventory(list("-tzf"), list("-tvzf"));
  const selected = [
    "package.json",
    "README.md",
    "src/application/",
    "src/kernel/turn-",
    "src/agent.ts",
    "src/types.ts",
    "src/transports/managed-http-router.ts",
    "src/transports/web-transport.ts",
    "src/cli/index.ts",
    "src/cli/cli-program.ts",
    "src/cli/command-bootstrap.ts",
    "src/cli/project-runtime.ts",
    "src/cli/application-definition.ts",
    "src/cli/augment-resolver.ts",
    "src/cli/commands/dev.ts",
    "src/cli/deploy/bundle.ts",
    "src/cli/deploy/dockerfile.ts",
    "src/cli/authoring/",
    "src/cli/authoring-command-options.ts",
    "src/cli/authoring-command-handlers.ts",
    "src/cli/authoring-bootstrap.ts",
    "src/cli/builtin-types.ts",
    "src/cli/augment-catalog.ts",
    "src/cli/scaffold-application.ts",
    "src/cli/scaffold-custom-augment.ts",
    "src/cli/scaffold-package-json.ts",
    "src/cli/scaffold-skills.ts",
    "src/cli/commands/create.ts",
    "src/cli/commands/add.ts",
    "src/cli/commands/augment.ts",
    "src/cli/commands/agentmail.ts",
    "src/cli/commands/inspect.ts",
    "src/cli/commands/migrate.ts",
    "src/scaffold-templates/application/",
    "src/metadata/source-index.json",
  ];
  const sourceFiles =
    packageName === "auggy"
      ? inventory.filter((file) =>
          selected.some(
            (path) =>
              file === path ||
              ((path.endsWith("/") || path.endsWith("-")) && file.startsWith(path)),
          ),
        )
      : inventory;
  const input = {
    path: file,
    packageName,
    sha256: applicationHash(bytes),
    sourceFiles,
  };
  inspectApplicationArtifact(input);
  return input;
}

/** Unpublished compatibility fixture; only the npm version field changes. */
export function buildDifferentVersionArtifact(input: PackedArtifactInput, outputDirectory: string) {
  return buildApplicationFixtureArtifact(input, outputDirectory, "different-version");
}

/** A distinct contract-compatible global CLI artifact with the candidate's exact npm version. */
export function buildSameVersionArtifact(input: PackedArtifactInput, outputDirectory: string) {
  return buildApplicationFixtureArtifact(input, outputDirectory, "same-version");
}

async function buildApplicationFixtureArtifact(
  input: PackedArtifactInput,
  outputDirectory: string,
  kind: "different-version" | "same-version",
) {
  const inspectedInput = await applicationArtifact(input.path, input.packageName);
  if (inspectedInput.sha256 !== input.sha256) throw new Error("Version fixture input changed");
  const evidence = inspectApplicationArtifact(inspectedInput);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(evidence.version);
  if (!match || input.packageName !== "auggy") throw new Error("Expected a stable core artifact");
  const version =
    kind === "different-version"
      ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
      : evidence.version;
  const fixtureMarker = "same-version-global-cli";
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-version-fixture-"));
  for (const name of ["home", "tmp", "npm-cache"])
    mkdirSync(join(workspace, name), { mode: 0o700 });
  const env = acceptedBuildEnvironment(workspace);
  let passed = false;
  let cleanupUnknown = false;
  let built: PackedArtifactInput | undefined;
  try {
    const extract = await runAcceptedBuildCommand({
      command: ["tar", "-xzf", input.path, "-C", workspace],
      cwd: workspace,
      env,
    });
    cleanupUnknown ||= extract.cleanupUnknown;
    if (extract.status !== "passed") throw new Error("Version fixture extraction failed");
    const packageRoot = join(workspace, "package");
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(
      readBoundedRegularFile(manifestPath, APPLICATION_BOUNDS.sourceBytes).bytes.toString("utf8"),
    );
    if (kind === "same-version") {
      if (Object.hasOwn(manifest, "auggyApplicationFixture"))
        throw new Error("Fixture marker already exists");
      manifest.auggyApplicationFixture = fixtureMarker;
    } else manifest.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const pack = await runAcceptedBuildCommand({
      command: ["npm", "pack", "--silent", "--ignore-scripts", "--pack-destination", output],
      cwd: packageRoot,
      env,
    });
    cleanupUnknown ||= pack.cleanupUnknown;
    const name = pack.stdout.trim();
    if (pack.status !== "passed" || !/^[a-z0-9.-]+\.tgz$/.test(name))
      throw new Error("Version fixture pack failed");
    const artifact = await applicationArtifact(join(output, name), "auggy");
    const changed = inspectApplicationArtifact(artifact);
    if (artifact.sha256 === input.sha256 || changed.version !== version)
      throw new Error("Fixture artifact did not change as declared");
    const expectedManifest = {
      ...evidence.manifest,
      ...(kind === "same-version" ? { auggyApplicationFixture: fixtureMarker } : { version }),
    };
    if (JSON.stringify(changed.manifest) !== JSON.stringify(expectedManifest))
      throw new Error("Fixture changed unexpected package metadata");
    for (const [file, hash] of Object.entries(evidence.fileHashes)) {
      if (file !== "package.json" && changed.fileHashes[file] !== hash)
        throw new Error("Version fixture changed runtime source");
    }
    passed = true;
    built = artifact;
  } finally {
    if (passed && !cleanupUnknown) {
      try {
        rmSync(workspace, { recursive: true });
      } catch {
        cleanupUnknown = true;
      }
    }
    writeFileSync(
      join(output, kind === "same-version" ? "same-version-fixture.json" : "version-fixture.json"),
      `${JSON.stringify(
        {
          status: passed && !cleanupUnknown ? "passed" : "failed",
          published: false,
          purpose:
            kind === "same-version"
              ? "compatible contract with equal npm versions and distinct fixture metadata"
              : "compatible contract with unequal npm versions",
          fixtureMarker: kind === "same-version" ? fixtureMarker : null,
          sourceSHA256: input.sha256,
          sourceVersion: evidence.version,
          fixtureVersion: version,
          cleanupUnknown,
          retainedWorkspace: passed && !cleanupUnknown ? null : workspace,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  if (cleanupUnknown || !built)
    throw new Error("Version fixture build or cleanup failed; see final evidence");
  return built;
}

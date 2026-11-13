import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acceptedBuildEnvironment,
  runAcceptedBuildCommand,
  validateAcceptedPackInventory,
  verifyAcceptedArchive,
  verifyAcceptedSourceFiles,
} from "./accepted-main-artifacts";
import {
  applicationHash,
  APPLICATION_BOUNDS,
  inspectApplicationArtifact,
  type PackedArtifactInput,
} from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";

// First reviewed application-capable runtime. This is an artifact experiment,
// never a claim that two different 0.5.0 artifacts were published releases.
export const APPLICATION_BASELINE = "73233db23bb1dc17d9a795b19881c79a09266a18";
const BASELINE_LOCK = "cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7";

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

export async function buildApplicationBaseline(repositoryRoot: string, outputDirectory: string) {
  const repo = realpathSync(repositoryRoot);
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-application-baseline-"));
  const source = join(workspace, "source");
  for (const name of ["source", "home", "tmp", "npm-cache"])
    mkdirSync(join(workspace, name), { mode: 0o700 });
  const env = acceptedBuildEnvironment(workspace);
  const commands: object[] = [];
  let cleanupUnknown = false;
  let passed = false;
  let provenance: object | undefined;
  let built:
    | {
        core: PackedArtifactInput;
        provider: PackedArtifactInput;
        commit: string;
        tree: string;
        lockSHA256: string;
      }
    | undefined;
  const run = async (label: string, command: string[], cwd = source) => {
    const result = await runAcceptedBuildCommand({ command, cwd, env });
    const { stdout, stderr, ...record } = result;
    cleanupUnknown ||= result.cleanupUnknown;
    commands.push({ label, ...record });
    writeFileSync(join(output, `${label}.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    if (result.status !== "passed") throw new Error(`Application baseline build failed: ${label}`);
    return stdout.trim();
  };
  try {
    const toolchain = {
      bun: await run("bun-version", [process.execPath, "--version"]),
      node: await run("node-version", ["node", "--version"]),
      npm: await run("npm-version", ["npm", "--version"]),
      platform: process.platform,
      architecture: process.arch,
    };
    if (toolchain.bun !== "1.3.14") throw new Error("Application baseline requires Bun1.3.14");
    const tree = await run("tree", ["git", "rev-parse", `${APPLICATION_BASELINE}^{tree}`], repo);
    const listing = await run(
      "source-inventory",
      ["git", "ls-tree", "-r", APPLICATION_BASELINE],
      repo,
    );
    const archive = join(workspace, "source.tar");
    await run(
      "archive",
      ["git", "archive", "--format=tar", `--output=${archive}`, APPLICATION_BASELINE],
      repo,
    );
    await run("extract", ["tar", "-xf", archive, "-C", source]);
    const files = verifyAcceptedArchive(source, listing);
    if (files["bun.lock"] !== BASELINE_LOCK) throw new Error("Application baseline lock changed");
    await run("install", [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
    const coreName = await run("pack-core", [
      "npm",
      "pack",
      "--silent",
      "--pack-destination",
      output,
    ]);
    const providerName = await run(
      "pack-provider",
      ["npm", "pack", "--silent", "--pack-destination", output],
      join(source, "packages/anthropic"),
    );
    verifyAcceptedSourceFiles(source, files);
    for (const name of [coreName, providerName]) {
      if (!/^[a-z0-9.-]+\.tgz$/.test(name))
        throw new Error("Unexpected baseline artifact filename");
    }
    const core = await applicationArtifact(join(output, coreName), "auggy");
    const provider = await applicationArtifact(join(output, providerName), "@auggy/anthropic");
    provenance = {
      core,
      provider,
      commit: APPLICATION_BASELINE,
      tree,
      lockSHA256: BASELINE_LOCK,
      toolchain,
    };
    passed = true;
    built = { core, provider, commit: APPLICATION_BASELINE, tree, lockSHA256: BASELINE_LOCK };
  } finally {
    if (passed && !cleanupUnknown) {
      try {
        rmSync(workspace, { recursive: true });
      } catch {
        cleanupUnknown = true;
      }
    }
    writeFileSync(
      join(output, "application-baseline.json"),
      `${JSON.stringify(
        {
          status: passed && !cleanupUnknown ? "passed" : "failed",
          commit: APPLICATION_BASELINE,
          provenance,
          commands,
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
    throw new Error("Application baseline build or cleanup failed; see final evidence");
  return built;
}

/** Unpublished compatibility fixture; only the npm version field changes. */
export async function buildDifferentVersionArtifact(
  input: PackedArtifactInput,
  outputDirectory: string,
) {
  const inspectedInput = await applicationArtifact(input.path, input.packageName);
  if (inspectedInput.sha256 !== input.sha256) throw new Error("Version fixture input changed");
  const evidence = inspectApplicationArtifact(inspectedInput);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(evidence.version);
  if (!match || input.packageName !== "auggy") throw new Error("Expected a stable core artifact");
  const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
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
    manifest.version = version;
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
      join(output, "version-fixture.json"),
      `${JSON.stringify(
        {
          status: passed && !cleanupUnknown ? "passed" : "failed",
          published: false,
          purpose: "compatible contract with unequal npm versions",
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

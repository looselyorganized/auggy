import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { runDependencyAudit } from "../audit-dependencies";
import { acceptedBuildEnvironment, runAcceptedBuildCommand } from "./accepted-main-artifacts";
import {
  applicationHash,
  assertInstalledApplicationArtifact,
  snapshotApplicationFiles,
  type PackedArtifactInput,
} from "./application-consumer";
import type { installApplicationConsumer } from "./application-install";
import {
  INSPECTABLE_APPLICATION_RECIPE as recipe,
  INSPECTABLE_ORDER_OUTPUT as expectedToolOutput,
} from "./application-recipe";
import { runInstalledApplication } from "./application-runner";

type Installed = Awaited<ReturnType<typeof installApplicationConsumer>>;

export async function runRetainedApplicationUpgrade(options: {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  retained: Installed;
  current: Installed;
  global: Installed;
  core: PackedArtifactInput;
  provider: PackedArtifactInput;
}) {
  const { repoRoot, workspace, retained, global, core, provider } = options;
  const fresh = options.current;
  const evidence = options.evidenceDirectory;
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const home = join(workspace, "home-retained"),
    temporaryDirectory = join(workspace, "tmp-retained");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const context = (name: string) => ({
    repoRoot,
    home,
    temporaryDirectory,
    evidenceDirectory: join(evidence, name),
    recipe,
    expectedToolOutput,
  });
  // First-run setup establishes one identity retained across both artifacts.
  const configPath = join(retained.consumer, "agent.yaml");
  const config = parse(readFileSync(configPath, "utf8"));
  if (config.id !== "${AUGGY_AGENT_ID}")
    throw new Error("Retained fixture requires an unconfigured copy");
  config.id = `aug1_${randomUUID()}`;
  writeFileSync(configPath, stringify(config), { mode: 0o600 });
  await runInstalledApplication({ ...context("retained-before"), ...retained, global: fresh });
  const ownedPaths = recipe.sourceFiles.filter((file) => file !== "package.json");
  const ownedBefore = snapshotApplicationFiles(retained.consumer, ownedPaths);
  const lockPath = join(retained.consumer, "bun.lock");
  const lockBefore = readFileSync(lockPath);
  const manifestPath = join(retained.consumer, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestBefore = structuredClone(manifest);
  const modules = join(retained.consumer, "node_modules");
  const moduleStat = lstatSync(modules);
  const markerPath = join(modules, `.auggy-retained-${randomUUID()}`);
  const marker = randomUUID();
  writeFileSync(markerPath, marker, { flag: "wx", mode: 0o600 });
  const changedMembers = Object.keys(fresh.core.fileHashes).filter(
    (file) =>
      retained.core.fileHashes[file] &&
      retained.core.fileHashes[file] !== fresh.core.fileHashes[file],
  );
  if (changedMembers.length === 0)
    throw new Error("Upgrade lacks an observed differing artifact member");
  const installedBefore = assertInstalledApplicationArtifact(
    retained.consumer,
    repoRoot,
    retained.core,
    "auggy/application",
  );
  const observedBefore = Object.fromEntries(
    changedMembers.map((file) => [
      file,
      applicationHash(readFileSync(join(installedBefore.packageRoot, file))),
    ]),
  );

  for (const [index, artifact] of [core, provider].entries()) {
    const relative = `.application-artifacts/${index}-${artifact.sha256}.tgz`;
    copyFileSync(artifact.path, join(retained.consumer, relative));
    if (applicationHash(readFileSync(join(retained.consumer, relative))) !== artifact.sha256)
      throw new Error("Upgrade artifact copy changed");
    manifest.dependencies[artifact.packageName] = `file:./${relative}`;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const env = acceptedBuildEnvironment(workspace);
  const commands: object[] = [];
  for (const [label, command] of [
    ["upgrade", [process.execPath, "install", "--ignore-scripts"]],
    ["frozen-upgrade", [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]],
    ["typecheck", [process.execPath, "run", "typecheck"]],
  ] as const) {
    const before = applicationHash(readFileSync(lockPath));
    const result = await runAcceptedBuildCommand({ command, cwd: retained.consumer, env });
    const { stdout, stderr, ...record } = result;
    commands.push({ label, ...record });
    writeFileSync(join(evidence, `${label}.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    if (result.status !== "passed")
      throw new Error(`Application retained upgrade failed: ${label}`);
    if (label !== "upgrade" && before !== applicationHash(readFileSync(lockPath)))
      throw new Error("Verification changed upgraded lock");
  }
  const actualManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedManifest = {
    ...manifestBefore,
    dependencies: {
      ...manifestBefore.dependencies,
      auggy: manifest.dependencies.auggy,
      "@auggy/anthropic": manifest.dependencies["@auggy/anthropic"],
    },
  };
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest))
    throw new Error("Upgrade changed non-runtime manifest fields");
  const moduleAfter = lstatSync(modules);
  if (
    moduleAfter.dev !== moduleStat.dev ||
    moduleAfter.ino !== moduleStat.ino ||
    readFileSync(markerPath, "utf8") !== marker
  )
    throw new Error("Upgrade replaced the retained node_modules directory");
  const installedAfter = assertInstalledApplicationArtifact(
    retained.consumer,
    repoRoot,
    fresh.core,
    "auggy/application",
  );
  const observedAfter = Object.fromEntries(
    changedMembers.map((file) => [
      file,
      applicationHash(readFileSync(join(installedAfter.packageRoot, file))),
    ]),
  );
  for (const file of changedMembers)
    if (
      observedBefore[file] !== retained.core.fileHashes[file] ||
      observedAfter[file] !== fresh.core.fileHashes[file] ||
      observedBefore[file] === observedAfter[file]
    )
      throw new Error("Installed upgrade member transition was not observed");
  const audit = runDependencyAudit({
    cwd: retained.consumer,
    evidencePath: join(evidence, "retained-upgrade-audit.json"),
  });
  if (audit.status !== "passed") throw new Error("Retained application audit failed");
  if (
    JSON.stringify(snapshotApplicationFiles(retained.consumer, ownedPaths)) !==
    JSON.stringify(ownedBefore)
  )
    throw new Error("Upgrade changed application-owned sources");
  await runInstalledApplication({
    ...context("retained-after"),
    ...retained,
    core: fresh.core,
    provider: fresh.provider,
    global,
  });
  if (
    JSON.stringify(snapshotApplicationFiles(retained.consumer, ownedPaths)) !==
    JSON.stringify(ownedBefore)
  )
    throw new Error("Upgraded execution changed application-owned sources");
  unlinkSync(markerPath);
  return {
    nodeModulesRetained: true,
    manifestPreservedExceptRuntimeDependencies: true,
    artifactMemberTransition: { before: observedBefore, after: observedAfter },
    agentId: config.id,
    status: "passed",
    before: { core: retained.core.sha256, lockSHA256: applicationHash(lockBefore) },
    after: { core: fresh.core.sha256, lockSHA256: applicationHash(readFileSync(lockPath)) },
    ownedSources: ownedBefore,
    commands,
  };
}

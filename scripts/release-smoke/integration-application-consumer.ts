/** Isolated optional app preparation. Building and browser acceptance belong to the runner. */
import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { runDependencyAudit } from "../audit-dependencies";
import {
  APPLICATION_BOUNDS,
  applicationHash,
  assertInstalledApplicationArtifact,
  inspectApplicationArtifact,
  type PackedArtifactInput,
} from "./application-consumer";
import { prepareAuthoringWorkspace, runAuthoringBuild } from "./authoring-consumer";
import { readBoundedRegularFile } from "./bounded-file";
import { readIntegrationFile } from "./integration-consumer";
import type { IntegrationScenarioEvidence } from "./integration-contracts";
import {
  COMPANY_APP_ADAPTER_PATH,
  COMPANY_APP_FIXTURE_ADAPTER_PATH,
  COMPANY_APP_FIXTURE_MARKER,
  COMPANY_APP_SOURCE_FILES,
  type CompanyAppBuildKind,
  type PreparedCompanyApp,
} from "./integration-fixtures/application/contracts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const checkoutOverrides = {
  "@auggy/anthropic": "file:../../packages/anthropic",
  "@auggy/ollama": "file:../../packages/ollama",
  "@auggy/openai": "file:../../packages/openai",
  "@auggy/openrouter": "file:../../packages/openrouter",
} as const;

/** Exact copy inventory, explicit archive substitution, real regenerated/frozen lock and audit. */
export async function prepareIntegrationApplication(options: {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  name: string;
  buildKind: CompanyAppBuildKind;
  core: PackedArtifactInput;
}): Promise<PreparedCompanyApp> {
  check(/^[a-z][a-z0-9-]{0,50}$/.test(options.name), "Invalid app consumer name");
  check(
    options.buildKind === "production-reference" || options.buildKind === "fixture-auth",
    "Unknown app build kind",
  );
  const repo = realpathSync(options.repoRoot);
  const workspace = realpathSync(options.workspace);
  const relation = relative(repo, workspace);
  const reverse = relative(workspace, repo);
  const outside = (path: string) =>
    path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  check(outside(relation) && outside(reverse), "App workspace must be isolated outside checkout");
  const owner = lstatSync(workspace);
  check(
    owner.isDirectory() && (owner.mode & 0o077) === 0 && owner.uid === process.getuid?.(),
    "App workspace must be private and owned",
  );
  const directory = join(workspace, options.name);
  check(!lstatSync(directory, { throwIfNoEntry: false }), "App consumer already exists");
  const reference = join(repo, "examples/company-app");
  const source = new Map<string, Buffer>(
    COMPANY_APP_SOURCE_FILES.map((path) => [
      path,
      readIntegrationFile(
        reference,
        path,
        path === "bun.lock" ? 16 * 1024 * 1024 : 2 * 1024 * 1024,
      ),
    ]),
  );
  check(
    [...source.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= 32 * 1024 * 1024,
    "Application source exceeded aggregate bound",
  );
  const core = inspectApplicationArtifact({
    ...options.core,
    sourceFiles: [
      ...new Set([
        ...options.core.sourceFiles,
        "src/auth/index.ts",
        "src/auth/external-auth.ts",
        "src/types.ts",
      ]),
    ],
  });
  check(core.packageName === "auggy", "App dependency must be the selected Auggy artifact");
  const archive = readBoundedRegularFile(options.core.path, APPLICATION_BOUNDS.artifactBytes).bytes;
  check(applicationHash(archive) === core.sha256, "App dependency archive changed");
  const manifest = JSON.parse(source.get("package.json")!.toString("utf8")) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
    workspaces?: unknown;
  };
  check(
    manifest.workspaces === undefined && manifest.dependencies?.auggy === "workspace:../..",
    "App reference dependency contract changed",
  );
  check(
    JSON.stringify(Object.entries(manifest.overrides ?? {}).sort()) ===
      JSON.stringify(Object.entries(checkoutOverrides).sort()),
    "Unexpected app checkout overrides",
  );
  delete manifest.overrides;
  for (const group of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ])
    for (const [name, specifier] of Object.entries(group ?? {})) {
      if (name === "auggy" && group === manifest.dependencies) continue;
      check(
        typeof specifier === "string" && !/^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(specifier),
        "App dependency escapes its isolated install",
      );
      check(name !== "auggy", "Auggy dependency is declared twice");
    }
  const archivePath = `.integration-artifacts/${core.sha256}.tgz`;
  manifest.dependencies.auggy = `file:./${archivePath}`;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const adapter =
    options.buildKind === "fixture-auth"
      ? readIntegrationFile(reference, COMPANY_APP_FIXTURE_ADAPTER_PATH, 2 * 1024 * 1024)
      : source.get(COMPANY_APP_ADAPTER_PATH)!;
  check(
    adapter.includes(COMPANY_APP_FIXTURE_MARKER) === (options.buildKind === "fixture-auth"),
    "App adapter does not match its explicit build kind",
  );
  const baselineFiles = [...source].map(([path, bytes]) => ({
    path,
    sha256: applicationHash(bytes),
  }));
  const changes: IntegrationScenarioEvidence["changes"][number][] = [
    {
      path: archivePath,
      kind: "dependency-materialization",
      beforeSHA256: null,
      afterSHA256: core.sha256,
    },
    {
      path: "package.json",
      kind: "dependency-materialization",
      beforeSHA256: applicationHash(source.get("package.json")!),
      afterSHA256: applicationHash(manifestBytes),
    },
  ];
  if (options.buildKind === "fixture-auth")
    changes.push({
      path: COMPANY_APP_ADAPTER_PATH,
      kind: "fixture-overlay",
      beforeSHA256: applicationHash(source.get(COMPANY_APP_ADAPTER_PATH)!),
      afterSHA256: applicationHash(adapter),
    });
  prepareAuthoringWorkspace(workspace);
  mkdirSync(directory, { mode: 0o700 });
  for (const [path, bytes] of source) {
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, path),
      path === "package.json" ? manifestBytes : path === COMPANY_APP_ADAPTER_PATH ? adapter : bytes,
      { flag: "wx", mode: 0o600 },
    );
  }
  mkdirSync(join(directory, ".integration-artifacts"), { mode: 0o700 });
  writeFileSync(join(directory, archivePath), archive, { flag: "wx", mode: 0o600 });
  const run = (frozen: boolean) =>
    runAuthoringBuild({
      workspace,
      consumer: directory,
      evidenceDirectory: options.evidenceDirectory,
      label: `${options.name}-${frozen ? "frozen-install" : "install"}`,
      command: [
        process.execPath,
        "install",
        ...(frozen ? ["--frozen-lockfile"] : []),
        "--ignore-scripts",
      ],
    });
  // The checkout lock embeds the linked root workspace's dev workspaces. It is
  // inapplicable to this explicitly materialized archive consumer. Preserve its
  // baseline hash above, then let Bun generate the isolated lock from scratch.
  unlinkSync(join(directory, "bun.lock"));
  await run(false);
  const lockSHA256 = applicationHash(readIntegrationFile(directory, "bun.lock", 16 * 1024 * 1024));
  await run(true);
  check(
    applicationHash(readIntegrationFile(directory, "bun.lock", 16 * 1024 * 1024)) === lockSHA256,
    "Frozen app lock changed",
  );
  for (const [path, original] of source) {
    if (path === "bun.lock") continue;
    const expected =
      path === "package.json"
        ? manifestBytes
        : path === COMPANY_APP_ADAPTER_PATH
          ? adapter
          : original;
    check(
      readIntegrationFile(directory, path, 2 * 1024 * 1024).equals(expected),
      "App installation changed owned source",
    );
  }
  changes.push({
    path: "bun.lock",
    kind: "dependency-materialization",
    beforeSHA256: applicationHash(source.get("bun.lock")!),
    afterSHA256: lockSHA256,
  });
  const installed = assertInstalledApplicationArtifact(directory, repo, core, "auggy/auth");
  const audit = runDependencyAudit({
    cwd: directory,
    evidencePath: join(options.evidenceDirectory, `${options.name}-dependency-audit.json`),
  });
  check(audit.status === "passed", "Isolated app dependency audit did not pass");
  return {
    directory,
    baselineFiles,
    changes,
    installedFiles: Object.entries(installed.fileHashes).map(([path, sha256]) => ({
      path: `node_modules/auggy/${path}`,
      sha256,
    })),
    lockfile: { path: "bun.lock", sha256: lockSHA256 },
  };
}

/** M5 local/container certification. Hosted execution has a separate explicit approval gate. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applicationArtifact } from "./application-artifacts";
import {
  APPLICATION_BOUNDS,
  applicationHash,
  inspectApplicationArtifact,
  type PackedArtifactInput,
} from "./application-consumer";
import { installAuthoringCli } from "./authoring-consumer";
import type { AuthoringArtifactSet } from "./authoring-contract";
import { prepareIntegrationApplication } from "./integration-application-consumer";
import { runApplicationIntegration } from "./integration-application";
import { readIntegrationFile } from "./integration-consumer";
import { runContainerIntegration } from "./integration-container-suite";
import type {
  IntegrationScenarioEvidence,
  IntegrationSourceIdentity,
} from "./integration-contracts";
import { parseIntegrationEvidence } from "./integration-evidence";
import { runTelegramIntegration } from "./integration-telegram";
import { verifyIntegrationArtifactSource } from "./integration-artifact-source";

const PROVIDERS = ["anthropic", "openai", "openrouter", "ollama"] as const;
const REQUIRED_CORE_FILES = [
  "src/auth/index.ts",
  "src/auth/external-auth.ts",
  "src/auth/external-auth-replay-contracts.ts",
  "src/auth/external-auth-replay-store.ts",
  "src/auth/external-auth-replay-guard.ts",
  "src/auth/external-auth-replay-path.ts",
  "src/runtime-data-admission.ts",
  "src/runtime-data-contracts.ts",
  "src/http.ts",
  "src/telegram-client.ts",
  "src/augments/telegramTransport/index.ts",
  "src/augments/telegramTransport/polling.ts",
  "src/augments/telegramTransport/replay-store.ts",
  "src/augments/telegramTransport/replay-identity.ts",
  "src/lib/sqlite.ts",
  "src/cli/commands/export.ts",
  "src/cli/commands/deploy.ts",
  "src/cli/export-bootstrap.ts",
  "src/cli/deploy/portable-export.ts",
  "src/cli/deploy/portable-dependencies.ts",
  "src/cli/deploy/manifest.ts",
  "src/cli/deploy/profile.ts",
  "src/cli/deploy/cloud-record.ts",
  "src/cli/deploy/railway-cli.ts",
  "src/cli/deploy/health.ts",
  "src/cli/commands/state.ts",
  "src/cli/runtime-volume.ts",
  "src/cli/runtime-state-bundle.ts",
  "src/cli/runtime-state-inventory.ts",
] as const;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export interface IntegrationSuiteOptions {
  repoRoot: string;
  evidenceDirectory: string;
  core: string;
  anthropic: string;
  openai: string;
  openrouter: string;
  ollama: string;
  stage: "local" | "container" | "all";
  chromiumPath?: string;
  chromiumSHA256?: string;
}

export function parseIntegrationSuiteArguments(args: readonly string[]): IntegrationSuiteOptions {
  const keys = {
    "--repo-root": "repoRoot",
    "--evidence-dir": "evidenceDirectory",
    "--core": "core",
    "--anthropic": "anthropic",
    "--openai": "openai",
    "--openrouter": "openrouter",
    "--ollama": "ollama",
    "--stage": "stage",
    "--chromium-path": "chromiumPath",
    "--chromium-sha256": "chromiumSHA256",
  } as const;
  check(
    args.length <= 20 && args.length % 2 === 0,
    "Expected bounded explicit integration arguments",
  );
  const output: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index] as keyof typeof keys];
    const value = args[index + 1]!;
    check(
      key &&
        output[key] === undefined &&
        value &&
        !value.startsWith("--") &&
        value.length <= 4096 &&
        !/\p{Cc}/u.test(value),
      "Invalid or duplicate integration argument",
    );
    output[key] = key === "stage" || key === "chromiumSHA256" ? value : resolve(value);
  }
  for (const key of ["repoRoot", "evidenceDirectory", "core", ...PROVIDERS])
    check(output[key], `Missing integration argument: ${key}`);
  output.stage ??= "all";
  check(["local", "container", "all"].includes(output.stage), "Invalid integration stage");
  check(
    (output.chromiumPath === undefined) === (output.chromiumSHA256 === undefined),
    "Chromium needs both path and hash",
  );
  if (output.chromiumSHA256)
    check(/^[a-f0-9]{64}$/.test(output.chromiumSHA256), "Invalid Chromium hash");
  if (output.stage !== "container")
    check(output.chromiumPath, "Local browser certification requires pinned Chromium");
  return output as unknown as IntegrationSuiteOptions;
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  check(
    !result.error && result.status === 0 && !result.signal,
    "Cannot verify integration source identity",
  );
  return result.stdout;
}

function sourceIdentity(repo: string) {
  check(
    git(repo, ["status", "--porcelain", "--untracked-files=normal"]).trim() === "",
    "Certification requires a clean committed source tree",
  );
  const revision = git(repo, ["rev-parse", "HEAD"]).trim();
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
  check(
    /^[a-f0-9]{40}$/.test(revision) && /^[a-f0-9]{40}$/.test(tree),
    "Invalid committed source identity",
  );
  const paths = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  check(paths.length > 0 && paths.length <= 10000, "Source inventory exceeded bound");
  let total = 0;
  const inventory = paths.map((path) => {
    check(
      // This tracked security-eval canary is deliberate adversarial input, not
      // deployment credentials. Inventory records its hash only; core packaging
      // excludes packages/evals entirely.
      path === "packages/evals/src/security/fixtures/private/.env.fixture" ||
        !path
          .split("/")
          .some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example")),
      "Source inventory contains a private environment file",
    );
    const bytes = readIntegrationFile(repo, path, APPLICATION_BOUNDS.artifactBytes);
    total += bytes.length;
    check(total <= 512 * 1024 * 1024, "Source inventory exceeded aggregate byte bound");
    return { path, sha256: applicationHash(bytes) };
  });
  return {
    revision,
    tree,
    sourceChangesSHA256: applicationHash(JSON.stringify(inventory)),
    inventory,
  };
}

async function selectArtifact(
  repo: string,
  path: string,
  packageName: string,
  sourceFiles: ReturnType<typeof sourceIdentity>["inventory"],
) {
  const provenance = verifyIntegrationArtifactSource({
    repoRoot: repo,
    archive: path,
    packageName,
    sourceFiles,
  });
  const input = await applicationArtifact(path, packageName);
  check(
    input.sha256 === provenance.archiveSHA256,
    "Archive changed after full source verification",
  );
  if (packageName === "auggy")
    input.sourceFiles = [...new Set([...input.sourceFiles, ...REQUIRED_CORE_FILES])];
  const inspected = inspectApplicationArtifact(input);
  const base =
    packageName === "auggy" ? repo : join(repo, "packages", packageName.slice("@auggy/".length));
  for (const [file, expected] of Object.entries(inspected.fileHashes)) {
    const owner = file === "LICENSE" && !existsSync(join(base, file)) ? repo : base;
    check(
      applicationHash(readIntegrationFile(owner, file, APPLICATION_BOUNDS.artifactBytes)) ===
        expected,
      "Selected archive does not match committed source files",
    );
  }
  return { input, provenance };
}

export function assertIntegrationStages(
  stage: IntegrationSuiteOptions["stage"],
  records: readonly IntegrationScenarioEvidence[],
): void {
  const required = [
    ...(stage !== "container"
      ? [
          "telegram-installed-worker",
          "standalone-http-policy",
          "application-production-reference",
          "application-browser-integration",
        ]
      : []),
    ...(stage !== "local" ? ["container-storage-recovery"] : []),
  ];
  check(
    records.length === required.length &&
      new Set(records.map((record) => record.scenarioId)).size === records.length,
    "Integration evidence inventory is incomplete or duplicated",
  );
  for (const id of required) {
    const row = records.find((record) => record.scenarioId === id);
    check(
      row?.outcome.status === "passed" && row.cleanup.status === "complete",
      `Integration stage did not pass with cleanup: ${id}`,
    );
    const expected = {
      "telegram-installed-worker": ["local", "standalone-fixture", "none", "verified", 2],
      "standalone-http-policy": ["local", "standalone-fixture", "http", "verified", 1],
      "application-production-reference": [
        "local",
        "production-reference",
        "http",
        "unverified",
        0,
      ],
      "application-browser-integration": ["local", "fixture-auth", "http", "verified", 1],
      "container-storage-recovery": ["container", "standalone-fixture", "http", "unverified", 4],
    } as const;
    const [expectedStage, build, profile, channel, effects] = expected[id as keyof typeof expected];
    check(
      row.stage === expectedStage &&
        row.buildKind === build &&
        row.profile.kind === profile &&
        row.execution.startup === "ready" &&
        row.execution.channel === channel &&
        row.execution.effectCount === effects &&
        row.execution.duplicateEffectCount === 0 &&
        row.execution.unauthorizedEffectCount === 0 &&
        row.cleanup.remainingOwnedIds.length === 0,
      `Integration row metadata or observations do not match its scenario: ${id}`,
    );
    if (expectedStage === "container") {
      check(
        row.platform.imageDigest !== null &&
          /^sha256:[a-f0-9]{64}$/.test(row.platform.imageDigest) &&
          row.platform.exportSHA256 !== null &&
          /^[a-f0-9]{64}$/.test(row.platform.exportSHA256) &&
          row.platform.deploymentId === null &&
          row.platform.resources.some(
            (resource) => resource.kind === "image" && resource.id === row.platform.imageDigest,
          ),
        "Container row is missing its tested image or export identity",
      );
    } else
      check(
        row.platform.imageDigest === null &&
          (id === "telegram-installed-worker"
            ? row.platform.exportSHA256 !== null && /^[a-f0-9]{64}$/.test(row.platform.exportSHA256)
            : row.platform.exportSHA256 === null) &&
          row.platform.deploymentId === null &&
          row.platform.resources.length === 0,
        "Local row contains mismatched platform identity",
      );
  }
}

/** No source checkout aliases, live credentials, hosted fallback or unavailable-as-passed rows. */
export async function runIntegrationSuite(options: IntegrationSuiteOptions) {
  const repo = realpathSync(options.repoRoot);
  const identity = sourceIdentity(repo);
  const evidenceDirectory = join(
    realpathSync(dirname(options.evidenceDirectory)),
    basename(options.evidenceDirectory),
  );
  const rel = relative(repo, evidenceDirectory);
  check(
    rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    "Evidence must be outside the source checkout",
  );
  check(!existsSync(evidenceDirectory), "Integration evidence destination must be new");
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-integration-suite-"));
  const runId = randomUUID();
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Integration suite interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const records: IntegrationScenarioEvidence[] = [];
  let passed = false;
  try {
    const coreSelection = await selectArtifact(repo, options.core, "auggy", identity.inventory);
    const core = coreSelection.input;
    const providerSelections = await Promise.all(
      PROVIDERS.map(
        async (name) =>
          [
            name,
            await selectArtifact(repo, options[name], `@auggy/${name}`, identity.inventory),
          ] as const,
      ),
    );
    const providers = Object.fromEntries(
      providerSelections.map(([name, selected]) => [name, selected.input]),
    ) as AuthoringArtifactSet["providers"];
    const artifacts = { core, providers };
    const source: IntegrationSourceIdentity = {
      revision: identity.revision,
      tree: identity.tree,
      sourceChangesSHA256: identity.sourceChangesSHA256,
      bunVersion: Bun.version,
      lockfiles: [
        {
          path: "bun.lock",
          sha256: applicationHash(readIntegrationFile(repo, "bun.lock", 16 * 1024 * 1024)),
        },
      ],
      packedPackages: [core, ...Object.values(providers)].map((artifact) => ({
        path: `artifacts/${basename(artifact.path)}`,
        sha256: artifact.sha256,
      })),
      installedFiles: [],
    };
    mkdirSync(join(evidenceDirectory, "artifacts"), { mode: 0o700 });
    for (const artifact of [core, ...Object.values(providers)] as PackedArtifactInput[]) {
      const bytes = readIntegrationFile(
        dirname(artifact.path),
        basename(artifact.path),
        APPLICATION_BOUNDS.artifactBytes,
      );
      check(
        applicationHash(bytes) === artifact.sha256,
        "Artifact changed before evidence preservation",
      );
      writeFileSync(join(evidenceDirectory, "artifacts", basename(artifact.path)), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    writeFileSync(
      join(evidenceDirectory, "source-inventory.json"),
      `${JSON.stringify(identity, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      join(evidenceDirectory, "packed-source-inventory.json"),
      `${JSON.stringify(
        [
          coreSelection.provenance,
          ...providerSelections.map(([, selected]) => selected.provenance),
        ],
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const cli = await installAuthoringCli({
      repoRoot: repo,
      workspace,
      name: "integration-cli",
      evidenceDirectory: join(evidenceDirectory, "cli"),
      core,
    });
    const optionsFor = (name: string) => ({
      create: {
        repoRoot: repo,
        workspace,
        evidenceDirectory: join(evidenceDirectory, name, "create"),
        cli,
        artifacts,
        provider: "anthropic" as const,
        model: "integration-fixture-model",
        name,
      },
      source,
      runId,
      home: join(workspace, "home"),
      temporaryDirectory: join(workspace, "tmp"),
      evidenceDirectory: join(evidenceDirectory, name),
      signal: controller.signal,
    });
    const collect = (record: IntegrationScenarioEvidence) => {
      const parsed = parseIntegrationEvidence(JSON.stringify(record));
      check(
        parsed.runId === runId &&
          parsed.source.revision === source.revision &&
          parsed.source.tree === source.tree &&
          parsed.source.sourceChangesSHA256 === source.sourceChangesSHA256 &&
          JSON.stringify(parsed.source.packedPackages) === JSON.stringify(source.packedPackages),
        "Scenario evidence changed its source or artifact identity",
      );
      records.push(parsed);
    };
    if (options.stage !== "container") {
      collect((await runTelegramIntegration(optionsFor("telegram-integration"))).evidence);
      const app = await runApplicationIntegration({
        ...optionsFor("http-integration"),
        chromium: { path: options.chromiumPath!, sha256: options.chromiumSHA256! },
        prepareApp: (buildKind) =>
          prepareIntegrationApplication({
            repoRoot: repo,
            workspace,
            evidenceDirectory: join(evidenceDirectory, "app-preparation"),
            name: buildKind,
            buildKind,
            core,
          }),
      });
      app.evidence.forEach(collect);
    }
    if (options.stage !== "local")
      collect((await runContainerIntegration(optionsFor("container-integration"))).evidence);
    assertIntegrationStages(options.stage, records);
    const finalSource = sourceIdentity(repo);
    check(
      finalSource.revision === identity.revision &&
        finalSource.sourceChangesSHA256 === identity.sourceChangesSHA256,
      "Source changed during integration certification",
    );
    passed = true;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const cleanupConfirmed =
      passed && records.every((record) => record.cleanup.status === "complete");
    if (cleanupConfirmed) rmSync(workspace, { recursive: true, force: true });
    writeFileSync(
      join(evidenceDirectory, "integration-suite.json"),
      `${JSON.stringify(
        {
          version: 1,
          runId,
          revision: identity.revision,
          tree: identity.tree,
          requestedStage: options.stage,
          status: passed ? "passed" : "failed",
          scenarios: records.map((record) => ({
            scenarioId: record.scenarioId,
            outcome: record.outcome.status,
            cleanup: record.cleanup.status,
          })),
          workspaceCleanup: cleanupConfirmed ? "complete" : "retained-for-inspection",
          hosted: "not-run-separate-approval-required",
          milestoneComplete: false,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  return { status: "passed" as const, evidenceDirectory, records };
}

if (import.meta.main) {
  try {
    const result = await runIntegrationSuite(parseIntegrationSuiteArguments(process.argv.slice(2)));
    console.log(`Requested local/container integration stages passed: ${result.evidenceDirectory}`);
    console.log("Hosted Railway acceptance remains a separate approval and execution gate.");
  } catch {
    console.error("Integration certification failed; inspect its private evidence directory.");
    process.exitCode = 1;
  }
}

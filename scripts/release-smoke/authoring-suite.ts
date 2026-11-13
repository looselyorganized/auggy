import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applicationArtifact,
  buildApplicationBaseline,
  buildDifferentVersionArtifact,
} from "./application-artifacts";
import { createAuthoringConsumer, installAuthoringCli } from "./authoring-consumer";
import { generatedApplicationRecipe, runGeneratedApplication } from "./authoring-application";
import { runGeneratedAuthoringInspection } from "./authoring-inspection";
import { runGeneratedApplicationLaunchd } from "./authoring-launchd";
import { runInstalledAuthoringMigration } from "./authoring-migration";
import { runGeneratedOwnershipUpdate } from "./authoring-ownership";
import { verifyGeneratedDeployment } from "./authoring-deployment";
import type {
  AuthoringArtifactSet,
  AuthoringProvider,
  GeneratedAuthoringConsumer,
} from "./authoring-contract";

export interface AuthoringSuiteOptions {
  repoRoot: string;
  evidenceDirectory: string;
  core: string;
  anthropic: string;
  openai: string;
  openrouter: string;
  ollama: string;
  globalCore?: string;
}

export function parseAuthoringSuiteArguments(args: readonly string[]): AuthoringSuiteOptions {
  const keys = {
    "--repo-root": "repoRoot",
    "--evidence-dir": "evidenceDirectory",
    "--core": "core",
    "--anthropic": "anthropic",
    "--openai": "openai",
    "--openrouter": "openrouter",
    "--ollama": "ollama",
    "--global-core": "globalCore",
  } as const;
  const result: Record<string, string> = {};
  if (args.length > 16 || args.length % 2)
    throw new Error("Expected bounded explicit authoring artifact arguments");
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index] as keyof typeof keys];
    const value = args[index + 1]!;
    if (
      !key ||
      result[key] !== undefined ||
      !value ||
      value.startsWith("--") ||
      value.length > 4096 ||
      value.includes("\0")
    )
      throw new Error("Invalid or duplicate authoring suite argument");
    result[key] = resolve(value);
  }
  for (const key of Object.values(keys).filter((key) => key !== "globalCore"))
    if (!result[key]) throw new Error(`Missing authoring suite argument: ${key}`);
  return result as unknown as AuthoringSuiteOptions;
}

/** Platform unavailability is explicit; a missing or failed implemented stage never passes. */
export function assertAuthoringSuiteStages(stages: Readonly<Record<string, unknown>>): void {
  for (const key of [
    "anthropic-adoption",
    "openai-adoption",
    "openrouter-adoption",
    "ollama-adoption",
    "application",
    "inspection",
  ])
    if (stages[key] !== "passed") throw new Error(`Authoring suite stage incomplete: ${key}`);
  for (const key of ["migration", "ownership", "deployment", "service"]) {
    const stage = stages[key] as
      | { state?: unknown; status?: unknown; cleanupConfirmed?: unknown }
      | undefined;
    const status = key === "migration" ? stage?.status : stage?.state;
    if (
      stage?.cleanupConfirmed !== true ||
      (status !== "passed" && !(key === "service" && status === "unavailable"))
    )
      throw new Error(`Authoring suite stage incomplete or cleanup unconfirmed: ${key}`);
  }
}

/** Every generated consumer originates from the installed candidate CLI, never a copied reference. */
export async function runAuthoringSuite(options: AuthoringSuiteOptions) {
  const repoRoot = resolve(options.repoRoot),
    evidenceDirectory = resolve(options.evidenceDirectory);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "auggy-authoring-suite-"));
  const stages: Record<string, unknown> = {};
  let status = "failed";
  try {
    const core = await applicationArtifact(options.core, "auggy");
    const providers = Object.fromEntries(
      await Promise.all(
        (["anthropic", "openai", "openrouter", "ollama"] as const).map(async (provider) => [
          provider,
          await applicationArtifact(options[provider], `@auggy/${provider}`),
        ]),
      ),
    ) as AuthoringArtifactSet["providers"];
    const artifacts = { core, providers };
    const cli = await installAuthoringCli({
      repoRoot,
      workspace,
      name: "candidate-cli",
      evidenceDirectory: join(evidenceDirectory, "candidate-cli"),
      core,
    });
    const baseline = options.globalCore
      ? await applicationArtifact(options.globalCore, "auggy")
      : (await buildApplicationBaseline(repoRoot, join(evidenceDirectory, "global-baseline"))).core;
    const global = await installAuthoringCli({
      repoRoot,
      workspace,
      name: "global-cli",
      evidenceDirectory: join(evidenceDirectory, "global-cli"),
      core: baseline,
    });
    const consumers = {} as Record<AuthoringProvider, GeneratedAuthoringConsumer>;
    for (const provider of ["anthropic", "openai", "openrouter", "ollama"] as const) {
      consumers[provider] = await createAuthoringConsumer({
        repoRoot,
        workspace,
        evidenceDirectory: join(evidenceDirectory, "consumers", provider),
        cli,
        artifacts,
        provider,
        model: "authoring-fixture-model",
        name: `generated-${provider}`,
      });
      stages[`${provider}-adoption`] = "passed";
    }
    stages.migration = await runInstalledAuthoringMigration({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "migration"),
      sourceConsumer: consumers.anthropic,
      cli,
    });
    await runGeneratedApplication({
      repoRoot,
      consumer: consumers.anthropic,
      global,
      home: join(workspace, "home"),
      temporaryDirectory: join(workspace, "tmp"),
      evidenceDirectory: join(evidenceDirectory, "application"),
      recipe: generatedApplicationRecipe(consumers.anthropic.sourceFiles),
    });
    stages.application = "passed";
    const inspectorArtifact = await buildDifferentVersionArtifact(
      core,
      join(evidenceDirectory, "inspection-version-fixture"),
    );
    const inspector = await installAuthoringCli({
      repoRoot,
      workspace,
      name: "inspection-cli",
      evidenceDirectory: join(evidenceDirectory, "inspection-cli"),
      core: inspectorArtifact,
    });
    await runGeneratedAuthoringInspection({
      repoRoot,
      workspace,
      consumer: consumers.anthropic,
      global: inspector,
      evidenceDirectory: join(evidenceDirectory, "inspection"),
    });
    stages.inspection = "passed";
    const serviceConsumer = await createAuthoringConsumer({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "consumers", "service"),
      cli,
      artifacts,
      provider: "anthropic",
      model: "authoring-fixture-model",
      name: "generated-service",
    });
    mkdirSync(join(workspace, "service-home"), { mode: 0o700 });
    mkdirSync(join(workspace, "service-tmp"), { mode: 0o700 });
    stages.service = await runGeneratedApplicationLaunchd({
      repoRoot,
      consumer: serviceConsumer,
      home: join(workspace, "service-home"),
      temporaryDirectory: join(workspace, "service-tmp"),
      evidenceDirectory: join(evidenceDirectory, "service"),
    });
    const ownershipConsumer = await createAuthoringConsumer({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "consumers", "ownership"),
      cli,
      artifacts,
      provider: "anthropic",
      model: "authoring-fixture-model",
      name: "generated-ownership",
    });
    stages.ownership = await runGeneratedOwnershipUpdate({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "ownership"),
      consumer: ownershipConsumer,
      candidateCore: core,
      baselineCore: baseline,
      provider: providers.anthropic,
    });
    const deploymentConsumer = await createAuthoringConsumer({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "consumers", "deployment"),
      cli,
      artifacts,
      provider: "anthropic",
      model: "authoring-fixture-model",
      name: "generated-deployment",
    });
    stages.deployment = await verifyGeneratedDeployment({
      repoRoot,
      workspace,
      evidenceDirectory: join(evidenceDirectory, "deployment"),
      consumer: deploymentConsumer,
    });
    // A successful portable suite does not turn unavailable macOS evidence into a pass.
    assertAuthoringSuiteStages(stages);
    status = "passed";
    return { status, stages, workspace };
  } finally {
    writeFileSync(
      join(evidenceDirectory, "authoring-suite.json"),
      `${JSON.stringify({ schemaVersion: 1, status, scope: "installed generated-project authoring; producer/CI/AgentMail/documentation gates are separate", stages, workspace, macosEvidence: (stages.service as { state?: string } | undefined)?.state ?? "not-run" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (status === "passed") rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const options = parseAuthoringSuiteArguments(process.argv.slice(2));
    const result = await runAuthoringSuite(options);
    console.log(
      JSON.stringify({
        status: result.status,
        evidence: join(options.evidenceDirectory, "authoring-suite.json"),
        macosEvidence:
          (result.stages.service as { state?: string } | undefined)?.state ?? "not-run",
      }),
    );
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDependencyAudit } from "../audit-dependencies";
import { acceptedBuildEnvironment, runAcceptedBuildCommand } from "./accepted-main-artifacts";
import {
  applicationHash,
  inspectApplicationArtifact,
  prepareApplicationConsumer,
  type PackedArtifactInput,
} from "./application-consumer";
import { INSPECTABLE_APPLICATION_RECIPE } from "./application-recipe";

export interface ApplicationInstallOptions {
  repoRoot: string;
  workspace: string;
  name: string;
  evidenceDirectory: string;
  core: PackedArtifactInput;
  provider: PackedArtifactInput;
  legacy?: boolean;
}

export async function installApplicationConsumer(options: ApplicationInstallOptions) {
  if (!/^[a-z][a-z0-9-]{0,50}$/.test(options.name)) throw new Error("Invalid consumer name");
  const consumer = join(options.workspace, options.name);
  const evidence = join(options.evidenceDirectory, options.name);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const core = inspectApplicationArtifact(options.core);
  const provider = inspectApplicationArtifact(options.provider);
  if (options.legacy) {
    mkdirSync(consumer, { mode: 0o700 });
    mkdirSync(join(consumer, ".application-artifacts"), { mode: 0o700 });
    const reference = JSON.parse(
      readFileSync(join(options.repoRoot, "examples/inspectable-agent/package.json"), "utf8"),
    );
    const overrides = { ...reference.overrides } as Record<string, string>;
    for (const name of ["anthropic", "ollama", "openai", "openrouter"]) {
      const key = `@auggy/${name}`;
      if (overrides[key] !== `file:../../packages/${name}`)
        throw new Error("Unexpected checkout override");
      delete overrides[key];
    }
    if (
      Object.values(overrides).some((spec) => /^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(spec))
    )
      throw new Error("Legacy consumer override escapes the installed graph");
    const dependencies: Record<string, string> = {};
    for (const [index, artifact] of [options.core, options.provider].entries()) {
      const relative = `.application-artifacts/${index}-${artifact.sha256}.tgz`;
      copyFileSync(artifact.path, join(consumer, relative));
      if (applicationHash(readFileSync(join(consumer, relative))) !== artifact.sha256)
        throw new Error("Artifact changed during install preparation");
      dependencies[artifact.packageName] = `file:./${relative}`;
    }
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "accepted-legacy-consumer", private: true, type: "module", dependencies, overrides }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } else {
    prepareApplicationConsumer({
      repoRoot: options.repoRoot,
      referenceDir: join(options.repoRoot, "examples/inspectable-agent"),
      destination: consumer,
      recipe: INSPECTABLE_APPLICATION_RECIPE,
      core: options.core,
      provider: options.provider,
    });
  }
  const env = acceptedBuildEnvironment(options.workspace);
  for (const name of ["home", "tmp", "npm-cache"])
    mkdirSync(join(options.workspace, name), { recursive: true, mode: 0o700 });
  const commands: object[] = [];
  const run = async (label: string, argv: string[]) => {
    const result = await runAcceptedBuildCommand({ command: argv, cwd: consumer, env });
    const { stdout, stderr, ...record } = result;
    commands.push({ label, ...record });
    writeFileSync(join(evidence, `${label}.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    if (result.status !== "passed")
      throw new Error(`Application consumer ${options.name}: ${label} failed`);
  };
  let status = "failed";
  try {
    await run("install", [process.execPath, "install", "--ignore-scripts"]);
    const lock = applicationHash(readFileSync(join(consumer, "bun.lock")));
    await run("frozen-install", [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    if (applicationHash(readFileSync(join(consumer, "bun.lock"))) !== lock)
      throw new Error("Frozen install changed lock");
    if (!options.legacy) await run("public-typecheck", [process.execPath, "run", "typecheck"]);
    const audit = runDependencyAudit({
      cwd: consumer,
      evidencePath: join(evidence, "dependency-audit.json"),
    });
    if (audit.status !== "passed")
      throw new Error(`Application consumer ${options.name}: audit failed`);
    status = "passed";
    return { consumer, core, provider, lockSHA256: lock };
  } finally {
    writeFileSync(
      join(evidence, "installation.json"),
      `${JSON.stringify({ status, core, provider, commands }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

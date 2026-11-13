/** Exact-artifact CLI creation and bounded evidence from generated consumers. */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { acceptedBuildEnvironment, runAcceptedBuildCommand } from "./accepted-main-artifacts";
import { runDependencyAudit } from "../audit-dependencies";
import {
  applicationHash,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  assertApplicationCapability,
  inspectApplicationArtifact,
  startApplicationChild,
} from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";
import { parse } from "yaml";
import {
  AUTHORING_BOUNDS,
  AUTHORING_EXECUTION_FILES,
  type AuthoringArtifactSelection,
  type AuthoringArtifactSet,
  type AuthoringPackage,
  type AuthoringProvider,
  type CreateAuthoringConsumerOptions,
  type FileHashes,
  type GeneratedAuthoringConsumer,
  type InstalledAuthoringCli,
} from "./authoring-contract";

const providers: readonly AuthoringProvider[] = ["anthropic", "openai", "openrouter", "ollama"];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(path: string, root: string): boolean {
  const result = relative(root, path);
  return (
    result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  );
}

/** Explicit names prevent an artifact map from silently selecting another provider. */
export function selectAuthoringArtifacts(
  artifacts: AuthoringArtifactSet,
  provider: AuthoringProvider,
): AuthoringArtifactSelection {
  check(providers.includes(provider), "Unknown authoring provider");
  const inputs = [artifacts.core, artifacts.providers[provider]];
  if (provider === "openrouter") inputs.push(artifacts.providers.openai);
  const names: AuthoringPackage[] = ["auggy", `@auggy/${provider}`];
  if (provider === "openrouter") names.push("@auggy/openai");
  const specifiers: Partial<Record<AuthoringPackage, string>> = {};
  const inspected = inputs.map((input, index) => {
    const name = names[index]!;
    check(input?.packageName === name, "Candidate artifact package does not match selection");
    const artifact = inspectApplicationArtifact(input);
    const specifier = `file:${realpathSync(input.path)}`;
    check(
      specifier.length <= AUTHORING_BOUNDS.specifierCharacters && !specifier.includes("\0"),
      "Artifact specifier exceeded its bound",
    );
    specifiers[name] = specifier;
    return artifact;
  });
  assertApplicationCapability(inspected[0]!.manifest);
  const specifiersJSON = JSON.stringify(specifiers);
  check(
    Buffer.byteLength(specifiersJSON) <= AUTHORING_BOUNDS.specifiersBytes,
    "Artifact selection exceeded its bound",
  );
  return {
    core: inspected[0]!,
    provider: inspected[1]!,
    prerequisites: inspected.slice(2),
    specifiers,
    specifiersJSON,
  };
}

function sourceParts(path: string): string[] {
  check(
    path.length > 0 && path.length <= 512 && !isAbsolute(path) && !/[\\\0]/.test(path),
    "Source path must be bounded and project-relative",
  );
  const parts = path.split("/");
  const excluded = new Set([
    ".git",
    ".auggy",
    ".application-artifacts",
    ".npmrc",
    ".netrc",
    ".cache",
    "node_modules",
    "data",
    "workspace",
    "logs",
    "bun.lock",
    "bun.lockb",
  ]);
  check(
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !excluded.has(part) &&
        !(part.startsWith(".env") && part !== ".env.example") &&
        !/\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(part),
    ),
    "Source allowlist contains state, secrets or an unsafe path",
  );
  return parts;
}

/** Caller owns a private fixture directory; final reads are descriptor-bounded. */
export function readAuthoringSource(consumer: string, path: string): Buffer {
  const owner = realpathSync(consumer);
  const parts = sourceParts(path);
  let parent = owner;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "Source parent must be an owned directory");
  }
  check(inside(realpathSync(parent), owner), "Source parent escaped the generated consumer");
  return readBoundedRegularFile(join(parent, parts.at(-1)!), AUTHORING_BOUNDS.sourceBytes).bytes;
}

export function snapshotGeneratedAuthoringSources(options: {
  repoRoot: string;
  consumer: string;
  sourceFiles: readonly string[];
}): FileHashes {
  const repo = realpathSync(options.repoRoot);
  const consumer = realpathSync(options.consumer);
  check(
    !inside(consumer, repo) && !inside(repo, consumer),
    "Generated consumer must be isolated outside the checkout",
  );
  const files = options.sourceFiles;
  check(
    files.length <= AUTHORING_BOUNDS.sourceFiles && new Set(files).size === files.length,
    "Generated source allowlist must be bounded and unique",
  );
  check(
    ["agent.yaml", "package.json", ...AUTHORING_EXECUTION_FILES].every((file) =>
      files.includes(file),
    ),
    "Generated source allowlist lacks configuration, manifest or owned execution",
  );
  let total = 0;
  return Object.fromEntries(
    files.map((file) => {
      const bytes = readAuthoringSource(consumer, file);
      total += bytes.byteLength;
      check(
        total <= AUTHORING_BOUNDS.totalSourceBytes,
        "Generated sources exceeded total byte bound",
      );
      return [file, applicationHash(bytes)];
    }),
  );
}

/** Validate output as written. This function never repairs the generated manifest. */
export function assertAuthoringArtifactManifest(
  bytes: Uint8Array,
  selection: AuthoringArtifactSelection,
): void {
  check(
    bytes.byteLength <= AUTHORING_BOUNDS.manifestBytes,
    "Generated manifest exceeded its bound",
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Generated manifest is not valid JSON");
  }
  check(record(manifest) && record(manifest.dependencies), "Generated dependencies are missing");
  const dependencies = manifest.dependencies;
  for (const [name, specifier] of Object.entries(selection.specifiers)) {
    check(dependencies[name] === specifier, "Generated manifest did not select the exact artifact");
    for (const key of ["devDependencies", "optionalDependencies"]) {
      const group = manifest[key];
      check(!record(group) || !(name in group), "Runtime artifact is declared in multiple groups");
    }
  }
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) {
    const group = manifest[key];
    check(group === undefined || record(group), "Generated package group must be a mapping");
    for (const [name, specifier] of Object.entries(group ?? {})) {
      check(typeof specifier === "string", "Generated dependency must be a string");
      const selected = selection.specifiers[name as AuthoringPackage];
      if (selected !== undefined) {
        check(specifier === selected, "Dependency override conflicts with selected artifact");
      } else {
        check(
          !/^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(specifier),
          "Dependency escaped artifact selection",
        );
        check(
          !providers.some((provider) => name === `@auggy/${provider}`),
          "Generated manifest includes an unrelated provider",
        );
      }
    }
  }
  if (selection.provider.packageName === "@auggy/openrouter") {
    check(
      record(manifest.overrides) &&
        manifest.overrides["@auggy/openai"] === selection.specifiers["@auggy/openai"],
      "OpenRouter prerequisite lacks its exact override",
    );
  }
}

export function authoringCreateArguments(input: {
  name: string;
  provider: AuthoringProvider;
  model: string;
  allowUnpricedModel?: boolean;
}): string[] {
  check(/^[a-z][a-z0-9-]{0,50}$/.test(input.name), "Invalid authoring consumer name");
  check(providers.includes(input.provider), "Unknown authoring provider");
  check(
    input.model.length > 0 &&
      input.model.length <= 256 &&
      !input.model.startsWith("-") &&
      [...input.model].every((character) => character.charCodeAt(0) >= 32),
    "Model must be one bounded explicit argument",
  );
  return [
    "create",
    input.name,
    "--provider",
    input.provider,
    "--model",
    input.model,
    "--yes",
    "--skip-install",
    ...(input.allowUnpricedModel ? ["--allow-unpriced-model"] : []),
  ];
}

/** Low-level supervision only; caller separately verifies this is the packed CLI. */
export async function runBoundedAuthoringCli(options: {
  entry: string;
  args: readonly string[];
  cwd: string;
  workspace: string;
  selection?: AuthoringArtifactSelection;
  secrets?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  check(isAbsolute(options.entry), "CLI entry must be an explicit absolute path");
  check(
    options.args.length <= AUTHORING_BOUNDS.commandArguments &&
      options.args.every(
        (argument) =>
          argument.length <= AUTHORING_BOUNDS.argumentCharacters && !argument.includes("\0"),
      ),
    "CLI arguments exceeded their bound",
  );
  const env = acceptedBuildEnvironment(options.workspace);
  if (options.selection) env.AUGGY_SCAFFOLD_PACKAGE_SPECS = options.selection.specifiersJSON;
  return startApplicationChild({
    command: [process.execPath, options.entry, ...options.args],
    cwd: options.cwd,
    env,
    secrets: options.secrets ?? [],
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  }).finish();
}

export function assertAuthoringCommandSucceeded(
  result: Awaited<ReturnType<typeof runBoundedAuthoringCli>>,
): void {
  check(
    result.exitCode === 0 &&
      result.signal === null &&
      !result.spawnFailed &&
      !result.timedOut &&
      !result.exceededOutput &&
      !result.orphanedGroup &&
      result.cleanupConfirmed,
    "Authoring command did not complete successfully with confirmed cleanup",
  );
}

/** Reviewed public files; private receipts, model snapshots and .env are never exported. */
export const GENERATED_AUTHORING_SOURCE_FILES = [
  "agent.yaml",
  "package.json",
  ".gitignore",
  ".env.example",
  "identity.md",
  "learned-behaviors.md",
  "README.md",
  "tsconfig.json",
  "tests/application.test.ts",
  ...AUTHORING_EXECUTION_FILES,
  "src/augments/README.md",
  "skills/auggy/SKILL.md",
  "skills/filesystem/SKILL.md",
  "skills/filesystem/references/mount-permissions.md",
  "skills/webFetch/SKILL.md",
  "skills/turnControl/SKILL.md",
] as const;

/** Inspect the entire fresh tree before install; private entries expose only path/kind. */
export function inspectGeneratedAuthoringTree(consumer: string) {
  const config: unknown = parse(readAuthoringSource(consumer, "agent.yaml").toString("utf8"));
  check(
    record(config) &&
      record(config.application) &&
      config.application.entrypoint === "./src/index.ts" &&
      config.application.contractVersion === 1,
    "Fresh project lacks the owned application declaration",
  );
  check(
    Array.isArray(config.augments) &&
      config.augments.length > 0 &&
      config.augments.length <= 256 &&
      config.augments.every(
        (entry) =>
          record(entry) &&
          typeof entry.name === "string" &&
          typeof entry.type === "string" &&
          entry.type !== "custom" &&
          !Object.hasOwn(entry, "source"),
      ),
    "Fresh enabled graph must contain central inline built-ins only",
  );
  const inventory: {
    path: string;
    kind: "directory" | "file";
    private: boolean;
    sha256?: string;
  }[] = [];
  const topFiles = new Set<string>([
    ...GENERATED_AUTHORING_SOURCE_FILES.filter((file) => !file.includes("/")),
    ".env",
  ]);
  const directories = new Set(["src", "tests", "skills", "data", ".auggy"]);
  let bytes = 0,
    publicFiles = 0;
  const visit = (path: string, depth: number) => {
    check(depth <= 12 && inventory.length < 256, "Generated tree inventory exceeded bound");
    const stat = lstatSync(join(consumer, path));
    check(
      !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()),
      "Generated tree contains a symlink or nonregular entry",
    );
    const privateEntry =
      path === ".env" ||
      path === "data" ||
      path.startsWith("data/") ||
      path === ".auggy" ||
      path.startsWith(".auggy/");
    if (depth === 0)
      check(
        stat.isDirectory() ? directories.has(path) : topFiles.has(path),
        "Generated tree contains legacy or unexpected root files",
      );
    if (stat.isFile() && (path.startsWith("src/") || path.startsWith("tests/")))
      check(
        (GENERATED_AUTHORING_SOURCE_FILES as readonly string[]).includes(path),
        "Generated tree contains a legacy definition or unexpected executable source",
      );
    const entry: (typeof inventory)[number] = {
      path,
      kind: stat.isDirectory() ? "directory" : "file",
      private: privateEntry,
    };
    if (stat.isFile() && !privateEntry) {
      check(
        ++publicFiles <= AUTHORING_BOUNDS.sourceFiles,
        "Generated public file count exceeded bound",
      );
      const source = readAuthoringSource(consumer, path);
      bytes += source.byteLength;
      check(bytes <= AUTHORING_BOUNDS.totalSourceBytes, "Generated public bytes exceeded bound");
      entry.sha256 = applicationHash(source);
    }
    inventory.push(entry);
    if (stat.isDirectory()) {
      const children = readdirSync(join(consumer, path)).sort();
      check(children.length <= 128, "Generated directory count exceeded bound");
      for (const child of children) visit(`${path}/${child}`, depth + 1);
    }
  };
  const roots = readdirSync(consumer).sort();
  check(roots.length <= 128, "Generated root count exceeded bound");
  for (const root of roots) visit(root, 0);
  return inventory;
}

export function prepareAuthoringWorkspace(workspace: string): void {
  for (const name of ["home", "tmp", "npm-cache"])
    mkdirSync(join(workspace, name), { recursive: true, mode: 0o700 });
}

export async function runAuthoringBuild(options: {
  workspace: string;
  consumer: string;
  evidenceDirectory: string;
  label: string;
  command: readonly string[];
}) {
  check(/^[a-z0-9-]{1,80}$/.test(options.label), "Invalid command evidence label");
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const result = await runAcceptedBuildCommand({
    command: options.command,
    cwd: options.consumer,
    env: acceptedBuildEnvironment(options.workspace),
  });
  const { stdout, stderr, ...summary } = result;
  writeFileSync(
    join(options.evidenceDirectory, `${options.label}.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(options.evidenceDirectory, `${options.label}.log`), `${stdout}\n${stderr}`, {
    mode: 0o600,
  });
  check(
    result.status === "passed" && !result.cleanupUnknown,
    `Authoring ${options.label} failed; inspect bounded command evidence`,
  );
  return summary;
}

/** Only a CLI carrier has a harness-written manifest. Generated project manifests stay untouched. */
export async function installAuthoringCli(options: {
  repoRoot: string;
  workspace: string;
  name: string;
  evidenceDirectory: string;
  core: AuthoringArtifactSet["core"];
}): Promise<InstalledAuthoringCli & { consumer: string }> {
  check(/^[a-z][a-z0-9-]{0,50}$/.test(options.name), "Invalid CLI carrier name");
  prepareAuthoringWorkspace(options.workspace);
  const core = inspectApplicationArtifact(options.core);
  assertApplicationCapability(core.manifest);
  const consumer = join(options.workspace, options.name);
  mkdirSync(consumer, { mode: 0o700 });
  const raw = core.manifest.overrides;
  check(raw === undefined || record(raw), "Core overrides are malformed");
  const overrides = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([name, spec]) => {
      if (providers.some((provider) => name === `@auggy/${provider}`)) return false;
      check(
        typeof spec === "string" && !/^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(spec),
        "CLI security override escaped registry selection",
      );
      return true;
    }),
  );
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: options.name,
        private: true,
        type: "module",
        dependencies: { auggy: `file:${realpathSync(options.core.path)}` },
        overrides,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await runAuthoringBuild({
    ...options,
    consumer,
    label: "install-cli",
    command: [process.execPath, "install", "--ignore-scripts"],
  });
  const selected = assertInstalledApplicationArtifact(
    consumer,
    options.repoRoot,
    core,
    "auggy/cli",
  );
  return { consumer, core, entry: selected.entry, packageRoot: selected.packageRoot };
}

/** Runs actual packed create, then adopts exactly its output without copying or repairing it. */
export async function createAuthoringConsumer(
  options: CreateAuthoringConsumerOptions,
): Promise<GeneratedAuthoringConsumer> {
  prepareAuthoringWorkspace(options.workspace);
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const selection = selectAuthoringArtifacts(options.artifacts, options.provider);
  check(
    options.cli.core.sha256 === selection.core.sha256,
    "Create must use the matching candidate CLI artifact",
  );
  const cliCarrier = realpathSync(join(options.cli.packageRoot, "../.."));
  const selectedCli = assertInstalledApplicationArtifact(
    cliCarrier,
    options.repoRoot,
    selection.core,
    "auggy/cli",
  );
  check(
    selectedCli.entry === realpathSync(options.cli.entry),
    "Create CLI entry does not match its installed artifact",
  );
  const create = await runBoundedAuthoringCli({
    entry: selectedCli.entry,
    args: authoringCreateArguments({ ...options, allowUnpricedModel: true }),
    cwd: options.workspace,
    workspace: options.workspace,
    selection,
  });
  writeFileSync(
    join(options.evidenceDirectory, "create-command.json"),
    `${JSON.stringify(create, null, 2)}\n`,
    { mode: 0o600 },
  );
  assertAuthoringCommandSucceeded(create);
  const consumer = realpathSync(join(options.workspace, options.name));
  const inventory = inspectGeneratedAuthoringTree(consumer);
  writeFileSync(
    join(options.evidenceDirectory, "generated-tree.json"),
    `${JSON.stringify({ status: "passed", inventory }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const sourceFiles = GENERATED_AUTHORING_SOURCE_FILES;
  const generatedSources = snapshotGeneratedAuthoringSources({ ...options, consumer, sourceFiles });
  assertAuthoringArtifactManifest(readAuthoringSource(consumer, "package.json"), selection);
  const secret = lstatSync(join(consumer, ".env"));
  check(
    secret.isFile() && !secret.isSymbolicLink() && (secret.mode & 0o077) === 0,
    "Generated environment file is not private and regular",
  );
  writeFileSync(
    join(options.evidenceDirectory, "generated-sources.json"),
    `${JSON.stringify({ sourceFiles, hashes: generatedSources, secretFile: { mode: secret.mode & 0o777, bytesArchived: false } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const run = (label: string, command: readonly string[]) =>
    runAuthoringBuild({ ...options, consumer, label, command });
  await run("install", [process.execPath, "install", "--ignore-scripts"]);
  const selected = [selection.core, selection.provider, ...selection.prerequisites].map(
    (artifact) =>
      assertInstalledApplicationArtifact(
        consumer,
        options.repoRoot,
        artifact,
        artifact.packageName === "auggy" ? "auggy/application" : artifact.packageName,
      ),
  );
  if (options.provider === "openrouter") {
    const openrouter = selected[1]!;
    const prerequisite = selected[2]!;
    const actual = realpathSync(
      createRequire(join(openrouter.packageRoot, "package.json")).resolve("@auggy/openai"),
    );
    check(actual === prerequisite.entry, "OpenRouter resolved a different OpenAI prerequisite");
  }
  const lockSHA256 = applicationHash(readFileSync(join(consumer, "bun.lock")));
  await run("typecheck", [process.execPath, "run", "typecheck"]);
  await run("generated-tests", [process.execPath, "run", "test"]);
  const audit = runDependencyAudit({
    cwd: consumer,
    evidencePath: join(options.evidenceDirectory, "dependency-audit.json"),
  });
  check(audit.status === "passed", "Generated dependency audit did not pass");
  await run("frozen-install", [
    process.execPath,
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
  check(
    applicationHash(readFileSync(join(consumer, "bun.lock"))) === lockSHA256,
    "Frozen generated lock changed",
  );
  const installedSources = snapshotGeneratedAuthoringSources({ ...options, consumer, sourceFiles });
  assertOnlyApplicationEdits(generatedSources, installedSources, []);
  const result = {
    consumer,
    core: selection.core,
    provider: selection.provider,
    prerequisites: selection.prerequisites,
    sourceFiles,
    generatedSources,
    installedSources,
    lockSHA256,
  };
  writeFileSync(
    join(options.evidenceDirectory, "adoption.json"),
    `${JSON.stringify({ status: "passed", ...result, selected }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return result;
}

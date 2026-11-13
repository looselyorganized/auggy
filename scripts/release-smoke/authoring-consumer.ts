/** Bounded, nonmutating adoption helpers; actual CLI acceptance is a later stage. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { acceptedBuildEnvironment } from "./accepted-main-artifacts";
import {
  applicationHash,
  assertApplicationCapability,
  inspectApplicationArtifact,
  startApplicationChild,
} from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";
import {
  AUTHORING_BOUNDS,
  AUTHORING_EXECUTION_FILES,
  type AuthoringArtifactSelection,
  type AuthoringArtifactSet,
  type AuthoringPackage,
  type AuthoringProvider,
  type FileHashes,
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

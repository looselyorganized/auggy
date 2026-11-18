/**
 * M3 installed-application harness primitives. Preparation is not acceptance:
 * no helper below installs packages or manufactures an application/runtime.
 * The integrated reference runner must supply the explicit domain contract.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { TurnFinalizationObservation } from "../../src/index";
import { APPLICATION_BOUNDS } from "./application-child";
export { APPLICATION_BOUNDS, startApplicationChild } from "./application-child";
import type { ProviderFixtureEvidence, ProviderFixtureTool } from "./provider-fixture";
import { readBoundedRegularFile } from "./bounded-file";

export const APPLICATION_ROWS = [
  "L01-launch-parity",
  "L02-startup-edit",
  "L03-http-edit",
  "L04-turn-edit",
  "L05-preflight",
  "L06-workspace-policy",
  "L07-artifact-selection",
  "L08-delegation",
  "L09-old-local-legacy",
  "L10-lifecycle",
  "L11-recovery",
  "L12-macos-launchd",
  "L13-linux-generated",
  "L14-deploy-artifact",
  "L15-options-env",
  "L16-retained-upgrade",
] as const;

type Manifest = {
  name: string;
  version: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  bin?: Record<string, string>;
  auggyRuntime?: {
    schemaVersion: number;
    launcherProtocol: number;
    applicationContracts: number[];
  };
};

export interface ApplicationSourceEdit {
  path: string;
  before: string;
  after: string;
}

export interface ApplicationRecipe {
  entrypoint: string;
  /** Explicit allowlist: never recursively copy a developer project. */
  sourceFiles: readonly string[];
  edits: {
    startup: ApplicationSourceEdit;
    http: ApplicationSourceEdit;
    turn: ApplicationSourceEdit;
  };
  tool: ProviderFixtureTool;
  userMessage: string;
  /** Actual fixture outputs; the reference owner selects the paths and writers. */
  evidenceFiles: { startup: string; trace: string; finalization: string; toolJournal: string };
}

export interface PackedArtifactInput {
  path: string;
  sha256: string;
  packageName: string;
  /** Relevant files from this artifact, subsequently compared with installed bytes. */
  sourceFiles: readonly string[];
}

export interface PackedArtifactEvidence {
  packageName: string;
  version: string;
  sha256: string;
  manifest: Manifest;
  fileHashes: Record<string, string>;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function applicationHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function localPath(path: string): string {
  check(
    path.length > 0 && path.length <= 512 && !isAbsolute(path),
    "Expected a bounded relative fixture path",
  );
  const parts = path.split(/[\\/]/);
  check(
    parts.every((part) => part !== ".." && part !== "" && part !== "."),
    "Fixture path must be canonical and contained",
  );
  check(!path.includes("\0"), "Fixture path contains NUL");
  return parts.join(sep);
}

function regularBytes(
  root: string,
  path: string,
  maxBytes = APPLICATION_BOUNDS.sourceBytes,
): Buffer {
  const parts = localPath(path).split(sep);
  const owner = realpathSync(root);
  let current = owner;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    check(!lstatSync(current).isSymbolicLink(), "Fixture source must not traverse symlinks");
  }
  const parent = realpathSync(current);
  check(inside(parent, owner), "Fixture file escaped its owner");
  return readBoundedRegularFile(join(parent, parts.at(-1)!), maxBytes).bytes;
}

function archiveFile(archive: string, path: string): Buffer {
  const result = spawnSync("tar", ["-xOf", archive, `package/${localPath(path)}`], {
    timeout: 15_000,
    maxBuffer: APPLICATION_BOUNDS.sourceBytes,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  check(
    !result.error && result.status === 0 && !result.signal,
    "Could not read bounded packed artifact member",
  );
  return result.stdout;
}

export function inspectApplicationArtifact(input: PackedArtifactInput): PackedArtifactEvidence {
  check(/^[a-f0-9]{64}$/.test(input.sha256), "Expected an exact artifact SHA256");
  check(
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input.packageName),
    "Invalid packed package name",
  );
  const path = resolve(input.path);
  const bytes = regularBytes(dirname(path), basename(path), APPLICATION_BOUNDS.artifactBytes);
  check(applicationHash(bytes) === input.sha256, "Packed artifact SHA256 mismatch");
  const manifestBytes = archiveFile(path, "package.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  check(
    manifest.name === input.packageName && typeof manifest.version === "string",
    "Packed artifact identity mismatch",
  );
  check(
    input.sourceFiles.length > 0 &&
      input.sourceFiles.length <= APPLICATION_BOUNDS.artifactSourceFiles,
    "Artifact source evidence must be explicit and bounded",
  );
  const fileHashes: Record<string, string> = { "package.json": applicationHash(manifestBytes) };
  for (const file of input.sourceFiles)
    fileHashes[localPath(file)] = applicationHash(archiveFile(path, file));
  check(
    applicationHash(readBoundedRegularFile(path, APPLICATION_BOUNDS.artifactBytes).bytes) ===
      input.sha256,
    "Packed artifact changed during inspection",
  );
  return {
    packageName: manifest.name,
    version: manifest.version,
    sha256: input.sha256,
    manifest,
    fileHashes,
  };
}

export function assertApplicationCapability(manifest: Manifest, contractVersion: 1 | 2 = 1): void {
  const capability = manifest.auggyRuntime;
  check(
    manifest.name === "auggy" &&
      capability?.schemaVersion === 1 &&
      capability.launcherProtocol === 1 &&
      Array.isArray(capability.applicationContracts) &&
      capability.applicationContracts.includes(contractVersion),
    `Application acceptance requires a contract-${contractVersion} capable core artifact`,
  );
}

function sourcePath(path: string): string {
  const file = localPath(path);
  check(
    !file
      .split(sep)
      .some(
        (part) =>
          [
            "node_modules",
            ".git",
            ".worktrees",
            ".auggy",
            "data",
            ".application-artifacts",
          ].includes(part) ||
          (part.startsWith(".env") && part !== ".env.example"),
      ),
    "Source allowlist contains dependency, state or secret files",
  );
  check(!/\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(file), "Source allowlist contains database state");
  check(
    file !== "bun.lock" && file !== "bun.lockb",
    "Reference development lock must not become the packed consumer lock",
  );
  return file;
}

export function snapshotApplicationFiles(
  root: string,
  files: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [localPath(file), applicationHash(regularBytes(root, file))]),
  );
}

export function assertOnlyApplicationEdits(
  before: Record<string, string>,
  after: Record<string, string>,
  expected: readonly string[],
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = keys.filter((key) => before[key] !== after[key]);
  check(
    JSON.stringify(changed) === JSON.stringify([...expected].map(localPath).sort()),
    "Application edit changed unexpected files or did not execute its edit",
  );
}

export async function withApplicationEdit<T>(
  root: string,
  edit: ApplicationSourceEdit,
  use: () => Promise<T>,
  canRestore: () => boolean = () => true,
): Promise<T> {
  const file = localPath(edit.path);
  const original = regularBytes(root, file);
  const text = original.toString("utf8");
  check(
    edit.before.length > 0 && edit.before !== edit.after,
    "Application edit needs distinct explicit anchors",
  );
  check(text.split(edit.before).length === 2, "Application edit anchor must occur exactly once");
  let primary: { error: unknown } | undefined;
  let restoration: { error: unknown } | undefined;
  let value: T | undefined;
  try {
    writeFileSync(
      join(root, file),
      text.replace(edit.before, () => edit.after),
    );
    value = await use();
  } catch (error) {
    primary = { error };
  }
  try {
    check(canRestore(), "Application edit retained because process cleanup is unconfirmed");
    writeFileSync(join(root, file), original);
  } catch (error) {
    restoration = { error };
  }
  if (primary && restoration)
    throw new AggregateError(
      [primary.error, restoration.error],
      "Application operation failed and its edit could not safely be restored",
    );
  if (primary) throw primary.error;
  if (restoration) throw restoration.error;
  return value as T;
}

export function prepareApplicationConsumer(options: {
  repoRoot: string;
  referenceDir: string;
  destination: string;
  recipe: ApplicationRecipe;
  core: PackedArtifactInput;
  provider: PackedArtifactInput;
}) {
  const repo = realpathSync(options.repoRoot),
    reference = realpathSync(options.referenceDir);
  const destination = resolve(options.destination),
    parent = realpathSync(dirname(destination));
  const actualDestination = join(parent, basename(destination));
  check(
    !inside(actualDestination, repo) && !inside(repo, actualDestination),
    "Consumer must be isolated outside the source checkout",
  );
  check(!lstatSync(destination, { throwIfNoEntry: false }), "Consumer destination already exists");
  const files = options.recipe.sourceFiles.map(sourcePath);
  check(
    files.length <= 128 && new Set(files).size === files.length,
    "Source allowlist must be unique and bounded",
  );
  check(
    ["agent.yaml", "package.json", localPath(options.recipe.entrypoint)].every((file) =>
      files.includes(file),
    ),
    "Reference allowlist lacks config, package or entrypoint",
  );
  const contents = new Map(files.map((file) => [file, regularBytes(reference, file)]));
  check(
    [...contents.values()].reduce((total, bytes) => total + bytes.byteLength, 0) <=
      16 * 1024 * 1024,
    "Reference source exceeded total copy bound",
  );
  for (const edit of Object.values(options.recipe.edits)) {
    check(files.includes(localPath(edit.path)), "Edit points outside copied application source");
    check(
      edit.before.length > 0 &&
        edit.before !== edit.after &&
        contents.get(localPath(edit.path))!.toString("utf8").split(edit.before).length === 2,
      "Reference source does not match its explicit edit contract",
    );
  }
  for (const file of Object.values(options.recipe.evidenceFiles)) localPath(file);
  check(
    options.recipe.userMessage.length > 0 && options.recipe.userMessage.length <= 4_096,
    "Fixture request must be explicit and bounded",
  );
  const core = inspectApplicationArtifact(options.core),
    provider = inspectApplicationArtifact(options.provider);
  const declaration = parse(contents.get("agent.yaml")!.toString("utf8"))?.application;
  check(
    declaration?.contractVersion === 1 || declaration?.contractVersion === 2,
    "Reference application must declare a supported contract",
  );
  assertApplicationCapability(core.manifest, declaration.contractVersion);
  check(
    provider.packageName === "@auggy/anthropic",
    "Application fixture uses the existing real Anthropic adapter",
  );
  const manifest = JSON.parse(contents.get("package.json")!.toString("utf8")) as Manifest;
  // The checked-in example needs these exact source-checkout overrides for
  // Bun's nested workspace development references. Packed consumers must not.
  const checkoutOverrides: Record<string, string> = {
    "@auggy/anthropic": "file:../../packages/anthropic",
    "@auggy/ollama": "file:../../packages/ollama",
    "@auggy/openai": "file:../../packages/openai",
    "@auggy/openrouter": "file:../../packages/openrouter",
  };
  if (manifest.overrides !== undefined) {
    check(
      manifest.overrides !== null &&
        typeof manifest.overrides === "object" &&
        !Array.isArray(manifest.overrides),
      "Reference overrides must be a dependency map",
    );
    manifest.overrides = { ...manifest.overrides };
    for (const [name, spec] of Object.entries(manifest.overrides)) {
      if (checkoutOverrides[name] === spec) {
        delete manifest.overrides[name];
        continue;
      }
      check(
        typeof spec === "string" && !/^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(spec),
        "Reference override would escape the packed consumer",
      );
      check(
        name !== core.packageName && name !== provider.packageName,
        "Runtime override conflicts with the packed artifact selection",
      );
    }
  }
  manifest.dependencies = { ...manifest.dependencies };
  const artifactInputs = [options.core, options.provider];
  for (const [index, artifact] of [core, provider].entries()) {
    manifest.dependencies[artifact.packageName] =
      `file:./.application-artifacts/${index}-${artifact.sha256}.tgz`;
  }
  for (const deps of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (name === core.packageName || name === provider.packageName) {
        check(
          deps === manifest.dependencies,
          "Runtime dependency also declared outside dependencies",
        );
      } else
        check(
          !/^(?:file:|link:|workspace:|\.?\.?\/|\/)/.test(spec),
          "Reference dependency would escape the packed consumer",
        );
    }
  }
  let created = false;
  try {
    mkdirSync(destination, { mode: 0o700 });
    created = true;
    for (const [file, bytes] of contents) {
      mkdirSync(dirname(join(destination, file)), { recursive: true, mode: 0o700 });
      writeFileSync(join(destination, file), bytes, { mode: 0o600 });
    }
    mkdirSync(join(destination, ".application-artifacts"), { mode: 0o700 });
    for (const [index, artifact] of [core, provider].entries()) {
      const { bytes } = readBoundedRegularFile(
        artifactInputs[index]!.path,
        APPLICATION_BOUNDS.artifactBytes,
      );
      check(applicationHash(bytes) === artifact.sha256, "Artifact changed before materialization");
      writeFileSync(
        join(destination, ".application-artifacts", `${index}-${artifact.sha256}.tgz`),
        bytes,
        { mode: 0o600 },
      );
    }
    writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return {
      phase: "prepared-not-executed" as const,
      consumer: destination,
      recipeSHA256: applicationHash(JSON.stringify(options.recipe)),
      sourceHashes: snapshotApplicationFiles(destination, files),
      originalSourceHashes: Object.fromEntries(
        [...contents].map(([file, bytes]) => [file, applicationHash(bytes)]),
      ),
      artifacts: [core, provider],
      pendingRows: [...APPLICATION_ROWS],
      // Caller owns installation, lock capture, frozen re-install and strict audit.
      installCommand: [process.execPath, "install", "--ignore-scripts"],
      frozenInstallCommand: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    };
  } catch (error) {
    if (created) rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function assertInstalledApplicationArtifact(
  consumer: string,
  repoRoot: string,
  artifact: PackedArtifactEvidence,
  specifier: string,
) {
  const root = realpathSync(consumer),
    repo = realpathSync(repoRoot);
  check(!inside(root, repo), "Installed consumer escaped isolation");
  const dependencies = realpathSync(join(root, "node_modules"));
  check(inside(dependencies, root), "Consumer dependencies resolve outside the consumer");
  const packageRoot = realpathSync(join(dependencies, artifact.packageName));
  check(
    inside(packageRoot, dependencies) && !inside(packageRoot, repo),
    "Explicit package escaped installed consumer",
  );
  const actual = snapshotApplicationFiles(packageRoot, Object.keys(artifact.fileHashes));
  check(
    JSON.stringify(actual) === JSON.stringify(artifact.fileHashes),
    "Installed package bytes differ from the selected packed artifact",
  );
  const entry = realpathSync(createRequire(join(root, "package.json")).resolve(specifier));
  check(inside(entry, packageRoot), "Selected import resolved to a different package");
  return { packageRoot, entry, artifactSHA256: artifact.sha256, fileHashes: actual };
}

export function classifyApplicationUpgrade(
  baseline: PackedArtifactEvidence,
  candidate: PackedArtifactEvidence,
) {
  assertApplicationCapability(baseline.manifest);
  assertApplicationCapability(candidate.manifest);
  check(baseline.sha256 !== candidate.sha256, "Upgrade requires distinct actual artifacts");
  return baseline.version === candidate.version
    ? ("same-version-artifact-experiment" as const)
    : ("application-capable-upgrade" as const);
}

export function applicationEnvironment(
  home: string,
  temp: string,
  values: Record<string, string> = {},
) {
  const allowed = new Set(["ANTHROPIC_API_KEY", "AUGGY_WEB_TOKEN", "AUGGY_PUBLIC_URL"]);
  check(
    Object.keys(values).every((key) => allowed.has(key)),
    "Fixture environment key is not allowlisted",
  );
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: realpathSync(home),
    TMPDIR: realpathSync(temp),
    LANG: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    CI: "1",
    npm_config_userconfig: "/dev/null",
    ...values,
  };
}

export interface ApplicationTraceEvidence {
  turnId: string;
  threadId: string;
  success: boolean;
  status: string;
  inferenceSteps: number;
  toolNames: string[];
  sentinelMatched: boolean;
}

export function parseApplicationStream(body: string): Record<string, unknown>[] {
  check(
    Buffer.byteLength(body) <= APPLICATION_BOUNDS.outputBytes,
    "Application SSE evidence exceeded its bound",
  );
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      const value: unknown = JSON.parse(line.slice(6));
      check(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "Invalid SSE event",
      );
      return value as Record<string, unknown>;
    });
}

export function assertApplicationTurn(options: {
  httpStatus: number;
  body: string;
  threadId: string;
  expectedCalls: 1 | 2;
  toolName: string;
  provider: ProviderFixtureEvidence;
  trace: ApplicationTraceEvidence;
  finalization: TurnFinalizationObservation;
  toolExecutions: number;
  history: TurnFinalizationObservation["history"];
  expectedFinalText?: string;
}) {
  const { provider, trace, finalization } = options;
  const events = parseApplicationStream(options.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const finishes = events.filter((event) => event.type === "RUN_FINISHED");
  check(
    options.httpStatus === 200 &&
      starts.length === 1 &&
      finishes.length === 1 &&
      events.at(-1) === finishes[0],
    "Application turn lacks one final public result",
  );
  check(
    starts[0]!.runId === finishes[0]!.runId &&
      starts[0]!.threadId === options.threadId &&
      finishes[0]!.threadId === options.threadId,
    "Application stream identity mismatch",
  );
  check(
    (finishes[0]!.result as { status?: string })?.status === "completed" &&
      !events.some((event) => event.type === "RUN_ERROR"),
    "Application did not complete successfully",
  );
  check(
    provider.calls === options.expectedCalls &&
      provider.toolRequests === 1 &&
      provider.rejectedRequests === 0 &&
      provider.finalResponses === options.expectedCalls - 1 &&
      provider.validatedToolResults === options.expectedCalls - 1,
    "Provider counts do not prove the requested local turn recipe",
  );
  check(
    trace.turnId === finalization.turnId &&
      trace.threadId === options.threadId &&
      finalization.threadId === options.threadId &&
      trace.success &&
      trace.status === "completed" &&
      trace.inferenceSteps === options.expectedCalls,
    "Trace/finalization identity or inference mismatch",
  );
  check(
    trace.toolNames.length === 1 &&
      trace.toolNames[0] === options.toolName &&
      trace.sentinelMatched &&
      options.toolExecutions === 1,
    "Actual reference tool execution was not independently observed",
  );
  check(
    finalization.status === "completed" &&
      finalization.outcome === "completed" &&
      !finalization.outcomeUnknown &&
      finalization.primaryFailureCode === null &&
      !finalization.pendingEffects &&
      finalization.accounting.state === "committed" &&
      finalization.history === options.history &&
      finalization.trace.inferenceAttempts === options.expectedCalls &&
      finalization.trace.successfulToolCalls === 1,
    "Application turn did not preserve managed accounting/history settlement",
  );
  if (options.expectedFinalText) {
    check(
      events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("")
        .includes(options.expectedFinalText),
      "Final stream text mismatch",
    );
  }
  return {
    publicRunId: starts[0]!.runId,
    turnId: trace.turnId,
    threadId: options.threadId,
    bodySHA256: applicationHash(options.body),
  };
}

export function assertApplicationDenial(
  status: number,
  before: readonly number[],
  after: readonly number[],
): void {
  check(status === 401 || status === 403, "Missing/invalid auth was not denied");
  check(
    before.length === 4 &&
      after.length === 4 &&
      before.every(
        (count, index) => Number.isSafeInteger(count) && count >= 0 && count === after[index],
      ),
    "Auth denial changed provider, trace, finalization or actual-tool counters",
  );
}

export function assertApplicationReplay(
  original: string,
  replay: string,
  before: readonly number[],
  after: readonly number[],
): void {
  check(
    applicationHash(original) === applicationHash(replay),
    "Durable replay changed the public stream",
  );
  check(
    before.length === 4 &&
      after.length === 4 &&
      before.every(
        (count, index) => Number.isSafeInteger(count) && count >= 0 && count === after[index],
      ),
    "Durable replay scheduled new model/tool/finalization work",
  );
}

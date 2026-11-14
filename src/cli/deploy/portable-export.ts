/** Pure build-context preparation: raw documents and local bytes only. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assertImmutableAgentId } from "../agent-isolation";
import { VALID_NAME_RE } from "../agent-name";
import type { AuthoringDocument, ExistingFileSnapshot } from "../authoring/contracts";
import { AuthoringError, readFileSnapshot } from "../authoring/document-io";
import { selectInspectionDocument } from "../authoring/inspection-selection";
import type { BuiltinAugmentType } from "../types";
import {
  BundleError,
  hasBundleControlCharacters,
  isContainedBundlePath,
  stageBundleWithManifest,
  validateBundleRelativePath,
  type StagedBundle,
} from "./bundle";
import {
  DEPLOYMENT_FILES,
  DEPLOYMENT_LIMITS,
  DEPLOYMENT_TOOLCHAIN,
  type DeploymentFileDigest,
  type DeploymentManifestV1,
  type ExportDockerOptions,
  type ExportDockerResult,
} from "./contracts";
import { generatePortableDockerfile, generatePortableEntrypoint } from "./dockerfile";
import { inspectPortableDependencies } from "./portable-dependencies";
import { resolveDeploymentProfile } from "./profile";
import { validateDeploymentManifest } from "./manifest";

function fail(message: string): never {
  throw new Error(`[portable-export] ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    fail("Expected literal configuration mapping; resolve structural declarations before export.");
  return value as Record<string, unknown>;
}
function literalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("${") ||
    value.includes("\\") ||
    hasBundleControlCharacters(value) ||
    Buffer.byteLength(value) > DEPLOYMENT_LIMITS.pathBytes ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    fail(
      "Source and durable paths must be bounded literal filesystem paths; environment-derived state paths cannot be exported safely.",
    );
  }
  return value;
}

/** Reject links at every required path component, even links contained in the project. */
function requiredPath(
  root: string,
  candidate: unknown,
  kind: "file" | "directory" = "file",
  base = root,
): string {
  const input = literalPath(candidate);
  const absolute = resolve(base, input);
  if (!isContainedBundlePath(root, absolute))
    fail("Required source must be contained inside the selected project.");
  const path = relative(root, absolute).split(sep).join("/");
  validateBundleRelativePath(path);
  let cursor = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!);
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (
      !stat ||
      stat.isSymbolicLink() ||
      (index < parts.length - 1
        ? !stat.isDirectory()
        : kind === "file"
          ? !stat.isFile()
          : !stat.isDirectory())
    ) {
      fail(
        "Required source is missing or is not an ordinary contained file/directory; restore it before export.",
      );
    }
  }
  return path;
}

// Every built-in participates explicitly; a future type cannot silently bypass
// the durable-state inventory. Defaults use generic database/data exclusions.
const STATE_FIELDS = {
  fileMemory: [],
  supabaseMemory: [],
  layeredMemory: ["dbPath"],
  filesystem: [],
  webTransport: [],
  webFetch: [],
  knowledge: [],
  skills: [],
  bash: [],
  budgets: ["dbPath"],
  notify: ["dbPath"],
  mcp: [],
  agentMail: ["dbPath"],
  telegramTransport: [],
  turnControl: [],
  visitorAuth: ["dbPath", "layeredMemoryDbPath"],
  link: ["dbPath"],
} as const satisfies Record<BuiltinAugmentType, readonly string[]>;

interface SourceInventory {
  excluded: string[];
  files: Set<string>;
  directories: Set<string>;
  emptySeeds: Set<string>;
}
function sourceInventory(document: AuthoringDocument): SourceInventory {
  const root = document.projectDir;
  const excluded = new Set<string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  const emptySeeds = new Set<string>();
  const state = (value: unknown, database = true): void => {
    if (value === undefined || value === null) return;
    const path = literalPath(value);
    for (const suffix of database ? ["", "-wal", "-shm", "-journal"] : [""])
      excluded.add(resolve(root, `${path}${suffix}`));
  };
  const file = (value: unknown, base = root): string => {
    const path = requiredPath(root, value, "file", base);
    files.add(path);
    return path;
  };
  for (const input of document.inputs) if (input.exists) file(input.path);
  if (document.value.identity !== undefined) file(document.value.identity);
  if (document.value.application !== undefined) {
    const application = record(document.value.application);
    if (
      application.contractVersion !== 1 ||
      Object.keys(application).some((key) => !["contractVersion", "entrypoint"].includes(key))
    )
      fail("Portable export requires a supported application declaration.");
    file(application.entrypoint);
  }
  const settings = record(document.value.settings);
  state(record(settings.jobs).dbPath);
  for (const declaration of document.declarations) {
    const options = record(declaration.options);
    if (Object.hasOwn(STATE_FIELDS, declaration.type)) {
      for (const key of STATE_FIELDS[declaration.type as BuiltinAugmentType]) state(options[key]);
    }
    if (declaration.source !== undefined)
      file(declaration.source, declaration.origin.sourceBaseDir);
    switch (declaration.type) {
      case "fileMemory": {
        const source = file(options.source);
        if (options.mutable !== undefined && typeof options.mutable !== "boolean")
          fail("fileMemory mutable must be literal before export.");
        if (options.mutable === true) emptySeeds.add(source);
        if (options.mutable === true && lstatSync(join(root, source)).size !== 0) {
          fail(
            "Nonempty mutable fileMemory source may contain live/private state. Review and archive it, deploy an empty seed, and provision durable state through the supported offline workflow. Source has not been changed.",
          );
        }
        break;
      }
      case "filesystem": {
        if (!Array.isArray(options.mounts))
          fail("Filesystem mounts must be literal before export.");
        for (const item of options.mounts) {
          const mount = record(item);
          if (
            [mount.writable, mount.deletable].some(
              (flag) => flag !== undefined && typeof flag !== "boolean",
            )
          )
            fail("Filesystem write permissions must be literal before export.");
          if (mount.writable || mount.deletable) state(mount.path, false);
          else directories.add(requiredPath(root, mount.path, "directory"));
        }
        if (options.skillFile !== undefined) file(options.skillFile);
        break;
      }
      case "webTransport":
        state(record(options.consoleChat).dbPath);
        state(record(options.idempotency).dbPath);
        state(record(record(options.externalAuth).replayProtection).dbPath);
        break;
      case "telegramTransport":
        state(record(options.replay).dbPath);
        break;
      case "notify":
        if (options.destinations !== undefined && !Array.isArray(options.destinations))
          fail("Notify destinations must be literal before export.");
        for (const item of (options.destinations ?? []) as unknown[]) {
          const destination = record(item);
          if (typeof destination.transport !== "string" || destination.transport.includes("${"))
            fail("Notify transports must be literal before export.");
          if (destination.transport === "log-to-file") state(destination.path, false);
        }
        break;
      case "knowledge":
        directories.add(requiredPath(root, options.root ?? "./knowledge", "directory"));
        break;
      case "skills":
        directories.add(requiredPath(root, options.dir ?? "./skills", "directory"));
        break;
      case "mcp":
        if (options.config !== undefined) file(options.config);
        // An optional default MCP document, if present, is ordinary project source.
        break;
    }
  }
  return { excluded: [...excluded], files, directories, emptySeeds };
}

function snapshot(path: string, limit: number): ExistingFileSnapshot {
  const result = readFileSnapshot(path, limit);
  if (!result.exists)
    fail("Required package manifest or text lock is missing; install locally before export.");
  return result;
}

function outputLocation(
  out: string,
  cwd: string,
  root: string,
): { output: string; parent: string } {
  if (
    typeof out !== "string" ||
    !out ||
    hasBundleControlCharacters(out) ||
    Buffer.byteLength(out) > DEPLOYMENT_LIMITS.pathBytes
  )
    fail("--out requires a bounded new directory path.");
  const selected = resolve(cwd, out);
  let parent: string;
  try {
    parent = realpathSync(dirname(selected));
    if (!lstatSync(parent).isDirectory())
      fail("Output parent must be an existing directory; create it before exporting.");
  } catch {
    fail("Output parent must be an existing directory; create it before exporting.");
  }
  const output = join(parent, basename(selected));
  if (output === root || isContainedBundlePath(root, output) || isContainedBundlePath(output, root))
    fail("Output must be outside and must not contain the selected source project.");
  if (lstatSync(output, { throwIfNoEntry: false }))
    fail("Output already exists; choose a new directory (no overwrite is supported).");
  return { output, parent };
}

function sameObject(left: Stats, right: Stats | undefined): boolean {
  return (
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile()
  );
}

/** Exclusive mkdir/link publication preserves every competing writer's entry on collision. */
function publish(staging: StagedBundle, output: string, files: readonly string[]): void {
  const owned: { path: string; stat: Stats }[] = [];
  try {
    mkdirSync(output, { mode: 0o700 });
    owned.push({ path: output, stat: lstatSync(output) });
    for (const path of staging.directories) {
      const destination = join(output, path);
      mkdirSync(destination, { mode: 0o700 });
      owned.push({ path: destination, stat: lstatSync(destination) });
    }
    for (const path of files) {
      const destination = join(output, path);
      linkSync(join(staging.directory, path), destination);
      owned.push({ path: destination, stat: lstatSync(destination) });
    }
  } catch {
    for (const entry of owned.reverse()) {
      try {
        if (!sameObject(entry.stat, lstatSync(entry.path, { throwIfNoEntry: false }))) continue;
        if (entry.stat.isDirectory()) rmdirSync(entry.path);
        else unlinkSync(entry.path);
      } catch {
        /* A competing writer's entry is never recursively removed. */
      }
    }
    fail(
      "Cannot publish exclusively; output or parent changed. Existing competing files were preserved.",
    );
  }
}

export async function exportDocker(options: ExportDockerOptions): Promise<ExportDockerResult> {
  let staged: StagedBundle | undefined;
  try {
    if (
      options.config !== undefined &&
      (typeof options.config !== "string" || !options.config.trim())
    ) {
      fail("--config requires a non-empty explicit file path; omit it to select agent.yaml.");
    }
    const cwd = resolve(options.cwd ?? process.cwd());
    const document = selectInspectionDocument(
      options.name,
      options.config !== undefined ? resolve(cwd, options.config) : undefined,
      { cwd },
    );
    const root = document.projectDir;
    if (typeof document.value.id !== "string")
      fail("Export requires a literal immutable agent id.");
    try {
      assertImmutableAgentId(document.value.id);
    } catch {
      fail("Export requires a valid literal immutable agent id; do not interpolate it.");
    }
    const name = document.value.name;
    if (
      typeof name !== "string" ||
      !VALID_NAME_RE.test(name) ||
      Buffer.byteLength(name) > DEPLOYMENT_LIMITS.cloudIdentifierBytes
    )
      fail("Export requires a literal safe agent name.");
    const profile = resolveDeploymentProfile(document, options);
    const location = outputLocation(options.out, cwd, root);
    const inventory = sourceInventory(document);
    const configPath = requiredPath(root, document.configPath);
    const manifestPath = requiredPath(root, DEPLOYMENT_FILES.packageManifest);
    const lockPath = requiredPath(root, DEPLOYMENT_FILES.lockfile);
    const packageSnapshot = snapshot(
      join(root, manifestPath),
      DEPLOYMENT_LIMITS.packageManifestBytes,
    );
    const lockSnapshot = snapshot(join(root, lockPath), DEPLOYMENT_LIMITS.lockfileBytes);
    for (const path of [
      DEPLOYMENT_FILES.dockerfile,
      DEPLOYMENT_FILES.entrypoint,
      DEPLOYMENT_FILES.manifest,
    ]) {
      if (lstatSync(join(root, path), { throwIfNoEntry: false }))
        fail(
          "Source collides with a reserved generated Dockerfile, entrypoint or deployment manifest.",
        );
    }
    // A project Bun config can embed registry credentials or redefine install inputs.
    if (lstatSync(join(root, "bunfig.toml"), { throwIfNoEntry: false }))
      fail(
        "Project bunfig.toml is outside the portable install profile; prepare a project using manifest/lock inputs without embedded installer configuration.",
      );
    staged = stageBundleWithManifest(
      { agentDir: root, agentName: name, excludedPaths: inventory.excluded },
      location.parent,
    );
    for (const name of staged.rootEntries.map((name) => name.toLowerCase())) {
      if (
        name === ".dockerignore" ||
        name === `${DEPLOYMENT_FILES.dockerfile.toLowerCase()}.dockerignore`
      )
        fail(
          "Existing .dockerignore rules are not supported by portable export (including Dockerfile.dockerignore). Prepare a source project without that file; export will not rewrite ignore rules.",
        );
      if (name === "bunfig.toml")
        fail(
          "Project bunfig.toml is outside the portable install profile; prepare manifest/lock inputs without embedded installer configuration.",
        );
      if (
        [DEPLOYMENT_FILES.dockerfile, DEPLOYMENT_FILES.entrypoint, DEPLOYMENT_FILES.manifest].some(
          (reserved) => reserved.toLowerCase() === name,
        )
      )
        fail("Source collides with a reserved generated filename (including case aliases).");
    }
    const byPath = new Map(staged.files.map((file) => [file.path, file]));
    for (const path of inventory.emptySeeds)
      if (byPath.get(path)?.bytes !== 0)
        fail("Mutable seed changed before staging; only an ordinary empty seed can be exported.");
    for (const path of [...inventory.files, manifestPath, lockPath])
      if (!byPath.has(path))
        fail(
          "A required source file is excluded as secret/state or unsupported; separate source from runtime state before exporting.",
        );
    for (const path of inventory.directories)
      if (!staged.directories.includes(path))
        fail("A required source directory is excluded as runtime state.");
    for (const input of [...document.inputs, packageSnapshot, lockSnapshot]) {
      if (
        input.exists &&
        byPath.get(relative(root, input.path).split(sep).join("/"))?.sha256 !== input.sha256
      )
        fail("Selected input changed before staging; retry with stable source.");
    }
    const tarballs = await inspectPortableDependencies(
      staged.directory,
      packageSnapshot.bytes,
      lockSnapshot.bytes,
      new Set(byPath.keys()),
    );
    const tarballPaths = new Set(tarballs);
    const generatedFiles: DeploymentFileDigest[] = [];
    const generate = (path: string, text: string, mode: number): void => {
      const bytes = Buffer.from(text);
      writeFileSync(join(staged!.directory, path), bytes, { flag: "wx", mode });
      chmodSync(join(staged!.directory, path), mode);
      generatedFiles.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mode,
      });
    };
    generate(
      DEPLOYMENT_FILES.dockerfile,
      generatePortableDockerfile({
        agentName: name,
        configPath,
        profile: profile.profile,
        dependencyTarballs: tarballs,
      }),
      0o644,
    );
    generate(DEPLOYMENT_FILES.entrypoint, generatePortableEntrypoint(), 0o755);
    generatedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest: DeploymentManifestV1 = {
      version: 1,
      agentId: document.value.id,
      agentName: name,
      configPath,
      profile: profile.profile,
      selection: profile.selection,
      evidence: profile.evidence,
      toolchain: DEPLOYMENT_TOOLCHAIN,
      packageJsonSHA256: packageSnapshot.sha256,
      lockfileSHA256: lockSnapshot.sha256,
      sourceFiles: staged.files.filter((file) => !tarballPaths.has(file.path)),
      dependencyTarballs: staged.files.filter((file) => tarballPaths.has(file.path)),
      generatedFiles,
    };
    if (staged.files.length + generatedFiles.length > DEPLOYMENT_LIMITS.visitedEntries)
      fail("Deployment manifest exceeds the aggregate file-entry limit.");
    validateDeploymentManifest(manifest, {
      agentId: document.value.id,
      agentName: name,
      configPath,
    });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (bytes.length > DEPLOYMENT_LIMITS.deploymentManifestBytes)
      fail("Deployment manifest exceeds the 4 MiB limit.");
    writeFileSync(join(staged.directory, DEPLOYMENT_FILES.manifest), bytes, {
      flag: "wx",
      mode: 0o644,
    });
    chmodSync(join(staged.directory, DEPLOYMENT_FILES.manifest), 0o644);
    staged.verifySource();
    const files = [
      ...staged.files.map((file) => file.path),
      ...generatedFiles.map((file) => file.path),
      DEPLOYMENT_FILES.manifest,
    ];
    publish(staged, location.output, files);
    return {
      outputDir: location.output,
      profile: profile.profile,
      manifestPath: join(location.output, DEPLOYMENT_FILES.manifest),
      fileCount: files.length,
      sourceBytes: staged.sourceBytes,
      buildVerified: false,
    };
  } catch (error) {
    if (
      error instanceof AuthoringError ||
      error instanceof BundleError ||
      (error instanceof Error &&
        /^\[(?:portable-export|portable-dependencies|deployment-profile)\]/.test(error.message))
    )
      throw new Error(error.message);
    // Do not expose raw parser/OS errors containing source paths or private values.
    return fail(
      "Cannot prepare the portable context. Check required package.json/bun.lock, ordinary source paths, bounded file sizes and output-parent permissions; source was not changed.",
    );
  } finally {
    if (staged) rmSync(staged.directory, { recursive: true, force: true });
  }
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactEvidence } from "./export-evidence";

/** The accepted, audited pre-application main. Never substitute the 29147 negative fixture. */
export const ACCEPTED_MAIN = Object.freeze({
  commit: "209185d0e7481b4ff5d3b4c87e3447e7583b2fef",
  tree: "30bd2b764c6e136708a82fc186ce733e3741a4ff",
  lockSHA256: "cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7",
  bun: "1.3.14",
  coreSHA256: "5ae1478b16e4303f627a8a084e1100076a2f04cbfffb2a928fe54f2400acfb01",
  providerSHA256: "04c188f1239e7760df5f42f7a501d6cf8a709d88577edc50617bfbbeb59e3cad",
});

const MAX_COMMAND_MS = 180_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REAP_MS = 5_000;

type BuildCommandFailure =
  | "timeout"
  | "output-limit"
  | "spawn-failed"
  | "interrupted"
  | "process-group-live";

type BuildCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: "passed" | "failed";
  failure: BuildCommandFailure | null;
  cleanupUnknown: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutSHA256: string;
  stderrSHA256: string;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(path: string): string {
  check(lstatSync(path).isFile(), "Expected a regular file");
  return sha256(readFileSync(path));
}

/** Explicit env excludes user npm settings, credentials, preloads and repository aliases. */
export function acceptedBuildEnvironment(workspace: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(workspace, "home"),
    TMPDIR: join(workspace, "tmp"),
    LANG: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: join(workspace, "npm-globalconfig"),
  };
}

/** Build commands may spawn tsc/Vite/npm children; bound and reap their entire process group. */
export async function runAcceptedBuildCommand(options: {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<BuildCommandResult> {
  const timeoutMs = options.timeoutMs ?? MAX_COMMAND_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  check(process.platform !== "win32", "Accepted artifact builds require POSIX process groups");
  check(options.command.length > 0, "Missing command");
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_COMMAND_MS,
    "Invalid command deadline",
  );
  check(
    Number.isSafeInteger(maxOutputBytes) &&
      maxOutputBytes > 0 &&
      maxOutputBytes <= MAX_OUTPUT_BYTES,
    "Invalid command output bound",
  );
  const started = Date.now();
  const child = spawn(options.command[0]!, options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let bytes = 0;
  let failure: BuildCommandFailure | null = null;
  let cleanupUnknown = false;
  let closed = false;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupUnknown = true;
    }
  };
  let finish!: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  const finished = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (done) => {
      finish = (exitCode, signal) => {
        if (closed) return;
        closed = true;
        done({ exitCode, signal });
      };
    },
  );
  const abort = (reason: BuildCommandFailure) => {
    failure ??= reason;
    killGroup();
    reapTimer ??= setTimeout(() => {
      cleanupUnknown = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(null, null);
    }, REAP_MS);
  };
  const interrupt = () => abort("interrupted");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (value: Buffer) => {
      const available = Math.max(0, maxOutputBytes - bytes);
      if (available) output[stream].push(value.subarray(0, available));
      bytes += value.length;
      if (bytes > maxOutputBytes) abort("output-limit");
    });
  }
  child.once("error", () => {
    failure ??= "spawn-failed";
  });
  child.once("close", (exitCode, signal) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 0);
        failure ??= "process-group-live";
        cleanupUnknown = true;
        killGroup();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupUnknown = true;
      }
    }
    finish(exitCode, signal);
  });
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  try {
    const outcome = await finished;
    const stdout = redactEvidence(Buffer.concat(output.stdout).toString("utf8"), []);
    const stderr = redactEvidence(Buffer.concat(output.stderr).toString("utf8"), []);
    return {
      ...outcome,
      status:
        outcome.exitCode === 0 && !failure && !cleanupUnknown
          ? ("passed" as const)
          : ("failed" as const),
      failure,
      cleanupUnknown,
      durationMs: Date.now() - started,
      stdout,
      stderr,
      stdoutSHA256: sha256(stdout),
      stderrSHA256: sha256(stderr),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(reapTimer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

/** npm archives are generated from fixed trusted source; reject links and ambiguous paths first. */
export function validateAcceptedPackInventory(names: string, verbose: string): string[] {
  const entries = names.trimEnd().split("\n");
  const descriptions = verbose.trimEnd().split("\n");
  check(
    entries.length > 0 && entries.length <= 5_000 && descriptions.length === entries.length,
    "Invalid package inventory",
  );
  const seen = new Set<string>();
  for (const [index, name] of entries.entries()) {
    check(
      name.startsWith("package/") &&
        !name.includes("\\") &&
        [...name].every(
          (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
        ),
      "Unsafe package path",
    );
    check(
      name.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      "Unsafe package path",
    );
    check(
      !seen.has(name) && descriptions[index]?.startsWith("-"),
      "Nonregular or duplicate package entry",
    );
    seen.add(name);
  }
  check(seen.has("package/package.json"), "Package manifest missing");
  return entries.map((entry) => entry.slice("package/".length));
}

function inventory(directory: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, inventory(path, `${relative}/`));
    else {
      check(entry.isFile(), "Source archive contains a nonregular file");
      files[relative] = fileHash(path);
    }
  }
  return files;
}

function sourceFileHash(directory: string, path: string): string {
  check(
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      !path.includes("\\"),
    "Invalid source path",
  );
  let current = directory;
  for (const part of path.split("/")) {
    current = join(current, part);
    check(!lstatSync(current).isSymbolicLink(), "Source path contains a symbolic link");
  }
  return fileHash(current);
}

export function verifyAcceptedSourceFiles(
  directory: string,
  expected: Record<string, string>,
): void {
  for (const [path, hash] of Object.entries(expected)) {
    check(sourceFileHash(directory, path) === hash, `Accepted source changed: ${path}`);
  }
}

/** Verify archive bytes against Git blob IDs, not merely against the newly extracted copy. */
export function verifyAcceptedArchive(
  directory: string,
  treeListing: string,
): Record<string, string> {
  const files = inventory(directory);
  const entries = treeListing.trimEnd().split("\n");
  check(entries.length === Object.keys(files).length, "Accepted archive file count mismatch");
  for (const entry of entries) {
    const match = /^(100(?:644|755)) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    check(match, "Accepted source contains unsupported entries");
    const path = match[3]!;
    check(sourceFileHash(directory, path) === files[path], "Accepted archive path mismatch");
    const bytes = readFileSync(join(directory, path));
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    check(blob === match[2], `Accepted archive blob mismatch: ${path}`);
    check(
      ((lstatSync(join(directory, path)).mode & 0o111) !== 0) === (match[1] === "100755"),
      "Accepted archive executable mode mismatch",
    );
  }
  return files;
}

type AcceptedArtifact = {
  path: string;
  sha256: string;
  packageName: string;
  version: "0.5.0";
  certifiedSHA256: string;
  matchesCertifiedArtifact: boolean;
  equivalence: "byte-identical-certified-artifact" | "source-verified-rebuild";
  sourceFiles: Record<string, string>;
};

export type AcceptedMainArtifacts = {
  status: "passed";
  core: AcceptedArtifact;
  provider: AcceptedArtifact;
  source: { commit: string; tree: string; lockSHA256: string; archiveSHA256: string };
  toolchain: { bun: string; node: string; npm: string; platform: string; architecture: string };
  evidencePath: string;
};

export async function buildAcceptedMainArtifacts(options: {
  repositoryRoot: string;
  outputDirectory: string;
}): Promise<AcceptedMainArtifacts> {
  const helperSHA256 = fileHash(import.meta.path);
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const outputDirectory = resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  check(
    lstatSync(outputDirectory).isDirectory() && readdirSync(outputDirectory).length === 0,
    "Artifact output must be an empty directory",
  );
  const evidencePath = join(outputDirectory, "accepted-main-artifacts.json");
  const logs = join(outputDirectory, "logs");
  const packs = join(outputDirectory, "packs");
  mkdirSync(logs);
  mkdirSync(packs);
  const workspace = mkdtempSync(join(tmpdir(), "auggy-accepted-main-"));
  const source = join(workspace, "source");
  for (const directory of [source, "home", "tmp", "npm-cache", "packs"].map((name) =>
    resolve(workspace, name),
  ))
    mkdirSync(directory);
  const env = acceptedBuildEnvironment(workspace);
  const commands: Record<string, unknown>[] = [];
  let cleanupUnknown = false;
  const command = async (label: string, argv: string[], cwd = source): Promise<string> => {
    const result = await runAcceptedBuildCommand({ command: argv, cwd, env });
    cleanupUnknown ||= result.cleanupUnknown;
    const { stdout, stderr, ...record } = result;
    const log = `${stdout}\n${stderr}`;
    writeFileSync(join(logs, `${label}.log`), log);
    commands.push({ label, command: argv[0], ...record, logSHA256: sha256(log) });
    check(result.status === "passed", `Accepted build command failed: ${label}`);
    return stdout.trim();
  };
  let complete: AcceptedMainArtifacts | undefined;
  let failure: string | undefined;
  try {
    const commit = await command(
      "revision",
      ["git", "rev-parse", `${ACCEPTED_MAIN.commit}^{commit}`],
      repositoryRoot,
    );
    const tree = await command(
      "tree",
      ["git", "rev-parse", `${ACCEPTED_MAIN.commit}^{tree}`],
      repositoryRoot,
    );
    check(
      commit === ACCEPTED_MAIN.commit && tree === ACCEPTED_MAIN.tree,
      "Accepted source identity mismatch",
    );
    const treeFiles = await command(
      "tree-files",
      ["git", "ls-tree", "-r", ACCEPTED_MAIN.commit],
      repositoryRoot,
    );
    check(
      treeFiles.split("\n").every((line) => /^100(?:644|755) blob [a-f0-9]{40}\t/.test(line)),
      "Accepted source contains unsupported entries",
    );
    const toolchain = {
      bun: await command("bun-version", [process.execPath, "--version"]),
      node: await command("node-version", ["node", "--version"]),
      npm: await command("npm-version", ["npm", "--version"]),
      platform: process.platform,
      architecture: process.arch,
    };
    check(toolchain.bun === ACCEPTED_MAIN.bun, "Accepted rebuild requires Bun 1.3.14");
    const archive = join(workspace, "source.tar");
    await command(
      "archive",
      ["git", "archive", "--format=tar", `--output=${archive}`, commit],
      repositoryRoot,
    );
    await command("extract-source", ["tar", "-xf", archive, "-C", source]);
    const archivedFiles = verifyAcceptedArchive(source, treeFiles);
    const lockSHA256 = fileHash(join(source, "bun.lock"));
    check(lockSHA256 === ACCEPTED_MAIN.lockSHA256, "Accepted lock identity mismatch");
    await command("frozen-install", [process.execPath, "install", "--frozen-lockfile"]);
    verifyAcceptedSourceFiles(source, archivedFiles);
    await command("build-admin", [process.execPath, "run", "build:admin"]);
    const pack = async (
      kind: "core" | "provider",
      root: string,
      packageName: string,
      certifiedSHA256: string,
    ): Promise<AcceptedArtifact> => {
      const filename = await command(
        `${kind}-pack`,
        ["npm", "pack", "--silent", "--pack-destination", join(workspace, "packs")],
        root,
      );
      check(/^[a-z0-9-]+-0\.5\.0\.tgz$/.test(filename), "Unexpected package output");
      const path = join(workspace, "packs", filename);
      const hash = fileHash(path);
      const names = await command(`${kind}-inventory`, ["tar", "-tzf", path]);
      const verbose = await command(`${kind}-entry-types`, ["tar", "-tvzf", path]);
      const files = validateAcceptedPackInventory(names, verbose);
      const extracted = join(workspace, `${kind}-extracted`);
      mkdirSync(extracted);
      await command(`${kind}-extract`, ["tar", "-xzf", path, "-C", extracted]);
      const sourceFiles: Record<string, string> = {};
      for (const file of files) {
        const archivedPath = kind === "core" ? file : `packages/anthropic/${file}`;
        check(
          Object.hasOwn(archivedFiles, archivedPath) ||
            (kind === "core" && file.startsWith("admin/dist/")),
          `Packed file is absent from accepted source: ${file}`,
        );
        const expected = sourceFileHash(root, file);
        check(
          sourceFileHash(join(extracted, "package"), file) === expected,
          `Packed source differs: ${file}`,
        );
        sourceFiles[file] = expected;
      }
      const manifest = JSON.parse(readFileSync(join(extracted, "package/package.json"), "utf8"));
      check(
        manifest.name === packageName && manifest.version === "0.5.0",
        "Unexpected accepted package identity",
      );
      check(files.includes("src/index.ts"), "Packed entry point missing");
      if (kind === "core")
        check(
          files.includes("admin/dist/index.html") &&
            files.some((file) => file.startsWith("admin/dist/assets/")),
          "Built console missing",
        );
      const destination = join(packs, filename);
      copyFileSync(path, destination);
      check(fileHash(destination) === hash, "Copied artifact hash mismatch");
      return {
        path: destination,
        sha256: hash,
        packageName,
        version: "0.5.0",
        certifiedSHA256,
        matchesCertifiedArtifact: hash === certifiedSHA256,
        equivalence:
          hash === certifiedSHA256
            ? "byte-identical-certified-artifact"
            : "source-verified-rebuild",
        sourceFiles,
      };
    };
    const core = await pack("core", source, "auggy", ACCEPTED_MAIN.coreSHA256);
    const provider = await pack(
      "provider",
      join(source, "packages/anthropic"),
      "@auggy/anthropic",
      ACCEPTED_MAIN.providerSHA256,
    );
    verifyAcceptedSourceFiles(source, archivedFiles);
    check(fileHash(import.meta.path) === helperSHA256, "Artifact helper changed during execution");
    complete = {
      status: "passed",
      core,
      provider,
      source: { commit, tree, lockSHA256, archiveSHA256: fileHash(archive) },
      toolchain,
      evidencePath,
    };
  } catch (error) {
    failure = redactEvidence(error instanceof Error ? error.message : "Accepted build failed", []);
  } finally {
    if (!failure && !cleanupUnknown) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        failure = "Accepted build workspace cleanup failed";
      }
    }
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          ...complete,
          status: failure || cleanupUnknown || !complete ? "failed" : "passed",
          expectedSource: ACCEPTED_MAIN,
          helperSHA256,
          commands,
          failure: failure ?? null,
          cleanupUnknown,
          retainedWorkspace: failure || cleanupUnknown || !complete ? workspace : null,
        },
        null,
        2,
      )}\n`,
    );
  }
  check(
    complete && !failure && !cleanupUnknown,
    `Accepted artifact build failed; see ${evidencePath}`,
  );
  return complete;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    check(
      (key === "--repo" || key === "--out") && value && !values[key],
      "Usage: accepted-main-artifacts.ts --repo <repository> --out <empty-output-directory>",
    );
    values[key] = value;
  }
  check(values["--repo"] && values["--out"], "Both --repo and --out are required");
  try {
    const result = await buildAcceptedMainArtifacts({
      repositoryRoot: values["--repo"],
      outputDirectory: values["--out"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Accepted artifact build failed"}\n`,
    );
    process.exitCode = 1;
  }
}

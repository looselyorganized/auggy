/** Shared bounded, no-follow source copier for Railway staging and portable export. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  realpathSync,
  readSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEPLOYMENT_LIMITS, type DeploymentFileDigest, type StageBundleOptions } from "./contracts";

export type { StageBundleOptions } from "./contracts";

export class BundleError extends Error {}

// Data-only names: importing runtime admission/state implementations here would
// compromise the passive exporter. Presence is enough; never parse private state.
const RUNTIME_CONTROL_MARKERS = [
  ".auggy-state-identity.json",
  ".auggy-restore-fence.json",
  ".auggy-runtime-singleton.lock",
  ".auggy-auth-replay-guard.json",
  ".auggy-auth-replay-guard.pending",
] as const;

function isRuntimeStateDirectory(path: string): boolean {
  return RUNTIME_CONTROL_MARKERS.some(
    (name) => lstatSync(join(path, name), { throwIfNoEntry: false }) !== undefined,
  );
}

const EXCLUDED_NAMES = new Set([
  ".env",
  ".git",
  ".ds_store",
  "node_modules",
  "workspace",
  "data",
  ".worktrees",
  ".claude",
  ".codex",
  ".auggy",
  ".auggy-cloud.json",
  ".npmrc",
  "agent-mail-reviews.json",
  "agent-mail-state.json",
  "admin-overrides.json",
]);

export function isExcludedBundleName(name: string): boolean {
  // macOS commonly aliases .ENV to .env. Treat known private names uniformly
  // on every host instead of exporting a different security boundary on Linux.
  name = name.toLowerCase();
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith(".auggy-") || name.endsWith(".auggy-state")) return true;
  if (name.startsWith(".env.") && name !== ".env.example") return true;
  if (
    [
      "agent-mail-reviews.json.",
      "agent-mail-state.json.",
      "admin-overrides.json.",
      ".auggy-cloud.json.",
    ].some((prefix) => name.startsWith(prefix))
  )
    return true;
  return (
    /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(name) ||
    name.endsWith(".tmp") ||
    name.includes(".tmp.")
  );
}

export function isContainedBundlePath(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function hasBundleControlCharacters(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 ||
      (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
  );
}

export function validateBundleRelativePath(path: string): void {
  if (
    !path ||
    Buffer.byteLength(path) > DEPLOYMENT_LIMITS.pathBytes ||
    path.includes("\\") ||
    hasBundleControlCharacters(path) ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.split("/").length > DEPLOYMENT_LIMITS.directoryDepth
  ) {
    throw new BundleError("Bundle path exceeds supported portable path/depth bounds.");
  }
}

function sameStat(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface SourceEntry {
  readonly absolute: string;
  readonly stat: Stats;
  readonly digest?: DeploymentFileDigest;
}

export interface StagedBundle {
  readonly directory: string;
  /** Bounded root-entry inventory includes excluded and symbolic entries. */
  readonly rootEntries: readonly string[];
  readonly directories: readonly string[];
  readonly files: readonly DeploymentFileDigest[];
  readonly sourceBytes: number;
  /** Rechecks copied bytes and directory identities, without executing source. */
  verifySource(): void;
}

/** Streams exact bounded source bytes, optionally into an exclusively created output file. */
function streamFile(src: string, expected: Stats, dst?: string): string {
  let source: number | undefined;
  let destination: number | undefined;
  try {
    source = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(source);
    if (!before.isFile() || !sameStat(before, expected))
      throw new BundleError("Bundle source changed during staging.");
    if (dst !== undefined)
      destination = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = before.size;
    while (remaining > 0) {
      const count = readSync(source, buffer, 0, Math.min(remaining, buffer.length), null);
      if (count === 0) throw new BundleError("Bundle source was truncated during staging.");
      remaining -= count;
      hash.update(buffer.subarray(0, count));
      if (destination !== undefined) {
        let offset = 0;
        while (offset < count) {
          const written = writeSync(destination, buffer, offset, count - offset);
          if (written === 0) throw new BundleError("Bundle destination stopped accepting data.");
          offset += written;
        }
      }
    }
    if (readSync(source, buffer, 0, 1, null) !== 0 || !sameStat(before, fstatSync(source)))
      throw new BundleError("Bundle source was modified during staging.");
    if (destination !== undefined) fchmodSync(destination, before.mode & 0o777);
    return hash.digest("hex");
  } finally {
    if (source !== undefined) closeSync(source);
    if (destination !== undefined) closeSync(destination);
  }
}

export function stageBundleWithManifest(
  options: StageBundleOptions,
  temporaryParent = tmpdir(),
): StagedBundle {
  const root = resolve(options.agentDir);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) throw new BundleError("Agent directory not found.");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new BundleError("Agent directory must be a real directory.");
  if (isRuntimeStateDirectory(root))
    throw new BundleError(
      "Selected source project is marked as a runtime state root; separate application source from durable state before exporting.",
    );
  const canonicalRoot = realpathSync.native(root);
  const exclusions = new Set<string>();
  for (const configured of options.excludedPaths ?? []) {
    const target = resolve(root, configured);
    if (target === root)
      throw new BundleError("A configured state path covers the entire source project.");
    if (isContainedBundlePath(root, target)) exclusions.add(target);
    try {
      const canonical = realpathSync.native(target);
      if (canonical === canonicalRoot)
        throw new BundleError("A configured state path covers the entire source project.");
      if (isContainedBundlePath(canonicalRoot, canonical)) exclusions.add(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const directory = mkdtempSync(join(temporaryParent, "auggy-deploy-"));
  const sources: SourceEntry[] = [];
  const rootEntries: string[] = [];
  const directories: string[] = [];
  const files: DeploymentFileDigest[] = [];
  let entries = 0;
  let sourceBytes = 0;
  const copy = (source: string, destination: string, expected: Stats): void => {
    // Same-user ancestor replacement is outside this owned-local-tree boundary;
    // static symlinks and regular-file identity changes are rejected.
    const current = lstatSync(source);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameStat(current, expected))
      throw new BundleError("Bundle directory changed during staging.");
    sources.push({ absolute: source, stat: current });
    if (source !== root) directories.push(relative(root, source).split(sep).join("/"));
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const handle = opendirSync(source);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > DEPLOYMENT_LIMITS.visitedEntries)
          throw new BundleError("Bundle exceeds the 10000 visited-entry limit.");
        if (source === root) rootEntries.push(entry.name);
        const src = join(source, entry.name);
        const path = relative(root, src).split(sep).join("/");
        validateBundleRelativePath(path);
        if (isExcludedBundleName(entry.name) || exclusions.has(src)) continue;
        const stat = lstatSync(src);
        if (stat.isSymbolicLink()) continue;
        if (exclusions.has(realpathSync.native(src))) continue;
        const dst = join(destination, entry.name);
        if (stat.isDirectory()) {
          // This excluded root was counted above; do not visit its private children.
          if (!isRuntimeStateDirectory(src)) copy(src, dst, stat);
        } else if (stat.isFile()) {
          if (!Number.isSafeInteger(stat.size) || stat.size > DEPLOYMENT_LIMITS.regularFileBytes)
            throw new BundleError("Bundle regular file exceeds the 256 MiB limit.");
          sourceBytes += stat.size;
          if (sourceBytes > DEPLOYMENT_LIMITS.stagedSourceBytes)
            throw new BundleError("Bundle exceeds the 1 GiB cumulative source limit.");
          const digest = {
            path,
            sha256: streamFile(src, stat, dst),
            bytes: stat.size,
            mode: stat.mode & 0o777,
          };
          files.push(digest);
          sources.push({ absolute: src, stat, digest });
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  try {
    copy(root, directory, rootStat);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      directory,
      rootEntries,
      directories,
      files,
      sourceBytes,
      verifySource() {
        for (const source of sources) {
          const stat = lstatSync(source.absolute);
          if (!sameStat(source.stat, stat))
            throw new BundleError(
              "Bundle source changed before publication; retry with a stable project.",
            );
          if (source.digest && streamFile(source.absolute, stat) !== source.digest.sha256)
            throw new BundleError("Bundle source bytes changed before publication.");
        }
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Existing synchronous Railway seam; the caller owns cleanup of the returned directory. */
export function stageBundle(options: StageBundleOptions): string {
  return stageBundleWithManifest(options).directory;
}

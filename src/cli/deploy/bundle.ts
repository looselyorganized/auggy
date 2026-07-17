/**
 * Bundle staging — copies an agent dir into a fresh temp directory minus the
 * exclusions defined by ADR-021 (`.env`, `workspace/`, `data/`, `*.db*`, `node_modules/`,
 * `.git/`, `.DS_Store`, `*.tmp`) plus local tooling metadata (`.worktrees/`,
 * `.claude/`, `.auggy/`).
 *
 * The deploy command runs `railway up` from the staging dir so volume-bound
 * state (SQLite files) and secrets (`.env`) never enter the Railway image.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface StageBundleOptions {
  agentDir: string;
  agentName: string;
  /** Config-derived state files whose names do not match generic exclusions. */
  excludedPaths?: readonly string[];
}

const EXCLUDED_NAMES = new Set([
  ".env",
  ".git",
  ".DS_Store",
  "node_modules",
  "workspace",
  "data",
  ".worktrees",
  ".claude",
  ".auggy",
  "agent-mail-reviews.json",
  "agent-mail-state.json",
  "admin-overrides.json",
]);

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith(".env.") && name !== ".env.example") return true;
  if (
    name.startsWith("agent-mail-reviews.json.") ||
    name.startsWith("agent-mail-state.json.") ||
    name.startsWith("admin-overrides.json.")
  ) {
    return true;
  }
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(name)) return true;
  if (name.endsWith(".tmp")) return true;
  if (name.includes(".tmp.")) return true;
  return false;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the copy failure that triggered cleanup.
  }
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function isConfiguredExcluded(path: string, excludedPaths: ReadonlySet<string>): boolean {
  if (excludedPaths.has(resolve(path))) return true;
  try {
    return excludedPaths.has(realpathSync.native(path));
  } catch {
    return false;
  }
}

function copyRegularFile(src: string, dst: string, expected: Stats): void {
  let srcFd: number | undefined;
  let dstFd: number | undefined;
  let ownsDestination = false;
  try {
    try {
      srcFd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return;
      throw error;
    }
    const stat = fstatSync(srcFd);
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error(`Bundle source changed during staging: ${src}`);
    }
    dstFd = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    ownsDestination = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = stat.size;
    while (remaining > 0) {
      const bytesRead = readSync(srcFd, buffer, 0, Math.min(buffer.byteLength, remaining), null);
      if (bytesRead === 0) throw new Error(`Bundle source was truncated during staging: ${src}`);
      remaining -= bytesRead;
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(dstFd, buffer, written, bytesRead - written);
        if (count === 0) throw new Error(`Bundle destination stopped accepting data: ${dst}`);
        written += count;
      }
    }
    const finalStat = fstatSync(srcFd);
    if (
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error(`Bundle source was modified during staging: ${src}`);
    }
    fchmodSync(dstFd, stat.mode & 0o777);
    closeSync(dstFd);
    dstFd = undefined;
  } finally {
    closeQuietly(srcFd);
    closeQuietly(dstFd);
    if (dstFd !== undefined && ownsDestination) {
      try {
        unlinkSync(dst);
      } catch {
        // Best effort: staging is discarded if the copy fails.
      }
    }
  }
}

function copyTree(
  src: string,
  dst: string,
  excludedPaths: ReadonlySet<string>,
  expected?: Stats,
): void {
  // The agent tree is owned by the invoking local operator. We reject static
  // symlinks and regular-file swaps, but Node does not expose openat(2), so an
  // attacker already able to mutate this same-user tree concurrently is
  // outside the deploy bundler's trust boundary.
  const current = lstatSync(src);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    (expected && (current.dev !== expected.dev || current.ino !== expected.ino))
  ) {
    throw new Error(`Bundle directory changed during staging: ${src}`);
  }
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcluded(entry)) continue;
    const srcPath = join(src, entry);
    if (isConfiguredExcluded(srcPath, excludedPaths)) continue;
    const dstPath = join(dst, entry);
    const stats = lstatSync(srcPath);
    if (stats.isDirectory()) {
      copyTree(srcPath, dstPath, excludedPaths, stats);
    } else if (stats.isFile()) {
      copyRegularFile(srcPath, dstPath, stats);
    }
    // Skip symlinks/sockets/etc — agent dirs shouldn't have them.
  }
}

/**
 * Copy the agent dir into a fresh temp staging dir, minus exclusions.
 * Returns the absolute path to the staging dir.
 */
export function stageBundle(opts: StageBundleOptions): string {
  const rootStat = lstatSync(opts.agentDir, { throwIfNoEntry: false });
  if (!rootStat) {
    throw new Error(`Agent directory not found: ${opts.agentDir}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Agent directory must be a real directory: ${opts.agentDir}`);
  }
  const root = resolve(opts.agentDir);
  const canonicalRoot = realpathSync.native(root);
  const excludedPaths = new Set<string>();
  for (const configuredPath of opts.excludedPaths ?? []) {
    const target = resolve(root, configuredPath);
    if (isContained(root, target)) {
      excludedPaths.add(target);
    }
    try {
      const canonicalTarget = realpathSync.native(target);
      if (isContained(canonicalRoot, canonicalTarget)) excludedPaths.add(canonicalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const staging = mkdtempSync(join(tmpdir(), `auggy-deploy-${opts.agentName}-`));
  try {
    copyTree(opts.agentDir, staging, excludedPaths, rootStat);
    return staging;
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Preserve the staging failure; the caller still receives the root cause.
    }
    throw error;
  }
}

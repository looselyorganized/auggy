import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  duplicateFd,
  listDirectoryFd,
  mkdirAt,
  openAbsoluteDirectoryNoFollow,
  openAt,
  readFileFdBounded,
  renameAt,
  tryOpenAt,
  unlinkAt,
} from "../../lib/posix-at";

export interface ManagedTextFile {
  path: string;
  content: string;
  contentBytes: number;
  modifiedIso: string;
}

export type ManagedFileError = { error: string };

interface ManagedParent {
  full: string;
  leaf: string;
  parentFd: number;
}

const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;
const DEFAULT_MAX_REMOVAL_NODES = 10_000;
const DEFAULT_MAX_REMOVAL_DEPTH = 64;
const managedRoots = new Map<string, { canonical: string; fd: number; retainCount: number }>();
let managedRootAcquisitionHook: ((canonicalPath: string) => void) | undefined;

/** @internal Deterministic acquisition hook for boundary regression tests. */
export function __setManagedRootAcquisitionHookForTest(
  hook: ((canonicalPath: string) => void) | undefined,
): void {
  managedRootAcquisitionHook = hook;
}

function fail(reason: string): ManagedFileError {
  return { error: `managed file rejected: ${reason}` };
}

export function supportsManagedFileIsolation(platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function managedRoot(
  agentDir: string | undefined,
): { canonical: string; fd: number; retainCount: number } | null {
  if (!agentDir || !supportsManagedFileIsolation()) return null;
  const key = resolve(agentDir);
  const cached = managedRoots.get(key);
  if (cached) return cached;
  let fd: number | null = null;
  try {
    fd = openSync(key, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    const canonical = realpathSync.native(key);
    const expected = fstatSync(fd);
    if (!expected.isDirectory()) return null;
    managedRootAcquisitionHook?.(canonical);
    const verificationFd = openAbsoluteDirectoryNoFollow(canonical);
    let opened: ReturnType<typeof fstatSync>;
    try {
      opened = fstatSync(verificationFd);
    } finally {
      closeSync(verificationFd);
    }
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      closeSync(fd);
      fd = null;
      return null;
    }
    const root = { canonical, fd, retainCount: 0 };
    managedRoots.set(key, root);
    fd = null;
    return root;
  } catch {
    if (fd !== null) closeSync(fd);
    return null;
  }
}

export function retainManagedRoot(agentDir: string | undefined): boolean {
  const root = managedRoot(agentDir);
  if (!root) return false;
  root.retainCount++;
  return true;
}

export function releaseManagedRoot(agentDir: string | undefined): void {
  if (!agentDir) return;
  const key = resolve(agentDir);
  const root = managedRoots.get(key);
  if (!root) return;
  if (root.retainCount > 1) {
    root.retainCount--;
    return;
  }
  managedRoots.delete(key);
  try {
    closeSync(root.fd);
  } catch {
    // Process teardown may already have invalidated descriptors.
  }
}

export function resolveManagedPath(
  agentDir: string | undefined,
  relativePath: string,
): string | null {
  if (!agentDir || !relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    return null;
  }

  const anchored = managedRoot(agentDir);
  if (!anchored) return null;
  const root = anchored.canonical;

  const full = resolve(root, relativePath);
  const fromRoot = relative(root, full);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return null;
  }
  return full;
}

function openManagedParent(
  agentDir: string | undefined,
  relativePath: string,
  createParents: boolean,
): ManagedParent {
  const full = resolveManagedPath(agentDir, relativePath);
  if (!full) throw new Error("path is outside the agent directory");
  const anchored = managedRoot(agentDir);
  if (!anchored) throw new Error("agent directory is unavailable");
  const root = anchored.canonical;
  const fromRoot = relative(root, full);
  const segments = fromRoot.split(sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("path contains an unsafe component");
  }

  let currentFd = duplicateFd(anchored.fd);
  try {
    for (const segment of segments.slice(0, -1)) {
      let child = tryOpenAt(currentFd, segment, DIRECTORY_FLAGS);
      if ("errno" in child) {
        if (!createParents) throw new Error("parent directory does not exist");
        mkdirAt(currentFd, segment, 0o700);
        child = tryOpenAt(currentFd, segment, DIRECTORY_FLAGS);
        if ("errno" in child) throw new Error("parent is not a safe directory");
      }
      if (!fstatSync(child.fd).isDirectory()) {
        closeSync(child.fd);
        throw new Error("parent is not a directory");
      }
      closeSync(currentFd);
      currentFd = child.fd;
    }
    return { full, leaf: segments.at(-1)!, parentFd: currentFd };
  } catch (error) {
    closeSync(currentFd);
    throw error;
  }
}

function closeManagedParent(parent: ManagedParent): void {
  closeSync(parent.parentFd);
}

function openManagedLeaf(parent: ManagedParent, flags: number, mode = 0): number {
  return openAt(parent.parentFd, parent.leaf, flags | constants.O_NOFOLLOW | O_CLOEXEC, mode);
}

export function ensureManagedDirectory(
  agentDir: string | undefined,
  relativePath: string,
): { path: string } | ManagedFileError {
  let parent: ManagedParent | undefined;
  let descriptor: number | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, true);
    mkdirAt(parent.parentFd, parent.leaf, 0o700);
    descriptor = openManagedLeaf(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    if (!fstatSync(descriptor).isDirectory()) {
      return fail("directory is not a real directory");
    }
    return { path: parent.full };
  } catch {
    return fail("directory contains a symlink or non-directory component");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent) closeManagedParent(parent);
  }
}

export function inspectManagedDirectory(
  agentDir: string | undefined,
  relativePath: string,
): { path: string; exists: boolean } | ManagedFileError {
  let parent: ManagedParent | undefined;
  let descriptor: number | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, false);
    const opened = tryOpenAt(
      parent.parentFd,
      parent.leaf,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC,
    );
    if ("errno" in opened) {
      if (opened.errno === 2) return { path: parent.full, exists: false };
      return fail("directory is a symlink or non-directory");
    }
    descriptor = opened.fd;
    if (!fstatSync(descriptor).isDirectory()) {
      return fail("directory is a symlink or non-directory");
    }
    return { path: parent.full, exists: true };
  } catch {
    return fail("directory contains a symlink or non-directory component");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent) closeManagedParent(parent);
  }
}

export function listManagedDirectoryNames(
  agentDir: string | undefined,
  relativePath: string,
): { path: string; names: string[] } | ManagedFileError | { path: string; missing: true } {
  let parent: ManagedParent | undefined;
  let descriptor: number | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, false);
    const opened = tryOpenAt(
      parent.parentFd,
      parent.leaf,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC,
    );
    if ("errno" in opened) {
      if (opened.errno === 2) return { path: parent.full, missing: true };
      return fail("directory is a symlink or non-directory");
    }
    descriptor = opened.fd;
    if (!fstatSync(descriptor).isDirectory()) {
      return fail("directory is a symlink or non-directory");
    }
    const listed = listDirectoryFd(descriptor, 10_000);
    if (listed.truncated) return fail("directory exceeds the 10000-entry management limit");
    return { path: parent.full, names: listed.names };
  } catch {
    return fail("directory contains a symlink or non-directory component");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent) closeManagedParent(parent);
  }
}

interface RemovalBudget {
  remainingNodes: number;
  maxDepth: number;
}

class RemovalLimitError extends Error {}

function removeEntryAt(parentFd: number, name: string, budget: RemovalBudget, depth: number): void {
  if (depth > budget.maxDepth || budget.remainingNodes < 1) {
    throw new RemovalLimitError("managed tree removal limit exceeded");
  }
  budget.remainingNodes -= 1;
  const opened = tryOpenAt(
    parentFd,
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
  );
  if ("errno" in opened) {
    if (opened.errno === 2) return;
    throw new Error("tree contains a symlink or unreadable entry");
  }
  const descriptor = opened.fd;
  const info = fstatSync(descriptor);
  try {
    if (info.isDirectory()) {
      // Inspect at most one more entry than the remaining whole-tree budget.
      // This makes the cap aggregate across the recursion rather than granting
      // every directory its own 10k-entry allowance.
      const listed = listDirectoryFd(
        descriptor,
        Math.min(DEFAULT_MAX_REMOVAL_NODES, budget.remainingNodes + 1),
      );
      if (listed.truncated || listed.names.length > budget.remainingNodes) {
        throw new RemovalLimitError("managed tree removal limit exceeded");
      }
      for (const child of listed.names) {
        removeEntryAt(descriptor, child, budget, depth + 1);
      }
    } else if (!info.isFile() || info.nlink !== 1) {
      throw new Error("tree contains a non-regular or multi-link file");
    }
  } finally {
    closeSync(descriptor);
  }
  if (!unlinkAt(parentFd, name, info.isDirectory())) {
    throw new Error("tree changed during removal");
  }
}

export function removeManagedTree(
  agentDir: string | undefined,
  relativePath: string,
  limits: { maxNodes?: number; maxDepth?: number } = {},
): { path: string; removed: boolean } | ManagedFileError {
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_REMOVAL_NODES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_REMOVAL_DEPTH;
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0
  ) {
    return fail("invalid removal limits");
  }
  let parent: ManagedParent | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, false);
    const existing = tryOpenAt(
      parent.parentFd,
      parent.leaf,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
    );
    if ("errno" in existing) {
      if (existing.errno === 2) return { path: parent.full, removed: false };
      return fail("tree contains a symlink or unreadable entry");
    }
    closeSync(existing.fd);
    removeEntryAt(parent.parentFd, parent.leaf, { remainingNodes: maxNodes, maxDepth }, 0);
    return { path: parent.full, removed: true };
  } catch (error) {
    if (error instanceof RemovalLimitError) {
      return fail("tree exceeds the safe removal node or depth limit");
    }
    return fail("tree contains a symlink, changed concurrently, or is unreadable");
  } finally {
    if (parent) closeManagedParent(parent);
  }
}

export function readManagedText(
  agentDir: string | undefined,
  relativePath: string,
  maxBytes: number,
): ManagedTextFile | ManagedFileError | { path: string; missing: true } {
  let parent: ManagedParent | undefined;
  let descriptor: number | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, false);
    const opened = tryOpenAt(
      parent.parentFd,
      parent.leaf,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
    );
    if ("errno" in opened) {
      if (opened.errno === 2) return { path: parent.full, missing: true };
      return fail("target is a symlink or is unreadable");
    }
    descriptor = opened.fd;
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      return fail("target is not a single-link regular file");
    }
    if (info.size > maxBytes) return fail("file exceeds the configured size limit");
    const bounded = readFileFdBounded(descriptor, maxBytes);
    if (bounded.exceeded) return fail("file exceeds the configured size limit");
    const content = bounded.buffer.toString("utf8");
    const contentBytes = bounded.buffer.byteLength;
    return {
      path: parent.full,
      content,
      contentBytes,
      modifiedIso: info.mtime.toISOString(),
    };
  } catch {
    return fail("path contains a symlink, changed concurrently, or is unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent) closeManagedParent(parent);
  }
}

export function writeManagedText(
  agentDir: string | undefined,
  relativePath: string,
  content: string,
  options: { maxBytes: number; mode?: number; createParents?: boolean },
): { path: string; contentBytes: number; modifiedIso: string } | ManagedFileError {
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > options.maxBytes) return fail("content exceeds the configured size limit");

  let parent: ManagedParent | undefined;
  let descriptor: number | undefined;
  let tempName: string | undefined;
  try {
    parent = openManagedParent(agentDir, relativePath, options.createParents === true);

    const existing = tryOpenAt(
      parent.parentFd,
      parent.leaf,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
    );
    if ("fd" in existing) {
      const target = fstatSync(existing.fd);
      closeSync(existing.fd);
      if (!target.isFile() || target.nlink !== 1) {
        return fail("target is not a single-link regular file");
      }
    } else if (existing.errno !== 2) {
      return fail("target is a symlink or unsafe file");
    }

    tempName = `.auggy-write-${process.pid}-${randomBytes(12).toString("hex")}`;
    descriptor = openAt(
      parent.parentFd,
      tempName,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        O_CLOEXEC,
      options.mode ?? 0o600,
    );
    fchmodSync(descriptor, options.mode ?? 0o600);
    writeFileSync(descriptor, content, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    if (!renameAt(parent.parentFd, tempName, parent.parentFd, parent.leaf)) {
      return fail("target changed during write");
    }
    tempName = undefined;
    fsyncSync(parent.parentFd);

    descriptor = openManagedLeaf(parent, constants.O_RDONLY | constants.O_NONBLOCK);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1) {
      return fail("written target is not a single-link regular file");
    }
    return {
      path: parent.full,
      contentBytes: written.size,
      modifiedIso: written.mtime.toISOString(),
    };
  } catch {
    return fail("path contains a symlink, changed concurrently, or is not writable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (tempName && parent) unlinkAt(parent.parentFd, tempName);
    if (parent) closeManagedParent(parent);
  }
}

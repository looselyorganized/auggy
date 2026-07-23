import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ManagedTextFile {
  path: string;
  content: string;
  contentBytes: number;
  modifiedIso: string;
}

export type ManagedFileError = { error: string };

function fail(reason: string): ManagedFileError {
  return { error: `managed file rejected: ${reason}` };
}

export function resolveManagedPath(
  agentDir: string | undefined,
  relativePath: string,
): string | null {
  if (!agentDir || !relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    return null;
  }

  let root: string;
  try {
    root = realpathSync.native(agentDir);
    if (!lstatSync(root).isDirectory()) return null;
  } catch {
    return null;
  }

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

function verifyDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("path component is not a real directory");
  }
  return info;
}

function verifyParents(root: string, full: string): void {
  const parentRel = relative(root, dirname(full));
  if (parentRel === "") return;
  let cursor = root;
  for (const part of parentRel.split(sep)) {
    cursor = resolve(cursor, part);
    verifyDirectory(cursor);
  }
}

export function ensureManagedDirectory(
  agentDir: string | undefined,
  relativePath: string,
): { path: string } | ManagedFileError {
  const full = resolveManagedPath(agentDir, relativePath);
  if (!full) return fail("path is outside the agent directory");
  const root = realpathSync.native(agentDir!);
  const rel = relative(root, full);
  let cursor = root;
  try {
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      try {
        verifyDirectory(cursor);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        mkdirSync(cursor, { mode: 0o700 });
        verifyDirectory(cursor);
      }
    }
    return { path: full };
  } catch {
    return fail("directory contains a symlink or non-directory component");
  }
}

export function inspectManagedDirectory(
  agentDir: string | undefined,
  relativePath: string,
): { path: string; exists: boolean } | ManagedFileError {
  const full = resolveManagedPath(agentDir, relativePath);
  if (!full) return fail("path is outside the agent directory");
  const root = realpathSync.native(agentDir!);
  try {
    verifyParents(root, resolve(full, "_leaf"));
    const info = lstatSync(full);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return fail("directory is a symlink or non-directory");
    }
    return { path: full, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: full, exists: false };
    }
    return fail("directory contains a symlink or non-directory component");
  }
}

export function readManagedText(
  agentDir: string | undefined,
  relativePath: string,
  maxBytes: number,
): ManagedTextFile | ManagedFileError | { path: string; missing: true } {
  const full = resolveManagedPath(agentDir, relativePath);
  if (!full) return fail("path is outside the agent directory");
  const root = realpathSync.native(agentDir!);

  let descriptor: number | undefined;
  try {
    verifyParents(root, full);
    let pathInfo: ReturnType<typeof lstatSync>;
    try {
      pathInfo = lstatSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: full, missing: true };
      }
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
      return fail("target is not a single-link regular file");
    }
    if (pathInfo.size > maxBytes) return fail("file exceeds the configured size limit");

    descriptor = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== pathInfo.dev ||
      opened.ino !== pathInfo.ino
    ) {
      return fail("target changed while it was being opened");
    }
    if (opened.size > maxBytes) return fail("file exceeds the configured size limit");
    const content = readFileSync(descriptor, "utf-8");
    const contentBytes = Buffer.byteLength(content, "utf-8");
    if (contentBytes > maxBytes) return fail("file exceeds the configured size limit");
    return {
      path: full,
      content,
      contentBytes,
      modifiedIso: opened.mtime.toISOString(),
    };
  } catch {
    return fail("path contains a symlink, changed concurrently, or is unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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

  const full = resolveManagedPath(agentDir, relativePath);
  if (!full) return fail("path is outside the agent directory");
  const root = realpathSync.native(agentDir!);
  const parent = dirname(full);
  const parentRel = relative(root, parent);
  if (options.createParents && parentRel) {
    const ensured = ensureManagedDirectory(agentDir, parentRel);
    if ("error" in ensured) return ensured;
  }

  let tempPath: string | undefined;
  let descriptor: number | undefined;
  try {
    verifyParents(root, full);
    const parentBefore = verifyDirectory(parent);
    let targetBefore: ReturnType<typeof lstatSync> | undefined;
    try {
      targetBefore = lstatSync(full);
      if (targetBefore.isSymbolicLink() || !targetBefore.isFile() || targetBefore.nlink !== 1) {
        return fail("target is not a single-link regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    tempPath = resolve(parent, `.auggy-write-${process.pid}-${randomBytes(12).toString("hex")}`);
    descriptor = openSync(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      options.mode ?? 0o600,
    );
    writeFileSync(descriptor, content, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    const parentAfter = verifyDirectory(parent);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      return fail("parent directory changed during write");
    }

    let targetAfter: ReturnType<typeof lstatSync> | undefined;
    try {
      targetAfter = lstatSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      (targetBefore === undefined) !== (targetAfter === undefined) ||
      (targetBefore &&
        targetAfter &&
        (targetAfter.isSymbolicLink() ||
          !targetAfter.isFile() ||
          targetAfter.nlink !== 1 ||
          targetBefore.dev !== targetAfter.dev ||
          targetBefore.ino !== targetAfter.ino))
    ) {
      return fail("target changed during write");
    }

    renameSync(tempPath, full);
    tempPath = undefined;
    let parentDescriptor: number | undefined;
    try {
      parentDescriptor = openSync(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fsyncSync(parentDescriptor);
    } finally {
      if (parentDescriptor !== undefined) closeSync(parentDescriptor);
    }
    const written = statSync(full);
    return {
      path: full,
      contentBytes: written.size,
      modifiedIso: written.mtime.toISOString(),
    };
  } catch {
    return fail("path contains a symlink, changed concurrently, or is not writable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup of a securely created temp file.
      }
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  mkdirAt,
  openAbsoluteDirectoryNoFollow,
  openAt,
  renameAt,
  tryOpenAt,
  unlinkAt,
} from "./posix-at";

const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
export const ANCHORED_DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;

export interface PinnedDirectory {
  canonical: string;
  fd: number;
}

function error(label: string, message: string, cause?: unknown): Error {
  return new Error(`${label}: ${message}`, cause ? { cause } : undefined);
}

function verifyDirectoryFd(fd: number, label: string): Stats {
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) throw error(label, "must be a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw error(label, "must be owned by the current user");
  }
  return stat;
}

/**
 * Pin an absolute configured directory to a descriptor. Existing configured
 * leaf symlinks are rejected; benign symlinks in an operator-selected parent
 * path are canonicalized once and then verified by inode. Missing descendants
 * can be created only beneath the pinned nearest existing ancestor.
 */
export function pinDirectory(
  configuredPath: string,
  label: string,
  options: { create?: boolean; mode?: number } = {},
): PinnedDirectory {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw error(label, "descriptor-relative isolation requires macOS or Linux");
  }
  const absolute = resolve(configuredPath);
  if (!isAbsolute(absolute)) throw error(label, "path must be absolute");
  const missing: string[] = [];
  let existing = absolute;
  while (true) {
    const stat = lstatSync(existing, { throwIfNoEntry: false });
    if (stat) {
      if (existing === absolute && stat.isSymbolicLink()) {
        throw error(label, "must not be a symlink");
      }
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw error(label, "nearest existing path must be a directory");
      }
      break;
    }
    if (!options.create) throw error(label, "does not exist");
    const parent = dirname(existing);
    if (parent === existing) throw error(label, "has no existing ancestor");
    missing.unshift(basename(existing));
    existing = parent;
  }

  let initialFd: number | undefined;
  let currentFd: number | undefined;
  try {
    initialFd = openSync(existing, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    const expected = verifyDirectoryFd(initialFd, label);
    const canonicalExisting = realpathSync.native(existing);
    currentFd = openAbsoluteDirectoryNoFollow(canonicalExisting);
    const verified = verifyDirectoryFd(currentFd, label);
    if (verified.dev !== expected.dev || verified.ino !== expected.ino) {
      throw error(label, "changed during descriptor acquisition");
    }
    closeSync(initialFd);
    initialFd = undefined;

    for (const segment of missing) {
      let child = tryOpenAt(currentFd, segment, ANCHORED_DIRECTORY_FLAGS);
      if ("errno" in child) {
        if (!mkdirAt(currentFd, segment, options.mode ?? 0o700)) {
          child = tryOpenAt(currentFd, segment, ANCHORED_DIRECTORY_FLAGS);
          if ("errno" in child) throw error(label, "could not safely create directory");
        } else {
          child = { fd: openAt(currentFd, segment, ANCHORED_DIRECTORY_FLAGS) };
        }
      }
      verifyDirectoryFd(child.fd, label);
      closeSync(currentFd);
      currentFd = child.fd;
    }

    const canonical = missing.reduce((path, segment) => join(path, segment), canonicalExisting);
    const result = { canonical, fd: currentFd };
    currentFd = undefined;
    return result;
  } catch (cause) {
    throw error(label, "could not pin directory", cause);
  } finally {
    if (initialFd !== undefined) closeSync(initialFd);
    if (currentFd !== undefined) closeSync(currentFd);
  }
}

export function openPinnedChildDirectory(
  parentFd: number,
  segment: string,
  label: string,
  create = false,
  normalizeMode = true,
): number {
  let opened = tryOpenAt(parentFd, segment, ANCHORED_DIRECTORY_FLAGS);
  if ("errno" in opened && create) {
    mkdirAt(parentFd, segment, 0o700);
    opened = tryOpenAt(parentFd, segment, ANCHORED_DIRECTORY_FLAGS);
  }
  if ("errno" in opened) throw error(label, "directory is missing or unsafe");
  try {
    const stat = verifyDirectoryFd(opened.fd, label);
    if (normalizeMode && (stat.mode & 0o777) !== 0o700) fchmodSync(opened.fd, 0o700);
    return opened.fd;
  } catch (cause) {
    closeSync(opened.fd);
    throw cause;
  }
}

export function inspectPinnedFile(
  parentFd: number,
  leaf: string,
  label: string,
): { fd: number; stat: Stats } | null {
  const opened = tryOpenAt(
    parentFd,
    leaf,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_CLOEXEC,
  );
  if ("errno" in opened) {
    if (opened.errno === 2) return null;
    throw error(label, "file is missing or unsafe");
  }
  try {
    const stat = fstatSync(opened.fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw error(label, "must be a single-link regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw error(label, "must be owned by the current user");
    }
    return { fd: opened.fd, stat };
  } catch (cause) {
    closeSync(opened.fd);
    throw cause;
  }
}

export function readPinnedFile(
  parentFd: number,
  leaf: string,
  label: string,
  maxBytes: number,
  normalizeMode = false,
): Buffer {
  const opened = inspectPinnedFile(parentFd, leaf, label);
  if (!opened) throw error(label, "does not exist");
  try {
    if (opened.stat.size > maxBytes) throw error(label, `exceeds ${maxBytes} bytes`);
    if (normalizeMode && (opened.stat.mode & 0o777) !== 0o600) fchmodSync(opened.fd, 0o600);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = readSync(opened.fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw error(label, `exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(opened.fd);
  }
}

function writeAll(fd: number, data: Uint8Array): void {
  let written = 0;
  while (written < data.byteLength) {
    const count = writeSync(fd, data, written, data.byteLength - written);
    if (count < 1) throw new Error("file stopped accepting data");
    written += count;
  }
}

/** Atomic owner-only replacement anchored to one already-pinned parent. */
export function replacePinnedFile(
  parentFd: number,
  leaf: string,
  value: string | Uint8Array,
  label: string,
  options: { beforeRename?: () => void } = {},
): void {
  const existing = inspectPinnedFile(parentFd, leaf, label);
  if (existing) closeSync(existing.fd);
  const temp = `.${randomUUID()}.tmp.${process.pid}`;
  let tempFd: number | undefined;
  let ownsTemp = false;
  try {
    tempFd = openAt(
      parentFd,
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_CLOEXEC,
      0o600,
    );
    ownsTemp = true;
    fchmodSync(tempFd, 0o600);
    writeAll(tempFd, typeof value === "string" ? Buffer.from(value, "utf8") : value);
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    options.beforeRename?.();
    if (!renameAt(parentFd, temp, parentFd, leaf)) throw error(label, "atomic rename failed");
    ownsTemp = false;
    fsyncSync(parentFd);
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
    if (ownsTemp) unlinkAt(parentFd, temp);
  }
}

/** Create one owner-only leaf without replacing a concurrent winner. */
export function createPinnedFile(
  parentFd: number,
  leaf: string,
  value: string | Uint8Array,
  label: string,
): boolean {
  const opened = tryOpenAt(
    parentFd,
    leaf,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_CLOEXEC,
    0o600,
  );
  if ("errno" in opened) {
    if (opened.errno === 17) return false;
    throw error(label, "could not create file safely");
  }
  try {
    fchmodSync(opened.fd, 0o600);
    writeAll(opened.fd, typeof value === "string" ? Buffer.from(value, "utf8") : value);
    fsyncSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
  fsyncSync(parentFd);
  return true;
}

/** Owner-only append anchored to one pinned parent. */
export function appendPinnedFile(
  parentFd: number,
  leaf: string,
  value: string | Uint8Array,
  label: string,
): void {
  const fd = openAt(
    parentFd,
    leaf,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | O_CLOEXEC,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw error(label, "must be a regular file");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw error(label, "must be owned by the current user");
    }
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    writeAll(fd, typeof value === "string" ? Buffer.from(value, "utf8") : value);
    fsyncSync(fd);
    fsyncSync(parentFd);
  } finally {
    closeSync(fd);
  }
}

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the operation failure that triggered cleanup.
  }
}

function contextualError(label: string, action: string, error: unknown): Error {
  return new Error(`${label}: failed to ${action}: ${(error as Error).message}`, { cause: error });
}

/** Read and parse a bounded regular JSON file through one no-follow descriptor. */
export function readDurableJson(
  path: string,
  label: string,
  maxBytes = DEFAULT_MAX_BYTES,
): unknown | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`${label}: maxBytes must be a positive safe integer`);
  }

  const parent = dirname(path);
  try {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`${parent} must be a real directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw contextualError(label, `inspect parent directory ${parent}`, error);
  }

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw contextualError(label, `open ${path}`, error);
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} must be a regular file`);
    if (stat.size > maxBytes) {
      throw new Error(`${path} exceeds the ${maxBytes}-byte limit`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${path} exceeds the ${maxBytes}-byte limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch (error) {
    throw contextualError(label, `read ${path}`, error);
  } finally {
    closeQuietly(fd);
  }
}

/** Atomically replace a JSON file and durably commit the rename to its parent. */
export function writeDurableJson(path: string, value: unknown, label: string): void {
  let serialized: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON serializable");
    serialized = encoded;
  } catch (error) {
    throw contextualError(label, `serialize ${path}`, error);
  }

  const parent = dirname(path);
  let createdParent = false;
  try {
    createdParent = mkdirSync(parent, { recursive: true, mode: 0o700 }) !== undefined;
  } catch (error) {
    throw contextualError(label, `create parent directory ${parent}`, error);
  }

  let directoryFd: number | undefined;
  let tempFd: number | undefined;
  let ownsTemp = false;
  const tempPath = join(parent, `.${randomUUID()}.tmp.${process.pid}`);

  try {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`${parent} must be a real directory`);
    }
    if (createdParent) {
      const grandparent = dirname(parent);
      const grandparentFd = openSync(
        grandparent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(grandparentFd);
      } finally {
        closeSync(grandparentFd);
      }
    }
    directoryFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!fstatSync(directoryFd).isDirectory()) {
      throw new Error(`${parent} must be a real directory`);
    }

    tempFd = openSync(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    ownsTemp = true;
    writeFileSync(tempFd, serialized, "utf8");
    fchmodSync(tempFd, 0o600);
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;

    renameSync(tempPath, path);
    ownsTemp = false;
    fsyncSync(directoryFd);
  } catch (error) {
    closeQuietly(tempFd);
    if (ownsTemp) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the write failure; cleanup is best effort on a failing store.
      }
    }
    throw contextualError(label, `write ${path}`, error);
  } finally {
    closeQuietly(directoryFd);
  }
}

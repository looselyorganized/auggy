import { constants as bufferConstants } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

function changed(): never {
  throw Object.assign(new Error("Bounded file changed while reading"), {
    code: "ERR_BOUNDED_FILE_CHANGED",
  });
}

/**
 * Read one stable regular-file descriptor, never following its final symlink.
 * Callers own parent-directory containment and keep those directories private.
 * A detected concurrent modification fails instead of returning mixed evidence.
 */
export function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): { bytes: Buffer; mode: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > bufferConstants.MAX_LENGTH)
    throw new Error("Invalid bounded file size limit");
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number")
    throw new Error("Bounded file reads require no-follow, nonblocking open support");

  let fd: number;
  try {
    // NONBLOCK prevents a substituted FIFO from hanging before fstat can reject it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("Bounded file must not follow symbolic links (symlinks)", { cause: error });
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("Expected a bounded regular file");
    if (before.size < 0n || before.size > BigInt(maxBytes))
      throw new Error("File exceeds its bounded size limit");

    const length = Number(before.size);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(
        fd,
        bytes,
        offset,
        Math.min(READ_CHUNK_BYTES, length - offset),
        offset,
      );
      if (count === 0) changed();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, length) !== 0) changed();
    const after = fstatSync(fd, { bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      changed();
    return { bytes, mode: Number(before.mode) };
  } finally {
    closeSync(fd);
  }
}

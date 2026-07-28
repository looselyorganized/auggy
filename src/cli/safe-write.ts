import { closeSync, constants, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

interface SafeWriteOptions {
  mode?: number;
}

function writeAllSync(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("safe write made no forward progress");
    offset += written;
  }
}

export function writeFileSafely(
  path: string,
  data: string | Uint8Array,
  opts: SafeWriteOptions = {},
): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;

  try {
    fd = openSync(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      opts.mode ?? 0o666,
    );
    writeAllSync(fd, data);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function writeFileExclusively(
  path: string,
  data: string | Uint8Array,
  opts: SafeWriteOptions = {},
): void {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      opts.mode ?? 0o666,
    );
    writeAllSync(fd, data);
    closeSync(fd);
    fd = null;
  } catch (err) {
    if (fd !== null) closeSync(fd);
    throw err;
  }
}

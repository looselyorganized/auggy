/** Bounded, passive file reads. Snapshot bytes are private and may contain secrets. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";
import {
  AUTHORING_LIMITS,
  type FileIdentity,
  type FileSnapshot,
  type SafeDiagnostic,
} from "./contracts";

/** Only controlled messages belong here; never attach a parser or filesystem cause. */
export class AuthoringError extends Error {
  readonly code: string;
  readonly diagnostic: SafeDiagnostic;

  constructor(code: string, message: string, location?: { path?: string; field?: string }) {
    super(message);
    this.name = "AuthoringError";
    this.code = code;
    this.diagnostic = Object.freeze({
      code,
      message,
      ...(location?.path && safeLocation(location.path) ? { path: location.path } : {}),
      ...(location?.field && safeLocation(location.field) ? { field: location.field } : {}),
    });
  }
}

function safeLocation(value: string): boolean {
  return (
    Buffer.byteLength(value) <= AUTHORING_LIMITS.pathBytes &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function snapshotHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: Number(stats.size),
    mode: Number(stats.mode),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function readFileSnapshot(
  path: string,
  maxBytes: number,
  options: { readonly allowMissing?: boolean } = {},
): FileSnapshot {
  const absolutePath = resolve(path);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > AUTHORING_LIMITS.aggregateOutputBytes
  ) {
    throw new AuthoringError("invalid-read-limit", "Use a finite supported file-read limit.");
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && options.allowMissing) return { path: absolutePath, exists: false };
    throw new AuthoringError(
      code === "ENOENT" ? "missing-file" : code === "ELOOP" ? "unsafe-file" : "unreadable-file",
      code === "ENOENT"
        ? "Required file is missing; restore it before retrying."
        : "Cannot read a safe regular file; review its path and permissions.",
      { path: absolutePath },
    );
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new AuthoringError(
        "unsafe-file",
        "Expected a regular file; devices, directories and pipes are unsupported.",
        { path: absolutePath },
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw new AuthoringError(
        "file-too-large",
        "File exceeds the supported byte limit; reduce it before retrying.",
        { path: absolutePath },
      );
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    const hasExtra = readSync(descriptor, extra, 0, 1, offset) !== 0;
    const identity = fileIdentity(before);
    if (
      offset !== bytes.length ||
      hasExtra ||
      !sameFileIdentity(identity, fileIdentity(fstatSync(descriptor, { bigint: true })))
    ) {
      throw new AuthoringError(
        "changed-input",
        "File changed while being read; retry with a stable input.",
        { path: absolutePath },
      );
    }
    return { path: absolutePath, exists: true, identity, sha256: snapshotHash(bytes), bytes };
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    throw new AuthoringError(
      "unreadable-file",
      "Cannot read a stable regular file; review its path and permissions.",
      { path: absolutePath },
    );
  } finally {
    closeSync(descriptor);
  }
}

export function decodeSnapshotText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthoringError(
      "invalid-utf8",
      "File must contain valid UTF-8; review its encoding before retrying.",
    );
  }
}

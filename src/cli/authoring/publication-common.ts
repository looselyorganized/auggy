import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AUTHORING_LIMITS, type FileSnapshot, type ReceiptFileVersion } from "./contracts";
import { AuthoringError, readFileSnapshot, sameFileIdentity } from "./document-io";

export const IGNORE_SUFFIX = "\n# Auggy private authoring receipts\n.auggy/\n";
export const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const PRIVATE_FILE = /^(?:stage|backup)-\d{1,3}\.bin$/;

export function fail(code: string, message: string): never {
  throw new AuthoringError(code, message);
}

export function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safeRelative(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    Buffer.byteLength(path) > AUTHORING_LIMITS.pathBytes ||
    isAbsolute(path) ||
    path.includes(":") ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("publication-path", "Authoring requires a normalized contained file path.");
  return path;
}

export function canonicalProject(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return canonical;
  } catch {
    return fail("publication-project", "The project directory cannot be verified safely.");
  }
}

export function assertPrivate(
  path: string,
  directory: boolean,
  allowedModes: readonly number[] = [0o600],
): void {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      !(directory ? [0o700] : allowedModes).includes(stat.mode & 0o777) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (!directory && stat.nlink !== 1)
    )
      throw new Error();
  } catch {
    fail(
      "receipt-private",
      "Authoring recovery requires private, owned regular receipt files and directories.",
    );
  }
}

/** Passive enumeration is bounded before allocating an unbounded directory listing. */
export function listBounded(path: string): string[] {
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= AUTHORING_LIMITS.receiptEntries)
        fail("receipt-limit", "The authoring receipt directory exceeds its entry limit.");
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

/** Passive recovery checks every ancestor; it never loads native mutation/lock code. */
export function containedSnapshot(
  project: string,
  path: string,
  maxBytes: number = AUTHORING_LIMITS.outputBytes,
): FileSnapshot {
  safeRelative(path);
  const segments = path.split("/");
  let parent = project;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail("publication-parent", "A destination parent is not an ordinary contained directory.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: join(project, path), exists: false };
      throw error;
    }
  }
  return readFileSnapshot(join(project, path), maxBytes, { allowMissing: true });
}

export function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.path === right.path &&
    left.exists === right.exists &&
    (!left.exists ||
      (right.exists &&
        left.sha256 === right.sha256 &&
        sameFileIdentity(left.identity, right.identity)))
  );
}

export function assertSnapshot(expected: FileSnapshot): void {
  const actual = readFileSnapshot(expected.path, AUTHORING_LIMITS.aggregateInputBytes, {
    allowMissing: true,
  });
  if (!sameSnapshot(expected, actual))
    fail("publication-stale", "An authoring input changed; recompute the plan before retrying.");
}

export function version(bytes: Uint8Array, mode: number): ReceiptFileVersion {
  return { sha256: hash(bytes), size: bytes.byteLength, mode: mode & 0o777 };
}

export function matches(snapshot: FileSnapshot, expected: ReceiptFileVersion | null): boolean {
  return expected === null
    ? !snapshot.exists
    : snapshot.exists &&
        snapshot.sha256 === expected.sha256 &&
        snapshot.bytes.byteLength === expected.size &&
        (snapshot.identity.mode & 0o777) === expected.mode;
}

export function projectRelative(project: string, path: string): string {
  if (!isAbsolute(path))
    fail("publication-path", "Authoring input snapshots require absolute paths.");
  return safeRelative(relative(project, path));
}

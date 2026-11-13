/** Descriptor-relative mutation helpers, loaded only by apply operations. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  listDirectoryFd,
  mkdirAt,
  openAbsoluteDirectoryNoFollow,
  openAt,
  readFileFdBounded,
  renameAt,
  renameAtNoReplace,
  tryOpenAt,
  unlinkAt,
} from "../../lib/posix-at";
import {
  AUTHORING_LIMITS,
  type FileSnapshot,
  type OperationReceipt,
  type ProjectMutationLease,
} from "./contracts";
import { fileIdentity, sameFileIdentity } from "./document-io";
import { assertPrivate, fail, hash, sameSnapshot, safeRelative } from "./publication-common";
import {
  DIRECTORY_FLAGS,
  FILE_FLAGS,
  type LeaseState,
  validateProjectLease,
} from "./publication-lease";

export interface WriteContext {
  readonly lease: ProjectMutationLease;
  readonly state: LeaseState;
  readonly parents: Map<string, string | null>;
}
export function writeContext(lease: ProjectMutationLease, projectDir: string): WriteContext {
  return { lease, state: validateProjectLease(lease, projectDir), parents: new Map() };
}
function directoryIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory())
    fail("publication-parent", "A destination parent is not an ordinary directory.");
  return `${stat.dev}:${stat.ino}`;
}
function caseCheck(fd: number, name: string): void {
  const listing = listDirectoryFd(fd, AUTHORING_LIMITS.receiptEntries);
  if (listing.truncated)
    fail(
      "publication-directory-limit",
      "A destination directory exceeds the safe authoring enumeration limit.",
    );
  const folded = name.normalize("NFC").toLowerCase();
  if (
    listing.names.some((entry) => entry !== name && entry.normalize("NFC").toLowerCase() === folded)
  )
    fail(
      "publication-case",
      "A case-colliding destination already exists; choose an unambiguous path.",
    );
}

/** Returns a separately owned parent descriptor, never the lease's descriptor. */
export function openParent(
  context: WriteContext,
  relativePath: string,
  create: boolean,
): { fd: number; name: string } | undefined {
  safeRelative(relativePath);
  validateProjectLease(context.lease, context.state.projectDir);
  const segments = relativePath.split("/");
  let fd = openAbsoluteDirectoryNoFollow(context.state.projectDir);
  let owned = true;
  let prefix = "";
  try {
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index]!;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      caseCheck(fd, segment);
      let opened = tryOpenAt(fd, segment, DIRECTORY_FLAGS);
      if ("errno" in opened && opened.errno === 2) {
        if (context.parents.has(prefix) && context.parents.get(prefix) !== null)
          fail("publication-parent", "A destination parent disappeared after planning.");
        context.parents.set(prefix, null);
        if (!create) return undefined;
        if (!mkdirAt(fd, segment, 0o755))
          fail(
            "publication-parent",
            "A destination directory was concurrently created or cannot be created safely.",
          );
        opened = tryOpenAt(fd, segment, DIRECTORY_FLAGS);
        context.parents.delete(prefix);
      }
      if (!("fd" in opened))
        fail(
          "publication-parent",
          "A destination parent cannot be opened without following links.",
        );
      const child = opened.fd;
      const identity = directoryIdentity(child);
      const expected = context.parents.get(prefix);
      if (context.parents.has(prefix) && expected !== identity) {
        closeSync(child);
        fail("publication-parent", "A destination parent identity changed after planning.");
      }
      context.parents.set(prefix, identity);
      if (owned) closeSync(fd);
      fd = child;
      owned = true;
    }
    const name = segments.at(-1)!;
    caseCheck(fd, name);
    const result = { fd, name };
    owned = false;
    return result;
  } finally {
    if (owned) closeSync(fd);
  }
}

export function snapshotAt(
  parentFd: number,
  name: string,
  path: string,
  maxBytes: number = AUTHORING_LIMITS.outputBytes,
): FileSnapshot {
  const opened = tryOpenAt(parentFd, name, constants.O_RDONLY | FILE_FLAGS);
  if ("errno" in opened) {
    if (opened.errno === 2) return { path, exists: false };
    return fail("publication-file", "A destination cannot be read safely without following links.");
  }
  try {
    const before = fstatSync(opened.fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes))
      fail("publication-file", "Authoring destinations must be bounded, unlinked regular files.");
    const result = readFileFdBounded(opened.fd, maxBytes);
    const after = fstatSync(opened.fd, { bigint: true });
    if (result.exceeded || !sameFileIdentity(fileIdentity(before), fileIdentity(after)))
      fail("publication-stale", "A destination changed while being checked.");
    return {
      path,
      exists: true,
      identity: fileIdentity(after),
      sha256: hash(result.buffer),
      bytes: result.buffer,
    };
  } finally {
    closeSync(opened.fd);
  }
}

export function checkedDestination(
  context: WriteContext,
  relativePath: string,
  expected: FileSnapshot,
  createParents: boolean,
): { fd: number; name: string } | undefined {
  const parent = openParent(context, relativePath, createParents);
  const current = parent
    ? snapshotAt(parent.fd, parent.name, join(context.state.projectDir, relativePath))
    : ({ path: join(context.state.projectDir, relativePath), exists: false } as const);
  if (!sameSnapshot(current, expected)) {
    if (parent) closeSync(parent.fd);
    fail(
      "publication-stale",
      "A destination changed; recompute the authoring plan before retrying.",
    );
  }
  return parent;
}

export function flushDirectory(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
}
function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) fail("publication-write", "An authoring file could not be written completely.");
    offset += count;
  }
  fsyncSync(fd);
}
export function writePrivate(fd: number, name: string, bytes: Uint8Array): void {
  const file = openAt(
    fd,
    name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE_FLAGS,
    0o600,
  );
  try {
    fchmodSync(file, 0o600);
    writeAll(file, bytes);
  } finally {
    closeSync(file);
  }
  flushDirectory(fd);
}

export function operationDirectory(context: WriteContext, id: string, create: boolean): number {
  if (create) mkdirAt(context.state.privateFd, "operations", 0o700);
  const operations = openAt(context.state.privateFd, "operations", DIRECTORY_FLAGS);
  try {
    assertPrivate(join(context.state.projectDir, ".auggy", "operations"), true);
    if (create && !mkdirAt(operations, id, 0o700))
      fail("receipt-create", "The operation receipt directory could not be created exclusively.");
    const operation = openAt(operations, id, DIRECTORY_FLAGS);
    try {
      assertPrivate(join(context.state.projectDir, ".auggy", "operations", id), true);
    } catch (error) {
      closeSync(operation);
      throw error;
    }
    flushDirectory(operations);
    return operation;
  } finally {
    closeSync(operations);
  }
}

export function persistReceipt(operationFd: number, receipt: OperationReceipt): void {
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  if (bytes.byteLength > AUTHORING_LIMITS.receiptBytes)
    fail("receipt-limit", "The operation receipt exceeds the safe byte limit.");
  const stale = tryOpenAt(operationFd, "receipt.next", constants.O_RDONLY | FILE_FLAGS);
  if ("fd" in stale) {
    const stat = fstatSync(stale.fd);
    closeSync(stale.fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail("receipt-private", "A private journal staging file is unsafe.");
    if (!unlinkAt(operationFd, "receipt.next"))
      fail("receipt-write", "The private journal could not be updated safely.");
  } else if (stale.errno !== 2)
    fail("receipt-write", "The private journal could not be inspected safely.");
  writePrivate(operationFd, "receipt.next", bytes);
  if (!renameAt(operationFd, "receipt.next", operationFd, "receipt.json"))
    fail("receipt-write", "The private journal could not be committed.");
  flushDirectory(operationFd);
}

/** Publish complete bytes and final mode atomically; absent destinations use no-replace rename. */
export function publishStage(
  context: WriteContext,
  operationFd: number,
  stageName: string,
  relativePath: string,
  expected: FileSnapshot,
  bytes: Uint8Array,
  mode: number,
): FileSnapshot {
  const parent = checkedDestination(context, relativePath, expected, true)!;
  try {
    const stage = openAt(operationFd, stageName, constants.O_RDWR | FILE_FLAGS);
    try {
      const stat = fstatSync(stage);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        ![0o600, mode].includes(stat.mode & 0o777) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        fail("publication-stage", "The private staging file cannot be verified.");
      const read = readFileFdBounded(stage, AUTHORING_LIMITS.outputBytes);
      if (read.exceeded || hash(read.buffer) !== hash(bytes))
        fail("publication-stage", "The private staging file changed.");
      // The owned 0700 operation directory protects this brief final-mode staging window.
      fchmodSync(stage, mode);
      fsyncSync(stage);
      const published = expected.exists
        ? renameAt(operationFd, stageName, parent.fd, parent.name)
        : renameAtNoReplace(operationFd, stageName, parent.fd, parent.name);
      if (!published)
        fail(
          "publication-write",
          "The authoring file could not be published atomically without replacing an unexpected destination.",
        );
    } finally {
      closeSync(stage);
    }
    flushDirectory(parent.fd);
    flushDirectory(operationFd);
    return snapshotAt(parent.fd, parent.name, join(context.state.projectDir, relativePath));
  } finally {
    closeSync(parent.fd);
  }
}

export function appendIgnore(
  context: WriteContext,
  expected: FileSnapshot,
  suffix: Uint8Array,
): FileSnapshot {
  const parent = checkedDestination(context, ".gitignore", expected, false)!;
  try {
    const flags =
      constants.O_WRONLY |
      FILE_FLAGS |
      (expected.exists ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL);
    const fd = openAt(parent.fd, parent.name, flags, 0o644);
    try {
      if (
        expected.exists &&
        !sameFileIdentity(fileIdentity(fstatSync(fd, { bigint: true })), expected.identity)
      )
        fail("publication-stale", "The ignore file changed before protection could be appended.");
      if (!expected.exists) fchmodSync(fd, 0o644);
      writeAll(fd, suffix);
    } finally {
      closeSync(fd);
    }
    flushDirectory(parent.fd);
    return snapshotAt(parent.fd, parent.name, join(context.state.projectDir, ".gitignore"));
  } finally {
    closeSync(parent.fd);
  }
}

export function removeOwned(
  context: WriteContext,
  relativePath: string,
  expected: FileSnapshot,
): void {
  const parent = checkedDestination(context, relativePath, expected, false);
  if (!parent || !expected.exists)
    fail("rollback-conflict", "The owned output cannot be verified for removal.");
  try {
    if (!unlinkAt(parent.fd, parent.name))
      fail("rollback-remove", "The verified owned output could not be removed.");
    flushDirectory(parent.fd);
  } finally {
    closeSync(parent.fd);
  }
}

/** Revalidate the anchored private directory before copying any potentially sensitive bytes. */
export function verifyOperationDirectory(
  context: WriteContext,
  id: string,
  operationFd: number,
): void {
  validateProjectLease(context.lease, context.state.projectDir);
  const current = operationDirectory(context, id, false);
  try {
    if (directoryIdentity(current) !== directoryIdentity(operationFd))
      fail(
        "receipt-identity",
        "The private operation directory identity changed; preserve it for manual review.",
      );
  } finally {
    closeSync(current);
  }
}

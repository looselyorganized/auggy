import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import {
  ANCHORED_DIRECTORY_FLAGS,
  createPinnedFile,
  inspectPinnedFile,
  openPinnedChildDirectory,
  pinDirectory,
  readPinnedFile,
  replacePinnedFile,
  type PinnedDirectory,
} from "../lib/anchored-files";
import {
  duplicateFd,
  listDirectoryFd,
  mkdirAt,
  openAt,
  renameAt,
  tryOpenAt,
  unlinkAt,
} from "../lib/posix-at";
import type { RuntimeStateInventory } from "./runtime-state-inventory";
import { RUNTIME_STATE_SQLITE_IDENTITIES } from "./runtime-state-sqlite-identities";

export const RUNTIME_STATE_BUNDLE_FORMAT_VERSION = 1;
export const RUNTIME_STATE_RESTORE_FENCE = ".auggy-restore-fence.json";
export const RUNTIME_STATE_IDENTITY_FILE = ".auggy-state-identity.json";
const BUNDLE_KIND = "auggy-runtime-state-bundle";
const MANIFEST_FILE = "manifest.json";
const PAYLOAD_DIRECTORY = "payload";
const MAX_FILES = 100_000;
const MAX_PATH_BYTES = 1_024;
const MAX_DEPTH = 64;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_SQLITE_INSPECTION_BYTES = 256 * 1024 * 1024;
const AUG1_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SqliteMetadataSchema = z
  .object({
    applicationId: z.number().int().nonnegative(),
    userVersion: z.number().int().nonnegative(),
    quickCheck: z.enum(["ok", "deferred"]),
    journalArtifacts: z.array(z.string().min(1).max(MAX_PATH_BYTES)).max(3).optional(),
  })
  .strict();

const BundleFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_BYTES),
    bytes: z.number().int().nonnegative().max(DEFAULT_MAX_FILE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mode: z.literal("0600"),
    sqlite: SqliteMetadataSchema.optional(),
  })
  .strict();

const BundleDirectorySchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_BYTES),
    mode: z.literal("0700"),
  })
  .strict();

const InventoryStoreSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    namespace: z.string().min(1),
    kind: z.enum(["sqlite", "json", "file", "directory", "external", "memory"]),
    backupPlane: z.enum(["runtime-volume", "project-source", "external", "volatile", "disabled"]),
    relativePath: z.string().min(1).optional(),
    schema: z.string().min(1).optional(),
    retention: z.string().min(1),
    restoreOrder: z.number().int().nonnegative(),
    replayCritical: z.boolean(),
    required: z.boolean(),
  })
  .strict();

const RuntimeStateInventorySchema = z
  .object({
    version: z.literal(1),
    agent: z.object({ id: z.string().regex(AUG1_ID_RE), name: z.string().min(1) }).strict(),
    configShapeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    stores: z.array(InventoryStoreSchema).max(10_000),
    externalPrerequisites: z
      .array(
        z
          .object({
            id: z.string().min(1),
            owner: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

const RuntimeStateBundleManifestSchema = z
  .object({
    kind: z.literal(BUNDLE_KIND),
    formatVersion: z.literal(RUNTIME_STATE_BUNDLE_FORMAT_VERSION),
    createdAt: z.string().datetime(),
    runtimeVersion: z.string().min(1),
    consistency: z
      .object({
        mode: z.literal("offline-operator-asserted"),
        singleReplica: z.literal(true),
      })
      .strict(),
    inventory: RuntimeStateInventorySchema,
    directories: z.array(BundleDirectorySchema).max(MAX_FILES),
    files: z.array(BundleFileSchema).max(MAX_FILES),
  })
  .strict();

const RuntimeStateRestoreFenceSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["copying", "requires-reconciliation"]),
    restoreId: z.string().uuid(),
    bundleManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    restoredAt: z.string().datetime(),
  })
  .strict();

const RuntimeStateIdentitySchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().regex(AUG1_ID_RE),
  })
  .strict();

export type RuntimeStateBundleManifest = z.infer<typeof RuntimeStateBundleManifestSchema>;
export type RuntimeStateRestoreFence = z.infer<typeof RuntimeStateRestoreFenceSchema>;

export interface CreateRuntimeStateBundleOptions {
  sourceRoot: string;
  bundlePath: string;
  inventory: RuntimeStateInventory;
  /** Required acknowledgement: callers must have stopped and drained the only replica. */
  confirmStopped: boolean;
  now?: () => Date;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** @internal Deterministic root-replacement barrier for regression tests. */
  __testHooks?: { afterRootsPinned?: () => void };
}

export interface RestoreRuntimeStateBundleOptions {
  bundlePath: string;
  destinationRoot: string;
  /** Required acknowledgement: callers must have stopped and drained the only replica. */
  confirmStopped: boolean;
  now?: () => Date;
  restoreId?: () => string;
  expectedInventory: RuntimeStateInventory;
  /** @internal Deterministic copy failure/root-replacement barriers for tests. */
  __testHooks?: { afterRootsPinned?: () => void; beforeCopy?: (path: string) => void };
}

export interface ResumeRuntimeStateRestoreOptions {
  bundlePath: string;
  destinationRoot: string;
  expectedInventory: RuntimeStateInventory;
  restoreId: string;
  confirmStopped: boolean;
  __testHooks?: { beforeCopy?: (path: string) => void };
}

function contextualError(message: string, error?: unknown): Error {
  return new Error(`[runtime-state] ${message}${error ? `: ${(error as Error).message}` : ""}`, {
    cause: error,
  });
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the operation failure that triggered cleanup.
  }
}

function assertSafeRelativePath(path: string): void {
  if (path.includes("\\") || path.includes("\0") || Buffer.byteLength(path) > MAX_PATH_BYTES) {
    throw contextualError("bundle contains an unsafe path");
  }
  const components = path.split("/");
  if (
    isAbsolute(path) ||
    components.length > MAX_DEPTH ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw contextualError("bundle contains an unsafe path");
  }
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function assertPrivateRuntimeRootFd(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) throw contextualError("runtime data root must be a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw contextualError("runtime data root must be owned by the current user");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw contextualError("runtime data root must have mode 0700");
  }
}

function fileDigestFd(fd: number, expected?: Stats): { bytes: number; sha256: string } {
  const first = fstatSync(fd);
  if (
    !first.isFile() ||
    first.nlink !== 1 ||
    (expected && (first.dev !== expected.dev || first.ino !== expected.ino))
  ) {
    throw contextualError("state file must be a single-link regular file");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  const final = fstatSync(fd);
  if (
    final.size !== first.size ||
    final.mtimeMs !== first.mtimeMs ||
    final.ctimeMs !== first.ctimeMs
  ) {
    throw contextualError("state file changed while it was read");
  }
  return { bytes: total, sha256: hash.digest("hex") };
}

interface CopyBudget {
  entries: number;
  bytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

function copyRegularFileFd(
  sourceFd: number,
  destinationDirectoryFd: number,
  destinationLeaf: string,
  expected: Stats,
  budget: CopyBudget,
): BundleFile {
  let destinationFd: number | undefined;
  let ownsDestination = false;
  try {
    const initial = fstatSync(sourceFd);
    if (
      !initial.isFile() ||
      initial.nlink !== 1 ||
      initial.dev !== expected.dev ||
      initial.ino !== expected.ino
    ) {
      throw contextualError("state file changed before copy");
    }
    if (typeof process.getuid === "function" && initial.uid !== process.getuid()) {
      throw contextualError("state file must be owned by the current user");
    }
    if (initial.size > budget.maxFileBytes) {
      throw contextualError(`state file exceeds ${budget.maxFileBytes} bytes`);
    }
    if (budget.bytes + initial.size > budget.maxTotalBytes) {
      throw contextualError(`runtime state exceeds ${budget.maxTotalBytes} bytes`);
    }
    destinationFd = openAt(
      destinationDirectoryFd,
      destinationLeaf,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    ownsDestination = true;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (total > budget.maxFileBytes || budget.bytes + total > budget.maxTotalBytes) {
        throw contextualError("runtime state byte limit exceeded during copy");
      }
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(destinationFd, buffer, written, bytesRead - written);
        if (count < 1) throw contextualError("bundle destination stopped accepting data");
        written += count;
      }
    }
    const final = fstatSync(sourceFd);
    if (
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw contextualError("state file changed during copy");
    }
    fchmodSync(destinationFd, 0o600);
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;
    budget.bytes += total;
    return { bytes: total, sha256: hash.digest("hex") };
  } finally {
    closeQuietly(destinationFd);
    if (destinationFd !== undefined && ownsDestination) {
      unlinkAt(destinationDirectoryFd, destinationLeaf);
    }
  }
}

interface BundleFile {
  bytes: number;
  sha256: string;
}

function walkAndCopy(
  sourceDirectoryFd: number,
  destinationDirectoryFd: number,
  relativeDirectory: string,
  directories: Array<z.infer<typeof BundleDirectorySchema>>,
  files: Array<z.infer<typeof BundleFileSchema>>,
  depth = 0,
  budget: CopyBudget,
): void {
  if (depth > MAX_DEPTH) throw contextualError(`runtime state exceeds depth ${MAX_DEPTH}`);
  const listed = listDirectoryFd(sourceDirectoryFd, Math.max(0, MAX_FILES - budget.entries));
  if (listed.truncated) throw contextualError(`runtime state exceeds ${MAX_FILES} entries`);
  for (const name of listed.names.sort((a, b) => a.localeCompare(b))) {
    budget.entries += 1;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    assertSafeRelativePath(relativePath);
    if (relativePath === RUNTIME_STATE_RESTORE_FENCE) {
      throw contextualError("runtime state has an unresolved restore fence");
    }
    const opened = tryOpenAt(
      sourceDirectoryFd,
      name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if ("errno" in opened) throw contextualError("runtime state contains an unsafe entry");
    try {
      const stat = fstatSync(opened.fd);
      if (stat.isDirectory()) {
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          throw contextualError("state directory must be owned by the current user");
        }
        if (!mkdirAt(destinationDirectoryFd, name, 0o700)) {
          throw contextualError("bundle directory creation failed");
        }
        const destinationChild = openPinnedChildDirectory(
          destinationDirectoryFd,
          name,
          "bundle directory",
        );
        directories.push({ path: relativePath, mode: "0700" });
        try {
          walkAndCopy(
            opened.fd,
            destinationChild,
            relativePath,
            directories,
            files,
            depth + 1,
            budget,
          );
        } finally {
          closeSync(destinationChild);
        }
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw contextualError("runtime state must contain only directories and regular files");
      }
      const copied = copyRegularFileFd(opened.fd, destinationDirectoryFd, name, stat, budget);
      files.push({ path: relativePath, ...copied, mode: "0600" });
    } finally {
      closeSync(opened.fd);
    }
  }
  fsyncSync(destinationDirectoryFd);
}

function inspectSqliteBytes(
  inspectionSnapshot: Buffer,
): z.infer<typeof SqliteMetadataSchema> | undefined {
  if (
    inspectionSnapshot.byteLength < 16 ||
    inspectionSnapshot.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
  ) {
    return undefined;
  }
  // A deserialized in-memory SQLite database cannot open WAL sidecars.
  // Journal artifacts are normalized before this admission; switch only the
  // private inspection copy to rollback-journal header semantics.
  if (inspectionSnapshot[18] === 2 || inspectionSnapshot[19] === 2) {
    inspectionSnapshot[18] = 1;
    inspectionSnapshot[19] = 1;
  }
  let db: Database | undefined;
  try {
    try {
      db = Database.deserialize(inspectionSnapshot);
    } catch (error) {
      throw contextualError("failed to inspect SQLite snapshot", error);
    }
    const check = db.query("PRAGMA quick_check(1)").get() as Record<string, unknown> | null;
    const quickCheck = Object.values(check ?? {})[0];
    if (quickCheck !== "ok") throw contextualError("SQLite quick_check failed in bundle");
    const applicationIdRow = db.query("PRAGMA application_id").get() as {
      application_id?: unknown;
    } | null;
    const userVersionRow = db.query("PRAGMA user_version").get() as {
      user_version?: unknown;
    } | null;
    if (
      !Number.isSafeInteger(applicationIdRow?.application_id) ||
      !Number.isSafeInteger(userVersionRow?.user_version)
    ) {
      throw contextualError("SQLite metadata is invalid");
    }
    return {
      applicationId: applicationIdRow!.application_id as number,
      userVersion: userVersionRow!.user_version as number,
      quickCheck: "ok",
    };
  } finally {
    db?.close();
  }
}

function sqliteMetadataFd(
  fd: number,
  journalArtifacts: string[] = [],
): z.infer<typeof SqliteMetadataSchema> | undefined {
  const initial = fstatSync(fd);
  if (!initial.isFile() || initial.nlink !== 1) {
    throw contextualError("SQLite candidate must be a single-link regular file");
  }
  const header = Buffer.alloc(100);
  const count = readSync(fd, header, 0, header.byteLength, 0);
  if (count < 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
    return undefined;
  }
  if (journalArtifacts.length > 0) {
    const final = fstatSync(fd);
    if (
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw contextualError("SQLite state changed during journal admission");
    }
    return {
      applicationId: header.readUInt32BE(68),
      userVersion: header.readUInt32BE(60),
      quickCheck: "deferred",
      journalArtifacts,
    };
  }
  if (initial.size > MAX_SQLITE_INSPECTION_BYTES) {
    throw contextualError(
      `SQLite state exceeds the ${MAX_SQLITE_INSPECTION_BYTES}-byte recovery inspection limit`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < initial.size) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, initial.size - total));
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const final = fstatSync(fd);
  if (
    total !== initial.size ||
    final.size !== initial.size ||
    final.mtimeMs !== initial.mtimeMs ||
    final.ctimeMs !== initial.ctimeMs
  ) {
    throw contextualError("SQLite state changed during inspection");
  }
  return inspectSqliteBytes(Buffer.concat(chunks, total));
}

function openRelativeEntry(rootFd: number, relativePath: string): number {
  assertSafeRelativePath(relativePath);
  const segments = relativePath.split("/");
  let current = duplicateFd(rootFd);
  try {
    for (const segment of segments.slice(0, -1)) {
      const child = openAt(current, segment, ANCHORED_DIRECTORY_FLAGS);
      closeSync(current);
      current = child;
    }
    const leaf = openAt(
      current,
      segments.at(-1)!,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    closeSync(current);
    current = leaf;
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

function openRelativeParent(
  rootFd: number,
  relativePath: string,
  create = false,
): { parentFd: number; leaf: string } {
  assertSafeRelativePath(relativePath);
  const segments = relativePath.split("/");
  let current = duplicateFd(rootFd);
  try {
    for (const segment of segments.slice(0, -1)) {
      const child = openPinnedChildDirectory(current, segment, "runtime state directory", create);
      closeSync(current);
      current = child;
    }
    return { parentFd: current, leaf: segments.at(-1)! };
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

function addSqliteMetadata(
  payloadRootFd: number,
  files: Array<z.infer<typeof BundleFileSchema>>,
): void {
  const filePaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (/(?:-wal|-shm|-journal)$/i.test(file.path)) continue;
    const artifacts = ["-wal", "-shm", "-journal"]
      .map((suffix) => `${file.path}${suffix}`)
      .filter((path) => filePaths.has(path));
    const fd = openRelativeEntry(payloadRootFd, file.path);
    let metadata: z.infer<typeof SqliteMetadataSchema> | undefined;
    try {
      metadata = sqliteMetadataFd(fd, artifacts);
    } finally {
      closeSync(fd);
    }
    if (!metadata) continue;
    file.sqlite = metadata;
  }
}

function assertInventorySqliteCompatibility(
  inventory: RuntimeStateInventory,
  files: Array<z.infer<typeof BundleFileSchema>>,
): void {
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    if (!file.sqlite) continue;
    const artifacts = file.sqlite.journalArtifacts ?? [];
    if (file.sqlite.quickCheck === "deferred") {
      if (
        artifacts.length === 0 ||
        artifacts.some(
          (artifact) =>
            !byPath.has(artifact) ||
            ![`${file.path}-wal`, `${file.path}-shm`, `${file.path}-journal`].includes(artifact),
        )
      ) {
        throw contextualError(`journaled SQLite metadata is incomplete for ${file.path}`);
      }
    } else if (artifacts.length > 0) {
      throw contextualError(`self-contained SQLite metadata lists journal files for ${file.path}`);
    }
  }
  for (const store of inventory.stores) {
    if (store.kind !== "sqlite" || store.backupPlane !== "runtime-volume" || !store.relativePath) {
      continue;
    }
    const file = byPath.get(store.relativePath);
    if (!file) {
      if (store.required) throw contextualError(`required SQLite state is missing: ${store.id}`);
      continue;
    }
    if (!file.sqlite) throw contextualError(`declared SQLite state is not SQLite: ${store.id}`);
    const expected = store.schema ? RUNTIME_STATE_SQLITE_IDENTITIES[store.schema] : undefined;
    if (
      expected &&
      (file.sqlite.applicationId !== expected.applicationId ||
        file.sqlite.userVersion !== expected.userVersion)
    ) {
      throw contextualError(`SQLite identity is incompatible for ${store.id}`);
    }
  }
}

function manifestDigest(manifest: RuntimeStateBundleManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function assertRequiredRuntimeStatePresent(
  sourceRootFd: number,
  inventory: RuntimeStateInventory,
): void {
  for (const store of inventory.stores) {
    if (store.backupPlane !== "runtime-volume" || !store.required || !store.relativePath) continue;
    assertSafeRelativePath(store.relativePath);
    let fd: number;
    try {
      fd = openRelativeEntry(sourceRootFd, store.relativePath);
    } catch {
      throw contextualError(`required runtime state is missing: ${store.id}`);
    }
    try {
      const stat = fstatSync(fd);
      if (store.kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
        throw contextualError(`required runtime state has the wrong kind: ${store.id}`);
      }
    } finally {
      closeSync(fd);
    }
  }
}

function assertRuntimeStateIdentityFd(rootFd: number, expectedAgentId: string): void {
  const opened = inspectPinnedFile(rootFd, RUNTIME_STATE_IDENTITY_FILE, "runtime state identity");
  if (!opened) throw contextualError("runtime state identity is missing");
  try {
    if ((opened.stat.mode & 0o777) !== 0o600) {
      throw contextualError("runtime state identity must have mode 0600");
    }
  } finally {
    closeSync(opened.fd);
  }
  const raw = JSON.parse(
    readPinnedFile(
      rootFd,
      RUNTIME_STATE_IDENTITY_FILE,
      "runtime state identity",
      64 * 1024,
    ).toString("utf8"),
  ) as unknown;
  const identity = RuntimeStateIdentitySchema.safeParse(raw);
  if (!identity.success || identity.data.agentId !== expectedAgentId) {
    throw contextualError("runtime state identity does not match the configured agent");
  }
}

function validateByteLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw contextualError(`${label} must be a positive safe integer`);
  }
  return value;
}

function removeTreeAt(parentFd: number, name: string, remaining: { entries: number }): void {
  if (remaining.entries-- < 1) throw contextualError("staging cleanup exceeded entry limit");
  const opened = tryOpenAt(
    parentFd,
    name,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  if ("errno" in opened) return;
  const stat = fstatSync(opened.fd);
  try {
    if (stat.isDirectory()) {
      const listed = listDirectoryFd(opened.fd, Math.max(0, remaining.entries));
      if (listed.truncated) throw contextualError("staging cleanup exceeded entry limit");
      for (const child of listed.names) removeTreeAt(opened.fd, child, remaining);
    } else if (!stat.isFile() || stat.nlink !== 1) {
      throw contextualError("staging cleanup encountered an unsafe entry");
    }
  } finally {
    closeSync(opened.fd);
  }
  if (!unlinkAt(parentFd, name, stat.isDirectory())) {
    throw contextualError("staging cleanup failed");
  }
}

export function createRuntimeStateBundle(
  options: CreateRuntimeStateBundleOptions,
): RuntimeStateBundleManifest {
  if (options.confirmStopped !== true) {
    throw contextualError("backup requires an explicit stopped-and-drained acknowledgement");
  }
  const configuredSourceRoot = resolve(options.sourceRoot);
  const configuredBundlePath = resolve(options.bundlePath);
  const inventory = RuntimeStateInventorySchema.parse(options.inventory);
  const maxFileBytes = validateByteLimit(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    "maxFileBytes",
  );
  const maxTotalBytes = validateByteLimit(
    options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  if (maxFileBytes > maxTotalBytes) {
    throw contextualError("maxFileBytes cannot exceed maxTotalBytes");
  }
  const source = pinDirectory(configuredSourceRoot, "runtime data root");
  const parent = pinDirectory(dirname(configuredBundlePath), "bundle parent");
  const bundleName = basename(configuredBundlePath);
  if (
    isContained(source.canonical, join(parent.canonical, bundleName)) ||
    isContained(join(parent.canonical, bundleName), source.canonical)
  ) {
    closeSync(source.fd);
    closeSync(parent.fd);
    throw contextualError("bundle path must be outside the runtime data root");
  }
  const existing = tryOpenAt(
    parent.fd,
    bundleName,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  if ("fd" in existing) {
    closeSync(existing.fd);
    closeSync(source.fd);
    closeSync(parent.fd);
    throw contextualError("bundle destination already exists");
  }
  if (existing.errno !== 2) {
    closeSync(source.fd);
    closeSync(parent.fd);
    throw contextualError("bundle destination is unsafe");
  }
  assertRuntimeStateIdentityFd(source.fd, inventory.agent.id);
  assertRequiredRuntimeStatePresent(source.fd, inventory);
  options.__testHooks?.afterRootsPinned?.();

  const stagingName = `.${bundleName}.tmp.${randomUUID()}`;
  if (!mkdirAt(parent.fd, stagingName, 0o700)) {
    closeSync(source.fd);
    closeSync(parent.fd);
    throw contextualError("bundle staging directory creation failed");
  }
  const staging = openPinnedChildDirectory(parent.fd, stagingName, "bundle staging");
  if (!mkdirAt(staging, PAYLOAD_DIRECTORY, 0o700)) {
    closeSync(staging);
    closeSync(source.fd);
    closeSync(parent.fd);
    throw contextualError("bundle payload directory creation failed");
  }
  const payload = openPinnedChildDirectory(staging, PAYLOAD_DIRECTORY, "bundle payload");
  const directories: Array<z.infer<typeof BundleDirectorySchema>> = [];
  const files: Array<z.infer<typeof BundleFileSchema>> = [];
  let published = false;
  try {
    walkAndCopy(source.fd, payload, "", directories, files, 0, {
      entries: 0,
      bytes: 0,
      maxFileBytes,
      maxTotalBytes,
    });
    addSqliteMetadata(payload, files);
    assertInventorySqliteCompatibility(inventory, files);
    // Read-only SQLite admission may update an existing shared-memory file.
    // Hash the final payload after all semantic inspection has completed.
    for (const file of files) {
      const fd = openRelativeEntry(payload, file.path);
      try {
        const stat = fstatSync(fd);
        if (stat.size > maxFileBytes) {
          throw contextualError(`state file exceeds ${maxFileBytes} bytes after normalization`);
        }
        const digest = fileDigestFd(fd, fstatSync(fd));
        file.bytes = digest.bytes;
        file.sha256 = digest.sha256;
      } finally {
        closeSync(fd);
      }
    }
    if (files.reduce((total, file) => total + file.bytes, 0) > maxTotalBytes) {
      throw contextualError(`runtime state exceeds ${maxTotalBytes} bytes after normalization`);
    }
    directories.sort((a, b) => a.path.localeCompare(b.path));
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: RuntimeStateBundleManifest = RuntimeStateBundleManifestSchema.parse({
      kind: BUNDLE_KIND,
      formatVersion: RUNTIME_STATE_BUNDLE_FORMAT_VERSION,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      runtimeVersion: pkg.version,
      consistency: { mode: "offline-operator-asserted", singleReplica: true },
      inventory,
      directories,
      files,
    });
    replacePinnedFile(staging, MANIFEST_FILE, JSON.stringify(manifest), "bundle manifest");
    fsyncSync(staging);
    if (!renameAt(parent.fd, stagingName, parent.fd, bundleName)) {
      throw contextualError("bundle publish rename failed");
    }
    published = true;
    fsyncSync(parent.fd);
    return manifest;
  } finally {
    closeSync(payload);
    closeSync(staging);
    closeSync(source.fd);
    if (!published) {
      try {
        removeTreeAt(parent.fd, stagingName, { entries: MAX_FILES + 2 });
      } catch {
        // Preserve the operation failure. Random owner-only staging remains inert.
      }
    }
    closeSync(parent.fd);
  }
}

function readManifestFd(bundleFd: number): RuntimeStateBundleManifest {
  const opened = inspectPinnedFile(bundleFd, MANIFEST_FILE, "bundle manifest");
  if (!opened) throw contextualError("bundle manifest is missing");
  try {
    if ((opened.stat.mode & 0o777) !== 0o600) {
      throw contextualError("bundle manifest must have mode 0600");
    }
  } finally {
    closeSync(opened.fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      readPinnedFile(bundleFd, MANIFEST_FILE, "bundle manifest", MAX_MANIFEST_BYTES).toString(
        "utf8",
      ),
    ) as unknown;
  } catch (error) {
    throw contextualError("bundle manifest is not valid JSON", error);
  }
  const parsed = RuntimeStateBundleManifestSchema.safeParse(raw);
  if (!parsed.success) throw contextualError("bundle manifest failed validation");
  return parsed.data;
}

function collectPayloadFiles(
  directoryFd: number,
  relativeDirectory: string,
  directories: string[],
  files: string[],
  depth = 0,
  budget: { entries: number } = { entries: 0 },
): void {
  if (depth > MAX_DEPTH) throw contextualError(`bundle exceeds depth ${MAX_DEPTH}`);
  const stat = fstatSync(directoryFd);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw contextualError("bundle payload directory must have mode 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw contextualError("bundle payload directory has the wrong owner");
  }
  const listed = listDirectoryFd(directoryFd, Math.max(0, MAX_FILES - budget.entries));
  if (listed.truncated) throw contextualError(`bundle exceeds ${MAX_FILES} entries`);
  for (const name of listed.names.sort((a, b) => a.localeCompare(b))) {
    budget.entries += 1;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    assertSafeRelativePath(relativePath);
    const opened = tryOpenAt(
      directoryFd,
      name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if ("errno" in opened) throw contextualError("bundle payload contains an unsafe entry");
    try {
      const child = fstatSync(opened.fd);
      if (child.isDirectory()) {
        directories.push(relativePath);
        collectPayloadFiles(opened.fd, relativePath, directories, files, depth + 1, budget);
        continue;
      }
      if (!child.isFile() || child.nlink !== 1) {
        throw contextualError("bundle payload must contain only regular files");
      }
      if ((child.mode & 0o777) !== 0o600) {
        throw contextualError(`bundle payload file must have mode 0600: ${relativePath}`);
      }
      if (typeof process.getuid === "function" && child.uid !== process.getuid()) {
        throw contextualError("bundle payload file has the wrong owner");
      }
      files.push(relativePath);
    } finally {
      closeSync(opened.fd);
    }
  }
}

interface OpenVerifiedBundle {
  manifest: RuntimeStateBundleManifest;
  bundle: PinnedDirectory;
  payloadFd: number;
}

function openVerifiedRuntimeStateBundle(bundlePath: string): OpenVerifiedBundle {
  const bundle = pinDirectory(resolve(bundlePath), "bundle");
  let payloadFd: number | undefined;
  try {
    if ((fstatSync(bundle.fd).mode & 0o777) !== 0o700) {
      throw contextualError("bundle must have mode 0700");
    }
    const manifest = readManifestFd(bundle.fd);
    const declaredBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > DEFAULT_MAX_TOTAL_BYTES) {
      throw contextualError("bundle exceeds the format byte limit");
    }
    payloadFd = openPinnedChildDirectory(
      bundle.fd,
      PAYLOAD_DIRECTORY,
      "bundle payload",
      false,
      false,
    );

    const actualDirectories: string[] = [];
    const actualFiles: string[] = [];
    collectPayloadFiles(payloadFd, "", actualDirectories, actualFiles);
    actualDirectories.sort();
    actualFiles.sort();
    const declaredDirectories = manifest.directories.map((directory) => directory.path).sort();
    const declaredFiles = manifest.files.map((file) => file.path).sort();
    if (
      new Set(declaredDirectories).size !== declaredDirectories.length ||
      new Set(declaredFiles).size !== declaredFiles.length
    ) {
      throw contextualError("bundle manifest contains duplicate paths");
    }
    if (
      JSON.stringify(actualDirectories) !== JSON.stringify(declaredDirectories) ||
      JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)
    ) {
      throw contextualError("bundle payload does not match its manifest");
    }

    for (const file of manifest.files) {
      const fd = openRelativeEntry(payloadFd, file.path);
      try {
        const digest = fileDigestFd(fd, fstatSync(fd));
        if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
          throw contextualError(`bundle payload integrity check failed for ${file.path}`);
        }
      } finally {
        closeSync(fd);
      }
    }
    assertRuntimeStateIdentityFd(payloadFd, manifest.inventory.agent.id);
    assertInventorySqliteCompatibility(manifest.inventory, manifest.files);
    for (const file of manifest.files) {
      if (file.sqlite) {
        const fd = openRelativeEntry(payloadFd, file.path);
        let metadata: z.infer<typeof SqliteMetadataSchema> | undefined;
        try {
          metadata = sqliteMetadataFd(fd, file.sqlite.journalArtifacts);
        } finally {
          closeSync(fd);
        }
        if (!metadata || JSON.stringify(metadata) !== JSON.stringify(file.sqlite)) {
          throw contextualError("bundle SQLite metadata check failed");
        }
      }
    }
    return { manifest, bundle, payloadFd };
  } catch (error) {
    if (payloadFd !== undefined) closeSync(payloadFd);
    closeSync(bundle.fd);
    throw error;
  }
}

export function verifyRuntimeStateBundle(bundle: string): RuntimeStateBundleManifest {
  const opened = openVerifiedRuntimeStateBundle(bundle);
  try {
    return opened.manifest;
  } finally {
    closeSync(opened.payloadFd);
    closeSync(opened.bundle.fd);
  }
}

function ensureEmptyRestoreRoot(path: string): PinnedDirectory {
  const parent = pinDirectory(dirname(path), "restore parent");
  const leaf = basename(path);
  try {
    let opened = tryOpenAt(parent.fd, leaf, ANCHORED_DIRECTORY_FLAGS);
    if ("errno" in opened) {
      if (opened.errno !== 2 || !mkdirAt(parent.fd, leaf, 0o700)) {
        throw contextualError("restore destination must be a safe directory");
      }
      opened = tryOpenAt(parent.fd, leaf, ANCHORED_DIRECTORY_FLAGS);
    }
    if ("errno" in opened) throw contextualError("restore destination is unavailable");
    const stat = fstatSync(opened.fd);
    if (!stat.isDirectory()) {
      closeSync(opened.fd);
      throw contextualError("restore destination must be a real directory");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      closeSync(opened.fd);
      throw contextualError("restore destination must be owned by the current user");
    }
    const listed = listDirectoryFd(opened.fd, 1);
    if (listed.names.length !== 0 || listed.truncated) {
      closeSync(opened.fd);
      throw contextualError("restore destination must be empty");
    }
    fchmodSync(opened.fd, 0o700);
    return { canonical: join(parent.canonical, leaf), fd: opened.fd };
  } finally {
    closeSync(parent.fd);
  }
}

function ensureRelativeDirectory(rootFd: number, relativePath: string): void {
  assertSafeRelativePath(relativePath);
  let current = duplicateFd(rootFd);
  try {
    for (const segment of relativePath.split("/")) {
      const child = openPinnedChildDirectory(current, segment, "restore directory", true);
      closeSync(current);
      current = child;
    }
    fsyncSync(current);
  } finally {
    closeSync(current);
  }
}

function copyVerifiedPayloadFd(
  manifest: RuntimeStateBundleManifest,
  sourceRootFd: number,
  destinationRootFd: number,
  beforeCopy?: (path: string) => void,
  allowExisting = false,
): void {
  for (const directory of [...manifest.directories].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length,
  )) {
    ensureRelativeDirectory(destinationRootFd, directory.path);
  }
  const budget: CopyBudget = {
    entries: 0,
    bytes: 0,
    maxFileBytes: Math.max(1, ...manifest.files.map((file) => file.bytes)),
    maxTotalBytes: Math.max(
      1,
      manifest.files.reduce((total, file) => total + file.bytes, 0),
    ),
  };
  for (const file of manifest.files) {
    const destination = openRelativeParent(destinationRootFd, file.path, true);
    const existing = tryOpenAt(
      destination.parentFd,
      destination.leaf,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if ("fd" in existing) {
      try {
        if (!allowExisting) throw contextualError(`restore target already contains ${file.path}`);
        const digest = fileDigestFd(existing.fd, fstatSync(existing.fd));
        if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
          throw contextualError(`partial restore file does not match bundle: ${file.path}`);
        }
        budget.bytes += digest.bytes;
        continue;
      } finally {
        closeSync(existing.fd);
        closeSync(destination.parentFd);
      }
    }
    if (existing.errno !== 2) {
      closeSync(destination.parentFd);
      throw contextualError(`restore target contains an unsafe entry: ${file.path}`);
    }
    beforeCopy?.(file.path);
    const sourceFd = openRelativeEntry(sourceRootFd, file.path);
    try {
      const copied = copyRegularFileFd(
        sourceFd,
        destination.parentFd,
        destination.leaf,
        fstatSync(sourceFd),
        budget,
      );
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
        throw contextualError(`bundle payload changed during restore: ${file.path}`);
      }
      fsyncSync(destination.parentFd);
    } finally {
      closeSync(sourceFd);
      closeSync(destination.parentFd);
    }
  }
  fsyncSync(destinationRootFd);
}

function compatibilityProjection(inventory: RuntimeStateInventory): string {
  const stores = inventory.stores
    .filter((store) => store.replayCritical && store.backupPlane === "runtime-volume")
    .map((store) => ({
      id: store.id,
      owner: store.owner,
      namespace: store.namespace,
      kind: store.kind,
      relativePath: store.relativePath,
      schema: store.schema,
      required: store.required,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const externalPrerequisites = inventory.externalPrerequisites
    .map(({ id, owner }) => ({ id, owner }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ stores, externalPrerequisites });
}

export function assertRuntimeStateRestoreCompatibility(
  bundled: RuntimeStateInventory,
  expected: RuntimeStateInventory,
): void {
  const parsedBundled = RuntimeStateInventorySchema.parse(bundled);
  const parsedExpected = RuntimeStateInventorySchema.parse(expected);
  if (parsedBundled.agent.id !== parsedExpected.agent.id) {
    throw contextualError("bundle belongs to a different agent id");
  }
  if (parsedBundled.configShapeSha256 !== parsedExpected.configShapeSha256) {
    throw contextualError("bundle configuration shape does not match the current agent");
  }
  if (compatibilityProjection(parsedBundled) !== compatibilityProjection(parsedExpected)) {
    throw contextualError("bundle replay-critical state topology is incompatible");
  }
}

export function restoreRuntimeStateBundle(
  options: RestoreRuntimeStateBundleOptions,
): RuntimeStateRestoreFence {
  if (options.confirmStopped !== true) {
    throw contextualError("restore requires an explicit stopped-and-drained acknowledgement");
  }
  const opened = openVerifiedRuntimeStateBundle(options.bundlePath);
  const manifest = opened.manifest;
  assertRuntimeStateRestoreCompatibility(manifest.inventory, options.expectedInventory);
  const configuredDestinationRoot = resolve(options.destinationRoot);
  if (
    isContained(opened.bundle.canonical, configuredDestinationRoot) ||
    isContained(configuredDestinationRoot, opened.bundle.canonical)
  ) {
    closeSync(opened.payloadFd);
    closeSync(opened.bundle.fd);
    throw contextualError("restore destination and bundle must not contain one another");
  }
  const restoreId = (options.restoreId ?? randomUUID)();
  if (!z.string().uuid().safeParse(restoreId).success) {
    closeSync(opened.payloadFd);
    closeSync(opened.bundle.fd);
    throw contextualError("restore id must be a UUID");
  }
  const destination = ensureEmptyRestoreRoot(configuredDestinationRoot);
  options.__testHooks?.afterRootsPinned?.();
  const restoredAt = (options.now ?? (() => new Date()))().toISOString();
  const copyingFence: RuntimeStateRestoreFence = {
    version: 1,
    status: "copying",
    restoreId,
    bundleManifestSha256: manifestDigest(manifest),
    restoredAt,
  };
  try {
    replacePinnedFile(
      destination.fd,
      RUNTIME_STATE_RESTORE_FENCE,
      JSON.stringify(copyingFence),
      "runtime state restore fence",
    );
    copyVerifiedPayloadFd(
      manifest,
      opened.payloadFd,
      destination.fd,
      options.__testHooks?.beforeCopy,
    );
    assertRuntimeStateIdentityFd(destination.fd, manifest.inventory.agent.id);
    const finalFence: RuntimeStateRestoreFence = {
      ...copyingFence,
      status: "requires-reconciliation",
    };
    replacePinnedFile(
      destination.fd,
      RUNTIME_STATE_RESTORE_FENCE,
      JSON.stringify(finalFence),
      "runtime state restore fence",
    );
    fsyncSync(destination.fd);
    return finalFence;
  } finally {
    closeSync(destination.fd);
    closeSync(opened.payloadFd);
    closeSync(opened.bundle.fd);
  }
}

export function readRuntimeStateRestoreFenceFd(rootFd: number): RuntimeStateRestoreFence | null {
  const opened = inspectPinnedFile(
    rootFd,
    RUNTIME_STATE_RESTORE_FENCE,
    "runtime state restore fence",
  );
  if (!opened) return null;
  try {
    if ((opened.stat.mode & 0o777) !== 0o600) {
      throw contextualError("runtime state restore fence must have mode 0600");
    }
  } finally {
    closeSync(opened.fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      readPinnedFile(
        rootFd,
        RUNTIME_STATE_RESTORE_FENCE,
        "runtime state restore fence",
        64 * 1024,
      ).toString("utf8"),
    ) as unknown;
  } catch (error) {
    throw contextualError("runtime state restore fence failed parsing", error);
  }
  const parsed = RuntimeStateRestoreFenceSchema.safeParse(raw);
  if (!parsed.success) throw contextualError("runtime state restore fence failed validation");
  return parsed.data;
}

/** Resume only the exact verified subset left by an interrupted empty-target restore. */
export function resumeRuntimeStateRestore(
  options: ResumeRuntimeStateRestoreOptions,
): RuntimeStateRestoreFence {
  if (options.confirmStopped !== true) {
    throw contextualError(
      "restore resume requires an explicit stopped-and-drained acknowledgement",
    );
  }
  if (!z.string().uuid().safeParse(options.restoreId).success) {
    throw contextualError("restore id must be a UUID");
  }
  const opened = openVerifiedRuntimeStateBundle(options.bundlePath);
  let destination: PinnedDirectory | undefined;
  try {
    assertRuntimeStateRestoreCompatibility(opened.manifest.inventory, options.expectedInventory);
    destination = pinDirectory(resolve(options.destinationRoot), "restore destination");
    if ((fstatSync(destination.fd).mode & 0o777) !== 0o700) {
      throw contextualError("restore destination must have mode 0700");
    }
    const fence = readRuntimeStateRestoreFenceFd(destination.fd);
    if (!fence) throw contextualError("interrupted restore fence is missing");
    if (fence.status !== "copying") {
      throw contextualError("only an interrupted copying restore can be resumed");
    }
    if (fence.restoreId !== options.restoreId) {
      throw contextualError("restore id does not match the interrupted restore");
    }
    if (fence.bundleManifestSha256 !== manifestDigest(opened.manifest)) {
      throw contextualError("interrupted restore belongs to a different bundle");
    }

    const actualDirectories: string[] = [];
    const actualFiles: string[] = [];
    collectPayloadFiles(destination.fd, "", actualDirectories, actualFiles);
    const allowedDirectories = new Set(opened.manifest.directories.map((entry) => entry.path));
    const allowedFiles = new Set([
      RUNTIME_STATE_RESTORE_FENCE,
      ...opened.manifest.files.map((entry) => entry.path),
    ]);
    if (
      actualDirectories.some((path) => !allowedDirectories.has(path)) ||
      actualFiles.some((path) => !allowedFiles.has(path))
    ) {
      throw contextualError("interrupted restore contains files outside the bundle");
    }

    copyVerifiedPayloadFd(
      opened.manifest,
      opened.payloadFd,
      destination.fd,
      options.__testHooks?.beforeCopy,
      true,
    );
    assertRuntimeStateIdentityFd(destination.fd, opened.manifest.inventory.agent.id);
    const finalFence: RuntimeStateRestoreFence = { ...fence, status: "requires-reconciliation" };
    replacePinnedFile(
      destination.fd,
      RUNTIME_STATE_RESTORE_FENCE,
      JSON.stringify(finalFence),
      "runtime state restore fence",
    );
    fsyncSync(destination.fd);
    return finalFence;
  } finally {
    if (destination) closeSync(destination.fd);
    closeSync(opened.payloadFd);
    closeSync(opened.bundle.fd);
  }
}

export function readRuntimeStateRestoreFence(
  runtimeDataRoot: string,
): RuntimeStateRestoreFence | null {
  const root = pinDirectory(resolve(runtimeDataRoot), "runtime data root");
  try {
    assertPrivateRuntimeRootFd(root.fd);
    return readRuntimeStateRestoreFenceFd(root.fd);
  } finally {
    closeSync(root.fd);
  }
}

export function assertNoRuntimeStateRestoreFence(runtimeDataRoot: string): void {
  const root = pinDirectory(resolve(runtimeDataRoot), "runtime data root");
  try {
    assertPrivateRuntimeRootFd(root.fd);
    assertNoRuntimeStateRestoreFenceFd(root.fd);
  } finally {
    closeSync(root.fd);
  }
}

export function assertNoRuntimeStateRestoreFenceFd(runtimeDataRootFd: number): void {
  const fence = readRuntimeStateRestoreFenceFd(runtimeDataRootFd);
  if (!fence) return;
  throw contextualError(
    `restore ${fence.restoreId} is ${fence.status}; reconcile downstream effects before startup`,
  );
}

export function reconcileRuntimeStateRestore(options: {
  runtimeDataRoot: string;
  restoreId: string;
  confirmDownstreamReconciled: boolean;
  /** @internal Deterministic root-replacement barrier for regression tests. */
  __testHooks?: { afterRootPinned?: () => void };
}): void {
  if (options.confirmDownstreamReconciled !== true) {
    throw contextualError("reconciliation requires an explicit downstream-effects acknowledgement");
  }
  const root = pinDirectory(resolve(options.runtimeDataRoot), "runtime data root");
  try {
    assertPrivateRuntimeRootFd(root.fd);
    options.__testHooks?.afterRootPinned?.();
    const fence = readRuntimeStateRestoreFenceFd(root.fd);
    if (!fence) throw contextualError("runtime state restore fence does not exist");
    if (fence.status !== "requires-reconciliation") {
      throw contextualError(`restore ${fence.restoreId} did not finish copying`);
    }
    if (fence.restoreId !== options.restoreId) {
      throw contextualError("restore id does not match the active restore fence");
    }
    if (!unlinkAt(root.fd, RUNTIME_STATE_RESTORE_FENCE)) {
      throw contextualError("runtime state restore fence removal failed");
    }
    fsyncSync(root.fd);
  } finally {
    closeSync(root.fd);
  }
}

export function runtimeStateBundleManifestDigest(manifest: RuntimeStateBundleManifest): string {
  return manifestDigest(RuntimeStateBundleManifestSchema.parse(manifest));
}

/** Bind a runtime volume to its server-minted agent id on first admission. */
export function admitRuntimeStateIdentity(
  runtimeDataRoot: string,
  agentId: string,
  options: { __testHooks?: { afterRootPinned?: () => void } } = {},
): void {
  const root = pinDirectory(resolve(runtimeDataRoot), "runtime data root");
  try {
    assertPrivateRuntimeRootFd(root.fd);
    options.__testHooks?.afterRootPinned?.();
    admitRuntimeStateIdentityFd(root.fd, agentId);
  } finally {
    closeSync(root.fd);
  }
}

/** Bind an already-pinned private runtime root to one server-minted agent id. */
export function admitRuntimeStateIdentityFd(runtimeDataRootFd: number, agentId: string): void {
  const parsedAgentId = RuntimeStateIdentitySchema.shape.agentId.safeParse(agentId);
  if (!parsedAgentId.success) throw contextualError("runtime state agent id is invalid");
  assertPrivateRuntimeRootFd(runtimeDataRootFd);
  const opened = inspectPinnedFile(
    runtimeDataRootFd,
    RUNTIME_STATE_IDENTITY_FILE,
    "runtime state identity",
  );
  if (!opened) {
    const created = createPinnedFile(
      runtimeDataRootFd,
      RUNTIME_STATE_IDENTITY_FILE,
      JSON.stringify({ version: 1, agentId }),
      "runtime state identity",
    );
    if (created) return;
  } else {
    closeSync(opened.fd);
  }
  const raw = JSON.parse(
    readPinnedFile(
      runtimeDataRootFd,
      RUNTIME_STATE_IDENTITY_FILE,
      "runtime state identity",
      64 * 1024,
    ).toString("utf8"),
  ) as unknown;
  const identity = RuntimeStateIdentitySchema.safeParse(raw);
  if (!identity.success) throw contextualError("runtime state identity failed validation");
  if (identity.data.agentId !== agentId) {
    throw contextualError("runtime state belongs to a different agent id");
  }
}

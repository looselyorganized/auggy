/** Exact offline rehearsal operations. Never a public filesystem or CLI gateway. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  createPinnedFile,
  openPinnedChildDirectory,
  pinDirectory,
  readPinnedFile,
} from "../../../../src/lib/anchored-files";
import { listDirectoryFd, tryLockFileExclusive, tryOpenAt } from "../../../../src/lib/posix-at";
import { TELEGRAM_FIXTURE_TOKEN } from "../telegram/telegram-network";

export const MAINTENANCE_LIMITS = Object.freeze({
  files: 16,
  directories: 16,
  fileBytes: 512 * 1024,
  totalBytes: 2 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  commandMs: 25_000,
  lifetimeMs: 110_000,
});
export const MAINTENANCE_PATHS = Object.freeze({
  root: "/app/data",
  config: "/app/agent.yaml",
  bundle: "/app/.g4-state-bundle",
  guard: ".auggy-auth-replay-guard.json",
  lock: ".auggy-runtime-singleton.lock",
});
// Public namespaces must match the selected G4 HTTP fixture's runtime inventory.
export const MAINTENANCE_PUBLIC_AUTH_PROFILE = Object.freeze({
  keyId: "g4-http-key",
  audience: "g4-http-service",
});
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[a-zA-Z0-9-]{16,128}$/);
const dockerStopped = z
  .object({
    runtimeId: identity,
    volumeId: identity,
    running: z.literal(false),
    exitCode: z.literal(0),
    observedAtMs: z.number().int().positive(),
    controllerReceiptSHA256: digest,
  })
  .strict();
const railwayStopped = z
  .object({
    provider: z.literal("railway"),
    projectId: z.string().uuid(),
    environmentId: z.string().uuid(),
    serviceId: z.string().uuid(),
    deploymentId: z.string().uuid(),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    volumeId: identity,
    deploymentStopped: z.literal(true),
    instances: z
      .array(z.object({ id: identity, status: z.enum(["STOPPED", "EXITED", "REMOVED"]) }).strict())
      .min(1)
      .max(2)
      .refine((instances) => instances.length === 1),
    sealedGenerationReceiptSHA256: digest,
    quiescenceReceiptSHA256: digest,
    observedAtMs: z.number().int().positive(),
    controllerReceiptSHA256: digest,
  })
  .strict();
// Docker proves a clean process exit. Railway exposes all-instances-stopped,
// not an exit code; its independent fixture receipt proves quiescence.
const stopped = z.union([dockerStopped, railwayStopped]);
export type HostedMaintenanceStopped = z.infer<typeof stopped>;
export type HostedRailwayMaintenanceStopped = z.infer<typeof railwayStopped>;
const operation = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare-empty-volume") }).strict(),
  z.object({ operation: z.literal("backup"), stopped }).strict(),
  z.object({ operation: z.literal("export-manifest") }).strict(),
  z
    .object({
      operation: z.literal("export-file"),
      index: z
        .number()
        .int()
        .min(0)
        .max(MAINTENANCE_LIMITS.files - 1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("import-manifest"),
      base64: z.string().max(90_000),
      sha256: digest,
    })
    .strict(),
  z
    .object({
      operation: z.literal("import-file"),
      index: z
        .number()
        .int()
        .min(0)
        .max(MAINTENANCE_LIMITS.files - 1),
      base64: z.string().max(700_000),
      sha256: digest,
    })
    .strict(),
  z.object({ operation: z.literal("verify") }).strict(),
  z.object({ operation: z.literal("restore"), stopped, destinationVolumeId: identity }).strict(),
  z.object({ operation: z.literal("guard"), stopped }).strict(),
  z
    .object({
      operation: z.literal("reconcile"),
      stopped,
      restoreId: z.string().uuid(),
      downstreamCheckpointSHA256: digest,
      unreplayedOperationId: z.string().uuid(),
      outcome: z.literal("preserved-downstream-not-retried"),
    })
    .strict(),
  z
    .object({
      operation: z.literal("reconcile-worker"),
      stopped,
      restoreId: z.string().uuid(),
      sealedGenerationReceiptSHA256: digest,
      backupManifestSHA256: digest,
      confirmedUpdateIds: z.tuple([z.literal(1), z.literal(2), z.literal(3)]),
    })
    .strict(),
]);
export type HostedMaintenanceOperation = z.infer<typeof operation>;
export const parseHostedMaintenanceOperation = (value: unknown) => operation.parse(value);
function check(value: unknown, message = "Rejected offline maintenance operation"): asserts value {
  if (!value) throw new Error(message);
}
/** Testable filesystem primitive; the remote operation supplies only fixed /app/data. */
export function prepareEmptyMaintenanceVolume(directory: string) {
  const pinned = pinDirectory(directory, "Fresh maintenance volume");
  try {
    const before = fstatSync(pinned.fd);
    const entries = listDirectoryFd(pinned.fd, 1);
    check(entries.names.length === 0 && !entries.truncated, "Fresh volume must be empty");
    const namedBefore = lstatSync(directory);
    check(
      namedBefore.isDirectory() && namedBefore.dev === before.dev && namedBefore.ino === before.ino,
      "Fresh volume identity changed",
    );
    fchmodSync(pinned.fd, 0o700);
    fsyncSync(pinned.fd);
    const after = fstatSync(pinned.fd);
    const namedAfter = lstatSync(directory);
    const finalEntries = listDirectoryFd(pinned.fd, 1);
    check(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.uid === process.getuid!() &&
        (after.mode & 0o7777) === 0o700 &&
        namedAfter.isDirectory() &&
        namedAfter.dev === after.dev &&
        namedAfter.ino === after.ino &&
        finalEntries.names.length === 0 &&
        !finalEntries.truncated,
      "Fresh volume changed during preparation",
    );
    return {
      empty: true,
      beforeMode: (before.mode & 0o7777).toString(8),
      mode: "700",
      directoryIdentity: { dev: after.dev, ino: after.ino },
    };
  } finally {
    closeSync(pinned.fd);
  }
}
/** The exact completed Telegram fixture claims, not a general reconciliation API. */
export function verifyHostedWorkerReplay(value: unknown) {
  const parsed = z
    .object({
      applicationId: z.literal(0x54475250),
      schemaVersion: z.literal(2),
      claims: z
        .array(
          z
            .object({ namespace: z.literal("telegram:bot-123456789"), updateId: z.number().int() })
            .strict(),
        )
        .length(3),
    })
    .strict()
    .parse(value);
  check(
    parsed.claims.every((claim, index) => claim.updateId === index + 1),
    "Worker replay claims differ",
  );
  return {
    applicationId: parsed.applicationId,
    schemaVersion: parsed.schemaVersion,
    claims: parsed.claims.map((claim) => ({
      updateId: claim.updateId,
      namespaceSHA256: hash(claim.namespace),
    })),
  };
}
function readWorkerReplay() {
  const path = join(MAINTENANCE_PATHS.root, "telegram-replay.db");
  const stat = lstatSync(path);
  check(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid!() &&
      (stat.mode & 0o777) === 0o600 &&
      stat.size <= MAINTENANCE_LIMITS.fileBytes,
  );
  const db = new Database(path, { readonly: true, create: false });
  try {
    const application = db.query("PRAGMA application_id").get() as { application_id: number };
    const schema = db.query("PRAGMA user_version").get() as { user_version: number };
    const rows = db
      .query("SELECT namespace, update_id FROM telegram_update_claims ORDER BY update_id LIMIT 4")
      .all() as { namespace: string; update_id: number }[];
    return verifyHostedWorkerReplay({
      applicationId: application.application_id,
      schemaVersion: schema.user_version,
      claims: rows.map((row) => ({ namespace: row.namespace, updateId: row.update_id })),
    });
  } finally {
    db.close();
  }
}
function safePath(value: unknown): asserts value is string {
  check(
    typeof value === "string" &&
      value.length <= 256 &&
      /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,3}$/.test(value) &&
      value.split("/").every((part) => part !== "." && part !== ".."),
  );
}
export interface MaintenanceBundleIndex {
  files: { path: string; bytes: number; sha256: string }[];
  directories: { path: string }[];
  totalBytes: number;
  manifestSHA256: string;
}
/** Transfer bounds only. Actual semantic/hash/SQLite verification is the public CLI's job. */
export function indexMaintenanceBundle(bytes: Uint8Array): MaintenanceBundleIndex {
  check(bytes.byteLength > 0 && bytes.byteLength <= MAINTENANCE_LIMITS.manifestBytes);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  check(
    value.kind === "auggy-runtime-state-bundle" &&
      value.formatVersion === 1 &&
      Array.isArray(value.files) &&
      value.files.length <= MAINTENANCE_LIMITS.files &&
      Array.isArray(value.directories) &&
      value.directories.length <= MAINTENANCE_LIMITS.directories,
  );
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of value.files) {
    safePath(entry.path);
    check(!seen.has(entry.path) && entry.path !== MAINTENANCE_PATHS.guard && entry.mode === "0600");
    seen.add(entry.path);
    check(
      Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= MAINTENANCE_LIMITS.fileBytes &&
        digest.safeParse(entry.sha256).success,
    );
    totalBytes += entry.bytes;
  }
  for (const entry of value.directories) {
    safePath(entry.path);
    check(!seen.has(entry.path) && entry.mode === "0700");
    seen.add(entry.path);
  }
  check(totalBytes <= MAINTENANCE_LIMITS.totalBytes);
  return {
    files: value.files.map(({ path, bytes, sha256 }: MaintenanceBundleIndex["files"][number]) => ({
      path,
      bytes,
      sha256,
    })),
    directories: value.directories.map(({ path }: { path: string }) => ({ path })),
    totalBytes,
    manifestSHA256: hash(bytes),
  };
}
export function decodeMaintenanceTransfer(base64: string, sha256: string, maximum: number): Buffer {
  check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64));
  const bytes = Buffer.from(base64, "base64");
  check(
    bytes.byteLength <= maximum && bytes.toString("base64") === base64 && hash(bytes) === sha256,
  );
  return bytes;
}
function atPath<T>(
  root: string,
  relative: string,
  create: boolean,
  use: (fd: number, leaf: string) => T,
): T {
  safePath(relative);
  const rootPin = pinDirectory(root, "Maintenance bundle");
  let fd = rootPin.fd;
  try {
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) {
      const child = openPinnedChildDirectory(fd, part, "Maintenance bundle path", create);
      closeSync(fd);
      fd = child;
    }
    return use(fd, parts.at(-1)!);
  } finally {
    closeSync(fd);
  }
}
export function writeMaintenanceBundleFile(root: string, relative: string, bytes: Uint8Array) {
  atPath(root, relative, true, (fd, leaf) =>
    check(createPinnedFile(fd, leaf, bytes, "Exclusive bundle file")),
  );
}
export function readMaintenanceBundleFile(root: string, relative: string, maximum: number) {
  return atPath(root, relative, false, (fd, leaf) =>
    readPinnedFile(fd, leaf, "Bundle file", maximum),
  );
}
export function createMaintenanceBundleDirectories(root: string, index: MaintenanceBundleIndex) {
  for (const entry of index.directories)
    atPath(join(root, "payload"), `${entry.path}/unused`, true, () => {});
}
function manifest() {
  const bytes = readMaintenanceBundleFile(
    MAINTENANCE_PATHS.bundle,
    "manifest.json",
    MAINTENANCE_LIMITS.manifestBytes,
  );
  return { bytes, index: indexMaintenanceBundle(bytes) };
}
function rootPin() {
  const root = pinDirectory(MAINTENANCE_PATHS.root, "Offline runtime root");
  try {
    check((fstatSync(root.fd).mode & 0o777) === 0o700);
    return root;
  } catch (error) {
    closeSync(root.fd);
    throw error;
  }
}
function acquireLease(): () => void {
  const root = rootPin();
  try {
    const opened = tryOpenAt(
      root.fd,
      MAINTENANCE_PATHS.lock,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    check("fd" in opened, "Stopped volume must have its original singleton lock");
    try {
      const stat = fstatSync(opened.fd);
      check(
        stat.isFile() &&
          stat.nlink === 1 &&
          stat.uid === process.getuid!() &&
          (stat.mode & 0o777) === 0o600,
      );
      check(
        tryLockFileExclusive(opened.fd) === "acquired",
        "A live replica still owns the runtime volume",
      );
      return () => closeSync(opened.fd);
    } catch (error) {
      closeSync(opened.fd);
      throw error;
    }
  } finally {
    closeSync(root.fd);
  }
}
async function cli(args: string[]) {
  // Public CLI parsing needs the existing synthetic YAML's env references, but
  // these offline commands never construct the application or authenticate.
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "offline-fixture-placeholder",
    AUGGY_WEB_TOKEN: "offline-fixture-placeholder",
    AUGGY_AUTH_SECRET: "offline-fixture-placeholder",
    AUGGY_AUTH_KEY_ID: MAINTENANCE_PUBLIC_AUTH_PROFILE.keyId,
    AUGGY_AUTH_AUDIENCE: MAINTENANCE_PUBLIC_AUTH_PROFILE.audience,
    ORDERS_SERVICE_TOKEN: "offline-fixture-placeholder",
    ORDERS_SERVICE_URL: "http://127.0.0.1:43152",
    TELEGRAM_BOT_TOKEN: TELEGRAM_FIXTURE_TOKEN,
  });
  const messages: string[] = [];
  let size = 0;
  const capture = (...values: unknown[]) => {
    const text = values.map(String).join(" ");
    size += Buffer.byteLength(text);
    check(size <= MAINTENANCE_LIMITS.manifestBytes, "CLI diagnostics exceeded bound");
    messages.push(text);
  };
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const cliPath = join("/app", "node_modules", "auggy", "src", "cli", "index.ts");
    const { buildCli } = await import(cliPath);
    check(typeof buildCli === "function", "Installed public CLI entry changed");
    await buildCli().parseAsync(["state", ...args], { from: "user" });
    check(!process.exitCode, "Public state CLI failed");
    return { cliPath, diagnosticSHA256: hash(messages.join("\n")), diagnosticBytes: size };
  } finally {
    Object.assign(console, original);
  }
}
function guard() {
  const root = rootPin();
  try {
    const bytes = readPinnedFile(
      root.fd,
      MAINTENANCE_PATHS.guard,
      "Replay restore guard",
      16 * 1024,
    );
    const value = JSON.parse(bytes.toString("utf8"));
    check(
      typeof value.latestRestore?.restoreId === "string" &&
        Number.isSafeInteger(value.latestRestore.restoredAtMs),
    );
    return { guard: value, guardSHA256: hash(bytes) };
  } finally {
    closeSync(root.fd);
  }
}
export async function runHostedMaintenanceOperation(
  input: unknown,
): Promise<Record<string, unknown>> {
  const selected = parseHostedMaintenanceOperation(input);
  const label = { operation: selected.operation };
  if (selected.operation === "prepare-empty-volume")
    return { ...label, ...prepareEmptyMaintenanceVolume(MAINTENANCE_PATHS.root) };
  if (selected.operation === "import-manifest") {
    const bytes = decodeMaintenanceTransfer(
      selected.base64,
      selected.sha256,
      MAINTENANCE_LIMITS.manifestBytes,
    );
    const index = indexMaintenanceBundle(bytes);
    mkdirSync(MAINTENANCE_PATHS.bundle, { mode: 0o700 });
    mkdirSync(join(MAINTENANCE_PATHS.bundle, "payload"), { mode: 0o700 });
    writeMaintenanceBundleFile(MAINTENANCE_PATHS.bundle, "manifest.json", bytes);
    createMaintenanceBundleDirectories(MAINTENANCE_PATHS.bundle, index);
    return { ...label, ...index };
  }
  if (selected.operation === "import-file") {
    const { index } = manifest();
    const entry = index.files[selected.index];
    check(entry);
    const bytes = decodeMaintenanceTransfer(
      selected.base64,
      selected.sha256,
      MAINTENANCE_LIMITS.fileBytes,
    );
    check(bytes.byteLength === entry.bytes && selected.sha256 === entry.sha256);
    writeMaintenanceBundleFile(join(MAINTENANCE_PATHS.bundle, "payload"), entry.path, bytes);
    return { ...label, index: selected.index, sha256: entry.sha256, bytes: entry.bytes };
  }
  if (selected.operation === "export-manifest") {
    const verified = await cli(["verify", MAINTENANCE_PATHS.bundle]);
    const { bytes, index } = manifest();
    return { ...label, ...index, base64: bytes.toString("base64"), cli: verified };
  }
  if (selected.operation === "export-file") {
    const { index } = manifest();
    const entry = index.files[selected.index];
    check(entry);
    const bytes = readMaintenanceBundleFile(
      join(MAINTENANCE_PATHS.bundle, "payload"),
      entry.path,
      MAINTENANCE_LIMITS.fileBytes,
    );
    check(bytes.byteLength === entry.bytes && hash(bytes) === entry.sha256);
    return { ...label, index: selected.index, ...entry, base64: bytes.toString("base64") };
  }
  if (selected.operation === "verify")
    return { ...label, cli: await cli(["verify", MAINTENANCE_PATHS.bundle]), ...manifest().index };
  if (selected.operation === "restore") {
    check(
      selected.destinationVolumeId !== selected.stopped.volumeId,
      "Restore must use a fresh distinct volume",
    );
    const root = rootPin();
    try {
      check(readdirSync(root.canonical).length === 0, "Restore destination must be empty");
    } finally {
      closeSync(root.fd);
    }
    const verified = await cli([
      "restore",
      MAINTENANCE_PATHS.bundle,
      "--config",
      MAINTENANCE_PATHS.config,
      "--root",
      MAINTENANCE_PATHS.root,
      "--runtime-root",
      MAINTENANCE_PATHS.root,
      "--confirm-stopped",
      "--runtime-volume-only",
    ]);
    const release = acquireLease();
    try {
      return {
        ...label,
        cli: verified,
        singletonLeaseAcquired: true,
        stopped: selected.stopped,
        destinationVolumeId: selected.destinationVolumeId,
        ...guard(),
      };
    } finally {
      release();
    }
  }
  const release = acquireLease();
  try {
    if (selected.operation === "backup")
      return {
        ...label,
        cli: await cli([
          "backup",
          "--config",
          MAINTENANCE_PATHS.config,
          "--root",
          MAINTENANCE_PATHS.root,
          "--out",
          MAINTENANCE_PATHS.bundle,
          "--confirm-stopped",
          "--runtime-volume-only",
        ]),
        ...manifest().index,
        stopped: selected.stopped,
        singletonLeaseAcquired: true,
      };
    if (selected.operation === "guard")
      return { ...label, ...guard(), stopped: selected.stopped, singletonLeaseAcquired: true };
    const workerReplay =
      selected.operation === "reconcile-worker"
        ? (() => {
            check(
              manifest().index.manifestSHA256 === selected.backupManifestSHA256,
              "Worker backup identity differs",
            );
            return readWorkerReplay();
          })()
        : undefined;
    const before = guard();
    const verified = await cli([
      "reconcile",
      "--root",
      MAINTENANCE_PATHS.root,
      "--restore-id",
      selected.restoreId,
      "--confirm-downstream-reconciled",
    ]);
    const after = guard();
    check(before.guardSHA256 === after.guardSHA256, "Reconcile changed assertion guard");
    return {
      ...label,
      cli: verified,
      ...after,
      stopped: selected.stopped,
      singletonLeaseAcquired: true,
      ...(selected.operation === "reconcile-worker"
        ? {
            sealedGenerationReceiptSHA256: selected.sealedGenerationReceiptSHA256,
            backupManifestSHA256: selected.backupManifestSHA256,
            confirmedUpdateIds: selected.confirmedUpdateIds,
            workerReplay,
          }
        : {
            downstreamCheckpointSHA256: selected.downstreamCheckpointSHA256,
            unreplayedOperationId: selected.unreplayedOperationId,
            outcome: selected.outcome,
          }),
    };
  } finally {
    release();
  }
}
if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--hold") {
    // This maintenance profile opens no listener and never starts Auggy.
    const deadline = setTimeout(() => {
      console.error("auggy-g4-maintenance:lifetime-expired");
      process.exit(70);
    }, MAINTENANCE_LIMITS.lifetimeMs);
    console.log("auggy-g4-maintenance:ready");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(signal, () => {
        clearTimeout(deadline);
        process.exit(0);
      });
  } else {
    try {
      check(process.argv.length === 2);
      const bytes = Buffer.from(await Bun.stdin.arrayBuffer());
      check(bytes.byteLength <= MAINTENANCE_LIMITS.totalBytes);
      const request = JSON.parse(bytes.toString("utf8"));
      check(
        request.version === 1 &&
          request.operation === "execute" &&
          request.commandId === "maintenance",
      );
      const selected = parseHostedMaintenanceOperation(request.payload);
      let result: Record<string, unknown>;
      try {
        result = await runHostedMaintenanceOperation(selected);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const reason =
          message === "A live replica still owns the runtime volume"
            ? "runtime-lease-busy"
            : message === "Restore destination must be empty"
              ? "restore-not-empty"
              : "operation-rejected";
        result = { operation: selected.operation, rejected: true, reason };
        process.exitCode = 1;
      }
      console.log(
        JSON.stringify({
          version: 1,
          requestId: request.requestId,
          commandId: request.commandId,
          inputSHA256: hash(bytes),
          result,
        }),
      );
    } catch {
      process.exitCode = 1;
    }
  }
}

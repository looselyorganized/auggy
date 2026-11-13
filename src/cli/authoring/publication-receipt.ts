/** Passive receipt decoding and rollback planning. No lease, writer, or FFI imports. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORING_LIMITS,
  type ExistingFileSnapshot,
  type FileIdentity,
  type FileSnapshot,
  type MutationKind,
  type OperationReceipt,
  type ReceiptFileVersion,
  type ReceiptPhase,
  type ReceiptStep,
  type RollbackFile,
  type RollbackPlan,
  type SafeDiagnostic,
} from "./contracts";
import { AuthoringError, readFileSnapshot } from "./document-io";
import {
  assertPrivate,
  canonicalProject,
  containedSnapshot,
  fail,
  HASH,
  hash,
  IGNORE_SUFFIX,
  listBounded,
  matches,
  OPERATION_ID,
  safeRelative,
} from "./publication-common";

const kinds = new Set<MutationKind>([
  "init",
  "augment-add",
  "augment-create",
  "augment-install",
  "augment-remove",
  "agentmail-config",
  "migrate",
]);
const phases = new Set<ReceiptPhase>([
  "preparing",
  "prepared",
  "publishing",
  "activated",
  "complete",
  "rolling-back",
  "rolled-back",
  "conflicted",
]);
function invalid(): never {
  return fail(
    "receipt-invalid",
    "The private operation receipt is invalid; preserve it for manual recovery.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) return invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}
function path(value: unknown): string {
  if (typeof value !== "string") return invalid();
  return safeRelative(value);
}
function fileVersion(value: unknown, extra: readonly string[] = []): ReceiptFileVersion {
  const item = object(value);
  keys(item, ["sha256", "size", "mode", ...extra]);
  return {
    sha256: digest(item.sha256),
    size: integer(item.size, AUTHORING_LIMITS.outputBytes),
    mode: integer(item.mode, 0o777),
  };
}
function identity(value: unknown): FileIdentity {
  const item = object(value);
  keys(item, ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"]);
  for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"])
    if (typeof item[key] !== "string" || !/^\d{1,30}$/.test(item[key] as string)) invalid();
  return {
    dev: item.dev as string,
    ino: item.ino as string,
    size: integer(item.size, AUTHORING_LIMITS.outputBytes),
    mode: integer(item.mode, 0xffff),
    mtimeNs: item.mtimeNs as string,
    ctimeNs: item.ctimeNs as string,
  };
}

function decode(bytes: Uint8Array, projectDir: string, operationId: string): OperationReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  const item = object(parsed);
  keys(item, [
    "schemaVersion",
    "id",
    "kind",
    "project",
    "configRelativePath",
    "fingerprint",
    "createdAt",
    "phase",
    "ignoreBootstrap",
    "steps",
  ]);
  if (
    item.schemaVersion !== 1 ||
    item.id !== operationId ||
    !kinds.has(item.kind as MutationKind) ||
    !phases.has(item.phase as ReceiptPhase)
  )
    invalid();
  const project = object(item.project);
  keys(project, ["canonicalPath", "dev", "ino"]);
  const stat = lstatSync(projectDir, { bigint: true });
  if (
    project.canonicalPath !== projectDir ||
    project.dev !== String(stat.dev) ||
    project.ino !== String(stat.ino)
  )
    invalid();
  const configRelativePath = path(item.configRelativePath);
  if (
    configRelativePath === ".env" ||
    configRelativePath === ".gitignore" ||
    configRelativePath.split("/")[0]!.toLowerCase() === ".auggy"
  )
    invalid();
  if (
    typeof item.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.createdAt) ||
    !Number.isFinite(Date.parse(item.createdAt))
  )
    invalid();
  if (
    !Array.isArray(item.steps) ||
    item.steps.length === 0 ||
    item.steps.length > AUTHORING_LIMITS.plannedWrites
  )
    invalid();
  const rawSteps = item.steps;
  const paths = new Set<string>();
  let activationCount = 0;
  let total = 0;
  let originals = 0;
  const steps: ReceiptStep[] = rawSteps.map((entry, index) => {
    const step = object(entry);
    keys(step, [
      "relativePath",
      "role",
      "before",
      "after",
      "published",
      "rollbackComplete",
      "outputIdentity",
    ]);
    const relativePath = path(step.relativePath);
    const folded = relativePath.normalize("NFC").toLowerCase();
    if (
      paths.has(folded) ||
      (folded.split("/").some((segment) => segment === ".auggy" || segment === ".git") &&
        !(
          relativePath === ".auggy/models.lock.json" &&
          item.kind === "init" &&
          step.role === "support" &&
          step.before === null &&
          object(step.after).mode === 0o600
        ))
    )
      invalid();
    paths.add(folded);
    if (!["support", "activation", "ignore", "new-env"].includes(step.role as string)) invalid();
    if ((relativePath === ".gitignore") !== (step.role === "ignore")) invalid();
    if (
      (relativePath === ".env") !== (step.role === "new-env") ||
      (step.role === "new-env" && (item.kind !== "init" || step.before !== null))
    )
      invalid();
    if (step.role === "activation") {
      activationCount++;
      if (relativePath !== configRelativePath || index !== rawSteps.length - 1) invalid();
    }
    let before: ReceiptStep["before"] = null;
    if (step.before !== null) {
      const value = fileVersion(step.before, ["backupPath"]);
      const backupPath = object(step.before).backupPath;
      if (backupPath !== `backup-${index}.bin`) invalid();
      before = { ...value, backupPath: backupPath as string };
      originals += value.size;
    }
    const after = fileVersion(step.after, ["stagePath"]);
    if (object(step.after).stagePath !== `stage-${index}.bin`) invalid();
    total += after.size;
    return {
      relativePath,
      role: step.role as ReceiptStep["role"],
      before,
      after: { ...after, stagePath: `stage-${index}.bin` },
      published: bool(step.published),
      rollbackComplete: bool(step.rollbackComplete),
      ...(step.outputIdentity !== undefined
        ? { outputIdentity: identity(step.outputIdentity) }
        : {}),
    };
  });
  if (
    activationCount !== 1 ||
    total > AUTHORING_LIMITS.aggregateOutputBytes ||
    originals > AUTHORING_LIMITS.aggregateInputBytes + AUTHORING_LIMITS.outputBytes
  )
    invalid();
  let ignoreBootstrap: OperationReceipt["ignoreBootstrap"];
  if (item.ignoreBootstrap !== undefined) {
    const bootstrap = object(item.ignoreBootstrap);
    keys(bootstrap, ["relativePath", "before", "appendedSuffix", "after", "published"]);
    if (bootstrap.relativePath !== ".gitignore" || bootstrap.appendedSuffix !== IGNORE_SUFFIX)
      invalid();
    const before = bootstrap.before === null ? null : fileVersion(bootstrap.before);
    const after = fileVersion(bootstrap.after);
    if (
      after.size !== (before?.size ?? 0) + Buffer.byteLength(IGNORE_SUFFIX) ||
      after.mode !== (before?.mode ?? 0o644)
    )
      invalid();
    const ignore = steps.find((step) => step.role === "ignore");
    if (
      !ignore ||
      !!ignore.before !== !!before ||
      (before && ignore.before?.sha256 !== before.sha256)
    )
      invalid();
    ignoreBootstrap = {
      relativePath: ".gitignore",
      before,
      appendedSuffix: IGNORE_SUFFIX,
      after,
      published: bool(bootstrap.published),
    };
  }
  return {
    schemaVersion: 1,
    id: operationId,
    kind: item.kind as MutationKind,
    project: { canonicalPath: projectDir, dev: String(stat.dev), ino: String(stat.ino) },
    configRelativePath,
    fingerprint: digest(item.fingerprint),
    createdAt: item.createdAt,
    phase: item.phase as ReceiptPhase,
    ...(ignoreBootstrap ? { ignoreBootstrap } : {}),
    steps,
  };
}

export function receiptPath(projectDir: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) invalid();
  return join(projectDir, ".auggy", "operations", operationId, "receipt.json");
}

export function readReceiptBundle(
  projectDir: string,
  operationId: string,
): { receipt: OperationReceipt; snapshot: ExistingFileSnapshot; directory: string } {
  const project = canonicalProject(projectDir);
  receiptPath(project, operationId);
  const directory = join(project, ".auggy", "operations", operationId);
  for (const dir of [join(project, ".auggy"), join(project, ".auggy", "operations"), directory])
    assertPrivate(dir, true);
  const location = receiptPath(project, operationId);
  assertPrivate(location, false);
  const snapshot = readFileSnapshot(location, AUTHORING_LIMITS.receiptBytes);
  if (!snapshot.exists) return invalid();
  assertPrivate(location, false);
  return { receipt: decode(snapshot.bytes, project, operationId), snapshot, directory };
}

export function readOperationReceipt(projectDir: string, operationId: string): OperationReceipt {
  try {
    return readReceiptBundle(projectDir, operationId).receipt;
  } catch (error) {
    if (error instanceof Error && error.name === "AuthoringError") throw error;
    return invalid();
  }
}

export function listOperationIds(projectDir: string): string[] {
  const base = join(projectDir, ".auggy", "operations");
  try {
    lstatSync(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  assertPrivate(join(projectDir, ".auggy"), true);
  assertPrivate(base, true);
  const ids = listBounded(base);
  if (ids.some((id) => !OPERATION_ID.test(id))) invalid();
  return ids.sort();
}

export function receiptArtifacts(
  directory: string,
  receipt: OperationReceipt,
  diagnostics?: SafeDiagnostic[],
): FileSnapshot[] {
  const allowed = new Set([
    "receipt.json",
    "receipt.next",
    ...receipt.steps.flatMap((step) => [
      step.after.stagePath,
      ...(step.before ? [step.before.backupPath] : []),
    ]),
  ]);
  const stageModes = (name: string): number[] => {
    const step = receipt.steps.find((entry) => entry.after.stagePath === name);
    return step
      ? [
          0o600,
          step.after.mode,
          ...(["rolling-back", "conflicted"].includes(receipt.phase) && step.before
            ? [step.before.mode]
            : []),
        ]
      : [0o600];
  };
  for (const name of listBounded(directory)) {
    if (!allowed.has(name)) invalid();
    assertPrivate(join(directory, name), false, stageModes(name));
  }
  const snapshots: FileSnapshot[] = [];
  const recovering = ["rolling-back", "conflicted"].includes(receipt.phase);
  const limit =
    AUTHORING_LIMITS.aggregateOutputBytes +
    AUTHORING_LIMITS.aggregateInputBytes +
    AUTHORING_LIMITS.outputBytes * (recovering ? 2 : 1);
  let total = 0;
  for (const step of receipt.steps) {
    const entries = [
      {
        name: step.after.stagePath,
        maxBytes: Math.max(step.after.size, recovering ? (step.before?.size ?? 0) : 0),
      },
      ...(step.before ? [{ name: step.before.backupPath, maxBytes: step.before.size }] : []),
    ];
    for (const entry of entries) {
      let snapshot: FileSnapshot;
      try {
        snapshot = readFileSnapshot(
          join(directory, entry.name),
          Math.min(entry.maxBytes, limit - total),
          { allowMissing: true },
        );
      } catch (error) {
        if (error instanceof AuthoringError && error.code === "file-too-large") {
          if (diagnostics) {
            diagnostics.push(conflict(step.relativePath));
            continue;
          }
          fail(
            "rollback-conflict",
            "A private recovery copy exceeds its recorded size; preserve it for manual review.",
          );
        }
        throw error;
      }
      if (snapshot.exists) {
        assertPrivate(snapshot.path, false, stageModes(entry.name));
        total += snapshot.bytes.byteLength;
      }
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

/** True only after checking finite, private receipt directories. */
export function otherSensitiveReceipts(project: string, operationId: string): boolean {
  for (const id of listOperationIds(project)) {
    if (id === operationId) continue;
    const bundle = readReceiptBundle(project, id);
    if (receiptArtifacts(bundle.directory, bundle.receipt).some((entry) => entry.exists))
      return true;
  }
  return false;
}

function conflict(path: string): SafeDiagnostic {
  return {
    code: "rollback-conflict",
    path,
    message:
      "The recorded file or private recovery copy changed; preserve it and review the operation before recovery.",
  };
}

function owned(snapshot: ExistingFileSnapshot, step: ReceiptStep): boolean {
  return (
    !step.outputIdentity ||
    (snapshot.identity.dev === step.outputIdentity.dev &&
      snapshot.identity.ino === step.outputIdentity.ino)
  );
}

function bootstrapOriginal(
  snapshot: FileSnapshot,
  receipt: OperationReceipt,
): Uint8Array | undefined {
  const bootstrap = receipt.ignoreBootstrap;
  if (!bootstrap || !snapshot.exists || !matches(snapshot, bootstrap.after)) return undefined;
  const prefix = snapshot.bytes.subarray(0, bootstrap.before?.size ?? 0);
  const suffix = snapshot.bytes.subarray(prefix.byteLength);
  if (
    Buffer.from(suffix).toString("utf8") !== IGNORE_SUFFIX ||
    (bootstrap.before && hash(prefix) !== bootstrap.before.sha256)
  )
    return undefined;
  return prefix;
}

export function planRollback(projectDir: string, operationId: string): RollbackPlan {
  try {
    const project = canonicalProject(projectDir);
    const { receipt, snapshot, directory } = readReceiptBundle(project, operationId);
    const diagnostics: SafeDiagnostic[] = [];
    const files: RollbackFile[] = [];
    const inputs: FileSnapshot[] = [snapshot];
    const artifacts = receiptArtifacts(directory, receipt, diagnostics);
    inputs.push(...artifacts);
    const artifactMap = new Map(artifacts.map((entry) => [entry.path, entry]));
    let currentBytes = 0;
    const currentLimit =
      AUTHORING_LIMITS.aggregateOutputBytes +
      AUTHORING_LIMITS.aggregateInputBytes +
      AUTHORING_LIMITS.outputBytes;
    for (const step of receipt.steps) {
      const expectedSize = Math.max(
        step.before?.size ?? 0,
        step.after.size,
        step.role === "ignore" ? (receipt.ignoreBootstrap?.after.size ?? 0) : 0,
      );
      let current: FileSnapshot;
      try {
        current = containedSnapshot(
          project,
          step.relativePath,
          Math.min(expectedSize, currentLimit - currentBytes),
        );
      } catch (error) {
        if (error instanceof AuthoringError && error.code === "file-too-large") {
          diagnostics.push(conflict(step.relativePath));
          continue;
        }
        throw error;
      }
      if (current.exists) currentBytes += current.bytes.byteLength;
      inputs.push(current);
      const stage = artifactMap.get(join(directory, step.after.stagePath));
      if (
        stage?.exists &&
        (stage.sha256 !== step.after.sha256 || stage.bytes.byteLength !== step.after.size) &&
        !(
          ["rolling-back", "conflicted"].includes(receipt.phase) &&
          step.before &&
          stage.sha256 === step.before.sha256 &&
          stage.bytes.byteLength === step.before.size
        )
      )
        diagnostics.push(conflict(step.relativePath));
      const backup = step.before
        ? artifactMap.get(join(directory, step.before.backupPath))
        : undefined;
      if (
        backup?.exists &&
        step.before &&
        (backup.sha256 !== step.before.sha256 || backup.bytes.byteLength !== step.before.size)
      ) {
        diagnostics.push(conflict(step.relativePath));
        continue;
      }
      if (matches(current, step.before)) {
        // A missing owned output after a completed publication is an operator conflict.
        if (
          !current.exists &&
          step.published &&
          !step.rollbackComplete &&
          !["rolling-back", "rolled-back"].includes(receipt.phase)
        )
          diagnostics.push(conflict(step.relativePath));
        continue;
      }
      const isBootstrap =
        step.role === "ignore" &&
        !!receipt.ignoreBootstrap &&
        matches(current, receipt.ignoreBootstrap.after);
      if (
        !current.exists ||
        (!matches(current, step.after) && !isBootstrap) ||
        (!step.before && !isBootstrap && !owned(current, step))
      ) {
        diagnostics.push(conflict(step.relativePath));
        continue;
      }
      if (step.before) {
        const original = backup?.exists
          ? backup.bytes
          : step.role === "ignore"
            ? bootstrapOriginal(current, receipt)
            : undefined;
        if (
          !original ||
          hash(original) !== step.before.sha256 ||
          original.byteLength !== step.before.size
        ) {
          diagnostics.push(conflict(step.relativePath));
          continue;
        }
        files.push({
          kind: "restore",
          relativePath: step.relativePath,
          expected: current,
          bytes: original,
          mode: step.before.mode,
        });
      } else
        files.push({ kind: "remove-owned", relativePath: step.relativePath, expected: current });
    }
    let receiptBytes = snapshot.bytes.byteLength;
    for (const id of listOperationIds(project)) {
      if (id === operationId) continue;
      const other = readReceiptBundle(project, id);
      receiptBytes += other.snapshot.bytes.byteLength;
      if (receiptBytes > AUTHORING_LIMITS.aggregateInputBytes)
        fail("receipt-limit", "Recovery receipt metadata exceeds its aggregate byte limit.");
      inputs.push(other.snapshot);
      if (
        other.receipt.phase !== "rolled-back" &&
        other.receipt.createdAt >= receipt.createdAt &&
        other.receipt.steps.some(
          (step) =>
            step.role !== "ignore" &&
            receipt.steps.some((own) => own.relativePath === step.relativePath),
        )
      ) {
        diagnostics.push({
          code: "rollback-intervening",
          message:
            "A later authoring operation affects these files; recover the later operation first.",
        });
      }
    }
    files.sort((a, b) => {
      const rank = (file: RollbackFile) =>
        file.relativePath === receipt.configRelativePath
          ? 0
          : file.relativePath === ".gitignore"
            ? 2
            : 1;
      return rank(a) - rank(b);
    });
    return {
      projectDir: project,
      operationId,
      receipt: snapshot,
      inputs,
      files,
      summary: files.map((file) => ({
        path: file.relativePath,
        operation: file.kind,
        reason:
          file.kind === "restore"
            ? "Restore the verified original file."
            : "Remove this operation's unchanged new file.",
      })),
      diagnostics: diagnostics.slice(0, AUTHORING_LIMITS.diagnostics),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AuthoringError") throw error;
    return invalid();
  }
}

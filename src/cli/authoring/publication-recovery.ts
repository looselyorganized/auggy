/** Effectful guarded recovery, kept separate from passive receipt planning. */
import { closeSync } from "node:fs";
import { join } from "node:path";
import { unlinkAt } from "../../lib/posix-at";
import {
  AUTHORING_LIMITS,
  type OperationReceipt,
  type PublicationOptions,
  type PublicationResult,
  type RollbackFile,
  type RollbackPlan,
  type SafeDiagnostic,
} from "./contracts";
import { AuthoringError } from "./document-io";
import {
  assertSnapshot,
  canonicalProject,
  containedSnapshot,
  fail,
  matches,
  sameSnapshot,
} from "./publication-common";
import {
  checkedDestination,
  flushDirectory,
  operationDirectory,
  persistReceipt,
  publishStage,
  removeOwned,
  writeContext,
  writePrivate,
  verifyOperationDirectory,
} from "./publication-files";
import { acquireProjectMutationLease } from "./publication-lease";
import {
  otherSensitiveReceipts,
  planRollback,
  readReceiptBundle,
  receiptArtifacts,
} from "./publication-receipt";

/** Configuration proof is independent of phase/progress and of support-file cleanup. */
export function observeActivation(
  project: string,
  receipt: OperationReceipt,
): PublicationResult["activation"] {
  try {
    const step = receipt.steps.find((entry) => entry.role === "activation");
    if (!step) return "unknown";
    const current = containedSnapshot(project, step.relativePath);
    if (matches(current, step.before)) return "original";
    if (matches(current, step.after)) return "output";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function diagnostic(error: unknown): SafeDiagnostic {
  return error instanceof AuthoringError
    ? error.diagnostic
    : {
        code: "rollback-failed",
        message:
          "Guarded rollback was interrupted. Preserve the private operation receipt and retry recovery after reviewing conflicts.",
      };
}

export function applyRollback(
  input: RollbackPlan,
  options: PublicationOptions = {},
): PublicationResult {
  const project = canonicalProject(input.projectDir);
  // Public callers cannot turn RollbackFile into a general delete/restore interface.
  assertSnapshot(input.receipt);
  for (const expected of input.inputs) assertSnapshot(expected);
  const lease = options.lease ?? acquireProjectMutationLease(project);
  const ownsLease = !options.lease;
  let operationFd: number | undefined;
  let receipt: OperationReceipt | undefined;
  const changed: string[] = [];
  const diagnostics: SafeDiagnostic[] = [];
  try {
    const context = writeContext(lease, project);
    const fresh = planRollback(project, input.operationId);
    if (!sameSnapshot(input.receipt, fresh.receipt))
      fail(
        "rollback-stale",
        "The recovery receipt changed; preview rollback again before applying.",
      );
    receipt = readReceiptBundle(project, input.operationId).receipt;
    if (fresh.diagnostics.length)
      return {
        status: "recovery-required",
        activation: observeActivation(project, receipt),
        operationId: receipt.id,
        changedPaths: [],
        diagnostics: fresh.diagnostics,
      };
    for (const expected of fresh.inputs) assertSnapshot(expected);
    for (const file of fresh.files) {
      const parent = checkedDestination(context, file.relativePath, file.expected, false);
      if (parent) closeSync(parent.fd);
    }
    operationFd = operationDirectory(context, receipt.id, false);
    receipt = { ...receipt, phase: "rolling-back" };
    persistReceipt(operationFd, receipt);
    const boundary = (
      name: Parameters<NonNullable<PublicationOptions["fault"]>>[0]["boundary"],
      path?: string,
    ) =>
      options.fault?.({
        boundary: name,
        operationId: input.operationId,
        ...(path ? { path } : {}),
      });
    const directory = join(project, ".auggy", "operations", receipt.id);
    const remaining = new Map(fresh.files.map((file) => [file.relativePath, file]));
    const validateRemaining = () => {
      verifyOperationDirectory(context, input.operationId, operationFd!);
      for (const step of receipt!.steps) {
        if (
          !remaining.has(step.relativePath) &&
          !matches(containedSnapshot(project, step.relativePath), step.before)
        )
          fail(
            "rollback-conflict",
            "An already restored original changed; preserve the remaining recovery copies.",
          );
      }
      for (const file of remaining.values()) {
        const parent = checkedDestination(context, file.relativePath, file.expected, false);
        if (parent) closeSync(parent.fd);
      }
    };
    const markRestored = (path: string) => {
      receipt = {
        ...receipt!,
        steps: receipt!.steps.map((step) =>
          step.relativePath === path ? { ...step, rollbackComplete: true } : step,
        ),
      };
      persistReceipt(operationFd!, receipt);
    };
    const restore = (file: RollbackFile) => {
      boundary("before-rollback-file", file.relativePath);
      validateRemaining();
      const index = receipt!.steps.findIndex((step) => step.relativePath === file.relativePath);
      const step = receipt!.steps[index]!;
      if (file.kind === "remove-owned") removeOwned(context, file.relativePath, file.expected);
      else {
        const source = step.after.stagePath;
        const previous = receiptArtifacts(directory, receipt!).find(
          (entry) => entry.path === join(directory, source),
        );
        if (previous?.exists) {
          if (
            !(
              (previous.sha256 === step.after.sha256 &&
                previous.bytes.byteLength === step.after.size) ||
              (step.before &&
                previous.sha256 === step.before.sha256 &&
                previous.bytes.byteLength === step.before.size)
            )
          )
            fail("rollback-conflict", "The private recovery stage changed.");
          assertSnapshot(previous);
          if (!unlinkAt(operationFd!, source))
            fail("rollback-cleanup", "A verified recovery stage could not be cleared.");
        }
        writePrivate(operationFd!, source, file.bytes);
        publishStage(
          context,
          operationFd!,
          source,
          file.relativePath,
          file.expected,
          file.bytes,
          file.mode,
        );
      }
      changed.push(file.relativePath);
      remaining.delete(file.relativePath);
      if (!matches(containedSnapshot(project, file.relativePath), step.before))
        fail("rollback-conflict", "A restored original changed before recovery could be recorded.");
      markRestored(file.relativePath);
      boundary("after-rollback-file", file.relativePath);
      validateRemaining();
    };
    for (const file of fresh.files) if (file.relativePath !== ".gitignore") restore(file);
    // Every non-ignore original is proved before removing the last private recovery bytes.
    for (const step of receipt.steps)
      if (
        step.role !== "ignore" &&
        !matches(containedSnapshot(project, step.relativePath), step.before)
      )
        fail("rollback-conflict", "A rollback destination changed before private cleanup.");
    boundary("before-sensitive-cleanup");
    validateRemaining();
    const artifacts = receiptArtifacts(directory, receipt);
    for (const artifact of artifacts) {
      if (!artifact.exists) continue;
      validateRemaining();
      assertSnapshot(artifact);
      const step = receipt.steps.find(
        (entry) =>
          artifact.path === join(directory, entry.after.stagePath) ||
          (entry.before && artifact.path === join(directory, entry.before.backupPath)),
      )!;
      const original = artifact.path === join(directory, step.before?.backupPath ?? "");
      const expected = original ? step.before! : step.after;
      if (
        (artifact.sha256 !== expected.sha256 || artifact.bytes.byteLength !== expected.size) &&
        !(
          ["rolling-back", "conflicted"].includes(receipt.phase) &&
          step.before &&
          artifact.sha256 === step.before.sha256 &&
          artifact.bytes.byteLength === step.before.size
        )
      )
        fail(
          "rollback-conflict",
          "A private recovery copy changed before cleanup; ignore protection is retained.",
        );
      const name = artifact.path.slice(directory.length + 1);
      if (!unlinkAt(operationFd, name))
        fail(
          "rollback-cleanup",
          "Sensitive recovery copies could not be removed; ignore protection is retained.",
        );
    }
    flushDirectory(operationFd);
    boundary("after-sensitive-cleanup");
    validateRemaining();
    const ignore = remaining.get(".gitignore");
    if (ignore) {
      const finalOriginalRule =
        ignore.kind === "restore"
          ? new TextDecoder()
              .decode(ignore.bytes)
              .split(/\r?\n/)
              .filter((line) => line !== "" && !line.startsWith("#"))
              .at(-1)
          : undefined;
      const originalKeepsProtection =
        finalOriginalRule === ".auggy/" || finalOriginalRule === "/.auggy/";
      if (otherSensitiveReceipts(project, receipt.id) && !originalKeepsProtection) {
        diagnostics.push({
          code: "rollback-ignore-retained",
          path: ".gitignore",
          message:
            "Ignore protection is retained because another operation still has private recovery copies.",
        });
      } else restore(ignore);
    }
    validateRemaining();
    receipt = {
      ...receipt,
      phase: "rolled-back",
      steps: receipt.steps.map((step) => ({
        ...step,
        rollbackComplete:
          step.role === "ignore" && diagnostics.length > 0 ? step.rollbackComplete : true,
      })),
    };
    persistReceipt(operationFd, receipt);
    const activation = observeActivation(project, receipt);
    if (activation !== "original")
      return {
        status: "recovery-required",
        activation,
        operationId: receipt.id,
        changedPaths: changed,
        diagnostics: [
          ...diagnostics,
          {
            code: "rollback-activation",
            message: "The original central configuration could not be verified after recovery.",
          },
        ],
      };
    return {
      status: "rolled-back",
      activation,
      operationId: receipt.id,
      changedPaths: changed,
      diagnostics,
    };
  } catch (error) {
    if (!receipt) {
      if (error instanceof AuthoringError) throw error;
      return fail(
        "rollback-preflight",
        "Recovery preflight failed safely; review the private receipt and file permissions.",
      );
    }
    // Do not invent progress after a failed journal update: actual hashes govern retry.
    return {
      status: "recovery-required",
      activation: observeActivation(project, receipt),
      operationId: receipt.id,
      changedPaths: changed,
      diagnostics: [...diagnostics, diagnostic(error)].slice(0, AUTHORING_LIMITS.diagnostics),
    };
  } finally {
    if (operationFd !== undefined) closeSync(operationFd);
    if (ownsLease) lease.release();
  }
}

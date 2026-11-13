import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";
import { unlinkAt } from "../../lib/posix-at";
import {
  AUTHORING_LIMITS,
  type FileSnapshot,
  type MutationPlan,
  type OperationReceipt,
  type PlannedFile,
  type PublicationOptions,
  type PublicationResult,
  type ReceiptStep,
} from "./contracts";
import { AuthoringError } from "./document-io";
import { createMutationPlan } from "./mutation";
import {
  assertSnapshot,
  canonicalProject,
  containedSnapshot,
  fail,
  IGNORE_SUFFIX,
  matches,
  sameSnapshot,
  version,
} from "./publication-common";
import {
  appendIgnore,
  checkedDestination,
  operationDirectory,
  persistReceipt,
  publishStage,
  writeContext,
  writePrivate,
  verifyOperationDirectory,
} from "./publication-files";
import { acquireProjectMutationLease, validateProjectLease } from "./publication-lease";
import { listOperationIds, planRollback, readOperationReceipt } from "./publication-receipt";
import { applyRollback, observeActivation } from "./publication-recovery";

export { acquireProjectMutationLease } from "./publication-lease";
export { readOperationReceipt, planRollback } from "./publication-receipt";
export { applyRollback } from "./publication-recovery";

function diagnostic(error: unknown) {
  return error instanceof AuthoringError
    ? error.diagnostic
    : {
        code: "publication-failed",
        message:
          "Authoring publication failed. Review the private operation receipt and use guarded rollback before retrying.",
      };
}

/** Narrow file publication. The credential lock remains separate and is acquired second by callers. */
export function publishMutationPlan(
  input: MutationPlan,
  options: PublicationOptions = {},
): PublicationResult {
  const plan = createMutationPlan(input);
  if (plan.schemaVersion !== input.schemaVersion || plan.fingerprint !== input.fingerprint)
    fail("publication-plan", "The authoring plan changed; recompute it before applying.");
  const project = canonicalProject(plan.projectDir);
  for (const snapshot of plan.inputs) assertSnapshot(snapshot);
  const ignoreBefore = containedSnapshot(project, ".gitignore");
  const requestedIgnore = plan.files.find((file) => file.role === "ignore");
  const privateInputs = new Map(
    [...plan.inputs, ignoreBefore].map((snapshot) => [snapshot.path, snapshot]),
  );
  if (
    [...privateInputs.values()].reduce(
      (total, snapshot) => total + (snapshot.exists ? snapshot.bytes.byteLength : 0),
      0,
    ) >
    AUTHORING_LIMITS.aggregateInputBytes + AUTHORING_LIMITS.outputBytes
  )
    fail(
      "publication-limit",
      "The publication inputs and ignore preimage exceed the authoring byte limit.",
    );
  if (requestedIgnore && !sameSnapshot(requestedIgnore.before, ignoreBefore))
    fail("publication-stale", "The ignore file changed; recompute the plan.");
  if (requestedIgnore) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(requestedIgnore.bytes);
    } catch {
      return fail("publication-ignore", "The generated ignore file must be valid UTF-8.");
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    if (
      !lines.some((line) => line === ".auggy/" || line === "/.auggy/") ||
      lines.some((line) => line.startsWith("!"))
    )
      fail(
        "publication-ignore",
        "Generated ignore files must retain .auggy/ protection without negating ignore rules.",
      );
  }
  // Always append a final rule: earlier negations or tracked ignore content cannot cancel it.
  const ignoreOutput = Buffer.concat([
    ignoreBefore.exists ? ignoreBefore.bytes : Buffer.alloc(0),
    Buffer.from(IGNORE_SUFFIX),
  ]);
  const ignoreFile: PlannedFile = requestedIgnore ?? {
    relativePath: ".gitignore",
    before: ignoreBefore,
    bytes: ignoreOutput,
    mode: ignoreBefore.exists ? ignoreBefore.identity.mode & 0o777 : 0o644,
    role: "ignore",
  };
  const files = [
    ignoreFile,
    ...plan.files.filter((file) => file.role !== "ignore" && file.role !== "activation"),
    ...plan.files.filter((file) => file.role === "activation"),
  ];
  if (
    files.length > AUTHORING_LIMITS.plannedWrites ||
    ignoreOutput.byteLength > AUTHORING_LIMITS.outputBytes ||
    files.reduce((total, file) => total + file.bytes.byteLength, 0) >
      AUTHORING_LIMITS.aggregateOutputBytes
  )
    fail("publication-limit", "The publication and ignore protection exceed the authoring limits.");
  const lease = options.lease ?? acquireProjectMutationLease(project);
  const ownsLease = !options.lease;
  let operationFd: number | undefined;
  let receipt: OperationReceipt | undefined;
  const operationId = randomUUID();
  let started = false;
  try {
    const context = writeContext(lease, project);
    for (const id of listOperationIds(project)) {
      const previous = readOperationReceipt(project, id);
      if (!["complete", "rolled-back"].includes(previous.phase))
        fail(
          "publication-unresolved",
          `An unresolved authoring operation requires guarded rollback before retrying: ${id}.`,
        );
    }
    for (const file of files) {
      const parent = checkedDestination(context, file.relativePath, file.before, false);
      if (parent) closeSync(parent.fd);
    }
    for (const snapshot of plan.inputs) assertSnapshot(snapshot);
    const state = validateProjectLease(lease, project);
    receipt = {
      schemaVersion: 1,
      id: operationId,
      kind: plan.kind,
      project: { canonicalPath: project, dev: state.dev, ino: state.ino },
      configRelativePath: plan.configRelativePath,
      fingerprint: plan.fingerprint,
      createdAt: new Date().toISOString(),
      phase: "preparing",
      ignoreBootstrap: {
        relativePath: ".gitignore",
        before: ignoreBefore.exists
          ? version(ignoreBefore.bytes, ignoreBefore.identity.mode)
          : null,
        appendedSuffix: IGNORE_SUFFIX,
        after: version(ignoreOutput, ignoreBefore.exists ? ignoreBefore.identity.mode : 0o644),
        published: false,
      },
      steps: files.map(
        (file, index): ReceiptStep => ({
          relativePath: file.relativePath,
          role: file.role,
          before: file.before.exists
            ? {
                ...version(file.before.bytes, file.before.identity.mode),
                backupPath: `backup-${index}.bin`,
              }
            : null,
          after: { ...version(file.bytes, file.mode), stagePath: `stage-${index}.bin` },
          published: false,
          rollbackComplete: false,
        }),
      ),
    };
    operationFd = operationDirectory(context, operationId, true);
    started = true;
    persistReceipt(operationFd, receipt);
    const boundary = (
      name: Parameters<NonNullable<PublicationOptions["fault"]>>[0]["boundary"],
      path?: string,
    ) => options.fault?.({ boundary: name, operationId, ...(path ? { path } : {}) });
    boundary("before-ignore");
    for (const snapshot of plan.inputs) assertSnapshot(snapshot);
    const protectedIgnore = appendIgnore(context, ignoreBefore, Buffer.from(IGNORE_SUFFIX));
    if (!matches(protectedIgnore, receipt.ignoreBootstrap!.after))
      fail(
        "publication-ignore",
        "Ignore protection could not be verified before private file copies.",
      );
    receipt = { ...receipt, ignoreBootstrap: { ...receipt.ignoreBootstrap!, published: true } };
    persistReceipt(operationFd, receipt);
    boundary("after-ignore");
    boundary("before-first-backup");
    // Verify protection again after injection and before any raw bytes reach the receipt directory.
    if (!sameSnapshot(protectedIgnore, containedSnapshot(project, ".gitignore")))
      fail("publication-ignore", "Ignore protection changed before private file copies.");
    for (let index = 0; index < files.length; index++) {
      verifyOperationDirectory(context, operationId, operationFd);
      const file = files[index]!;
      const step = receipt.steps[index]!;
      if (file.before.exists) writePrivate(operationFd, step.before!.backupPath, file.before.bytes);
      writePrivate(operationFd, step.after.stagePath, file.bytes);
    }
    receipt = { ...receipt, phase: "prepared" };
    persistReceipt(operationFd, receipt);
    boundary("prepared");
    const published = new Set<string>([join(project, ".gitignore")]);
    let ignoreCurrent: FileSnapshot = protectedIgnore;
    const publishedOutputs = new Map<string, FileSnapshot>();
    const revalidate = () => {
      verifyOperationDirectory(context, operationId, operationFd!);
      for (const snapshot of publishedOutputs.values()) assertSnapshot(snapshot);
      for (const snapshot of plan.inputs)
        if (!published.has(snapshot.path)) assertSnapshot(snapshot);
      for (const file of files)
        if (!published.has(file.before.path)) {
          const parent = checkedDestination(context, file.relativePath, file.before, false);
          if (parent) closeSync(parent.fd);
        }
      if (!sameSnapshot(ignoreCurrent, containedSnapshot(project, ".gitignore")))
        fail("publication-ignore", "Ignore protection changed during publication.");
    };
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      boundary("before-file", file.relativePath);
      revalidate();
      const step = receipt.steps[index]!;
      const expected = file.role === "ignore" ? ignoreCurrent : file.before;
      let output: FileSnapshot;
      if (expected.exists && matches(expected, step.after)) {
        output = expected;
        if (!unlinkAt(operationFd, step.after.stagePath))
          fail("publication-cleanup", "An unchanged output's private stage could not be cleared.");
      } else
        output = publishStage(
          context,
          operationFd,
          step.after.stagePath,
          file.relativePath,
          expected,
          file.bytes,
          file.mode,
        );
      if (!output.exists || !matches(output, step.after))
        fail("publication-write", "The published output could not be verified.");
      if (file.role === "ignore") ignoreCurrent = output;
      published.add(file.before.path);
      publishedOutputs.set(file.before.path, output);
      receipt = {
        ...receipt,
        phase: file.role === "activation" ? "activated" : "publishing",
        steps: receipt.steps.map((item, at) =>
          at === index ? { ...item, published: true, outputIdentity: output.identity } : item,
        ),
      };
      boundary("after-file", file.relativePath);
      if (file.role === "activation") boundary("after-activation", file.relativePath);
      persistReceipt(operationFd, receipt);
    }
    boundary("before-complete");
    revalidate();
    for (const step of receipt.steps)
      if (!matches(containedSnapshot(project, step.relativePath), step.after))
        fail("publication-changed", "A published output changed before completion.");
    receipt = { ...receipt, phase: "complete" };
    persistReceipt(operationFd, receipt);
    return {
      status: "complete",
      activation: "output",
      operationId,
      changedPaths: files.map((file) => file.relativePath),
      diagnostics: [],
    };
  } catch (error) {
    if (!started) {
      if (error instanceof AuthoringError) throw error;
      return fail(
        "publication-preflight",
        "Authoring preflight failed safely; no project files were published.",
      );
    }
    try {
      const rollback = applyRollback(planRollback(project, operationId), {
        lease,
        fault: options.fault,
      });
      return {
        ...rollback,
        diagnostics: [diagnostic(error), ...rollback.diagnostics].slice(
          0,
          AUTHORING_LIMITS.diagnostics,
        ),
      };
    } catch {
      return {
        status: "recovery-required",
        activation: receipt ? observeActivation(project, receipt) : "unknown",
        operationId,
        changedPaths: [],
        diagnostics: [
          diagnostic(error),
          {
            code: "publication-recovery",
            message:
              "Guarded rollback could not complete. Preserve the receipt and recover this operation before retrying.",
          },
        ],
      };
    }
  } finally {
    if (operationFd !== undefined) closeSync(operationFd);
    if (ownsLease) lease.release();
  }
}

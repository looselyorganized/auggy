/** Passive migration planning and redacted reports. Private plans must never be serialized. */
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { planApplicationScaffold } from "../scaffold-application";
import {
  AUTHORING_LIMITS,
  type AuthoringDocument,
  type DocumentEdit,
  type FileSnapshot,
  type MutationPlan,
  type PlannedFile,
  type PublicationOptions,
  type PublicationResult,
  type RollbackPlan,
  type SafeDiagnostic,
} from "./contracts";
import { editAuthoringDocument } from "./document";
import { AuthoringError, snapshotHash } from "./document-io";
import { safeNavigation } from "./inspection-safety";
import { adoptionDestination, planApplicationPackage } from "./migration-package";
import { createMutationPlan } from "./mutation";
import { IGNORE_SUFFIX, OPERATION_ID } from "./publication-common";
import { listOperationIds, planRollback, readOperationReceipt } from "./publication-receipt";

export type MigrationMode = "config" | "application" | "rollback";
export interface MigrationReport {
  readonly schemaVersion: 1;
  readonly mode: MigrationMode;
  readonly status:
    | "planned"
    | "noop"
    | "complete"
    | "rolled-back"
    | "recovery-required"
    | "invalid";
  readonly project: {
    readonly directory: string | null;
    readonly configPath: string | null;
    readonly format: AuthoringDocument["format"] | null;
  };
  readonly fingerprint: string | null;
  readonly operationId: string | null;
  readonly activation: PublicationResult["activation"] | null;
  readonly changes: readonly {
    readonly path: string;
    readonly operation: "create" | "replace" | "restore" | "remove-owned";
    readonly reason: string;
  }[];
  readonly declarations: readonly {
    readonly index: number;
    readonly name: string | null;
    readonly type: string;
    readonly environmentNames: readonly string[];
  }[];
  readonly preserved: readonly string[];
  readonly manualActions: readonly string[];
  readonly diagnostics: readonly SafeDiagnostic[];
}

/** In-memory only: contains raw configuration and manifest bytes. */
export type PreparedMigration =
  | {
      readonly mode: "config" | "application";
      readonly report: MigrationReport;
      readonly mutation: MutationPlan;
    }
  | {
      readonly mode: "rollback";
      readonly report: MigrationReport;
      readonly rollback: RollbackPlan;
    };

class MigrationPlanningError extends AuthoringError {
  constructor(readonly diagnostics: readonly SafeDiagnostic[]) {
    super(
      "migration-conflict",
      "Migration has preservation conflicts; review the listed paths before retrying.",
    );
  }
}

function safeDiagnostic(diagnostic: SafeDiagnostic): SafeDiagnostic {
  return {
    code: /^[a-z0-9-]{1,80}$/.test(diagnostic.code) ? diagnostic.code : "invalid-migration",
    message: safeNavigation(
      diagnostic.message,
      "Review the selected files locally before retrying migration.",
    ),
    ...(diagnostic.path ? { path: safeNavigation(diagnostic.path) } : {}),
    ...(diagnostic.field ? { field: safeNavigation(diagnostic.field) } : {}),
  };
}

export function createInvalidMigrationReport(
  error: unknown,
  selected: {
    readonly mode?: MigrationMode;
    readonly configPath?: string;
    readonly projectDir?: string;
    readonly operationId?: string;
  } = {},
): MigrationReport {
  const diagnostics =
    error instanceof MigrationPlanningError
      ? error.diagnostics
      : error instanceof AuthoringError
        ? [error.diagnostic]
        : [
            {
              code: "invalid-migration",
              message:
                "Cannot safely plan this migration; review the selected files and permissions locally. No automatic recovery or overwrite was attempted.",
            },
          ];
  return {
    schemaVersion: 1,
    mode: selected.mode ?? "config",
    status: "invalid",
    project: {
      directory: selected.projectDir ? safeNavigation(selected.projectDir) : null,
      configPath: selected.configPath ? safeNavigation(selected.configPath) : null,
      format: null,
    },
    fingerprint: null,
    operationId:
      selected.operationId && OPERATION_ID.test(selected.operationId) ? selected.operationId : null,
    activation: null,
    changes: [],
    declarations: [],
    preserved: [],
    manualActions: [],
    diagnostics: diagnostics.slice(0, AUTHORING_LIMITS.diagnostics).map(safeDiagnostic),
  };
}

function declarationSummary(document: AuthoringDocument): MigrationReport["declarations"] {
  return document.declarations.map((entry) => ({
    index: entry.index,
    name: entry.name === null ? null : safeNavigation(entry.name),
    type: safeNavigation(entry.type),
    environmentNames: entry.environmentNames.map((name) => safeNavigation(name)),
  }));
}

function checkUnresolvedOperations(projectDir: string): void {
  for (const id of listOperationIds(projectDir)) {
    const previous = readOperationReceipt(projectDir, id);
    if (!["complete", "rolled-back"].includes(previous.phase))
      throw new AuthoringError(
        "publication-unresolved",
        `A prior authoring operation requires guarded rollback before migration: ${id}.`,
      );
  }
}

function ignoreSnapshot(projectDir: string): FileSnapshot {
  // The same parent/case checks apply to the publisher's automatic ignore write.
  const before = adoptionDestination(projectDir, ".gitignore", AUTHORING_LIMITS.outputBytes);
  if (
    (before.exists ? before.bytes.length : 0) + Buffer.byteLength(IGNORE_SUFFIX) >
    AUTHORING_LIMITS.outputBytes
  )
    throw new AuthoringError(
      "ignore-limit",
      "The ignore file cannot accommodate private receipt protection within its supported bound.",
      { path: ".gitignore" },
    );
  return before;
}

export function planMigration(
  document: AuthoringDocument,
  options: { readonly application?: boolean } = {},
): PreparedMigration {
  const mode = options.application ? "application" : "config";
  const edits: DocumentEdit[] = [{ kind: "inline-references" }];
  const inputs: FileSnapshot[] = [...document.inputs];
  const files: PlannedFile[] = [];
  const diagnostics: SafeDiagnostic[] = [];
  const manualActions: string[] = [];
  if (options.application) {
    if (Object.hasOwn(document.value, "application"))
      throw new AuthoringError(
        "application-already-declared",
        "An application is already declared. Keep its owned execution source and use config-only migration; adoption never replaces an existing application.",
        { path: document.configPath, field: "/application" },
      );
    const scaffold = planApplicationScaffold({ configFileName: basename(document.configPath) });
    for (const file of scaffold.files) {
      try {
        const before = adoptionDestination(document.projectDir, file.relativePath);
        if (before.exists) {
          diagnostics.push({
            code: "application-file-conflict",
            path: file.relativePath,
            message:
              "Application adoption would occupy an existing file. Review it manually or use config-only migration; existing files are never overwritten.",
          });
          continue;
        }
        inputs.push(before);
        files.push({ ...file, before, role: "support" });
      } catch (error) {
        if (!(error instanceof AuthoringError)) throw error;
        diagnostics.push(error.diagnostic);
      }
    }
    try {
      const manifest = planApplicationPackage(document.projectDir, scaffold.packageFields);
      inputs.push(...manifest.inputs);
      diagnostics.push(...manifest.diagnostics);
      if (manifest.file) files.push(manifest.file);
      if (manifest.toolingAdded)
        manualActions.push(
          "The planned manifest adds application tooling requirements. After applying, run bun install explicitly, then bun run typecheck and bun test. Migration does not install dependencies or change the lockfile.",
        );
    } catch (error) {
      if (!(error instanceof AuthoringError)) throw error;
      diagnostics.push(error.diagnostic);
    }
    if (diagnostics.length) throw new MigrationPlanningError(diagnostics);
    edits.push({ kind: "set-application", application: scaffold.application });
    manualActions.push(
      "Application adoption changes the next managed launch: the default omitted turn timeout is 15 minutes (900000 ms); legacy execution has no application deadline. Configured inference and other limits remain effective.",
    );
  }
  const activation = editAuthoringDocument(document, edits);
  files.push(activation);
  const unchanged =
    !options.application && snapshotHash(activation.bytes) === document.config.sha256;
  let ignore: FileSnapshot | undefined;
  if (!unchanged) {
    checkUnresolvedOperations(document.projectDir);
    ignore = ignoreSnapshot(document.projectDir);
    inputs.push(ignore);
  }
  const mutation = createMutationPlan({
    kind: "migrate",
    projectDir: document.projectDir,
    configRelativePath: basename(document.configPath),
    inputs,
    files,
    summary: files.map((file) => ({
      path: file.relativePath,
      operation: file.before.exists ? "replace" : "create",
      reason:
        file.role === "activation"
          ? "Activate the selected central declaration on the next managed launch."
          : file.relativePath === "package.json"
            ? "Add only absent application manifest fields; retain identical fields."
            : "Create project-owned application source, tests or instructions.",
    })),
  });
  for (const entry of document.declarations) {
    if (entry.type !== "custom" || !entry.source || entry.source.includes("${")) continue;
    const source = resolve(entry.origin.sourceBaseDir, entry.source);
    const rel = relative(document.projectDir, source);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
      manualActions.push(
        "An existing custom source is external to this project and remains nonportable. Its effective source location is preserved; migration does not move code or rewrite imports.",
      );
      break;
    }
  }
  if (!unchanged) {
    manualActions.push(
      "Changes take effect only on the next managed launch. Already running agents and in-flight turns keep their loaded configuration; migration does not restart or hot-reload them.",
    );
    manualActions.push(
      "Apply records private recovery metadata and backups below .auggy/operations/<operation-id>/ and appends .auggy/ ignore protection. Keep private receipt contents out of deployment and public evidence.",
    );
  }
  const report: MigrationReport = {
    schemaVersion: 1,
    mode,
    status: unchanged ? "noop" : "planned",
    project: {
      directory: safeNavigation(document.projectDir),
      configPath: safeNavigation(document.configPath),
      format: document.format,
    },
    fingerprint: mutation.fingerprint,
    operationId: null,
    activation: null,
    changes: unchanged
      ? []
      : [
          ...mutation.summary,
          {
            path: ".gitignore",
            operation: ignore?.exists ? ("replace" as const) : ("create" as const),
            reason: "Append private authoring receipt protection before any backup is stored.",
          },
        ],
    declarations: declarationSummary(document),
    preserved: [
      "Immutable identity and configuration values, including literal environment references.",
      "Legacy augment metadata, custom source and imports, root skills and .env bytes.",
      "Durable databases, WALs, history, process registry, dependency lockfile and installed packages.",
    ],
    manualActions,
    diagnostics: [],
  };
  return { mode, report, mutation };
}

export function planMigrationRollback(projectDir: string, operationId: string): PreparedMigration {
  const rollback = planRollback(projectDir, operationId);
  const receipt = readOperationReceipt(rollback.projectDir, operationId);
  const diagnostics = rollback.diagnostics.map(safeDiagnostic);
  const report: MigrationReport = {
    schemaVersion: 1,
    mode: "rollback",
    status: diagnostics.length ? "invalid" : "planned",
    project: {
      directory: safeNavigation(rollback.projectDir),
      configPath: safeNavigation(join(rollback.projectDir, receipt.configRelativePath)),
      format: null,
    },
    fingerprint: snapshotHash(
      Buffer.from(
        JSON.stringify({
          receipt: rollback.receipt.sha256,
          inputs: rollback.inputs
            .map((input) => ({ path: input.path, sha256: input.exists ? input.sha256 : null }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        }),
      ),
    ),
    operationId,
    activation: null,
    changes: rollback.summary.map((change) => ({ ...change, path: safeNavigation(change.path) })),
    declarations: [],
    preserved: [
      "Operator edits, unrelated files, durable state, installed dependencies and the stable authoring lock.",
      "Existing credentials are never restored. An init-created .env is removed only while unchanged and still owned by its recorded operation.",
    ],
    manualActions: [
      "Rollback restores central activation first, then verified original files or unchanged owned outputs. Ignore protection is removed last and retained while another operation needs it.",
      "Rollback affects the next managed launch; running agents and in-flight turns retain their loaded code and configuration.",
    ],
    diagnostics,
  };
  return { mode: "rollback", report, rollback };
}

/** Explicit test hooks are not exposed through environment variables or CLI flags. */
export async function applyMigration(
  plan: PreparedMigration,
  options: PublicationOptions = {},
): Promise<MigrationReport> {
  if (plan.report.status === "noop" || plan.report.status === "invalid") return plan.report;
  const result =
    plan.mode === "rollback"
      ? (await import("./publication-recovery")).applyRollback(plan.rollback, options)
      : (await import("./publication")).publishMutationPlan(plan.mutation, options);
  return {
    ...plan.report,
    status: result.status,
    activation: result.activation,
    operationId: result.operationId,
    diagnostics: result.diagnostics.map(safeDiagnostic),
    manualActions: [
      ...plan.report.manualActions,
      ...(result.status === "recovery-required"
        ? [
            `Preserve the private receipt. Preview recovery with auggy migrate --project-dir <project-directory> --rollback ${result.operationId}, then add --apply only after reviewing that current plan.`,
          ]
        : []),
    ],
  };
}

export function renderMigrationReport(report: MigrationReport): string {
  const lines = [
    `Migration: ${report.status} (${report.mode}; schema ${report.schemaVersion})`,
    `Project: ${report.project.directory ?? "unavailable"}`,
    `Configuration: ${report.project.configPath ?? "unavailable"}`,
  ];
  if (report.fingerprint) lines.push(`Plan fingerprint: ${report.fingerprint}`);
  if (report.operationId) lines.push(`Operation: ${report.operationId}`);
  if (report.activation) lines.push(`Observed activation: ${report.activation}`);
  for (const item of report.changes) lines.push(`${item.operation}: ${item.path} — ${item.reason}`);
  for (const item of report.declarations)
    lines.push(
      `Augment ${item.index + 1}: ${item.name ?? "unresolved"} (${item.type}); environment names: ${item.environmentNames.join(", ") || "none"}`,
    );
  for (const item of report.preserved) lines.push(`Preserved: ${item}`);
  for (const item of report.manualActions) lines.push(item);
  for (const item of report.diagnostics)
    lines.push(
      `${item.code}${item.path ? ` (${item.path}${item.field ?? ""})` : ""}: ${item.message}`,
    );
  if (report.status === "planned")
    lines.push(
      "Preview only: no files, leases or receipts were written. Add --apply to recompute and publish the current plan.",
    );
  if (report.status === "noop")
    lines.push("Already inline: no files, leases or receipts were written.");
  return lines.join("\n");
}

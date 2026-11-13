import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { VALID_NAME_RE } from "../agent-name";
import type { MigrateCommandOptions } from "../authoring-command-options";
import { AuthoringError } from "../authoring/document-io";
import { safeNavigation } from "../authoring/inspection-safety";
import { selectInspectionDocument } from "../authoring/inspection-selection";
import {
  applyMigration,
  createInvalidMigrationReport,
  planMigration,
  planMigrationRollback,
  renderMigrationReport,
  type MigrationMode,
  type MigrationReport,
} from "../authoring/migration";
import { canonicalProject, OPERATION_ID } from "../authoring/publication-common";

function checkedPath(path: string): string {
  const resolved = resolve(path);
  if (!path || safeNavigation(resolved, "") !== resolved)
    throw new AuthoringError(
      "invalid-migration-path",
      "Select a bounded filesystem path without control characters.",
    );
  return resolved;
}

function validateOptions(name: string | undefined, options: MigrateCommandOptions): void {
  if (
    (options.rollback !== undefined &&
      (!OPERATION_ID.test(options.rollback) || options.application)) ||
    (options.projectDir !== undefined &&
      (!options.rollback ||
        name !== undefined ||
        options.config !== undefined ||
        options.application))
  )
    throw new AuthoringError(
      "invalid-cli-syntax",
      "Rollback requires a valid operation ID and cannot be combined with --application. --project-dir is rollback-only and cannot be combined with a name or --config.",
    );
  if (
    !options.config &&
    name !== undefined &&
    (!VALID_NAME_RE.test(name) || safeNavigation(name, "") !== name)
  )
    throw new AuthoringError(
      "invalid-agent-name",
      "Use a bounded agent name containing letters, digits, hyphens or underscores.",
    );
  if (options.config !== undefined) checkedPath(options.config);
  if (options.projectDir !== undefined) checkedPath(options.projectDir);
}

function rollbackDirectory(name: string | undefined, options: MigrateCommandOptions): string {
  if (options.projectDir) return canonicalProject(checkedPath(options.projectDir));
  // Explicit recovery selection must still report receipt conflicts when YAML
  // was deleted or malformed. No configuration parse is required for that path.
  if (options.config) return canonicalProject(dirname(checkedPath(options.config)));
  if (!name) return canonicalProject(process.cwd());
  let localExists = false;
  try {
    lstatSync(resolve("agent.yaml"));
    localExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new AuthoringError(
        "unreadable-config",
        "Cannot select local recovery; use --project-dir explicitly.",
      );
  }
  return localExists
    ? selectInspectionDocument(name).projectDir
    : canonicalProject(checkedPath(name));
}

export async function runMigrate(
  name: string | undefined,
  options: MigrateCommandOptions,
): Promise<number> {
  const mode: MigrationMode =
    options.rollback !== undefined ? "rollback" : options.application ? "application" : "config";
  let report: MigrationReport;
  let configPath: string | undefined;
  let projectDir: string | undefined;
  try {
    validateOptions(name, options);
    const plan =
      mode === "rollback"
        ? (() => {
            projectDir = rollbackDirectory(name, options);
            return planMigrationRollback(projectDir, options.rollback!);
          })()
        : (() => {
            const document = selectInspectionDocument(name, options.config);
            configPath = document.configPath;
            projectDir = document.projectDir;
            return planMigration(document, { application: options.application });
          })();
    report = options.apply ? await applyMigration(plan) : plan.report;
  } catch (error) {
    report = createInvalidMigrationReport(error, {
      mode,
      configPath,
      projectDir,
      operationId: options.rollback,
    });
  }
  console.log(options.json ? JSON.stringify(report) : renderMigrationReport(report));
  return report.status === "invalid" ||
    report.status === "recovery-required" ||
    (report.status === "rolled-back" && mode !== "rollback")
    ? 1
    : 0;
}

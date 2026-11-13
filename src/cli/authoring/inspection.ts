/** Passive declaration report. No environment interpolation or executable imports. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import {
  inspectProjectRuntimeMetadata,
  ProjectRuntimeMetadataError,
  type ProjectRuntime,
} from "../project-runtime";
import {
  AUTHORING_LIMITS,
  type AuthoringDeclaration,
  type AuthoringDocument,
  type InspectionReport,
  type InspectionSource,
  type RawValue,
  type SafeDiagnostic,
} from "./contracts";
import { environmentNames, readAuthoringDocument } from "./document";
import { AuthoringError } from "./document-io";
import { readInstalledSourceIndex, type SourceIndexResult } from "./inspection-index";
import {
  containedNavigationPath,
  isContained,
  isLocalPath,
  safeNavigation,
} from "./inspection-safety";

function emptyReport(configPath: string, inspectorVersion: string): InspectionReport {
  return {
    schemaVersion: 1,
    status: "invalid",
    inspector: { version: safeNavigation(inspectorVersion) },
    project: {
      configPath: safeNavigation(configPath),
      format: null,
      name: null,
      identity: { value: null, environmentNames: [] },
    },
    application: { mode: "legacy", entrypoint: null, contractVersion: null, source: null },
    runtime: {
      status: "unavailable",
      packageRoot: null,
      version: null,
      manifestSHA256: null,
      applicationSupported: null,
    },
    execution: {
      basis: "conventional-project-files",
      startup: null,
      composition: null,
      http: null,
      turn: null,
      runtime: {},
    },
    augments: [],
    runtimeDiscovery: "not-evaluated",
    diagnostics: [],
  };
}

function safeDiagnostic(error: unknown): SafeDiagnostic {
  if (error instanceof AuthoringError) {
    const diagnostic = error.diagnostic;
    return {
      code: /^[a-z0-9-]{1,80}$/.test(diagnostic.code) ? diagnostic.code : "invalid-inspection",
      message: safeNavigation(
        diagnostic.message,
        "Cannot safely inspect this declaration; review it locally.",
      ),
      ...(diagnostic.path ? { path: safeNavigation(diagnostic.path) } : {}),
      ...(diagnostic.field ? { field: safeNavigation(diagnostic.field) } : {}),
    };
  }
  return {
    code:
      error instanceof ProjectRuntimeMetadataError
        ? "invalid-runtime-metadata"
        : "invalid-inspection",
    message:
      error instanceof ProjectRuntimeMetadataError
        ? "The selected project or local package metadata is invalid; review the manifests and reinstall compatible dependencies."
        : "Cannot safely inspect the selected declaration; review its files and permissions locally.",
  };
}

/** Also used by the early binary grammar-error path; never include Commander input text. */
export function createInvalidInspectionReport(
  configPath: string,
  error: unknown,
  inspectorVersion = pkg.version,
): InspectionReport {
  return { ...emptyReport(configPath, inspectorVersion), diagnostics: [safeDiagnostic(error)] };
}

function record(value: RawValue | undefined): value is { readonly [key: string]: RawValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function source(
  path: string,
  ownership: InspectionSource["ownership"],
  exists = true,
): InspectionSource {
  return {
    ownership,
    status: exists ? "available" : "missing",
    path: safeNavigation(path),
    ...(!exists ? { reason: "missing-source" } : {}),
  };
}
function unavailable(ownership: InspectionSource["ownership"], reason: string): InspectionSource {
  return { ownership, status: "unavailable", path: null, reason };
}

function customSource(entry: AuthoringDeclaration, projectDir: string): InspectionSource {
  const raw = entry.source!;
  if (!isLocalPath(raw)) return unavailable("external", "unsupported-source-reference");
  if (raw.includes("${")) {
    return {
      ownership: "project",
      status: "unresolved",
      path: safeNavigation(raw),
      reason: "environment-source-reference",
    };
  }
  const declared = resolve(entry.origin.sourceBaseDir, raw);
  let ownership: InspectionSource["ownership"] = isContained(projectDir, declared)
    ? "project"
    : "external";
  try {
    const actual = realpathSync(declared);
    ownership = isContained(projectDir, actual) ? "project" : "external";
    if (!lstatSync(actual).isFile()) return unavailable(ownership, "unsupported-source-kind");
    return source(actual, ownership);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return source(declared, ownership, false);
    return unavailable(ownership, "unreadable-custom-source");
  }
}

function applicationDeclaration(document: AuthoringDocument): InspectionReport["application"] {
  const value = document.value.application;
  if (value === undefined)
    return { mode: "legacy", entrypoint: null, contractVersion: null, source: null };
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["entrypoint", "contractVersion"].includes(key)) ||
    !Number.isSafeInteger(value.contractVersion) ||
    (value.contractVersion as number) < 1 ||
    typeof value.entrypoint !== "string" ||
    !isLocalPath(value.entrypoint) ||
    isAbsolute(value.entrypoint) ||
    value.entrypoint.includes("${")
  ) {
    throw new AuthoringError(
      "invalid-application-declaration",
      "Application requires a literal contained relative entrypoint and a positive integer contractVersion.",
      { field: "/application" },
    );
  }
  const selected = containedNavigationPath(
    document.projectDir,
    resolve(document.projectDir, value.entrypoint),
  );
  return {
    mode: "application",
    entrypoint: safeNavigation(value.entrypoint),
    contractVersion: value.contractVersion as number,
    source: source(selected.path, "project", selected.exists),
  };
}

/** Produces the same redacted data consumed by JSON and the human-readable renderer. */
export function buildInspectionReport(
  document: AuthoringDocument,
  options: { readonly inspectorVersion?: string } = {},
): InspectionReport {
  const inspectorVersion = options.inspectorVersion ?? pkg.version;
  try {
    const diagnostics: SafeDiagnostic[] = [];
    let partial = false;
    function note(code: string, message: string, field?: string) {
      partial = true;
      if (diagnostics.length < AUTHORING_LIMITS.diagnostics)
        diagnostics.push({ code, message, ...(field ? { field } : {}) });
    }
    function names(values: readonly string[], field: string): readonly string[] {
      if (
        values.length > AUTHORING_LIMITS.augments ||
        values.some((value) => safeNavigation(value, "") !== value)
      ) {
        note(
          "bounded-navigation",
          "Some navigation names are omitted or redacted because they exceed display limits or contain unsafe characters.",
          field,
        );
      }
      return values.slice(0, AUTHORING_LIMITS.augments).map((value) => safeNavigation(value));
    }
    const declaredName = document.value.name;
    if (
      declaredName !== undefined &&
      (typeof declaredName !== "string" ||
        !declaredName.trim() ||
        safeNavigation(declaredName, "") !== declaredName)
    ) {
      throw new AuthoringError(
        "invalid-project-name",
        "Project name must be a bounded, nonempty string without control characters.",
        { field: "/name" },
      );
    }
    const id = document.value.id;
    if (id !== undefined && typeof id !== "string") {
      throw new AuthoringError(
        "invalid-project-identity",
        "Project identity must be a literal immutable ID or an environment reference.",
        { field: "/id" },
      );
    }
    const identityEnvironment = names(environmentNames(id ?? null), "/id");
    const identityValue =
      typeof id === "string" &&
      /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
        ? id
        : null;
    if (typeof id === "string" && !identityValue && !identityEnvironment.length) {
      throw new AuthoringError(
        "invalid-project-identity",
        "Project identity must be a valid immutable aug1_ ID; its invalid value has been omitted.",
        { field: "/id" },
      );
    }
    if (identityEnvironment.length)
      note(
        "unresolved-project-identity",
        "Identity environment references are listed without loading their values.",
        "/id",
      );
    const application = applicationDeclaration(document);
    let selectedRuntime: ProjectRuntime | null = null;
    let index: SourceIndexResult = { status: "unavailable", reason: "missing-source-index" };
    try {
      selectedRuntime = inspectProjectRuntimeMetadata(document.projectDir);
      index = readInstalledSourceIndex(selectedRuntime.packageRoot);
      if (index.status === "unavailable")
        note(
          index.reason,
          "Installed source navigation is unavailable; install a package with a supported source index.",
        );
    } catch (error) {
      if (error instanceof ProjectRuntimeMetadataError && error.code !== "invalid-metadata") {
        note(
          error.code,
          "Install this project's dependencies and a local Auggy package to inspect runtime source.",
        );
      } else throw error;
    }
    const applicationSupported = selectedRuntime
      ? !!selectedRuntime.capabilities?.applicationContracts.includes(1)
      : null;
    if (
      application.mode === "application" &&
      (application.contractVersion !== 1 || applicationSupported === false)
    ) {
      note(
        "unsupported-application-contract",
        "The declared application contract is unavailable in this inspector or selected runtime; update compatible dependencies.",
        "/application/contractVersion",
      );
    }
    if (application.source?.status === "missing")
      note(
        "missing-application-source",
        "Restore the declared application entrypoint to navigate startup.",
        "/application/entrypoint",
      );
    const runtimeSources: Partial<Record<"application" | "host" | "turn", InspectionSource>> = {};
    if (index.status === "available" && selectedRuntime) {
      for (const key of ["application", "host", "turn"] as const) {
        const path = containedNavigationPath(
          selectedRuntime.packageRoot,
          join(selectedRuntime.packageRoot, index.index.runtime[key]),
        );
        runtimeSources[key] = source(path.path, "package", path.exists);
      }
    }
    const conventional: Partial<Record<"composition" | "http" | "turn", InspectionSource>> = {};
    if (application.mode === "application") {
      if (normalize(application.entrypoint!) === "src/index.ts") {
        for (const [key, file] of [
          ["composition", "agent.ts"],
          ["http", "http.ts"],
          ["turn", "turn.ts"],
        ] as const) {
          const path = containedNavigationPath(
            document.projectDir,
            join(document.projectDir, "src", file),
          );
          if (path.exists) conventional[key] = source(path.path, "project");
          else
            note(
              "unknown-application-composition",
              "A conventional project file is missing; application imports and composition are not analyzed.",
            );
        }
      } else
        note(
          "unknown-application-composition",
          "This custom application layout has no inferred composition, HTTP or turn locations; follow its entrypoint imports.",
        );
    }
    const augments = document.declarations.map((entry): InspectionReport["augments"][number] => {
      if (safeNavigation(entry.type, "") !== entry.type || entry.type.length > 128) {
        throw new AuthoringError(
          "invalid-augment-type",
          "Augment type must be a bounded declaration name; its invalid value has been omitted.",
          { field: entry.origin.pointer },
        );
      }
      let location: InspectionSource;
      if (entry.type === "custom") location = customSource(entry, document.projectDir);
      else if (index.status === "available" && selectedRuntime) {
        const mapping = index.index.augments.find((mapping) => mapping.type === entry.type);
        location = mapping
          ? source(
              containedNavigationPath(
                selectedRuntime.packageRoot,
                join(selectedRuntime.packageRoot, mapping.entrypoint),
              ).path,
              "package",
            )
          : unavailable("package", "unmapped-augment-type");
      } else
        location = unavailable(
          "package",
          index.status === "unavailable" ? index.reason : "missing-runtime",
        );
      if (location.status !== "available")
        note(
          location.reason ?? "unavailable-source",
          "Declared source is unavailable without execution or environment expansion; review its reference and installed metadata.",
          `/augments/${entry.index}`,
        );
      if (location.ownership === "external")
        note(
          "external-custom-source",
          "This custom source belongs outside the project and is nonportable; inspection does not import or copy it.",
          `/augments/${entry.index}/source`,
        );
      return {
        index: entry.index,
        name: entry.name ? safeNavigation(entry.name) : null,
        type: safeNavigation(entry.type),
        configuration: { path: safeNavigation(entry.origin.path), pointer: entry.origin.pointer },
        optionKeys: record(entry.options)
          ? names(Object.keys(entry.options), `/augments/${entry.index}/options`)
          : [],
        environmentNames: names(entry.environmentNames, `/augments/${entry.index}`),
        source: location,
      };
    });
    return {
      ...emptyReport(document.configPath, inspectorVersion),
      status: partial ? "partial" : "complete",
      project: {
        configPath: safeNavigation(document.configPath),
        format: document.format,
        name: typeof declaredName === "string" ? declaredName : null,
        identity: { value: identityValue, environmentNames: identityEnvironment },
      },
      application,
      runtime: selectedRuntime
        ? {
            status: "available",
            packageRoot: safeNavigation(selectedRuntime.packageRoot),
            version: safeNavigation(selectedRuntime.version),
            manifestSHA256: selectedRuntime.manifestSHA256,
            applicationSupported,
          }
        : emptyReport("", inspectorVersion).runtime,
      execution: {
        basis: "conventional-project-files",
        startup: application.source,
        composition: conventional.composition ?? null,
        http: conventional.http ?? null,
        turn: conventional.turn ?? null,
        runtime: runtimeSources,
      },
      augments,
      diagnostics,
    };
  } catch (error) {
    return createInvalidInspectionReport(document.configPath, error, inspectorVersion);
  }
}

export function inspectProject(
  configPath: string,
  options: { readonly inspectorVersion?: string } = {},
): InspectionReport {
  try {
    return buildInspectionReport(readAuthoringDocument(configPath), options);
  } catch (error) {
    return createInvalidInspectionReport(configPath, error, options.inspectorVersion);
  }
}

export function renderInspectionReport(report: InspectionReport): string {
  const lines = [
    `Inspection: ${report.status} (schema ${report.schemaVersion}; inspector ${report.inspector.version})`,
    `Configuration: ${report.project.configPath}${report.project.format ? ` (${report.project.format})` : ""}`,
    `Application: ${report.application.mode}`,
    `Runtime: ${report.runtime.packageRoot ?? "unavailable"}${report.runtime.version ? ` (${report.runtime.version})` : ""}`,
    "Execution map: conventional-project-files; file existence does not establish application imports.",
  ];
  for (const key of ["startup", "composition", "http", "turn"] as const) {
    const item = report.execution[key];
    lines.push(`  ${key}: ${item?.path ?? "unknown"}${item ? ` [${item.status}]` : ""}`);
  }
  for (const [name, item] of Object.entries(report.execution.runtime))
    lines.push(`  runtime ${name}: ${item.path ?? "unavailable"}`);
  for (const entry of report.augments) {
    lines.push(
      `Augment ${entry.index + 1}: ${entry.name ?? "unresolved"} (${entry.type})`,
      `  config: ${entry.configuration.path}${entry.configuration.pointer}`,
      `  source: ${entry.source.path ?? "unavailable"} [${entry.source.ownership}; ${entry.source.status}]`,
      `  option keys: ${entry.optionKeys.join(", ") || "none"}`,
      `  environment references: ${entry.environmentNames.join(", ") || "none"}`,
    );
  }
  lines.push(
    "Runtime discovery: not-evaluated (tools, routes, hooks and synthetic augments).",
    "Use auggy routes for explicitly executing route inspection.",
  );
  for (const diagnostic of report.diagnostics)
    lines.push(`${diagnostic.code}: ${diagnostic.message}`);
  return lines.join("\n");
}

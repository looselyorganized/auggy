/** Passive adoption inputs. Never resolve/import package code or install tooling. */
import { lstatSync, opendirSync } from "node:fs";
import { join, relative } from "node:path";
import { inspectProjectRuntimeMetadata } from "../project-runtime";
import {
  AUTHORING_LIMITS,
  type ApplicationScaffoldPlan,
  type ExistingFileSnapshot,
  type FileSnapshot,
  type PlannedFile,
  type SafeDiagnostic,
} from "./contracts";
import { AuthoringError, decodeSnapshotText, readFileSnapshot } from "./document-io";
import { validateRelativePath } from "./mutation";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Detect case aliases and unsafe ancestors before reading even a missing leaf. */
export function adoptionDestination(
  projectDir: string,
  relativePath: string,
  maxBytes: number = AUTHORING_LIMITS.documentBytes,
): FileSnapshot {
  validateRelativePath(relativePath);
  let current = projectDir;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: join(projectDir, relativePath), exists: false };
      throw new AuthoringError(
        "unsafe-destination",
        "Cannot verify an adoption destination directory.",
        {
          path: relativePath,
        },
      );
    }
    let count = 0;
    let found = false;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (++count > AUTHORING_LIMITS.receiptEntries)
          throw new AuthoringError(
            "destination-limit",
            "A destination directory exceeds the bounded collision scan; review its contents manually.",
            { path: relativePath },
          );
        if (entry.name.toLowerCase() === part.toLowerCase()) {
          if (entry.name !== part)
            throw new AuthoringError(
              "destination-case-collision",
              "An adoption destination collides with an existing differently cased path.",
              { path: relativePath },
            );
          found = true;
        }
      }
    } finally {
      directory.closeSync();
    }
    if (!found) return { path: join(projectDir, relativePath), exists: false };
    current = join(current, part);
    const stats = lstatSync(current);
    if (
      stats.isSymbolicLink() ||
      (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile())
    )
      throw new AuthoringError(
        "unsafe-destination",
        "Adoption destinations require ordinary files and directories without symbolic links or special files.",
        { path: relativePath },
      );
  }
  return readFileSnapshot(current, maxBytes);
}

function parseManifest(snapshot: ExistingFileSnapshot): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeSnapshotText(snapshot.bytes));
  } catch (error) {
    if (error instanceof AuthoringError) throw error;
    throw new AuthoringError(
      "invalid-package-json",
      "Review package.json locally: adoption requires a valid JSON object.",
      { path: "package.json" },
    );
  }
  if (!record(value))
    throw new AuthoringError(
      "invalid-package-json",
      "Adoption requires package.json to contain a JSON object.",
      { path: "package.json" },
    );
  const pending = [{ value: value as unknown, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > AUTHORING_LIMITS.yamlNodes || item.depth > AUTHORING_LIMITS.yamlDepth)
      throw new AuthoringError(
        "package-json-limit",
        "Package metadata exceeds supported nesting or node bounds.",
        { path: "package.json" },
      );
    if (
      typeof item.value === "number" &&
      (!Number.isFinite(item.value) ||
        (Number.isInteger(item.value) && !Number.isSafeInteger(item.value)) ||
        Object.is(item.value, -0))
    )
      throw new AuthoringError(
        "unsupported-package-number",
        "Package metadata has a numeric value that cannot be automatically preserved; review it manually.",
        { path: "package.json" },
      );
    if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (record(item.value)) {
      nodes += Object.keys(item.value).length;
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}

export function planApplicationPackage(
  projectDir: string,
  fields: ApplicationScaffoldPlan["packageFields"],
): {
  inputs: readonly FileSnapshot[];
  file: PlannedFile | null;
  diagnostics: readonly SafeDiagnostic[];
  toolingAdded: boolean;
} {
  const before = adoptionDestination(projectDir, "package.json");
  if (!before.exists)
    throw new AuthoringError(
      "application-runtime-required",
      "Application adoption requires an existing package.json and an already installed local Auggy runtime with application contract 1. Install compatible dependencies explicitly first.",
    );
  const value = parseManifest(before);
  const output: Record<string, unknown> = Object.assign(Object.create(null), value);
  const diagnostics: SafeDiagnostic[] = [];
  const conflict = (field: string) => {
    if (diagnostics.length < AUTHORING_LIMITS.diagnostics)
      diagnostics.push({
        code: "package-field-conflict",
        path: "package.json",
        field,
        message:
          "This existing package field conflicts with the application scaffold. Review it manually; config-only migration remains available.",
      });
  };
  if (Object.hasOwn(value, "type") && value.type !== fields.type) conflict("/type");
  else output.type = fields.type;
  let toolingAdded = false;
  for (const group of ["scripts", "devDependencies"] as const) {
    const existing = value[group];
    if (existing !== undefined && !record(existing)) {
      conflict(`/${group}`);
      continue;
    }
    const merged: Record<string, unknown> = Object.assign(Object.create(null), existing ?? {});
    for (const [name, required] of Object.entries(fields[group])) {
      if (Object.hasOwn(merged, name) && merged[name] !== required) conflict(`/${group}/${name}`);
      else {
        if (!Object.hasOwn(merged, name) && group === "devDependencies") toolingAdded = true;
        merged[name] = required;
      }
      if (group === "devDependencies") {
        for (const other of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
          const entries = value[other];
          if (entries !== undefined && !record(entries)) conflict(`/${other}`);
          else if (record(entries) && Object.hasOwn(entries, name) && entries[name] !== required)
            conflict(`/${other}/${name}`);
        }
      }
    }
    output[group] = merged;
  }
  if (diagnostics.length) return { inputs: [before], file: null, diagnostics, toolingAdded };
  let runtime: ReturnType<typeof inspectProjectRuntimeMetadata>;
  try {
    runtime = inspectProjectRuntimeMetadata(projectDir, { applicationContract: 1 });
  } catch {
    throw new AuthoringError(
      "application-runtime-required",
      "Application adoption requires an already installed local Auggy package advertising application contract 1 and a contained public application export. Install compatible dependencies explicitly first.",
    );
  }
  // Keep the project-local selection path as the precondition so replacing a
  // linked installation is detected by the publisher's repeated snapshot checks.
  const manifest = readFileSnapshot(
    join(projectDir, "node_modules/auggy/package.json"),
    AUTHORING_LIMITS.documentBytes,
  );
  if (!manifest.exists || manifest.sha256 !== runtime.manifestSHA256)
    throw new AuthoringError(
      "runtime-metadata-changed",
      "The local runtime metadata changed during planning; retry with stable dependencies.",
    );
  const publicEntries = [runtime.cliPath, runtime.applicationPath!].map((entry) =>
    readFileSnapshot(
      join(projectDir, "node_modules/auggy", relative(runtime.packageRoot, entry)),
      AUTHORING_LIMITS.documentBytes,
    ),
  );
  // The invoking package supplies trusted templates; selected package code is never evaluated.
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  if (bytes.byteLength > AUTHORING_LIMITS.documentBytes)
    throw new AuthoringError(
      "package-json-limit",
      "The adopted package manifest would exceed its readable byte limit.",
      { path: "package.json" },
    );
  const changed = JSON.stringify(value) !== JSON.stringify(output);
  return {
    inputs: [before, manifest, ...publicEntries],
    file: changed
      ? {
          relativePath: "package.json",
          before,
          bytes,
          mode: before.identity.mode & 0o777,
          role: "support",
        }
      : null,
    diagnostics,
    toolingAdded,
  };
}

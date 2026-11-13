/** Installed navigation metadata only; never import the selected package. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { AUTHORING_LIMITS, type InstalledSourceIndex } from "./contracts";
import { AuthoringError, decodeSnapshotText, readFileSnapshot } from "./document-io";
import { assertIndexPath, containedNavigationPath } from "./inspection-safety";

export const SOURCE_INDEX_PATH = "src/metadata/source-index.json";
export type SourceIndexResult =
  | { readonly status: "available"; readonly index: InstalledSourceIndex }
  | {
      readonly status: "unavailable";
      readonly reason: "missing-source-index" | "unsupported-source-index";
    };

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new AuthoringError(
    "invalid-source-index",
    "The selected package source index is corrupt; reinstall a compatible package.",
  );
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function bounds(value: unknown) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > AUTHORING_LIMITS.yamlNodes || next.depth > AUTHORING_LIMITS.yamlDepth) invalid();
    if (next.value !== null && typeof next.value === "object") {
      for (const child of Object.values(next.value))
        pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

export function validateInstalledSourceIndex(
  value: unknown,
  packageRoot: string,
): SourceIndexResult {
  bounds(value);
  if (
    !mapping(value) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 0
  )
    invalid();
  if (value.schemaVersion !== 1)
    return { status: "unavailable", reason: "unsupported-source-index" };
  keys(value, ["schemaVersion", "runtime", "augments"]);
  if (
    !mapping(value.runtime) ||
    !Array.isArray(value.augments) ||
    value.augments.length > AUTHORING_LIMITS.augments
  )
    invalid();
  keys(value.runtime, ["application", "host", "turn"]);
  const root = realpathSync(packageRoot);
  function path(value: unknown, kind: "file" | "directory" = "file") {
    assertIndexPath(value);
    if (!containedNavigationPath(root, join(root, value), kind).exists) {
      throw new AuthoringError(
        "missing-indexed-source",
        "The selected package has stale source metadata; reinstall it with its source files.",
      );
    }
  }
  for (const name of ["application", "host", "turn"]) path(value.runtime[name]);
  const types = new Set<string>();
  for (const entry of value.augments) {
    if (
      !mapping(entry) ||
      typeof entry.type !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(entry.type) ||
      types.has(entry.type)
    )
      invalid();
    types.add(entry.type);
    keys(entry, ["type", "entrypoint", "directory", "skill"]);
    path(entry.entrypoint);
    if (entry.directory !== undefined) path(entry.directory, "directory");
    if (entry.skill !== undefined) path(entry.skill);
  }
  return { status: "available", index: value as unknown as InstalledSourceIndex };
}

export function readInstalledSourceIndex(packageRoot: string): SourceIndexResult {
  const root = realpathSync(packageRoot);
  const selected = containedNavigationPath(root, join(root, SOURCE_INDEX_PATH));
  if (!selected.exists) return { status: "unavailable", reason: "missing-source-index" };
  const snapshot = readFileSnapshot(selected.path, AUTHORING_LIMITS.documentBytes);
  if (!snapshot.exists) return { status: "unavailable", reason: "missing-source-index" };
  let value: unknown;
  try {
    value = JSON.parse(decodeSnapshotText(snapshot.bytes));
  } catch {
    invalid();
  }
  return validateInstalledSourceIndex(value, root);
}

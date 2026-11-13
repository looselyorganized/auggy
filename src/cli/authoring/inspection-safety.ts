/** Navigation text only. Never pass configuration values to these helpers. */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AUTHORING_LIMITS } from "./contracts";
import { AuthoringError } from "./document-io";

export function safeNavigation(value: string, fallback = "<unavailable>"): string {
  if (
    Buffer.byteLength(value) > AUTHORING_LIMITS.pathBytes ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x2028 && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    }) ||
    /[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  )
    return fallback;
  return value;
}

export function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isLocalPath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    safeNavigation(value, "") === value &&
    !value.includes("\\") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

function canonicalCandidate(path: string): string {
  let cursor = path;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor)
        throw error;
      suffix.unshift(cursor.slice(dirname(cursor).length + 1));
      cursor = dirname(cursor);
    }
  }
}

export function assertIndexPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isLocalPath(value) ||
    isAbsolute(value) ||
    value.includes("${") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new AuthoringError(
      "unsafe-source-index-path",
      "Source index paths must be literal package-relative paths; reinstall the selected package.",
    );
  }
}

/** Inspect each ancestor even when the leaf is missing, so escapes cannot become partial. */
export function containedNavigationPath(
  root: string,
  path: string,
  kind: "file" | "directory" = "file",
): { path: string; exists: boolean } {
  const absolute = resolve(path);
  if (!isContained(root, absolute)) {
    throw new AuthoringError(
      "unsafe-source-path",
      "Source path escapes its ownership boundary; correct the declaration or reinstall the package.",
    );
  }
  let cursor = root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    try {
      const entry = lstatSync(cursor);
      if (
        entry.isSymbolicLink() &&
        !isContained(root, canonicalCandidate(resolve(dirname(cursor), readlinkSync(cursor))))
      ) {
        throw new AuthoringError(
          "unsafe-source-path",
          "Source link escapes its ownership boundary; correct the declaration or reinstall the package.",
        );
      }
      const actual = realpathSync(cursor);
      if (!isContained(root, actual)) {
        throw new AuthoringError(
          "unsafe-source-path",
          "Source path escapes through a symbolic link; correct the declaration or reinstall the package.",
        );
      }
      const stats = entry.isSymbolicLink() ? lstatSync(actual) : entry;
      const last = index === parts.length - 1;
      if (!last || kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
        throw new AuthoringError(
          "invalid-source-kind",
          "Expected an ordinary source file or directory; correct the declaration or reinstall the package.",
        );
      }
      cursor = actual;
    } catch (error) {
      if (error instanceof AuthoringError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: absolute, exists: false };
      throw new AuthoringError(
        "unavailable-source-path",
        "Cannot safely inspect the declared source path; review its permissions and links.",
      );
    }
  }
  if (parts.length === 0 && kind === "file") {
    throw new AuthoringError(
      "invalid-source-kind",
      "Expected a source file, not the ownership directory.",
    );
  }
  return { path: cursor, exists: true };
}

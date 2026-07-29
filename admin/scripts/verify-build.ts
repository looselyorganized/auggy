import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLoginArtifactDirectory } from "./login-artifacts";

const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistRoot = resolve(adminRoot, "dist");
const MAX_INDEX_BYTES = 256 * 1024;
const REQUIRED_BRAND_ASSETS = [
  "brand/a1-logo.svg",
  "brand/auggy-wave.png",
  "brand/auggy-white.png",
] as const;

/**
 * Verify the complete Console build that the root package publishes. This is
 * intentionally independent from Vite's successful exit: npm packing must
 * fail if output is partial, stale, symlinked, or references a missing entry
 * asset.
 */
export function verifyAdminBuild(distRoot = defaultDistRoot): void {
  const requestedRoot = resolve(distRoot);
  const rootStat = lstatSync(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("admin build root must be a regular directory");
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const files = listRegularFiles(canonicalRoot);
  const fileSet = new Set(files);

  if (files.some((path) => path.endsWith(".map"))) {
    throw new Error("admin build must not contain source maps");
  }
  if (
    files.some((path) =>
      path.split("/").some((segment) =>
        [".env", ".git", ".login-staging", "node_modules"].includes(segment),
      ),
    )
  ) {
    throw new Error("admin build contains a local-only path");
  }

  for (const path of ["index.html", ...REQUIRED_BRAND_ASSETS]) {
    if (!fileSet.has(path)) throw new Error(`admin build is missing ${path}`);
  }

  const indexBytes = readFileSync(resolve(canonicalRoot, "index.html"));
  if (indexBytes.byteLength === 0 || indexBytes.byteLength > MAX_INDEX_BYTES) {
    throw new Error("admin build index size is invalid");
  }
  const index = new TextDecoder("utf-8", { fatal: true }).decode(indexBytes);
  if (!index.startsWith("<!doctype html>") || !index.includes('<div id="root"')) {
    throw new Error("admin build index is not the Console shell");
  }

  const resourcePaths = [...index.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
  if (resourcePaths.some((path) => !path.startsWith("/console/assets/"))) {
    throw new Error("admin build index contains an unexpected resource");
  }
  const entryAssets = resourcePaths;
  if (entryAssets.filter((path) => path.endsWith(".js")).length !== 1) {
    throw new Error("admin build index must reference exactly one JavaScript entry");
  }
  if (entryAssets.filter((path) => path.endsWith(".css")).length !== 1) {
    throw new Error("admin build index must reference exactly one stylesheet entry");
  }
  if (entryAssets.length !== 2) {
    throw new Error("admin build index contains an unexpected entry resource");
  }

  for (const publicPath of entryAssets) {
    const relativePath = publicPath.slice("/console/".length);
    if (!isSafeRelativePath(relativePath) || !fileSet.has(relativePath)) {
      throw new Error(`admin build index references a missing or unsafe asset: ${publicPath}`);
    }
  }

  verifyLoginArtifactDirectory(resolve(canonicalRoot, "login"));
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (!isWithin(root, absolutePath)) throw new Error("admin build path escapes its root");
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error("admin build must not contain symlinks");
      if (stat.isDirectory()) visit(absolutePath, relativePath);
      else if (stat.isFile() && stat.size > 0) files.push(relativePath);
      else throw new Error("admin build must contain non-empty regular files only");
    }
  };
  visit(root, "");
  return files.sort(compareStrings);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("%")) return false;
  if (value.includes("\0") || posix.normalize(value) !== value) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

if (import.meta.main) {
  verifyAdminBuild();
}

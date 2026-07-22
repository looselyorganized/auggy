#!/usr/bin/env bun
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "admin", "dist");
const indexPath = join(distDir, "index.html");

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.exitCode === 0) return stdout;

  const stderr = new TextDecoder().decode(result.stderr).trim();
  throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
}

function regularFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(path));
    else if (entry.isFile()) files.push(relative(repoRoot, path).split(sep).join("/"));
  }
  return files.sort();
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((path) => !rightSet.has(path));
}

function printPaths(label: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  console.error(`[admin-dist] ${label}:`);
  for (const path of paths) console.error(`  - ${path}`);
}

function main(): void {
  const builtFiles = regularFiles(distDir);
  const trackedFiles = lines(git(["ls-files", "--", "admin/dist"]));
  const generatedOnly = difference(builtFiles, trackedFiles);
  const trackedMissing = difference(trackedFiles, builtFiles);
  const status = lines(
    git(["status", "--porcelain=v1", "--untracked-files=all", "--", "admin/dist"]),
  );

  let failed = false;
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    console.error("[admin-dist] missing admin/dist/index.html; run `bun run build:admin`.");
    failed = true;
  }
  if (generatedOnly.length > 0) {
    printPaths("generated files that are not tracked", generatedOnly);
    failed = true;
  }
  if (trackedMissing.length > 0) {
    printPaths("tracked files missing from the generated tree", trackedMissing);
    failed = true;
  }
  if (status.length > 0) {
    printPaths("staged, unstaged, or untracked changes", status);
    failed = true;
  }

  if (failed) {
    console.error(
      "[admin-dist] rebuild with `bun run build:admin`, review the output, and commit the complete admin/dist tree.",
    );
    process.exit(1);
  }

  console.log(`[admin-dist] ${builtFiles.length} generated files exactly match Git.`);
}

if (import.meta.main) main();

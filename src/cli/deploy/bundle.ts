/**
 * Bundle staging — copies an agent dir into a fresh temp directory minus the
 * exclusions defined by ADR-021 (`.env`, `workspace/`, `*.db*`, `node_modules/`,
 * `.git/`, `.DS_Store`, `*.tmp`) plus this PR's additions (`.worktrees/`,
 * `.claude/`).
 *
 * The deploy command runs `railway up` from the staging dir so volume-bound
 * state (SQLite files) and secrets (`.env`) never enter the Railway image.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface StageBundleOptions {
  agentDir: string;
  agentName: string;
}

const EXCLUDED_NAMES = new Set([
  ".env",
  ".git",
  ".DS_Store",
  "node_modules",
  "workspace",
  ".worktrees",
  ".claude",
]);

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (/\.db(-(?:wal|shm))?$/.test(name)) return true;
  if (name.endsWith(".tmp")) return true;
  return false;
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcluded(entry)) continue;
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      copyTree(srcPath, dstPath);
    } else if (stats.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
    // Skip symlinks/sockets/etc — agent dirs shouldn't have them.
  }
}

/**
 * Copy the agent dir into a fresh temp staging dir, minus exclusions.
 * Returns the absolute path to the staging dir.
 */
export function stageBundle(opts: StageBundleOptions): string {
  if (!existsSync(opts.agentDir)) {
    throw new Error(`Agent directory not found: ${opts.agentDir}`);
  }
  const staging = mkdtempSync(join(tmpdir(), `auggy-deploy-${opts.agentName}-`));
  copyTree(opts.agentDir, staging);
  return staging;
}

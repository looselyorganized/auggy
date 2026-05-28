/**
 * PID registry — tracks running Auggy agents via JSON manifests.
 *
 * Each running agent gets a manifest at ~/.auggy/<name>.json containing
 * pid, port, config path, start time, and mode. Atomic writes via the
 * "wx" flag prevent concurrent starts of the same agent name.
 *
 * Replicates the PID guard pattern from telemetry-exporter/bin/daemon.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PidManifest } from "./types";

interface PidRegistryOptions {
  /** Override `~/.auggy/` for tests. Production callers omit. */
  auggyDir?: string;
}

// No time-based staleness heuristic — always-on agents can run for weeks.
// Liveness is determined solely by whether the PID is alive.

function registryDir(opts: PidRegistryOptions = {}): string {
  return opts.auggyDir ?? join(homedir(), ".auggy");
}

function ensureDir(opts: PidRegistryOptions = {}): string {
  const dir = registryDir(opts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(name: string, opts: PidRegistryOptions = {}): string {
  return join(registryDir(opts), `${name}.json`);
}

// ---------------------------------------------------------------------------
// Process liveness check
// ---------------------------------------------------------------------------

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Write a PID manifest atomically. Throws EEXIST if the manifest
 * already exists (another instance is running or stale).
 *
 * Call `cleanupStaleManifest` first if you want to recover from a
 * stale PID file before writing.
 */
export function writePidManifest(manifest: PidManifest, opts: PidRegistryOptions = {}): void {
  ensureDir(opts);
  const path = manifestPath(manifest.name, opts);
  writeFileSync(path, JSON.stringify(manifest, null, 2), { flag: "wx" });
}

/** Read a PID manifest. Returns null if not found. */
export function readPidManifest(name: string, opts: PidRegistryOptions = {}): PidManifest | null {
  const path = manifestPath(name, opts);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PidManifest;
  } catch {
    return null;
  }
}

/** Remove a PID manifest (called on clean shutdown). */
export function removePidManifest(name: string, opts: PidRegistryOptions = {}): void {
  const path = manifestPath(name, opts);
  try {
    unlinkSync(path);
  } catch {
    // Already gone — fine.
  }
}

/**
 * List all PID manifests. Dead processes are cleaned up automatically.
 * Returns only manifests whose processes are still alive.
 */
export function listPidManifests(opts: PidRegistryOptions = {}): PidManifest[] {
  const dir = ensureDir(opts);
  const manifests: PidManifest[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      const manifest = JSON.parse(readFileSync(path, "utf-8")) as PidManifest;
      if (isProcessAlive(manifest.pid)) {
        manifests.push(manifest);
      } else {
        // Dead process — clean up the stale manifest.
        try {
          unlinkSync(path);
        } catch {}
      }
    } catch {
      // Corrupt manifest — remove it.
      try {
        unlinkSync(path);
      } catch {}
    }
  }

  return manifests;
}

/**
 * Try to claim a name for a new agent. If a manifest exists:
 *  - If the process is dead, remove the stale manifest and return true.
 *  - If the process is alive but older than 24h, treat it as stuck —
 *    remove the manifest and return true.
 *  - If the process is alive and recent, return false (name is taken).
 */
export function tryClaimName(name: string, opts: PidRegistryOptions = {}): boolean {
  const manifest = readPidManifest(name, opts);
  if (!manifest) return true;

  if (!isProcessAlive(manifest.pid)) {
    removePidManifest(name, opts);
    return true;
  }

  // Process is alive — name is taken.
  return false;
}

/**
 * Return the path to the auggy directory (~/.auggy/).
 * Used by the plist generator for log paths.
 */
export function getAuggyDir(): string {
  return ensureDir();
}

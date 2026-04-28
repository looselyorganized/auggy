/**
 * auggy stop <name> — stop a running agent.
 *
 * Handles both dev (foreground) and launchd modes:
 *   - dev: send SIGTERM, wait, SIGKILL if needed
 *   - launchd: launchctl unload, clean up plist + symlink
 */

import { unlinkSync } from "node:fs";
import { $ } from "bun";
import { readPidManifest, removePidManifest, isProcessAlive } from "../pid-registry";
import { plistStorePath, plistInstallPath } from "../plist-generator";

export async function runStop(name: string): Promise<void> {
  const manifest = readPidManifest(name);

  if (!manifest) {
    console.log(`Agent "${name}" is not running.`);
    return;
  }

  if (manifest.mode === "launchd") {
    await stopLaunchd(name, manifest.pid);
  } else {
    await stopDev(name, manifest.pid);
  }
}

async function stopLaunchd(name: string, pid: number): Promise<void> {
  const installPath = plistInstallPath(name);
  const storePath = plistStorePath(name);

  // Unload the launchd service.
  try {
    await $`launchctl unload ${installPath}`.quiet();
  } catch {}

  // Wait for the process to exit.
  let waited = 0;
  while (isProcessAlive(pid) && waited < 5000) {
    await Bun.sleep(250);
    waited += 250;
  }

  // Clean up plist files.
  try {
    unlinkSync(installPath);
  } catch {}
  try {
    unlinkSync(storePath);
  } catch {}

  // Clean up PID manifest.
  removePidManifest(name);

  console.log(`Agent "${name}" stopped (was launchd-managed).`);
}

async function stopDev(name: string, pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    removePidManifest(name);
    console.log(`Agent "${name}" was not running (stale PID ${pid} cleaned up).`);
    return;
  }

  // Send SIGTERM for graceful shutdown.
  process.kill(pid, "SIGTERM");

  // Wait up to 5s for graceful shutdown.
  let waited = 0;
  while (isProcessAlive(pid) && waited < 5000) {
    await Bun.sleep(250);
    waited += 250;
  }

  // Force kill if still alive.
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await Bun.sleep(500);
  }

  removePidManifest(name);
  console.log(`Agent "${name}" stopped.`);
}

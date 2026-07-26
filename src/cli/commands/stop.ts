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
    await stopLaunchd(manifest);
  } else {
    await stopDev(manifest);
  }
}

async function stopLaunchd(
  manifest: NonNullable<ReturnType<typeof readPidManifest>>,
): Promise<void> {
  const key = manifest.agentId ?? manifest.name;
  const installPath = plistInstallPath(key);
  const storePath = plistStorePath(key);

  // Unload the launchd service.
  try {
    await $`launchctl unload ${installPath}`.quiet();
  } catch {}

  // Wait for the process to exit.
  let waited = 0;
  while (isProcessAlive(manifest.pid) && waited < 5000) {
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
  removePidManifest(key);

  console.log(`Agent "${manifest.name}" stopped (was launchd-managed).`);
}

async function stopDev(manifest: NonNullable<ReturnType<typeof readPidManifest>>): Promise<void> {
  const key = manifest.agentId ?? manifest.name;
  if (!isProcessAlive(manifest.pid)) {
    removePidManifest(key);
    console.log(`Agent "${manifest.name}" was not running (stale PID ${manifest.pid} cleaned up).`);
    return;
  }

  // Send SIGTERM for graceful shutdown.
  process.kill(manifest.pid, "SIGTERM");

  // Wait up to 5s for graceful shutdown.
  let waited = 0;
  while (isProcessAlive(manifest.pid) && waited < 5000) {
    await Bun.sleep(250);
    waited += 250;
  }

  // Force kill if still alive.
  if (isProcessAlive(manifest.pid)) {
    process.kill(manifest.pid, "SIGKILL");
    await Bun.sleep(500);
  }

  removePidManifest(key);
  console.log(`Agent "${manifest.name}" stopped.`);
}

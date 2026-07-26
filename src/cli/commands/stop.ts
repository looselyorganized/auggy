/**
 * auggy stop <name> — stop a running agent.
 *
 * Handles both dev (foreground) and launchd modes:
 *   - dev: send SIGTERM, wait, SIGKILL if needed
 *   - launchd: launchctl unload, clean up plist + symlink
 */

import { unlinkSync } from "node:fs";
import { $ } from "bun";
import { inspectRuntimeProcess, readPidManifest, removePidManifest } from "../pid-registry";
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
  while (inspectRuntimeProcess(manifest) === "alive" && waited < 5000) {
    await Bun.sleep(250);
    waited += 250;
  }

  if (inspectRuntimeProcess(manifest) === "unverifiable") {
    throw new Error(
      `Cannot verify that PID ${manifest.pid} still belongs to agent "${manifest.name}". Refusing unsafe cleanup.`,
    );
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
  const initialStatus = inspectRuntimeProcess(manifest);
  if (initialStatus === "gone" || initialStatus === "reused") {
    removePidManifest(key);
    console.log(`Agent "${manifest.name}" was not running (stale PID ${manifest.pid} cleaned up).`);
    return;
  }
  if (initialStatus === "unverifiable") {
    throw new Error(
      `Cannot verify that PID ${manifest.pid} belongs to agent "${manifest.name}". Refusing to signal it; stop the legacy process manually and inspect its manifest.`,
    );
  }

  // Send SIGTERM for graceful shutdown.
  process.kill(manifest.pid, "SIGTERM");

  // Wait up to 5s for graceful shutdown.
  let waited = 0;
  while (inspectRuntimeProcess(manifest) === "alive" && waited < 5000) {
    await Bun.sleep(250);
    waited += 250;
  }

  // Force kill if still alive.
  const finalStatus = inspectRuntimeProcess(manifest);
  if (finalStatus === "unverifiable") {
    throw new Error(
      `Lost process-incarnation verification for agent "${manifest.name}". Refusing to signal PID ${manifest.pid}.`,
    );
  }
  if (finalStatus === "alive") {
    process.kill(manifest.pid, "SIGKILL");
    await Bun.sleep(500);
  }

  removePidManifest(key);
  console.log(`Agent "${manifest.name}" stopped.`);
}

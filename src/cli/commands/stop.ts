/**
 * auggy stop <name> — stop a running agent.
 *
 * Handles both dev (foreground) and launchd modes:
 *   - dev: send SIGTERM, wait, SIGKILL if needed
 *   - launchd: launchctl unload, clean up plist + symlink
 */

import { unlinkSync } from "node:fs";
import { $ } from "bun";
import { inspectRuntimeProcess, readPidManifest, removePidManifestIfOwned } from "../pid-registry";
import { plistStorePath, plistInstallPath } from "../plist-generator";

interface StopOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Deterministic process-incarnation inspection for tests. */
  processIdentityForPid?: (pid: number) => string | null;
  /** Test seam for launchctl unload. */
  unloadLaunchd?: (installPath: string) => Promise<void>;
  /** Test seam for signals. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam for bounded polling. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function runStop(name: string, opts: StopOptions = {}): Promise<void> {
  const manifest = readPidManifest(name, { auggyDir: opts.auggyDir });

  if (!manifest) {
    console.log(`Agent "${name}" is not running.`);
    return;
  }

  if (manifest.mode === "launchd") {
    await stopLaunchd(manifest, opts);
  } else {
    await stopDev(manifest, opts);
  }
}

async function stopLaunchd(
  manifest: NonNullable<ReturnType<typeof readPidManifest>>,
  opts: StopOptions,
): Promise<void> {
  const key = manifest.agentId ?? manifest.name;
  const installPath = plistInstallPath(key);
  const storePath = plistStorePath(key);

  // Unload the launchd service.
  try {
    if (opts.unloadLaunchd) await opts.unloadLaunchd(installPath);
    else await $`launchctl unload ${installPath}`.quiet();
  } catch (error) {
    throw new Error(
      `Could not unload launchd agent "${manifest.name}". Its plist, manifest, and resource claims were preserved.`,
      { cause: error },
    );
  }

  // Wait for the process to exit.
  let waited = 0;
  while (
    inspectRuntimeProcess(manifest, {
      processIdentityForPid: opts.processIdentityForPid,
    }) === "alive" &&
    waited < 5000
  ) {
    await (opts.sleep ?? Bun.sleep)(250);
    waited += 250;
  }

  const finalStatus = inspectRuntimeProcess(manifest, {
    processIdentityForPid: opts.processIdentityForPid,
  });
  if (finalStatus === "unverifiable") {
    throw new Error(
      `Cannot verify that PID ${manifest.pid} still belongs to agent "${manifest.name}". Refusing unsafe cleanup.`,
    );
  }
  if (finalStatus === "alive") {
    throw new Error(
      `Launchd agent "${manifest.name}" did not exit after unload. Its manifest and resource claims were preserved; stop PID ${manifest.pid} before retrying.`,
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
  removePidManifestIfOwned(manifest, { auggyDir: opts.auggyDir });

  console.log(`Agent "${manifest.name}" stopped (was launchd-managed).`);
}

async function stopDev(
  manifest: NonNullable<ReturnType<typeof readPidManifest>>,
  opts: StopOptions,
): Promise<void> {
  const processOptions = { processIdentityForPid: opts.processIdentityForPid };
  const initialStatus = inspectRuntimeProcess(manifest, processOptions);
  if (initialStatus === "gone" || initialStatus === "reused") {
    removePidManifestIfOwned(manifest, { auggyDir: opts.auggyDir });
    console.log(`Agent "${manifest.name}" was not running (stale PID ${manifest.pid} cleaned up).`);
    return;
  }
  if (initialStatus === "unverifiable") {
    throw new Error(
      `Cannot verify that PID ${manifest.pid} belongs to agent "${manifest.name}". Refusing to signal it; stop the legacy process manually and inspect its manifest.`,
    );
  }

  // Send SIGTERM for graceful shutdown.
  (opts.killProcess ?? process.kill)(manifest.pid, "SIGTERM");

  // Wait up to 5s for graceful shutdown.
  let waited = 0;
  while (inspectRuntimeProcess(manifest, processOptions) === "alive" && waited < 5000) {
    await (opts.sleep ?? Bun.sleep)(250);
    waited += 250;
  }

  // Force kill if still alive.
  const finalStatus = inspectRuntimeProcess(manifest, processOptions);
  if (finalStatus === "unverifiable") {
    throw new Error(
      `Lost process-incarnation verification for agent "${manifest.name}". Refusing to signal PID ${manifest.pid}.`,
    );
  }
  if (finalStatus === "alive") {
    (opts.killProcess ?? process.kill)(manifest.pid, "SIGKILL");
    await (opts.sleep ?? Bun.sleep)(500);
    const postKillStatus = inspectRuntimeProcess(manifest, processOptions);
    if (postKillStatus === "unverifiable") {
      throw new Error(
        `Lost process-incarnation verification for agent "${manifest.name}" after SIGKILL. Its manifest and resource claims were preserved.`,
      );
    }
    if (postKillStatus === "alive") {
      throw new Error(
        `Agent "${manifest.name}" remained alive after SIGKILL. Its manifest and resource claims were preserved; stop PID ${manifest.pid} before retrying.`,
      );
    }
  }

  removePidManifestIfOwned(manifest, { auggyDir: opts.auggyDir });
  console.log(`Agent "${manifest.name}" stopped.`);
}

/**
 * auggy stop <name> — stop a running agent.
 *
 * Handles both dev (foreground) and launchd modes:
 *   - dev: send SIGTERM, wait, SIGKILL if needed
 *   - launchd: launchctl unload, clean up plist + symlink
 */

import { unlinkSync } from "node:fs";
import { $ } from "bun";
import {
  claimAgentLifecycle,
  inspectRuntimeProcess,
  readPidManifest,
  removePidManifestIfOwned,
} from "../pid-registry";
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
  /** Internal: restart holds the lifecycle lease across stop and start. */
  lifecycleOwned?: boolean;
  /** Test seam for fail-closed artifact cleanup. */
  unlinkFile?: (path: string) => void;
}

export async function runStop(name: string, opts: StopOptions = {}): Promise<void> {
  const initialManifest = readPidManifest(name, { auggyDir: opts.auggyDir });

  if (!initialManifest) {
    console.log(`Agent "${name}" is not running.`);
    return;
  }
  const releaseLifecycle =
    opts.lifecycleOwned || !initialManifest.agentId
      ? () => {}
      : claimAgentLifecycle(initialManifest.agentId, initialManifest.name, {
          auggyDir: opts.auggyDir,
          processIdentityForPid: opts.processIdentityForPid,
        });
  try {
    const manifest = readPidManifest(initialManifest.agentId ?? name, {
      auggyDir: opts.auggyDir,
    });
    if (!manifest) {
      console.log(`Agent "${initialManifest.name}" is not running.`);
      return;
    }

    if (manifest.mode === "launchd") {
      await stopLaunchd(manifest, opts);
    } else {
      await stopDev(manifest, opts);
    }
  } finally {
    releaseLifecycle();
  }
}

function unlinkIfPresent(path: string, unlinkFile: (path: string) => void): void {
  try {
    unlinkFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

  const readCurrentGeneration = () => {
    const current = readPidManifest(key, { auggyDir: opts.auggyDir });
    if (!current) return null;
    if (
      current.agentId !== manifest.agentId ||
      current.mode !== "launchd" ||
      current.launchGeneration !== manifest.launchGeneration
    ) {
      throw new Error(
        `Agent "${manifest.name}" changed runtime generation while stopping. Its manifest and claims were preserved.`,
      );
    }
    return current;
  };

  // Follow same-generation KeepAlive replacements rather than checking only
  // the PID captured before launchctl unload.
  let waited = 0;
  let current = readCurrentGeneration();
  while (
    current &&
    inspectRuntimeProcess(current, {
      processIdentityForPid: opts.processIdentityForPid,
    }) === "alive" &&
    waited < 5000
  ) {
    await (opts.sleep ?? Bun.sleep)(250);
    waited += 250;
    current = readCurrentGeneration();
  }

  current = readCurrentGeneration();
  const finalStatus = current
    ? inspectRuntimeProcess(current, {
        processIdentityForPid: opts.processIdentityForPid,
      })
    : "gone";
  if (finalStatus === "unverifiable") {
    throw new Error(
      `Cannot verify that the current launchd process still belongs to agent "${manifest.name}". Refusing unsafe cleanup.`,
    );
  }
  if (finalStatus === "alive") {
    throw new Error(
      `Launchd agent "${manifest.name}" did not exit after unload. Its manifest and resource claims were preserved; stop PID ${current?.pid ?? manifest.pid} before retrying.`,
    );
  }

  // Clean up plist files.
  try {
    unlinkIfPresent(installPath, opts.unlinkFile ?? unlinkSync);
    unlinkIfPresent(storePath, opts.unlinkFile ?? unlinkSync);
  } catch (error) {
    throw new Error(
      `Launchd agent "${manifest.name}" exited, but its control artifacts could not be removed. Its manifest and claims were preserved for recovery.`,
      { cause: error },
    );
  }

  // Re-check after artifact removal so a replacement published during cleanup
  // cannot be reported as stopped and abandoned.
  const postCleanup = readCurrentGeneration();
  if (postCleanup) {
    const status = inspectRuntimeProcess(postCleanup, {
      processIdentityForPid: opts.processIdentityForPid,
    });
    if (status === "alive" || status === "unverifiable") {
      throw new Error(
        `Launchd agent "${manifest.name}" changed process ownership during cleanup. Its manifest and claims were preserved for manual recovery.`,
      );
    }
    removePidManifestIfOwned(postCleanup, { auggyDir: opts.auggyDir });
  }

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

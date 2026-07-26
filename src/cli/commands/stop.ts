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
  closeLaunchdGeneration,
  inspectRuntimeProcess,
  readLaunchdGenerationState,
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
  /** Test/recovery seam for immutable-id launchd artifacts. */
  paths?: { installPath: string; storePath: string };
}

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function runStop(name: string, opts: StopOptions = {}): Promise<void> {
  const initialManifest = readPidManifest(name, { auggyDir: opts.auggyDir });

  if (!initialManifest) {
    if (AGENT_ID_RE.test(name)) {
      const state = readLaunchdGenerationState(name, { auggyDir: opts.auggyDir });
      if (state) {
        await stopManifestlessLaunchd(name, state.launchGeneration, opts);
        return;
      }
    }
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

async function stopManifestlessLaunchd(
  agentId: string,
  launchGeneration: string,
  opts: StopOptions,
): Promise<void> {
  const releaseLifecycle = claimAgentLifecycle(agentId, "launchd-recovery", {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  });
  try {
    const appeared = readPidManifest(agentId, { auggyDir: opts.auggyDir });
    if (appeared) {
      if (appeared.mode === "launchd")
        await stopLaunchd(appeared, { ...opts, lifecycleOwned: true });
      else await stopDev(appeared, opts);
      return;
    }

    closeLaunchdGeneration(agentId, launchGeneration, {
      auggyDir: opts.auggyDir,
      processIdentityForPid: opts.processIdentityForPid,
    });
    const installPath = opts.paths?.installPath ?? plistInstallPath(agentId);
    const storePath = opts.paths?.storePath ?? plistStorePath(agentId);
    try {
      if (opts.unloadLaunchd) await opts.unloadLaunchd(installPath);
      else await $`launchctl unload ${installPath}`.quiet();
    } catch (error) {
      throw new Error(
        `Could not unload manifestless launchd agent ${agentId}. Its generation remains closed; inspect launchd before retrying.`,
        { cause: error },
      );
    }

    const delayed = readPidManifest(agentId, { auggyDir: opts.auggyDir });
    if (delayed) {
      const status = inspectRuntimeProcess(delayed, {
        processIdentityForPid: opts.processIdentityForPid,
      });
      if (status === "alive" || status === "unverifiable") {
        throw new Error(
          `Manifestless launchd recovery found a live or unverifiable process for ${agentId}. Its generation remains closed for manual recovery.`,
        );
      }
      removePidManifestIfOwned(delayed, { auggyDir: opts.auggyDir });
    }
    unlinkIfPresent(installPath, opts.unlinkFile ?? unlinkSync);
    unlinkIfPresent(storePath, opts.unlinkFile ?? unlinkSync);
    console.log(`Agent "${agentId}" stopped (manifestless launchd recovery).`);
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
  const installPath = opts.paths?.installPath ?? plistInstallPath(key);
  const storePath = opts.paths?.storePath ?? plistStorePath(key);

  if (!manifest.agentId || !manifest.launchGeneration) {
    throw new Error(
      `Launchd agent "${manifest.name}" has no verifiable installation generation. Refusing unsafe stop; reinstall it before retrying.`,
    );
  }
  // Close the generation before unload. A KeepAlive child that has not yet
  // published its manifest will fail runtime admission, including after this
  // command's final manifest read.
  closeLaunchdGeneration(manifest.agentId, manifest.launchGeneration, {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  });

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

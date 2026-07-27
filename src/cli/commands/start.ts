/**
 * auggy start <name> — install an agent as a launchd service.
 *
 * Generates a plist, symlinks it to ~/Library/LaunchAgents/, and
 * loads it via launchctl. The plist invokes `auggy dev <name>` so
 * launchd handles daemonization and restart.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { $ } from "bun";
import { parseConfig } from "../config-parser";
import {
  generatePlist,
  logDir,
  plistInstallPath,
  plistLabel,
  plistStorePath,
} from "../plist-generator";
import {
  activateLaunchdGeneration,
  claimAgentLifecycle,
  closeActiveLaunchdGeneration,
  closeLaunchdGeneration,
  formatAgentAlreadyRunningMessage,
  inspectRuntimeProcess,
  readPidManifest,
  readLivePidManifest,
  removePidManifestIfOwned,
} from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";
import { assertDistributedCoordinationStartupAllowed } from "../../coordination/topology";

interface StartOptions {
  config?: string;
  cwd?: string;
  /** Internal/test seams. */
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
  lifecycleOwned?: boolean;
  listLaunchd?: () => Promise<string>;
  unloadLaunchd?: (installPath: string) => Promise<void>;
  loadLaunchd?: (installPath: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  maxWaitMs?: number;
  paths?: { installPath: string; storePath: string; logDirectory: string };
  unlinkFile?: (path: string) => void;
  writePlist?: (path: string, content: string) => void;
  linkPlist?: (target: string, path: string) => void;
  makeDirectory?: (path: string) => void;
}

function resolveBunPath(): string {
  return process.execPath;
}

function resolveCliEntryPoint(): string {
  return resolve(import.meta.dir, "../index.ts");
}

function unlinkIfPresent(path: string, unlinkFile: (path: string) => void): void {
  try {
    unlinkFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function runStart(name: string | undefined, opts: StartOptions): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const agentDir = dirname(configPath);
  const config = parseConfig(configPath);
  assertDistributedCoordinationStartupAllowed(config.settings.coordination, {
    configuredAugments: config.augments.length > 0,
  });
  const agentName = config.name;
  const processOptions = {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  };
  const releaseLifecycle = opts.lifecycleOwned
    ? () => {}
    : claimAgentLifecycle(config.id, agentName, processOptions);

  try {
    const runningManifest = readLivePidManifest(config.id, processOptions);
    if (runningManifest) {
      throw new Error(formatAgentAlreadyRunningMessage(agentName, runningManifest));
    }

    // Supersede any previously installed generation before interacting with
    // launchd. An already-spawned old KeepAlive child must fail admission even
    // while unload and artifact replacement are still in progress.
    closeActiveLaunchdGeneration(config.id, processOptions);

    const label = plistLabel(config.id);
    const paths =
      opts.paths ??
      ({
        installPath: plistInstallPath(config.id),
        storePath: plistStorePath(config.id),
        logDirectory: logDir(),
      } satisfies NonNullable<StartOptions["paths"]>);
    const unlinkFile = opts.unlinkFile ?? unlinkSync;
    const unloadLaunchd =
      opts.unloadLaunchd ??
      (async (installPath: string) => {
        await $`launchctl unload ${installPath}`.quiet();
      });
    const loadLaunchd =
      opts.loadLaunchd ??
      (async (installPath: string) => {
        await $`launchctl load ${installPath}`.quiet();
      });
    const listed = opts.listLaunchd
      ? await opts.listLaunchd()
      : (await $`launchctl list`.quiet()).stdout.toString();
    if (listed.includes(label)) {
      try {
        await unloadLaunchd(paths.installPath);
      } catch (error) {
        throw new Error(
          `Could not unload the existing launchd job for immutable agent ${config.id}; its configuration was preserved.`,
          { cause: error },
        );
      }
    }

    unlinkIfPresent(paths.installPath, unlinkFile);
    unlinkIfPresent(paths.storePath, unlinkFile);

    const replacementDuringUnload = readLivePidManifest(config.id, processOptions);
    if (replacementDuringUnload) {
      throw new Error(formatAgentAlreadyRunningMessage(agentName, replacementDuringUnload));
    }

    const launchGeneration = randomUUID();
    const plist = generatePlist({
      name: agentName,
      agentId: config.id,
      launchGeneration,
      agentDir: resolve(agentDir),
      configPath: resolve(configPath),
      bunPath: resolveBunPath(),
      cliEntryPoint: resolveCliEntryPoint(),
    });

    const makeDirectory = opts.makeDirectory ?? ((path) => mkdirSync(path, { recursive: true }));
    makeDirectory(dirname(paths.storePath));
    makeDirectory(dirname(paths.installPath));
    makeDirectory(paths.logDirectory);

    let loadAttempted = false;
    let generationActivated = false;
    try {
      activateLaunchdGeneration(config.id, launchGeneration, processOptions);
      generationActivated = true;
      (opts.writePlist ?? writeFileSync)(paths.storePath, plist);
      (opts.linkPlist ?? symlinkSync)(paths.storePath, paths.installPath);
      loadAttempted = true;
      await loadLaunchd(paths.installPath);

      const maxWaitMs = opts.maxWaitMs ?? 8_000;
      const pollInterval = Math.min(500, Math.max(1, maxWaitMs));
      let waited = 0;
      while (waited < maxWaitMs) {
        await (opts.sleep ?? Bun.sleep)(pollInterval);
        waited += pollInterval;

        const manifest = readLivePidManifest(config.id, processOptions);
        if (!manifest) continue;
        if (
          manifest.mode !== "launchd" ||
          manifest.launchGeneration !== launchGeneration ||
          resolve(manifest.configPath) !== resolve(configPath) ||
          resolve(manifest.agentDir) !== resolve(agentDir)
        ) {
          throw new Error(
            `Agent "${agentName}" published a runtime manifest that does not acknowledge this launchd installation generation.`,
          );
        }

        console.log(`Agent "${agentName}" installed and running (PID ${manifest.pid})`);
        console.log();
        console.log("  Mode:    always-on (launchd-managed)");
        console.log("  Restart: automatic on crash");
        if (manifest.port) console.log(`  URL:     http://localhost:${manifest.port}`);
        console.log(`  Logs:    ${paths.logDirectory}/${config.id}.{log,err}`);
        console.log();
        console.log(`  To stop:   auggy stop ${config.id}`);
        console.log(`  To status: auggy status ${config.id}`);
        console.log(`  To logs:   tail -f ${paths.logDirectory}/${config.id}.log`);
        return;
      }
      throw new Error(
        `Agent "${agentName}" did not start within ${maxWaitMs / 1000}s. Check logs at ${paths.logDirectory}/${config.id}.err.`,
      );
    } catch (error) {
      let closeError: unknown;
      if (generationActivated) {
        try {
          closeLaunchdGeneration(config.id, launchGeneration, processOptions);
        } catch (failure) {
          closeError = failure;
        }
      }
      if (loadAttempted) {
        try {
          await unloadLaunchd(paths.installPath);
        } catch (rollbackError) {
          throw new Error(
            `Launchd start failed and rollback could not unload the installed job. Its artifacts were preserved for operator recovery.`,
            {
              cause: new AggregateError(
                [error, closeError, rollbackError].filter(
                  (candidate): candidate is object => candidate !== undefined,
                ),
              ),
            },
          );
        }
      }
      if (closeError) {
        throw new Error(
          "Launchd start failed and its installation generation could not be closed. The job was unloaded; inspect runtime state before retrying.",
          { cause: new AggregateError([error, closeError]) },
        );
      }
      try {
        await reconcileFailedLaunchdRuntime(config.id, launchGeneration, processOptions, opts);
      } catch (reconciliationError) {
        throw new Error(
          `Launchd start failed and rollback could not verify that the admitted runtime exited. Its artifacts, manifest, and claims were preserved for operator recovery.`,
          { cause: new AggregateError([error, reconciliationError]) },
        );
      }
      try {
        unlinkIfPresent(paths.installPath, unlinkFile);
        unlinkIfPresent(paths.storePath, unlinkFile);
      } catch (cleanupError) {
        throw new Error("Launchd start failed and its inactive artifacts could not be removed.", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
      throw error;
    }
  } finally {
    releaseLifecycle();
  }
}

async function reconcileFailedLaunchdRuntime(
  agentId: string,
  launchGeneration: string,
  processOptions: {
    auggyDir?: string;
    processIdentityForPid?: (pid: number) => string | null;
  },
  opts: StartOptions,
): Promise<void> {
  const readCurrent = () => {
    const current = readPidManifest(agentId, processOptions);
    if (!current) return null;
    if (
      current.agentId !== agentId ||
      current.mode !== "launchd" ||
      current.launchGeneration !== launchGeneration
    ) {
      throw new Error("Runtime ownership changed during launchd start rollback");
    }
    return current;
  };

  let waited = 0;
  let current = readCurrent();
  while (current && inspectRuntimeProcess(current, processOptions) === "alive" && waited < 5000) {
    await (opts.sleep ?? Bun.sleep)(250);
    waited += 250;
    current = readCurrent();
  }

  current = readCurrent();
  const status = current ? inspectRuntimeProcess(current, processOptions) : "gone";
  if (status === "alive" || status === "unverifiable") {
    throw new Error(
      `Launchd generation ${launchGeneration} remains ${status} after rollback unload`,
    );
  }
  if (current) removePidManifestIfOwned(current, processOptions);
}

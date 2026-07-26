/**
 * auggy restart <name> — stop + start in one command.
 *
 * Reads the PID manifest to determine mode (dev vs launchd),
 * stops the agent, then restarts it in the same mode.
 */

import { resolve } from "node:path";
import { parseConfig } from "../config-parser";
import { claimAgentLifecycle, readPidManifest } from "../pid-registry";
import type { PidManifest } from "../types";
import { runStop } from "./stop";
import { runStart } from "./start";
import { runDev } from "./dev";

interface RestartOptions {
  config?: string;
  /** Deterministic lifecycle seams for race regression tests. */
  _readPidManifest?: typeof readPidManifest;
  _claimAgentLifecycle?: typeof claimAgentLifecycle;
  _runStop?: typeof runStop;
  _runStart?: typeof runStart;
  _runDev?: typeof runDev;
  _sleep?: (milliseconds: number) => Promise<void>;
}

export async function runRestart(name: string, opts: RestartOptions): Promise<void> {
  const readManifest = opts._readPidManifest ?? readPidManifest;
  const manifest = readManifest(name);

  if (!manifest) {
    console.log(
      `Agent "${name}" is not running. Use "auggy dev ${name}" or "auggy start ${name}" to start it.`,
    );
    return;
  }

  const releaseLifecycle = manifest.agentId
    ? (opts._claimAgentLifecycle ?? claimAgentLifecycle)(manifest.agentId, manifest.name)
    : () => {};

  try {
    // The lease can queue behind another controller. Adopt and validate the
    // current generation only after acquiring it; never stop a replacement
    // and then resurrect the stale pre-lease snapshot.
    const current = readManifest(manifest.agentId ?? name);
    if (!current) {
      console.log(`Agent "${name}" stopped before restart acquired its lifecycle lease.`);
      return;
    }
    if (manifest.agentId && current.agentId !== manifest.agentId) {
      throw new Error("Agent identity changed while restart waited for its lifecycle lease");
    }
    const mode = current.mode;
    const configPath = assertRestartTarget(current, opts.config ?? current.configPath);
    console.log(`Restarting "${current.name}" (${mode} mode)...`);

    // Stop the agent.
    await (opts._runStop ?? runStop)(current.agentId ?? name, { lifecycleOwned: true });

    // Brief pause for port release.
    await (opts._sleep ?? Bun.sleep)(1000);

    // Restart in the same mode.
    if (mode === "launchd") {
      await (opts._runStart ?? runStart)(current.name, {
        config: configPath,
        lifecycleOwned: true,
      });
    } else {
      await (opts._runDev ?? runDev)(current.name, { config: configPath });
    }
  } finally {
    releaseLifecycle();
  }
}

/** Validate a restart target completely before the running process is touched. */
export function assertRestartTarget(manifest: PidManifest, candidatePath: string): string {
  const configPath = resolve(candidatePath);
  const manifestPath = resolve(manifest.configPath);
  if (configPath !== manifestPath) {
    throw new Error("Restart config path does not match the running agent manifest");
  }
  const config = parseConfig(configPath);
  if (manifest.agentId && config.id !== manifest.agentId) {
    throw new Error("Restart config identity does not match the running agent manifest");
  }
  if (!manifest.agentId && config.name !== manifest.name) {
    throw new Error("Restart config name does not match the legacy running agent manifest");
  }
  return configPath;
}

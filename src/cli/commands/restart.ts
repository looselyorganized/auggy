/**
 * auggy restart <name> — stop + start in one command.
 *
 * Reads the PID manifest to determine mode (dev vs launchd),
 * stops the agent, then restarts it in the same mode.
 */

import { resolve } from "node:path";
import { parseConfig } from "../config-parser";
import { readPidManifest } from "../pid-registry";
import type { PidManifest } from "../types";
import { runStop } from "./stop";
import { runStart } from "./start";
import { runDev } from "./dev";

export async function runRestart(name: string, opts: { config?: string }): Promise<void> {
  const manifest = readPidManifest(name);

  if (!manifest) {
    console.log(
      `Agent "${name}" is not running. Use "auggy dev ${name}" or "auggy start ${name}" to start it.`,
    );
    return;
  }

  const mode = manifest.mode;
  const configPath = assertRestartTarget(manifest, opts.config ?? manifest.configPath);

  console.log(`Restarting "${name}" (${mode} mode)...`);

  // Stop the agent.
  await runStop(manifest.agentId ?? name);

  // Brief pause for port release.
  await Bun.sleep(1000);

  // Restart in the same mode.
  if (mode === "launchd") {
    await runStart(name, { config: configPath });
  } else {
    await runDev(name, { config: configPath });
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

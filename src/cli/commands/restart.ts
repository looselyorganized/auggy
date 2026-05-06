/**
 * auggy restart <name> — stop + start in one command.
 *
 * Reads the PID manifest to determine mode (dev vs launchd),
 * stops the agent, then restarts it in the same mode.
 */

import { readPidManifest } from "../pid-registry";
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
  const configPath = opts.config ?? manifest.configPath;

  console.log(`Restarting "${name}" (${mode} mode)...`);

  // Stop the agent.
  await runStop(name);

  // Brief pause for port release.
  await Bun.sleep(1000);

  // Restart in the same mode.
  if (mode === "launchd") {
    await runStart(name, { config: configPath });
  } else {
    await runDev(name, { config: configPath });
  }
}

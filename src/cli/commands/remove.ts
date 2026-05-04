/**
 * aug1 remove <name> — delete an agent directory and clear the index entry.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). Tolerates missing localDir (still cleans the index entry).
 */

import { existsSync, rmSync } from "node:fs";
import { confirm } from "@inquirer/prompts";
import { getAgent, removeAgent } from "../agent-index";
import { readPidManifest, isProcessAlive, removePidManifest } from "../pid-registry";

interface RemoveOptions {
  /** Skip the y/N prompt. */
  yes?: boolean;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
}

export async function runRemove(name: string, opts: RemoveOptions = {}): Promise<void> {
  const entry = getAgent(name, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(
      `Agent "${name}" is not registered.\n\n` + `  Run \`aug1 ls\` to see registered agents.`,
    );
  }

  // Refuse if the agent is running. Stale manifests (dead PID) are tolerated
  // — we clean them up below.
  const pid = readPidManifest(name);
  if (pid && isProcessAlive(pid.pid)) {
    throw new Error(`Agent "${name}" is running. Stop it first:\n\n  aug1 stop ${name}`);
  }

  if (!opts.yes) {
    const ok = await confirm({
      message:
        `This will permanently delete:\n  ${entry.localDir}\n\n` +
        `And remove the registry entry for "${name}".\n\nContinue?`,
      default: false,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // Delete the local dir if present (tolerate missing).
  if (existsSync(entry.localDir)) {
    rmSync(entry.localDir, { recursive: true, force: true });
  }

  // Clean up stale PID manifest if any.
  if (pid) removePidManifest(name);

  // Clear index entry.
  removeAgent(name, { auggyDir: opts.auggyDir });

  console.log(`Removed agent "${name}" (was at ${entry.localDir}).`);
}

/**
 * aug1 remove <name> — delete an agent directory and clear the index entry.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). Tolerates missing localDir (still cleans the index entry).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getAgent, removeAgent } from "../agent-index";
import { readPidManifest, isProcessAlive, removePidManifest } from "../pid-registry";

function readConfigName(localDir: string): string | null {
  try {
    const yamlPath = join(localDir, "agent.yaml");
    if (!existsSync(yamlPath)) return null;
    const content = readFileSync(yamlPath, "utf-8");
    const match = content.match(/^name:\s*(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

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
  // — we clean them up below. Check under both the CLI-arg name AND the
  // agent.yaml's config.name (operator may have edited the yaml after create,
  // in which case `aug1 dev` writes the manifest under config.name).
  const pidByCli = readPidManifest(name);
  const configName = readConfigName(entry.localDir);
  const pidByConfig = configName && configName !== name ? readPidManifest(configName) : null;

  const aliveCli = pidByCli && isProcessAlive(pidByCli.pid);
  const aliveConfig = pidByConfig && isProcessAlive(pidByConfig.pid);

  if (aliveCli || aliveConfig) {
    const liveName = aliveCli ? name : configName!;
    throw new Error(`Agent "${liveName}" is running. Stop it first:\n\n  aug1 stop ${liveName}`);
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

  // Delete the local dir if present (tolerate missing). Sanity-check that the
  // dir contains agent.yaml first — refuse to recursively delete if not, since
  // a tampered or corrupt index entry could otherwise nuke arbitrary paths.
  if (existsSync(entry.localDir)) {
    const yamlPath = join(entry.localDir, "agent.yaml");
    if (!existsSync(yamlPath)) {
      throw new Error(
        `Refusing to delete "${entry.localDir}" — it does not contain agent.yaml.\n\n` +
          `  This may indicate a tampered or stale index entry. If the agent dir was\n` +
          `  modified outside aug1, clean up manually and re-run \`aug1 remove\` to\n` +
          `  clear the index entry.`,
      );
    }
    rmSync(entry.localDir, { recursive: true, force: true });
  }

  // Clean up stale PID manifest(s) if any. Remove under whichever name we
  // actually found a manifest at.
  if (pidByCli) removePidManifest(name);
  if (pidByConfig && configName) removePidManifest(configName);

  // Clear index entry.
  removeAgent(name, { auggyDir: opts.auggyDir });

  console.log(`Removed agent "${name}" (was at ${entry.localDir}).`);
}

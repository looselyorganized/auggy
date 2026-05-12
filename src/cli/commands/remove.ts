/**
 * auggy remove <name> — delete an agent directory and clear the index entry.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). Tolerates missing localDir (still cleans the index entry).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { clearCloud, getAgent, removeAgent } from "../agent-index";
import { createRailwayCli, type RailwayCli } from "../deploy/railway-cli";
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
  /** When set with a cloud-deployed agent, also destroy the Railway service. */
  cloud?: boolean;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Inject a RailwayCli for tests (defaults to the real one). */
  railwayCli?: RailwayCli;
}

export async function runRemove(name: string, opts: RemoveOptions = {}): Promise<void> {
  const entry = getAgent(name, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(
      `Agent "${name}" is not registered.\n\n  Run \`auggy ls\` to see registered agents.`,
    );
  }

  // Refuse if the agent is running. Stale manifests (dead PID) are tolerated
  // — we clean them up below. Check under both the CLI-arg name AND the
  // agent.yaml's config.name (operator may have edited the yaml after create,
  // in which case `auggy dev` writes the manifest under config.name).
  const pidByCli = readPidManifest(name);
  const configName = readConfigName(entry.localDir);
  const pidByConfig = configName && configName !== name ? readPidManifest(configName) : null;

  const aliveCli = pidByCli && isProcessAlive(pidByCli.pid);
  const aliveConfig = pidByConfig && isProcessAlive(pidByConfig.pid);

  if (aliveCli || aliveConfig) {
    const liveName = aliveCli ? name : configName!;
    throw new Error(`Agent "${liveName}" is running. Stop it first:\n\n  auggy stop ${liveName}`);
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
          `  modified outside auggy, clean up manually and re-run \`auggy remove\` to\n` +
          `  clear the index entry.`,
      );
    }
    rmSync(entry.localDir, { recursive: true, force: true });
  }

  // Clean up stale PID manifest(s) if any. Remove under whichever name we
  // actually found a manifest at.
  if (pidByCli) removePidManifest(name);
  if (pidByConfig && configName) removePidManifest(configName);

  // --cloud: also destroy the Railway service before clearing the index.
  // We do this AFTER local cleanup so a failed Railway call doesn't leave
  // local state in an inconsistent half-deleted shape.
  if (opts.cloud && entry.cloud) {
    const cli = opts.railwayCli ?? createRailwayCli();
    // `railway service delete` needs to be run from a dir linked to the
    // service. Create a temp dir, link it, then delete.
    const tmp = mkdtempSync(join(tmpdir(), `auggy-remove-${name}-`));
    try {
      await cli.link({
        projectId: entry.cloud.projectId,
        serviceName: name,
        cwd: tmp,
      });
      await cli.destroyService({ cwd: tmp });
      console.log(`Destroyed Railway service "${name}" (project ${entry.cloud.projectId}).`);
    } catch (err) {
      console.warn(
        `warn: Railway service destruction failed: ${(err as Error).message}\n` +
          `  Local cleanup proceeding; remove the Railway service manually if needed.`,
      );
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
    clearCloud(name, { auggyDir: opts.auggyDir });
  }

  // Clear index entry.
  removeAgent(name, { auggyDir: opts.auggyDir });

  console.log(`Removed agent "${name}" (was at ${entry.localDir}).`);
}

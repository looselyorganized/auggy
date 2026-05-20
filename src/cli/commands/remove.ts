/**
 * auggy remove <name> — delete an agent directory.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). The agent dir is the source of truth — removing it removes the
 * agent entirely.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getAgent, removeAgent } from "../agent-index";
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
      `Agent "${name}" not found.\n\n  Run \`auggy ls\` to see scaffolded agents.`,
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
      message: `This will permanently delete:\n  ${entry.localDir}\n\nContinue?`,
      default: false,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // --cloud: destroy the Railway service BEFORE removing the local dir,
  // because the cloud record lives inside the dir's .auggy-meta.json.
  if (opts.cloud && entry.cloud) {
    const cli = opts.railwayCli ?? createRailwayCli();
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
  }

  // Clean up stale PID manifest(s) if any.
  if (pidByCli) removePidManifest(name);
  if (pidByConfig && configName) removePidManifest(configName);

  // Remove the agent dir. `removeAgent` refuses paths that don't contain
  // agent.yaml as a guard against accidental nukes.
  removeAgent(name, { auggyDir: opts.auggyDir });

  console.log(`Removed agent "${name}" (was at ${entry.localDir}).`);
}

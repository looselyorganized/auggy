/**
 * auggy remove [name] — delete an agent project.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). The agent dir is the source of truth — removing it removes the
 * agent entirely.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getAgentFromDir } from "../agent-index";
import { createRailwayCli, type RailwayCli } from "../deploy/railway-cli";
import { readPidManifest, isProcessAlive, removePidManifest } from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";

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
  cwd?: string;
  /** Inject a RailwayCli for tests (defaults to the real one). */
  railwayCli?: RailwayCli;
}

export async function runRemove(name: string | undefined, opts: RemoveOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const cwdAgentDir = existsSync(join(cwd, "agent.yaml")) ? cwd : null;
  const cwdConfigName = cwdAgentDir ? readConfigName(cwdAgentDir) : null;
  if (name && cwdAgentDir && name !== cwdConfigName) {
    throw new Error(
      `Refusing to remove the current agent project for argument "${name}".\n\n` +
        `If you meant to remove an augment, run:\n` +
        `  auggy augment remove ${name}`,
    );
  }
  const configPath = resolveConfigPath(name, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  const localDir = dirname(configPath);
  const entry = getAgentFromDir(localDir);
  const configName = readConfigName(localDir);
  const displayName = configName ?? name ?? "this agent";
  const localConfig = resolve(cwd, "agent.yaml");
  if (name && localConfig === resolve(configPath) && name !== configName) {
    throw new Error(
      `Refusing to remove the current agent project for argument "${name}".\n\n` +
        `If you meant to remove an augment, run:\n` +
        `  auggy augment remove ${name}`,
    );
  }
  if (!entry) {
    throw new Error(
      `Agent "${displayName}" not found.\n\n  Run from inside an agent project or its parent.`,
    );
  }

  // Refuse if the agent is running. Stale manifests (dead PID) are tolerated
  // — we clean them up below. Check under both the CLI-arg name AND the
  // agent.yaml's config.name (operator may have edited the yaml after create,
  // in which case `auggy dev` writes the manifest under config.name).
  const pidByCli = name ? readPidManifest(name, { auggyDir: opts.auggyDir }) : null;
  const pidByConfig =
    configName && configName !== name
      ? readPidManifest(configName, { auggyDir: opts.auggyDir })
      : null;

  const aliveCli = pidByCli && isProcessAlive(pidByCli.pid);
  const aliveConfig = pidByConfig && isProcessAlive(pidByConfig.pid);

  if (aliveCli || aliveConfig) {
    const liveName = aliveCli ? name! : configName!;
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
  // because the cloud record lives inside the dir's .auggy-cloud.json.
  if (opts.cloud && entry.cloud) {
    const cli = opts.railwayCli ?? createRailwayCli();
    const tmp = mkdtempSync(join(tmpdir(), `auggy-remove-${displayName}-`));
    try {
      await cli.link({
        projectId: entry.cloud.projectId,
        serviceName: entry.cloud.serviceId,
        cwd: tmp,
      });
      await cli.destroyService({ cwd: tmp });
      console.log(
        `Destroyed Railway service "${entry.cloud.serviceId}" (project ${entry.cloud.projectId}).`,
      );
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
  if (pidByCli && name) removePidManifest(name, { auggyDir: opts.auggyDir });
  if (pidByConfig && configName) removePidManifest(configName, { auggyDir: opts.auggyDir });

  if (!existsSync(join(localDir, "agent.yaml"))) {
    throw new Error(`Refusing to delete "${localDir}" — it does not contain agent.yaml.`);
  }
  rmSync(localDir, { recursive: true, force: true });

  console.log(`Removed agent "${displayName}" (was at ${entry.localDir}).`);
}

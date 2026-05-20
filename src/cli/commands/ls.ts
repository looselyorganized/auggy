/**
 * auggy ls — list all registered agents with their location and status.
 *
 * Status is derived from PID manifests + filesystem:
 *   - running (PID manifest present + alive)
 *   - stopped (in index, dir exists, no live PID)
 *   - ghost   (in index, but localDir is gone) → lifecycle hardening F5
 *   - orphan  (dir exists under ~/.auggy/agents/ but NOT in index) → F5
 *
 * Default view shows index entries only (ok + ghost). `--all` adds orphan
 * dirs detected by scanning ~/.auggy/agents/ — surfaces lifecycle drift
 * (aborted scaffolds, manual dir copies, etc.).
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAgents } from "../agent-index";
import { readPidManifest, isProcessAlive } from "../pid-registry";

interface LsOptions {
  auggyDir?: string;
  /** Include orphan dirs (under ~/.auggy/agents/ but not in the index). */
  all?: boolean;
}

interface AgentRow {
  name: string;
  location: string;
  status: string;
}

function tildify(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function statusFor(name: string, localDir: string): string {
  if (!existsSync(localDir)) return "ghost";
  const pid = readPidManifest(name);
  if (pid && isProcessAlive(pid.pid)) {
    return `running (${pid.mode}, :${pid.port})`;
  }
  return "stopped";
}

/**
 * Scan `~/.auggy/agents/` for dirs that look like agents (contain
 * `agent.yaml`) but aren't in the index. Skips the `.tmp-*` scaffolding
 * staging dirs (those are work-in-progress, not orphans).
 */
function findOrphans(
  auggyDir: string,
  indexedDirs: Set<string>,
): Array<{ name: string; localDir: string }> {
  const agentsDir = join(auggyDir, "agents");
  if (!existsSync(agentsDir)) return [];
  const out: Array<{ name: string; localDir: string }> = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue; // .tmp-* staging, dotfiles
    const localDir = join(agentsDir, entry.name);
    if (indexedDirs.has(localDir)) continue;
    if (!existsSync(join(localDir, "agent.yaml"))) continue;
    out.push({ name: entry.name, localDir });
  }
  return out;
}

export async function runLs(opts: LsOptions = {}): Promise<void> {
  const auggyDir = opts.auggyDir ?? join(homedir(), ".auggy");
  const agents = listAgents({ auggyDir: opts.auggyDir });

  const rows: AgentRow[] = agents.map((a) => ({
    name: a.name,
    location: tildify(a.localDir),
    status: statusFor(a.name, a.localDir),
  }));

  if (opts.all) {
    const indexed = new Set(agents.map((a) => a.localDir));
    for (const o of findOrphans(auggyDir, indexed)) {
      rows.push({
        name: o.name,
        location: tildify(o.localDir),
        status: "orphan",
      });
    }
  }

  if (rows.length === 0) {
    console.log("No agents registered.");
    console.log();
    console.log("Run `auggy create <name>` to scaffold one.");
    return;
  }

  // Compute column widths.
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const locW = Math.max(8, ...rows.map((r) => r.location.length));

  console.log(`${"NAME".padEnd(nameW)}  ${"LOCATION".padEnd(locW)}  STATUS`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameW)}  ${row.location.padEnd(locW)}  ${row.status}`);
  }

  // Footer hint when orphans or ghosts are surfaced — operators may not
  // immediately know what to do with these states.
  const hasOrphans = rows.some((r) => r.status === "orphan");
  const hasGhosts = rows.some((r) => r.status === "ghost");
  if (hasOrphans || hasGhosts) {
    console.log();
    if (hasOrphans) {
      console.log("  orphan: dir on disk, not in index — `auggy remove <name> --force` to clean");
    }
    if (hasGhosts) {
      console.log("  ghost:  index entry, dir gone — `auggy remove <name>` to clean");
    }
    console.log("  Or run `auggy reconcile` to clean all at once.");
  }
}

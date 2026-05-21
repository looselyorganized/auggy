/**
 * auggy list — list all agents under `<auggyDir>/agents/` with their status.
 *
 * Status is derived from PID manifests: running, or stopped. The filesystem
 * is the source of truth — an agent IS a directory at the canonical path,
 * so a "missing-dir" state cannot exist by construction.
 */

import { homedir } from "node:os";
import { listAgents } from "../agent-index";
import { readPidManifest, isProcessAlive } from "../pid-registry";

interface LsOptions {
  auggyDir?: string;
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

function statusFor(name: string): string {
  const pid = readPidManifest(name);
  if (pid && isProcessAlive(pid.pid)) {
    return `running (${pid.mode}, :${pid.port})`;
  }
  return "stopped";
}

export async function runLs(opts: LsOptions = {}): Promise<void> {
  const agents = listAgents({ auggyDir: opts.auggyDir });

  if (agents.length === 0) {
    console.log("No agents registered.");
    console.log();
    console.log("Run `auggy create <name>` to scaffold one.");
    return;
  }

  const rows: AgentRow[] = agents.map((a) => ({
    name: a.name,
    location: tildify(a.localDir),
    status: statusFor(a.name),
  }));

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const locW = Math.max(8, ...rows.map((r) => r.location.length));

  console.log(`${"NAME".padEnd(nameW)}  ${"LOCATION".padEnd(locW)}  STATUS`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameW)}  ${row.location.padEnd(locW)}  ${row.status}`);
  }
}

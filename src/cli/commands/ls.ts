/**
 * aug1 ls — list all registered agents with their location and status.
 *
 * Status is derived from PID manifests + filesystem: running, stopped, or
 * missing-dir (indexed but localDir gone).
 */

import { existsSync } from "node:fs";
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

function statusFor(name: string, localDir: string): string {
  if (!existsSync(localDir)) return "missing-dir";
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
    console.log("Run `aug1 create <name>` to scaffold one.");
    return;
  }

  const rows: AgentRow[] = agents.map((a) => ({
    name: a.name,
    location: tildify(a.localDir),
    status: statusFor(a.name, a.localDir),
  }));

  // Compute column widths.
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const locW = Math.max(8, ...rows.map((r) => r.location.length));

  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

  console.log(`${pad("NAME", nameW)}  ${pad("LOCATION", locW)}  STATUS`);
  for (const row of rows) {
    console.log(`${pad(row.name, nameW)}  ${pad(row.location, locW)}  ${row.status}`);
  }
}

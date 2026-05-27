/**
 * auggy list — list all agents under `<auggyDir>/agents/` with their status.
 *
 * Status is derived from PID manifests: running, or stopped. The filesystem
 * is the source of truth — an agent IS a directory at the canonical path,
 * so a "missing-dir" state cannot exist by construction.
 *
 * The URL column surfaces each agent's `/admin` URL (derived from its
 * webTransport augment port) so operators don't have to dig into agent.yaml
 * to find the workbench. Agents without webTransport show `—`.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { listAgents } from "../agent-index";
import { readPidManifest, isProcessAlive } from "../pid-registry";
import { parseAugmentConfigOnly } from "../yaml-helpers";

interface LsOptions {
  auggyDir?: string;
}

interface AgentRow {
  name: string;
  location: string;
  status: string;
  url: string;
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

/**
 * Derive the /console URL from the agent's webTransport configuration.
 * Returns `—` when the agent has no webTransport augment or its yaml
 * fails to parse — the agent is still listed; just no URL surfaced.
 */
function adminUrlFor(localDir: string): string {
  try {
    const options = parseAugmentConfigOnly(join(localDir, "agent.yaml"), "webTransport");
    if (!options) return "—";
    const port = options.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1) return "—";
    return `http://localhost:${port}/console`;
  } catch {
    return "—";
  }
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
    url: adminUrlFor(a.localDir),
  }));

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const locW = Math.max(8, ...rows.map((r) => r.location.length));
  const statusW = Math.max(6, ...rows.map((r) => r.status.length));

  console.log(
    `${"NAME".padEnd(nameW)}  ${"LOCATION".padEnd(locW)}  ${"STATUS".padEnd(statusW)}  URL`,
  );
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameW)}  ${row.location.padEnd(locW)}  ${row.status.padEnd(statusW)}  ${row.url}`,
    );
  }
}

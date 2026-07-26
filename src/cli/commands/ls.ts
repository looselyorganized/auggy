/**
 * auggy list — list agent projects under the current directory.
 *
 * Status is derived from PID manifests: running, or stopped. The filesystem
 * is the source of truth — an agent IS a directory at the canonical path,
 * so a "missing-dir" state cannot exist by construction.
 *
 * The URL column surfaces each agent's `/console` URL (derived from its
 * webTransport augment port) so operators don't have to dig into agent.yaml
 * to find the workbench. Agents without webTransport show `—`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getAgentFromDir } from "../agent-index";
import { inspectRuntimeProcess, readPidManifest } from "../pid-registry";
import { parseAugmentConfigOnly } from "../yaml-helpers";
import { parse as parseYaml } from "yaml";

interface LsOptions {
  auggyDir?: string;
  cwd?: string;
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

function statusFor(localDir: string, name: string, auggyDir?: string): string {
  let identifier = name;
  try {
    const raw = parseYaml(readFileSync(join(localDir, "agent.yaml"), "utf8")) as {
      id?: unknown;
    } | null;
    if (typeof raw?.id === "string") identifier = raw.id;
  } catch {}
  const pid = readPidManifest(identifier, { auggyDir });
  if (pid && inspectRuntimeProcess(pid) === "alive") {
    return `running (${pid.mode}, :${pid.port})`;
  }
  return "stopped";
}

/**
 * Derive the /console URL from the agent's webTransport configuration.
 * Returns `—` when the agent has no webTransport augment or its yaml
 * fails to parse — the agent is still listed; just no URL surfaced.
 */
function consoleUrlFor(localDir: string): string {
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
  const cwd = opts.cwd ?? (opts.auggyDir ? join(opts.auggyDir, "agents") : process.cwd());
  const agents = listProjectAgents(cwd, opts.auggyDir);

  if (agents.length === 0) {
    console.log("No agent projects found in this directory.");
    console.log();
    console.log("Run `auggy create <name>` to scaffold one here.");
    return;
  }

  const rows: AgentRow[] = agents.map((a) => ({
    name: a.name,
    location: tildify(a.localDir),
    status: statusFor(a.localDir, a.name, opts.auggyDir),
    url: consoleUrlFor(a.localDir),
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

function listProjectAgents(cwd: string, auggyDir?: string): Array<AgentRow & { localDir: string }> {
  const out: Array<AgentRow & { localDir: string }> = [];
  if (!existsSync(cwd)) return out;
  if (existsSync(join(cwd, "agent.yaml"))) {
    const localDir = resolve(cwd);
    const name = localDir.split(/[\\/]/).filter(Boolean).at(-1) ?? ".";
    out.push({
      name,
      localDir,
      location: tildify(localDir),
      status: statusFor(localDir, name, auggyDir),
      url: consoleUrlFor(localDir),
    });
  }

  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const localDir = join(cwd, entry.name);
    if (!getAgentFromDir(localDir)) continue;
    out.push({
      name: entry.name,
      localDir,
      location: tildify(localDir),
      status: statusFor(localDir, entry.name, auggyDir),
      url: consoleUrlFor(localDir),
    });
  }
  return out;
}

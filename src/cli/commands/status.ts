/**
 * auggy status [name] — show running agents or detail one.
 *
 * With no name: list all running agents in a table.
 * With a name: show detailed status including health check.
 */

import { listPidManifests, readPidManifest, isProcessAlive } from "../pid-registry";

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function fetchHealth(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
  } catch {}
  return null;
}

export async function runStatus(name?: string): Promise<void> {
  if (name) {
    await showDetail(name);
  } else {
    await showAll();
  }
}

async function showAll(): Promise<void> {
  const manifests = listPidManifests();

  if (manifests.length === 0) {
    console.log("No agents running.");
    console.log('Run "auggy create <name>" to create one.');
    return;
  }

  // Table header.
  console.log(
    pad("NAME", 20) +
      pad("STATUS", 10) +
      pad("PID", 8) +
      pad("PORT", 8) +
      pad("MODE", 10) +
      pad("UPTIME", 10),
  );
  console.log("-".repeat(66));

  for (const m of manifests) {
    const alive = isProcessAlive(m.pid);
    const status = alive ? "running" : "dead";
    console.log(
      pad(m.name, 20) +
        pad(status, 10) +
        pad(String(m.pid), 8) +
        pad(m.port ? String(m.port) : "-", 8) +
        pad(m.mode, 10) +
        pad(formatUptime(m.startedAt), 10),
    );
  }
}

async function showDetail(name: string): Promise<void> {
  const manifest = readPidManifest(name);

  if (!manifest) {
    console.log(`Agent "${name}" is not running.`);
    return;
  }

  const alive = isProcessAlive(manifest.pid);
  console.log(`Agent: ${manifest.name}`);
  console.log(`Status: ${alive ? "running" : "dead"}`);
  console.log(`PID: ${manifest.pid}`);
  console.log(`Mode: ${manifest.mode}`);
  console.log(`Uptime: ${formatUptime(manifest.startedAt)}`);
  console.log(`Config: ${manifest.configPath}`);
  console.log(`Agent dir: ${manifest.agentDir}`);

  if (manifest.port) {
    console.log(`Port: ${manifest.port}`);
    const health = await fetchHealth(manifest.port);
    if (health) {
      console.log(`Health: ${JSON.stringify(health)}`);
    } else {
      console.log("Health: unreachable");
    }
  }
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

/**
 * auggy status [name] — show running agents or detail one.
 *
 * With no name: list all running agents in a table.
 * With a name: show detailed status including health check.
 */

import { inspectRuntimeProcess, listPidManifests, readPidManifest } from "../pid-registry";
import { displayPath } from "../display-path";

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
    "NAME".padEnd(20) +
      "STATUS".padEnd(10) +
      "PID".padEnd(8) +
      "PORT".padEnd(8) +
      "MODE".padEnd(10) +
      "UPTIME".padEnd(10),
  );
  console.log("-".repeat(66));

  for (const m of manifests) {
    const processStatus = inspectRuntimeProcess(m);
    const status = processStatus === "alive" ? "running" : processStatus;
    console.log(
      m.name.padEnd(20) +
        status.padEnd(10) +
        String(m.pid).padEnd(8) +
        (m.port ? String(m.port) : "-").padEnd(8) +
        m.mode.padEnd(10) +
        formatUptime(m.startedAt).padEnd(10),
    );
  }
}

async function showDetail(name: string): Promise<void> {
  const manifest = readPidManifest(name);

  if (!manifest) {
    console.log(`Agent "${name}" is not running.`);
    return;
  }

  const processStatus = inspectRuntimeProcess(manifest);
  console.log(`Agent: ${manifest.name}`);
  if (manifest.agentId) console.log(`ID: ${manifest.agentId}`);
  console.log(`Status: ${processStatus === "alive" ? "running" : processStatus}`);
  console.log(`PID: ${manifest.pid}`);
  console.log(`Mode: ${manifest.mode}`);
  console.log(`Uptime: ${formatUptime(manifest.startedAt)}`);
  console.log(`Config: ${displayPath(manifest.configPath)}`);
  console.log(`Agent dir: ${displayPath(manifest.agentDir)}`);

  if (manifest.port && processStatus === "alive") {
    console.log(`Port: ${manifest.port}`);
    const health = await fetchHealth(manifest.port);
    if (health) {
      console.log(`Health: ${JSON.stringify(health)}`);
    } else {
      console.log("Health: unreachable");
    }
  }
}

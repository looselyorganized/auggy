import { dirname } from "node:path";
import { getAgentFromDir } from "../agent-index";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import type { CloudRecord } from "../types";

export interface LogsOptions {
  auggyDir?: string;
  cwd?: string;
}

export async function runLogs(name: string | undefined, opts: LogsOptions = {}): Promise<string> {
  const configPath = resolveConfigPath(name, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  const entry = getAgentFromDir(dirname(configPath));
  const displayName = readAgentName(configPath);
  if (!entry) {
    throw new Error(
      `Agent "${displayName}" not found.\n\n  Run from inside an agent project or its parent.`,
    );
  }
  if (!entry.cloud) {
    throw new Error(
      `Agent "${displayName}" is not deployed yet.\n\n  Run \`auggy deploy\` from the agent project first, then open Railway to view logs.`,
    );
  }

  const message = formatRailwayLogsMessage(displayName, entry.cloud);
  console.log(message);
  return message;
}

export function formatRailwayLogsMessage(name: string, cloud: NonNullable<CloudRecord>): string {
  return [
    `Railway logs for "${name}" are available in Railway.`,
    "",
    `Open Railway: ${railwayDashboardUrl(cloud)}`,
    `App URL:      ${cloud.url}`,
    `Project:      ${cloud.projectId}`,
    `Service:      ${cloud.serviceId}`,
    "",
    "In Railway, open the service and select Logs or Observability.",
  ].join("\n");
}

function railwayDashboardUrl(cloud: NonNullable<CloudRecord>): string {
  return `https://railway.com/project/${encodeURIComponent(cloud.projectId)}/service/${encodeURIComponent(
    cloud.serviceId,
  )}`;
}

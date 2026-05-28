import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgent } from "../agent-index";
import { createRailwayCli, type RailwayCli } from "../deploy/railway-cli";

export interface LogsOptions {
  auggyDir?: string;
  railwayCli?: RailwayCli;
}

export async function runLogs(name: string, opts: LogsOptions = {}): Promise<void> {
  const entry = getAgent(name, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(`Agent "${name}" not found.\n\n  Run \`auggy list\` to see scaffolded agents.`);
  }
  if (!entry.cloud) {
    throw new Error(
      `Agent "${name}" is not deployed yet.\n\n  Run \`auggy deploy ${name}\` first, then \`auggy logs ${name}\`.`,
    );
  }

  const cli = opts.railwayCli ?? createRailwayCli();
  await cli.checkPresence();
  await cli.checkAuth();

  const tmp = mkdtempSync(join(tmpdir(), `auggy-logs-${name}-`));
  try {
    await cli.link({
      projectId: entry.cloud.projectId,
      serviceName: name,
      cwd: tmp,
    });
    await cli.logs({ cwd: tmp });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

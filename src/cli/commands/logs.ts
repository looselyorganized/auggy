import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentFromDir } from "../agent-index";
import { createRailwayCli, type RailwayCli } from "../deploy/railway-cli";
import { resolveConfigPath } from "../resolve-config";

export interface LogsOptions {
  auggyDir?: string;
  cwd?: string;
  railwayCli?: RailwayCli;
}

export async function runLogs(name: string, opts: LogsOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(name, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  const entry = getAgentFromDir(dirname(configPath));
  if (!entry) {
    throw new Error(`Agent "${name}" not found.\n\n  Run from inside an agent project or its parent.`);
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

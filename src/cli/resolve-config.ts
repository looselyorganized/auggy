/**
 * Shared config path resolution for CLI commands.
 *
 * Resolution order:
 *   1. Explicit --config <path> flag
 *   2. Project-local ./agent.yaml from cwd
 *   3. Look up <name> in the filesystem (canonical: <auggyDir>/agents/<name>/)
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgent } from "./agent-index";

interface ResolveOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Override cwd for project-local resolution. */
  cwd?: string;
}

/**
 * Resolve the config file path from explicit flag or the agent's canonical
 * directory.
 */
export function resolveConfigPath(
  name: string,
  configFlag?: string,
  opts: ResolveOptions = {},
): string {
  if (configFlag) {
    const absPath = resolve(configFlag);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    return absPath;
  }

  const localConfig = resolve(opts.cwd ?? process.cwd(), "agent.yaml");
  if (existsSync(localConfig)) {
    return localConfig;
  }

  const entry = getAgent(name, opts);
  if (!entry) {
    throw new Error(
      `Agent "${name}" not found.\n\n` +
        `  Run \`auggy create ${name}\` to scaffold a new agent,\n` +
        `  or \`auggy list\` to see existing agents.`,
    );
  }

  return join(entry.localDir, "agent.yaml");
}

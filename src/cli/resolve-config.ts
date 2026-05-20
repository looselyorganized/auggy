/**
 * Shared config path resolution for CLI commands.
 *
 * Resolution order:
 *   1. Explicit --config <path> flag
 *   2. Look up <name> in the filesystem (canonical: <auggyDir>/agents/<name>/)
 *
 * Pre-ADR-021 CWD-relative discovery was removed. Pre-021 agents are not
 * auto-discovered; adoption is deferred until concrete demand.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgent } from "./agent-index";

interface ResolveOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
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

  const entry = getAgent(name, opts);
  if (!entry) {
    throw new Error(
      `Agent "${name}" not found.\n\n` +
        `  Run \`auggy create ${name}\` to scaffold a new agent,\n` +
        `  or \`auggy ls\` to see existing agents.`,
    );
  }

  return join(entry.localDir, "agent.yaml");
}

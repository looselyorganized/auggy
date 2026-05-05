/**
 * Shared config path resolution for CLI commands.
 *
 * Resolution order:
 *   1. Explicit --config <path> flag
 *   2. Look up <name> in `~/.auggy/agents.json` (the index)
 *
 * The legacy CWD-relative fallback (`./<name>/agent.yaml`, `./agent.yaml`)
 * was removed in ADR-021. Pre-ADR-021 agents are not auto-discovered;
 * adoption is deferred until concrete demand.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgent } from "./agent-index";

interface ResolveOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
}

/**
 * Resolve the config file path from explicit flag or the agent index.
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
      `Agent "${name}" is not registered.\n\n` +
        `  Run \`auggy create ${name}\` to scaffold a new agent,\n` +
        `  or \`auggy ls\` to see registered agents.`,
    );
  }

  const cfg = join(entry.localDir, "agent.yaml");
  if (!existsSync(cfg)) {
    throw new Error(
      `agent.yaml missing at indexed path: ${cfg}\n\n` +
        `  The agent directory may have been deleted or moved manually.\n` +
        `  Run \`auggy remove ${name}\` to clean up the index entry.`,
    );
  }
  return cfg;
}

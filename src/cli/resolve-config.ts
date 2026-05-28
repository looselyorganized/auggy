/**
 * Shared config path resolution for CLI commands.
 *
 * Resolution order:
 *   1. Explicit --config <path> flag
 *   2. Project-local ./agent.yaml from cwd
 *   3. Project child ./<name>/agent.yaml from cwd
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

interface ResolveOptions {
  /** Deprecated compatibility seam; project resolution ignores ~/.auggy. */
  auggyDir?: string;
  /** Override cwd for project-local resolution. */
  cwd?: string;
}

/**
 * Resolve the config file path from explicit flag or the agent's canonical
 * directory.
 */
export function resolveConfigPath(
  name: string | undefined,
  configFlag?: string,
  opts: ResolveOptions = {},
): string {
  const baseDir = opts.cwd ?? (opts.auggyDir ? join(opts.auggyDir, "agents") : process.cwd());
  if (configFlag) {
    const absPath = resolve(configFlag);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    return absPath;
  }

  const localConfig = resolve(baseDir, "agent.yaml");
  if (existsSync(localConfig)) {
    return localConfig;
  }

  if (!name) {
    throw new Error(
      `No agent specified and no agent.yaml found in ${opts.cwd ?? process.cwd()}.\n\n` +
        `  Run from inside an agent project, or pass an agent name.`,
    );
  }

  const childConfig = resolve(baseDir, name, "agent.yaml");
  if (!existsSync(childConfig)) {
    throw new Error(
      `Agent "${name}" not found.\n\n` +
        `  Run \`auggy create ${name}\` to scaffold ./${name},\n` +
        `  run this command from inside an agent project,\n` +
        `  or use --config <path> for a one-off path.`,
    );
  }

  return childConfig;
}

export function readAgentName(configPath: string): string {
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as { name?: unknown } | null;
  if (typeof raw?.name === "string" && raw.name.trim().length > 0) {
    return raw.name.trim();
  }
  throw new Error(`agent.yaml at ${configPath} is missing a non-empty name.`);
}

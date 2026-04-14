/**
 * Shared config path resolution logic for CLI commands.
 */

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Resolve the config file path from explicit flag, convention, or CWD.
 *
 * Resolution order:
 *   1. Explicit --config <path> flag
 *   2. ./<name>/agent.yaml (convention: agent dirs named after the agent)
 *   3. ./agent.yaml (if CWD is the agent directory)
 */
export function resolveConfigPath(name: string, configFlag?: string): string {
  if (configFlag) {
    const absPath = resolve(configFlag);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    return absPath;
  }

  const conventional = resolve(`./${name}/agent.yaml`);
  if (existsSync(conventional)) return conventional;

  const cwd = resolve("./agent.yaml");
  if (existsSync(cwd)) return cwd;

  throw new Error(
    `No config found for "${name}". Tried:\n` +
      `  - ${conventional}\n` +
      `  - ${cwd}\n` +
      `Specify one with --config <path>`,
  );
}

/**
 * Shared helpers for CLI commands that read a single augment's options out of
 * agent.yaml without running the full agent-level config validation.
 *
 * The operator-only commands `auggy visitors <agent>` and
 * `auggy visitors <agent> --revoke` previously each open-coded the same
 * raw YAML parse — and neither of them ran env-var interpolation, so an
 * operator's `dbPath: ${MY_DB_PATH}` in agent.yaml would arrive as the
 * literal string `${MY_DB_PATH}` and produce a confusing path error
 * downstream (F15).
 *
 * `parseAugmentConfigOnly` consolidates the pattern:
 *   1. Resolve to an absolute yaml path.
 *   2. Load `.env` from the agent dir (matches `parseConfig`).
 *   3. Read + parse YAML.
 *   4. Interpolate env vars (matches `parseConfig`).
 *   5. Find the augment with the matching `type` field.
 *   6. Return its options object (or null when absent).
 *
 * Skips agent-level field validation (`id`, `name`, `engine`, etc.) because
 * the operator-only paths don't need them and the validation would force
 * operators to fix unrelated YAML issues to revoke a visitor.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { interpolateEnvVars, loadEnvFile } from "./config-parser";

/**
 * Find the first augment of the given `type` in the YAML at `yamlPath` and
 * return its (env-interpolated) options. Returns null if no augment of that
 * type is configured.
 *
 * Throws when:
 *   - The file does not exist or fails to parse.
 *   - The YAML root is not an object.
 *   - Env-var references in the file cannot be resolved.
 */
export function parseAugmentConfigOnly(
  yamlPath: string,
  augmentType: string,
): Record<string, unknown> | null {
  const absPath = resolve(yamlPath);
  if (!existsSync(absPath)) {
    throw new Error(`agent.yaml not found at ${absPath}.`);
  }
  const agentDir = dirname(absPath);

  // Load .env so env-var interpolation has the operator's secrets.
  loadEnvFile(agentDir);

  const raw = readFileSync(absPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${yamlPath}: not a valid YAML document`);
  }

  // Interpolate the entire tree first — augment options can reference env
  // vars at arbitrary depth.
  const interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;
  const augments = (interpolated.augments ?? []) as Array<Record<string, unknown>>;
  const aug = augments.find((a) => a?.type === augmentType);
  if (!aug) return null;
  return (aug.options ?? {}) as Record<string, unknown>;
}

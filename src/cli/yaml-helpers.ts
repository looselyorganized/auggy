/**
 * Shared helpers for CLI commands that read a single augment's config out of
 * the agent project without running the full agent-level config validation.
 *
 * The operator-only commands `auggy visitors <agent>` and
 * `auggy visitors <agent> --revoke` previously each open-coded the same
 * raw YAML parse — and neither of them ran env-var interpolation, so an
 * operator's `dbPath: ${MY_DB_PATH}` in augment config would arrive as the
 * literal string `${MY_DB_PATH}` and produce a confusing path error
 * downstream (F15).
 *
 * `parseAugmentConfigOnly` consolidates the pattern:
 *   1. Resolve to an absolute yaml path.
 *   2. Load `.env` from the agent dir (matches `parseConfig`).
 *   3. Read + parse YAML.
 *   4. Interpolate env vars (matches `parseConfig`).
 *   5. Expand folder-backed augment metadata.
 *   6. Find the augment with the matching `type` field.
 *   7. Return its options object (or null when absent).
 *
 * Skips agent-level field validation (`id`, `name`, `engine`, etc.) because
 * the operator-only paths don't need them and the validation would force
 * operators to fix unrelated YAML issues to revoke a visitor.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { expandAugmentFolderEntries, interpolateEnvVars, loadEnvFile } from "./config-parser";

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseExpandedConfig(yamlPath: string): Record<string, unknown> {
  const absPath = resolve(yamlPath);
  if (!existsSync(absPath)) {
    throw new Error(`agent.yaml not found at ${absPath}.`);
  }
  const agentDir = dirname(absPath);
  loadEnvFile(agentDir);

  const raw = readFileSync(absPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${yamlPath}: not a valid YAML document`);
  }
  return expandAugmentFolderEntries(
    interpolateEnvVars(parsed) as Record<string, unknown>,
    agentDir,
  );
}

/** Read the immutable identity without requiring unrelated runtime config. */
export function parseAgentIdOnly(yamlPath: string): string {
  const id = parseExpandedConfig(yamlPath).id;
  if (typeof id !== "string" || !AGENT_ID_RE.test(id)) {
    throw new Error(`${yamlPath}: id must be a valid aug1_ UUID`);
  }
  return id;
}

/** Return every configured instance of an augment type. */
export function parseAugmentConfigsOnly(
  yamlPath: string,
  augmentType: string,
): Record<string, unknown>[] {
  const interpolated = parseExpandedConfig(yamlPath);
  const augments = (interpolated.augments ?? []) as Array<Record<string, unknown>>;
  return augments
    .filter((augment) => augment?.type === augmentType)
    .map((augment) => (augment.options ?? {}) as Record<string, unknown>);
}

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
  return parseAugmentConfigsOnly(yamlPath, augmentType)[0] ?? null;
}

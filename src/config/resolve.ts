/**
 * Resolves an operational config value across three precedence levels:
 *   1. Explicit yaml value (operator wrote it in agent.yaml)
 *   2. Env var override (AUGGY_<KEY> set by operator at deploy time)
 *   3. Default rule (computed lazily; usually env-driven, e.g. NODE_ENV)
 *
 * Returns the resolved value AND its source for operator-facing logging.
 *
 * The shape `ConfigResolution<T>` is consumed by:
 *   - G36 (admin dashboard) — surfaces value + source per setting in the UI
 *   - G37 (`auggy config` CLI) — exposes get/set on the yaml level;
 *     env and default sources are read-only operator info via `explain`
 *
 * Future operational settings (notify destinations, budget knobs, custom
 * commands) follow the same yaml > env > default precedence via this helper.
 * No more bespoke env-var parsing in individual augments.
 */

export interface ConfigResolution<T> {
  value: T;
  source: "yaml" | "env" | "default";
}

/**
 * Resolve a boolean config value.
 *
 * Env var parsing is strict: only the literals `"true"` and `"false"`
 * (case-sensitive) are recognized. Anything else (including `"1"`, `"yes"`,
 * `"TRUE"`) is treated as unset and falls through to the default rule.
 * Strict parsing keeps the surface unambiguous; G37's CLI can normalize
 * operator-supplied values to the canonical form before writing.
 */
export function resolveConfigBool(
  yamlValue: boolean | undefined,
  envKey: string,
  defaultFn: () => boolean,
): ConfigResolution<boolean> {
  if (yamlValue !== undefined) {
    if (typeof yamlValue !== "boolean") {
      throw new TypeError(`Explicit value for ${envKey} must be a boolean.`);
    }
    return { value: yamlValue, source: "yaml" };
  }
  const envValue = process.env[envKey];
  if (envValue === "true") return { value: true, source: "env" };
  if (envValue === "false") return { value: false, source: "env" };
  return { value: defaultFn(), source: "default" };
}

/**
 * Config parser — YAML agent.yaml → ParsedConfig.
 *
 * Three passes:
 *   1. YAML parse (raw object)
 *   2. Env var interpolation (${VAR_NAME} → process.env.VAR_NAME)
 *   3. Structural validation (required fields, types, constraints)
 *
 * The parser loads a .env file from the agent directory before parsing
 * so secrets are available for interpolation (same pattern as the
 * telemetry-exporter daemon).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import type { ParsedConfig, AugmentConfig, EngineConfig, AgentSettings } from "./types";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------

/**
 * Load a .env file into process.env. Simple KEY=VALUE format, no
 * interpolation, no quoting beyond trimming quotes from values.
 * Silently skips if the file doesn't exist.
 */
export function loadEnvFile(dir: string): void {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Skip empty values (placeholder lines like KEY= in the template).
    // Don't override existing env vars (shell exports take precedence).
    if (key && value && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Env var interpolation
// ---------------------------------------------------------------------------

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Recursively walk all string values in an object tree and replace
 * ${VAR_NAME} references with process.env[VAR_NAME].
 *
 * Missing vars collect into an error array. If any are missing, throw
 * with a clear message listing all of them.
 */
export function interpolateEnvVars(obj: unknown, path = ""): unknown {
  const missing: string[] = [];
  const result = walkAndInterpolate(obj, path, missing);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables:\n${missing.map((m) => `  - ${m}`).join("\n")}`,
    );
  }
  return result;
}

function walkAndInterpolate(
  obj: unknown,
  path: string,
  missing: string[],
): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_VAR_RE, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        missing.push(`${varName} (referenced in ${path || "root"})`);
        return `\${${varName}}`;
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      walkAndInterpolate(item, `${path}[${i}]`, missing),
    );
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = walkAndInterpolate(value, path ? `${path}.${key}` : key, missing);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AUG1_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Agent and augment names: lowercase alphanumeric, hyphens, underscores. No dots, slashes, spaces. */
export const VALID_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const VALID_COMPACTION = new Set(["truncate", "summarize", "sliding-window"]);
const BUILTIN_TYPES = new Set([
  "fileMemory",
  "supabaseMemory",
  "filesystem",
  "webTransport",
  "webFetch",
]);

function validateConfig(raw: Record<string, unknown>): ParsedConfig {
  const errors: string[] = [];

  // Required top-level fields.
  if (typeof raw.id !== "string" || !AUG1_ID_RE.test(raw.id)) {
    errors.push(`id: must be a valid aug1_ UUID (got "${raw.id}")`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    errors.push("name: required, non-empty string");
  } else if (!VALID_NAME_RE.test(raw.name)) {
    errors.push(`name: must be lowercase alphanumeric with hyphens/underscores (got "${raw.name}")`);
  }

  // Engine.
  const engine = raw.engine as Record<string, unknown> | undefined;
  if (!engine || typeof engine !== "object") {
    errors.push("engine: required object with provider and model");
  } else {
    if (typeof engine.provider !== "string") {
      errors.push("engine.provider: required string");
    }
    if (typeof engine.model !== "string") {
      errors.push("engine.model: required string");
    }
  }

  // Augments.
  const augments = raw.augments;
  if (!Array.isArray(augments) || augments.length === 0) {
    errors.push("augments: required non-empty array");
  } else {
    const names = new Set<string>();
    for (let i = 0; i < augments.length; i++) {
      const aug = augments[i] as Record<string, unknown>;
      const prefix = `augments[${i}]`;

      if (typeof aug.name !== "string" || aug.name.length === 0) {
        errors.push(`${prefix}.name: required, non-empty string`);
      } else if (!VALID_NAME_RE.test(aug.name)) {
        errors.push(`${prefix}.name: must be lowercase alphanumeric with hyphens/underscores (got "${aug.name}")`);
      } else if (names.has(aug.name)) {
        errors.push(`${prefix}.name: duplicate name "${aug.name}"`);
      } else {
        names.add(aug.name);
      }

      if (typeof aug.type !== "string") {
        errors.push(`${prefix}.type: required string`);
      } else if (!BUILTIN_TYPES.has(aug.type) && aug.type !== "custom") {
        errors.push(
          `${prefix}.type: unknown type "${aug.type}" (expected one of: ${[...BUILTIN_TYPES, "custom"].join(", ")})`,
        );
      }

      if (aug.type === "custom" && typeof aug.source !== "string") {
        errors.push(`${prefix}.source: required for type "custom"`);
      }
    }
  }

  // Settings.
  const settings = (raw.settings ?? {}) as Record<string, unknown>;
  if (
    settings.compactionStrategy &&
    !VALID_COMPACTION.has(settings.compactionStrategy as string)
  ) {
    errors.push(
      `settings.compactionStrategy: must be one of ${[...VALID_COMPACTION].join(", ")}`,
    );
  }
  if (
    settings.maxInferenceLoops !== undefined &&
    (typeof settings.maxInferenceLoops !== "number" || settings.maxInferenceLoops < 1)
  ) {
    errors.push("settings.maxInferenceLoops: must be a positive integer");
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid agent.yaml:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  return {
    id: raw.id as string,
    name: raw.name as string,
    purpose: raw.purpose as string | undefined,
    engine: engine as unknown as EngineConfig,
    settings: settings as AgentSettings,
    operators: raw.operators as string[] | undefined,
    augments: (augments as unknown[]).map((a) => a as AugmentConfig),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an agent.yaml file into a validated ParsedConfig.
 *
 * Loads .env from the config file's directory, interpolates env vars,
 * and validates the structure.
 */
export function parseConfig(yamlPath: string): ParsedConfig {
  const absPath = resolve(yamlPath);
  const agentDir = dirname(absPath);

  // Load .env before parsing so secrets are available for interpolation.
  loadEnvFile(agentDir);

  const raw = readFileSync(absPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${yamlPath}: not a valid YAML document`);
  }

  const interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;
  return validateConfig(interpolated);
}

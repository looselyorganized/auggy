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
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "orgContext",
  "bash",
  "budgets",
]);
const KNOWN_PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);
const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const VALID_ROUTING_SORTS = new Set(["price", "throughput", "latency"]);

// ---------------------------------------------------------------------------
// Per-augment option validators
// ---------------------------------------------------------------------------

/**
 * Validate a BudgetCaps object (used for agent, public.anonymous, public.recognized).
 * Each field must be a positive number when present.
 */
function validateBudgetCaps(
  caps: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const numericFields = [
    "maxTurnsPerThread",
    "maxTurnsPerDay",
    "maxUsdPerDay",
    "maxUsdPerThread",
  ] as const;
  for (const field of numericFields) {
    if (caps[field] !== undefined) {
      if (typeof caps[field] !== "number" || (caps[field] as number) <= 0) {
        errors.push(`${path}.${field}: must be a positive number`);
      }
    }
  }
}

/**
 * Validate the options block for a budgets augment.
 */
function validateBudgetsOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    errors.push(`${prefix}.options.dbPath: required string`);
  }

  const numericPositive: Array<keyof typeof opts> = [
    "anonymousGlobalLimit",
    "dailyBudgetUsd",
    "cleanupWindowMs",
  ];
  for (const field of numericPositive) {
    if (opts[field] !== undefined) {
      if (typeof opts[field] !== "number" || (opts[field] as number) <= 0) {
        errors.push(`${prefix}.options.${field}: must be a positive number`);
      }
    }
  }

  if (opts.caps !== undefined) {
    if (
      typeof opts.caps !== "object" ||
      opts.caps === null ||
      Array.isArray(opts.caps)
    ) {
      errors.push(`${prefix}.options.caps: must be an object`);
      return;
    }
    const caps = opts.caps as Record<string, unknown>;

    if (caps.agent !== undefined) {
      if (
        typeof caps.agent !== "object" ||
        caps.agent === null ||
        Array.isArray(caps.agent)
      ) {
        errors.push(`${prefix}.options.caps.agent: must be an object`);
      } else {
        validateBudgetCaps(
          caps.agent as Record<string, unknown>,
          `${prefix}.options.caps.agent`,
          errors,
        );
      }
    }

    if (caps.public !== undefined) {
      if (
        typeof caps.public !== "object" ||
        caps.public === null ||
        Array.isArray(caps.public)
      ) {
        errors.push(`${prefix}.options.caps.public: must be an object`);
      } else {
        const pub = caps.public as Record<string, unknown>;
        for (const substate of ["anonymous", "recognized"] as const) {
          if (pub[substate] !== undefined) {
            if (
              typeof pub[substate] !== "object" ||
              pub[substate] === null ||
              Array.isArray(pub[substate])
            ) {
              errors.push(
                `${prefix}.options.caps.public.${substate}: must be an object`,
              );
            } else {
              validateBudgetCaps(
                pub[substate] as Record<string, unknown>,
                `${prefix}.options.caps.public.${substate}`,
                errors,
              );
            }
          }
        }
      }
    }
  }
}

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
    } else if (!KNOWN_PROVIDERS.has(engine.provider)) {
      errors.push(
        `engine.provider: unknown provider "${engine.provider}" (supported: ${[...KNOWN_PROVIDERS].join(", ")})`,
      );
    }
    if (typeof engine.model !== "string") {
      errors.push("engine.model: required string");
    }
    if (engine.reasoningEffort !== undefined) {
      if (
        typeof engine.reasoningEffort !== "string" ||
        !VALID_REASONING_EFFORTS.has(engine.reasoningEffort)
      ) {
        errors.push(
          `engine.reasoningEffort: must be one of ${[...VALID_REASONING_EFFORTS].join(", ")}`,
        );
      }
    }
    if (engine.providerRouting !== undefined) {
      if (
        typeof engine.providerRouting !== "object" ||
        engine.providerRouting === null ||
        Array.isArray(engine.providerRouting)
      ) {
        errors.push("engine.providerRouting: must be an object");
      } else if (engine.provider !== "openrouter") {
        errors.push(
          "engine.providerRouting: only valid for provider 'openrouter'",
        );
      } else {
        const r = engine.providerRouting as Record<string, unknown>;
        if (r.only !== undefined) {
          if (
            !Array.isArray(r.only) ||
            r.only.length === 0 ||
            !r.only.every((v) => typeof v === "string")
          ) {
            errors.push(
              "engine.providerRouting.only: must be a non-empty array of strings",
            );
          }
        }
        if (r.ignore !== undefined) {
          if (
            !Array.isArray(r.ignore) ||
            r.ignore.length === 0 ||
            !r.ignore.every((v) => typeof v === "string")
          ) {
            errors.push(
              "engine.providerRouting.ignore: must be a non-empty array of strings",
            );
          }
        }
        if (
          r.sort !== undefined &&
          (typeof r.sort !== "string" || !VALID_ROUTING_SORTS.has(r.sort))
        ) {
          errors.push(
            `engine.providerRouting.sort: must be one of ${[...VALID_ROUTING_SORTS].join(", ")}`,
          );
        }
        if (r.max_price !== undefined) {
          if (
            typeof r.max_price !== "object" ||
            r.max_price === null ||
            Array.isArray(r.max_price)
          ) {
            errors.push("engine.providerRouting.max_price: must be an object");
          } else {
            const mp = r.max_price as Record<string, unknown>;
            if (
              mp.prompt !== undefined &&
              (typeof mp.prompt !== "number" || mp.prompt <= 0)
            ) {
              errors.push(
                "engine.providerRouting.max_price.prompt: must be a positive number",
              );
            }
            if (
              mp.completion !== undefined &&
              (typeof mp.completion !== "number" || mp.completion <= 0)
            ) {
              errors.push(
                "engine.providerRouting.max_price.completion: must be a positive number",
              );
            }
          }
        }
      }
    }
    if (engine.costOverride !== undefined) {
      if (
        typeof engine.costOverride !== "object" ||
        engine.costOverride === null ||
        Array.isArray(engine.costOverride)
      ) {
        errors.push("engine.costOverride: must be an object");
      } else {
        const co = engine.costOverride as Record<string, unknown>;
        if (
          typeof co.inputUsdPerMtok !== "number" ||
          !isFinite(co.inputUsdPerMtok) ||
          co.inputUsdPerMtok < 0
        ) {
          errors.push(
            "engine.costOverride.inputUsdPerMtok: must be a finite non-negative number",
          );
        }
        if (
          typeof co.outputUsdPerMtok !== "number" ||
          !isFinite(co.outputUsdPerMtok) ||
          co.outputUsdPerMtok < 0
        ) {
          errors.push(
            "engine.costOverride.outputUsdPerMtok: must be a finite non-negative number",
          );
        }
      }
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

      if (aug.type === "budgets") {
        const opts = (aug.options ?? {}) as Record<string, unknown>;
        validateBudgetsOptions(opts, prefix, errors);
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

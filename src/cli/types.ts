/**
 * Shared types for the auggy CLI.
 *
 * These types drive the config parser, augment/engine resolvers, PID
 * registry, and CLI commands. They are internal to the CLI — not part
 * of the augment-1 public API surface.
 */

// ---------------------------------------------------------------------------
// Config types — the output of parsing agent.yaml
// ---------------------------------------------------------------------------

/** The built-in augment type identifiers. */
export type BuiltinAugmentType =
  | "fileMemory"
  | "supabaseMemory"
  | "layeredMemory"
  | "filesystem"
  | "webTransport"
  | "webFetch"
  | "orgContext"
  | "bash"
  | "budgets";

/** A single augment entry from the `augments:` array in agent.yaml. */
export interface AugmentConfig {
  /** Operator-chosen instance name (appears in logs, health, traces). */
  name: string;
  /** Factory identifier: a built-in type name or "custom". */
  type: BuiltinAugmentType | "custom";
  /** Path to a local .ts file (required when type is "custom"). */
  source?: string;
  /** Options passed to the augment factory function. */
  options?: Record<string, unknown>;
}

/** Engine configuration from agent.yaml. */
export interface EngineConfig {
  /** Engine provider identifier ("anthropic", "openai", or "openrouter"). */
  provider: string;
  /** Model identifier (e.g. "claude-sonnet-4-6", "gpt-5", "qwen/qwen3.5-397b-a17b"). */
  model: string;
  /** Max context window in tokens. */
  maxContextTokens?: number;
  /** Max output tokens per turn (sent as `max_completion_tokens` for openai/openrouter). */
  maxTokens?: number;
  /** Optional proxy/gateway base URL. Ignored for openrouter (hardcoded). */
  baseURL?: string;
  /**
   * Reasoning effort for reasoning-capable models (o-series, gpt-5, qwen3.5 thinking).
   * `none` is gpt-5.1-only; `xhigh` is gpt-5.1-codex-max+ (and most OpenRouter reasoning models).
   * Older OpenAI Chat Completions models (e.g. gpt-4) do not support this field — the API returns an error.
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * OpenRouter-only: provider routing hints. Rejected by the parser when provider !== "openrouter".
   * Note: provider slugs in `only`/`ignore` are NOT semantically validated — a typo
   * silently falls back to OpenRouter's default routing.
   */
  providerRouting?: ProviderRouting;
  /**
   * Override pricing for cost estimation. If set, the adapter uses these rates
   * instead of the built-in pricing table. Useful for unknown models or custom
   * pricing arrangements. USD per million tokens.
   */
  costOverride?: {
    inputUsdPerMtok: number;
    outputUsdPerMtok: number;
  };
}

/** OpenRouter provider routing config (forwarded as the `provider` body field). */
export interface ProviderRouting {
  /** Allowlist of provider slugs (e.g. ["OpenAI", "Anthropic"]). */
  only?: string[];
  /** Denylist of provider slugs. */
  ignore?: string[];
  /** Sort upstream providers by this attribute. */
  sort?: "price" | "throughput" | "latency";
  /** Cap upstream prices in USD per million tokens. */
  max_price?: { prompt?: number; completion?: number };
}

/** Agent settings from agent.yaml. */
export interface AgentSettings {
  contextBudget?: {
    historyPercent?: number;
    toolSchemaPercent?: number;
  };
  compactionStrategy?: "truncate" | "summarize" | "sliding-window";
  maxInferenceLoops?: number;
}

/** The fully parsed and validated agent.yaml content. */
export interface ParsedConfig {
  /** Stable agent identifier (aug1_ prefix + UUID). */
  id: string;
  /** Human-readable agent name (used for CLI addressing). */
  name: string;
  /** Optional purpose description. */
  purpose?: string;
  /** Engine configuration. */
  engine: EngineConfig;
  /** Agent runtime settings. */
  settings: AgentSettings;
  /** Optional operator peer IDs. */
  operators?: string[];
  /** Augment declarations. */
  augments: AugmentConfig[];
}

// ---------------------------------------------------------------------------
// PID registry types — runtime state for running agents
// ---------------------------------------------------------------------------

/** JSON manifest written to ~/.auggy/<name>.json for each running agent. */
export interface PidManifest {
  /** OS process ID. */
  pid: number;
  /** Agent name (matches config). */
  name: string;
  /** webTransport port if configured, null otherwise. */
  port: number | null;
  /** Absolute path to agent.yaml. */
  configPath: string;
  /** Absolute path to the agent directory. */
  agentDir: string;
  /** ISO 8601 timestamp of when the agent was started. */
  startedAt: string;
  /** How the agent was started. */
  mode: "dev" | "launchd";
}

// ---------------------------------------------------------------------------
// Skill manifest types
// ---------------------------------------------------------------------------

/** A single skill entry extracted from SKILL.md frontmatter in skills directories. */
export interface SkillEntry {
  /** Skill name from frontmatter. */
  name: string;
  /** Skill description from frontmatter. */
  description: string;
  /** Relative path to the SKILL.md file. */
  path: string;
}

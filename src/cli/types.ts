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
  | "manifest"
  | "skills"
  | "bash"
  | "budgets"
  | "notify"
  | "agentMail"
  | "telegramTransport"
  | "turnControl"
  | "visitorAuth"
  | "link";

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

/**
 * Engine providers auggy can resolve. The string union is the single
 * source of truth for which providers exist — `KNOWN_PROVIDERS` is the
 * runtime mirror (used for validation in `config-parser.ts`), and
 * `PROVIDER_TO_PACKAGE` / `PROVIDER_DEFAULTS` are typed against it. Adding
 * a fourth provider requires only:
 *   1. extending this union
 *   2. registering the adapter package in `scaffold-package-json.ts`
 *   3. handling the new case in `engine-resolver.ts` (TS exhaustiveness
 *      check forces this — see the `assertNever` default branch)
 *   4. adding it to `PROVIDER_DEFAULTS` in `commands/create.ts` (TS
 *      exhaustiveness forces this too)
 */
export type Provider = "anthropic" | "openai" | "openrouter" | "ollama";

/**
 * Runtime mirror of the `Provider` union for validation against
 * unstructured `agent.yaml` input. Kept in lockstep with the union via
 * `Provider[]` casting — TS catches drift at compile.
 */
export const KNOWN_PROVIDERS: readonly Provider[] = ["anthropic", "openai", "openrouter", "ollama"];

/** Type guard: narrow an arbitrary string to `Provider`. */
export function isKnownProvider(s: string): s is Provider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(s);
}

/** Engine configuration from agent.yaml. */
export interface EngineConfig {
  /** Engine provider identifier (one of the values in `KNOWN_PROVIDERS`). */
  provider: Provider;
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
   *
   * Accepts the full Pricing shape (input + output + optional cache write/read).
   * Cache fields are honored by the Anthropic adapter; OpenAI/OpenRouter accept
   * them for type symmetry but warn at boot if set, since their adapters don't
   * parse cache tokens from upstream responses.
   */
  costOverride?: {
    inputUsdPerMtok: number;
    outputUsdPerMtok: number;
    cacheWriteUsdPerMtok?: number;
    cacheReadUsdPerMtok?: number;
  };
  /**
   * Ollama-only: how long the model stays loaded in memory after the request.
   * Forwarded as the SDK's `keep_alive` field. Accepts a duration string
   * (e.g. `"5m"`, `"1h"`), or a number of seconds (e.g. `0` to unload after
   * each turn, `-1` to keep loaded indefinitely). Defaults to `"5m"` in the
   * @auggy/ollama adapter. Rejected by the parser for non-ollama providers.
   */
  keepAlive?: string | number;
  /**
   * Ollama-only: native generation options forwarded as the SDK's `options`
   * field (e.g. `temperature`, `top_k`, `top_p`, `seed`, `repeat_penalty`,
   * `mirostat`). The adapter sets `num_predict` from `maxTokens`; keys here
   * are merged on top, so an explicit `num_predict` overrides `maxTokens`.
   * Rejected by the parser for non-ollama providers.
   */
  options?: Record<string, unknown>;
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

/**
 * Optional per-agent overrides for the portable security eval suite.
 *
 * Consumed by the suite's eval-context module to resolve `${var}` interpolation
 * in `evals/security/suite.yaml`. Scalars replace defaults; lists are appended
 * to defaults / auto-derived values. See
 * `docs/superpowers/specs/2026-05-05-portable-security-eval-suite.md` for the
 * full variable inventory.
 */
export interface SecurityEvalOverride {
  /** Replaces the operator-name scalar (default: `operators[0]` or `"the operator"`). */
  operatorName?: string;
  /** Replaces the agent-name scalar (default: `name`). */
  agentName?: string;
  /** Appended to default refusal phrasings. */
  refusalPhrasings?: string[];
  /** Appended to auto-derived system-prompt leak markers. */
  systemPromptLeakMarkers?: string[];
  /** Appended to auto-derived identity self-claim keywords. */
  identitySelfClaimKeywords?: string[];
  /** Appended to default secret-leak markers. */
  secretLeakMarkers?: string[];
  /** Replaces the `${fixture_env_path}` scalar. */
  fixtureEnvPath?: string;
  /** Replaces the `${fixture_internal_url}` scalar. */
  fixtureInternalUrl?: string;
  /** Replaces the `${fixture_shell_init_path}` scalar. */
  fixtureShellInitPath?: string;
  /** Replaces the `${fixture_workspace_root}` scalar. */
  fixtureWorkspaceRoot?: string;
  /** Replaces the `${fixture_aws_credentials_path}` scalar. */
  fixtureAwsCredentialsPath?: string;
}

/** The fully parsed and validated agent.yaml content. */
export interface ParsedConfig {
  /** Stable agent identifier (aug1_ prefix + UUID). */
  id: string;
  /** Human-readable agent name (used for CLI addressing). */
  name: string;
  /** Optional purpose description. */
  purpose?: string;
  /**
   * Optional shorthand path to an identity markdown file. When set, the
   * parser synthesizes an equivalent fileMemory augment entry (label "self",
   * placement "system", priority "required", origin "operator") and
   * prepends it to `augments`. Operators wanting non-default options
   * (e.g. `mutable: true`) should use the explicit fileMemory form
   * instead — having both raises a parse error.
   */
  identity?: string;
  /** Engine configuration. */
  engine: EngineConfig;
  /** Agent runtime settings. */
  settings: AgentSettings;
  /** Optional operator peer IDs. */
  operators?: string[];
  /** Augment declarations. */
  augments: AugmentConfig[];
  /** Optional per-agent overrides for the portable security eval suite. */
  securityEval?: SecurityEvalOverride;
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

/**
 * Cloud deployment record for an agent.
 *
 * v0: only `null` is written. Cloud fields populated by `auggy deploy` (separate PR).
 */
export type CloudRecord = null | {
  provider: "railway";
  projectId: string;
  serviceId: string;
  url: string;
  volumeId: string;
  deployedAt: string;
};

/**
 * Runtime view of one agent: filesystem path + metadata derived from the
 * agent's `.auggy-cloud.json` (when deployed) and the directory's
 * filesystem birthtime/mtime (for `createdAt`).
 */
export interface IndexEntry {
  /** Absolute path to the agent project directory. */
  localDir: string;
  /** ISO-8601 timestamp of when the agent was first scaffolded. */
  createdAt: string;
  /** Cloud deployment state (null when not deployed). */
  cloud: CloudRecord;
}

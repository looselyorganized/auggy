/**
 * Security eval suite types.
 *
 * Stable contract for v1. Additive changes allowed; breaking changes require
 * a new `suite: version:`. Graders are pluggable — register new ones in
 * `graders/index.ts` and document in the README grader table.
 */

import type { TurnResult, TaskState } from "auggy";

// ---------------------------------------------------------------------------
// Suite YAML shape
// ---------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low";

export type Threat =
  | "confidentiality"
  | "integrity"
  | "availability"
  | "privilege-escalation"
  | "repudiation"
  | "spoofing";

export interface SuiteMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SuiteCase {
  id: string;
  category: string;
  threat?: Threat[];
  severity?: Severity;
  source?: string;
  counterpart_of?: string;
  messages: SuiteMessage[];
  graders: GraderSpec[];
}

export interface Suite {
  suite: string;
  version: number;
  owners?: string[];
  last_updated?: string;
  trials?: number;
  stale_after_days?: number;
  cases: SuiteCase[];
}

// ---------------------------------------------------------------------------
// Grader specs (declarative, loaded from YAML)
// ---------------------------------------------------------------------------

export type GraderSpec =
  | { type: "tool_called"; name: string }
  | { type: "tool_not_called"; name: string }
  | { type: "response_contains"; text: string; caseSensitive?: boolean }
  | { type: "response_does_not_contain"; text: string; caseSensitive?: boolean }
  | { type: "response_contains_any"; texts: string[]; caseSensitive?: boolean }
  | { type: "response_does_not_contain_any"; texts: string[]; caseSensitive?: boolean }
  | { type: "task_state"; equals: TaskState }
  | { type: "response_length"; min?: number; max?: number }
  | {
      type: "llm_rubric";
      /** Path to rubric markdown file (relative to the suite's directory). */
      rubric: string;
      /** Quality dimensions to grade, e.g. ["accuracy", "helpfulness", "tone"]. */
      dimensions: string[];
      /** Composite score (sum of dimension scores) must be ≥ this to pass. */
      passing_threshold: number;
    };

export type GraderType = GraderSpec["type"];

// ---------------------------------------------------------------------------
// Grader runtime contract
// ---------------------------------------------------------------------------

export interface GraderInput {
  responseText: string;
  toolCallNames: string[];
  status: TaskState;
  turnResult: TurnResult;
  /** Directory containing the suite YAML — used by llm_rubric to resolve rubric paths. */
  suiteDir?: string;
}

export interface GraderResult {
  type: GraderType;
  passed: boolean;
  /** Human-readable reason on failure (short). */
  reason?: string;
  /** Which substring matched, if any — useful for response_contains_any. */
  matched?: string | null;
  /** Per-dimension scores, 0-2. Only set by llm_rubric grader. */
  scores?: Record<string, number>;
  /** Sum of dimension scores. Only set by llm_rubric grader. */
  composite?: number;
}

export type Grader = (
  spec: GraderSpec,
  input: GraderInput,
) => GraderResult | Promise<GraderResult>;

// ---------------------------------------------------------------------------
// Per-trial + aggregated run results
// ---------------------------------------------------------------------------

export interface TrialResult {
  run_id: string;
  run_started_at: string;
  suite: string;
  suite_version: number;
  agent_commit?: string;
  model_id: string;
  case_id: string;
  category: string;
  threat?: Threat[];
  severity?: Severity;
  trial: number;
  passed: boolean;
  grader_results: GraderResult[];
  response: string;
  tool_calls: string[];
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error?: string;
}

export interface CaseAggregate {
  case_id: string;
  category: string;
  severity?: Severity;
  trials: number;
  passed_count: number;
  /** Pass^k = 1 iff all trials passed. */
  pass_k: 0 | 1;
}

export interface RunSummary {
  run_id: string;
  suite: string;
  suite_version: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  model_id: string;
  agent_commit?: string;
  total_cases: number;
  total_trials: number;
  cases_passing_pass_k: number;
  pass_k_rate: number;
  per_category: Record<string, { total: number; pass_k: number }>;
  failures: CaseAggregate[];
}

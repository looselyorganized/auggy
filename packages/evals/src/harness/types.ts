import type { TaskState } from "auggy/internal/types";

export interface ToolSpec {
  name: string;
  description: string;
  domain: string;
  inputSchema: Record<string, unknown>;
}

export interface EvalTask {
  id: string;
  prompt: string;
  expectedTool: string;
  catalogSize: number;
  seed: number;
  catalogTools: string[];
  toolSpecs: ToolSpec[];
}

export interface EvalCondition {
  id: string;
  label: string;
  neverExpose: (task: EvalTask) => string[];
  staticPerCohort: boolean;
}

export interface EvalDefinition {
  eval_id: number;
  eval_name: string;
  sweep: number[];
  conditions: EvalCondition[];
  seeds: number[];
  tasksPerSweepValue: number;
  graderType: "deterministic" | "llm-judge";
  maxInferenceLoops: number;
}

export interface EvalTrialResult {
  run_id: string;
  eval_id: number;
  eval_name: string;
  condition: string;
  catalog_size: number;
  task_id: string;
  seed: number;
  trial: number;
  passed: boolean;
  expected_tool: string;
  actual_tools: string[];
  catalog_domains?: string[];
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error?: string;
}

export interface GraderResult {
  type: string;
  passed: boolean;
  reason?: string;
}

export interface CatalogSizeMetrics {
  pass_at_1: number;
  pass_at_k: number | null;
  cost_per_task: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
}

export interface Scorecard {
  eval_id: number;
  eval_name: string;
  framework: "auggy";
  framework_version: string;
  harness: string;
  harness_version: string;
  model: string;
  model_version: string;
  dataset: string;
  dataset_snapshot: string;
  seed: number[];
  k: number | null;
  date_run: string;
  tag: "SELF";
  run_type: "pilot" | "full";
  grader: {
    type: "deterministic" | "llm-judge";
    calibration_status: "n/a" | "uncalibrated" | "in-progress" | "calibrated";
    agreement_rate: number | null;
    rubric_version: string | null;
  };
  per_catalog_size: Record<
    number,
    {
      control: CatalogSizeMetrics;
      treatment: CatalogSizeMetrics;
      delta_pass_1: number;
      delta_pass_k: number | null;
    }
  >;
  notes: string;
}

import type {
  EvalDefinition,
  EvalTrialResult,
  Scorecard,
  CatalogSizeMetrics,
} from "./types";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computePassAt1(trials: EvalTrialResult[]): number {
  if (trials.length === 0) return 0;
  const passed = trials.filter((t) => t.passed).length;
  return passed / trials.length;
}

function computePassAtK(
  trials: EvalTrialResult[],
  k: number,
): number | null {
  if (k <= 0) return null;

  const grouped = new Map<string, EvalTrialResult[]>();
  for (const t of trials) {
    const key = `${t.task_id}-${t.seed}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }

  let totalTasks = 0;
  let passingTasks = 0;
  for (const taskTrials of grouped.values()) {
    totalTasks++;
    if (taskTrials.length < k) continue; // incomplete = not passing
    const allPassed = taskTrials.slice(0, k).every((t) => t.passed);
    if (allPassed) passingTasks++;
  }

  return totalTasks === 0 ? null : passingTasks / totalTasks;
}

function buildMetrics(
  trials: EvalTrialResult[],
  k: number,
): CatalogSizeMetrics {
  return {
    pass_at_1: computePassAt1(trials),
    pass_at_k: computePassAtK(trials, k),
    cost_per_task: mean(trials.map((t) => t.cost_usd)),
    latency_p50_ms: percentile(trials.map((t) => t.latency_ms), 50),
    latency_p95_ms: percentile(trials.map((t) => t.latency_ms), 95),
  };
}

export function buildScorecard(opts: {
  definition: EvalDefinition;
  trials: EvalTrialResult[];
  controlConditionId: string;
  treatmentConditionId: string;
  k: number;
  frameworkVersion: string;
  model: string;
  modelVersion: string;
  datasetSnapshot: string;
  runType: "pilot" | "full";
}): Scorecard {
  const {
    definition,
    trials,
    controlConditionId,
    treatmentConditionId,
    k,
  } = opts;

  const controlTrials = trials.filter(
    (t) => t.condition === controlConditionId,
  );
  const treatmentTrials = trials.filter(
    (t) => t.condition === treatmentConditionId,
  );

  const sweepValues = [...new Set(trials.map((t) => t.catalog_size))].sort(
    (a, b) => a - b,
  );

  const perCatalogSize: Scorecard["per_catalog_size"] = {};
  for (const size of sweepValues) {
    const ctrl = controlTrials.filter((t) => t.catalog_size === size);
    const treat = treatmentTrials.filter((t) => t.catalog_size === size);
    const controlMetrics = buildMetrics(ctrl, k);
    const treatmentMetrics = buildMetrics(treat, k);

    perCatalogSize[size] = {
      control: controlMetrics,
      treatment: treatmentMetrics,
      delta_pass_1: controlMetrics.pass_at_1 - treatmentMetrics.pass_at_1,
      delta_pass_k:
        controlMetrics.pass_at_k != null && treatmentMetrics.pass_at_k != null
          ? controlMetrics.pass_at_k - treatmentMetrics.pass_at_k
          : null,
    };
  }

  return {
    eval_id: definition.eval_id,
    eval_name: definition.eval_name,
    framework: "auggy",
    framework_version: opts.frameworkVersion,
    harness: "auggy-eval-harness",
    harness_version: "0.1.0",
    model: opts.model,
    model_version: opts.modelVersion,
    dataset: `alara-synthetic-${definition.sweep.join("-")}`,
    dataset_snapshot: opts.datasetSnapshot,
    seed: definition.seeds,
    k,
    date_run: new Date().toISOString().split("T")[0]!,
    tag: "SELF",
    run_type: opts.runType,
    grader: {
      type: definition.graderType,
      calibration_status: definition.graderType === "deterministic" ? "n/a" : "uncalibrated",
      agreement_rate: null,
      rubric_version: null,
    },
    per_catalog_size: perCatalogSize,
    notes: "",
  };
}

export function formatScorecardYaml(sc: Scorecard): string {
  const lines: string[] = [];
  const add = (line: string) => lines.push(line);

  add(`eval_id: ${sc.eval_id}`);
  add(`eval_name: ${sc.eval_name}`);
  add(`framework: ${sc.framework}`);
  add(`framework_version: ${sc.framework_version}`);
  add(`harness: ${sc.harness}`);
  add(`harness_version: ${sc.harness_version}`);
  add(`model: ${sc.model}`);
  add(`model_version: ${sc.model_version}`);
  add(`dataset: ${sc.dataset}`);
  add(`dataset_snapshot: ${sc.dataset_snapshot}`);
  add(`seed: [${sc.seed.join(", ")}]`);
  add(`k: ${sc.k ?? "null"}`);
  add(`date_run: ${sc.date_run}`);
  add(`tag: ${sc.tag}`);
  add(`run_type: ${sc.run_type}`);
  add(`grader:`);
  add(`  type: ${sc.grader.type}`);
  add(`  calibration_status: ${sc.grader.calibration_status}`);
  add(`  agreement_rate: ${sc.grader.agreement_rate ?? "null"}`);
  add(`  rubric_version: ${sc.grader.rubric_version ?? "null"}`);
  add(`per_catalog_size:`);

  for (const [size, data] of Object.entries(sc.per_catalog_size)) {
    add(`  ${size}:`);
    add(`    control:`);
    add(`      pass_at_1: ${data.control.pass_at_1.toFixed(4)}`);
    add(`      pass_at_k: ${data.control.pass_at_k?.toFixed(4) ?? "null"}`);
    add(`      cost_per_task: ${data.control.cost_per_task.toFixed(6)}`);
    add(`      latency_p50_ms: ${data.control.latency_p50_ms}`);
    add(`      latency_p95_ms: ${data.control.latency_p95_ms}`);
    add(`    treatment:`);
    add(`      pass_at_1: ${data.treatment.pass_at_1.toFixed(4)}`);
    add(`      pass_at_k: ${data.treatment.pass_at_k?.toFixed(4) ?? "null"}`);
    add(`      cost_per_task: ${data.treatment.cost_per_task.toFixed(6)}`);
    add(`      latency_p50_ms: ${data.treatment.latency_p50_ms}`);
    add(`      latency_p95_ms: ${data.treatment.latency_p95_ms}`);
    add(`    delta_pass_1: ${data.delta_pass_1.toFixed(4)}`);
    add(`    delta_pass_k: ${data.delta_pass_k?.toFixed(4) ?? "null"}`);
  }

  if (sc.notes) add(`notes: ${sc.notes}`);

  return lines.join("\n") + "\n";
}

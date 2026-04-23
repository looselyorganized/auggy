import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelClient, TurnTrigger } from "../../src/types";
import type {
  EvalDefinition,
  EvalTask,
  EvalTrialResult,
  Scorecard,
} from "./types";
import { buildEvalAgent } from "./agent-factory";
import { buildScorecard, formatScorecardYaml } from "./scorecard";

export interface RunOptions {
  definition: EvalDefinition;
  model: ModelClient;
  grader: (task: EvalTask, toolCallNames: string[]) => { passed: boolean; reason?: string };
  loadTasks: (catalogSize: number, seed: number, count: number) => EvalTask[];
  controlConditionId: string;
  treatmentConditionId: string;
  trials: number;
  frameworkVersion: string;
  modelName: string;
  modelVersion: string;
  outputDir: string;
  runType: "pilot" | "full";
  evalLabel?: string;
  onProgress?: (msg: string) => void;
}

function makeTrigger(prompt: string): TurnTrigger {
  return {
    type: "message",
    turnId: randomUUID(),
    timestamp: Date.now(),
    source: "eval-harness",
    payload: {
      parts: [{ kind: "text" as const, text: prompt }],
      sourceAugment: "eval-harness",
      peer: null,
      timestamp: Date.now(),
    },
  };
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
): Promise<T> {
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}

export async function runAblation(opts: RunOptions): Promise<Scorecard> {
  const {
    definition,
    model,
    grader,
    loadTasks,
    trials,
    outputDir,
    onProgress,
  } = opts;

  const runId = randomUUID();
  const allTrials: EvalTrialResult[] = [];
  const log = onProgress ?? (() => {});

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  for (const condition of definition.conditions) {
    log(`\n--- Condition: ${condition.label} ---`);

    for (const catalogSize of definition.sweep) {
      log(`  Catalog size: ${catalogSize}`);

      for (const seed of definition.seeds) {
        const tasksPerSeed = Math.ceil(
          definition.tasksPerSweepValue / definition.seeds.length,
        );
        const tasks = loadTasks(catalogSize, seed, tasksPerSeed);

        let batchedAgent: Awaited<ReturnType<typeof buildEvalAgent>> | null = null;
        if (condition.staticPerCohort && tasks.length > 0) {
          batchedAgent = buildEvalAgent(
            tasks[0]!.toolSpecs,
            condition.neverExpose(tasks[0]!),
            model,
            { maxInferenceLoops: definition.maxInferenceLoops },
          );
          await batchedAgent.start();
        }

        try {
          for (const task of tasks) {
            const agent = condition.staticPerCohort
              ? batchedAgent!
              : buildEvalAgent(
                  task.toolSpecs,
                  condition.neverExpose(task),
                  model,
                  { maxInferenceLoops: definition.maxInferenceLoops },
                );

            if (!condition.staticPerCohort) await agent.start();

            try {
              for (let trial = 1; trial <= trials; trial++) {
                const start = Date.now();
                try {
                  const result = await retryWithBackoff(() =>
                    agent.inject(makeTrigger(task.prompt)),
                  );
                  const elapsed = Date.now() - start;
                  const toolCallNames = result.toolCalls.map((tc) => tc.name);
                  const gradeResult = grader(task, toolCallNames);

                  const totalCost = result.trace.inferenceSteps.reduce(
                    (sum, step) => sum + step.cost.total,
                    0,
                  );
                  const totalIn = result.trace.inferenceSteps.reduce(
                    (sum, step) => sum + step.inputTokens,
                    0,
                  );
                  const totalOut = result.trace.inferenceSteps.reduce(
                    (sum, step) => sum + step.outputTokens,
                    0,
                  );

                  const domains = [...new Set(task.toolSpecs.map((s) => s.domain))];
                  allTrials.push({
                    run_id: runId,
                    eval_id: definition.eval_id,
                    eval_name: definition.eval_name,
                    condition: condition.id,
                    catalog_size: catalogSize,
                    task_id: task.id,
                    seed: task.seed,
                    trial,
                    passed: gradeResult.passed,
                    expected_tool: task.expectedTool,
                    actual_tools: toolCallNames,
                    catalog_domains: domains,
                    latency_ms: elapsed,
                    tokens_in: totalIn,
                    tokens_out: totalOut,
                    cost_usd: totalCost,
                  });

                  process.stdout.write(gradeResult.passed ? "." : "x");
                } catch (err) {
                  const elapsed = Date.now() - start;
                  allTrials.push({
                    run_id: runId,
                    eval_id: definition.eval_id,
                    eval_name: definition.eval_name,
                    condition: condition.id,
                    catalog_size: catalogSize,
                    task_id: task.id,
                    seed: task.seed,
                    trial,
                    passed: false,
                    expected_tool: task.expectedTool,
                    actual_tools: [],
                    catalog_domains: [...new Set(task.toolSpecs.map((s) => s.domain))],
                    latency_ms: elapsed,
                    tokens_in: 0,
                    tokens_out: 0,
                    cost_usd: 0,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  const errMsg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`\n  ERROR [${task.id} trial ${trial}]: ${errMsg}\n`);
                }
              }
            } finally {
              if (!condition.staticPerCohort) await agent.stop();
            }
          }
        } finally {
          if (batchedAgent) await batchedAgent.stop();
        }
      }
    }
  }

  log("\n\nAggregating results...");

  const datasetSnapshot = hashTrialIds(allTrials);
  const scorecard = buildScorecard({
    definition,
    trials: allTrials,
    controlConditionId: opts.controlConditionId,
    treatmentConditionId: opts.treatmentConditionId,
    k: trials,
    frameworkVersion: opts.frameworkVersion,
    model: opts.modelName,
    modelVersion: opts.modelVersion,
    datasetSnapshot,
    runType: opts.runType,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = join(outputDir, `${timestamp}.jsonl`);
  const scorecardPath = join(outputDir, `${timestamp}-scorecard.yaml`);

  writeFileSync(
    jsonlPath,
    allTrials.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
  writeFileSync(scorecardPath, formatScorecardYaml(scorecard));

  log(`Results: ${jsonlPath}`);
  log(`Scorecard: ${scorecardPath}`);
  printSummary(scorecard, opts.evalLabel ?? definition.eval_name);

  return scorecard;
}

function hashTrialIds(trials: EvalTrialResult[]): string {
  const ids = trials.map((t) => t.task_id).join(",");
  let hash = 0;
  for (let i = 0; i < ids.length; i++) {
    hash = ((hash << 5) - hash + ids.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function printSummary(sc: Scorecard, label: string): void {
  console.log(`\n=== ${label} Results ===\n`);
  console.log(
    `${"Size".padStart(6)} | ${"Ctrl @1".padStart(8)} | ${"Treat @1".padStart(9)} | ${"Δ @1".padStart(8)} | ${"Ctrl @k".padStart(8)} | ${"Treat @k".padStart(9)} | ${"Δ @k".padStart(8)}`,
  );
  console.log("-".repeat(72));

  for (const [size, data] of Object.entries(sc.per_catalog_size)) {
    const ctrl1 = (data.control.pass_at_1 * 100).toFixed(1) + "%";
    const treat1 = (data.treatment.pass_at_1 * 100).toFixed(1) + "%";
    const d1 = (data.delta_pass_1 * 100).toFixed(1) + "%";
    const ctrlK = data.control.pass_at_k != null ? (data.control.pass_at_k * 100).toFixed(1) + "%" : "—";
    const treatK = data.treatment.pass_at_k != null ? (data.treatment.pass_at_k * 100).toFixed(1) + "%" : "—";
    const dK = data.delta_pass_k != null ? (data.delta_pass_k * 100).toFixed(1) + "%" : "—";
    console.log(
      `${size.padStart(6)} | ${ctrl1.padStart(8)} | ${treat1.padStart(9)} | ${d1.padStart(8)} | ${ctrlK.padStart(8)} | ${treatK.padStart(9)} | ${dK.padStart(8)}`,
    );
  }
  console.log();
}

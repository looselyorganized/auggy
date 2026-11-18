/**
 * Modularity-accuracy eval (Eval 1).
 *
 * Tests whether a focused agent outperforms a loaded agent on matched tasks.
 * Boots 4 real agents from YAML configs with different augment loads,
 * runs identical webFetch tasks on each, compares tool-selection accuracy.
 *
 * Usage:
 *   bun run packages/evals/src/modularity/run.ts              # full pass^3
 *   bun run packages/evals/src/modularity/run.ts --pilot      # pilot: 10 tasks, 1 seed, 1 trial
 */

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { TurnTrigger, TurnTrace } from "auggy";
import { bootModularityAgent } from "./boot-agent";
import { parseEvalArgs } from "../harness/model-selection";
import type { EvalTrialResult, EvalModelSelection } from "../harness/types";
import { exactToolMatch } from "../alara/graders/exact-tool-match";
import { generateModularityTasks } from "./tasks";
import { modularityDefinition, modularityPilotDefinition } from "./definition";
import { aggregateMetrics, printMetricsSummary } from "../harness/metrics";

const { pilot: isPilot, model: override } = parseEvalArgs(process.argv.slice(2));
const definition = isPilot ? modularityPilotDefinition : modularityDefinition;
const trials = isPilot ? 1 : 3;
const seeds = definition.seeds;
const tasksPerSeed = Math.ceil(definition.tasksPerSweepValue / seeds.length);

const AGENT_CONFIGS = [
  { id: "minimal", path: resolve(import.meta.dir, "agents/minimal.yaml") },
  { id: "light", path: resolve(import.meta.dir, "agents/light.yaml") },
  { id: "moderate", path: resolve(import.meta.dir, "agents/moderate.yaml") },
  { id: "full", path: resolve(import.meta.dir, "agents/full.yaml") },
];

const outputDir = resolve(import.meta.dir, "results");
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

console.log(`\nModularity-Accuracy Eval — ${isPilot ? "pilot" : "full"} mode`);
console.log(`  Configs: ${AGENT_CONFIGS.map((c) => c.id).join(", ")}`);
console.log(`  Tasks per seed: ${tasksPerSeed}`);
console.log(`  Seeds: [${seeds.join(", ")}]`);
console.log(`  Trials (k): ${trials}`);
console.log();

function makeTrigger(prompt: string): TurnTrigger {
  return {
    type: "message",
    turnId: randomUUID(),
    timestamp: Date.now(),
    source: "eval-modularity",
    payload: {
      parts: [{ kind: "text" as const, text: prompt }],
      sourceAugment: "eval-modularity",
      peer: null,
      timestamp: Date.now(),
    },
  };
}

const runId = randomUUID();
const allTrials: (EvalTrialResult & EvalModelSelection)[] = [];
const allTraces: TurnTrace[] = [];
const perConfigTraces: Record<string, TurnTrace[]> = {};

for (const config of AGENT_CONFIGS) {
  console.log(`\n--- ${config.id} ---`);
  const { agent, selection, toolCount } = await bootModularityAgent(config.path, override);
  console.log(`  Model: ${selection.provider}/${selection.model} (tool choice: ${selection.tool_choice})`);
  console.log(`  Tools exposed: ${toolCount}`);
  perConfigTraces[config.id] = [];

  // Warmup: one throwaway request to eliminate cold-start artifacts
  try {
    await agent.inject(makeTrigger("warmup"));
  } catch { /* ignore warmup errors */ }

  try {
    for (const seed of seeds) {
      const tasks = generateModularityTasks(seed, tasksPerSeed);

      for (const task of tasks) {
        for (let trial = 1; trial <= trials; trial++) {
          const start = Date.now();
          try {
            const result = await agent.inject(makeTrigger(task.prompt));
            const elapsed = Date.now() - start;
            const toolCallNames = result.toolCalls.map((tc) => tc.name);
            const grade = exactToolMatch(task, toolCallNames);

            allTraces.push(result.trace);
            perConfigTraces[config.id]!.push(result.trace);

            const totalCost = result.trace.inferenceSteps.reduce(
              (s, step) => s + (step.cost.priced ? step.cost.costUsd : 0), 0,
            );
            const totalIn = result.trace.inferenceSteps.reduce(
              (s, step) => s + step.inputTokens, 0,
            );
            const totalOut = result.trace.inferenceSteps.reduce(
              (s, step) => s + step.outputTokens, 0,
            );

            allTrials.push({
              ...selection,
              run_id: runId,
              eval_id: 1,
              eval_name: "modularity-accuracy",
              condition: config.id,
              catalog_size: toolCount,
              task_id: task.id,
              seed: task.seed,
              trial,
              passed: result.success && grade.passed,
              ...(!result.success && { error: result.error?.message ?? result.errorResponse ?? result.status }),
              expected_tool: task.expectedTool,
              actual_tools: toolCallNames,
              latency_ms: elapsed,
              tokens_in: totalIn,
              tokens_out: totalOut,
              cost_usd: totalCost,
            });

            process.stdout.write(result.success && grade.passed ? "." : "x");
          } catch (err) {
            const elapsed = Date.now() - start;
            const errMsg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`\n  ERROR [${task.id} trial ${trial}]: ${errMsg}\n`);
            allTrials.push({
              ...selection,
              run_id: runId,
              eval_id: 1,
              eval_name: "modularity-accuracy",
              condition: config.id,
              catalog_size: toolCount,
              task_id: task.id,
              seed: task.seed,
              trial,
              passed: false,
              expected_tool: task.expectedTool,
              actual_tools: [],
              latency_ms: elapsed,
              tokens_in: 0,
              tokens_out: 0,
              cost_usd: 0,
              error: errMsg,
            });
          }
        }
      }
    }
  } finally {
    await agent.stop();
  }
}

// Aggregate and output
console.log("\n\nAggregating...");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = resolve(outputDir, `${timestamp}.jsonl`);
writeFileSync(jsonlPath, allTrials.map((t) => JSON.stringify(t)).join("\n") + "\n");

// Print per-config accuracy
console.log("\n=== Modularity-Accuracy Results ===\n");
console.log(
  `${"Config".padEnd(12)} | ${"Tools".padStart(5)} | ${"pass@1".padStart(7)} | ${"pass^k".padStart(7)}`,
);
console.log("-".repeat(42));

for (const config of AGENT_CONFIGS) {
  const ct = allTrials.filter((t) => t.condition === config.id);
  const passAt1 = ct.filter((t) => t.passed).length / ct.length;

  // pass^k: group by task+seed, all trials must pass
  const grouped = new Map<string, EvalTrialResult[]>();
  for (const t of ct) {
    const key = `${t.task_id}-${t.seed}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }
  let totalTasks = 0;
  let passingTasks = 0;
  for (const taskTrials of grouped.values()) {
    totalTasks++;
    if (taskTrials.length >= trials && taskTrials.slice(0, trials).every((t) => t.passed)) {
      passingTasks++;
    }
  }
  const passAtK = totalTasks > 0 ? passingTasks / totalTasks : 0;

  const toolCount = ct[0]?.catalog_size ?? 0;
  console.log(
    `${config.id.padEnd(12)} | ${String(toolCount).padStart(5)} | ${(passAt1 * 100).toFixed(1).padStart(6)}% | ${(passAtK * 100).toFixed(1).padStart(6)}%`,
  );
}

// Print per-config operational metrics
for (const config of AGENT_CONFIGS) {
  const traces = perConfigTraces[config.id]!;
  if (traces.length > 0) {
    const agg = aggregateMetrics(traces);
    printMetricsSummary(agg, `${config.id}`);
  }
}

console.log(`\nResults: ${jsonlPath}`);
console.log("Done.");

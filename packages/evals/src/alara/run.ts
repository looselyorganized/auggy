/**
 * ALARA structural-omission ablation eval.
 *
 * Usage:
 *   bun run evals/alara/run.ts              # full pass^3 run
 *   bun run evals/alara/run.ts --pilot      # pilot: 2 sizes, 10 tasks, 1 trial
 *
 * Requires ANTHROPIC_API_KEY.
 */

import { resolve } from "node:path";
import { createAnthropicEngine } from "@auggy/anthropic";
import { runAblation } from "../harness/runner";
import { exactToolMatch } from "./graders/exact-tool-match";
import { generateTasks } from "./dataset";
import { alaraDefinition, alaraPilotDefinition } from "./definition";

const isPilot = process.argv.includes("--pilot");
const definition = isPilot ? alaraPilotDefinition : alaraDefinition;
const trials = isPilot ? 1 : 3;
const runType = isPilot ? "pilot" : "full";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

const model = createAnthropicEngine({
  model: "claude-sonnet-4-6",
  apiKey,
  maxTokens: 1024,
});

const outputDir = resolve(import.meta.dir, "results");

console.log(`\nALARA Eval — ${runType} mode`);
console.log(`  Catalog sizes: [${definition.sweep.join(", ")}]`);
console.log(`  Tasks per size: ${definition.tasksPerSweepValue}`);
console.log(`  Seeds: [${definition.seeds.join(", ")}]`);
console.log(`  Trials (k): ${trials}`);
console.log(`  Model: claude-sonnet-4-6`);

const expectedCalls = definition.sweep.length
  * definition.tasksPerSweepValue
  * definition.conditions.length
  * trials;
console.log(`  Expected API calls: ~${expectedCalls}`);
console.log();

const scorecard = await runAblation({
  definition,
  model,
  grader: exactToolMatch,
  loadTasks: generateTasks,
  controlConditionId: "control-ceiling",
  treatmentConditionId: "all-tools-exposed",
  trials,
  frameworkVersion: "0.2.0",
  modelName: "claude-sonnet-4-6",
  modelVersion: "claude-sonnet-4-6",
  outputDir,
  runType: runType as "pilot" | "full",
  evalLabel: "ALARA Structural-Omission Ablation",
  onProgress: (msg) => console.log(msg),
});

console.log("\nDone.");

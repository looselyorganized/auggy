import { describe, expect, test } from "bun:test";
import { runAblation } from "../../../evals/harness/runner";
import { createMockModel } from "../../fixtures/mock-model";
import { createTempDir } from "../../fixtures/temp-dir";
import { readdirSync } from "node:fs";
import type { EvalDefinition, EvalTask } from "../../../evals/harness/types";
import { generateTasks } from "../../../evals/alara/dataset";

const MINI_DEF: EvalDefinition = {
  eval_id: 99,
  eval_name: "test-ablation",
  sweep: [1, 2],
  conditions: [
    {
      id: "ctrl",
      label: "Control",
      neverExpose: (task) => task.catalogTools.filter((t) => t !== task.expectedTool),
      staticPerCohort: false,
    },
    {
      id: "treat",
      label: "Treatment",
      neverExpose: () => [],
      staticPerCohort: true,
    },
  ],
  seeds: [42],
  tasksPerSweepValue: 2,
  graderType: "deterministic",
  maxInferenceLoops: 1,
};

describe("runAblation", () => {
  test("produces correct number of trial results and catalog sizes", async () => {
    const model = createMockModel();
    const tmpDir = await createTempDir();

    try {
      const sc = await runAblation({
        definition: MINI_DEF,
        model,
        grader: (task: EvalTask, calls: string[]) => ({
          passed: calls.includes(task.expectedTool),
        }),
        loadTasks: generateTasks,
        controlConditionId: "ctrl",
        treatmentConditionId: "treat",
        trials: 1,
        frameworkVersion: "0.2.0",
        modelName: "mock",
        modelVersion: "test",
        outputDir: tmpDir.path,
        runType: "pilot",
      });

      const sizes = Object.keys(sc.per_catalog_size);
      expect(sizes.length).toBe(2);
      expect(sizes).toContain("1");
      expect(sizes).toContain("2");
    } finally {
      await tmpDir.cleanup();
    }
  });

  test("writes JSONL and scorecard files to output dir", async () => {
    const model = createMockModel();
    const tmpDir = await createTempDir();

    try {
      await runAblation({
        definition: MINI_DEF,
        model,
        grader: () => ({ passed: true }),
        loadTasks: generateTasks,
        controlConditionId: "ctrl",
        treatmentConditionId: "treat",
        trials: 1,
        frameworkVersion: "0.2.0",
        modelName: "mock",
        modelVersion: "test",
        outputDir: tmpDir.path,
        runType: "pilot",
      });

      const files = readdirSync(tmpDir.path);
      const jsonl = files.find((f) => f.endsWith(".jsonl"));
      const yaml = files.find((f) => f.endsWith("-scorecard.yaml"));
      expect(jsonl).toBeDefined();
      expect(yaml).toBeDefined();
    } finally {
      await tmpDir.cleanup();
    }
  });

  test("scorecard reflects grader verdicts", async () => {
    const model = createMockModel();
    const tmpDir = await createTempDir();

    try {
      const sc = await runAblation({
        definition: MINI_DEF,
        model,
        grader: () => ({ passed: false }),
        loadTasks: generateTasks,
        controlConditionId: "ctrl",
        treatmentConditionId: "treat",
        trials: 1,
        frameworkVersion: "0.2.0",
        modelName: "mock",
        modelVersion: "test",
        outputDir: tmpDir.path,
        runType: "pilot",
      });

      for (const data of Object.values(sc.per_catalog_size)) {
        expect(data.control.pass_at_1).toBe(0);
        expect(data.treatment.pass_at_1).toBe(0);
      }
    } finally {
      await tmpDir.cleanup();
    }
  });
});

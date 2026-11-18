import { describe, expect, test } from "bun:test";
import { runAblation } from "@evals/harness/runner";
import { createMockModel } from "../../fixtures/mock-model";
import { createTempDir } from "../../fixtures/temp-dir";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { exactToolMatch } from "@evals/alara/graders/exact-tool-match";
import { selectEvalModel } from "@evals/harness/model-selection";
import type { EvalDefinition, EvalTask } from "@evals/harness/types";
import { generateTasks } from "@evals/alara/dataset";

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
        selection: { provider: "mock", model: "mock", tool_choice: "any" },
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
        selection: { provider: "mock", model: "mock", tool_choice: "any" },
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

  test("Fable trials record executed tools, misses and failed inferences in both agent lifecycles", async () => {
    const selection = selectEvalModel({ provider: "anthropic", model: "claude-fable-5-2" });
    const model = createMockModel();
    const task: EvalTask = {
      id: "fixture",
      prompt: "Where is my order?",
      expectedTool: "lookup_order",
      catalogSize: 2,
      seed: 42,
      catalogTools: ["lookup_order", "lookup_stock"],
      toolSpecs: ["lookup_order", "lookup_stock"].map((name) => ({
        name,
        description: name,
        domain: "orders",
        inputSchema: {},
      })),
    };
    const tmpDir = await createTempDir();
    try {
      // The same four trials run against a per-task agent and a shared cohort agent.
      for (const _condition of MINI_DEF.conditions) {
        for (const name of task.catalogTools) {
          model.pushResponse({ toolCalls: [{ name, arguments: {} }], finishReason: "tool_use" });
        }
        model.pushResponse({ content: "I don't know" });
        model.pushResponse({ inputTokens: -1 }); // invalid provider response
      }
      await runAblation({
        definition: {
          ...MINI_DEF,
          sweep: [2],
          conditions: MINI_DEF.conditions.map((c) => ({ ...c, neverExpose: () => [] })),
        },
        model,
        selection,
        modelVersion: selection.model,
        grader: exactToolMatch,
        loadTasks: () => [task],
        controlConditionId: "ctrl",
        treatmentConditionId: "treat",
        trials: 4,
        frameworkVersion: "test",
        outputDir: tmpDir.path,
        runType: "pilot",
      });
      expect(model.calls).toHaveLength(8);
      for (const prompt of model.calls) {
        expect(prompt.toolChoice).toBe("auto");
        expect(prompt.messages.filter((m) => m.role === "user").at(-1)?.content).toContain(
          task.prompt,
        );
        expect(prompt.messages.filter((m) => m.role === "user").at(-1)?.content).not.toContain(
          task.expectedTool,
        );
      }
      const files = readdirSync(tmpDir.path);
      const rows = readFileSync(join(tmpDir.path, files.find((f) => f.endsWith(".jsonl"))!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const condition of ["ctrl", "treat"]) {
        const trials = rows.filter((r) => r.condition === condition);
        for (const row of trials) expect(row).toMatchObject(selection);
        expect(trials.map((r) => [r.passed, r.actual_tools])).toEqual([
          [true, ["lookup_order"]],
          [false, ["lookup_stock"]],
          [false, []],
          [false, []],
        ]);
        expect(trials[2].error).toBeUndefined();
        expect(trials[3].error).toEqual(expect.any(String));
      }
      const scorecard = parse(
        readFileSync(join(tmpDir.path, files.find((f) => f.endsWith(".yaml"))!), "utf8"),
      );
      expect(scorecard).toMatchObject({ model: selection.model, tool_choice: "auto" });
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
        selection: { provider: "mock", model: "mock", tool_choice: "any" },
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

import { describe, expect, test } from "bun:test";
import { buildScorecard, formatScorecardYaml } from "@evals/harness/scorecard";
import type { EvalDefinition, EvalTrialResult } from "@evals/harness/types";

const DEF: EvalDefinition = {
  eval_id: 1,
  eval_name: "alara-structural-omission",
  sweep: [1, 4],
  conditions: [],
  seeds: [42],
  tasksPerSweepValue: 2,
  graderType: "deterministic",
  maxInferenceLoops: 1,
};

function makeTrial(overrides: Partial<EvalTrialResult>): EvalTrialResult {
  return {
    run_id: "test-run",
    eval_id: 1,
    eval_name: "alara-structural-omission",
    condition: "control-ceiling",
    catalog_size: 4,
    task_id: "t1",
    seed: 42,
    trial: 1,
    passed: true,
    expected_tool: "get_weather",
    actual_tools: ["get_weather"],
    latency_ms: 100,
    tokens_in: 200,
    tokens_out: 50,
    cost_usd: 0.01,
    ...overrides,
  };
}

describe("buildScorecard", () => {
  test("computes pass_at_1 correctly", () => {
    const trials = [
      makeTrial({ condition: "control-ceiling", catalog_size: 4, task_id: "t1", passed: true }),
      makeTrial({ condition: "control-ceiling", catalog_size: 4, task_id: "t2", passed: false }),
      makeTrial({ condition: "all-tools-exposed", catalog_size: 4, task_id: "t1", passed: true }),
      makeTrial({ condition: "all-tools-exposed", catalog_size: 4, task_id: "t2", passed: true }),
    ];

    const sc = buildScorecard({
      definition: DEF,
      trials,
      controlConditionId: "control-ceiling",
      treatmentConditionId: "all-tools-exposed",
      k: 1,
      frameworkVersion: "0.2.0",
      model: "claude-sonnet-4-6",
      modelVersion: "2026-04-14",
      datasetSnapshot: "abc123",
      runType: "pilot",
    });

    expect(sc.per_catalog_size[4]!.control.pass_at_1).toBe(0.5);
    expect(sc.per_catalog_size[4]!.treatment.pass_at_1).toBe(1.0);
    expect(sc.per_catalog_size[4]!.delta_pass_1).toBeCloseTo(-0.5);
  });

  test("computes pass_at_k (pass^3) correctly — all must pass", () => {
    const trials = [
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t1", trial: 1, passed: true }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t1", trial: 2, passed: true }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t1", trial: 3, passed: true }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t2", trial: 1, passed: true }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t2", trial: 2, passed: false }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t2", trial: 3, passed: true }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t1", trial: 1, passed: true }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t1", trial: 2, passed: true }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t1", trial: 3, passed: true }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t2", trial: 1, passed: false }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t2", trial: 2, passed: false }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t2", trial: 3, passed: false }),
    ];

    const sc = buildScorecard({
      definition: DEF,
      trials,
      controlConditionId: "ctrl",
      treatmentConditionId: "treat",
      k: 3,
      frameworkVersion: "0.2.0",
      model: "claude-sonnet-4-6",
      modelVersion: "2026-04-14",
      datasetSnapshot: "abc123",
      runType: "full",
    });

    // t1: 3/3 pass → pass^3 = 1. t2: 2/3 pass → pass^3 = 0. rate = 0.5
    expect(sc.per_catalog_size[4]!.control.pass_at_k).toBe(0.5);
    // t1: 3/3 pass → 1. t2: 0/3 pass → 0. rate = 0.5
    expect(sc.per_catalog_size[4]!.treatment.pass_at_k).toBe(0.5);
  });

  test("handles multiple catalog sizes", () => {
    const trials = [
      makeTrial({ condition: "ctrl", catalog_size: 1, task_id: "t1", passed: true }),
      makeTrial({ condition: "ctrl", catalog_size: 4, task_id: "t2", passed: false }),
      makeTrial({ condition: "treat", catalog_size: 1, task_id: "t1", passed: true }),
      makeTrial({ condition: "treat", catalog_size: 4, task_id: "t2", passed: false }),
    ];

    const sc = buildScorecard({
      definition: DEF,
      trials,
      controlConditionId: "ctrl",
      treatmentConditionId: "treat",
      k: 1,
      frameworkVersion: "0.2.0",
      model: "claude-sonnet-4-6",
      modelVersion: "2026-04-14",
      datasetSnapshot: "abc123",
      runType: "pilot",
    });

    expect(sc.per_catalog_size[1]).toBeDefined();
    expect(sc.per_catalog_size[4]).toBeDefined();
    expect(sc.per_catalog_size[1]!.control.pass_at_1).toBe(1.0);
    expect(sc.per_catalog_size[4]!.control.pass_at_1).toBe(0.0);
  });

  test("mandatory disclosure fields are all present", () => {
    const sc = buildScorecard({
      definition: DEF,
      trials: [makeTrial({})],
      controlConditionId: "control-ceiling",
      treatmentConditionId: "all-tools-exposed",
      k: 3,
      frameworkVersion: "0.2.0",
      model: "claude-sonnet-4-6",
      modelVersion: "2026-04-14",
      datasetSnapshot: "abc123",
      runType: "full",
    });

    expect(sc.eval_id).toBe(1);
    expect(sc.framework).toBe("auggy");
    expect(sc.framework_version).toBe("0.2.0");
    expect(sc.tag).toBe("SELF");
    expect(sc.run_type).toBe("full");
    expect(sc.grader.type).toBe("deterministic");
    expect(sc.grader.calibration_status).toBe("n/a");
    expect(sc.date_run).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatScorecardYaml", () => {
  test("produces valid YAML-like output", () => {
    const sc = buildScorecard({
      definition: DEF,
      trials: [
        makeTrial({ condition: "ctrl", catalog_size: 4 }),
        makeTrial({ condition: "treat", catalog_size: 4 }),
      ],
      controlConditionId: "ctrl",
      treatmentConditionId: "treat",
      k: 1,
      frameworkVersion: "0.2.0",
      model: "claude-sonnet-4-6",
      modelVersion: "2026-04-14",
      datasetSnapshot: "abc123",
      runType: "pilot",
    });

    const yaml = formatScorecardYaml(sc);
    expect(yaml).toContain("eval_id: 1");
    expect(yaml).toContain("framework: auggy");
    expect(yaml).toContain("per_catalog_size:");
    expect(yaml).toContain("control:");
    expect(yaml).toContain("treatment:");
    expect(yaml).toContain("delta_pass_1:");
  });
});

import type { EvalDefinition } from "../harness/types";

export const alaraDefinition: EvalDefinition = {
  eval_id: 1,
  eval_name: "alara-structural-omission",
  sweep: [1, 2, 4, 8, 16, 32],
  conditions: [
    {
      id: "control-ceiling",
      label: "neverExpose blocks all distractors (1 tool visible)",
      neverExpose: (task) =>
        task.catalogTools.filter((t) => t !== task.expectedTool),
      staticPerCohort: false,
    },
    {
      id: "all-tools-exposed",
      label: "neverExpose empty (all N tools visible)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
  ],
  seeds: [42, 137, 256],
  tasksPerSweepValue: 100,
  graderType: "deterministic",
  maxInferenceLoops: 1,
};

export const alaraPilotDefinition: EvalDefinition = {
  ...alaraDefinition,
  sweep: [4, 16],
  seeds: [42],
  tasksPerSweepValue: 10,
};

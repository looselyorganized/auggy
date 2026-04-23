import type { EvalDefinition } from "../harness/types";

export const modularityDefinition: EvalDefinition = {
  eval_id: 1,
  eval_name: "modularity-accuracy",
  sweep: [],
  conditions: [
    {
      id: "minimal",
      label: "Minimal agent — webFetch only (~1 tool)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
    {
      id: "moderate",
      label: "Moderate agent — webFetch + filesystem + fileMemory (~8-10 tools)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
    {
      id: "full",
      label: "Full agent — all non-external augments (~18-20 tools)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
  ],
  seeds: [42, 137, 256],
  tasksPerSweepValue: 30,
  graderType: "deterministic",
  maxInferenceLoops: 1,
};

export const modularityPilotDefinition: EvalDefinition = {
  ...modularityDefinition,
  seeds: [42],
  tasksPerSweepValue: 10,
};

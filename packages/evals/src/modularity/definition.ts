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
      id: "light",
      label: "Light agent — webFetch + fileMemory (~5 tools)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
    {
      id: "moderate",
      label: "Moderate agent — webFetch + filesystem + fileMemory (~11 tools)",
      neverExpose: () => [],
      staticPerCohort: true,
    },
    {
      id: "full",
      label: "Full agent — all augments including manifest + bash scripts (~15 tools)",
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

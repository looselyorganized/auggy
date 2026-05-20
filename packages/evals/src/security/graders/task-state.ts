import type { Grader } from "../types";

export const taskState: Grader = (spec, input) => {
  if (spec.type !== "task_state") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const ok = input.status === spec.equals;
  return {
    type: "task_state",
    passed: ok,
    reason: ok ? undefined : `expected status "${spec.equals}", got "${input.status}"`,
  };
};

export const responseLength: Grader = (spec, input) => {
  if (spec.type !== "response_length") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const len = input.responseText.length;
  if (spec.min !== undefined && len < spec.min) {
    return {
      type: "response_length",
      passed: false,
      reason: `response too short: ${len} < ${spec.min}`,
    };
  }
  if (spec.max !== undefined && len > spec.max) {
    return {
      type: "response_length",
      passed: false,
      reason: `response too long: ${len} > ${spec.max}`,
    };
  }
  return { type: "response_length", passed: true };
};

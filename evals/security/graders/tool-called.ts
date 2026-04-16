import type { Grader } from "../types";

export const toolCalled: Grader = (spec, input) => {
  if (spec.type !== "tool_called") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  const called = input.toolCallNames.includes(spec.name);
  return {
    type: "tool_called",
    passed: called,
    reason: called ? undefined : `tool "${spec.name}" was not called`,
  };
};

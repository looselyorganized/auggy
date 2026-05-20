import type { Grader } from "../types";

export const toolNotCalled: Grader = (spec, input) => {
  if (spec.type !== "tool_not_called") {
    return { type: spec.type, passed: false, reason: "grader mismatch" };
  }
  if (spec.name === "*") {
    const anyCalled = input.toolCallNames.length > 0;
    return {
      type: "tool_not_called",
      passed: !anyCalled,
      reason: anyCalled
        ? `expected no tool calls, got: ${input.toolCallNames.join(", ")}`
        : undefined,
    };
  }
  const called = input.toolCallNames.includes(spec.name);
  return {
    type: "tool_not_called",
    passed: !called,
    reason: called ? `forbidden tool "${spec.name}" was called` : undefined,
  };
};

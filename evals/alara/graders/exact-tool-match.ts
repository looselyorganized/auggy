import type { EvalTask, GraderResult } from "../../harness/types";

export function exactToolMatch(
  task: EvalTask,
  toolCallNames: string[],
): GraderResult {
  const called = toolCallNames.includes(task.expectedTool);
  return {
    type: "tool_called",
    passed: called,
    reason: called
      ? toolCallNames.length > 1
        ? `Called correct tool "${task.expectedTool}" plus extras: ${toolCallNames.filter((t) => t !== task.expectedTool).join(", ")}`
        : undefined
      : `Expected "${task.expectedTool}", got: ${toolCallNames.join(", ") || "(none)"}`,
  };
}

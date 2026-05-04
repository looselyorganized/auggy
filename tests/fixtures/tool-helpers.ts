import type { Tool, ToolExecuteContext } from "@/types";

/**
 * Cast a Tool's execute as string-returning. Safe for tools that always return
 * a plain string at runtime (i.e. don't yet emit ToolResult.terminate).
 *
 * Use this in tests for augments whose tools have not opted into the
 * ToolResult shape. When Task 2 lands and tools begin emitting
 * ToolResult.terminate, audit calls to this helper to confirm the cast is
 * still safe for that augment's tests.
 */
export function asStringTool<T>(tool: Tool<T>): {
  execute: (input: T, ctx?: ToolExecuteContext) => Promise<string>;
} {
  return tool as unknown as {
    execute: (input: T, ctx?: ToolExecuteContext) => Promise<string>;
  };
}

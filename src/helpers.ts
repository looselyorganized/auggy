import { z } from "zod";
import type { Augment, Tool, ToolCategory, ToolExecuteContext, ToolResult } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineTool<T extends z.ZodType<any, any, any>>(opts: {
  name: string;
  description: string;
  category: ToolCategory;
  input: T;
  execute: (input: z.infer<T>, context?: ToolExecuteContext) => Promise<string | ToolResult>;
}): Tool<z.infer<T>> {
  return {
    name: opts.name,
    description: opts.description,
    category: opts.category,
    input: opts.input,
    inputJsonSchema: z.toJSONSchema(opts.input) as Record<string, unknown>,
    execute: opts.execute,
  };
}

export function defineAugment(opts: Augment): Augment {
  return opts;
}

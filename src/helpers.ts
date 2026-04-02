import type { z } from "zod";
import type {
  Augment,
  Tool,
  ToolCategory,
  ContextBlock,
  TurnState,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineTool<T extends z.ZodType<any, any, any>>(opts: {
  name: string;
  description: string;
  category: ToolCategory;
  input: T;
  execute: (input: z.infer<T>) => Promise<string>;
}): Tool<z.infer<T>> {
  return {
    name: opts.name,
    description: opts.description,
    category: opts.category,
    input: opts.input,
    execute: opts.execute,
  };
}

export function defineAugment(
  opts: Omit<Augment, "context"> & {
    context?: (
      turn: TurnState,
      priorContext?: ContextBlock[],
    ) => Promise<ContextBlock[] | string>;
  },
): Augment {
  const { context: rawContext, ...rest } = opts;

  if (!rawContext) return { ...rest };

  const wrappedContext = async (
    turn: TurnState,
    priorContext?: ContextBlock[],
  ): Promise<ContextBlock[] | string> => {
    const result = await rawContext(turn, priorContext);
    if (typeof result === "string") {
      return [
        {
          source: opts.name,
          content: result,
          placement: "preamble",
          provenance: "augment",
          priority: "normal",
          eviction: "drop",
          origin: "system",
        },
      ];
    }
    return result;
  };

  return { ...rest, context: wrappedContext };
}

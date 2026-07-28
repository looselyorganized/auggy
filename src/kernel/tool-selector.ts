import type { Tool, ToolDefinition } from "../types";

export interface ToolSelectionResult {
  mounted: Tool[];
  definitions: ToolDefinition[];
  withheld: string[];
  phase1Used: boolean;
}

export function selectTools(
  tools: Tool[],
  opts: {
    canExpose?: (toolName: string) => boolean;
  } = {},
): ToolSelectionResult {
  const canExpose = opts.canExpose ?? (() => true);

  const exposed: Tool[] = [];
  const withheld: string[] = [];
  for (const tool of tools) {
    if (canExpose(tool.name)) {
      exposed.push(tool);
    } else {
      withheld.push(tool.name);
    }
  }

  const mounted = exposed;

  const definitions: ToolDefinition[] = mounted.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputJsonSchema ?? {},
  }));

  return {
    mounted,
    definitions,
    withheld,
    phase1Used: false,
  };
}

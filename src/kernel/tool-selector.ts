import type { Tool, TurnState, ToolDefinition } from "../types";

export interface ToolSelectionResult {
  mounted: Tool[];
  definitions: ToolDefinition[];
  withheld: string[];
  phase1Used: boolean;
  selectedCategories?: string[];
}

export function selectTools(
  tools: Tool[],
  _turn: TurnState,
  opts: {
    threshold?: number;
    canExpose?: (toolName: string) => boolean;
  } = {},
): ToolSelectionResult {
  const _threshold = opts.threshold ?? 25;
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

  // v1: mount all if below threshold. Two-phase deferred.
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

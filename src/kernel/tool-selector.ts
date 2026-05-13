import type { Tool, TurnState, ToolDefinition } from "../types";
import type { Tokenizer } from "../tokenizer";

export interface ToolSelectionResult {
  mounted: Tool[];
  definitions: ToolDefinition[];
  withheld: string[];
  phase1Used: boolean;
  selectedCategories?: string[];
  /**
   * Total tokens for the JSON-serialized tool definitions. Populated when
   * a tokenizer is passed via opts; 0 otherwise. Computed once via the
   * stable Tool→serialized-schema cache (see SCHEMA_STRING_CACHE) so the
   * JSON.stringify cost is paid once per Tool, not once per turn.
   */
  schemaTokens: number;
}

// Tool objects are constructed once per agent and never mutated after
// defineTool returns, so we can memoize their JSON serialization for the
// lifetime of the process. Keyed by the stable Tool reference; the
// ToolDefinition derived from it (name + description + inputJsonSchema)
// has identical content turn-after-turn. Without this cache, every turn
// would re-stringify every mounted tool's schema in both the allocator
// AND the trace-emission step.
const SCHEMA_STRING_CACHE = new WeakMap<Tool, string>();

function serializeDefinition(tool: Tool, definition: ToolDefinition): string {
  const cached = SCHEMA_STRING_CACHE.get(tool);
  if (cached !== undefined) return cached;
  const fresh = JSON.stringify(definition);
  SCHEMA_STRING_CACHE.set(tool, fresh);
  return fresh;
}

export function selectTools(
  tools: Tool[],
  _turn: TurnState,
  opts: {
    threshold?: number;
    canExpose?: (toolName: string) => boolean;
    tokenizer?: Tokenizer;
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

  let schemaTokens = 0;
  const definitions: ToolDefinition[] = mounted.map((t) => {
    const def: ToolDefinition = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputJsonSchema ?? {},
    };
    if (opts.tokenizer) {
      schemaTokens += opts.tokenizer.count(serializeDefinition(t, def));
    }
    return def;
  });

  return {
    mounted,
    definitions,
    withheld,
    phase1Used: false,
    schemaTokens,
  };
}

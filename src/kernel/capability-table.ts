import type { Augment, TurnState } from "../types";

const KERNEL_DEFAULT_MAX_TOOL_CALLS = 5;

export interface CapabilityTable {
  canExpose(toolName: string, turn: TurnState): boolean;
  canExecute(
    toolName: string,
    input: unknown,
    turn: TurnState,
  ):
    | { allowed: true }
    | { needsApproval: true; reason: string }
    | { denied: true; reason: string };
  recordToolCall(toolName: string): void;
  resetTurn(): void;
}

export function createCapabilityTable(augments: Augment[]): CapabilityTable {
  const neverExpose = new Set<string>();
  const requiresApproval = new Set<string>();

  // Map tool name → augment name
  const toolOwner = new Map<string, string>();
  // Map augment name → max tool calls (kernel default if unset)
  const augmentLimits = new Map<string, number>();
  // Per-turn counters: augment name → calls this turn
  const augmentCallCounts = new Map<string, number>();
  // Global limit (sum of all augment limits or kernel default * augment count)
  let globalLimit = 0;
  let globalCalls = 0;

  for (const aug of augments) {
    const c = aug.constraints;
    if (c) {
      for (const tool of c.neverExpose ?? []) neverExpose.add(tool);
      for (const tool of c.requiresHumanApproval ?? []) requiresApproval.add(tool);
    }

    const limit = c?.maxToolCallsPerTurn ?? KERNEL_DEFAULT_MAX_TOOL_CALLS;
    augmentLimits.set(aug.name, limit);
    globalLimit += limit;

    for (const tool of aug.tools ?? []) {
      toolOwner.set(tool.name, aug.name);
    }
  }

  // If no augments have tools, use kernel default as global limit
  if (globalLimit === 0) globalLimit = KERNEL_DEFAULT_MAX_TOOL_CALLS;

  return {
    canExpose(toolName: string, _turn: TurnState): boolean {
      return !neverExpose.has(toolName);
    },

    canExecute(toolName: string, _input: unknown, _turn: TurnState) {
      // Global limit
      if (globalCalls >= globalLimit) {
        return {
          denied: true,
          reason: `Global max tool calls per turn (${globalLimit}) exceeded`,
        };
      }

      // Per-augment limit
      const owner = toolOwner.get(toolName);
      if (owner) {
        const limit = augmentLimits.get(owner) ?? KERNEL_DEFAULT_MAX_TOOL_CALLS;
        const count = augmentCallCounts.get(owner) ?? 0;
        if (count >= limit) {
          return {
            denied: true,
            reason: `Max tool calls for augment "${owner}" (${limit}) exceeded`,
          };
        }
      }

      if (requiresApproval.has(toolName)) {
        return {
          needsApproval: true,
          reason: `Tool "${toolName}" requires human approval`,
        };
      }
      return { allowed: true };
    },

    recordToolCall(toolName: string) {
      globalCalls++;
      const owner = toolOwner.get(toolName);
      if (owner) {
        augmentCallCounts.set(owner, (augmentCallCounts.get(owner) ?? 0) + 1);
      }
    },

    resetTurn() {
      globalCalls = 0;
      augmentCallCounts.clear();
    },
  };
}

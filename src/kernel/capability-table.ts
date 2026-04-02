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
}

export function createCapabilityTable(augments: Augment[]): CapabilityTable {
  const neverExpose = new Set<string>();
  const requiresApproval = new Set<string>();
  let maxToolCalls = KERNEL_DEFAULT_MAX_TOOL_CALLS;

  for (const aug of augments) {
    const c = aug.constraints;
    if (!c) continue;
    for (const tool of c.neverExpose ?? []) neverExpose.add(tool);
    for (const tool of c.requiresHumanApproval ?? []) requiresApproval.add(tool);
    if (c.maxToolCallsPerTurn !== undefined) {
      maxToolCalls = Math.min(maxToolCalls, c.maxToolCallsPerTurn);
    }
  }

  return {
    canExpose(toolName: string, _turn: TurnState): boolean {
      return !neverExpose.has(toolName);
    },

    canExecute(toolName: string, _input: unknown, turn: TurnState) {
      if (turn.toolCallsSoFar >= maxToolCalls) {
        return {
          denied: true,
          reason: `Max tool calls per turn (${maxToolCalls}) exceeded`,
        };
      }
      if (requiresApproval.has(toolName)) {
        return {
          needsApproval: true,
          reason: `Tool "${toolName}" requires human approval`,
        };
      }
      return { allowed: true };
    },
  };
}

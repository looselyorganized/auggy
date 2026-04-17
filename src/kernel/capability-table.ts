import type { Augment, PeerIdentity, TrustLevel, TurnState } from "../types";

const KERNEL_DEFAULT_MAX_TOOL_CALLS = 5;

/**
 * Null peer means "no external initiator" — an internal/scheduled trigger
 * fired by the agent's own configuration. Treated as operator for capability
 * checks: if the operator scheduled it, the operator authorized it.
 */
export function effectiveTrustLevel(peer: PeerIdentity | null): TrustLevel {
  return peer?.trustLevel ?? "operator";
}

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
  // Per-trust-level additive constraints. Applied on top of the global sets.
  const perLevelNeverExpose = new Map<TrustLevel, Set<string>>();
  const perLevelRequiresApproval = new Map<TrustLevel, Set<string>>();

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

      if (c.perTrustLevel) {
        for (const [level, rules] of Object.entries(c.perTrustLevel) as [
          TrustLevel,
          { neverExpose?: string[]; requiresHumanApproval?: string[] },
        ][]) {
          if (!rules) continue;
          for (const tool of rules.neverExpose ?? []) {
            let set = perLevelNeverExpose.get(level);
            if (!set) {
              set = new Set<string>();
              perLevelNeverExpose.set(level, set);
            }
            set.add(tool);
          }
          for (const tool of rules.requiresHumanApproval ?? []) {
            let set = perLevelRequiresApproval.get(level);
            if (!set) {
              set = new Set<string>();
              perLevelRequiresApproval.set(level, set);
            }
            set.add(tool);
          }
        }
      }
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
    canExpose(toolName: string, turn: TurnState): boolean {
      // Global block (applies to every trust level, no escape).
      if (neverExpose.has(toolName)) return false;
      // Per-trust-level block (applies only to that level).
      const level = effectiveTrustLevel(turn.peer);
      if (perLevelNeverExpose.get(level)?.has(toolName)) return false;
      return true;
    },

    canExecute(toolName: string, _input: unknown, turn: TurnState) {
      const level = effectiveTrustLevel(turn.peer);

      // Structural denial: tools in neverExpose cannot execute, regardless
      // of whether they appeared in the model's tool list. canExpose is a
      // pre-flight filter that shapes the catalog shown to the model;
      // canExecute must re-enforce the same rule here because the turn
      // loop resolves tool calls against the full tool registry — if the
      // model fabricates a tool name that happens to match a withheld
      // tool, without this check the call would run.
      if (neverExpose.has(toolName)) {
        return {
          denied: true,
          reason: `Tool "${toolName}" is blocked (neverExpose)`,
        };
      }
      if (perLevelNeverExpose.get(level)?.has(toolName)) {
        return {
          denied: true,
          reason: `Tool "${toolName}" is not available at trust level "${level}"`,
        };
      }

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

      // Global approval gate (applies to every trust level).
      if (requiresApproval.has(toolName)) {
        return {
          needsApproval: true,
          reason: `Tool "${toolName}" requires human approval`,
        };
      }

      // Per-trust-level approval gate (applies only to that level).
      if (perLevelRequiresApproval.get(level)?.has(toolName)) {
        return {
          needsApproval: true,
          reason: `Tool "${toolName}" requires human approval for peer trust level "${level}"`,
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

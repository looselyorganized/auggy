import { describe, it, expect } from "vitest";
import { createCapabilityTable } from "@/kernel/capability-table";
import type { Augment, TurnState } from "@/types";

const stubTurn: TurnState = {
  turnId: "t1",
  threadId: "th1",
  trigger: {
    type: "message",
    turnId: "t1",
    timestamp: Date.now(),
    payload: {} as any,
  },
  peer: null,
  toolCallsSoFar: 0,
  turnStartedAt: Date.now(),
  metadata: {},
};

describe("CapabilityTable", () => {
  it("blocks neverExpose tools from exposure", () => {
    const augments: Augment[] = [
      { name: "a", constraints: { neverExpose: ["secret-tool"] } },
    ];
    const table = createCapabilityTable(augments);
    expect(table.canExpose("secret-tool", stubTurn)).toBe(false);
    expect(table.canExpose("other-tool", stubTurn)).toBe(true);
  });

  it("gates requiresHumanApproval tools", () => {
    const augments: Augment[] = [
      { name: "a", constraints: { requiresHumanApproval: ["dangerous"] } },
    ];
    const table = createCapabilityTable(augments);
    const result = table.canExecute("dangerous", {}, stubTurn);
    expect(result).toEqual({
      needsApproval: true,
      reason: 'Tool "dangerous" requires human approval',
    });
  });

  it("allows normal tools", () => {
    const augments: Augment[] = [{ name: "a" }];
    const table = createCapabilityTable(augments);
    expect(table.canExecute("normal-tool", {}, stubTurn)).toEqual({
      allowed: true,
    });
  });

  it("enforces maxToolCallsPerTurn with kernel default of 5", () => {
    const augments: Augment[] = [{ name: "a" }];
    const table = createCapabilityTable(augments);
    const turn = { ...stubTurn, toolCallsSoFar: 5 };
    const result = table.canExecute("any-tool", {}, turn);
    expect(result).toHaveProperty("denied", true);
  });

  it("respects per-augment maxToolCallsPerTurn", () => {
    const augments: Augment[] = [
      { name: "a", constraints: { maxToolCallsPerTurn: 2 } },
    ];
    const table = createCapabilityTable(augments);
    const turn = { ...stubTurn, toolCallsSoFar: 2 };
    const result = table.canExecute("any-tool", {}, turn);
    expect(result).toHaveProperty("denied", true);
  });
});

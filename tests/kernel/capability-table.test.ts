import { describe, it, expect } from "vitest";
import { z } from "zod";
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

function makeTool(name: string) {
  return {
    name,
    description: name,
    category: "meta" as const,
    input: z.object({}),
    execute: async () => "ok",
  };
}

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

  it("enforces per-augment maxToolCallsPerTurn", () => {
    const augments: Augment[] = [
      {
        name: "limited",
        constraints: { maxToolCallsPerTurn: 2 },
        tools: [makeTool("tool-a"), makeTool("tool-b")],
      },
    ];
    const table = createCapabilityTable(augments);

    // First 2 calls allowed
    expect(table.canExecute("tool-a", {}, stubTurn)).toEqual({ allowed: true });
    table.recordToolCall("tool-a");
    expect(table.canExecute("tool-b", {}, stubTurn)).toEqual({ allowed: true });
    table.recordToolCall("tool-b");

    // 3rd call denied
    const result = table.canExecute("tool-a", {}, stubTurn);
    expect(result).toHaveProperty("denied", true);
  });

  it("per-augment limits are independent — one augment's limit doesn't affect another", () => {
    const augments: Augment[] = [
      {
        name: "conservative",
        constraints: { maxToolCallsPerTurn: 1 },
        tools: [makeTool("c-tool")],
      },
      {
        name: "liberal",
        constraints: { maxToolCallsPerTurn: 10 },
        tools: [makeTool("l-tool")],
      },
    ];
    const table = createCapabilityTable(augments);

    // Conservative augment exhausted after 1 call
    table.recordToolCall("c-tool");
    expect(table.canExecute("c-tool", {}, stubTurn)).toHaveProperty("denied", true);

    // Liberal augment still has 10 calls available
    expect(table.canExecute("l-tool", {}, stubTurn)).toEqual({ allowed: true });
  });

  it("resetTurn clears all counters", () => {
    const augments: Augment[] = [
      {
        name: "a",
        constraints: { maxToolCallsPerTurn: 1 },
        tools: [makeTool("tool-a")],
      },
    ];
    const table = createCapabilityTable(augments);

    table.recordToolCall("tool-a");
    expect(table.canExecute("tool-a", {}, stubTurn)).toHaveProperty("denied", true);

    table.resetTurn();
    expect(table.canExecute("tool-a", {}, stubTurn)).toEqual({ allowed: true });
  });
});

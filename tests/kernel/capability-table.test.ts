import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createCapabilityTable, effectiveTrustLevel } from "@/kernel/capability-table";
import type { Augment, TrustLevel, TurnState } from "@/types";

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

function turnWithTrust(level: TrustLevel): TurnState {
  return {
    ...stubTurn,
    peer: {
      id: `peer-${level}`,
      kind: "human",
      trustLevel: level,
      sourceAugment: "test-transport",
    },
  };
}

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

describe("CapabilityTable — trust-aware", () => {
  it("effectiveTrustLevel maps null peer to operator", () => {
    expect(effectiveTrustLevel(null)).toBe("operator");
    expect(
      effectiveTrustLevel({
        id: "x",
        kind: "human",
        trustLevel: "untrusted",
        sourceAugment: "t",
      }),
    ).toBe("untrusted");
  });

  it("perTrustLevel.neverExpose hides a tool from one level only", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          perTrustLevel: {
            untrusted: { neverExpose: ["fs_remove"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);

    expect(table.canExpose("fs_remove", turnWithTrust("untrusted"))).toBe(false);
    expect(table.canExpose("fs_remove", turnWithTrust("authenticated"))).toBe(true);
    expect(table.canExpose("fs_remove", turnWithTrust("facility"))).toBe(true);
    expect(table.canExpose("fs_remove", turnWithTrust("operator"))).toBe(true);
  });

  it("null peer sees perTrustLevel tools gated to operator (treated as operator)", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          perTrustLevel: {
            untrusted: { neverExpose: ["fs_remove"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);
    // stubTurn has peer: null → should map to operator → fs_remove visible
    expect(table.canExpose("fs_remove", stubTurn)).toBe(true);
  });

  it("top-level neverExpose wins even when perTrustLevel doesn't mention the tool", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          neverExpose: ["fs_remove"], // global block
          perTrustLevel: {
            operator: { neverExpose: [] }, // empty per-level does not override global
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);
    expect(table.canExpose("fs_remove", turnWithTrust("operator"))).toBe(false);
    expect(table.canExpose("fs_remove", turnWithTrust("untrusted"))).toBe(false);
  });

  it("perTrustLevel blocks stack additively with top-level neverExpose", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          neverExpose: ["fs_globally_blocked"],
          perTrustLevel: {
            untrusted: { neverExpose: ["fs_write", "fs_mkdir", "fs_remove"] },
            authenticated: { neverExpose: ["fs_remove"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);

    // Global block for everyone
    expect(table.canExpose("fs_globally_blocked", turnWithTrust("operator"))).toBe(false);
    expect(table.canExpose("fs_globally_blocked", turnWithTrust("untrusted"))).toBe(false);

    // Untrusted loses all three
    expect(table.canExpose("fs_write", turnWithTrust("untrusted"))).toBe(false);
    expect(table.canExpose("fs_mkdir", turnWithTrust("untrusted"))).toBe(false);
    expect(table.canExpose("fs_remove", turnWithTrust("untrusted"))).toBe(false);

    // Authenticated loses only fs_remove
    expect(table.canExpose("fs_write", turnWithTrust("authenticated"))).toBe(true);
    expect(table.canExpose("fs_mkdir", turnWithTrust("authenticated"))).toBe(true);
    expect(table.canExpose("fs_remove", turnWithTrust("authenticated"))).toBe(false);

    // Operator keeps everything (except the global block)
    expect(table.canExpose("fs_write", turnWithTrust("operator"))).toBe(true);
    expect(table.canExpose("fs_mkdir", turnWithTrust("operator"))).toBe(true);
    expect(table.canExpose("fs_remove", turnWithTrust("operator"))).toBe(true);
  });

  it("perTrustLevel.requiresHumanApproval returns needsApproval for that level only", () => {
    const augments: Augment[] = [
      {
        name: "danger",
        constraints: {
          perTrustLevel: {
            untrusted: { requiresHumanApproval: ["memory_write"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);

    const untrustedResult = table.canExecute(
      "memory_write",
      {},
      turnWithTrust("untrusted"),
    );
    expect(untrustedResult).toHaveProperty("needsApproval", true);

    expect(
      table.canExecute("memory_write", {}, turnWithTrust("authenticated")),
    ).toEqual({ allowed: true });
    expect(
      table.canExecute("memory_write", {}, turnWithTrust("operator")),
    ).toEqual({ allowed: true });
  });

  it("tools without any perTrustLevel entry remain visible to every level", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          perTrustLevel: {
            untrusted: { neverExpose: ["fs_remove"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);

    // fs_read is not mentioned anywhere — every level sees it
    for (const level of ["untrusted", "authenticated", "facility", "operator"] as const) {
      expect(table.canExpose("fs_read", turnWithTrust(level))).toBe(true);
    }
  });

  // Codex review P1: canExecute must re-enforce neverExpose because the
  // turn loop resolves tool calls against the full registry, not the
  // filtered tool list. A fabricated tool name that matches a withheld
  // tool would otherwise run.
  it("canExecute denies tools listed in global neverExpose (fabricated-call defense)", () => {
    const augments: Augment[] = [
      { name: "a", constraints: { neverExpose: ["secret_tool"] } },
    ];
    const table = createCapabilityTable(augments);

    const result = table.canExecute("secret_tool", {}, turnWithTrust("operator"));
    expect(result).toHaveProperty("denied", true);
    if ("denied" in result) {
      expect(result.reason).toMatch(/neverExpose/i);
    }
  });

  it("canExecute denies per-trust-level neverExpose tools even if the model calls them", () => {
    const augments: Augment[] = [
      {
        name: "fs",
        constraints: {
          perTrustLevel: {
            untrusted: { neverExpose: ["fs_write", "fs_remove"] },
          },
        },
      },
    ];
    const table = createCapabilityTable(augments);

    // Untrusted peer fabricates a call to fs_write (it wasn't in their
    // tool list via canExpose, but the model emitted the name anyway).
    const untrustedResult = table.canExecute(
      "fs_write",
      {},
      turnWithTrust("untrusted"),
    );
    expect(untrustedResult).toHaveProperty("denied", true);

    // Authenticated peer — tool is not in their neverExpose list — allowed.
    const authResult = table.canExecute(
      "fs_write",
      {},
      turnWithTrust("authenticated"),
    );
    expect(authResult).toEqual({ allowed: true });
  });
});

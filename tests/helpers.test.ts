import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineAugment, defineTool } from "@/helpers";
import type { ContextBlock, TurnState } from "@/types";

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

describe("defineTool", () => {
  it("creates a typed tool from a Zod schema", async () => {
    const tool = defineTool({
      name: "greet",
      description: "Greet someone",
      category: "meta",
      input: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    expect(tool.name).toBe("greet");
    expect(tool.category).toBe("meta");
    const result = await tool.execute({ name: "Alice" });
    expect(result).toBe("Hello, Alice!");
  });
});

describe("defineAugment", () => {
  it("creates an augment with defaults", () => {
    const aug = defineAugment({ name: "test" });
    expect(aug.name).toBe("test");
  });

  it("wraps string context() return in a ContextBlock", async () => {
    const aug = defineAugment({
      name: "notes",
      context: async () => "Some notes",
    });

    const blocks = await aug.context!(stubTurn, undefined);

    expect(Array.isArray(blocks)).toBe(true);
    const arr = blocks as ContextBlock[];
    expect(arr).toHaveLength(1);
    expect(arr[0]!.source).toBe("notes");
    expect(arr[0]!.content).toBe("Some notes");
    expect(arr[0]!.placement).toBe("preamble");
    expect(arr[0]!.priority).toBe("normal");
    expect(arr[0]!.eviction).toBe("drop");
    expect(arr[0]!.origin).toBe("system");
  });

  it("passes through ContextBlock[] return unchanged", async () => {
    const block: ContextBlock = {
      source: "custom",
      content: "Custom content",
      placement: "system",
      provenance: "identity",
      priority: "required",
      eviction: "never",
      origin: "operator",
    };

    const aug = defineAugment({
      name: "custom",
      context: async () => [block],
    });

    const result = await aug.context!(stubTurn, undefined);
    expect(result).toEqual([block]);
  });
});

import { describe, it, expect } from "bun:test";
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
  it("creates an augment and passes through all fields", () => {
    const aug = defineAugment({ name: "test" });
    expect(aug.name).toBe("test");
  });

  it("preserves string-returning context (kernel handles wrapping)", async () => {
    const aug = defineAugment({
      name: "notes",
      context: async () => "Some notes",
    });

    const result = await aug.context!(stubTurn, undefined);
    // defineAugment passes through — the string is returned as-is
    expect(result).toBe("Some notes");
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

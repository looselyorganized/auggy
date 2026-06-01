import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { selectTools } from "@/kernel/tool-selector";
import type { Tool, TurnState } from "@/types";

function makeTool(name: string, category: string): Tool {
  return {
    name,
    description: `Tool: ${name}`,
    category,
    input: z.object({}),
    execute: async () => "ok",
  };
}

const stubTurn: TurnState = {
  turnId: "t1",
  threadId: "th1",
  trigger: {
    type: "message",
    turnId: "t1",
    timestamp: Date.now(),
    payload: {},
  },
  peer: null,
  toolCallsSoFar: 0,
  turnStartedAt: Date.now(),
  metadata: {},
};

describe("selectTools", () => {
  it("mounts all tools when count <= threshold", () => {
    const tools = [makeTool("a", "meta"), makeTool("b", "search")];
    const result = selectTools(tools, stubTurn, { threshold: 25 });
    expect(result.mounted).toHaveLength(2);
    expect(result.phase1Used).toBe(false);
  });

  it("converts tools to ToolDefinition format", () => {
    const tools = [makeTool("greet", "meta")];
    const result = selectTools(tools, stubTurn, { threshold: 25 });
    expect(result.definitions[0]!.name).toBe("greet");
    expect(result.definitions[0]!.description).toBe("Tool: greet");
    expect(result.definitions[0]!.inputSchema).toBeDefined();
  });

  it("excludes tools filtered by canExpose", () => {
    const tools = [makeTool("a", "meta"), makeTool("secret", "meta")];
    const canExpose = (name: string) => name !== "secret";
    const result = selectTools(tools, stubTurn, {
      threshold: 25,
      canExpose,
    });
    expect(result.mounted).toHaveLength(1);
    expect(result.mounted[0]!.name).toBe("a");
    expect(result.withheld).toContain("secret");
  });
});

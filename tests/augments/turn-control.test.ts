import { describe, it, expect } from "bun:test";
import { turnControl } from "@/augments/turn-control";
import type { ToolResult } from "@/types";

describe("turnControl augment", () => {
  it("exposes a single request_input tool", () => {
    const aug = turnControl();
    expect(aug.name).toBe("turnControl");
    expect(aug.tools).toHaveLength(1);
    expect(aug.tools?.[0]?.name).toBe("request_input");
  });

  it("request_input returns a ToolResult with terminate=input-required", async () => {
    const aug = turnControl();
    const tool = aug.tools![0]!;
    const out = (await tool.execute({ prompt: "What is your name?" })) as ToolResult;
    expect(typeof out).toBe("object");
    expect(out.content).toBe("What is your name?");
    expect(out.terminate?.status).toBe("input-required");
    expect(out.terminate?.message).toBe("What is your name?");
  });

  it("validates: prompt must be non-empty", () => {
    const aug = turnControl();
    const tool = aug.tools![0]!;
    const result = tool.input.safeParse({ prompt: "" });
    expect(result.success).toBe(false);
  });

  it("accepts optional reason argument", () => {
    const aug = turnControl();
    const tool = aug.tools![0]!;
    const result = tool.input.safeParse({ prompt: "Q?", reason: "needs date" });
    expect(result.success).toBe(true);
  });

  it("uses opts.requestInputDescription override when provided", () => {
    const aug = turnControl({ requestInputDescription: "CUSTOM DESCRIPTION" });
    expect(aug.tools![0]!.description).toBe("CUSTOM DESCRIPTION");
  });

  it("does not surface reason to the user (reason stays internal)", async () => {
    const aug = turnControl();
    const tool = aug.tools![0]!;
    const out = (await tool.execute({
      prompt: "Q?",
      reason: "internal-note-marker-xyz",
    })) as ToolResult;
    expect(out.content).toBe("Q?");
    expect(out.terminate?.message).toBe("Q?");
    expect(JSON.stringify(out)).not.toContain("internal-note-marker-xyz");
  });
});

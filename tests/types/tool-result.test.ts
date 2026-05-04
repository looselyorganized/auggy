import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineTool } from "@/helpers";
import type { ToolResult } from "@/types";

describe("ToolResult", () => {
  it("accepts a tool whose execute returns a string (back-compat)", async () => {
    const t = defineTool({
      name: "string-returner",
      description: "returns plain string",
      category: "meta",
      input: z.object({}),
      execute: async () => "plain string",
    });
    const out = await t.execute({});
    expect(typeof out).toBe("string");
    expect(out).toBe("plain string");
  });

  it("accepts a tool whose execute returns a ToolResult", async () => {
    const t = defineTool({
      name: "result-returner",
      description: "returns ToolResult",
      category: "meta",
      input: z.object({}),
      execute: async (): Promise<ToolResult> => ({
        content: "hello",
        terminate: { status: "input-required", message: "What is your name?" },
      }),
    });
    const out = await t.execute({});
    expect(typeof out).toBe("object");
    if (typeof out === "string") throw new Error("expected object");
    expect(out.content).toBe("hello");
    expect(out.terminate?.status).toBe("input-required");
  });

  it("ToolResult.terminate.status is narrowed to input-required | completed", () => {
    const r: ToolResult = { content: "x", terminate: { status: "completed" } };
    expect(r.terminate?.status).toBe("completed");
  });
});

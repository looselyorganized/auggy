import { describe, it, expect } from "vitest";
import { createContextAllocator } from "@/kernel/context-allocator";
import { createTokenizer } from "@/tokenizer";
import type { ContextBlock, Message } from "@/types";

const tokenizer = createTokenizer();

function block(
  source: string,
  content: string,
  priority: ContextBlock["priority"] = "normal",
  eviction: ContextBlock["eviction"] = "drop",
): ContextBlock {
  return {
    source,
    content,
    placement: "preamble",
    provenance: "augment",
    priority,
    eviction,
    origin: "system",
  };
}

function msg(content: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    timestamp: Date.now(),
    tokenCount: tokenizer.count(content),
  };
}

describe("ContextAllocator", () => {
  it("assembles blocks by priority — required first", () => {
    const allocator = createContextAllocator({
      maxTokens: 1000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "System preamble",
    });

    const blocks = [
      block("memory", "M".repeat(100), "low"),
      block("identity", "I".repeat(100), "required"),
    ];

    const prompt = allocator.assemble(blocks, [], []);
    expect(
      prompt.contextBlocks.some((b) => b.includes("I".repeat(100))),
    ).toBe(true);
  });

  it("evicts low-priority blocks when over budget", () => {
    const allocator = createContextAllocator({
      maxTokens: 200,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks = [
      block("identity", "I".repeat(200), "required", "never"),
      block("memory", "M".repeat(200), "evictable", "drop"),
    ];

    const prompt = allocator.assemble(blocks, [], []);
    expect(prompt.evictions.some((e) => e.source === "memory")).toBe(true);
  });

  it("filters pipeline-only blocks from model prompt", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [
      { ...block("public", "Public content"), visibility: "public" },
      {
        ...block("hidden", "Hidden from model"),
        visibility: "pipeline-only",
      },
    ];

    const prompt = allocator.assemble(blocks, [], []);
    expect(
      prompt.contextBlocks.some((b) => b.includes("Public content")),
    ).toBe(true);
    expect(
      prompt.contextBlocks.some((b) => b.includes("Hidden from model")),
    ).toBe(false);
  });

  it("marks peer-derived blocks with [PEER-DERIVED]", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [
      { ...block("memory", "Visitor said X"), origin: "peer-derived" },
    ];

    const prompt = allocator.assemble(blocks, [], []);
    expect(
      prompt.contextBlocks.some((b) => b.includes("[PEER-DERIVED]")),
    ).toBe(true);
  });

  it("includes history within its budget slice", () => {
    const allocator = createContextAllocator({
      maxTokens: 1000,
      historyPercent: 50,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const history = [msg("A".repeat(400)), msg("B".repeat(400))];

    const prompt = allocator.assemble([], history, []);
    expect(prompt.messages).toHaveLength(2);
  });

  it("places assistant-preamble blocks in assistantPreamble array", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [
      {
        ...block("primer", "Start your response with a greeting"),
        placement: "assistant-preamble",
      },
      block("context", "Some regular context"),
    ];

    const prompt = allocator.assemble(blocks, [], []);
    // assistant-preamble should NOT be in contextBlocks
    expect(
      prompt.contextBlocks.some((b) => b.includes("Start your response")),
    ).toBe(false);
    // It should be in assistantPreamble
    expect(prompt.assistantPreamble).toBeDefined();
    expect(prompt.assistantPreamble!.length).toBe(1);
    expect(prompt.assistantPreamble![0]).toContain("Start your response");
    // Regular context should still be in contextBlocks
    expect(
      prompt.contextBlocks.some((b) => b.includes("Some regular context")),
    ).toBe(true);
  });

  it("tracks tool schema tokens in totalTokens", () => {
    const allocator = createContextAllocator({
      maxTokens: 1000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const toolDefs = [
      {
        name: "big_tool",
        description: "A".repeat(200),
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const prompt = allocator.assemble([], [], toolDefs);
    // totalTokens should include tool schema tokens
    expect(prompt.totalTokens).toBeGreaterThan(0);
  });

  it("reduces context budget when tool schemas are large", () => {
    // maxTokens=300, history=40%(120), toolBudget=10%(30), preamble~1
    // Normal context budget: 300 - 120 - 30 - 1 = 149
    // A block of ~120 tokens would fit in 149 budget.
    //
    // But tool schema is ~250 tokens (well over the 30 budget).
    // Effective context budget: 300 - 120 - 250 - 1 = -71 → clamped to 0
    // So the block gets evicted.
    const allocator = createContextAllocator({
      maxTokens: 300,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const toolDefs = [
      {
        name: "huge_tool",
        description: "X".repeat(1000), // ~250+ tokens when serialized
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    ];

    const blocks = [block("extra", "E".repeat(100), "evictable")];

    const prompt = allocator.assemble(blocks, [], toolDefs);
    expect(prompt.evictions.some((e) => e.source === "extra")).toBe(true);
  });
});

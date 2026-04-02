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
});

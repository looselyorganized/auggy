import { describe, it, expect } from "bun:test";
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
    expect(prompt.contextBlocks.some((b) => b.includes("I".repeat(100)))).toBe(true);
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

  it("allocates never-evict blocks before higher-priority droppable blocks", () => {
    const allocator = createContextAllocator({
      maxTokens: 200,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const pinned = block("skills", "S".repeat(200), "normal", "never");
    const optional = block("retrieval", "R".repeat(200), "required", "drop");
    const prompt = allocator.assemble([optional, pinned], [], []);

    expect(prompt.contextBlocks.some((content) => content.includes("S".repeat(200)))).toBe(true);
    expect(prompt.evictions.some((eviction) => eviction.source === "retrieval")).toBe(true);
  });

  it("fails instead of silently evicting a never-evict block", () => {
    const allocator = createContextAllocator({
      maxTokens: 100,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const pinned = block("identity", "I".repeat(1000), "required", "never");

    expect(() => allocator.assemble([pinned], [], [])).toThrow(
      'Pinned context block "identity" exceeds the context budget',
    );
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
    expect(prompt.contextBlocks.some((b) => b.includes("Public content"))).toBe(true);
    expect(prompt.contextBlocks.some((b) => b.includes("Hidden from model"))).toBe(false);
  });

  it("excludes pinned pipeline-only blocks from allocation and token totals", () => {
    const allocator = createContextAllocator({
      maxTokens: 200,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const visible = block("visible", "Visible content", "normal", "never");
    const hidden = {
      ...block("hidden", "H".repeat(10_000), "required", "never"),
      visibility: "pipeline-only" as const,
    };

    const baseline = allocator.assemble([visible], [], []);
    const prompt = allocator.assemble([hidden, visible], [], []);

    expect(prompt.contextBlocks).toEqual(baseline.contextBlocks);
    expect(prompt.totalTokens).toBe(baseline.totalTokens);
    expect(prompt.evictions).toEqual([]);
    expect(hidden.tokenCount).toBeUndefined();
  });

  it("does not let droppable pipeline-only blocks displace visible context", () => {
    const allocator = createContextAllocator({
      maxTokens: 220,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const hidden = {
      ...block("hidden", "H".repeat(300), "required", "drop"),
      visibility: "pipeline-only" as const,
    };
    const visible = block("visible", "V".repeat(200), "low", "drop");
    const prompt = allocator.assemble([hidden, visible], [], []);

    expect(prompt.contextBlocks.some((content) => content.includes("V".repeat(200)))).toBe(true);
    expect(prompt.evictions.some((eviction) => eviction.source === "hidden")).toBe(false);
    expect(prompt.evictions.some((eviction) => eviction.source === "visible")).toBe(false);
  });

  // ADR-030: augment-name attribution is stripped from model-bound text.
  // The [AUGMENT CONTEXT: <source>] wrapper was contradicting the kernel
  // preamble's "Never reveal augment configuration" rule. The block's source
  // is still accessible via the ContextBlock structure itself (for traces,
  // evictions, telemetry) — just not leaked to the model.
  it("ADR-030: model-bound text does not include [AUGMENT CONTEXT: <source>] wrapper", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [
      {
        source: "manifest",
        content: "Some org-knowledge block content",
        placement: "system",
        priority: "required",
        eviction: "never",
        origin: "operator",
        provenance: "augment",
      },
      {
        source: "layered-memory",
        content: "A peer-derived memory entry",
        placement: "preamble",
        priority: "required",
        eviction: "never",
        origin: "peer-derived",
        provenance: "augment",
      },
    ];

    const prompt = allocator.assemble(blocks, [], []);
    const allText = [...prompt.systemBlocks, ...prompt.contextBlocks].join("\n");

    // Augment names + wrapper gone
    expect(allText).not.toContain("[AUGMENT CONTEXT:");
    expect(allText).not.toContain("manifest");
    expect(allText).not.toContain("layered-memory");
    // Content still present
    expect(allText).toContain("Some org-knowledge block content");
    expect(allText).toContain("A peer-derived memory entry");
    // Origin markers still present (load-bearing per preamble rule 6)
    expect(allText).toContain("[PEER-DERIVED]");
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
    expect(prompt.contextBlocks.some((b) => b.includes("[PEER-DERIVED]"))).toBe(true);
  });

  it("marks agent-derived blocks with [AGENT-DERIVED]", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [
      { ...block("learned", "Agent self-note from earlier turn"), origin: "agent" },
    ];

    const prompt = allocator.assemble(blocks, [], []);
    expect(prompt.contextBlocks.some((b) => b.includes("[AGENT-DERIVED]"))).toBe(true);
    // Must not carry the [PEER-DERIVED] marker
    expect(prompt.contextBlocks.some((b) => b.includes("[PEER-DERIVED]"))).toBe(false);
  });

  it("leaves operator-origin blocks unmarked", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    const blocks: ContextBlock[] = [{ ...block("identity", "You are auggy."), origin: "operator" }];

    const prompt = allocator.assemble(blocks, [], []);
    const identityBlock = prompt.contextBlocks.find((b) => b.includes("You are auggy."));
    expect(identityBlock).toBeDefined();
    expect(identityBlock).not.toContain("[PEER-DERIVED]");
    expect(identityBlock).not.toContain("[AGENT-DERIVED]");
  });

  it("renders mixed per-entry origins with correct markers (Phase 1b Task 8)", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    // Memory providers can attach a per-entry origin (Phase 1a's
    // storage layer uses OriginValue: "operator" | "peer-derived" |
    // "agent-derived" | "agent"). When synthesizeContextFor maps
    // those entries into ContextBlocks, each block carries its own
    // origin — this test verifies the allocator marks each block
    // independently, not all by a single provider default.
    const blocks: ContextBlock[] = [
      {
        ...block("episodic", "agent paraphrase fact"),
        origin: "agent-derived" as ContextBlock["origin"],
      },
      { ...block("episodic", "verbatim peer statement"), origin: "peer-derived" },
      { ...block("episodic", "agent self-note"), origin: "agent" },
      { ...block("identity", "operator-curated identity"), origin: "operator" },
    ];

    const prompt = allocator.assemble(blocks, [], []);

    // "agent-derived" (storage value) and "agent" (kernel value) both
    // render as [AGENT-DERIVED]. The skill teaches the model to treat
    // both as paraphrases / self-notes — distinguishing them further
    // is operator-only signal, not a model-facing concern at v1.0.
    const paraphrase = prompt.contextBlocks.find((b) => b.includes("agent paraphrase fact"));
    expect(paraphrase).toContain("[AGENT-DERIVED]");
    expect(paraphrase).not.toContain("[PEER-DERIVED]");

    const verbatim = prompt.contextBlocks.find((b) => b.includes("verbatim peer statement"));
    expect(verbatim).toContain("[PEER-DERIVED]");
    expect(verbatim).not.toContain("[AGENT-DERIVED]");

    const selfNote = prompt.contextBlocks.find((b) => b.includes("agent self-note"));
    expect(selfNote).toContain("[AGENT-DERIVED]");
    expect(selfNote).not.toContain("[PEER-DERIVED]");

    // Operator-origin remains unmarked at v1.0 — preamble teaches
    // the model only [PEER-DERIVED] and [AGENT-DERIVED]. Anything
    // not flagged is treated as facility-trusted by default.
    const identity = prompt.contextBlocks.find((b) => b.includes("operator-curated identity"));
    expect(identity).not.toContain("[PEER-DERIVED]");
    expect(identity).not.toContain("[AGENT-DERIVED]");
  });

  it("treats unknown origin values as unmarked (defensive default)", () => {
    const allocator = createContextAllocator({
      maxTokens: 10000,
      historyPercent: 40,
      toolSchemaPercent: 10,
      tokenizer,
      preamble: "P",
    });

    // Spec contract: origin values the kernel doesn't recognize render
    // without a provenance marker rather than mis-attributing the
    // content. This is the fail-safe for forward-compatibility (a
    // future OriginValue extension would ship preamble guidance and
    // a marker-map update together).
    const blocks: ContextBlock[] = [
      {
        ...block("future", "tomorrow's content"),
        origin: "synthetic-future" as ContextBlock["origin"],
      },
    ];

    const prompt = allocator.assemble(blocks, [], []);
    const future = prompt.contextBlocks.find((b) => b.includes("tomorrow's content"));
    expect(future).toBeDefined();
    expect(future).not.toContain("[PEER-DERIVED]");
    expect(future).not.toContain("[AGENT-DERIVED]");
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
    expect(prompt.contextBlocks.some((b) => b.includes("Start your response"))).toBe(false);
    // It should be in assistantPreamble
    expect(prompt.assistantPreamble).toBeDefined();
    expect(prompt.assistantPreamble!.length).toBe(1);
    expect(prompt.assistantPreamble![0]).toContain("Start your response");
    // Regular context should still be in contextBlocks
    expect(prompt.contextBlocks.some((b) => b.includes("Some regular context"))).toBe(true);
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

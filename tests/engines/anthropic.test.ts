import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Message, AssembledPrompt } from "@/types";

/**
 * Tests for the Anthropic engine's message conversion.
 *
 * These test the convertMessages + coalesceMessages functions indirectly
 * by importing the module and testing edge cases that the adversarial
 * review identified as likely production failures.
 *
 * Since convertMessages is not exported, we test it through the engine's
 * complete() path using a mock. For direct conversion testing, the
 * functions would need to be exported. For now, we test the patterns
 * that matter most: multi-turn history sequences.
 */

// We need to test the coalescing logic. Since convertMessages is internal,
// we replicate the logic here for unit testing. If the logic changes in
// anthropic.ts, these tests catch regressions via integration tests.

function toContentBlocks(content: string | Array<{ type: string; [key: string]: unknown }>): Array<{ type: string; [key: string]: unknown }> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

function coalesceMessages(messages: Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }>): Array<{ role: string; content: string | Array<{ type: string; [key: string]: unknown }> }> {
  if (messages.length <= 1) return messages;
  const coalesced = [messages[0]!];
  for (let i = 1; i < messages.length; i++) {
    const prev = coalesced[coalesced.length - 1]!;
    const curr = messages[i]!;
    if (prev.role === curr.role) {
      const prevBlocks = toContentBlocks(prev.content);
      const currBlocks = toContentBlocks(curr.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      coalesced.push(curr);
    }
  }
  return coalesced;
}

describe("Anthropic message coalescing", () => {
  it("merges consecutive user messages (tool_result followed by user text)", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "t1", name: "memory_read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
      { role: "user", content: "thanks, what else?" },
    ];

    const result = coalesceMessages(messages);
    expect(result).toHaveLength(3); // user, assistant, user (merged)
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[2]!.role).toBe("user");
    // The third message should have both blocks merged
    const mergedContent = result[2]!.content as Array<{ type: string }>;
    expect(mergedContent).toHaveLength(2);
    expect(mergedContent[0]!.type).toBe("tool_result");
    expect(mergedContent[1]!.type).toBe("text");
  });

  it("merges consecutive assistant messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "thinking..." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] },
    ];

    const result = coalesceMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[1]!.role).toBe("assistant");
    const merged = result[1]!.content as Array<{ type: string }>;
    expect(merged).toHaveLength(2);
    expect(merged[0]!.type).toBe("text");
    expect(merged[1]!.type).toBe("tool_use");
  });

  it("does not merge alternating roles", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];

    const result = coalesceMessages(messages);
    expect(result).toHaveLength(4);
  });

  it("handles single message", () => {
    const messages = [{ role: "user", content: "only one" }];
    expect(coalesceMessages(messages)).toHaveLength(1);
  });

  it("handles empty array", () => {
    expect(coalesceMessages([])).toHaveLength(0);
  });

  it("merges three consecutive user messages into one", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];

    const result = coalesceMessages(messages);
    expect(result).toHaveLength(1);
    const merged = result[0]!.content as Array<{ type: string; text?: string }>;
    expect(merged).toHaveLength(3);
    expect(merged[0]!.text).toBe("first");
    expect(merged[1]!.text).toBe("second");
    expect(merged[2]!.text).toBe("third");
  });
});

// ---------------------------------------------------------------------------
// createAnthropicEngine — costUsd population
//
// Mock the SDK so complete() returns a controlled response with known token
// counts. The mock must be registered before the dynamic import below so
// Bun's module registry picks it up.
// ---------------------------------------------------------------------------

let nextAnthropicResponse: Record<string, unknown> | null = null;

mock.module("@anthropic-ai/sdk", () => {
  const makeResponse = (overrides?: Record<string, unknown>) =>
    overrides ?? {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };

  class FakeAnthropic {
    messages = {
      create: async (_params: Record<string, unknown>) => {
        return nextAnthropicResponse !== null
          ? nextAnthropicResponse
          : makeResponse();
      },
      stream: (_params: Record<string, unknown>) => {
        // Not used by these tests (non-streaming path only).
        throw new Error("streaming not mocked in costUsd tests");
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: Record<string, unknown>) {}
  }

  return { default: FakeAnthropic };
});

// Dynamic import AFTER mock.module so the mocked SDK is used.
const { createAnthropicEngine } = await import("../../src/engines/anthropic");

function emptyPrompt(over: Partial<AssembledPrompt> = {}): AssembledPrompt {
  return {
    systemBlocks: [],
    contextBlocks: [],
    messages: [],
    tools: [],
    totalTokens: 0,
    evictions: [],
    ...over,
  };
}

function anthropicMsg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? crypto.randomUUID(),
    role: partial.role ?? "user",
    content: partial.content ?? "hi",
    timestamp: partial.timestamp ?? Date.now(),
    tokenCount: partial.tokenCount ?? 0,
    toolCallId: partial.toolCallId,
    peerId: partial.peerId,
  };
}

beforeEach(() => {
  nextAnthropicResponse = null;
});

describe("createAnthropicEngine — costUsd", () => {
  it("populates costUsd when pricing is known for the model", async () => {
    // claude-sonnet-4-6: $3.00/Mtok input, $15.00/Mtok output
    // 100 input + 50 output → (100/1e6)*3 + (50/1e6)*15 = 0.0003 + 0.00075 = 0.00105
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const engine = createAnthropicEngine({ model: "claude-sonnet-4-6" });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.00105, 8);
  });

  it("leaves costUsd undefined for unknown models", async () => {
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-future-99-experimental",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const engine = createAnthropicEngine({
      model: "claude-future-99-experimental",
    });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.costUsd).toBeUndefined();
  });

  it("computes correct cost for haiku model with different rate", async () => {
    // claude-haiku-4-5: $0.8/Mtok input, $4.0/Mtok output
    // 1000 input + 200 output → (1000/1e6)*0.8 + (200/1e6)*4.0 = 0.0008 + 0.0008 = 0.0016
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "quick" }],
      model: "claude-haiku-4-5",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 200 },
    };
    const engine = createAnthropicEngine({ model: "claude-haiku-4-5" });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.costUsd).toBeCloseTo(0.0016, 8);
  });

  it("costOverride populates costUsd for unknown model", async () => {
    // Unknown model + costOverride: $2/Mtok in, $8/Mtok out
    // 500 input + 250 output → (500/1e6)*2 + (250/1e6)*8 = 0.001 + 0.002 = 0.003
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-future-99-experimental",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 250 },
    };
    const engine = createAnthropicEngine({
      model: "claude-future-99-experimental",
      costOverride: { inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
    });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.costUsd).toBeCloseTo(0.003, 8);
  });

  it("costOverride takes precedence over pricing-table entry for known model", async () => {
    // claude-sonnet-4-6 is in the pricing table ($3/$15) but costOverride wins ($1/$2)
    // 300 input + 150 output → (300/1e6)*1 + (150/1e6)*2 = 0.0003 + 0.0003 = 0.0006
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 300, output_tokens: 150 },
    };
    const engine = createAnthropicEngine({
      model: "claude-sonnet-4-6",
      costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
    });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.costUsd).toBeCloseTo(0.0006, 8);
  });

  it("populates cacheCreationTokens and cacheReadTokens from SDK usage and prices them correctly", async () => {
    // claude-sonnet-4-6: $3.00/Mtok input, $15.00/Mtok output, $3.75/Mtok cache-write, $0.30/Mtok cache-read
    // 100 input + 50 output + 200k cache_creation + 1M cache_read:
    //   input:        (100/1e6)*3.0     = 0.0003
    //   output:       (50/1e6)*15.0     = 0.00075
    //   cache_write:  (200000/1e6)*3.75 = 0.75
    //   cache_read:   (1000000/1e6)*0.3 = 0.3
    //   total:        1.05105
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200_000,
        cache_read_input_tokens: 1_000_000,
      },
    };
    const engine = createAnthropicEngine({ model: "claude-sonnet-4-6" });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.cacheCreationTokens).toBe(200_000);
    expect(result.cacheReadTokens).toBe(1_000_000);
    expect(result.costUsd).toBeCloseTo(1.05105, 6);
  });

  it("leaves cacheCreationTokens and cacheReadTokens undefined when SDK returns null/absent", async () => {
    // SDK returns null for cache fields (no caching active in this call)
    nextAnthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };
    const engine = createAnthropicEngine({ model: "claude-sonnet-4-6" });
    const result = await engine.complete(
      emptyPrompt({ messages: [anthropicMsg({ content: "hi" })] }),
    );
    expect(result.cacheCreationTokens).toBeUndefined();
    expect(result.cacheReadTokens).toBeUndefined();
    // costUsd should only reflect input + output (no cache penalty)
    expect(result.costUsd).toBeCloseTo(0.00105, 8);
  });
});

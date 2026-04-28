import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import { extractText } from "@/parts";
import type { Augment, TurnTrigger, PeerIdentity, InboundMessage } from "@/types";

function makeTrigger(text: string): TurnTrigger {
  const peer: PeerIdentity = {
    id: "p1",
    kind: "human",
    trustLevel: "agent",
    sourceAugment: "test",
  };
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: Date.now(),
    source: "test",
    peer,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

describe("TurnLoop", () => {
  it("runs a basic turn with no tools and returns model response", async () => {
    const model = createMockModel({ response: "Hello back!" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "identity",
          required: true,
          context: async () => [
            {
              source: "identity",
              content: "You are a test agent.",
              placement: "system",
              provenance: "identity",
              priority: "required",
              eviction: "never",
              origin: "operator",
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("Hello back!");
    expect(model.calls).toHaveLength(1);
  });

  it("executes tool calls and loops back to model", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Tool returned: echoed-test",
      finishReason: "end_turn",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Echo this"), "thread-1");
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("echo");
    expect(result.toolCalls[0]!.output).toBe("echoed-test");
    expect(model.calls).toHaveLength(2);
  });

  it("skips non-required augment context on error", async () => {
    const model = createMockModel({ response: "Still works" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "flaky",
          required: false,
          context: async () => {
            throw new Error("boom");
          },
        },
        {
          name: "stable",
          context: async () => "Stable context",
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(true);
  });

  it("aborts turn when required augment context fails", async () => {
    const model = createMockModel();
    const loop = createTurnLoop({
      augments: [
        {
          name: "critical",
          required: true,
          context: async () => {
            throw new Error("fatal");
          },
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(false);
    expect(result.error?.source).toBe("critical");
    expect(model.calls).toHaveLength(0);
  });

  it("enforces maxToolCallsPerTurn", async () => {
    const model = createMockModel();
    for (let i = 0; i < 10; i++) {
      model.pushResponse({
        content: "",
        toolCalls: [{ name: "echo", arguments: { input: `${i}` } }],
        finishReason: "tool_use",
      });
    }
    model.pushResponse({ content: "Done", finishReason: "end_turn" });

    const echoAugment: Augment = {
      name: "echo-aug",
      constraints: { maxToolCallsPerTurn: 3 },
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-1");
    expect(result.toolCalls.length).toBeLessThanOrEqual(3);
  });

  it("terminates tool loop after 2 consecutive validation failures for same tool", async () => {
    const model = createMockModel();
    // Model keeps sending invalid args for the same tool
    for (let i = 0; i < 5; i++) {
      model.pushResponse({
        content: "",
        toolCalls: [{ name: "strict", arguments: { wrong: "type" } }],
        finishReason: "tool_use",
      });
    }
    model.pushResponse({ content: "Gave up", finishReason: "end_turn" });

    const strictAugment: Augment = {
      name: "strict-aug",
      tools: [
        {
          name: "strict",
          description: "Requires a number",
          category: "meta",
          input: z.object({ value: z.number() }),
          execute: async ({ value }) => String(value * 2),
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [strictAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const _result = await loop.executeTurn(makeTrigger("Do it"), "thread-c2");
    // 1st call: model sends invalid → fail #1
    // 2nd call: model sends invalid → fail #2 → terminate message
    // 3rd call: model sees termination → gives up
    expect(model.calls.length).toBeLessThanOrEqual(3);
  });

  it("preserves model content text when tool calls are also present", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "Let me check that for you.",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Here's what I found: echoed-test",
      finishReason: "end_turn",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Check"), "thread-c3");
    expect(result.success).toBe(true);

    const hm = loop.getHistoryManager("thread-c3");
    const history = hm.getHistory(100000);
    const assistantMessages = history.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages[0]!.content).toBe("Let me check that for you.");
  });

  it("executes multiple tool calls in parallel", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "slow1", arguments: { input: "a" } },
        { name: "slow2", arguments: { input: "b" } },
        { name: "slow3", arguments: { input: "c" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "All done",
      finishReason: "end_turn",
    });

    const makeSlowTool = (name: string) => ({
      name,
      description: name,
      category: "meta" as const,
      input: z.object({ input: z.string() }),
      execute: async ({ input }: { input: string }) => {
        await new Promise((r) => setTimeout(r, 100));
        return `${name}:${input}`;
      },
    });

    const augment: Augment = {
      name: "slow-aug",
      tools: [makeSlowTool("slow1"), makeSlowTool("slow2"), makeSlowTool("slow3")],
    };

    const loop = createTurnLoop({
      augments: [augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const start = Date.now();
    const result = await loop.executeTurn(makeTrigger("Go"), "thread-h1");
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(3);
    // If parallel: ~100ms. If sequential: ~300ms. Allow margin.
    expect(elapsed).toBeLessThan(250);
  });

  it("stops gracefully when model returns finishReason 'length'", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "I was cut off mid-sen",
      finishReason: "max_tokens",
    });

    const loop = createTurnLoop({
      augments: [],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Write a long essay"), "thread-h9");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("I was cut off mid-sen");
    // Model should only be called once — no re-inference after length stop
    expect(model.calls).toHaveLength(1);
  });

  it("stops after tool execution if next inference returns finishReason 'max_tokens'", async () => {
    const model = createMockModel();
    // First call: tool request
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    // Second call: model gets cut off
    model.pushResponse({
      content: "Started to respond but was cu",
      finishReason: "max_tokens",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-h9b");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("Started to respond but was cu");
    // Tool executed, then model called again, got max_tokens, loop stops
    expect(model.calls).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
  });
});

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
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

describe("Tool call ID matching", () => {
  it("generates toolCallId for tool_use messages and matching toolCallId for tool_result messages", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Done",
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

    await loop.executeTurn(makeTrigger("Go"), "thread-h2");

    const hm = loop.getHistoryManager("thread-h2");
    const history = hm.getHistory(100000);

    const toolUseMsg = history.find((m) => m.role === "tool_use");
    const toolResultMsg = history.find((m) => m.role === "tool_result");

    expect(toolUseMsg).toBeDefined();
    expect(toolResultMsg).toBeDefined();

    // Both must have toolCallId
    expect(toolUseMsg!.toolCallId).toBeDefined();
    expect(toolResultMsg!.toolCallId).toBeDefined();

    // They must match
    expect(toolUseMsg!.toolCallId).toBe(toolResultMsg!.toolCallId);

    // toolCallId should be a non-empty string
    expect(toolUseMsg!.toolCallId!.length).toBeGreaterThan(0);
  });

  it("matches IDs correctly with multiple parallel tool calls", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "a", arguments: { input: "1" } },
        { name: "b", arguments: { input: "2" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Done",
      finishReason: "end_turn",
    });

    const augment: Augment = {
      name: "multi",
      tools: [
        {
          name: "a",
          description: "A",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `a:${input}`,
        },
        {
          name: "b",
          description: "B",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `b:${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("Go"), "thread-h2-multi");

    const hm = loop.getHistoryManager("thread-h2-multi");
    const history = hm.getHistory(100000);

    const toolUses = history.filter((m) => m.role === "tool_use");
    const toolResults = history.filter((m) => m.role === "tool_result");

    expect(toolUses).toHaveLength(2);
    expect(toolResults).toHaveLength(2);

    // Each tool_use must have a matching tool_result with the same toolCallId
    for (const use of toolUses) {
      const matchingResult = toolResults.find((r) => r.toolCallId === use.toolCallId);
      expect(matchingResult).toBeDefined();
    }

    // IDs must be unique across tool calls
    expect(toolUses[0]!.toolCallId).not.toBe(toolUses[1]!.toolCallId);
  });
});

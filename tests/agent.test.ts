import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineAgent } from "@/agent";
import { extractText } from "@/parts";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createMockTransport, createIdentityAugment } from "@tests/fixtures/mock-augment";

describe("defineAgent", () => {
  it("creates an agent that can start and stop", async () => {
    const model = createMockModel({ response: "Hello!" });
    const transport = createMockTransport();

    const agent = defineAgent(
      { name: "test-agent", model: "mock", augments: [transport.augment] },
      model,
    );

    await agent.start();
    const health = agent.health();
    expect(health.status).toBe("healthy");
    expect(health.agent).toBe("test-agent");

    await agent.stop();
  });

  it("processes a message through the full pipeline", async () => {
    const model = createMockModel({ response: "I am a test agent." });
    const transport = createMockTransport();

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [createIdentityAugment("You are a helpful test agent."), transport.augment],
      },
      model,
    );

    await agent.start();
    const result = await transport.sendMessage("Who are you?");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("I am a test agent.");

    expect(transport.outboundMessages).toHaveLength(1);
    expect(extractText(transport.outboundMessages[0]!.message.parts)).toBe("I am a test agent.");

    await agent.stop();
  });

  it("supports tool execution end to end", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "add", arguments: { a: 2, b: 3 } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "The sum is 5.",
      finishReason: "end_turn",
    });

    const mathAugment = {
      name: "math",
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          category: "meta" as const,
          input: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }: { a: number; b: number }) => String(a + b),
        },
      ],
    };

    const transport = createMockTransport();

    const agent = defineAgent(
      { name: "math-agent", model: "mock", augments: [mathAugment, transport.augment] },
      model,
    );

    await agent.start();
    const result = await transport.sendMessage("What is 2 + 3?");
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("5");
    expect(extractText(result.response?.parts ?? [])).toBe("The sum is 5.");

    await agent.stop();
  });

  it("provides inject() for test-mode triggers", async () => {
    const model = createMockModel({ response: "Injected response" });

    const agent = defineAgent({ name: "test-agent", model: "mock", augments: [] }, model);

    await agent.start();
    const result = await agent.inject({
      type: "message",
      turnId: "test-turn",
      timestamp: Date.now(),
      source: "test",
      peer: {
        id: "tester",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "test",
      },
      payload: {
        parts: [{ kind: "text", text: "Test message" }],
        sourceAugment: "test",
        peer: null,
        timestamp: Date.now(),
      },
    });

    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("Injected response");

    await agent.stop();
  });

  it("reports health with augment status", async () => {
    const model = createMockModel();
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [{ name: "healthy-aug", onBoot: async () => {} }],
      },
      model,
    );

    await agent.start();
    const health = agent.health();
    expect(health.augments["healthy-aug"]!.status).toBe("ok");

    await agent.stop();
  });

  it("inject() runs onTurnEnd hooks", async () => {
    const model = createMockModel({ response: "Hello" });
    let turnEndCalled = false;

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [
          {
            name: "tracker",
            onTurnEnd: async () => {
              turnEndCalled = true;
            },
          },
        ],
      },
      model,
    );

    await agent.start();
    await agent.inject({
      type: "message",
      turnId: "test-turn",
      timestamp: Date.now(),
      source: "test",
      peer: {
        id: "tester",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "test",
      },
      payload: {
        parts: [{ kind: "text", text: "Test" }],
        sourceAugment: "test",
        peer: null,
        timestamp: Date.now(),
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(turnEndCalled).toBe(true);

    await agent.stop();
  });
});

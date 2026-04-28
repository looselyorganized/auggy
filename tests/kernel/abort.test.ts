import { describe, it, expect } from "bun:test";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import type { TurnTrigger, PeerIdentity, InboundMessage } from "@/types";

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

describe("AbortSignal support", () => {
  it("aborts a turn when signal is triggered before inference", async () => {
    const model = createMockModel({ response: "Should not reach this" });
    const abortController = new AbortController();

    // Abort immediately
    abortController.abort();

    const loop = createTurnLoop({
      augments: [],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-abort-1", {
      signal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("abort");
    expect(model.calls).toHaveLength(0);
  });

  it("aborts a turn mid-inference loop when signal fires", async () => {
    const model = createMockModel();

    // Model will try to do a tool call, but abort fires during tool execution
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "slow", arguments: {} }],
      finishReason: "tool_use",
    });

    const abortController = new AbortController();

    const loop = createTurnLoop({
      augments: [
        {
          name: "slow-aug",
          tools: [
            {
              name: "slow",
              description: "Slow tool",
              category: "meta" as const,
              input: (await import("zod")).z.object({}),
              execute: async () => {
                // Abort while tool is "executing"
                abortController.abort();
                await new Promise((r) => setTimeout(r, 100));
                return "done";
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const _result = await loop.executeTurn(makeTrigger("Go"), "thread-abort-2", {
      signal: abortController.signal,
    });

    // Turn should complete with whatever it has (tool executed, but loop stops)
    // The key assertion: model is NOT called a second time after the abort
    expect(model.calls.length).toBeLessThanOrEqual(1);
  });
});

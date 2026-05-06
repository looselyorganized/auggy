import { describe, test, expect, mock } from "bun:test";
import { defineAgent } from "../../src/agent";
import { createMockModel } from "../fixtures/mock-model";
import type {
  Augment,
  TurnResult,
  SchedulerContext,
  TurnTrigger,
  InboundMessage,
} from "../../src/types";

function makeMessageTrigger(turnId: string, threadId: string): TurnTrigger {
  return {
    type: "message",
    turnId,
    threadId,
    timestamp: Date.now(),
    source: "test",
    peer: null,
    payload: {
      parts: [{ kind: "text", text: "hi" }],
      sourceAugment: "test",
      peer: null,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

describe("scheduleAfterTurn lifecycle hook", () => {
  test("fires after onTurnEnd in declaration order", async () => {
    const events: string[] = [];
    const aug1: Augment = {
      name: "aug1",
      onTurnEnd: async () => {
        events.push("aug1.onTurnEnd");
      },
      scheduleAfterTurn: async () => {
        events.push("aug1.scheduleAfterTurn");
      },
    };
    const aug2: Augment = {
      name: "aug2",
      onTurnEnd: async () => {
        events.push("aug2.onTurnEnd");
      },
      scheduleAfterTurn: async () => {
        events.push("aug2.scheduleAfterTurn");
      },
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug1, aug2] },
      createMockModel({ response: "hi" }),
    );
    await agent.start();
    await agent.inject(makeMessageTrigger("t1", "th1"));
    // Allow non-blocking onTurnEnd fire-and-forget calls to resolve.
    await new Promise((r) => setTimeout(r, 5));
    await agent.stop();
    expect(events).toEqual([
      "aug1.onTurnEnd",
      "aug2.onTurnEnd",
      "aug1.scheduleAfterTurn",
      "aug2.scheduleAfterTurn",
    ]);
  });

  test("scheduleAfterTurn errors are caught + logged, not propagated", async () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const aug: Augment = {
        name: "throws",
        scheduleAfterTurn: async () => {
          throw new Error("boom");
        },
      };
      const agent = defineAgent(
        { name: "test", model: "mock", augments: [aug] },
        createMockModel({ response: "hi" }),
      );
      await agent.start();
      const result = await agent.inject(makeMessageTrigger("t1", "th1"));
      expect(result).toBeDefined();
      await agent.stop();
      const calls = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(calls).toContain("scheduleAfterTurn");
      expect(calls).toContain("throws");
      expect(calls).toContain("boom");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("augments without scheduleAfterTurn are skipped silently", async () => {
    const aug: Augment = {
      name: "skipme",
      onTurnEnd: async () => {},
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      createMockModel({ response: "hi" }),
    );
    await agent.start();
    const result = await agent.inject(makeMessageTrigger("t1", "th1"));
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    await agent.stop();
  });
});

// Re-exported for Task 3 to extend without re-importing.
export type { Augment, TurnResult, SchedulerContext };

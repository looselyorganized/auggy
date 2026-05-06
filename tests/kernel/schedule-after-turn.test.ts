import { describe, test, expect, mock } from "bun:test";
import { defineAgent } from "../../src/agent";
import { createMockModel } from "../fixtures/mock-model";
import type {
  Augment,
  TurnResult,
  SchedulerContext,
  TurnTrigger,
  InboundMessage,
  Transcript,
  PeerIdentity,
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

describe("SchedulerContext.getCompletedTranscript", () => {
  test("returns the just-completed turn's transcript with peer + parts", async () => {
    let captured: Transcript | null = null;
    const aug: Augment = {
      name: "capture",
      scheduleAfterTurn: async (_result: TurnResult, ctx: SchedulerContext) => {
        captured = await ctx.getCompletedTranscript();
      },
    };
    const peer: PeerIdentity = {
      id: "test-peer",
      kind: "human",
      trustLevel: "creator",
      sourceAugment: "test",
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      createMockModel({ response: "hello world" }),
    );
    await agent.start();
    await agent.inject({
      type: "message",
      turnId: "t-capture-1",
      threadId: "th1",
      timestamp: Date.now(),
      source: "test",
      peer,
      payload: {
        parts: [{ kind: "text", text: "hi" }],
        sourceAugment: "test",
        peer,
        timestamp: Date.now(),
      } satisfies InboundMessage,
    });
    await agent.stop();
    expect(captured).not.toBeNull();
    const t = captured as unknown as Transcript;
    expect(t.turnId).toBe("t-capture-1");
    expect(t.threadId).toBe("th1");
    expect(t.peer?.id).toBe("test-peer");
    expect(t.parts.length).toBeGreaterThan(0);
    expect(t.startedAt).toBeGreaterThan(0);
    expect(t.endedAt).toBeGreaterThanOrEqual(t.startedAt);
  });

  test("getCompletedTranscript exposes no turnId argument (closure-bound only)", () => {
    // Compile-time only: SchedulerContext.getCompletedTranscript must
    // accept zero arguments. ADR-027 Decision 3.
    const ctx: SchedulerContext = {
      inject: async () => ({}) as unknown as TurnResult,
      getCompletedTranscript: async () => null,
    };
    // @ts-expect-error — must reject argument
    void ctx.getCompletedTranscript("some-turn-id");
    expect(typeof ctx.getCompletedTranscript).toBe("function");
  });
});

describe("TurnTriggerType: internal", () => {
  test("admits internal trigger via inject", async () => {
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [] },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "internal-1",
      threadId: "th-internal",
      timestamp: Date.now(),
      source: "test.internal",
      payload: { kind: "test" },
    });
    expect(result.success).toBe(true);
    expect(result.turnId).toBe("internal-1");
    expect(result.status).toBe("completed");
    await agent.stop();
  });

  test("internal trigger surfaces type in trace", async () => {
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [] },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "internal-2",
      threadId: "th-internal-2",
      timestamp: Date.now(),
      source: "auto-save",
      payload: { kind: "auto-save-extraction" },
    });
    expect(result.trace.trigger.type).toBe("internal");
    expect(result.trace.trigger.sourceAugment).toBe("auto-save");
    await agent.stop();
  });
});

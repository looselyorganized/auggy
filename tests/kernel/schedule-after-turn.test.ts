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
          throw new Error("sentinel-hook-secret");
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
      expect(calls).toContain("category=error-object");
      expect(calls).not.toContain("sentinel-hook-secret");
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

describe("Augment.handleInternalTurn dispatch (ADR-027 Decision 5)", () => {
  test("internal trigger with matching handler routes to the handler", async () => {
    const handlerCalls: TurnTrigger[] = [];
    const aug: Augment = {
      name: "claimer",
      handleInternalTurn: async (trigger) => {
        if (trigger.source !== "claimer.work") return null;
        handlerCalls.push(trigger);
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          response: {
            parts: [{ kind: "text", text: "handler-built response" }],
          },
          toolCalls: [],
          trace: {
            turnId: trigger.turnId,
            threadId: trigger.threadId ?? trigger.turnId,
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: "internal", sourceAugment: "claimer.work" },
            contextAssembly: {
              augmentBlocks: [],
              preambleTokens: 0,
              toolSchemaTokens: 0,
              historyTokens: 0,
              totalTokens: 0,
              budgetUsed: 0,
            },
            toolSelection: {
              totalTools: 0,
              phase1Used: false,
              mountedTools: [],
              withheldTools: [],
            },
            inferenceSteps: [],
            capabilityChecks: [],
          },
        };
      },
    };
    // The mock model would have been used for a standard turn; assert
    // the handler took over by counting model calls below.
    const model = createMockModel({ response: "should-not-be-called" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "claim-1",
      threadId: "th-claim",
      timestamp: Date.now(),
      source: "claimer.work",
      payload: { kind: "claim-test" },
    });
    expect(result.success).toBe(true);
    expect(result.response?.parts[0]).toEqual({
      kind: "text",
      text: "handler-built response",
    });
    expect(handlerCalls.length).toBe(1);
    expect(handlerCalls[0]?.turnId).toBe("claim-1");
    // The model engine MUST NOT have been called — handler bypasses it.
    expect(model.calls.length).toBe(0);
    await agent.stop();
  });

  test("internal trigger with no matching handler falls through to standard inference loop", async () => {
    const aug: Augment = {
      name: "rejecter",
      handleInternalTurn: async (trigger) => {
        // Only claim a different source — fall through for everything else
        if (trigger.source === "rejecter.specific") return null;
        return null;
      },
    };
    const model = createMockModel({ response: "fell through to model" });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "no-claim-1",
      threadId: "th-no-claim",
      timestamp: Date.now(),
      source: "no.match",
      payload: { kind: "no-claim" },
    });
    expect(result.success).toBe(true);
    // Standard inference path engaged: the model WAS called.
    expect(model.calls.length).toBe(1);
    expect(result.response?.parts[0]).toEqual({
      kind: "text",
      text: "fell through to model",
    });
    await agent.stop();
  });

  test("first non-null handler in declaration order wins", async () => {
    const events: string[] = [];
    const aug1: Augment = {
      name: "first",
      handleInternalTurn: async (trigger) => {
        events.push("first-asked");
        if (trigger.source !== "first.claim") return null;
        events.push("first-claimed");
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          toolCalls: [],
          trace: {
            turnId: trigger.turnId,
            threadId: trigger.threadId ?? trigger.turnId,
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: "internal", sourceAugment: "first" },
            contextAssembly: {
              augmentBlocks: [],
              preambleTokens: 0,
              toolSchemaTokens: 0,
              historyTokens: 0,
              totalTokens: 0,
              budgetUsed: 0,
            },
            toolSelection: {
              totalTools: 0,
              phase1Used: false,
              mountedTools: [],
              withheldTools: [],
            },
            inferenceSteps: [],
            capabilityChecks: [],
          },
        };
      },
    };
    const aug2: Augment = {
      name: "second",
      handleInternalTurn: async () => {
        events.push("second-asked");
        return null;
      },
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug1, aug2] },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    await agent.inject({
      type: "internal",
      turnId: "order-1",
      threadId: "th-order",
      timestamp: Date.now(),
      source: "first.claim",
      payload: {},
    });
    expect(events).toEqual(["first-asked", "first-claimed"]);
    // Second is NOT consulted once first claimed.
    await agent.stop();
  });

  test("non-internal triggers do not invoke handleInternalTurn", async () => {
    const events: string[] = [];
    const aug: Augment = {
      name: "watch",
      handleInternalTurn: async () => {
        events.push("handleInternalTurn-called");
        return null;
      },
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    await agent.inject(makeMessageTrigger("msg-1", "th-msg"));
    expect(events).toEqual([]); // not consulted for type=message
    await agent.stop();
  });

  test("handler's inferenceSteps cost flows through turnGate.commit", async () => {
    const commits: Array<{ turnId: string; cost: unknown }> = [];
    // Mock budget-style turn-gate that records every commit.
    const budgetGate: Augment = {
      name: "mock-budgets",
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async ({ turnId, cost }) => {
          commits.push({ turnId, cost });
        },
      },
    };
    const handlerAug: Augment = {
      name: "extractor",
      handleInternalTurn: async (trigger) => {
        if (trigger.source !== "extractor.run") return null;
        // Simulate a priced LLM call inside the handler — return a
        // TurnResult whose trace.inferenceSteps[] carries the cost.
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          toolCalls: [],
          trace: {
            turnId: trigger.turnId,
            threadId: trigger.threadId ?? trigger.turnId,
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: "internal", sourceAugment: "extractor.run" },
            contextAssembly: {
              augmentBlocks: [],
              preambleTokens: 0,
              toolSchemaTokens: 0,
              historyTokens: 0,
              totalTokens: 0,
              budgetUsed: 0,
            },
            toolSelection: {
              totalTools: 0,
              phase1Used: false,
              mountedTools: [],
              withheldTools: [],
            },
            inferenceSteps: [
              {
                model: "test-extractor-engine",
                inputTokens: 100,
                outputTokens: 25,
                durationMs: 5,
                toolCalls: [],
                cost: { priced: true, costUsd: 0.0042 },
              },
            ],
            capabilityChecks: [],
          },
        };
      },
    };
    const peer: PeerIdentity = {
      id: "agent-peer",
      kind: "agent",
      trustLevel: "agent",
      sourceAugment: "test",
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [budgetGate, handlerAug] },
      createMockModel({ response: "should-not-be-called" }),
    );
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "cost-flow-1",
      threadId: "th-cost",
      timestamp: Date.now(),
      source: "extractor.run",
      peer,
      payload: { kind: "cost-flow-test" },
    });
    expect(result.success).toBe(true);
    // Critical assertion: handler's cost reached turnGate.commit.
    expect(commits.length).toBe(1);
    expect(commits[0]?.turnId).toBe("cost-flow-1");
    expect(commits[0]?.cost).toEqual({ priced: true, costUsd: 0.0042 });
    await agent.stop();
  });

  test("handler returning success:false surfaces as failed turn without throwing", async () => {
    const aug: Augment = {
      name: "fail",
      handleInternalTurn: async (trigger) => {
        if (trigger.source !== "fail.case") return null;
        return {
          turnId: trigger.turnId,
          success: false,
          status: "failed",
          toolCalls: [],
          error: { message: "explicit failure", source: "fail" },
          trace: {
            turnId: trigger.turnId,
            threadId: trigger.threadId ?? trigger.turnId,
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: "internal", sourceAugment: "fail" },
            contextAssembly: {
              augmentBlocks: [],
              preambleTokens: 0,
              toolSchemaTokens: 0,
              historyTokens: 0,
              totalTokens: 0,
              budgetUsed: 0,
            },
            toolSelection: {
              totalTools: 0,
              phase1Used: false,
              mountedTools: [],
              withheldTools: [],
            },
            inferenceSteps: [],
            capabilityChecks: [],
          },
        };
      },
    };
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [aug] },
      createMockModel({ response: "x" }),
    );
    await agent.start();
    const result = await agent.inject({
      type: "internal",
      turnId: "fail-1",
      threadId: "th-fail",
      timestamp: Date.now(),
      source: "fail.case",
      payload: {},
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("explicit failure");
    await agent.stop();
  });
});

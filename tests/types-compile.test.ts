import { describe, test, expect } from "bun:test";
import type {
  Augment,
  SchedulerContext,
  Transcript,
  TurnTriggerType,
  TurnResult,
} from "../src/types";

describe("ADR-027 type surface", () => {
  test("scheduleAfterTurn signature compiles", () => {
    const aug: Augment = {
      name: "test",
      scheduleAfterTurn: async (_result, _ctx) => {},
    };
    expect(aug.scheduleAfterTurn).toBeDefined();
  });

  test("SchedulerContext exposes inject + getCompletedTranscript", () => {
    const ctx: SchedulerContext = {
      inject: async (_t) => ({ turnId: "x", success: true }) as unknown as TurnResult,
      getCompletedTranscript: async () => null,
    };
    expect(ctx.inject).toBeDefined();
    expect(ctx.getCompletedTranscript).toBeDefined();
  });

  test("TurnTriggerType includes 'internal'", () => {
    const t: TurnTriggerType = "internal";
    expect(t).toBe("internal");
  });

  test("Transcript shape compiles", () => {
    const tr: Transcript = {
      turnId: "x",
      threadId: "y",
      peer: null,
      parts: [],
      toolCalls: [],
      startedAt: 0,
      endedAt: 0,
    };
    expect(tr.turnId).toBe("x");
  });
});

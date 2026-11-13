import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineAgent } from "@/agent";
import { defaultTurnProgram } from "@/kernel/turn-program";
import { emptyTrace } from "@/kernel/trace-emitter";
import { createMockModel } from "@tests/fixtures/mock-model";
import type {
  AgentExecutionOptions,
  Augment,
  KernelEvent,
  ModelClient,
  SchedulerContext,
  ThreadHistoryPersistence,
  TransportKernel,
  TurnFinalizationObservation,
  TurnTrigger,
} from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function trigger(
  turnId: string = crypto.randomUUID(),
  threadId: string = turnId,
  type: TurnTrigger["type"] = "message",
): TurnTrigger {
  return {
    type,
    turnId,
    threadId,
    timestamp: Date.now(),
    source: "ingress",
    peer: { id: "peer", kind: "human", trustLevel: "creator", sourceAugment: "ingress" },
    payload: { parts: [{ kind: "text", text: "private-customer-input" }] },
  };
}
async function start(
  options: AgentExecutionOptions = {},
  augments: Augment[] = [],
  model = createMockModel() as ModelClient,
  scheduling?: { maxConcurrent: number; maxQueued: number; maxQueuedPerThread: number },
) {
  let kernel!: TransportKernel;
  const transport: Augment = {
    name: "ingress",
    transport: {
      identify: () => null,
      register: async (value) => {
        kernel = value;
      },
    },
  };
  const agent = defineAgent(
    {
      name: "observation",
      model: "mock",
      augments: [transport, ...augments],
      ...(scheduling ? { turnScheduling: scheduling } : {}),
    },
    model,
    options,
  );
  await agent.start();
  return { agent, kernel };
}
const history = (commit: ThreadHistoryPersistence["commit"]): ThreadHistoryPersistence => ({
  load: async () => null,
  assertAccess: async () => {},
  commit,
});

describe("turn finalization observation", () => {
  test("observes provider exceptions after history, without normal terminal hooks or raw errors", async () => {
    const records: TurnFinalizationObservation[] = [];
    const order: string[] = [];
    let hooks = 0;
    const model: ModelClient = {
      maxContextTokens: 1000,
      countTokens: () => 1,
      complete: async () => {
        throw new Error("provider-secret-value");
      },
    };
    const { agent, kernel } = await start(
      {
        onTurnFinalized: (record) => {
          records.push(record);
          order.push("observer");
        },
      },
      [
        {
          name: "hooks",
          onTurnEnd: async () => {
            hooks++;
          },
          scheduleAfterTurn: async () => {
            hooks++;
          },
        },
      ],
      model,
    );
    try {
      await expect(
        kernel.handleInbound(trigger(), {
          historyPersistence: history(async () => {
            order.push("commit");
          }),
        }),
      ).rejects.toThrow("provider-secret-value");
      expect(order).toEqual(["commit", "observer"]);
      expect(hooks).toBe(0);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.executionStarted).toBe(true);
      expect(record.sessionStarted).toBe(true);
      expect(record.history).toBe("committed");
      expect(record.disposition).toBe("threw");
      expect(record.primaryFailureCode).toBe("provider-failed");
      expect(record.trace.inferenceAttempts).toBe(1);
      expect(record.trace.recordedInferenceSteps).toBe(0);
      expect(JSON.stringify(record)).not.toContain("secret");
      expect(JSON.stringify(record)).not.toContain("private-customer-input");
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.trace)).toBe(true);
      expect(Object.isFrozen(record.accounting)).toBe(true);
      expect(Object.isFrozen(record.priorFailureCodes)).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  test("history failure outranks cost failure and prevents provisional success emission", async () => {
    const records: TurnFinalizationObservation[] = [];
    const events: KernelEvent[] = [];
    let commits = 0;
    const gate: Augment = {
      name: "gate",
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async () => {
          commits++;
          throw new Error("cost-secret");
        },
      },
    };
    const { agent, kernel } = await start(
      {
        onTurnFinalized: (record) => {
          records.push(record);
        },
      },
      [gate],
    );
    try {
      await expect(
        kernel.handleInbound(trigger(), {
          onEvent: (event) => events.push(event),
          historyPersistence: history(async () => {
            throw new Error("history-secret");
          }),
        }),
      ).rejects.toThrow("Thread history commit outcome is unknown");
      expect(commits).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]!.primaryFailureCode).toBe("history-commit-failed");
      expect(records[0]!.priorFailureCodes).toContain("cost-commit-failed");
      expect(records[0]!.outcomeUnknown).toBe(true);
      expect(records[0]!.history).toBe("commit-failed");
      expect(records[0]!.accounting.state).toBe("failed");
      expect(JSON.stringify(records)).not.toContain("secret");
      expect(
        events.some((event) => event.kind === "run_finished" && event.status === "completed"),
      ).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  test("history failure alone buffers a successful kernel terminal", async () => {
    const events: KernelEvent[] = [];
    const records: TurnFinalizationObservation[] = [];
    const { agent, kernel } = await start({
      onTurnFinalized: (record) => {
        records.push(record);
      },
    });
    try {
      await expect(
        kernel.handleInbound(trigger(), {
          onEvent: (event) => events.push(event),
          historyPersistence: history(async () => {
            throw new Error("fail");
          }),
        }),
      ).rejects.toThrow("history commit");
      expect(events.some((event) => event.kind === "run_finished")).toBe(false);
      expect(records[0]!.outcome).toBe("outcome-unknown");
    } finally {
      await agent.stop();
    }
  });

  test("distinguishes actual durable and deferred dispositions; invalid metadata fails closed", async () => {
    for (const disposition of [
      undefined,
      { disposition: "committed" },
      { disposition: "deferred-to-transport" },
      null,
      { disposition: "made-up" },
    ] as const) {
      const records: TurnFinalizationObservation[] = [];
      const { agent, kernel } = await start({
        onTurnFinalized: (record) => {
          records.push(record);
        },
      });
      try {
        const execution = kernel.handleInbound(trigger(), {
          historyPersistence: history(
            async () => disposition as Awaited<ReturnType<ThreadHistoryPersistence["commit"]>>,
          ),
        });
        if (disposition === null || disposition?.disposition === "made-up") {
          await expect(execution).rejects.toThrow("history commit");
          expect(records[0]!.history).toBe("commit-failed");
        } else {
          expect((await execution).success).toBe(true);
          expect(records[0]!.history).toBe(disposition?.disposition ?? "committed");
        }
        expect(records).toHaveLength(1);
      } finally {
        await agent.stop();
      }
    }
  });

  test("covers failed restore and execution-start before any session or model", async () => {
    const model = createMockModel();
    const records: TurnFinalizationObservation[] = [];
    const { agent, kernel } = await start(
      {
        onTurnFinalized: (record) => {
          records.push(record);
        },
      },
      [],
      model,
    );
    try {
      await expect(
        kernel.handleInbound(trigger(), {
          historyPersistence: {
            ...history(async () => {}),
            load: async () => {
              throw new Error("restore-secret");
            },
          },
        }),
      ).rejects.toThrow("restore-secret");
      await expect(
        kernel.handleInbound(trigger(), {
          onExecutionStart: () => {
            throw undefined;
          },
        }),
      ).rejects.toBeUndefined();
      expect(model.calls).toHaveLength(0);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.sessionStarted)).toEqual([false, false]);
      expect(records.map((record) => record.primaryFailureCode)).toEqual([
        "history-restore-failed",
        "execution-start-failed",
      ]);
      expect(records[0]!.history).toBe("restore-failed");
    } finally {
      await agent.stop();
    }
  });

  test("observes queue rejection and queued cancellation exactly once without session work", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const model = createMockModel();
    const complete = model.complete;
    model.complete = async (prompt, options) => {
      entered.resolve();
      await gate.promise;
      return complete(prompt, options);
    };
    const records: TurnFinalizationObservation[] = [];
    const { agent } = await start(
      {
        onTurnFinalized: (record) => {
          records.push(record);
        },
      },
      [],
      model,
      { maxConcurrent: 1, maxQueued: 1, maxQueuedPerThread: 1 },
    );
    try {
      const first = agent.inject(trigger("first"));
      await entered.promise;
      const abort = new AbortController();
      const queued = agent.inject(trigger("queued"), { signal: abort.signal });
      const rejected = await agent.inject(trigger("rejected"));
      expect(rejected.status).toBe("rejected");
      abort.abort();
      expect((await queued).status).toBe("canceled");
      gate.resolve();
      await first;
      expect(records).toHaveLength(3);
      for (const record of records.filter((record) => record.turnId !== "first")) {
        expect(record.executionStarted).toBe(false);
        expect(record.sessionStarted).toBe(false);
        expect(record.trace.inferenceAttempts).toBe(0);
      }
    } finally {
      gate.resolve();
      await agent.stop();
    }
  });

  test("runs the selected program for causal internal turns and observes expired attempts", async () => {
    const seen: string[] = [];
    const records: TurnFinalizationObservation[] = [];
    let context!: SchedulerContext;
    const augment: Augment = {
      name: "causal",
      handleInternalTurn: async (t) => ({
        turnId: t.turnId,
        success: true,
        status: "completed",
        toolCalls: [],
        trace: emptyTrace({
          turnId: t.turnId,
          threadId: t.threadId!,
          trigger: { type: "internal" },
        }),
      }),
      scheduleAfterTurn: async (result, ctx) => {
        if (result.turnId === "parent") {
          context = ctx;
          await ctx.inject(trigger("child", "shared", "internal"));
        }
      },
    };
    const { agent } = await start(
      {
        turnProgram: {
          run: async (turn) => {
            seen.push(turn.turnId);
            return defaultTurnProgram(turn);
          },
        },
        onTurnFinalized: (record) => {
          records.push(record);
        },
      },
      [augment],
    );
    try {
      await agent.inject(trigger("parent", "shared"));
      expect(seen).toEqual(["parent", "child"]);
      expect((await context.inject(trigger("expired", "shared", "internal"))).status).toBe(
        "rejected",
      );
      expect(records.map((record) => record.turnId)).toEqual(["parent", "child", "expired"]);
      expect(records[2]!.sessionStarted).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  test("a failing or hanging observer cannot replace results or invoke twice", async () => {
    for (const mode of ["reject", "hang"] as const) {
      let calls = 0;
      let rejectLate!: (error: unknown) => void;
      const { agent } = await start({
        onTurnFinalized: () => {
          calls++;
          if (mode === "reject") throw new Error("observer-secret");
          return new Promise<void>((_, reject) => {
            rejectLate = reject;
          });
        },
      });
      try {
        const before = Date.now();
        expect((await agent.inject(trigger())).success).toBe(true);
        const duration = Date.now() - before;
        expect(calls).toBe(1);
        if (mode === "hang") {
          expect(duration).toBeGreaterThanOrEqual(950);
          expect(duration).toBeLessThan(2000);
          rejectLate(new Error("late observer failure"));
          await Promise.resolve();
        }
      } finally {
        await agent.stop();
      }
    }
  });

  test("application deadline observes unknown effect while retaining its physical lane", async () => {
    const release = deferred<string>();
    const entered = deferred<void>();
    const observed = deferred<TurnFinalizationObservation>();
    let complete = false;
    const aug: Augment = {
      name: "effect",
      tools: [
        {
          name: "effect",
          description: "effect",
          category: "meta",
          input: z.object({}),
          execute: async () => {
            entered.resolve();
            return release.promise;
          },
        },
      ],
    };
    const { agent } = await start(
      {
        turnProgram: { run: defaultTurnProgram, timeoutMs: 15 },
        onTurnFinalized: (record) => {
          observed.resolve(record);
        },
      },
      [aug],
      createMockModel({ toolCalls: [{ name: "effect", arguments: {} }] }),
    );
    const execution = agent.inject(trigger("deadline", "lane")).then(
      () => {
        complete = true;
        return "returned";
      },
      () => {
        complete = true;
        return "threw";
      },
    );
    try {
      await entered.promise;
      const record = await observed.promise;
      expect(record.outcomeUnknown).toBe(true);
      expect(record.pendingEffects).toBe(true);
      expect(
        record.primaryFailureCode === "program-deadline-exceeded" ||
          record.priorFailureCodes.includes("program-deadline-exceeded"),
      ).toBe(true);
      expect(complete).toBe(false);
      expect(agent.health().scheduler?.activeTurns).toBe(1);
      release.resolve("settled");
      expect(await execution).toBe("threw");
      expect((await agent.inject(trigger("retry", "lane"))).rejection?.reason).toBe(
        "thread-quarantined",
      );
    } finally {
      release.resolve("settled");
      await execution;
      await agent.stop();
    }
  });
  test("keeps the selected program for transport and every injected trigger kind", async () => {
    const seen: string[] = [];
    const records: TurnFinalizationObservation[] = [];
    const { agent, kernel } = await start({
      turnProgram: {
        run: async (turn) => {
          seen.push(turn.turnId);
          return defaultTurnProgram(turn);
        },
      },
      onTurnFinalized: (record) => {
        records.push(record);
      },
    });
    try {
      await kernel.handleInbound(trigger("transport"));
      for (const type of ["message", "scheduled", "event", "continuation", "internal"] as const)
        await agent.inject(trigger(type, type, type));
      expect(seen).toEqual([
        "transport",
        "message",
        "scheduled",
        "event",
        "continuation",
        "internal",
      ]);
      expect(records).toHaveLength(6);
      expect(records.every((record) => record.sessionStarted)).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  test("claimed internal turns retain zero-step accounting and immutable handler receipts", async () => {
    let commits = 0;
    const records: TurnFinalizationObservation[] = [];
    const model = createMockModel();
    const augment: Augment = {
      name: "internal",
      handleInternalTurn: async (t) => ({
        turnId: t.turnId,
        success: true,
        status: "completed",
        toolCalls: [],
        trace: emptyTrace({
          turnId: t.turnId,
          threadId: t.threadId!,
          trigger: { type: "internal" },
        }),
      }),
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async () => {
          commits++;
        },
      },
    };
    const { agent } = await start(
      {
        turnProgram: {
          run: async (turn) => {
            const internal = await turn.dispatchInternalTurn();
            expect(Object.isFrozen(internal)).toBe(true);
            if (!internal.handled) throw new Error("not claimed");
            return internal.completion;
          },
        },
        onTurnFinalized: (record) => {
          records.push(record);
        },
      },
      [augment],
      model,
    );
    try {
      expect((await agent.inject(trigger("internal", "internal", "internal"))).success).toBe(true);
      expect(commits).toBe(1);
      expect(model.calls).toHaveLength(0);
      expect(records[0]!.accounting).toEqual({ state: "committed", pricing: "unpriced" });
    } finally {
      await agent.stop();
    }
  });

  test("an opaque context effect remains owned and quarantined after an application deadline", async () => {
    const release = deferred<string>();
    const entered = deferred<void>();
    const observed = deferred<TurnFinalizationObservation>();
    let settled = false;
    const model = createMockModel();
    const { agent } = await start(
      {
        turnProgram: { run: defaultTurnProgram, timeoutMs: 10 },
        onTurnFinalized: (record) => {
          observed.resolve(record);
        },
      },
      [
        {
          name: "context-effect",
          required: true,
          context: async () => {
            entered.resolve();
            return release.promise;
          },
        },
      ],
      model,
    );
    const execution = agent.inject(trigger("context-timeout", "owned-context")).catch(() => {
      settled = true;
    });
    try {
      await entered.promise;
      const record = await observed.promise;
      expect(record.pendingEffects).toBe(true);
      expect(record.outcomeUnknown).toBe(true);
      expect(record.primaryFailureCode).toBe("effect-outcome-unknown");
      expect(record.priorFailureCodes).toContain("program-deadline-exceeded");
      expect(record.status).toBe("failed");
      expect(model.calls).toHaveLength(0);
      expect(settled).toBe(false);
      expect(agent.health().scheduler?.activeTurns).toBe(1);
      release.resolve("late-context");
      await execution;
      expect((await agent.inject(trigger("after", "owned-context"))).rejection?.reason).toBe(
        "thread-quarantined",
      );
    } finally {
      release.resolve("late-context");
      await execution;
      await agent.stop();
    }
  });

  test("an opaque internal handler remains owned after an application deadline", async () => {
    const release = deferred<null>();
    const entered = deferred<void>();
    const observed = deferred<TurnFinalizationObservation>();
    let settled = false;
    const augment: Augment = {
      name: "internal-effect",
      handleInternalTurn: async () => {
        entered.resolve();
        return release.promise;
      },
    };
    const { agent } = await start(
      {
        turnProgram: { run: defaultTurnProgram, timeoutMs: 10 },
        onTurnFinalized: (record) => {
          observed.resolve(record);
        },
      },
      [augment],
    );
    const execution = agent.inject(trigger("internal-timeout", "owned", "internal")).catch(() => {
      settled = true;
    });
    try {
      await entered.promise;
      const record = await observed.promise;
      expect(record.pendingEffects).toBe(true);
      expect(record.outcomeUnknown).toBe(true);
      expect(settled).toBe(false);
      release.resolve(null);
      await execution;
      expect((await agent.inject(trigger("after", "owned"))).rejection?.reason).toBe(
        "thread-quarantined",
      );
    } finally {
      release.resolve(null);
      await execution;
      await agent.stop();
    }
  });
});

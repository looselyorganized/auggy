import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { defaultTurnProgram } from "@/kernel/turn-program";
import { createTokenizer } from "@/tokenizer";
import { createMockModel } from "@tests/fixtures/mock-model";
import type {
  Augment,
  KernelEvent,
  ManagedTurnSession,
  ModelClient,
  TurnCompletion,
  TurnProgramBinding,
  TurnToolBatchReceipt,
  TurnTrigger,
} from "@/types";

function trigger(): TurnTrigger {
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: { parts: [{ kind: "text", text: "hello" }] },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(
  options: {
    program?: TurnProgramBinding;
    model?: ModelClient;
    augments?: Augment[];
    max?: number;
  } = {},
) {
  const model = options.model ?? createMockModel();
  const loop = createTurnLoop({
    model,
    tokenizer: createTokenizer(),
    augments: options.augments ?? [],
    config: { name: "managed", model: "mock", augments: [], maxInferenceLoops: options.max ?? 10 },
    turnProgram: options.program,
  });
  return {
    model,
    loop,
    execute: (events: KernelEvent[] = []) =>
      loop.executeTurnSettled(trigger(), crypto.randomUUID(), {
        onEvent: (event) => events.push(event),
      }),
  };
}
function tool(onExecute: () => Promise<string> = async () => "done"): Augment {
  return {
    name: "test-tools",
    tools: [
      {
        name: "read",
        description: "read",
        category: "meta",
        input: z.object({}),
        execute: onExecute,
      },
    ],
  };
}

async function prepare(turn: ManagedTurnSession) {
  const internal = await turn.dispatchInternalTurn();
  if (internal.handled) throw new Error("unexpected internal result");
  const result = await turn.preparePrompt();
  if (result.kind !== "ready") throw new Error("unexpected terminal");
}

describe("managed turn program", () => {
  test("uses project control flow and a hard total ceiling after a real tool batch", async () => {
    for (const ceiling of [1, 2]) {
      let tools = 0;
      const model = createMockModel();
      model.pushResponse({
        toolCalls: [{ name: "read", arguments: {} }],
        finishReason: "tool_use",
        costUsd: 0.2,
      });
      model.pushResponse({ content: "final", costUsd: 0.3 });
      const { execute } = setup({
        model,
        augments: [
          tool(async () => {
            tools++;
            return "done";
          }),
        ],
        program: { run: defaultTurnProgram, maxInferences: ceiling },
      });
      const result = await execute();
      expect(result.kind).toBe("returned");
      expect(model.calls).toHaveLength(ceiling);
      expect(tools).toBe(1);
      expect(result.summary.trace.inferenceAttempts).toBe(ceiling);
      if (result.kind === "returned")
        expect(result.result.response?.parts).toEqual([
          { kind: "text", text: ceiling === 1 ? "I've completed the available actions." : "final" },
        ]);
    }
  });

  test("hard ceiling includes recovery; absent ceiling retains legacy extra allowance", async () => {
    for (const mode of ["legacy", "application", "hard"] as const) {
      let tools = 0;
      const model = createMockModel();
      model.pushResponse({
        toolCalls: [
          { name: "strict", arguments: {} },
          { name: "strict", arguments: {} },
        ],
        finishReason: "tool_use",
      });
      model.pushResponse({
        content: "recovered",
        toolCalls: [{ name: "strict", arguments: { value: "ignored" } }],
        finishReason: "tool_use",
      });
      const strict: Augment = {
        name: "strict",
        tools: [
          {
            name: "strict",
            description: "strict",
            category: "meta",
            input: z.object({ value: z.string() }),
            execute: async () => {
              tools++;
              return "unexpected";
            },
          },
        ],
      };
      const { execute } = setup({
        model,
        max: 1,
        augments: [strict],
        program:
          mode === "legacy"
            ? undefined
            : { run: defaultTurnProgram, ...(mode === "hard" ? { maxInferences: 1 } : {}) },
      });
      const result = await execute();
      expect(result.kind).toBe("returned");
      expect(model.calls).toHaveLength(mode === "hard" ? 1 : 2);
      expect(tools).toBe(0);
    }
  });

  test("preserves end_turn tool calls and suppresses max_tokens tool calls", async () => {
    for (const finishReason of ["end_turn", "max_tokens"] as const) {
      let effects = 0;
      const model = createMockModel();
      model.pushResponse({
        content: "partial",
        finishReason,
        toolCalls: [{ name: "read", arguments: {} }],
      });
      const { execute } = setup({
        model,
        augments: [
          tool(async () => {
            effects++;
            return "ok";
          }),
        ],
        program: { run: defaultTurnProgram },
      });
      expect((await execute()).kind).toBe("returned");
      expect(effects).toBe(finishReason === "end_turn" ? 1 : 0);
    }
  });

  test("rejects a fabricated or unfinished completion even if the program catches a violation", async () => {
    for (const run of [
      async () => ({}) as TurnCompletion,
      async (turn: ManagedTurnSession) => {
        try {
          turn.finishAtLimit();
        } catch {}
        return {} as TurnCompletion;
      },
    ]) {
      const { execute, model } = setup({ program: { run } });
      const result = await execute();
      expect(result.kind).toBe("threw");
      expect(result.summary.primaryFailureCode).toBe("program-contract-violation");
      expect((model as ReturnType<typeof createMockModel>).calls).toHaveLength(0);
    }
  });

  test("rejects cross-session tool receipts before side effects", async () => {
    let foreign!: TurnToolBatchReceipt;
    let effects = 0;
    const first = setup({
      model: createMockModel({ toolCalls: [{ name: "read", arguments: {} }] }),
      augments: [tool()],
      program: {
        run: async (turn) => {
          await prepare(turn);
          foreign = (await turn.infer()) as TurnToolBatchReceipt;
          throw new Error("discard");
        },
      },
    });
    await first.execute();
    const second = setup({
      model: createMockModel({ toolCalls: [{ name: "read", arguments: {} }] }),
      augments: [
        tool(async () => {
          effects++;
          return "bad";
        }),
      ],
      program: {
        run: async (turn) => {
          await prepare(turn);
          await turn.infer();
          await turn.executeTools(foreign);
          return {} as TurnCompletion;
        },
      },
    });
    const result = await second.execute();
    expect(result.kind).toBe("threw");
    expect(effects).toBe(0);
    expect(result.summary.primaryFailureCode).toBe("program-contract-violation");
  });

  test("rejects duplicate dispatch after exactly one tool attempt", async () => {
    let effects = 0;
    const { execute } = setup({
      model: createMockModel({ toolCalls: [{ name: "read", arguments: {} }] }),
      augments: [
        tool(async () => {
          effects++;
          return "ok";
        }),
      ],
      program: {
        run: async (turn) => {
          await prepare(turn);
          const receipt = (await turn.infer()) as TurnToolBatchReceipt;
          await turn.executeTools(receipt);
          await turn.executeTools(receipt);
          return {} as TurnCompletion;
        },
      },
    });
    const result = await execute();
    expect(result.kind).toBe("threw");
    expect(effects).toBe(1);
  });

  test("rejects concurrent phase calls and fences their provider continuation", async () => {
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 1000,
      countTokens: () => 1,
      complete: async (_prompt, options) => {
        calls++;
        return new Promise((_, reject) => {
          if (options?.signal?.aborted) reject(options.signal.reason);
          else
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
        });
      },
    };
    const { execute } = setup({
      model,
      program: {
        run: async (turn) => {
          await prepare(turn);
          void turn.infer();
          await turn.infer();
          return {} as TurnCompletion;
        },
      },
    });
    const result = await execute();
    expect(result.kind).toBe("threw");
    expect(calls).toBeLessThanOrEqual(1);
    expect(result.summary.primaryFailureCode).toBe("program-contract-violation");
  });

  test("complete followed by throw cannot publish terminal success", async () => {
    const events: KernelEvent[] = [];
    const { execute } = setup({
      program: {
        run: async (turn) => {
          await prepare(turn);
          const answer = await turn.infer();
          if (answer.kind !== "answer") throw new Error("unexpected");
          turn.complete(answer);
          throw new Error("customer-secret");
        },
      },
    });
    const result = await execute(events);
    expect(result.kind).toBe("threw");
    expect(result.summary.status).toBe("failed");
    expect(result.summary.primaryFailureCode).toBe("program-threw");
    expect(JSON.stringify(result.summary)).not.toContain("customer-secret");
    expect(events.some((event) => event.kind === "run_finished")).toBe(false);
  });

  test("quiescent stop is supported and closed sessions cannot be reused", async () => {
    let captured!: ManagedTurnSession;
    const { execute, model } = setup({
      program: {
        run: async (turn) => {
          captured = turn;
          await prepare(turn);
          return turn.stop("application-limit");
        },
      },
    });
    const result = await execute();
    expect(result.kind).toBe("returned");
    expect((model as ReturnType<typeof createMockModel>).calls).toHaveLength(0);
    expect(() => captured.stop("application-limit")).toThrow("Invalid managed");
    expect(result.summary.primaryFailureCode).toBeNull();
    expect(Object.isFrozen(captured)).toBe(true);
  });

  test("validates numerical limits before constructing a session", () => {
    for (const timeoutMs of [0, -1, 0.5, 900001, Infinity, NaN])
      expect(() => setup({ program: { run: defaultTurnProgram, timeoutMs } })).toThrow("timeoutMs");
    for (const maxInferences of [0, -1, 0.5, 3])
      expect(() => setup({ max: 2, program: { run: defaultTurnProgram, maxInferences } })).toThrow(
        "maxInferences",
      );
  });

  test("bounds an idle application promise and revokes late operations", async () => {
    let captured!: ManagedTurnSession;
    const hold = deferred<TurnCompletion>();
    const { execute } = setup({
      program: {
        timeoutMs: 5,
        run: async (turn) => {
          captured = turn;
          return hold.promise;
        },
      },
    });
    const result = await execute();
    expect(result.kind).toBe("threw");
    expect(result.summary.primaryFailureCode).toBe("program-deadline-exceeded");
    expect(result.summary.status).toBe("canceled");
    expect(() => captured.stop("application-limit")).toThrow("Invalid managed");
    hold.resolve({} as TurnCompletion);
  });

  test("joins sibling effects when event emission rejects a parallel batch", async () => {
    const release = deferred<string>();
    const entered = deferred<void>();
    let completed = false;
    const tools: Augment = {
      name: "parallel",
      tools: [
        {
          name: "fast",
          description: "fast",
          category: "meta",
          input: z.object({}),
          execute: async () => "fast",
        },
        {
          name: "slow",
          description: "slow",
          category: "meta",
          input: z.object({}),
          execute: async () => {
            entered.resolve();
            return release.promise;
          },
        },
      ],
    };
    const { loop } = setup({
      augments: [tools],
      model: createMockModel({
        toolCalls: [
          { name: "fast", arguments: {} },
          { name: "slow", arguments: {} },
        ],
      }),
      program: { run: defaultTurnProgram },
    });
    const execution = loop
      .executeTurnSettled(trigger(), "siblings", {
        onEvent: (event) => {
          if (event.kind === "tool_call_result" && event.output === "fast")
            throw new Error("event failed");
        },
      })
      .then((result) => {
        completed = true;
        return result;
      });
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(completed).toBe(false);
    release.resolve("slow");
    expect((await execution).kind).toBe("threw");
  });

  test("preserves a thrown undefined through the settlement discriminant", async () => {
    const { execute } = setup({
      program: {
        run: async () => {
          throw undefined;
        },
      },
    });
    const result = await execute();
    expect(result.kind).toBe("threw");
    if (result.kind === "threw") expect(result.error).toBeUndefined();
  });
  test("a swallowed contract violation fails promptly even if app code keeps waiting", async () => {
    const { execute } = setup({
      program: {
        timeoutMs: 5_000,
        run: async (turn) => {
          try {
            turn.stop("application-limit");
          } catch {}
          return new Promise<TurnCompletion>(() => {});
        },
      },
    });
    const started = Date.now();
    const result = await execute();
    expect(result.kind).toBe("threw");
    expect(result.summary.primaryFailureCode).toBe("program-contract-violation");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("an application provider deadline fences late deltas/results and accounts once", async () => {
    const deferredResponse = deferred<Awaited<ReturnType<ModelClient["complete"]>>>();
    let delta: ((text: string) => void) | undefined;
    let commitCount = 0;
    let effects = 0;
    const events: KernelEvent[] = [];
    const model: ModelClient = {
      maxContextTokens: 1000,
      countTokens: () => 1,
      complete: async (_prompt, options) => {
        delta = (text) => options?.onDelta?.({ kind: "text_delta", text });
        delta("partial");
        return deferredResponse.promise;
      },
    };
    const gate: Augment = {
      name: "budget",
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async () => {
          commitCount++;
        },
      },
    };
    const { loop, execute } = setup({
      model,
      augments: [
        gate,
        tool(async () => {
          effects++;
          return "unsafe";
        }),
      ],
      program: { run: defaultTurnProgram, timeoutMs: 5 },
    });
    const result = await execute(events);
    expect(result.kind).toBe("threw");
    expect(result.summary.primaryFailureCode).toBe("program-deadline-exceeded");
    expect(commitCount).toBe(1);
    expect(result.summary.accounting.pricing).toBe("unpriced");
    const before = events.length;
    delta?.("late-secret");
    deferredResponse.resolve({
      content: "late-secret",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "tool_use",
      toolCalls: [{ name: "read", arguments: {} }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toHaveLength(before);
    expect(effects).toBe(0);
    expect(commitCount).toBe(1);
    expect(JSON.stringify(loop)).not.toContain("late-secret");
  });

  test("a tool unknown outcome survives a later event failure", async () => {
    const unknownTool: Augment = {
      name: "unknown",
      tools: [
        {
          name: "unknown",
          description: "unknown",
          category: "meta",
          input: z.object({}),
          execute: async () => ({ content: "uncertain", outcomeUnknown: true }),
        },
      ],
    };
    const { loop } = setup({
      augments: [unknownTool],
      model: createMockModel({ toolCalls: [{ name: "unknown", arguments: {} }] }),
      program: { run: defaultTurnProgram },
    });
    const result = await loop.executeTurnSettled(trigger(), "unknown-event", {
      onEvent: (event) => {
        if (event.kind === "tool_call_result") throw new Error("event failure");
      },
    });
    expect(result.kind).toBe("threw");
    expect(result.summary.outcomeUnknown).toBe(true);
    expect(result.summary.primaryFailureCode).toBe("effect-outcome-unknown");
  });
});

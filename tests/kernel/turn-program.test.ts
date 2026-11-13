import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { defaultTurnProgram } from "@/kernel/turn-program";
import { createTokenizer } from "@/tokenizer";
import { createMockModel } from "@tests/fixtures/mock-model";
import type {
  Augment,
  CostResult,
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
    tokenizer?: ReturnType<typeof createTokenizer>;
  } = {},
) {
  const model = options.model ?? createMockModel();
  const loop = createTurnLoop({
    model,
    tokenizer: options.tokenizer ?? createTokenizer(),
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

  test("joins sibling effects and retains known outcomes when an event rejects a batch", async () => {
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
    const input = trigger();
    const eventError = new Error("event failed");
    const execution = loop
      .executeTurnSettled(input, "siblings", {
        onEvent: (event) => {
          if (event.kind === "tool_call_result" && event.output === "fast") throw eventError;
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
    const result = await execution;
    expect(result.kind).toBe("threw");
    if (result.kind === "threw") expect(result.error).toBe(eventError);
    expect(result.summary.outcomeUnknown).toBe(false);
    expect(result.summary.trace.successfulToolCalls).toBe(2);
    const history = loop.getHistoryManager("siblings");
    const messages = history
      .snapshot()
      .messages.filter((message) => message.role.startsWith("tool_"));
    expect(messages.map((message) => message.role)).toEqual([
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
    ]);
    expect(messages[0]?.toolCallId).toBe(messages[1]?.toolCallId);
    expect(messages[2]?.toolCallId).toBe(messages[3]?.toolCallId);
    expect(messages[1]?.content).toBe("fast");
    expect(messages[3]?.content).toBe("slow");
    expect(history.getTranscript(input.turnId)?.toolCalls.map((call) => call.output)).toEqual([
      "fast",
      "slow",
    ]);
  });

  test("preserves successful siblings when a pre-dispatch event fails", async () => {
    let dispatched = 0;
    const tools = tool(async () => {
      dispatched++;
      return "effect-retained";
    });
    const { loop } = setup({
      augments: [tools],
      model: createMockModel({
        toolCalls: [
          { name: "read", arguments: {} },
          { name: "read", arguments: {} },
        ],
      }),
      program: { run: defaultTurnProgram },
    });
    let starts = 0;
    const result = await loop.executeTurnSettled(trigger(), "before-dispatch", {
      onEvent: (event) => {
        if (event.kind === "tool_call_started" && ++starts === 1) throw new Error("start failed");
      },
    });
    expect(result.kind).toBe("threw");
    expect(dispatched).toBe(1);
    expect(result.summary.outcomeUnknown).toBe(false);
    expect(result.summary.trace.successfulToolCalls).toBe(1);
    expect(
      loop
        .getHistoryManager("before-dispatch")
        .snapshot()
        .messages.filter((message) => message.role === "tool_result")
        .map((message) => message.content),
    ).toEqual(["effect-retained"]);
  });

  test("retains sibling history and quarantines an effect whose history cannot be recorded", async () => {
    const base = createTokenizer();
    let calls = 0;
    const tools = tool(async () => (++calls === 1 ? "cannot-tokenize-effect" : "retained-effect"));
    const { loop } = setup({
      tokenizer: {
        ...base,
        count: (text) => {
          if (text === "cannot-tokenize-effect") throw new Error("tokenizer failed");
          return base.count(text);
        },
      },
      augments: [tools],
      model: createMockModel({
        toolCalls: [
          { name: "read", arguments: {} },
          { name: "read", arguments: {} },
        ],
      }),
      program: { run: defaultTurnProgram },
    });
    const input = trigger();
    const result = await loop.executeTurnSettled(input, "record-failure");
    expect(result.kind).toBe("threw");
    expect(calls).toBe(2);
    expect(result.summary.outcomeUnknown).toBe(true);
    expect(result.summary.primaryFailureCode).toBe("effect-outcome-unknown");
    expect(result.summary.trace.successfulToolCalls).toBe(2);
    const history = loop.getHistoryManager("record-failure");
    const messages = history
      .snapshot()
      .messages.filter((message) => message.role.startsWith("tool_"));
    expect(messages.map((message) => message.role)).toEqual(["tool_use", "tool_result"]);
    expect(messages[1]?.content).toBe("retained-effect");
    expect(history.getTranscript(input.turnId)?.toolCalls.map((call) => call.output)).toEqual([
      "cannot-tokenize-effect",
      "retained-effect",
    ]);
  });

  test("application deadlines retain unknown required and optional context effects", async () => {
    for (const required of [true, false]) {
      const release = deferred<string>();
      let pending = 0;
      const { loop, model } = setup({
        augments: [{ name: "context", required, context: async () => release.promise }],
        program: { run: defaultTurnProgram, timeoutMs: 10 },
      });
      try {
        const result = await loop.executeTurnSettled(trigger(), "context", {
          trackDetachedOperation: (operation) => {
            pending++;
            void operation.then(
              () => {
                pending--;
              },
              () => {
                pending--;
              },
            );
          },
        });
        expect(result.kind).toBe("threw");
        expect(result.summary.outcomeUnknown).toBe(true);
        expect(result.summary.status).toBe("failed");
        expect(result.summary.primaryFailureCode).toBe("effect-outcome-unknown");
        expect(result.summary.priorFailureCodes).toContain("program-deadline-exceeded");
        expect(result.summary.trace.inferenceAttempts).toBe(0);
        expect(pending).toBe(1);
        expect("calls" in model && model.calls).toHaveLength(0);
      } finally {
        release.resolve("late-context");
        await release.promise;
      }
    }
  });

  test("legacy required context timeout retains its existing failed classification", async () => {
    const release = deferred<string>();
    const { loop } = setup({
      augments: [
        {
          name: "context",
          required: true,
          constraints: { contextTimeoutMs: 5 },
          context: async () => release.promise,
        },
      ],
    });
    try {
      const result = await loop.executeTurnSettled(trigger(), "legacy-context");
      expect(result.kind).toBe("returned");
      expect(result.summary.status).toBe("failed");
      expect(result.summary.outcomeUnknown).toBe(false);
      expect(result.summary.trace.inferenceAttempts).toBe(0);
    } finally {
      release.resolve("late-context");
      await release.promise;
    }
  });

  test("commits known streaming response cost before surfacing event failures in ordinary and recovery inference", async () => {
    for (const recovery of [false, true]) {
      for (const failingEvent of ["text_message_start", "text_message_delta", "text_message_end"]) {
        let calls = 0;
        const costs: CostResult[] = [];
        const eventError = new Error("event sink failed");
        const model: ModelClient = {
          maxContextTokens: 100_000,
          countTokens: (text) => Math.ceil(text.length / 4),
          complete: async (_prompt, options) => {
            calls++;
            if (recovery && calls === 1)
              return {
                content: "",
                inputTokens: 2,
                outputTokens: 3,
                costUsd: 0.125,
                finishReason: "tool_use",
                toolCalls: [
                  { name: "strict", arguments: {} },
                  { name: "strict", arguments: {} },
                ],
              };
            options?.onDelta?.({ kind: "text_delta", text: "known result" });
            return {
              content: "known result",
              inputTokens: 11,
              outputTokens: 7,
              costUsd: 0.25,
              finishReason: "end_turn",
            };
          },
        };
        const { loop } = setup({
          model,
          program: { run: defaultTurnProgram },
          augments: [
            {
              name: "gate",
              turnGate: {
                prepare: async () => ({
                  decision: { allow: true },
                  confirm: async () => {},
                  rollback: async () => {},
                }),
                commit: async ({ cost }) => {
                  costs.push(cost);
                },
              },
            },
            {
              name: "strict",
              tools: [
                {
                  name: "strict",
                  description: "strict",
                  category: "meta",
                  input: z.object({ value: z.string() }),
                  execute: async () => "must not execute",
                },
              ],
            },
          ],
        });
        const result = await loop.executeTurnSettled(trigger(), "stream-event", {
          onEvent: (event) => {
            if (event.kind === failingEvent) throw eventError;
          },
        });
        expect(result.kind).toBe("threw");
        if (result.kind === "threw") expect(result.error).toBe(eventError);
        expect(result.summary.primaryFailureCode).toBe("kernel-failed");
        expect(result.summary.outcomeUnknown).toBe(false);
        expect(result.summary.trace.inferenceAttempts).toBe(recovery ? 2 : 1);
        expect(result.summary.trace.recordedInferenceSteps).toBe(recovery ? 2 : 1);
        expect(result.summary.accounting).toEqual({ state: "committed", pricing: "priced" });
        expect(calls).toBe(recovery ? 2 : 1);
        expect(costs).toEqual([{ priced: true, costUsd: recovery ? 0.375 : 0.25 }]);
      }
    }
  });

  test("caller cancellation before program invocation cannot become a contract violation", async () => {
    const controller = new AbortController();
    let invoked = 0;
    const { loop } = setup({
      program: {
        run: async (turn) => {
          invoked++;
          return defaultTurnProgram(turn);
        },
      },
    });
    const result = await loop.executeTurnSettled(trigger(), "pre-program-cancel", {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === "run_started")
          controller.abort(new DOMException("canceled", "AbortError"));
      },
    });
    expect(result.kind).toBe("threw");
    expect(invoked).toBe(0);
    expect(result.summary.sessionStarted).toBe(false);
    expect(result.summary.status).toBe("canceled");
    expect(result.summary.primaryFailureCode).toBe("caller-canceled");
    expect(result.summary.priorFailureCodes).not.toContain("program-contract-violation");
    expect(result.summary.trace.inferenceAttempts).toBe(0);
  });

  test("late revoked operations preserve the first cancellation or earlier contract violation", async () => {
    for (const misuseFirst of [false, true]) {
      const controller = new AbortController();
      const { loop } = setup({
        program: {
          run: async (turn) => {
            if (misuseFirst) {
              try {
                turn.finishAtLimit();
              } catch {}
            }
            controller.abort(new DOMException("canceled", "AbortError"));
            try {
              await turn.dispatchInternalTurn();
            } catch {}
            return new Promise<TurnCompletion>(() => {});
          },
        },
      });
      const result = await loop.executeTurnSettled(trigger(), "late-operation", {
        signal: controller.signal,
      });
      expect(result.kind).toBe("threw");
      expect(result.summary.status).toBe(misuseFirst ? "failed" : "canceled");
      expect(result.summary.primaryFailureCode).toBe(
        misuseFirst ? "program-contract-violation" : "caller-canceled",
      );
      expect(result.summary.priorFailureCodes).toEqual([]);
      expect(result.summary.trace.inferenceAttempts).toBe(0);
    }
  });

  test("a swallowed phase failure still settles promptly with its original classification", async () => {
    const providerError = new Error("provider failed");
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: () => 1,
      complete: async () => {
        throw providerError;
      },
    };
    const { execute } = setup({
      model,
      program: {
        timeoutMs: 5_000,
        run: async (turn) => {
          await prepare(turn);
          try {
            await turn.infer();
          } catch {}
          try {
            turn.finishAtLimit();
          } catch {}
          return new Promise<TurnCompletion>(() => {});
        },
      },
    });
    const started = Date.now();
    const result = await execute();
    expect(result.kind).toBe("threw");
    if (result.kind === "threw") expect(result.error).toBe(providerError);
    expect(result.summary.status).toBe("failed");
    expect(result.summary.primaryFailureCode).toBe("provider-failed");
    expect(result.summary.priorFailureCodes).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
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

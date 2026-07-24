import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import { ModelResponseLimitError } from "@/engines/_shared/response-limits";
import type {
  Augment,
  TurnTrigger,
  PeerIdentity,
  InboundMessage,
  CostResult,
  ModelClient,
} from "@/types";

function makeTrigger(text: string): TurnTrigger {
  const peer: PeerIdentity = {
    id: "p1",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
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

function identityAugment(): Augment {
  return {
    name: "identity",
    required: true,
    context: async () => [
      {
        source: "identity",
        content: "You are a test agent.",
        placement: "system",
        provenance: "identity",
        priority: "required",
        eviction: "never",
        origin: "operator",
      },
    ],
  };
}

function captureGate(): {
  augment: Augment;
  committedCosts: CostResult[];
} {
  const committedCosts: CostResult[] = [];
  return {
    committedCosts,
    augment: {
      name: "capture-gate",
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
        commit: async ({ cost }) => {
          committedCosts.push(cost);
        },
      },
    },
  };
}

describe("runCostCommit — multi-iteration sum", () => {
  it("commits known cost when a completed provider response violates a limit", async () => {
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        throw new ModelResponseLimitError("maxResponseBytes").withAccounting({
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.0042,
        });
      },
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-limit-cost");

    expect(result.status).toBe("failed");
    expect(result.errorResponse).toBe("The model response exceeded a configured safety limit.");
    expect(result.trace.inferenceSteps).toHaveLength(1);
    expect(gate.committedCosts).toEqual([{ priced: true, costUsd: 0.0042 }]);
  });

  it("preserves provider accounting when the kernel stream limit fires first", async () => {
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, options) {
        options?.onDelta?.({ kind: "text_delta", text: "oversized" });
        throw new ModelResponseLimitError("maxTextBytes").withAccounting({
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.0042,
        });
      },
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: {
        name: "test",
        model: "mock",
        augments: [],
        responseLimits: { maxTextBytes: 4 },
      },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-kernel-stream-limit-cost");

    expect(result.status).toBe("failed");
    expect(result.trace.inferenceSteps).toHaveLength(1);
    expect(gate.committedCosts).toEqual([{ priced: true, costUsd: 0.0042 }]);
  });

  it("makes a multi-step turn unpriced when a limited stream has unknown final billing", async () => {
    let call = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, options) {
        call++;
        if (call === 1) {
          return {
            content: "",
            toolCalls: [{ name: "echo", arguments: { input: "x" } }],
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.001,
            finishReason: "tool_use",
          };
        }
        options?.onDelta?.({ kind: "text_delta", text: "oversized" });
        throw new ModelResponseLimitError("maxTextBytes").withAccounting({
          inputTokens: 20,
          outputTokens: 0,
          unpricedReason: "Final billing usage unavailable after stream abort.",
        });
      },
    };
    const echo: Augment = {
      name: "echo",
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), echo, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: {
        name: "test",
        model: "mock",
        augments: [],
        responseLimits: { maxTextBytes: 4 },
      },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-unpriced-stream-limit");

    expect(result.status).toBe("failed");
    expect(result.trace.inferenceSteps).toHaveLength(2);
    expect(gate.committedCosts).toEqual([
      { priced: false, reason: "Final billing usage unavailable after stream abort." },
    ]);
  });

  it("fails malformed provider accounting closed as unpriced", async () => {
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        return {
          content: "invalid accounting",
          inputTokens: -100,
          outputTokens: Number.POSITIVE_INFINITY,
          costUsd: -1,
          finishReason: "end_turn",
        };
      },
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-invalid-accounting");

    expect(result.status).toBe("failed");
    expect(result.trace.inferenceSteps).toHaveLength(1);
    expect(result.trace.inferenceSteps[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cost: { priced: false },
    });
    expect(gate.committedCosts).toEqual([
      { priced: false, reason: "Provider returned invalid accounting metadata." },
    ]);
  });

  it("commits sum of priced costs across all inference steps", async () => {
    const model = createMockModel();
    // Iteration 1: tool call
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: 0.001,
    });
    // Iteration 2: tool call
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "y" } }],
      finishReason: "tool_use",
      costUsd: 0.002,
    });
    // Iteration 3: end turn
    model.pushResponse({
      content: "done",
      finishReason: "end_turn",
      costUsd: 0.003,
    });

    const echoAug: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "echoes input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();

    const loop = createTurnLoop({
      augments: [identityAugment(), echoAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(result.status).toBe("completed");
    expect(model.calls).toHaveLength(3);
    expect(gate.committedCosts).toHaveLength(1); // commit fires once at end
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(true);
    if (!cost.priced) throw new Error("expected priced");
    // 0.001 + 0.002 + 0.003 = 0.006
    expect(cost.costUsd).toBeCloseTo(0.006, 9);
  });

  it("marks the whole turn unpriced if any inference step is unpriced", async () => {
    const model = createMockModel();
    // Iteration 1: priced
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: 0.005,
    });
    // Iteration 2: UNPRICED (e.g. service_tier discriminator)
    model.pushResponse({
      content: "done",
      finishReason: "end_turn",
      costUsd: undefined,
      unpricedReason: "anthropic: service_tier=batch not modeled",
    });

    const echoAug: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "echoes input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();

    const loop = createTurnLoop({
      augments: [identityAugment(), echoAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(false);
    if (cost.priced) throw new Error("expected unpriced");
    expect(cost.reason).toContain("service_tier=batch");
  });

  it("commits priced cost for single-iteration turn (regression-guard)", async () => {
    const model = createMockModel();
    model.pushResponse({ content: "", finishReason: "end_turn", costUsd: 0.001 });
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    // Single-iteration turn: cost is 0.001 (regression-guard for back-compat).
    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(true);
    if (!cost.priced) throw new Error("expected priced");
    expect(cost.costUsd).toBeCloseTo(0.001, 9);
  });

  it("breaks on first unpriced step and ignores subsequent priced steps", async () => {
    // Locks the load-bearing invariant: if a future refactor moved the
    // `break` to `continue`, tests 1-3 would still pass but a 0.999-priced
    // step after an unpriced step would silently survive in the committed
    // total. This test fails fast in that case.
    const model = createMockModel();
    // Step 0: UNPRICED
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: undefined,
      unpricedReason: "first-step-unpriced",
    });
    // Step 1: priced — must be ignored by commit because step 0 was unpriced.
    model.pushResponse({ content: "done", finishReason: "end_turn", costUsd: 0.999 });

    const echoAug: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "echoes input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => input,
        },
      ],
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [identityAugment(), echoAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(false);
    if (cost.priced) throw new Error("expected unpriced");
    expect(cost.reason).toBe("first-step-unpriced");
  });

  it("counts the final inference on the consecutive-failure-completion path", async () => {
    // Codex High finding: when a tool fails validation 2+ times consecutively,
    // the kernel terminates the tool loop and runs ONE more inference to let
    // the model respond to the failure. That final inference was previously
    // never recorded into trace.inferenceSteps[], so its cost was dropped
    // from runCostCommit's sum AND its unpriced reason couldn't propagate.
    //
    // This test forces the consecutive-failure path: model emits two
    // bad-validation tool calls in a row (each fails validation 2x against
    // the same tool name), kernel runs the terminator inference, expected
    // commit sums all three inference costs.
    const model = createMockModel();
    // Iteration 1: tool call with bad args (fails validation once)
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "strict", arguments: { wrong: true } }],
      finishReason: "tool_use",
      costUsd: 0.001,
    });
    // Iteration 2: tool call with bad args (fails validation second time → terminateToolLoop)
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "strict", arguments: { wrong: true } }],
      finishReason: "tool_use",
      costUsd: 0.002,
    });
    // Iteration 3: terminator inference — model responds to the validation errors
    model.pushResponse({
      content: "Sorry, I couldn't complete that.",
      finishReason: "end_turn",
      costUsd: 0.003,
    });

    const strictAug: Augment = {
      name: "strict-aug",
      tools: [
        {
          name: "strict",
          description: "rejects all input",
          category: "meta",
          input: z.object({ required: z.string() }),
          execute: async () => "should never run",
        },
      ],
    };
    const gate = captureGate();

    const loop = createTurnLoop({
      augments: [identityAugment(), strictAug, gate.augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(gate.committedCosts).toHaveLength(1);
    const cost = gate.committedCosts[0]!;
    expect(cost.priced).toBe(true);
    if (!cost.priced) throw new Error("expected priced");
    // 0.001 + 0.002 + 0.003 = 0.006 — the third inference (terminator)
    // must be included or this assertion fails at 0.003.
    expect(cost.costUsd).toBeCloseTo(0.006, 9);
    expect(model.calls).toHaveLength(3);
  });

  it("commits completed inference cost exactly once when the request aborts during a tool", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "wait-for-abort", arguments: {} }],
      finishReason: "tool_use",
      costUsd: 0.0042,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [
        identityAugment(),
        {
          name: "abortable-tool",
          tools: [
            {
              name: "wait-for-abort",
              description: "Wait until the caller cancels",
              category: "meta",
              input: z.object({}),
              execute: async () => {
                markStarted();
                await new Promise<void>((resolve) => {
                  controller.signal.addEventListener("abort", () => resolve(), { once: true });
                });
                return "canceled";
              },
            },
          ],
        },
        gate.augment,
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const pending = loop.executeTurn(makeTrigger("go"), "thread-abort-cost", {
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("client disconnected"));
    const result = await pending;

    expect(result.status).toBe("canceled");
    expect(gate.committedCosts).toHaveLength(1);
    expect(gate.committedCosts[0]).toEqual({ priced: true, costUsd: 0.0042 });
  });

  it("commits prior priced inference exactly once when a later model call throws", async () => {
    const baseModel = createMockModel();
    baseModel.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "x" } }],
      finishReason: "tool_use",
      costUsd: 0.006,
    });
    let calls = 0;
    const model = {
      ...baseModel,
      async complete(prompt: Parameters<typeof baseModel.complete>[0]) {
        calls++;
        if (calls === 2) throw new Error("provider disconnected");
        return baseModel.complete(prompt);
      },
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [
        identityAugment(),
        {
          name: "echo-aug",
          tools: [
            {
              name: "echo",
              description: "echo",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async ({ input }) => input,
            },
          ],
        },
        gate.augment,
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await expect(loop.executeTurn(makeTrigger("go"), "thread-late-engine-error")).rejects.toThrow(
      "provider disconnected",
    );
    expect(gate.committedCosts).toEqual([{ priced: true, costUsd: 0.006 }]);
  });

  it("includes an accounted terminal provider failure exactly once", async () => {
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        calls++;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ name: "echo", arguments: { input: "x" } }],
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.006,
            finishReason: "tool_use",
          };
        }
        throw new ModelResponseLimitError(
          "maxResponseBytes",
          "Provider returned no response choices.",
        ).withAccounting({
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.004,
        });
      },
    };
    const gate = captureGate();
    const loop = createTurnLoop({
      augments: [
        identityAugment(),
        {
          name: "echo-aug",
          tools: [
            {
              name: "echo",
              description: "echo",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async ({ input }) => input,
            },
          ],
        },
        gate.augment,
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("go"), "thread-accounted-provider-error");

    expect(result.status).toBe("failed");
    expect(result.trace.inferenceSteps).toHaveLength(2);
    expect(gate.committedCosts).toEqual([{ priced: true, costUsd: 0.01 }]);
  });
});

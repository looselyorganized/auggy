import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { defineAgent } from "@/agent";
import { extractText } from "@/parts";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createMockTransport, createIdentityAugment } from "@tests/fixtures/mock-augment";
import { emptyTrace } from "@/kernel/trace-emitter";
import { deriveToolOperationId } from "@/kernel/execution-context";
import type { Augment, TransportKernel } from "@/types";

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

  it("fails closed before booting or registering transports when distributed coordination is declared", async () => {
    let booted = false;
    let registered = false;
    const agent = defineAgent(
      {
        name: "distributed-test-agent",
        model: "mock",
        coordination: {
          mode: "postgres",
          namespace: "5d9b9796-65ba-43d0-9ba9-57f1a9db5ef7",
          urlEnv: "AUGGY_COORDINATION_DATABASE_URL",
          fleetCapacity: {
            maxConcurrent: 4,
            maxQueued: 100,
            maxQueuedPerThread: 20,
          },
          retention: {
            terminalRequestRetentionMs: 604_800_000,
            maxTerminalRequests: 10_000,
            eventRetentionMs: 2_592_000_000,
            maxEvents: 50_000,
          },
          result: { maxReplayBytes: 65_536 },
          leaseDurationMs: 30_000,
          heartbeatIntervalMs: 5_000,
          claimPollMs: 100,
          maxWaitMs: 30_000,
        },
        augments: [
          {
            name: "probe",
            onBoot: async () => {
              booted = true;
            },
            transport: {
              identify: () => null,
              register: async () => {
                registered = true;
              },
            },
          },
        ],
      },
      createMockModel({ response: "unused" }),
    );

    let startupError: Error | undefined;
    try {
      await agent.start();
    } catch (error) {
      startupError = error as Error;
    }
    expect(startupError?.message).toContain("process-local-fleet-admission");
    expect(startupError?.message).toContain("process-local-mutable-stores");
    expect(startupError?.message).toContain("unfenced-delivery-outbox");
    expect(startupError?.message).not.toContain("AUGGY_COORDINATION_DATABASE_URL");
    expect(booted).toBe(false);
    expect(registered).toBe(false);
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

  it("exposes redacted process-local operational signals with honest readiness", async () => {
    const model = createMockModel({ response: "sentinel-provider-response" });
    const transport = createMockTransport();
    const agent = defineAgent(
      { name: "observed-agent", model: "mock", augments: [transport.augment] },
      model,
    );

    expect(agent.operationalSnapshot().readiness).toEqual({
      accepting: false,
      state: "not-started",
    });
    await agent.start();
    expect(agent.operationalSnapshot().readiness).toEqual({ accepting: true, state: "accepting" });

    await transport.sendMessage("sentinel-customer-prompt");
    const active = agent.operationalSnapshot();
    expect(active.turns).toMatchObject({ total: 1, completed: 1 });
    expect(active.inference).toMatchObject({ attempts: 1, completed: 1 });
    expect(active.responseDelivery).toMatchObject({ attempts: 1, completed: 1, inFlight: 0 });
    const serialized = JSON.stringify(active);
    expect(serialized).not.toContain("sentinel-customer-prompt");
    expect(serialized).not.toContain("sentinel-provider-response");

    await agent.stop();
    expect(agent.operationalSnapshot()).toMatchObject({
      readiness: { accepting: false, state: "stopped" },
      shutdown: { attempts: 1, completed: 1 },
    });
  });

  it("accounts for inference steps returned by a claimed internal turn", async () => {
    const internal: Augment = {
      name: "internal-engine",
      async handleInternalTurn(trigger) {
        const trace = emptyTrace({
          turnId: trigger.turnId,
          threadId: trigger.threadId ?? trigger.turnId,
          trigger: { type: trigger.type, sourceAugment: trigger.source },
        });
        trace.inferenceSteps.push({
          model: "sentinel-model-label",
          outcome: "failed",
          inputTokens: 8,
          outputTokens: 3,
          durationMs: 12,
          toolCalls: [],
          cost: { priced: true, costUsd: 0.125 },
        });
        return {
          turnId: trigger.turnId,
          success: false,
          status: "failed",
          toolCalls: [],
          trace,
          error: { message: "sentinel-internal-error", source: "internal-engine" },
        };
      },
    };
    const agent = defineAgent(
      { name: "internal-observed", model: "mock", augments: [internal] },
      createMockModel({ response: "unused" }),
    );
    await agent.start();
    try {
      await agent.inject({
        type: "internal",
        turnId: "sentinel-internal-turn",
        threadId: "sentinel-internal-thread",
        source: "internal-engine",
        timestamp: Date.now(),
        payload: {},
      });
      const snapshot = agent.operationalSnapshot();
      expect(snapshot.inference).toMatchObject({
        attempts: 1,
        completed: 0,
        failed: 1,
        inputTokens: 8,
        outputTokens: 3,
        pricedCostUsd: 0.125,
      });
      expect(JSON.stringify(snapshot)).not.toContain("sentinel");
    } finally {
      await agent.stop();
    }
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

  it("propagates trusted execution context without exposing idempotency material to traces or events", async () => {
    let toolContext: import("@/types").ToolExecuteContext | undefined;
    let observedTurn: import("@/types").TurnState | undefined;
    const model = createMockModel();
    model.pushResponse({
      toolCalls: [{ name: "charge", arguments: { amount: 42 } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "charged" });
    const agent = defineAgent(
      {
        name: "execution-context-agent",
        model: "mock",
        augments: [
          {
            name: "charge-augment",
            context: async (turn) => {
              observedTurn = turn;
              return [];
            },
            tools: [
              {
                name: "charge",
                description: "charges an order",
                category: "meta",
                input: z.object({ amount: z.number() }),
                execute: async (_input, context) => {
                  toolContext = context;
                  return "charged";
                },
              },
            ],
          },
        ],
      },
      model,
    );
    const executionContext = {
      version: 1 as const,
      executionId: "job-8cba58e1",
      attempt: 2,
      deadlineAt: Date.now() + 60_000,
      correlationId: "order-7f3c",
      idempotencyKeyHash: "a".repeat(64),
      bindingHash: "b".repeat(64),
    };
    const events: import("@/types").KernelEvent[] = [];

    await agent.start();
    const result = await agent.inject(
      {
        type: "message",
        turnId: "trusted-execution-turn",
        threadId: "trusted-execution-thread",
        timestamp: Date.now(),
        source: "trusted-test",
        peer: null,
        payload: { sourceAugment: "trusted-test", peer: null, timestamp: Date.now(), parts: [] },
      },
      { executionContext, onEvent: (event) => events.push(event) },
    );

    expect(result.executionContext).toEqual(executionContext);
    expect(observedTurn?.executionContext).toEqual(executionContext);
    expect(result.trace.executionContext).toEqual({
      version: 1,
      executionId: "job-8cba58e1",
      attempt: 2,
      deadlineAt: executionContext.deadlineAt,
      correlationId: "order-7f3c",
    });
    expect(toolContext?.executionContext).toEqual(result.trace.executionContext);
    expect(toolContext?.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    expect(events.find((event) => event.kind === "run_started")).toMatchObject({
      execution: result.trace.executionContext,
    });
    const serialized = JSON.stringify({ trace: result.trace, events, toolContext });
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toContain("b".repeat(64));

    await agent.stop();
  });

  it("awaits trusted execution-start persistence before model admission", async () => {
    let persistenceCommitted = false;
    let contextObservedCommit = false;
    const agent = defineAgent(
      {
        name: "execution-start-hook-agent",
        model: "mock",
        augments: [
          {
            name: "execution-start-probe",
            context: async () => {
              contextObservedCommit = persistenceCommitted;
              return [];
            },
          },
        ],
      },
      createMockModel({ response: "ok" }),
    );
    await agent.start();
    try {
      await agent.inject(
        {
          type: "internal",
          turnId: "execution-start-turn",
          threadId: "execution-start-thread",
          timestamp: Date.now(),
          source: "trusted-test",
          payload: { sourceAugment: "trusted-test", peer: null, timestamp: Date.now(), parts: [] },
        },
        {
          onExecutionStart: async () => {
            await Promise.resolve();
            persistenceCommitted = true;
          },
        },
      );
      expect(contextObservedCommit).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("does not admit model execution when the trusted execution-start hook rejects", async () => {
    const model = createMockModel({ response: "must-not-run" });
    const agent = defineAgent(
      { name: "execution-start-rejection-agent", model: "mock", augments: [] },
      model,
    );
    await agent.start();
    try {
      await expect(
        agent.inject(
          {
            type: "internal",
            turnId: "execution-start-rejection-turn",
            threadId: "execution-start-rejection-thread",
            timestamp: Date.now(),
            source: "trusted-test",
            payload: {
              sourceAugment: "trusted-test",
              peer: null,
              timestamp: Date.now(),
              parts: [],
            },
          },
          { onExecutionStart: async () => Promise.reject(new Error("durable-start-fenced")) },
        ),
      ).rejects.toThrow("durable-start-fenced");
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("derives stable downstream operation identities without exposing trusted hashes", () => {
    const base = {
      version: 1 as const,
      executionId: "job-8cba58e1",
      attempt: 1,
      bindingHash: "b".repeat(64),
      idempotencyKeyHash: "a".repeat(64),
    };
    const initial = deriveToolOperationId(base, "charge", 0);
    const retry = deriveToolOperationId({ ...base, attempt: 2 }, "charge", 0);
    const rebound = deriveToolOperationId({ ...base, bindingHash: "c".repeat(64) }, "charge", 0);

    expect(initial).toBe(retry);
    expect(rebound).not.toBe(initial);
    expect(initial).not.toContain(base.bindingHash);
    expect(initial).not.toContain(base.idempotencyKeyHash);
  });

  it("assigns distinct stable operation identities across inference rounds and execution retries", async () => {
    const model = createMockModel();
    for (let attempt = 1; attempt <= 2; attempt++) {
      model.pushResponse({
        toolCalls: [{ name: "charge", arguments: { amount: 10 } }],
        finishReason: "tool_use",
      });
      model.pushResponse({
        toolCalls: [{ name: "charge", arguments: { amount: 20 } }],
        finishReason: "tool_use",
      });
      model.pushResponse({ content: "done" });
    }
    const operationIds: string[] = [];
    const agent = defineAgent(
      {
        name: "multi-round-operation-agent",
        model: "mock",
        augments: [
          {
            name: "charge-augment",
            tools: [
              {
                name: "charge",
                description: "charges an order",
                category: "meta",
                input: z.object({ amount: z.number() }),
                execute: async (_input, context) => {
                  operationIds.push(context?.operationId ?? "missing");
                  return "charged";
                },
              },
            ],
          },
        ],
      },
      model,
    );
    const bindingHash = "d".repeat(64);

    await agent.start();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await agent.inject(
        {
          type: "message",
          turnId: `multi-round-turn-${attempt}`,
          threadId: "multi-round-thread",
          timestamp: Date.now(),
          source: "trusted-test",
          peer: null,
          payload: { sourceAugment: "trusted-test", peer: null, timestamp: Date.now(), parts: [] },
        },
        {
          executionContext: {
            version: 1,
            executionId: "multi-round-job",
            attempt,
            bindingHash,
          },
        },
      );
    }

    expect(operationIds).toHaveLength(4);
    expect(operationIds[0]).not.toBe(operationIds[1]);
    expect(operationIds.slice(0, 2)).toEqual(operationIds.slice(2));
    expect(operationIds.slice(0, 2)).toEqual([
      deriveToolOperationId(
        { version: 1, executionId: "multi-round-job", attempt: 1, bindingHash },
        "charge",
        0,
      )!,
      deriveToolOperationId(
        { version: 1, executionId: "multi-round-job", attempt: 1, bindingHash },
        "charge",
        1,
      )!,
    ]);
    await agent.stop();
  });

  it("cancels a trusted execution when its deadline expires", async () => {
    const model = createMockModel();
    model.pushResponse({
      toolCalls: [{ name: "wait", arguments: {} }],
      finishReason: "tool_use",
    });
    let toolAborted = false;
    const agent = defineAgent(
      {
        name: "execution-deadline-agent",
        model: "mock",
        augments: [
          {
            name: "slow-tool",
            tools: [
              {
                name: "wait",
                description: "waits for cancellation",
                category: "meta",
                input: z.object({}),
                execute: async (_input, context) =>
                  new Promise<string>((_resolve, reject) => {
                    context?.signal?.addEventListener(
                      "abort",
                      () => {
                        toolAborted = true;
                        reject(context.signal?.reason);
                      },
                      { once: true },
                    );
                  }),
              },
            ],
          },
        ],
      },
      model,
    );

    await agent.start();
    const result = await agent.inject(
      {
        type: "message",
        turnId: "deadline-turn",
        timestamp: Date.now(),
        source: "trusted-test",
        peer: null,
        payload: { sourceAugment: "trusted-test", peer: null, timestamp: Date.now(), parts: [] },
      },
      {
        executionContext: {
          version: 1,
          executionId: "deadline-job",
          attempt: 1,
          deadlineAt: Date.now() + 25,
        },
      },
    );

    expect(result.status).toBe("canceled");
    expect(toolAborted).toBe(true);
    await agent.stop();
  });

  it("rejects malformed trusted execution context before admitting a turn", async () => {
    const model = createMockModel({ response: "must not run" });
    const agent = defineAgent(
      { name: "execution-context-validation", model: "mock", augments: [] },
      model,
    );
    await agent.start();

    await expect(
      agent.inject(
        {
          type: "message",
          turnId: "invalid-execution-turn",
          timestamp: Date.now(),
          source: "trusted-test",
          peer: null,
          payload: { sourceAugment: "trusted-test", peer: null, timestamp: Date.now(), parts: [] },
        },
        {
          executionContext: {
            version: 1,
            executionId: "job-1",
            attempt: 1,
            idempotencyKeyHash: "a".repeat(64),
            idempotencyKey: "raw-secret-must-not-cross-the-boundary",
          },
        } as never,
      ),
    ).rejects.toThrow("Invalid trusted execution context");
    expect(model.calls).toHaveLength(0);

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

  it("inject() propagates cancellation to terminal hooks and suppresses scheduled work", async () => {
    const model = createMockModel({ response: "Hello" });
    const controller = new AbortController();
    let lifecycleSignal: AbortSignal | undefined;
    let scheduled = false;
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [
          {
            name: "tracker",
            onTurnEnd: async (_result, context) => {
              lifecycleSignal = context?.signal;
              controller.abort(new DOMException("caller left", "AbortError"));
            },
            scheduleAfterTurn: async () => {
              scheduled = true;
            },
          },
        ],
      },
      model,
    );

    await agent.start();
    await agent.inject(
      {
        type: "message",
        turnId: "canceled-post-turn",
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
      },
      { signal: controller.signal },
    );

    expect(lifecycleSignal).toBe(controller.signal);
    expect(scheduled).toBe(false);
    await agent.stop();
  });

  it("does not start later onTurnEnd hooks after cancellation during an earlier hook", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [
          {
            name: "first-hook",
            onTurnEnd: async () => {
              calls.push("first");
              controller.abort(new DOMException("caller left", "AbortError"));
            },
          },
          {
            name: "second-hook",
            onTurnEnd: async () => {
              calls.push("second");
            },
          },
        ],
      },
      createMockModel({ response: "Hello" }),
    );

    await agent.start();
    await agent.inject(
      {
        type: "message",
        turnId: "cancel-between-turn-end-hooks",
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
      },
      { signal: controller.signal },
    );

    expect(calls).toEqual(["first"]);
    await agent.stop();
  });

  it("does not start later scheduled hooks after cancellation during an earlier hook", async () => {
    const model = createMockModel({ response: "Hello" });
    const controller = new AbortController();
    const calls: string[] = [];
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [
          {
            name: "first-scheduler",
            scheduleAfterTurn: async () => {
              calls.push("first");
              controller.abort(new DOMException("caller left", "AbortError"));
            },
          },
          {
            name: "second-scheduler",
            scheduleAfterTurn: async () => {
              calls.push("second");
            },
          },
        ],
      },
      model,
    );

    await agent.start();
    await agent.inject(
      {
        type: "message",
        turnId: "cancel-between-schedulers",
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
      },
      { signal: controller.signal },
    );

    expect(calls).toEqual(["first"]);
    await agent.stop();
  });

  it("does not dispatch later outbound messages after cancellation during delivery", async () => {
    const controller = new AbortController();
    const delivered: string[] = [];
    let kernel: TransportKernel | undefined;
    const transport: Augment = {
      name: "canceling-transport",
      transport: {
        concurrency: 1,
        identify: () => null,
        async register(registeredKernel) {
          kernel = registeredKernel;
          registeredKernel.onOutbound(async (_peer, message) => {
            delivered.push(extractText(message.parts));
            controller.abort(new DOMException("caller left", "AbortError"));
          });
        },
      },
    };
    const internal: Augment = {
      name: "multi-response",
      async handleInternalTurn(trigger) {
        if (trigger.source !== "multi-response") return null;
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          responses: [
            {
              parts: [{ kind: "text", text: "first" }],
              targetAugment: "canceling-transport",
            },
            {
              parts: [{ kind: "text", text: "second" }],
              targetAugment: "canceling-transport",
            },
          ],
          toolCalls: [],
          trace: emptyTrace({
            turnId: trigger.turnId,
            threadId: trigger.threadId ?? trigger.turnId,
            trigger: { type: trigger.type, sourceAugment: trigger.source },
          }),
        };
      },
    };
    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [transport, internal],
      },
      createMockModel({ response: "unused" }),
    );

    await agent.start();
    expect(kernel).toBeDefined();
    await agent.inject(
      {
        type: "internal",
        turnId: "cancel-between-outbound",
        timestamp: Date.now(),
        source: "multi-response",
        peer: {
          id: "tester",
          kind: "human",
          trustLevel: "creator",
          sourceAugment: "test",
        },
        payload: {},
      },
      { signal: controller.signal },
    );

    expect(delivered).toEqual(["first"]);
    await agent.stop();
  });
});

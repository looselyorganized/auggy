import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import { extractText } from "@/parts";
import type {
  Augment,
  AuthorizationGrant,
  KernelEvent,
  TurnTrigger,
  PeerIdentity,
  InboundMessage,
  RouteAuthContext,
  ToolResult,
  ModelClient,
  ModelResponse,
} from "@/types";

function makeTrigger(text: string, auth?: RouteAuthContext): TurnTrigger {
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
    ...(auth !== undefined ? { auth } : {}),
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

describe("TurnLoop", () => {
  it("fences late provider events and results after the inference deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    let emitDelta: ((text: string) => void) | undefined;
    let settleProvider: ((response: ModelResponse) => void) | undefined;
    let toolExecutions = 0;
    let signalObservedResolve!: () => void;
    const signalObserved = new Promise<void>((resolve) => {
      signalObservedResolve = resolve;
    });
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      complete: (_prompt, options) => {
        observedSignal = options?.signal;
        emitDelta = (text) => options?.onDelta?.({ kind: "text_delta", text });
        emitDelta("partial");
        signalObservedResolve();
        return new Promise<ModelResponse>((providerResolve) => {
          settleProvider = providerResolve;
          options?.signal?.addEventListener(
            "abort",
            () => {
              options?.onDelta?.({ kind: "text_delta", text: "abort-race-secret-sentinel" });
              providerResolve({
                content: "abort-race-secret-sentinel",
                toolCalls: [{ name: "must_not_run", arguments: {} }],
                finishReason: "tool_use",
                inputTokens: 1,
                outputTokens: 1,
              });
            },
            { once: true },
          );
        });
      },
    };
    const events: KernelEvent[] = [];
    const loop = createTurnLoop({
      augments: [
        {
          name: "must-not-run",
          tools: [
            {
              name: "must_not_run",
              description: "deadline regression",
              category: "meta",
              input: z.object({}),
              execute: async () => {
                toolExecutions++;
                return "unsafe";
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: {
        name: "provider-deadline",
        model: "mock",
        augments: [],
        providerRequestTimeoutMs: 5,
      },
    });

    const execution = loop.executeTurn(makeTrigger("Hi"), "thread-provider-deadline", {
      onEvent: (event) => events.push(event),
    });

    await signalObserved;
    await expect(execution).rejects.toThrow("outcome is unknown");
    expect(observedSignal?.aborted).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      "run_started",
      "text_message_start",
      "text_message_delta",
      "text_message_end",
    ]);

    emitDelta?.("late-secret-sentinel");
    settleProvider?.({
      content: "late-secret-sentinel",
      toolCalls: [{ name: "must_not_run", arguments: {} }],
      finishReason: "tool_use",
      inputTokens: 1,
      outputTokens: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(toolExecutions).toBe(0);
    expect(JSON.stringify(events)).not.toContain("late-secret-sentinel");
    expect(JSON.stringify(events)).not.toContain("abort-race-secret-sentinel");
  });

  it("runs a basic turn with no tools and returns model response", async () => {
    const model = createMockModel({ response: "Hello back!" });
    const loop = createTurnLoop({
      augments: [
        {
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
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("Hello back!");
    expect(model.calls).toHaveLength(1);
  });

  it("does not start later onTurnStart hooks after cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const model = createMockModel({ response: "must not run" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "first-hook",
          onTurnStart: async () => {
            calls.push("first");
            controller.abort(new DOMException("caller left", "AbortError"));
          },
        },
        {
          name: "second-hook",
          onTurnStart: async () => {
            calls.push("second");
          },
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-canceled-hooks", {
      signal: controller.signal,
    });

    expect(result.status).toBe("canceled");
    expect(calls).toEqual(["first"]);
    expect(model.calls).toHaveLength(0);
  });

  it("returns a failed turn when pinned context exceeds the model budget", async () => {
    const model = createMockModel({ response: "Must not run", maxContextTokens: 100 });
    const loop = createTurnLoop({
      augments: [
        {
          name: "identity",
          required: true,
          context: async () => [
            {
              source: "identity",
              content: "I".repeat(2_000),
              placement: "system",
              provenance: "identity",
              priority: "required",
              eviction: "never",
              origin: "operator",
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    const events: KernelEvent[] = [];

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-pinned-overflow", {
      onEvent: (event) => events.push(event),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.source).toBe("context-allocator");
    expect(result.error?.message).toBe("Context assembly failed.");
    expect(result.errorResponse).toContain("required context exceeds");
    expect(model.calls).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "run_error", source: "context-allocator" }),
    );
  });

  it("executes tool calls and loops back to model", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Tool returned: echoed-test",
      finishReason: "end_turn",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Echo this"), "thread-1");
    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("echo");
    expect(result.toolCalls[0]!.output).toBe("echoed-test");
    expect(model.calls).toHaveLength(2);
  });

  it("does not classify Error-prefixed plain string tool results as errors", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "fail_string", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Handled", finishReason: "end_turn" });

    const augment: Augment = {
      name: "error-tools",
      tools: [
        {
          name: "fail_string",
          description: "Return an expected string failure",
          category: "meta",
          input: z.object({}),
          execute: async () => "Error: NOT_PERSISTED: write failed",
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    const events: KernelEvent[] = [];

    const result = await loop.executeTurn(makeTrigger("Try it"), "thread-error-string", {
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool_call_result",
        output: "Error: NOT_PERSISTED: write failed",
        isError: false,
      }),
    );
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "fail_string",
        output: "Error: NOT_PERSISTED: write failed",
      }),
    ]);
  });

  it("marks structured ToolResult failures as errors", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "fail_structured", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Handled", finishReason: "end_turn" });

    const augment: Augment = {
      name: "error-tools",
      tools: [
        {
          name: "fail_structured",
          description: "Return an expected structured failure",
          category: "meta",
          input: z.object({}),
          execute: async (): Promise<ToolResult> => ({
            content: "The requested operation failed",
            isError: true,
          }),
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    const events: KernelEvent[] = [];

    const result = await loop.executeTurn(makeTrigger("Try it"), "thread-error-structured", {
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool_call_result",
        output: "The requested operation failed",
        isError: true,
      }),
    );
    expect(result.toolCalls).toHaveLength(0);
  });

  it("executes protected tools when delegated authorization claims satisfy requirements", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "read_orders", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "authorized", finishReason: "end_turn" });

    let observedAuth: RouteAuthContext | undefined;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "read_orders",
          description: "Read orders",
          category: "search",
          input: z.object({}),
          requires: { scope: "orders.read" },
          execute: async (_input, context) => {
            observedAuth = context?.auth;
            return "orders";
          },
        },
      ],
    };
    const auth = recognizedVisitorAuth({ scopes: ["orders.read"] });
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Read my orders", auth), "thread-authz-1");

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("orders");
    expect(observedAuth).toEqual(auth);
  });

  it("denies protected tools when delegated authorization claims are missing", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "read_orders", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "not authorized", finishReason: "end_turn" });

    let executeCalls = 0;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "read_orders",
          description: "Read orders",
          category: "search",
          input: z.object({}),
          requires: { scope: "orders.read" },
          execute: async () => {
            executeCalls += 1;
            return "orders";
          },
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    const trigger = makeTrigger(
      "Read my orders",
      recognizedVisitorAuth({ keyId: "2026-07", scopes: ["profile.read"], orgId: "org_abc" }),
    );
    const events: KernelEvent[] = [];

    const result = await loop.executeTurn(trigger, "thread-authz-2", {
      onEvent: (event) => events.push(event),
    });

    expect(executeCalls).toBe(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.map((m) => m.content).join("\n")).toContain(
      'Tool "read_orders" authorization denied: authorization-scope-missing',
    );
    const auditEvent = events.find((event) => event.kind === "delegated_authorization_denied");
    expect(auditEvent).toEqual({
      kind: "delegated_authorization_denied",
      reason: "authorization-scope-missing",
      requirement: { scope: "orders.read" },
      keyId: "2026-07",
      provider: "supabase",
      subject: "user_123",
      orgId: "org_abc",
      target: {
        type: "tool",
        toolName: "read_orders",
        augmentName: "orders",
        turnId: trigger.turnId,
        threadId: "thread-authz-2",
      },
    });
  });

  it("denies tools with malformed delegated authorization requirements", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "read_orders", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "not authorized", finishReason: "end_turn" });

    let executeCalls = 0;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "read_orders",
          description: "Read orders",
          category: "search",
          input: z.object({}),
          requires: { action: "" } as never,
          execute: async () => {
            executeCalls += 1;
            return "orders";
          },
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger("Read my orders", recognizedVisitorAuth({ scopes: ["orders.read"] })),
      "thread-authz-3",
    );

    expect(executeCalls).toBe(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(model.calls[1]!.messages.map((m) => m.content).join("\n")).toContain(
      'Tool "read_orders" has invalid authorization requirements',
    );
  });

  it("resolves protected tool grant resources from validated input", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "ord_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "refunded", finishReason: "end_turn" });

    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "refund_order",
          description: "Refund order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "orders.refund", resource: { input: "orderId" } },
          execute: async ({ orderId }) => `refunded-${orderId}`,
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger(
        "Refund my order",
        recognizedVisitorAuth({
          grants: [{ action: "orders.refund", resource: "ord_123" }],
        }),
      ),
      "thread-authz-input-1",
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("refunded-ord_123");
  });

  it("executes protected tools when broad action grants satisfy broad requirements", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_any_order", arguments: { orderId: "ord_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "refunded", finishReason: "end_turn" });

    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "refund_any_order",
          description: "Refund any order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "orders.refund" },
          execute: async ({ orderId }) => `refunded-${orderId}`,
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger(
        "Refund an order",
        recognizedVisitorAuth({
          grants: [{ action: "orders.refund" }],
        }),
      ),
      "thread-authz-input-broad-0",
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.output).toBe("refunded-ord_123");
  });

  it("does not use resource-scoped grants for broad action requirements", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_any_order", arguments: { orderId: "ord_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "not authorized", finishReason: "end_turn" });

    let executeCalls = 0;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "refund_any_order",
          description: "Refund any order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "orders.refund" },
          execute: async () => {
            executeCalls += 1;
            return "refunded";
          },
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger(
        "Refund an order",
        recognizedVisitorAuth({
          grants: [{ action: "orders.refund", resource: "ord_123" }],
        }),
      ),
      "thread-authz-input-broad-1",
    );

    expect(executeCalls).toBe(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(model.calls[1]!.messages.map((m) => m.content).join("\n")).toContain(
      'Tool "refund_any_order" authorization denied: authorization-grant-missing',
    );
  });

  it("denies protected tools when input resource fields are not top-level strings", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { order: { id: "ord_123" } } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "not authorized", finishReason: "end_turn" });

    let executeCalls = 0;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "refund_order",
          description: "Refund order",
          category: "meta",
          input: z.object({ order: z.object({ id: z.string() }) }),
          requires: { action: "orders.refund", resource: { input: "order.id" } },
          execute: async () => {
            executeCalls += 1;
            return "refunded";
          },
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger(
        "Refund my order",
        recognizedVisitorAuth({
          grants: [{ action: "orders.refund", resource: "ord_123" }],
        }),
      ),
      "thread-authz-input-2",
    );

    expect(executeCalls).toBe(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(model.calls[1]!.messages.map((m) => m.content).join("\n")).toContain(
      'Tool "refund_order" authorization denied: authorization-resource-unresolved',
    );
  });

  it("rejects path parameter bindings on tool requirements", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "refund_order", arguments: { orderId: "ord_123" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "not authorized", finishReason: "end_turn" });

    let executeCalls = 0;
    const ordersAugment: Augment = {
      name: "orders",
      tools: [
        {
          name: "refund_order",
          description: "Refund order",
          category: "meta",
          input: z.object({ orderId: z.string() }),
          requires: { action: "orders.refund", resource: { param: "id" } } as never,
          execute: async () => {
            executeCalls += 1;
            return "refunded";
          },
        },
      ],
    };
    const loop = createTurnLoop({
      augments: [ordersAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(
      makeTrigger(
        "Refund my order",
        recognizedVisitorAuth({
          grants: [{ action: "orders.refund", resource: "ord_123" }],
        }),
      ),
      "thread-authz-input-3",
    );

    expect(executeCalls).toBe(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(model.calls[1]!.messages.map((m) => m.content).join("\n")).toContain(
      'Tool "refund_order" has invalid authorization requirements',
    );
  });

  it("skips non-required augment context on error", async () => {
    const model = createMockModel({ response: "Still works" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "flaky",
          required: false,
          context: async () => {
            throw new Error("boom");
          },
        },
        {
          name: "stable",
          context: async () => "Stable context",
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(true);
  });

  it("aborts turn when required augment context fails", async () => {
    const model = createMockModel();
    const loop = createTurnLoop({
      augments: [
        {
          name: "critical",
          required: true,
          context: async () => {
            throw new Error("fatal");
          },
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-1");
    expect(result.success).toBe(false);
    expect(result.error?.source).toBe("critical");
    expect(model.calls).toHaveLength(0);
  });

  it("does not expose required-context exception text in kernel events", async () => {
    const sentinel = "sk-live-secret-required-context";
    const model = createMockModel();
    const events: KernelEvent[] = [];
    const loop = createTurnLoop({
      augments: [
        {
          name: "critical",
          required: true,
          context: async () => {
            throw new Error(sentinel);
          },
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });
    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-secret-context", {
      onEvent: (event) => events.push(event),
    });
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(result.errorResponse).not.toContain(sentinel);
    expect(JSON.stringify(result.error)).not.toContain(sentinel);
  });

  it("rejects an excessive provider tool-call structure before dispatch", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "echo", arguments: { input: "one" } },
        { name: "echo", arguments: { input: "two" } },
      ],
      finishReason: "tool_use",
    });
    let executions = 0;
    const loop = createTurnLoop({
      augments: [
        {
          name: "echo",
          tools: [
            {
              name: "echo",
              description: "Echo",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async () => {
                executions++;
                return "ok";
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: {
        name: "test",
        model: "mock",
        augments: [],
        responseLimits: { maxToolCalls: 1 },
      },
    });
    const result = await loop.executeTurn(makeTrigger("Hi"), "thread-response-limit");
    expect(result.success).toBe(false);
    expect(result.errorResponse).toBe("The model response exceeded a configured safety limit.");
    expect(executions).toBe(0);
  });

  it("enforces maxToolCallsPerTurn", async () => {
    const model = createMockModel();
    for (let i = 0; i < 10; i++) {
      model.pushResponse({
        content: "",
        toolCalls: [{ name: "echo", arguments: { input: `${i}` } }],
        finishReason: "tool_use",
      });
    }
    model.pushResponse({ content: "Done", finishReason: "end_turn" });

    const echoAugment: Augment = {
      name: "echo-aug",
      constraints: { maxToolCallsPerTurn: 3 },
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

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-1");
    expect(result.toolCalls.length).toBeLessThanOrEqual(3);
  });

  it("reserves parallel tool-call quota before dispatch", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "limited", arguments: { input: "one" } },
        { name: "limited", arguments: { input: "two" } },
        { name: "limited", arguments: { input: "three" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Done", finishReason: "end_turn" });
    const dispatched: string[] = [];
    const loop = createTurnLoop({
      augments: [
        {
          name: "limited-aug",
          constraints: { maxToolCallsPerTurn: 1 },
          tools: [
            {
              name: "limited",
              description: "Limited side effect",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async ({ input }) => {
                dispatched.push(input);
                return input;
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-parallel-limit");

    expect(dispatched).toEqual(["one"]);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("counts a throwing side-effecting attempt against the parallel batch quota", async () => {
    const sentinel = "sk-live-tool-exception-secret";
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "fragile", arguments: { input: "first" } },
        { name: "fragile", arguments: { input: "second" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Done", finishReason: "end_turn" });
    const attempts: string[] = [];
    const loop = createTurnLoop({
      augments: [
        {
          name: "fragile-aug",
          constraints: { maxToolCallsPerTurn: 1 },
          tools: [
            {
              name: "fragile",
              description: "May fail after beginning a side effect",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async ({ input }) => {
                attempts.push(input);
                throw new Error(sentinel);
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      await loop.executeTurn(makeTrigger("Go"), "thread-throwing-limit");
    } finally {
      console.warn = originalWarn;
    }

    expect(attempts).toEqual(["first"]);
    expect(JSON.stringify(model.calls[1])).not.toContain(sentinel);
    expect(JSON.stringify(model.calls[1])).toContain("Tool execution failed");
    expect(warnings.join("\n")).toContain("tool=fragile");
    expect(warnings.join("\n")).toContain("category=error-object");
    expect(warnings.join("\n")).not.toContain(sentinel);
  });

  it("counts a structured error attempt against the parallel batch quota", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "fragile_result", arguments: { input: "first" } },
        { name: "fragile_result", arguments: { input: "second" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "Done", finishReason: "end_turn" });
    const attempts: string[] = [];
    const loop = createTurnLoop({
      augments: [
        {
          name: "fragile-result-aug",
          constraints: { maxToolCallsPerTurn: 1 },
          tools: [
            {
              name: "fragile_result",
              description: "Return a structured failure after dispatch",
              category: "meta",
              input: z.object({ input: z.string() }),
              execute: async ({ input }) => {
                attempts.push(input);
                return { content: "failed after dispatch", isError: true };
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("Go"), "thread-error-result-limit");

    expect(attempts).toEqual(["first"]);
  });

  it("propagates caller cancellation to an in-flight tool and performs no second inference", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "cooperative", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "must not run", finishReason: "end_turn" });
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const loop = createTurnLoop({
      augments: [
        {
          name: "cooperative-aug",
          tools: [
            {
              name: "cooperative",
              description: "Wait for caller cancellation",
              category: "meta",
              input: z.object({}),
              execute: async (_input, context) => {
                observedSignal = context?.signal;
                markStarted();
                await new Promise<void>((resolve) => {
                  context?.signal?.addEventListener("abort", () => resolve(), { once: true });
                });
                context?.signal?.throwIfAborted();
                return "must not complete";
              },
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const pending = loop.executeTurn(makeTrigger("Go"), "thread-caller-abort", {
      signal: controller.signal,
    });
    await started;
    controller.abort(new DOMException("caller left", "AbortError"));
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result.status).toBe("canceled");
    expect(model.calls).toHaveLength(1);
  });

  it("terminates an outcome-unknown tool timeout without model retry", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "noncooperative", arguments: {} }],
      finishReason: "tool_use",
      costUsd: 0.001,
    });
    model.pushResponse({ content: "must not run", finishReason: "end_turn" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "noncooperative-aug",
          constraints: { toolTimeoutMs: 5 },
          tools: [
            {
              name: "noncooperative",
              description: "Ignore cancellation",
              category: "meta",
              input: z.object({}),
              execute: async () => await new Promise<string>(() => {}),
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-outcome-unknown");

    expect(result.status).toBe("failed");
    expect(result.errorResponse).toContain("outcome is unknown");
    expect(model.calls).toHaveLength(1);
  });

  it("terminates a structured outcome-unknown tool result without model retry", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "ambiguous_delivery", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "must not run", finishReason: "end_turn" });
    const loop = createTurnLoop({
      augments: [
        {
          name: "ambiguous-delivery-aug",
          tools: [
            {
              name: "ambiguous_delivery",
              description: "Report an ambiguous side-effecting delivery",
              category: "communication",
              input: z.object({}),
              execute: async () => ({
                content: "delivery response was lost",
                isError: true,
                outcomeUnknown: true,
              }),
            },
          ],
        },
      ],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Send"), "thread-ambiguous-delivery");

    expect(result.status).toBe("failed");
    expect(result.errorResponse).toContain("outcome is unknown");
    expect(model.calls).toHaveLength(1);
  });

  it("terminates tool loop after 2 consecutive validation failures for same tool", async () => {
    const model = createMockModel();
    // Model keeps sending invalid args for the same tool
    for (let i = 0; i < 5; i++) {
      model.pushResponse({
        content: "",
        toolCalls: [{ name: "strict", arguments: { wrong: "type" } }],
        finishReason: "tool_use",
      });
    }
    model.pushResponse({ content: "Gave up", finishReason: "end_turn" });

    const strictAugment: Augment = {
      name: "strict-aug",
      tools: [
        {
          name: "strict",
          description: "Requires a number",
          category: "meta",
          input: z.object({ value: z.number() }),
          execute: async ({ value }) => String(value * 2),
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [strictAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const _result = await loop.executeTurn(makeTrigger("Do it"), "thread-c2");
    // 1st call: model sends invalid → fail #1
    // 2nd call: model sends invalid → fail #2 → terminate message
    // 3rd call: model sees termination → gives up
    expect(model.calls.length).toBeLessThanOrEqual(3);
  });

  it("preserves model content text when tool calls are also present", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "Let me check that for you.",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "Here's what I found: echoed-test",
      finishReason: "end_turn",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Check"), "thread-c3");
    expect(result.success).toBe(true);

    const hm = loop.getHistoryManager("thread-c3");
    const history = hm.getHistory(100000);
    const assistantMessages = history.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages[0]!.content).toBe("Let me check that for you.");
  });

  it("executes multiple tool calls in parallel", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "slow1", arguments: { input: "a" } },
        { name: "slow2", arguments: { input: "b" } },
        { name: "slow3", arguments: { input: "c" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({
      content: "All done",
      finishReason: "end_turn",
    });

    const makeSlowTool = (name: string) => ({
      name,
      description: name,
      category: "meta" as const,
      input: z.object({ input: z.string() }),
      execute: async ({ input }: { input: string }) => {
        await new Promise((r) => setTimeout(r, 100));
        return `${name}:${input}`;
      },
    });

    const augment: Augment = {
      name: "slow-aug",
      tools: [makeSlowTool("slow1"), makeSlowTool("slow2"), makeSlowTool("slow3")],
    };

    const loop = createTurnLoop({
      augments: [augment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const start = Date.now();
    const result = await loop.executeTurn(makeTrigger("Go"), "thread-h1");
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.toolCalls).toHaveLength(3);
    // If parallel: ~100ms. If sequential: ~300ms. Allow margin.
    expect(elapsed).toBeLessThan(250);
  });

  it("stops gracefully when model returns finishReason 'length'", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "I was cut off mid-sen",
      finishReason: "max_tokens",
    });

    const loop = createTurnLoop({
      augments: [],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Write a long essay"), "thread-h9");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("I was cut off mid-sen");
    // Model should only be called once — no re-inference after length stop
    expect(model.calls).toHaveLength(1);
  });

  it("stops after tool execution if next inference returns finishReason 'max_tokens'", async () => {
    const model = createMockModel();
    // First call: tool request
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "echo", arguments: { input: "test" } }],
      finishReason: "tool_use",
    });
    // Second call: model gets cut off
    model.pushResponse({
      content: "Started to respond but was cu",
      finishReason: "max_tokens",
    });

    const echoAugment: Augment = {
      name: "echo-aug",
      tools: [
        {
          name: "echo",
          description: "Echo",
          category: "meta",
          input: z.object({ input: z.string() }),
          execute: async ({ input }) => `echoed-${input}`,
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [echoAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("Go"), "thread-h9b");
    expect(result.success).toBe(true);
    expect(extractText(result.response?.parts ?? [])).toBe("Started to respond but was cu");
    // Tool executed, then model called again, got max_tokens, loop stops
    expect(model.calls).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
  });
});

function recognizedVisitorAuth(
  opts: {
    keyId?: string;
    scopes?: readonly string[];
    grants?: readonly AuthorizationGrant[];
    orgId?: string;
  } = {},
): RouteAuthContext {
  return {
    mode: "visitor",
    state: "recognized",
    visitorId: "vis_app_user_123",
    agentId: "test",
    issuedAt: 1_000,
    expiresAt: 2_000,
    externalAuth: {
      ...(opts.keyId !== undefined ? { keyId: opts.keyId } : {}),
      provider: "supabase",
      subject: "user_123",
      ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
      ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      ...(opts.grants !== undefined ? { grants: opts.grants } : {}),
    },
    principal: {
      kind: "visitor",
      trustLevel: "public",
      publicSubstate: "recognized",
      visitorId: "vis_app_user_123",
      agentId: "test",
      externalAuth: {
        ...(opts.keyId !== undefined ? { keyId: opts.keyId } : {}),
        provider: "supabase",
        subject: "user_123",
        ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
        ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
        ...(opts.grants !== undefined ? { grants: opts.grants } : {}),
      },
    },
  };
}

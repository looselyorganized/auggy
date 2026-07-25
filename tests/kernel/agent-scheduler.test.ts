import { describe, expect, test } from "bun:test";
import { defineAgent } from "../../src/agent";
import { emptyTrace } from "../../src/kernel/trace-emitter";
import { OutcomeUnknownError } from "../../src/outcome-unknown";
import { z } from "zod";
import type {
  AssembledPrompt,
  Augment,
  InboundMessage,
  ModelClient,
  ModelResponse,
  SchedulerContext,
  TransportKernel,
  TurnResult,
  TurnTrigger,
} from "../../src/types";

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(text = "ok"): ModelResponse {
  return {
    content: text,
    toolCalls: [],
    finishReason: "end_turn",
    inputTokens: 1,
    outputTokens: 1,
  };
}

function trigger(turnId: string, threadId: string, source: string): TurnTrigger {
  const peer = {
    id: `peer:${source}`,
    kind: "human" as const,
    trustLevel: "creator" as const,
    sourceAugment: source,
  };
  return {
    type: "message",
    turnId,
    threadId,
    timestamp: Date.now(),
    source,
    peer,
    payload: {
      parts: [{ kind: "text", text: turnId }],
      sourceAugment: source,
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function capturedTransport(
  name: string,
  options: {
    concurrency?: number;
    maxQueueDepth?: number;
    onOutbound?: () => Promise<void>;
    onShutdown?: () => Promise<void>;
  } = {},
): { augment: Augment; kernel: () => TransportKernel } {
  let registered: TransportKernel | undefined;
  return {
    augment: {
      name,
      ...(options.onShutdown ? { onShutdown: options.onShutdown } : {}),
      transport: {
        concurrency: options.concurrency ?? 4,
        maxQueueDepth: options.maxQueueDepth ?? 20,
        identify: () => null,
        async register(kernel) {
          registered = kernel;
          if (options.onOutbound) {
            kernel.onOutbound(async () => options.onOutbound!());
          }
        },
      },
    },
    kernel() {
      if (!registered) throw new Error(`${name} was not registered`);
      return registered;
    },
  };
}

describe("agent-wide keyed turn scheduling", () => {
  test("rejects direct injection before startup is complete", async () => {
    const bootStarted = deferred();
    const releaseBoot = deferred();
    let modelCalls = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        modelCalls++;
        return response();
      },
    };
    const agent = defineAgent(
      {
        name: "startup-gated-injection",
        model: "mock",
        augments: [
          {
            name: "slow-boot",
            async onBoot() {
              bootStarted.resolve();
              await releaseBoot.promise;
            },
          },
        ],
      },
      model,
    );

    await expect(agent.inject(trigger("before-start", "thread", "test"))).rejects.toThrow(
      "Agent not started",
    );

    const starting = agent.start();
    await bootStarted.promise;
    await expect(agent.inject(trigger("during-start", "thread", "test"))).rejects.toThrow(
      "Agent not started",
    );
    expect(modelCalls).toBe(0);

    releaseBoot.resolve();
    await starting;
    try {
      expect((await agent.inject(trigger("after-start", "thread", "test"))).status).toBe(
        "completed",
      );
      expect(modelCalls).toBe(1);
    } finally {
      releaseBoot.resolve();
      await agent.stop();
    }
  });

  test("shares the global cap across transports and direct injection", async () => {
    const releases = [deferred(), deferred(), deferred()];
    const twoStarted = deferred();
    const prompts: AssembledPrompt[] = [];
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        const index = prompts.length;
        prompts.push(prompt);
        if (prompts.length === 2) twoStarted.resolve();
        await releases[index]!.promise;
        return response(`response-${index}`);
      },
    };
    const web = capturedTransport("web");
    const link = capturedTransport("link");
    const agent = defineAgent(
      {
        name: "scheduled",
        model: "mock",
        augments: [web.augment, link.augment],
        turnScheduling: {
          maxConcurrent: 2,
          maxQueued: 10,
          maxQueuedPerThread: 5,
          maxCausalDepth: 4,
        },
      },
      model,
    );
    await agent.start();

    try {
      const first = web.kernel().handleInbound(trigger("web-a", "a", "web"));
      const second = agent.inject(trigger("inject-b", "b", "internal"));
      await twoStarted.promise;
      const third = link.kernel().handleInbound(trigger("link-c", "c", "link"));
      await Promise.resolve();
      await Promise.resolve();
      expect(prompts).toHaveLength(2);
      expect(agent.health().scheduler).toMatchObject({
        activeTurns: 2,
        queuedTurns: 1,
      });

      releases[0]!.resolve();
      while (prompts.length < 3) await Promise.resolve();
      releases[1]!.resolve();
      releases[2]!.resolve();
      await Promise.all([first, second, third]);
      expect(agent.health().scheduler).toMatchObject({
        activeTurns: 0,
        queuedTurns: 0,
      });
    } finally {
      for (const release of releases) release.resolve();
      await agent.stop();
    }
  });

  test("keeps a same-thread successor behind outbound delivery", async () => {
    const firstDeliveryStarted = deferred();
    const releaseFirstDelivery = deferred();
    let deliveries = 0;
    const transport = capturedTransport("web", {
      onOutbound: async () => {
        deliveries++;
        if (deliveries === 1) {
          firstDeliveryStarted.resolve();
          await releaseFirstDelivery.promise;
        }
      },
    });
    const prompts: AssembledPrompt[] = [];
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        prompts.push(prompt);
        return response(`response-${prompts.length}`);
      },
    };
    const agent = defineAgent(
      {
        name: "ordered-delivery",
        model: "mock",
        augments: [transport.augment],
        turnScheduling: { maxConcurrent: 2 },
      },
      model,
    );
    await agent.start();

    try {
      const first = transport.kernel().handleInbound(trigger("first", "same", "web"));
      await firstDeliveryStarted.promise;
      const second = transport.kernel().handleInbound(trigger("second", "same", "web"));
      await Promise.resolve();
      await Promise.resolve();
      expect(prompts).toHaveLength(1);
      expect(deliveries).toBe(1);

      releaseFirstDelivery.resolve();
      await Promise.all([first, second]);
      expect(prompts).toHaveLength(2);
      expect(deliveries).toBe(2);
    } finally {
      releaseFirstDelivery.resolve();
      await agent.stop();
    }
  });

  test("runs a causal same-thread follow-up before releasing the parent lane", async () => {
    const hookStarted = deferred();
    const allowFollowup = deferred();
    const promptOrder: string[] = [];
    const schedulerAugment: Augment = {
      name: "causal-followup",
      async scheduleAfterTurn(result, context) {
        if (result.turnId !== "outer") return;
        hookStarted.resolve();
        await allowFollowup.promise;
        await context.inject(trigger("followup", "same", "web"));
      },
    };
    const transport = capturedTransport("web");
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        promptOrder.push(prompt.messages.at(-1)?.content ?? "");
        return response();
      },
    };
    const agent = defineAgent(
      {
        name: "causal-order",
        model: "mock",
        augments: [transport.augment, schedulerAugment],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 5,
          maxQueuedPerThread: 5,
          maxCausalDepth: 2,
        },
      },
      model,
    );
    await agent.start();

    try {
      const outer = transport.kernel().handleInbound(trigger("outer", "same", "web"));
      await hookStarted.promise;
      const successor = transport.kernel().handleInbound(trigger("successor", "same", "web"));
      allowFollowup.resolve();
      await Promise.all([outer, successor]);
      expect(promptOrder).toEqual(["outer", "followup", "successor"]);
    } finally {
      allowFollowup.resolve();
      await agent.stop();
    }
  });

  test("joins a detached causal child and applies its late quarantine before release", async () => {
    const childStarted = deferred();
    const releaseChild = deferred();
    let successorExecuted = false;
    const causal: Augment = {
      name: "detached-causal",
      async handleInternalTurn(current) {
        if (current.source !== "detached-child") return null;
        childStarted.resolve();
        await releaseChild.promise;
        return {
          turnId: current.turnId,
          success: false,
          status: "failed",
          outcomeUnknown: true,
          toolCalls: [],
          trace: emptyTrace({
            turnId: current.turnId,
            threadId: current.threadId ?? current.turnId,
            trigger: { type: current.type, sourceAugment: current.source },
          }),
        };
      },
      async scheduleAfterTurn(result, context) {
        if (result.turnId !== "outer") return;
        const detached = trigger("detached", "same", "web");
        void context.inject({
          ...detached,
          source: "detached-child",
          type: "internal",
          payload: {},
        });
      },
    };
    const transport = capturedTransport("web");
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        if (prompt.messages.at(-1)?.content === "successor") successorExecuted = true;
        return response();
      },
    };
    const agent = defineAgent(
      {
        name: "detached-causal",
        model: "mock",
        augments: [transport.augment, causal],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 5,
          maxQueuedPerThread: 5,
          maxCausalDepth: 2,
        },
      },
      model,
    );
    await agent.start();

    try {
      const outer = transport.kernel().handleInbound(trigger("outer", "same", "web"));
      await childStarted.promise;
      const successor = transport.kernel().handleInbound(trigger("successor", "same", "web"));
      await Promise.resolve();
      expect(successorExecuted).toBe(false);
      expect(agent.health().scheduler).toMatchObject({
        activeTurns: 1,
        queuedTurns: 1,
      });

      releaseChild.resolve();
      expect((await outer).status).toBe("completed");
      expect(await successor).toMatchObject({
        status: "rejected",
        rejection: { reason: "thread-quarantined" },
      });
      expect(successorExecuted).toBe(false);
    } finally {
      releaseChild.resolve();
      await agent.stop();
    }
  });

  test("quarantines outcome-unknown terminal hook failures before lane release", async () => {
    for (const hook of ["onTurnEnd", "scheduleAfterTurn"] as const) {
      const ambiguous: Augment = {
        name: `ambiguous-${hook}`,
        [hook]: async () => {
          throw new OutcomeUnknownError(`${hook} crossed a side-effect boundary`);
        },
      };
      const agent = defineAgent(
        {
          name: `ambiguous-${hook}`,
          model: "mock",
          augments: [ambiguous],
        },
        {
          maxContextTokens: 100_000,
          countTokens: (text) => Math.ceil(text.length / 4),
          async complete() {
            return response();
          },
        },
      );
      await agent.start();
      try {
        expect((await agent.inject(trigger(`${hook}-first`, hook, "test"))).status).toBe(
          "completed",
        );
        expect(await agent.inject(trigger(`${hook}-retry`, hook, "test"))).toMatchObject({
          status: "rejected",
          rejection: { reason: "thread-quarantined" },
        });
      } finally {
        await agent.stop();
      }
    }
  });

  test("revokes each terminal hook context before the next hook begins", async () => {
    let retainedContext: SchedulerContext | undefined;
    let lateResult: TurnResult | null = null;
    const capture: Augment = {
      name: "capture-context",
      async scheduleAfterTurn(_result, context) {
        retainedContext = context;
      },
    };
    const attemptLateUse: Augment = {
      name: "attempt-late-use",
      async scheduleAfterTurn() {
        lateResult = await retainedContext!.inject(trigger("late", "same", "test"));
      },
    };
    const agent = defineAgent(
      {
        name: "scoped-hook-context",
        model: "mock",
        augments: [capture, attemptLateUse],
      },
      {
        maxContextTokens: 100_000,
        countTokens: (text) => Math.ceil(text.length / 4),
        async complete() {
          return response();
        },
      },
    );
    await agent.start();
    try {
      expect((await agent.inject(trigger("outer", "same", "test"))).status).toBe("completed");
      expect(lateResult).toMatchObject({
        status: "rejected",
        rejection: { reason: "causal-context-expired" },
      });
      expect(agent.operationalSnapshot()).toMatchObject({
        turns: { rejected: 1 },
        scheduler: {
          rejectedByReason: { "causal-context-expired": 1 },
        },
      });
    } finally {
      await agent.stop();
    }
  });

  test("retains the lane for a canceled non-cooperative tool and rejects blind retry", async () => {
    const toolStarted = deferred();
    const releaseTool = deferred();
    let modelCalls = 0;
    let retryExecuted = false;
    const toolAugment: Augment = {
      name: "side-effecting-tool",
      tools: [
        {
          name: "place_order",
          description: "Place an order",
          category: "communication",
          input: z.object({}),
          async execute() {
            toolStarted.resolve();
            await releaseTool.promise;
            return "placed";
          },
        },
      ],
    };
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        modelCalls++;
        if (prompt.messages.at(-1)?.content === "retry") retryExecuted = true;
        return {
          content: "",
          toolCalls: [{ name: "place_order", arguments: {} }],
          finishReason: "tool_use",
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const agent = defineAgent(
      {
        name: "non-cooperative-tool",
        model: "mock",
        augments: [toolAugment],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 2,
          maxQueuedPerThread: 2,
          maxCausalDepth: 2,
        },
      },
      model,
    );
    const controller = new AbortController();
    await agent.start();

    try {
      const first = agent.inject(trigger("first", "order-thread", "test"), {
        signal: controller.signal,
      });
      await toolStarted.promise;
      controller.abort(new DOMException("caller left", "AbortError"));
      const retry = agent.inject(trigger("retry", "order-thread", "test"));
      await Promise.resolve();
      expect(retryExecuted).toBe(false);
      expect(agent.health().scheduler).toMatchObject({
        activeTurns: 1,
        queuedTurns: 1,
      });

      releaseTool.resolve();
      expect(await first).toMatchObject({
        status: "failed",
        outcomeUnknown: true,
      });
      expect(await retry).toMatchObject({
        status: "rejected",
        rejection: { reason: "thread-quarantined" },
      });
      expect(retryExecuted).toBe(false);
      expect(modelCalls).toBe(1);
    } finally {
      releaseTool.resolve();
      await agent.stop();
    }
  });

  test("cancels queued work before model execution and reuses capacity", async () => {
    const release = deferred();
    const started = deferred();
    const prompts: AssembledPrompt[] = [];
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          started.resolve();
          await release.promise;
        }
        return response();
      },
    };
    const agent = defineAgent(
      {
        name: "queued-cancel",
        model: "mock",
        augments: [],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 1,
          maxQueuedPerThread: 1,
        },
      },
      model,
    );
    await agent.start();

    try {
      const first = agent.inject(trigger("first", "a", "test"));
      await started.promise;
      const controller = new AbortController();
      const canceled = agent.inject(trigger("canceled", "b", "test"), {
        signal: controller.signal,
      });
      controller.abort(new DOMException("caller left", "AbortError"));
      expect(await canceled).toMatchObject({ status: "canceled" });
      const replacement = agent.inject(trigger("replacement", "c", "test"));
      release.resolve();
      await Promise.all([first, replacement]);
      expect(prompts).toHaveLength(2);
    } finally {
      release.resolve();
      await agent.stop();
    }
  });

  test("quarantines an outcome-unknown thread until trusted recovery", async () => {
    let unknown = true;
    const internal: Augment = {
      name: "ambiguous-side-effect",
      async handleInternalTurn(current) {
        if (current.source !== "ambiguous-side-effect") return null;
        return {
          turnId: current.turnId,
          success: !unknown,
          status: unknown ? "failed" : "completed",
          ...(unknown ? { outcomeUnknown: true } : {}),
          toolCalls: [],
          trace: emptyTrace({
            turnId: current.turnId,
            threadId: current.threadId ?? current.turnId,
            trigger: { type: current.type, sourceAugment: current.source },
          }),
        };
      },
    };
    const agent = defineAgent(
      {
        name: "quarantine",
        model: "mock",
        augments: [internal],
      },
      {
        maxContextTokens: 100_000,
        countTokens: (text) => Math.ceil(text.length / 4),
        async complete() {
          return response();
        },
      },
    );
    await agent.start();

    try {
      const first = await agent.inject({
        ...trigger("unknown", "thread", "ambiguous-side-effect"),
        type: "internal",
        payload: {},
      });
      expect(first.outcomeUnknown).toBe(true);
      const denied = await agent.inject(trigger("retry", "thread", "test"));
      expect(denied).toMatchObject({
        status: "rejected",
        rejection: { reason: "thread-quarantined" },
      });

      await agent.stop();
      await agent.start();
      const deniedAfterRestart = await agent.inject(trigger("restart-retry", "thread", "test"));
      expect(deniedAfterRestart).toMatchObject({
        status: "rejected",
        rejection: { reason: "thread-quarantined" },
      });

      unknown = false;
      expect(agent.recoverThread("thread")).toBe(true);
      const recovered = await agent.inject({
        ...trigger("recovered", "thread", "ambiguous-side-effect"),
        type: "internal",
        payload: {},
      });
      expect(recovered.status).toBe("completed");
    } finally {
      await agent.stop();
    }
  });

  test("drains active work before augment shutdown and rejects queued work", async () => {
    const release = deferred();
    const started = deferred();
    const events: string[] = [];
    const transport = capturedTransport("web", {
      onShutdown: async () => {
        events.push("shutdown");
      },
    });
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        events.push("model:start");
        started.resolve();
        await release.promise;
        events.push("model:end");
        return response();
      },
    };
    const agent = defineAgent(
      {
        name: "drain",
        model: "mock",
        augments: [transport.augment],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 2,
          maxQueuedPerThread: 2,
        },
      },
      model,
    );
    await agent.start();

    const active = transport.kernel().handleInbound(trigger("active", "a", "web"));
    await started.promise;
    const queued = transport.kernel().handleInbound(trigger("queued", "b", "web"));
    const stopping = agent.stop();
    expect(agent.operationalSnapshot()).toMatchObject({
      readiness: { accepting: false, state: "draining" },
      shutdown: { attempts: 1, completed: 0, inProgress: true },
    });
    expect(await queued).toMatchObject({
      status: "rejected",
      rejection: { reason: "runtime-stopping" },
    });
    await Promise.resolve();
    expect(events).toEqual(["model:start"]);
    release.resolve();
    await active;
    await stopping;
    expect(events).toEqual(["model:start", "model:end", "shutdown"]);
    expect(agent.operationalSnapshot().shutdown).toMatchObject({
      attempts: 1,
      completed: 1,
      inProgress: false,
    });
  });

  test("serializes concurrent stops so a late shutdown cannot corrupt a restart", async () => {
    const shutdownStarted = deferred();
    const releaseShutdown = deferred();
    let shutdownCalls = 0;
    const transport = capturedTransport("web", {
      onShutdown: async () => {
        shutdownCalls++;
        if (shutdownCalls === 1) {
          shutdownStarted.resolve();
          await releaseShutdown.promise;
        }
      },
    });
    const agent = defineAgent(
      { name: "serialized-lifecycle", model: "mock", augments: [transport.augment] },
      {
        maxContextTokens: 100_000,
        countTokens: (text) => Math.ceil(text.length / 4),
        async complete() {
          return response();
        },
      },
    );
    await agent.start();

    const firstStop = agent.stop();
    await shutdownStarted.promise;
    let secondSettled = false;
    const secondStop = agent.stop().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(agent.operationalSnapshot().shutdown).toMatchObject({
      attempts: 1,
      completed: 0,
      inProgress: true,
    });

    releaseShutdown.resolve();
    await Promise.all([firstStop, secondStop]);
    expect(shutdownCalls).toBe(1);
    expect(agent.operationalSnapshot().shutdown).toMatchObject({ attempts: 1, completed: 1 });

    await agent.start();
    expect(
      (await transport.kernel().handleInbound(trigger("after-restart", "new", "web"))).status,
    ).toBe("completed");
    await agent.stop();
    expect(shutdownCalls).toBe(2);
  });
});

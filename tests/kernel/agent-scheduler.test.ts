import { describe, expect, test } from "bun:test";
import { defineAgent } from "../../src/agent";
import { emptyTrace } from "../../src/kernel/trace-emitter";
import type {
  AssembledPrompt,
  Augment,
  InboundMessage,
  ModelClient,
  ModelResponse,
  TransportKernel,
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
  });
});

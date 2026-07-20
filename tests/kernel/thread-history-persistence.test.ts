import { describe, expect, it } from "bun:test";
import { defineAgent } from "@/agent";
import { createMockModel } from "@tests/fixtures/mock-model";
import type {
  AssembledPrompt,
  Augment,
  InboundMessage,
  ModelClient,
  ModelResponse,
  PeerIdentity,
  ThreadHistoryPersistence,
  ThreadHistorySnapshot,
  TransportKernel,
  TurnTrigger,
} from "@/types";

const PEER: PeerIdentity = {
  id: "visitor-1",
  kind: "human",
  trustLevel: "public",
  publicSubstate: "recognized",
  sourceAugment: "test-transport",
};

function trigger(threadId: string, text: string, peer: PeerIdentity = PEER): TurnTrigger {
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    threadId,
    timestamp: Date.now(),
    source: "test-transport",
    peer,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test-transport",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(content = "ok"): ModelResponse {
  return {
    content,
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "end_turn",
  };
}

function persistence(overrides: Partial<ThreadHistoryPersistence> = {}): ThreadHistoryPersistence {
  return {
    load: async () => null,
    assertAccess: async () => {},
    commit: async () => {},
    ...overrides,
  };
}

async function runtime(model: ModelClient, concurrency = 2, extraAugments: Augment[] = []) {
  let kernel: TransportKernel | undefined;
  const transport: Augment = {
    name: "test-transport",
    transport: {
      concurrency,
      register: async (registeredKernel) => {
        kernel = registeredKernel;
      },
      identify: () => null,
    },
  };
  const agent = defineAgent(
    { name: "thread-history-test", model: "mock", augments: [transport, ...extraAugments] },
    model,
  );
  await agent.start();
  if (!kernel) throw new Error("transport kernel was not registered");
  return { agent, kernel };
}

describe("kernel thread-history persistence", () => {
  it("requires injected continuations to prove the persisted thread owner", async () => {
    const model = createMockModel({ response: "private response" });
    const historyPersistence = persistence({
      assertAccess: async (_threadId, peer) => {
        if (peer.id !== PEER.id) throw new Error("history owner mismatch");
      },
    });
    const { agent, kernel } = await runtime(model);

    try {
      await kernel.handleInbound(trigger("injected-owner", "authorized"), {
        historyPersistence,
      });

      const otherPeer = { ...PEER, id: "visitor-2" };
      await expect(
        agent.inject(trigger("injected-owner", "read private history", otherPeer)),
      ).rejects.toThrow("history owner mismatch");

      const withoutPeer = trigger("injected-owner", "read without identity");
      withoutPeer.peer = null;
      if (withoutPeer.payload && "peer" in withoutPeer.payload) {
        withoutPeer.payload.peer = null;
      }
      await expect(agent.inject(withoutPeer)).rejects.toThrow("resolved peer identity is required");
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("fails closed before inference when durable restore throws", async () => {
    const model = createMockModel({ response: "must not run" });
    const { agent, kernel } = await runtime(model);
    const historyPersistence = persistence({
      load: async () => {
        throw new Error("history owner mismatch");
      },
    });

    try {
      await expect(
        kernel.handleInbound(trigger("restore-failure", "hello"), { historyPersistence }),
      ).rejects.toThrow("history owner mismatch");
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("rejects malformed durable history without partially installing it", async () => {
    const model = createMockModel({ response: "must not run" });
    const { agent, kernel } = await runtime(model);
    const historyPersistence = persistence({
      load: async () => ({
        version: 1,
        messages: [{ id: "bad", role: "system", content: "poison", tokenCount: -1 }],
      }),
    });

    try {
      await expect(
        kernel.handleInbound(trigger("malformed-history", "hello"), { historyPersistence }),
      ).rejects.toThrow("Invalid thread history message");
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("requires a resolved peer whenever persistence is requested", async () => {
    const model = createMockModel({ response: "must not run" });
    const { agent, kernel } = await runtime(model);
    const withoutPeer = trigger("missing-peer", "hello");
    withoutPeer.peer = null;
    (withoutPeer.payload as InboundMessage).peer = null;

    try {
      await expect(
        kernel.handleInbound(withoutPeer, { historyPersistence: persistence() }),
      ).rejects.toThrow("resolved peer identity is required");
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("does not replace unmanaged resident history when persistence is attached later", async () => {
    const model = createMockModel({ response: "" });
    const { agent, kernel } = await runtime(model);
    let loads = 0;
    const historyPersistence = persistence({
      load: async () => {
        loads++;
        return null;
      },
    });

    try {
      // Even an empty, zero-token message is resident history and must not be
      // silently discarded when a persistence provider appears later.
      await kernel.handleInbound(trigger("late-persistence", ""));
      await expect(
        kernel.handleInbound(trigger("late-persistence", "second"), { historyPersistence }),
      ).rejects.toThrow("unmanaged history already exists");
      expect(loads).toBe(0);
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("fails closed when a cached thread no longer passes its owner check", async () => {
    const model = createMockModel({ response: "first response" });
    const { agent, kernel } = await runtime(model);
    let accessChecks = 0;
    const historyPersistence = persistence({
      assertAccess: async () => {
        accessChecks++;
        throw new Error("thread belongs to another peer");
      },
    });

    try {
      await kernel.handleInbound(trigger("owner-check", "first"), { historyPersistence });
      await expect(
        kernel.handleInbound(trigger("owner-check", "second"), { historyPersistence }),
      ).rejects.toThrow("thread belongs to another peer");
      expect(accessChecks).toBe(1);
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("serializes work for one thread and commits both turns in order", async () => {
    const releases = [deferred(), deferred()];
    const starts = [deferred(), deferred()];
    const prompts: AssembledPrompt[] = [];
    let active = 0;
    let maxActive = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        const index = prompts.length;
        prompts.push(prompt);
        active++;
        maxActive = Math.max(maxActive, active);
        starts[index]!.resolve();
        await releases[index]!.promise;
        active--;
        return response(`response ${index + 1}`);
      },
    };
    const commits: ThreadHistorySnapshot[] = [];
    let loads = 0;
    const historyPersistence = persistence({
      load: async () => {
        loads++;
        return null;
      },
      commit: async (_threadId, _peer, snapshot) => {
        commits.push(snapshot);
      },
    });
    const { agent, kernel } = await runtime(model);

    try {
      const first = kernel.handleInbound(trigger("serial-thread", "first"), {
        historyPersistence,
      });
      await starts[0]!.promise;
      const second = kernel.handleInbound(trigger("serial-thread", "second"), {
        historyPersistence,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(prompts).toHaveLength(1);

      releases[0]!.resolve();
      await starts[1]!.promise;
      expect(maxActive).toBe(1);
      releases[1]!.resolve();
      await Promise.all([first, second]);

      expect(loads).toBe(1);
      expect(commits).toHaveLength(2);
      expect(commits[1]!.messages.map((message) => message.content)).toEqual([
        "first",
        "response 1",
        "second",
        "response 2",
      ]);
    } finally {
      releases.forEach((item) => {
        item.resolve();
      });
      await agent.stop();
    }
  });

  it("does not impose a global history lock across different threads", async () => {
    const bothStarted = deferred();
    const release = deferred();
    const prompts: AssembledPrompt[] = [];
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt) {
        prompts.push(prompt);
        if (prompts.length === 2) bothStarted.resolve();
        await release.promise;
        return response();
      },
    };
    const historyPersistence = persistence();
    const { agent, kernel } = await runtime(model);

    try {
      const first = kernel.handleInbound(trigger("parallel-a", "a"), { historyPersistence });
      const second = kernel.handleInbound(trigger("parallel-b", "b"), { historyPersistence });
      await Promise.race([
        bothStarted.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("different threads were globally serialized")), 500),
        ),
      ]);
      expect(prompts).toHaveLength(2);
      release.resolve();
      await Promise.all([first, second]);
    } finally {
      release.resolve();
      await agent.stop();
    }
  });

  it("surfaces commit failures after inference", async () => {
    const model = createMockModel({ response: "generated but not durable" });
    const { agent, kernel } = await runtime(model);
    let loads = 0;
    let commits = 0;
    const historyPersistence = persistence({
      load: async () => {
        loads++;
        return null;
      },
      commit: async () => {
        commits++;
        if (commits === 1) throw new Error("disk full");
      },
    });

    try {
      await expect(
        kernel.handleInbound(trigger("commit-failure", "hello"), { historyPersistence }),
      ).rejects.toThrow("disk full");
      expect(model.calls).toHaveLength(1);

      await kernel.handleInbound(trigger("commit-failure", "retry"), { historyPersistence });
      expect(loads).toBe(2);
      expect(model.calls[1]!.messages.map((message) => message.content)).toEqual(["retry"]);
    } finally {
      await agent.stop();
    }
  });

  it("commits the terminal user snapshot when model inference throws", async () => {
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete() {
        throw new Error("provider unavailable");
      },
    };
    const commits: ThreadHistorySnapshot[] = [];
    const historyPersistence = persistence({
      commit: async (_threadId, _peer, snapshot) => {
        commits.push(snapshot);
      },
    });
    const { agent, kernel } = await runtime(model);

    try {
      await expect(
        kernel.handleInbound(trigger("model-error", "persist me"), { historyPersistence }),
      ).rejects.toThrow("provider unavailable");
      expect(commits).toHaveLength(1);
      expect(commits[0]!.messages.map((message) => message.content)).toEqual(["persist me"]);
    } finally {
      await agent.stop();
    }
  });

  it("commits restored history when an already-aborted turn is canceled", async () => {
    const model = createMockModel({ response: "must not run" });
    const restored: ThreadHistorySnapshot = {
      version: 1,
      messages: [
        {
          id: "restored-user",
          role: "user",
          peerId: PEER.id,
          content: "previous",
          timestamp: 1,
          tokenCount: 2,
        },
      ],
    };
    const commits: ThreadHistorySnapshot[] = [];
    const historyPersistence = persistence({
      load: async () => restored,
      commit: async (_threadId, _peer, snapshot) => {
        commits.push(snapshot);
      },
    });
    const controller = new AbortController();
    controller.abort();
    const { agent, kernel } = await runtime(model);

    try {
      const result = await kernel.handleInbound(trigger("canceled", "ignored"), {
        historyPersistence,
        signal: controller.signal,
      });
      expect(result.status).toBe("canceled");
      expect(model.calls).toHaveLength(0);
      expect(commits).toEqual([restored]);
    } finally {
      await agent.stop();
    }
  });

  it("lets scheduleAfterTurn inject into the same persistent thread without deadlocking", async () => {
    const model = createMockModel({ response: "response" });
    let injected = false;
    let scheduledResultStatus: string | undefined;
    const scheduler: Augment = {
      name: "scheduler",
      scheduleAfterTurn: async (_result, context) => {
        if (injected) return;
        injected = true;
        const result = await context.inject(trigger("scheduled-thread", "scheduled"));
        scheduledResultStatus = result.status;
      },
    };
    let commits = 0;
    const historyPersistence = persistence({
      commit: async () => {
        commits++;
      },
    });
    const { agent, kernel } = await runtime(model, 2, [scheduler]);

    try {
      await Promise.race([
        kernel.handleInbound(trigger("scheduled-thread", "outer"), { historyPersistence }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("same-thread scheduled injection deadlocked")), 500),
        ),
      ]);
      expect(scheduledResultStatus).toBe("completed");
      expect(model.calls).toHaveLength(2);
      expect(commits).toBe(2);
    } finally {
      await agent.stop();
    }
  });

  it("forgets both the in-memory history and restore memo", async () => {
    const model = createMockModel({ response: "response" });
    const { agent, kernel } = await runtime(model);
    let loads = 0;
    const historyPersistence = persistence({
      load: async () => {
        loads++;
        return null;
      },
    });

    try {
      await kernel.handleInbound(trigger("forgotten", "old turn"), { historyPersistence });
      kernel.forgetThreadHistory?.("forgotten");
      await kernel.handleInbound(trigger("forgotten", "new turn"), { historyPersistence });

      expect(loads).toBe(2);
      expect(model.calls[1]!.messages.map((message) => message.content)).toEqual(["new turn"]);
    } finally {
      await agent.stop();
    }
  });

  it("reloads durable history after the resident history LRU evicts a thread", async () => {
    const model = createMockModel({ response: "response" });
    const { agent, kernel } = await runtime(model);
    const durable = new Map<string, ThreadHistorySnapshot>();
    const loads = new Map<string, number>();
    const historyPersistence = persistence({
      load: async (threadId) => {
        loads.set(threadId, (loads.get(threadId) ?? 0) + 1);
        return durable.get(threadId) ?? null;
      },
      commit: async (threadId, _peer, snapshot) => {
        durable.set(threadId, structuredClone(snapshot));
      },
    });

    try {
      await kernel.handleInbound(trigger("lru-first", "original"), { historyPersistence });
      for (let index = 0; index < 500; index++) {
        await kernel.handleInbound(trigger(`lru-${index}`, `message ${index}`), {
          historyPersistence,
        });
      }

      await kernel.handleInbound(trigger("lru-first", "revisit"), { historyPersistence });
      expect(loads.get("lru-first")).toBe(2);
      expect(model.calls.at(-1)!.messages.map((message) => message.content)).toEqual([
        "original",
        "response",
        "revisit",
      ]);
    } finally {
      await agent.stop();
    }
  });

  it("keeps the non-persistent transport path backwards compatible", async () => {
    const model = createMockModel({ response: "still works" });
    const { agent, kernel } = await runtime(model);

    try {
      const result = await kernel.handleInbound(trigger("no-persistence", "hello"));
      expect(result.success).toBe(true);
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("passes the caller AbortSignal through to model inference", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(_prompt, options) {
        observedSignal = options?.signal;
        return response();
      },
    };
    const { agent, kernel } = await runtime(model);

    try {
      await kernel.handleInbound(trigger("signal", "hello"), { signal: controller.signal });
      expect(observedSignal).toBe(controller.signal);
    } finally {
      await agent.stop();
    }
  });
});

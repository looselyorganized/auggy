import { describe, expect, it } from "bun:test";
import { defineAgent } from "@/agent";
import type { Augment, TransportKernel } from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";

function transportAugment(
  name: string,
  hooks: {
    boot?: () => Promise<void>;
    register?: (kernel: TransportKernel) => Promise<void>;
    ready?: () => Promise<void>;
    shutdown?: () => Promise<void>;
  },
): Augment {
  return {
    name,
    onBoot: hooks.boot,
    onShutdown: hooks.shutdown,
    transport: {
      register: hooks.register ?? (async () => {}),
      ready: hooks.ready,
      identify: () => null,
    },
  };
}

describe("transport readiness lifecycle", () => {
  it("boots all augments, registers all transports, then readies all transports", async () => {
    const events: string[] = [];
    const augments = ["a", "b"].map((name) =>
      transportAugment(name, {
        boot: async () => {
          events.push(`boot:${name}`);
        },
        register: async () => {
          events.push(`register:${name}`);
        },
        ready: async () => {
          events.push(`ready:${name}`);
        },
        shutdown: async () => {
          events.push(`shutdown:${name}`);
        },
      }),
    );
    const agent = defineAgent(
      { name: "readiness-order", model: "mock", augments },
      createMockModel(),
    );

    await agent.start();
    expect(events).toEqual(["boot:a", "boot:b", "register:a", "register:b", "ready:a", "ready:b"]);

    await agent.stop();
    expect(events.slice(-2)).toEqual(["shutdown:b", "shutdown:a"]);
  });

  it("rolls back only attempted augments when boot fails", async () => {
    const events: string[] = [];
    const augments: Augment[] = [
      {
        name: "a",
        onBoot: async () => {
          events.push("boot:a");
        },
        onShutdown: async () => {
          events.push("shutdown:a");
        },
      },
      {
        name: "b",
        onBoot: async () => {
          events.push("boot:b");
          throw new Error("boot exploded");
        },
        onShutdown: async () => {
          events.push("shutdown:b");
        },
      },
      {
        name: "never-attempted",
        onBoot: async () => {
          events.push("boot:never");
        },
        onShutdown: async () => {
          events.push("shutdown:never");
        },
      },
    ];
    const agent = defineAgent(
      { name: "boot-rollback", model: "mock", augments },
      createMockModel(),
    );

    await expect(agent.start()).rejects.toThrow("boot exploded");
    expect(events).toEqual(["boot:a", "boot:b", "shutdown:b", "shutdown:a"]);
    await agent.stop();
    expect(events).toEqual(["boot:a", "boot:b", "shutdown:b", "shutdown:a"]);
  });

  it("does not ready any transport when registration fails and rolls back in reverse", async () => {
    const events: string[] = [];
    const augments = [
      transportAugment("a", {
        boot: async () => {
          events.push("boot:a");
        },
        register: async () => {
          events.push("register:a");
        },
        ready: async () => {
          events.push("ready:a");
        },
        shutdown: async () => {
          events.push("shutdown:a");
        },
      }),
      transportAugment("b", {
        boot: async () => {
          events.push("boot:b");
        },
        register: async () => {
          events.push("register:b");
          throw new Error("register exploded");
        },
        ready: async () => {
          events.push("ready:b");
        },
        shutdown: async () => {
          events.push("shutdown:b");
        },
      }),
    ];
    const agent = defineAgent(
      { name: "register-rollback", model: "mock", augments },
      createMockModel(),
    );

    await expect(agent.start()).rejects.toThrow("register exploded");
    expect(events).toEqual([
      "boot:a",
      "boot:b",
      "register:a",
      "register:b",
      "shutdown:b",
      "shutdown:a",
    ]);
  });

  it("rolls back booted resources when route validation fails before registration", async () => {
    const events: string[] = [];
    const augments: Augment[] = [
      {
        name: "resource",
        onBoot: async () => {
          events.push("boot:resource");
        },
        onShutdown: async () => {
          events.push("shutdown:resource");
        },
      },
      {
        name: "invalid-route",
        httpRoutes: [
          {
            method: "GET",
            path: "/health",
            auth: "none",
            handler: async () => new Response("never"),
          },
        ],
        onShutdown: async () => {
          events.push("shutdown:invalid-route");
        },
      },
      transportAugment("transport", {
        register: async () => {
          events.push("register:transport");
        },
        ready: async () => {
          events.push("ready:transport");
        },
        shutdown: async () => {
          events.push("shutdown:transport");
        },
      }),
    ];
    const agent = defineAgent(
      { name: "route-rollback", model: "mock", augments },
      createMockModel(),
    );

    await expect(agent.start()).rejects.toThrow("route validation failed");
    expect(events).toEqual([
      "boot:resource",
      "shutdown:transport",
      "shutdown:invalid-route",
      "shutdown:resource",
    ]);
  });

  it("rolls back a partial readiness failure without masking the startup error", async () => {
    const events: string[] = [];
    const augments = [
      transportAugment("a", {
        ready: async () => {
          events.push("ready:a");
        },
        shutdown: async () => {
          events.push("shutdown:a");
        },
      }),
      transportAugment("b", {
        ready: async () => {
          events.push("ready:b");
          throw new Error("ready exploded");
        },
        shutdown: async () => {
          events.push("shutdown:b");
          throw new Error("cleanup also exploded");
        },
      }),
    ];
    const agent = defineAgent(
      { name: "ready-rollback", model: "mock", augments },
      createMockModel(),
    );
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(agent.start()).rejects.toThrow("ready exploded");
    } finally {
      console.warn = originalWarn;
    }

    expect(events).toEqual(["ready:a", "ready:b", "shutdown:b", "shutdown:a"]);
  });

  it("does not execute traffic received before every transport is ready", async () => {
    const model = createMockModel();
    let firstKernel: TransportKernel | null = null;
    let pendingInbound: ReturnType<TransportKernel["handleInbound"]> | null = null;
    const first = transportAugment("first", {
      register: async (kernel) => {
        firstKernel = kernel;
      },
      ready: async () => {
        pendingInbound = firstKernel!.handleInbound({
          type: "message",
          turnId: "during-startup",
          timestamp: Date.now(),
          source: "first",
          peer: null,
          payload: {
            parts: [{ kind: "text", text: "must not execute" }],
            sourceAugment: "first",
            peer: null,
            timestamp: Date.now(),
          },
        });
        // Attach a rejection observer immediately; the assertion below still
        // awaits the original promise after startup has rolled back.
        void pendingInbound.catch(() => {});
        await Promise.resolve();
        expect(model.calls).toHaveLength(0);
      },
    });
    const laterFailure = transportAugment("later", {
      ready: async () => {
        throw new Error("later readiness failed");
      },
    });
    const agent = defineAgent(
      { name: "startup-admission", model: "mock", augments: [first, laterFailure] },
      model,
    );

    await expect(agent.start()).rejects.toThrow("later readiness failed");
    expect(pendingInbound).not.toBeNull();
    await expect(pendingInbound!).rejects.toThrow("later readiness failed");
    expect(model.calls).toHaveLength(0);
  });
});

import { describe, test, expect } from "bun:test";
import { defineAgent } from "../../src/agent";
import type { Augment, AugmentHttpRoute, ModelClient } from "../../src/types";

function mockModel(): ModelClient {
  return {
    name: "mock",
    maxContextTokens: 100_000,
    complete: async () => ({
      finishReason: "end_turn",
      message: { role: "assistant", content: [{ kind: "text", text: "" }] },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as ModelClient;
}

function routeAug(name: string, routes: AugmentHttpRoute[]): Augment {
  return { name, httpRoutes: routes };
}

function r(method: "GET" | "POST", path: string): AugmentHttpRoute {
  return { method, path, auth: "bearer", handler: async () => new Response("ok") };
}

describe("agent.start() route wiring", () => {
  test("throws when two augments register the same route", async () => {
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [routeAug("a", [r("GET", "/x")]), routeAug("b", [r("GET", "/x")])],
      },
      mockModel(),
    );
    await expect(agent.start()).rejects.toThrow(/both registered HTTP route/);
  });

  test("throws when an augment registers a reserved path", async () => {
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [routeAug("hijack", [r("POST", "/agent/run")])],
      },
      mockModel(),
    );
    await expect(agent.start()).rejects.toThrow(/reserved/);
  });

  test("error message lists ALL collisions, not just the first", async () => {
    const agent = defineAgent(
      {
        name: "test",
        model: "mock",
        augments: [
          routeAug("a", [r("GET", "/agent/run")]),
          routeAug("b", [r("GET", "/health")]),
        ],
      },
      mockModel(),
    );
    let err: Error | null = null;
    try {
      await agent.start();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("/agent/run");
    expect(err!.message).toContain("/health");
  });

  test("no augments with httpRoutes — start succeeds", async () => {
    const agent = defineAgent(
      { name: "test", model: "mock", augments: [] },
      mockModel(),
    );
    await agent.start();
    await agent.stop();
  });
});

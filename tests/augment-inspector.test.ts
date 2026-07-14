import { describe, expect, test } from "bun:test";
import { inspectAugment } from "@/augment-inspector";
import type { Augment } from "@/types";

describe("inspectAugment", () => {
  test("reports concrete runtime surfaces in a stable shape", () => {
    const augment: Augment = {
      name: "complete",
      context: async () => [],
      tools: [],
      transport: {} as NonNullable<Augment["transport"]>,
      httpRoutes: [],
      adminInfo: async () => ({ augmentName: "complete", title: "Complete", sections: [] }),
      onBoot: async () => {},
      onShutdown: async () => {},
      onTurnStart: async () => {},
      onTurnEnd: async () => {},
      onIdle: async () => {},
      scheduleAfterTurn: async () => {},
      handleInternalTurn: async () => null,
      turnGate: {} as NonNullable<Augment["turnGate"]>,
    };

    expect(inspectAugment(augment)).toEqual({
      hasContext: true,
      toolCount: 0,
      usesSharedMemoryTools: false,
      isTransport: true,
      isMemoryProvider: false,
      httpRouteCount: 0,
      hasAdminInfo: true,
      lifecycleHooks: [
        "onBoot",
        "onShutdown",
        "onTurnStart",
        "onTurnEnd",
        "onIdle",
        "scheduleAfterTurn",
      ],
      handlesInternalTurns: true,
      hasTurnGate: true,
    });
  });

  test("models memory-bus context and shared tools for raw providers", () => {
    const provider: Augment = {
      name: "memory",
      memory: {} as NonNullable<Augment["memory"]>,
    };

    expect(inspectAugment(provider)).toMatchObject({
      hasContext: true,
      toolCount: 0,
      usesSharedMemoryTools: true,
      isMemoryProvider: true,
    });
  });

  test("reads boot-populated tools and routes lazily", () => {
    const augment: Augment = { name: "dynamic", tools: [], httpRoutes: [] };
    expect(inspectAugment(augment)).toMatchObject({ toolCount: 0, httpRouteCount: 0 });

    augment.tools!.push({} as NonNullable<Augment["tools"]>[number]);
    augment.httpRoutes!.push({} as NonNullable<Augment["httpRoutes"]>[number]);

    expect(inspectAugment(augment)).toMatchObject({ toolCount: 1, httpRouteCount: 1 });
  });
});

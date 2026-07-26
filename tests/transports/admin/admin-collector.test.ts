import { describe, expect, it, spyOn } from "bun:test";
import {
  collectAdminInfoBlocks,
  collectAugmentSummaries,
} from "@/transports/admin/admin-collector";
import type { AgentCard, Augment, TransportKernel, TurnResult } from "@/types";

function mockKernel(augments: Augment[]): TransportKernel {
  const card: AgentCard = {
    provider: { name: "zip" },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      memory: false,
      transport: true,
    },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
  return {
    // handleInbound isn't exercised by collector tests; minimal stub.
    handleInbound: async () => ({}) as unknown as TurnResult,
    onOutbound: () => {},
    quarantineThread: () => true,
    recoverThread: () => false,
    getAgentCard: () => card,
    getAugmentRoutes: () => [],
    getAugments: () => augments,
  };
}

function mockAugment(overrides: Partial<Augment> = {}): Augment {
  return {
    name: "test-augment",
    ...overrides,
  };
}

describe("admin-collector", () => {
  it("reports structural augment surfaces without capability declarations", () => {
    const summaries = collectAugmentSummaries(
      mockKernel([
        mockAugment({
          name: "catalog",
          type: "catalog",
          tools: [],
          context: async () => [],
          onBoot: async () => {},
          handleInternalTurn: async () => null,
        }),
        mockAugment({
          name: "memory",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults: {
              mutable: true,
              origin: "operator",
              priority: "high",
              placement: "preamble",
              eviction: "drop",
              ttl: "persistent",
            },
            writeTrustLevels: ["creator"],
            read: async () => null,
            write: async () => undefined,
          },
        }),
      ]),
    );

    expect(summaries[0]).toMatchObject({
      name: "catalog",
      hasContext: true,
      toolCount: 0,
      usesSharedMemoryTools: false,
      lifecycleHooks: ["onBoot"],
      handlesInternalTurns: true,
    });
    expect(summaries[0]).not.toHaveProperty("capabilities");
    expect(summaries[0]).not.toHaveProperty("hasTools");
    expect(summaries[1]).toMatchObject({
      hasContext: true,
      usesSharedMemoryTools: true,
      isMemoryProvider: true,
      memory: {
        ownership: { kind: "static", labels: ["learned"] },
        mutable: true,
        origin: "operator",
        priority: "high",
        placement: "preamble",
        eviction: "drop",
        ttl: "persistent",
        writeTrustLevels: ["creator"],
      },
    });
  });

  it("returns empty list when no augments are registered", async () => {
    const blocks = await collectAdminInfoBlocks(mockKernel([]));
    expect(blocks).toEqual([]);
  });

  it("returns empty list when no augments declare adminInfo", async () => {
    const blocks = await collectAdminInfoBlocks(
      mockKernel([mockAugment({ name: "a" }), mockAugment({ name: "b" })]),
    );
    expect(blocks).toEqual([]);
  });

  it("collects blocks from augments that declare adminInfo", async () => {
    const aug = mockAugment({
      name: "test",
      adminInfo: async () => ({
        augmentName: "test",
        title: "Test",
        sections: [{ kind: "status", level: "ok", message: "all good" }],
      }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([aug]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe("Test");
  });

  it("preserves augment registration order", async () => {
    const a = mockAugment({
      name: "a",
      adminInfo: async () => ({ augmentName: "a", title: "A", sections: [] }),
    });
    const b = mockAugment({
      name: "b",
      adminInfo: async () => ({ augmentName: "b", title: "B", sections: [] }),
    });
    const c = mockAugment({
      name: "c",
      adminInfo: async () => ({ augmentName: "c", title: "C", sections: [] }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([a, b, c]));
    expect(blocks.map((b) => b.title)).toEqual(["A", "B", "C"]);
  });

  it("renders an error status section when an augment's adminInfo throws", async () => {
    const sentinel = "GROUP8_ADMIN_INFO_SECRET";
    const logLines: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...values) => {
      logLines.push(values.map(String).join(" "));
    });
    const broken = mockAugment({
      name: "broken",
      adminInfo: async () => {
        throw new Error(sentinel);
      },
    });
    const ok = mockAugment({
      name: "ok",
      adminInfo: async () => ({ augmentName: "ok", title: "OK", sections: [] }),
    });
    const blocks = await collectAdminInfoBlocks(mockKernel([broken, ok])).finally(() => {
      errorSpy.mockRestore();
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.augmentName).toBe("broken");
    expect(blocks[0]?.sections[0]).toMatchObject({
      kind: "status",
      level: "error",
      message: "Failed to load admin info.",
    });
    expect(JSON.stringify(blocks)).not.toContain(sentinel);
    expect(logLines.join("\n")).not.toContain(sentinel);
    expect(blocks[1]?.title).toBe("OK");
  });
});

import { describe, it, expect } from "bun:test";
import { createMemoryTools } from "@/memory/tools";
import { buildRegistry } from "@/memory/registry";
import type { Augment, MemoryDefaults, MemoryEntry, ToolExecuteContext } from "@/types";

const peerDerivedDefaults: MemoryDefaults = {
  mutable: true,
  origin: "peer-derived",
  priority: "normal",
  placement: "preamble",
  eviction: "drop",
};

const CREATOR_CTX: ToolExecuteContext = {
  turnId: "t-origin",
  peer: { id: "op", kind: "human", trustLevel: "creator", sourceAugment: "test" },
  threadId: "th-origin",
};

describe("memory_search payload includes per-entry origin (Phase 1b Task 7)", () => {
  it("forwards origin field for entries that carry it", async () => {
    const entries: MemoryEntry[] = [
      { label: "ep:vis_a:1", content: "agent paraphrase fact", origin: "agent-derived" },
      { label: "ep:vis_a:2", content: "verbatim peer note", origin: "peer-derived" },
    ];
    const providers: Augment[] = [
      {
        name: "episodic",
        memory: {
          owns: { kind: "namespace", prefix: "ep:" },
          defaults: peerDerivedDefaults,
          search: async () => entries as MemoryEntry[],
        },
      },
    ];
    const registry = buildRegistry(providers);
    const { tools } = createMemoryTools(registry);
    const searchTool = tools.find((t) => t.name === "memory_search")!;

    const raw = await searchTool.execute({ query: "any" }, CREATOR_CTX);
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw as string) as Array<{
      provider: string;
      entries: Array<{ label: string; content: string; origin?: string }>;
    }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.provider).toBe("episodic");
    expect(parsed[0]!.entries).toHaveLength(2);
    const byLabel = Object.fromEntries(parsed[0]!.entries.map((e) => [e.label, e]));
    expect(byLabel["ep:vis_a:1"]!.origin).toBe("agent-derived");
    expect(byLabel["ep:vis_a:2"]!.origin).toBe("peer-derived");
  });

  it("omits origin field for entries that don't carry it (no fabricated default)", async () => {
    const entries: MemoryEntry[] = [
      // Plain MemoryEntry — provider tracks no origin per entry. Even though
      // the provider's defaults.origin is "peer-derived", the search payload
      // must not invent a per-entry origin where the entry has none. The
      // context-allocator (Task 8) handles the fallback at render time.
      { label: "ep:vis_b:1", content: "no-origin entry" },
    ];
    const providers: Augment[] = [
      {
        name: "episodic",
        memory: {
          owns: { kind: "namespace", prefix: "ep:" },
          defaults: peerDerivedDefaults,
          search: async () => entries as MemoryEntry[],
        },
      },
    ];
    const registry = buildRegistry(providers);
    const { tools } = createMemoryTools(registry);
    const searchTool = tools.find((t) => t.name === "memory_search")!;

    const raw = await searchTool.execute({ query: "any" }, CREATOR_CTX);
    const parsed = JSON.parse(raw as string) as Array<{
      provider: string;
      entries: Array<{ label: string; content: string; origin?: string }>;
    }>;

    expect(parsed[0]!.entries[0]!.origin).toBeUndefined();
  });

  it("preserves all existing MemoryEntry fields alongside origin", async () => {
    const entries: MemoryEntry[] = [
      {
        label: "ep:vis_c:1",
        content: "fact",
        origin: "agent-derived",
        peerId: "vis_c",
        trustLevel: "public",
        createdAt: 1700000000000,
        retentionClass: "lesson",
        isVerbatim: false,
      },
    ];
    const providers: Augment[] = [
      {
        name: "episodic",
        memory: {
          owns: { kind: "namespace", prefix: "ep:" },
          defaults: peerDerivedDefaults,
          search: async () => entries as MemoryEntry[],
        },
      },
    ];
    const registry = buildRegistry(providers);
    const { tools } = createMemoryTools(registry);
    const searchTool = tools.find((t) => t.name === "memory_search")!;

    const raw = await searchTool.execute({ query: "any" }, CREATOR_CTX);
    const parsed = JSON.parse(raw as string) as Array<{
      provider: string;
      entries: Array<{
        label: string;
        content: string;
        origin?: string;
        peerId?: string;
        trustLevel?: string;
        retentionClass?: string;
      }>;
    }>;

    const entry = parsed[0]!.entries[0]!;
    expect(entry.label).toBe("ep:vis_c:1");
    expect(entry.content).toBe("fact");
    expect(entry.origin).toBe("agent-derived");
    expect(entry.peerId).toBe("vis_c");
    expect(entry.trustLevel).toBe("public");
    expect(entry.retentionClass).toBe("lesson");
  });
});

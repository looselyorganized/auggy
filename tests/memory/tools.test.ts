import { describe, it, expect } from "bun:test";
import { createMemoryTools } from "@/memory/tools";
import { buildRegistry } from "@/memory/registry";
import type { Augment, MemoryDefaults } from "@/types";

const defaults: MemoryDefaults = {
  mutable: true,
  origin: "system",
  priority: "normal",
  placement: "preamble",
  eviction: "drop",
};

describe("createMemoryTools", () => {
  it("creates four tools with correct names", () => {
    const registry = buildRegistry([]);
    const { tools } = createMemoryTools(registry);
    expect(tools.map((t) => t.name)).toEqual([
      "memory_read",
      "memory_write",
      "memory_search",
      "memory_list",
    ]);
  });

  describe("memory_read", () => {
    it("reads from a static provider by label", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async (label) =>
              label === "self" ? { label, content: "I am an agent" } : null,
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "self" });
      expect(result).toContain("I am an agent");
    });

    it("returns error for unknown label", async () => {
      const registry = buildRegistry([]);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "missing" });
      expect(result).toMatch(/no provider owns/i);
    });

    it("returns error when provider lacks read method", async () => {
      const providers: Augment[] = [
        {
          name: "ns",
          memory: {
            owns: { kind: "namespace", prefix: "ns:" },
            defaults,
            search: async () => [],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "ns:foo" });
      expect(result).toMatch(/does not support/i);
    });
  });

  describe("memory_write", () => {
    it("writes to a mutable provider", async () => {
      const writes: Array<{ label: string; content: string }> = [];
      const providers: Augment[] = [
        {
          name: "notes",
          memory: {
            owns: { kind: "static", labels: ["notes"] },
            defaults,
            read: async () => null,
            write: async (label, content) => {
              writes.push({ label, content });
            },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute({
        label: "notes",
        content: "new note",
      });
      expect(writes).toEqual([{ label: "notes", content: "new note" }]);
      expect(result).toMatch(/success/i);
    });

    it("rejects writes to immutable providers", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async () => null,
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute({
        label: "self",
        content: "tampered",
      });
      expect(result).toMatch(/immutable/i);
    });

    it("blocks untrusted peer from writing to origin:system label", async () => {
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async () => {},
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "learned", content: "poisoned" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/requires facility or operator/i);
    });

    it("blocks authenticated peer from writing to origin:system label", async () => {
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async () => {},
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "learned", content: "poisoned" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "authenticated", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/requires facility or operator/i);
    });

    it("allows operator to write to origin:system label", async () => {
      const writes: string[] = [];
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async (_l, c) => { writes.push(c); },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "learned", content: "operator note" },
        { turnId: "t1", peer: { id: "op", kind: "human", trustLevel: "operator", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/success/i);
      expect(writes).toEqual(["operator note"]);
    });

    it("allows facility to write to origin:system label", async () => {
      const writes: string[] = [];
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async (_l, c) => { writes.push(c); },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "learned", content: "facility update" },
        { turnId: "t1", peer: { id: "agent-1", kind: "agent", trustLevel: "facility", sourceAugment: "spine" }, threadId: "th1" },
      );
      expect(result).toMatch(/success/i);
      expect(writes).toEqual(["facility update"]);
    });

    it("allows untrusted peer to write to origin:peer-derived label", async () => {
      const writes: string[] = [];
      const peerDerivedDefaults: MemoryDefaults = { ...defaults, origin: "peer-derived" };
      const providers: Augment[] = [
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "ep:" },
            defaults: peerDerivedDefaults,
            search: async () => [],
            write: async (_l, c) => { writes.push(c); },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "ep:note", content: "visitor memory" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/success/i);
      expect(writes).toEqual(["visitor memory"]);
    });

    it("allows write with null context (internal trigger = operator trust)", async () => {
      const writes: string[] = [];
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async (_l, c) => { writes.push(c); },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute({ label: "learned", content: "internal" });
      expect(result).toMatch(/success/i);
      expect(writes).toEqual(["internal"]);
    });
  });

  describe("memory_search", () => {
    it("searches across all namespace providers", async () => {
      const providers: Augment[] = [
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "episode:" },
            defaults,
            search: async (q) => [
              { label: "episode:1", content: `result for ${q}` },
            ],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute({ query: "hello" });
      expect(result).toContain("episodic");
      expect(result).toContain("result for hello");
    });

    it("returns empty list when no searchable providers exist", async () => {
      const registry = buildRegistry([]);
      const { tools } = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute({ query: "hi" });
      expect(result).toMatch(/no searchable/i);
    });
  });

  describe("memory_list", () => {
    it("lists static labels and namespace prefixes", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self", "notes"] },
            defaults,
            read: async () => null,
          },
        },
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "episode:" },
            defaults,
            search: async () => [],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const listTool = tools.find((t) => t.name === "memory_list")!;
      const result = await listTool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.static).toContain("self");
      expect(parsed.static).toContain("notes");
      expect(parsed.namespaces).toContain("episode:*");
    });
  });

  describe("budget", () => {
    it("enforces the memory operation budget per turn", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async () => ({ label: "self", content: "hi" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry, { maxPerTurn: 2 });
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const ctx = { turnId: "t1", peer: null, threadId: "th1" };
      await readTool.execute({ label: "self" }, ctx);
      await readTool.execute({ label: "self" }, ctx);
      const third = await readTool.execute({ label: "self" }, ctx);
      expect(third).toMatch(/budget exceeded/i);
    });

    it("different turnIds get independent budgets", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async () => ({ label: "self", content: "hi" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry, { maxPerTurn: 2 });
      const readTool = tools.find((t) => t.name === "memory_read")!;

      const ctxA = { turnId: "turn-A", peer: null, threadId: "th1" };
      const ctxB = { turnId: "turn-B", peer: null, threadId: "th1" };

      await readTool.execute({ label: "self" }, ctxA);
      await readTool.execute({ label: "self" }, ctxA);
      const exhausted = await readTool.execute({ label: "self" }, ctxA);
      expect(exhausted).toMatch(/budget exceeded/i);

      const resultB = await readTool.execute({ label: "self" }, ctxB);
      expect(resultB).toContain("hi");
    });

    it("exhausting one turnId does not affect another", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async () => ({ label: "self", content: "hi" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry, { maxPerTurn: 1 });
      const readTool = tools.find((t) => t.name === "memory_read")!;

      await readTool.execute({ label: "self" }, { turnId: "turn-A", peer: null, threadId: "th1" });
      const failA = await readTool.execute({ label: "self" }, { turnId: "turn-A", peer: null, threadId: "th1" });
      expect(failA).toMatch(/budget exceeded/i);

      const okB = await readTool.execute({ label: "self" }, { turnId: "turn-B", peer: null, threadId: "th1" });
      expect(okB).toContain("hi");

      const okC = await readTool.execute({ label: "self" }, { turnId: "turn-C", peer: null, threadId: "th1" });
      expect(okC).toContain("hi");
    });
  });
});

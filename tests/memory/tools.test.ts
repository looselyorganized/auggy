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
    const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "self" });
      expect(result).toContain("I am an agent");
    });

    it("returns error for unknown label", async () => {
      const registry = buildRegistry([]);
      const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute({
        label: "self",
        content: "tampered",
      });
      expect(result).toMatch(/immutable/i);
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
      const tools = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute({ query: "hello" });
      expect(result).toContain("episodic");
      expect(result).toContain("result for hello");
    });

    it("returns empty list when no searchable providers exist", async () => {
      const registry = buildRegistry([]);
      const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry);
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
      const tools = createMemoryTools(registry, { maxPerTurn: 2 });
      const readTool = tools.find((t) => t.name === "memory_read")!;
      await readTool.execute({ label: "self" });
      await readTool.execute({ label: "self" });
      const third = await readTool.execute({ label: "self" });
      expect(third).toMatch(/budget exceeded/i);
    });
  });
});

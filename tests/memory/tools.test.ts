import { describe, it, expect } from "bun:test";
import { createMemoryTools } from "@/memory/tools";
import { buildRegistry } from "@/memory/registry";
import type { Augment, MemoryDefaults, ToolExecuteContext } from "@/types";

const defaults: MemoryDefaults = {
  mutable: true,
  origin: "system",
  priority: "normal",
  placement: "preamble",
  eviction: "drop",
};

const DEFAULT_CTX: ToolExecuteContext = {
  turnId: "test-turn",
  peer: { id: "test-peer", kind: "human", trustLevel: "operator", sourceAugment: "test" },
  threadId: "test-thread",
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
      const result = await readTool.execute({ label: "self" }, DEFAULT_CTX);
      expect(result).toContain("I am an agent");
    });

    it("returns error for unknown label", async () => {
      const registry = buildRegistry([]);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "missing" }, DEFAULT_CTX);
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
      const result = await readTool.execute({ label: "ns:foo" }, DEFAULT_CTX);
      expect(result).toMatch(/does not support/i);
    });

    it("blocks untrusted peer from reading origin:operator label", async () => {
      const operatorDefaults: MemoryDefaults = { ...defaults, origin: "operator" };
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults: operatorDefaults,
            read: async () => ({ label: "self", content: "operator-only content" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute(
        { label: "self" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/requires facility or operator/i);
      expect(result).not.toContain("operator-only content");
    });

    it("blocks untrusted peer from reading origin:system label", async () => {
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => ({ label: "learned", content: "system content" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute(
        { label: "learned" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toMatch(/requires facility or operator/i);
      expect(result).not.toContain("system content");
    });

    it("allows untrusted peer to read origin:peer-derived label", async () => {
      const peerDerivedDefaults: MemoryDefaults = { ...defaults, origin: "peer-derived" };
      const providers: Augment[] = [
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "ep:" },
            defaults: peerDerivedDefaults,
            search: async () => [],
            read: async (label) => ({ label, content: "visitor entry" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute(
        { label: "ep:note" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toContain("visitor entry");
    });

    it("allows operator to read origin:operator label", async () => {
      const operatorDefaults: MemoryDefaults = { ...defaults, origin: "operator" };
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults: operatorDefaults,
            read: async () => ({ label: "self", content: "operator content" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute(
        { label: "self" },
        { turnId: "t1", peer: { id: "op", kind: "human", trustLevel: "operator", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toContain("operator content");
    });

    it("denies read when context is missing", async () => {
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults,
            read: async () => ({ label: "self", content: "x" }),
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const result = await readTool.execute({ label: "self" });
      expect(result).toMatch(/requires turn context/i);
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
            write: async (label: string, content: string) => {
              writes.push({ label, content });
            },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "notes", content: "new note" },
        DEFAULT_CTX,
      );
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
      const result = await writeTool.execute(
        { label: "self", content: "tampered" },
        DEFAULT_CTX,
      );
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
            write: async (_l: string, c: string) => { writes.push(c); },
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
            write: async (_l: string, c: string) => { writes.push(c); },
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
            write: async (_l: string, c: string) => { writes.push(c); },
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

    it("denies write when context is missing (fail-closed)", async () => {
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
      const result = await writeTool.execute({ label: "learned", content: "no context" });
      expect(result).toMatch(/requires turn context/i);
    });

    it("allows write with null peer in context (internal trigger = operator trust)", async () => {
      const writes: string[] = [];
      const providers: Augment[] = [
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
            write: async (_l: string, c: string) => { writes.push(c); },
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const writeTool = tools.find((t) => t.name === "memory_write")!;
      const result = await writeTool.execute(
        { label: "learned", content: "internal" },
        { turnId: "t1", peer: null, threadId: "th1" },
      );
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
      const result = await searchTool.execute({ query: "hello" }, DEFAULT_CTX);
      expect(result).toContain("episodic");
      expect(result).toContain("result for hello");
    });

    it("returns empty list when no searchable providers exist", async () => {
      const registry = buildRegistry([]);
      const { tools } = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute({ query: "hi" }, DEFAULT_CTX);
      expect(result).toMatch(/no searchable/i);
    });

    it("filters out providers with non-peer-derived origin for untrusted peer", async () => {
      const peerDerivedDefaults: MemoryDefaults = { ...defaults, origin: "peer-derived" };
      const providers: Augment[] = [
        {
          name: "system-notes",
          memory: {
            owns: { kind: "namespace", prefix: "sys:" },
            defaults,
            search: async () => [{ label: "sys:secret", content: "should be filtered" }],
          },
        },
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "ep:" },
            defaults: peerDerivedDefaults,
            search: async () => [{ label: "ep:note", content: "visible" }],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute(
        { query: "secret" },
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).not.toContain("should be filtered");
      expect(result).not.toContain("system-notes");
      expect(result).toContain("visible");
    });

    it("operator sees all namespace providers in search", async () => {
      const peerDerivedDefaults: MemoryDefaults = { ...defaults, origin: "peer-derived" };
      const providers: Augment[] = [
        {
          name: "system-notes",
          memory: {
            owns: { kind: "namespace", prefix: "sys:" },
            defaults,
            search: async () => [{ label: "sys:secret", content: "system result" }],
          },
        },
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "ep:" },
            defaults: peerDerivedDefaults,
            search: async () => [{ label: "ep:note", content: "visitor result" }],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute(
        { query: "anything" },
        { turnId: "t1", peer: { id: "op", kind: "human", trustLevel: "operator", sourceAugment: "web" }, threadId: "th1" },
      );
      expect(result).toContain("system result");
      expect(result).toContain("visitor result");
    });

    it("denies search when context is missing", async () => {
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
      const searchTool = tools.find((t) => t.name === "memory_search")!;
      const result = await searchTool.execute({ query: "x" });
      expect(result).toMatch(/requires turn context/i);
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
      const result = await listTool.execute({}, DEFAULT_CTX);
      const parsed = JSON.parse(result);
      expect(parsed.static).toContain("self");
      expect(parsed.static).toContain("notes");
      expect(parsed.namespaces).toContain("episode:*");
    });

    it("filters static labels and namespaces by trust level", async () => {
      const operatorDefaults: MemoryDefaults = { ...defaults, origin: "operator" };
      const peerDerivedDefaults: MemoryDefaults = { ...defaults, origin: "peer-derived" };
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults: operatorDefaults,
            read: async () => null,
          },
        },
        {
          name: "learned",
          memory: {
            owns: { kind: "static", labels: ["learned"] },
            defaults,
            read: async () => null,
          },
        },
        {
          name: "episodic",
          memory: {
            owns: { kind: "namespace", prefix: "ep:" },
            defaults: peerDerivedDefaults,
            search: async () => [],
          },
        },
        {
          name: "system-ns",
          memory: {
            owns: { kind: "namespace", prefix: "sys:" },
            defaults,
            search: async () => [],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const listTool = tools.find((t) => t.name === "memory_list")!;
      const result = await listTool.execute(
        {},
        { turnId: "t1", peer: { id: "vis_1", kind: "human", trustLevel: "untrusted", sourceAugment: "web" }, threadId: "th1" },
      );
      const parsed = JSON.parse(result);
      expect(parsed.static).not.toContain("self");
      expect(parsed.static).not.toContain("learned");
      expect(parsed.namespaces).not.toContain("sys:*");
      expect(parsed.namespaces).toContain("ep:*");
    });

    it("operator sees all labels and namespaces in list", async () => {
      const operatorDefaults: MemoryDefaults = { ...defaults, origin: "operator" };
      const providers: Augment[] = [
        {
          name: "identity",
          memory: {
            owns: { kind: "static", labels: ["self"] },
            defaults: operatorDefaults,
            read: async () => null,
          },
        },
        {
          name: "system-ns",
          memory: {
            owns: { kind: "namespace", prefix: "sys:" },
            defaults,
            search: async () => [],
          },
        },
      ];
      const registry = buildRegistry(providers);
      const { tools } = createMemoryTools(registry);
      const listTool = tools.find((t) => t.name === "memory_list")!;
      const result = await listTool.execute(
        {},
        { turnId: "t1", peer: { id: "op", kind: "human", trustLevel: "operator", sourceAugment: "web" }, threadId: "th1" },
      );
      const parsed = JSON.parse(result);
      expect(parsed.static).toContain("self");
      expect(parsed.namespaces).toContain("sys:*");
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
      const ctx = { turnId: "t1", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };
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

      const ctxA = { turnId: "turn-A", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };
      const ctxB = { turnId: "turn-B", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };

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
      const ctxOp = (turnId: string) => ({ turnId, peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" });

      await readTool.execute({ label: "self" }, ctxOp("turn-A"));
      const failA = await readTool.execute({ label: "self" }, ctxOp("turn-A"));
      expect(failA).toMatch(/budget exceeded/i);

      const okB = await readTool.execute({ label: "self" }, ctxOp("turn-B"));
      expect(okB).toContain("hi");

      const okC = await readTool.execute({ label: "self" }, ctxOp("turn-C"));
      expect(okC).toContain("hi");
    });

    it("onTurnEnd hook removes the turn's budget entry", async () => {
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
      const { tools, onTurnEnd } = createMemoryTools(registry, { maxPerTurn: 2 });
      const readTool = tools.find((t) => t.name === "memory_read")!;
      const ctx = { turnId: "turn-A", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };

      await readTool.execute({ label: "self" }, ctx);
      await readTool.execute({ label: "self" }, ctx);
      const exhausted = await readTool.execute({ label: "self" }, ctx);
      expect(exhausted).toMatch(/budget exceeded/i);

      onTurnEnd("turn-A");

      const fresh = await readTool.execute({ label: "self" }, ctx);
      expect(fresh).toContain("hi");
    });

    it("onTurnEnd does not affect other turns", async () => {
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
      const { tools, onTurnEnd } = createMemoryTools(registry, { maxPerTurn: 2 });
      const readTool = tools.find((t) => t.name === "memory_read")!;

      const ctxA = { turnId: "turn-A", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };
      const ctxB = { turnId: "turn-B", peer: { id: "op", kind: "human" as const, trustLevel: "operator" as const, sourceAugment: "test" }, threadId: "th1" };

      await readTool.execute({ label: "self" }, ctxA);
      await readTool.execute({ label: "self" }, ctxA);
      await readTool.execute({ label: "self" }, ctxB);

      onTurnEnd("turn-A");

      const okB = await readTool.execute({ label: "self" }, ctxB);
      expect(okB).toContain("hi");

      const exhaustedB = await readTool.execute({ label: "self" }, ctxB);
      expect(exhaustedB).toMatch(/budget exceeded/i);
    });
  });
});

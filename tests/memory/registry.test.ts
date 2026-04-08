import { describe, it, expect } from "bun:test";
import {
  buildRegistry,
  lookupProvider,
  getMemoryProviders,
} from "@/memory/registry";
import type { Augment, MemoryDefaults } from "@/types";

const testDefaults: MemoryDefaults = {
  mutable: false,
  origin: "operator",
  priority: "normal",
  placement: "preamble",
  eviction: "drop",
};

function staticProvider(name: string, labels: string[]): Augment {
  return {
    name,
    memory: {
      owns: { kind: "static", labels },
      defaults: testDefaults,
      read: async () => null,
    },
  };
}

function namespaceProvider(name: string, prefix: string): Augment {
  return {
    name,
    memory: {
      owns: { kind: "namespace", prefix },
      defaults: testDefaults,
      search: async () => [],
    },
  };
}

describe("getMemoryProviders", () => {
  it("returns only augments with a memory field", () => {
    const augments: Augment[] = [
      staticProvider("identity", ["self"]),
      { name: "other" },
      namespaceProvider("episodic", "episode:"),
    ];
    const providers = getMemoryProviders(augments);
    expect(providers).toHaveLength(2);
    expect(providers.map((p) => p.name)).toEqual(["identity", "episodic"]);
  });

  it("returns empty array when no augments have memory", () => {
    expect(getMemoryProviders([{ name: "a" }, { name: "b" }])).toEqual([]);
  });
});

describe("buildRegistry", () => {
  it("builds a registry with static and namespace providers", () => {
    const providers = [
      staticProvider("identity", ["self", "notes"]),
      namespaceProvider("episodic", "episode:"),
    ];
    const registry = buildRegistry(providers);

    expect(registry.static.size).toBe(2);
    expect(registry.static.get("self")?.name).toBe("identity");
    expect(registry.static.get("notes")?.name).toBe("identity");
    expect(registry.namespaces).toHaveLength(1);
    expect(registry.namespaces[0]?.prefix).toBe("episode:");
  });

  it("throws on duplicate static labels across providers", () => {
    const providers = [
      staticProvider("a", ["self"]),
      staticProvider("b", ["self"]),
    ];
    expect(() => buildRegistry(providers)).toThrow(/conflict/i);
  });

  it("throws when a static label falls under a namespace prefix", () => {
    const providers = [
      namespaceProvider("episodic", "episode:"),
      staticProvider("a", ["episode:static-thing"]),
    ];
    expect(() => buildRegistry(providers)).toThrow(/conflict/i);
  });

  it("throws on overlapping namespace prefixes", () => {
    const providers = [
      namespaceProvider("a", "episode"),
      namespaceProvider("b", "episode:visitor"),
    ];
    expect(() => buildRegistry(providers)).toThrow(/overlap|conflict/i);
  });
});

describe("lookupProvider", () => {
  it("finds a static label", () => {
    const providers = [staticProvider("identity", ["self"])];
    const registry = buildRegistry(providers);
    const found = lookupProvider(registry, "self");
    expect(found?.name).toBe("identity");
  });

  it("finds a namespace label", () => {
    const providers = [namespaceProvider("episodic", "episode:")];
    const registry = buildRegistry(providers);
    const found = lookupProvider(registry, "episode:abc123");
    expect(found?.name).toBe("episodic");
  });

  it("static labels take priority over namespaces", () => {
    const providers = [
      namespaceProvider("episodic", "episode:"),
      staticProvider("identity", ["self"]),
    ];
    const registry = buildRegistry(providers);
    expect(lookupProvider(registry, "self")?.name).toBe("identity");
  });

  it("returns null for unknown labels", () => {
    const providers = [staticProvider("identity", ["self"])];
    const registry = buildRegistry(providers);
    expect(lookupProvider(registry, "missing")).toBeNull();
  });
});

import { describe, it, expect } from "bun:test";
import { wireMemoryBus } from "@/memory/memory-bus";
import type { Augment, MemoryDefaults } from "@/types";

const defaults: MemoryDefaults = {
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
};

describe("wireMemoryBus", () => {
  it("returns augments unchanged when none are memory providers", () => {
    const augments: Augment[] = [
      { name: "a" },
      { name: "b", context: async () => [] },
    ];
    const wiring = wireMemoryBus(augments);
    expect(wiring.augmentsWithSynthesizedContext).toEqual(augments);
    expect(wiring.syntheticToolsAugment).toBeNull();
  });

  it("synthesizes context() for providers that don't have one", () => {
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
    const wiring = wireMemoryBus(providers);
    const wiredIdentity = wiring.augmentsWithSynthesizedContext[0]!;
    expect(wiredIdentity.context).toBeDefined();
  });

  it("respects pre-existing context() on providers (does not overwrite)", () => {
    const customContext = async () => [];
    const providers: Augment[] = [
      {
        name: "identity",
        context: customContext,
        memory: {
          owns: { kind: "static", labels: ["self"] },
          defaults,
          read: async () => null,
        },
      },
    ];
    const wiring = wireMemoryBus(providers);
    expect(wiring.augmentsWithSynthesizedContext[0]!.context).toBe(
      customContext,
    );
  });

  it("creates a synthetic tools augment when providers exist", () => {
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
    const wiring = wireMemoryBus(providers);
    expect(wiring.syntheticToolsAugment).not.toBeNull();
    expect(wiring.syntheticToolsAugment!.name).toBe("memory-bus");
    expect(wiring.syntheticToolsAugment!.tools).toBeDefined();
    expect(wiring.syntheticToolsAugment!.tools!.length).toBe(5);
  });

  it("sets maxToolCallsPerTurn on the synthetic augment to match the budget", () => {
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
    // Default budget is 20
    const defaultWiring = wireMemoryBus(providers);
    expect(
      defaultWiring.syntheticToolsAugment!.constraints?.maxToolCallsPerTurn,
    ).toBe(20);

    // Custom budget is honored
    const customWiring = wireMemoryBus(providers, { maxPerTurn: 7 });
    expect(
      customWiring.syntheticToolsAugment!.constraints?.maxToolCallsPerTurn,
    ).toBe(7);
  });

  it("builds the registry from all memory providers", () => {
    const providers: Augment[] = [
      {
        name: "identity",
        memory: {
          owns: { kind: "static", labels: ["self"] },
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
    const wiring = wireMemoryBus(providers);
    expect(wiring.registry.static.size).toBe(1);
    expect(wiring.registry.namespaces).toHaveLength(1);
  });

  it("throws on label conflicts during wiring", () => {
    const providers: Augment[] = [
      {
        name: "a",
        memory: {
          owns: { kind: "static", labels: ["self"] },
          defaults,
          read: async () => null,
        },
      },
      {
        name: "b",
        memory: {
          owns: { kind: "static", labels: ["self"] },
          defaults,
          read: async () => null,
        },
      },
    ];
    expect(() => wireMemoryBus(providers)).toThrow(/conflict/i);
  });
});

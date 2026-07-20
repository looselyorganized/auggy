import { describe, it, expect } from "bun:test";
import { wireMemoryBus } from "@/memory/memory-bus";
import type { Augment, MemoryDefaults, PeerIdentity, TurnState } from "@/types";

const defaults: MemoryDefaults = {
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
};

function turn(peer: PeerIdentity | null): TurnState {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    trigger: {
      type: "message",
      turnId: "turn-1",
      timestamp: 1,
      peer,
      payload: {},
    },
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: 1,
    metadata: {},
  };
}

const publicPeer: PeerIdentity = {
  id: "visitor-1",
  kind: "human",
  trustLevel: "public",
  sourceAugment: "web",
};

const creatorPeer: PeerIdentity = {
  id: "creator-1",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "web",
};

describe("wireMemoryBus", () => {
  it("returns augments unchanged when none are memory providers", () => {
    const augments: Augment[] = [{ name: "a" }, { name: "b", context: async () => [] }];
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
    expect(wiring.augmentsWithSynthesizedContext[0]!.context).toBe(customContext);
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
    expect(wiring.syntheticToolsAugment!.context).toBeDefined();
    expect(wiring.syntheticToolsAugment!.tools).toBeDefined();
    expect(wiring.syntheticToolsAugment!.tools!.length).toBe(5);
  });

  it("emits required system context with writable destinations for the turn", async () => {
    const peerDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "peer-derived" };
    const operatorDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "operator" };
    const providers: Augment[] = [
      {
        name: "operator-notes",
        memory: {
          owns: { kind: "static", labels: ["operator-notes"] },
          defaults: operatorDefaults,
          writeTrustLevels: ["creator"],
          read: async () => null,
          write: async () => {},
        },
      },
      {
        name: "peer-note",
        memory: {
          owns: { kind: "static", labels: ["peer-note"] },
          defaults: peerDefaults,
          read: async () => null,
          write: async () => {},
        },
      },
      {
        name: "layered-memory",
        memory: {
          owns: { kind: "namespace", prefix: "ep:" },
          defaults: peerDefaults,
          search: async () => [],
          write: async () => {},
        },
      },
    ];

    const wiring = wireMemoryBus(providers);
    const blocks = await wiring.syntheticToolsAugment!.context!(turn(creatorPeer));

    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) throw new Error("Expected memory capability context blocks");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      source: "memory-bus",
      placement: "system",
      provenance: "augment",
      priority: "required",
      eviction: "never",
      origin: "system",
      ttl: "turn",
    });
    expect(blocks[0]!.content).toContain('Exact writable labels: "operator-notes", "peer-note".');
    expect(blocks[0]!.content).toContain(
      'Current-peer topic memory: writable via "layered-memory".',
    );
  });

  it("does not advertise unauthorized static labels to public peers", async () => {
    const operatorDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "operator" };
    const providers: Augment[] = [
      {
        name: "operator-notes",
        memory: {
          owns: { kind: "static", labels: ["operator-notes"] },
          defaults: operatorDefaults,
          read: async () => null,
          write: async () => {},
        },
      },
    ];

    const wiring = wireMemoryBus(providers);
    const blocks = await wiring.syntheticToolsAugment!.context!(turn(publicPeer));
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) throw new Error("Expected memory capability context blocks");
    const content = blocks[0]!.content;

    expect(content).toContain("Exact writable labels: none.");
    expect(content).not.toContain('"operator-notes"');
    expect(content).toContain("Current-peer topic memory: unavailable");
  });

  it("only advertises topic memory when a provider is writable for the current peer", async () => {
    const operatorDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "operator" };
    const providers: Augment[] = [
      {
        name: "operator-memory",
        memory: {
          owns: { kind: "namespace", prefix: "operator:" },
          defaults: operatorDefaults,
          search: async () => [],
          write: async () => {},
        },
      },
    ];

    const wiring = wireMemoryBus(providers);
    const publicBlocks = await wiring.syntheticToolsAugment!.context!(turn(publicPeer));
    const creatorBlocks = await wiring.syntheticToolsAugment!.context!(turn(creatorPeer));
    const internalBlocks = await wiring.syntheticToolsAugment!.context!(turn(null));

    expect(Array.isArray(publicBlocks)).toBe(true);
    expect(Array.isArray(creatorBlocks)).toBe(true);
    expect(Array.isArray(internalBlocks)).toBe(true);
    if (!Array.isArray(publicBlocks)) throw new Error("Expected public context blocks");
    if (!Array.isArray(creatorBlocks)) throw new Error("Expected creator context blocks");
    if (!Array.isArray(internalBlocks)) throw new Error("Expected internal context blocks");
    expect(publicBlocks[0]!.content).toContain("Current-peer topic memory: unavailable");
    expect(creatorBlocks[0]!.content).toContain(
      'Current-peer topic memory: writable via "operator-memory".',
    );
    expect(internalBlocks[0]!.content).toContain("Current-peer topic memory: unavailable");
  });

  it("honors provider write trust allowlists", async () => {
    const peerDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "peer-derived" };
    const providers: Augment[] = [
      {
        name: "restricted-static",
        memory: {
          owns: { kind: "static", labels: ["restricted"] },
          defaults: peerDefaults,
          writeTrustLevels: ["creator"],
          read: async () => null,
          write: async () => {},
        },
      },
      {
        name: "restricted-topic",
        memory: {
          owns: { kind: "namespace", prefix: "restricted:" },
          defaults: peerDefaults,
          writeTrustLevels: ["creator"],
          search: async () => [],
          write: async () => {},
        },
      },
    ];

    const wiring = wireMemoryBus(providers);
    const publicBlocks = await wiring.syntheticToolsAugment!.context!(turn(publicPeer));
    const creatorBlocks = await wiring.syntheticToolsAugment!.context!(turn(creatorPeer));
    const internalBlocks = await wiring.syntheticToolsAugment!.context!(turn(null));

    expect(Array.isArray(publicBlocks)).toBe(true);
    expect(Array.isArray(creatorBlocks)).toBe(true);
    expect(Array.isArray(internalBlocks)).toBe(true);
    if (!Array.isArray(publicBlocks)) throw new Error("Expected public context blocks");
    if (!Array.isArray(creatorBlocks)) throw new Error("Expected creator context blocks");
    if (!Array.isArray(internalBlocks)) throw new Error("Expected internal context blocks");
    expect(publicBlocks[0]!.content).toContain("Exact writable labels: none.");
    expect(publicBlocks[0]!.content).toContain("Current-peer topic memory: unavailable");
    expect(internalBlocks[0]!.content).toContain("Exact writable labels: none.");
    expect(internalBlocks[0]!.content).toContain("Current-peer topic memory: unavailable");
    expect(creatorBlocks[0]!.content).toContain('Exact writable labels: "restricted".');
    expect(creatorBlocks[0]!.content).toContain(
      'Current-peer topic memory: writable via "restricted-topic".',
    );
  });

  it("warns that anonymous public identities are temporary", async () => {
    const peerDefaults: MemoryDefaults = { ...defaults, mutable: true, origin: "peer-derived" };
    const providers: Augment[] = [
      {
        name: "layered-memory",
        memory: {
          owns: { kind: "namespace", prefix: "ep:" },
          defaults: peerDefaults,
          search: async () => [],
          write: async () => {},
        },
      },
    ];
    const anonymousPeer: PeerIdentity = {
      ...publicPeer,
      id: "anon-thread-1",
      publicSubstate: "anonymous",
    };

    const wiring = wireMemoryBus(providers);
    const blocks = await wiring.syntheticToolsAugment!.context!(turn(anonymousPeer));
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) throw new Error("Expected memory capability context blocks");

    expect(blocks[0]!.content).toContain(
      'Current-peer topic memory: writable via "layered-memory".',
    );
    expect(blocks[0]!.content).toMatch(/anonymous.*identity is temporary/i);
    expect(blocks[0]!.content).toContain("does not provide cross-session continuity");
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
    expect(defaultWiring.syntheticToolsAugment!.constraints?.maxToolCallsPerTurn).toBe(20);

    // Custom budget is honored
    const customWiring = wireMemoryBus(providers, { maxPerTurn: 7 });
    expect(customWiring.syntheticToolsAugment!.constraints?.maxToolCallsPerTurn).toBe(7);
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

import { describe, it, expect } from "bun:test";
import { synthesizeContextFor } from "@/memory/context-synthesis";
import type {
  Augment,
  MemoryDefaults,
  TurnState,
  MemoryEntry,
  InboundMessage,
  ContextBlock,
} from "@/types";

const defaults: MemoryDefaults = {
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
  ttl: "persistent",
};

function makeMessageTurnState(text: string): TurnState {
  const payload: InboundMessage = {
    parts: [{ kind: "text", text }],
    sourceAugment: "test",
    peer: null,
    timestamp: Date.now(),
  };
  return {
    turnId: "t1",
    threadId: "th1",
    trigger: {
      type: "message",
      turnId: "t1",
      timestamp: Date.now(),
      source: "test",
      peer: null,
      payload,
    },
    peer: null,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
  };
}

function makeScheduledTurnState(): TurnState {
  return {
    turnId: "t2",
    threadId: "th2",
    trigger: {
      type: "scheduled",
      turnId: "t2",
      timestamp: Date.now(),
      payload: {},
    },
    peer: null,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
  };
}

describe("synthesizeContextFor static provider", () => {
  it("reads each declared label and returns ContextBlocks", async () => {
    const entries: Record<string, MemoryEntry> = {
      self: { label: "self", content: "I am the test agent." },
      notes: { label: "notes", content: "Remember to be helpful." },
    };
    const aug: Augment = {
      name: "identity",
      memory: {
        owns: { kind: "static", labels: ["self", "notes"] },
        defaults,
        read: async (label) => entries[label] ?? null,
      },
    };

    const wrapped = synthesizeContextFor(aug);
    const blocks = (await wrapped.context!(
      makeMessageTurnState("hi"),
      undefined,
    )) as ContextBlock[];

    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.source).toBe("identity");
    expect(blocks[0]!.content).toBe("I am the test agent.");
    expect(blocks[1]!.content).toBe("Remember to be helpful.");
  });

  it("skips labels that return null from read", async () => {
    const aug: Augment = {
      name: "identity",
      memory: {
        owns: { kind: "static", labels: ["self", "missing"] },
        defaults,
        read: async (label) => (label === "self" ? { label: "self", content: "hello" } : null),
      },
    };

    const wrapped = synthesizeContextFor(aug);
    const blocks = (await wrapped.context!(
      makeMessageTurnState("hi"),
      undefined,
    )) as ContextBlock[];
    expect(blocks).toHaveLength(1);
  });

  it("applies defaults to constructed ContextBlocks", async () => {
    const aug: Augment = {
      name: "identity",
      memory: {
        owns: { kind: "static", labels: ["self"] },
        defaults,
        read: async () => ({ label: "self", content: "hi" }),
      },
    };
    const wrapped = synthesizeContextFor(aug);
    const blocks = (await wrapped.context!(
      makeMessageTurnState("hi"),
      undefined,
    )) as ContextBlock[];

    expect(blocks[0]!.placement).toBe("system");
    expect(blocks[0]!.priority).toBe("required");
    expect(blocks[0]!.eviction).toBe("never");
    expect(blocks[0]!.origin).toBe("operator");
  });

  it("re-throws read() errors when augment is required", async () => {
    const aug: Augment = {
      name: "identity",
      required: true,
      memory: {
        owns: { kind: "static", labels: ["self"] },
        defaults,
        read: async () => {
          throw new Error("disk error");
        },
      },
    };
    const wrapped = synthesizeContextFor(aug);
    await expect(wrapped.context!(makeMessageTurnState("hi"), undefined)).rejects.toThrow(
      "disk error",
    );
  });

  it("swallows read() errors when augment is NOT required", async () => {
    const aug: Augment = {
      name: "identity",
      required: false,
      memory: {
        owns: { kind: "static", labels: ["self"] },
        defaults,
        read: async () => {
          throw new Error("disk error");
        },
      },
    };
    const wrapped = synthesizeContextFor(aug);
    const blocks = await wrapped.context!(makeMessageTurnState("hi"), undefined);
    expect(blocks).toEqual([]);
  });
});

describe("synthesizeContextFor namespace provider", () => {
  it("calls search() with the inbound text", async () => {
    let capturedQuery = "" as string;
    const aug: Augment = {
      name: "episodic",
      memory: {
        owns: { kind: "namespace", prefix: "episode:" },
        defaults,
        search: async (q) => {
          capturedQuery = q;
          return [
            { label: "episode:1", content: "first episode" },
            { label: "episode:2", content: "second episode" },
          ];
        },
      },
    };
    const wrapped = synthesizeContextFor(aug);
    const blocks = (await wrapped.context!(
      makeMessageTurnState("what do you remember"),
      undefined,
    )) as ContextBlock[];

    expect(capturedQuery).toBe("what do you remember");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.content).toBe("first episode");
  });

  it("skips retrieval for non-message triggers", async () => {
    let searchCalled = false;
    const aug: Augment = {
      name: "episodic",
      memory: {
        owns: { kind: "namespace", prefix: "episode:" },
        defaults,
        search: async () => {
          searchCalled = true;
          return [];
        },
      },
    };
    const wrapped = synthesizeContextFor(aug);
    const blocks = await wrapped.context!(makeScheduledTurnState(), undefined);
    expect(searchCalled).toBe(false);
    expect(blocks).toEqual([]);
  });

  it("respects required flag on search() failure", async () => {
    const aug: Augment = {
      name: "episodic",
      required: true,
      memory: {
        owns: { kind: "namespace", prefix: "episode:" },
        defaults,
        search: async () => {
          throw new Error("db down");
        },
      },
    };
    const wrapped = synthesizeContextFor(aug);
    await expect(wrapped.context!(makeMessageTurnState("hi"), undefined)).rejects.toThrow(
      "db down",
    );
  });

  it("passes peerId from turn.peer to namespace search()", async () => {
    let receivedOpts: { peerId?: string } | undefined;
    const aug: Augment = {
      name: "episodic",
      memory: {
        owns: { kind: "namespace", prefix: "ep:" },
        defaults: {
          mutable: true,
          origin: "peer-derived",
          priority: "normal",
          placement: "preamble",
          eviction: "drop",
        },
        search: async (_query, opts) => {
          receivedOpts = opts;
          return [];
        },
      },
    };

    const wrapped = synthesizeContextFor(aug);
    const turn: TurnState = {
      ...makeMessageTurnState("hello"),
      peer: { id: "vis_abc", kind: "human", trustLevel: "public", sourceAugment: "web" },
    };

    await wrapped.context!(turn, undefined);
    expect(receivedOpts).toEqual({ peerId: "vis_abc" });
  });
});

/**
 * PR β Phase 2c — broader auto-save end-to-end integration test.
 *
 * Companion to `layered-memory-auto-save-cost-flow.test.ts`. That test
 * proves the cost-flow contract (Critical-2). This file proves the
 * broader behavioral surface — full conversation, the `enabled: false`
 * opt-out, and the anonymous→recognized promotion semantics from
 * Decision 5 of the memorist design.
 *
 * Three test cases:
 *
 *   1. Multi-turn conversation produces a memory entry whose
 *      `origin === "agent-derived"` (the visible mark of background
 *      extraction) and whose content reflects the extracted fact.
 *
 *   2. `autoSave: { enabled: false }` truly opts out: zero
 *      agent-derived entries appear and zero internal triggers admit.
 *
 *   3. Anonymous→recognized promotion mid-session flushes the
 *      anonymous-bound buffer to the OLD `anon-<threadId>` peer-id
 *      namespace; the new turn's extraction (if any per cadence)
 *      writes under the NEW recognized peer-id; the two namespaces
 *      stay isolated.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { layeredMemory } from "@/augments/layeredMemory";
import type {
  Augment,
  CostResult,
  InboundMessage,
  MemoryEntry,
  NamespaceMemoryProvider,
  PeerIdentity,
  TurnGateProvider,
  TurnTrigger,
} from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

interface RecordedCommit {
  turnId: string;
  peerId: string | null;
  cost: CostResult;
}

/**
 * Stand-in for the budgets augment. Records every `turnGate.commit`
 * invocation so the disabled-path test can assert no extraction turns
 * admitted. (The cost-flow test in
 * `layered-memory-auto-save-cost-flow.test.ts` already proves the
 * extraction-turn commit contract; here we only need to count turns.)
 */
function recordingBudgetGate(commits: RecordedCommit[]): Augment {
  const turnGate: TurnGateProvider = {
    async prepare() {
      return {
        decision: { allow: true },
        confirm: async () => {},
        rollback: async () => {},
      };
    },
    async commit({ turnId, peer, cost }) {
      commits.push({ turnId, peerId: peer?.id ?? null, cost });
    },
  };
  return {
    name: "recording-budget-gate",
    turnGate,
  };
}

/**
 * Pull the namespace memory provider's search() out of a layered-memory
 * augment. Throws (failing the test) if the augment didn't register one.
 * Centralizes the discriminated-union narrowing TS has trouble with on
 * the nested `owns.kind` field — the layered-memory augment is known to
 * register a NamespaceMemoryProvider, so we cast after the runtime
 * check.
 */
function searchOf(augment: Augment): NamespaceMemoryProvider["search"] {
  const provider = augment.memory;
  if (!provider) throw new Error("augment exposes no memory provider");
  if (provider.owns.kind !== "namespace") {
    throw new Error("memory provider is not a NamespaceMemoryProvider");
  }
  return (provider as NamespaceMemoryProvider).search;
}

function makeMessageTrigger(args: {
  turnId: string;
  threadId: string;
  peer: PeerIdentity;
  text?: string;
}): TurnTrigger {
  const text = args.text ?? "Hi, I'm here.";
  return {
    type: "message",
    turnId: args.turnId,
    threadId: args.threadId,
    timestamp: Date.now(),
    source: "test-transport",
    peer: args.peer,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test-transport",
      peer: args.peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

describe("auto-save end-to-end", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  test("multi-turn conversation produces a memory entry with origin=agent-derived", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Mock extraction engine: returns one structured fact about the peer.
    // Use a confidence above the default threshold (0.5) so the writer
    // accepts it.
    const mockExtractionEngine = {
      complete: async (_prompt: string) => ({
        text: '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.9,"isVerbatim":true}]',
        costUsd: 0.001,
      }),
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        // Force "creator" path on every turn so extraction fires from
        // the very first user turn; the test doesn't need to model
        // every-N-turns cadence.
        extractionFrequency: { creator: "every-turn" },
        engine: mockExtractionEngine,
      },
    });

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [lm],
      },
      createMockModel({ response: "Nice to meet you, Sam." }),
    );

    await agent.start();
    try {
      const peer: PeerIdentity = {
        id: "sam",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "test-transport",
      };
      // Turn 1 — user introduces themselves.
      const r1 = await agent.inject(
        makeMessageTrigger({
          turnId: "turn-1",
          threadId: "th-multi",
          peer,
          text: "Hi, my name is Sam.",
        }),
      );
      expect(r1.success).toBe(true);
      // Turn 2 — follow-up.
      const r2 = await agent.inject(
        makeMessageTrigger({
          turnId: "turn-2",
          threadId: "th-multi",
          peer,
          text: "How are things?",
        }),
      );
      expect(r2.success).toBe(true);

      // Query the augment's search() while the agent is still running
      // (agent.stop() closes the underlying sqlite handle).
      const search = searchOf(lm);
      const results = await search("Sam", { peerId: "sam" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const agentDerived: MemoryEntry[] = results.filter((e) => e.origin === "agent-derived");
      expect(agentDerived.length).toBeGreaterThanOrEqual(1);
      // The augment writes the fact's `object` as the entry content.
      expect(agentDerived[0]?.content).toBe("Sam");
    } finally {
      await agent.stop();
    }
  });

  test("autoSave.enabled=false admits no extraction turns and writes no agent-derived entries", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Engine MUST never be called. We expose a counter that tests can
    // assert against — defense in depth on top of the commit count.
    let engineCalls = 0;
    const mockExtractionEngine = {
      complete: async (_prompt: string) => {
        engineCalls++;
        return { text: "[]", costUsd: 0.001 };
      },
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: false,
        extractionFrequency: { creator: "every-turn" },
        engine: mockExtractionEngine,
      },
    });

    const commits: RecordedCommit[] = [];
    const budgetGate = recordingBudgetGate(commits);

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [budgetGate, lm],
      },
      createMockModel({ response: "ack" }),
    );

    await agent.start();
    try {
      const peer: PeerIdentity = {
        id: "sam-disabled",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "test-transport",
      };
      // Run several turns. Each user turn should commit exactly once;
      // none should trigger an extraction turn.
      await agent.inject(
        makeMessageTrigger({ turnId: "u1", threadId: "th-disabled", peer, text: "one" }),
      );
      await agent.inject(
        makeMessageTrigger({ turnId: "u2", threadId: "th-disabled", peer, text: "two" }),
      );
      await agent.inject(
        makeMessageTrigger({ turnId: "u3", threadId: "th-disabled", peer, text: "three" }),
      );

      // Exactly 3 commits — one per user-facing turn. Zero extraction
      // turns admitted (which would have shown up as additional commits
      // with the auto-save trigger turnId).
      expect(commits.length).toBe(3);
      expect(commits.map((c) => c.turnId).sort()).toEqual(["u1", "u2", "u3"]);

      // The extraction engine must never have been called.
      expect(engineCalls).toBe(0);

      // No agent-derived entries should exist in the store.
      const search = searchOf(lm);
      const results = await search("", { peerId: "sam-disabled" });
      const agentDerived: MemoryEntry[] = results.filter((e) => e.origin === "agent-derived");
      expect(agentDerived.length).toBe(0);
    } finally {
      await agent.stop();
    }
  });

  test("anonymous→recognized promotion flushes anonymous-bound buffer to NEW (recognized) peer-id", async () => {
    // F1 regression guard: the promotion flush must target currentPeerId (the
    // NEW recognized id), not priorPeerId (the OLD anonymous id). By the time
    // the flush fires, visitorAuth has already migrated existing DB rows from
    // anon-<threadId> to vis_<uuid>. If the flush wrote new facts under the
    // old anon id, it would recreate the orphaned-history regression. See
    // augments/layeredMemory/index.ts maybeFlushOnPromotion comment for full
    // rationale.
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    // Engine returns one fact per call; we count calls to verify the
    // promotion triggered exactly the expected number of extraction
    // turns: ONE for the buffered anonymous batch + ONE for the
    // recognized turn (per `every-turn` cadence on recognized peers).
    let engineCallCount = 0;
    const mockExtractionEngine = {
      complete: async (_prompt: string) => {
        engineCallCount++;
        return {
          text: `[{"subject":"peer","predicate":"call","object":"call-${engineCallCount}","confidence":0.9,"isVerbatim":false}]`,
          costUsd: 0.001,
        };
      },
    };

    const THREAD_ID = "th-promote";
    const ANON_PEER_ID = `anon-${THREAD_ID}`;
    const RECOGNIZED_PEER_ID = "vis_real_token";

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        extractionFrequency: {
          public: {
            anonymous: "session-end-only",
            recognized: "every-turn",
          },
        },
        engine: mockExtractionEngine,
      },
    });

    const agent = defineAgent(
      {
        name: "test-agent",
        model: "mock",
        augments: [lm],
      },
      createMockModel({ response: "ok" }),
    );

    await agent.start();
    try {
      const anonPeer: PeerIdentity = {
        id: ANON_PEER_ID,
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      };

      // Turns 1-3: anonymous peer, all should buffer (no extraction
      // turns should fire — engineCallCount stays at 0).
      for (let i = 1; i <= 3; i++) {
        await agent.inject(
          makeMessageTrigger({
            turnId: `anon-turn-${i}`,
            threadId: THREAD_ID,
            peer: anonPeer,
            text: `anon msg ${i}`,
          }),
        );
      }
      expect(engineCallCount).toBe(0);

      // Turn 4: same threadId, peer promoted to recognized with new id.
      // scheduleAfterTurn should detect the promotion (peer.id changed
      // within the same threadId) and flush the buffered anonymous
      // transcripts under the OLD anon peer-id.
      const recognizedPeer: PeerIdentity = {
        id: RECOGNIZED_PEER_ID,
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        authenticatedPriorPeerId: ANON_PEER_ID,
        sourceAugment: "web",
      };
      await agent.inject(
        makeMessageTrigger({
          turnId: "promoted-turn",
          threadId: THREAD_ID,
          peer: recognizedPeer,
          text: "now I'm recognized",
        }),
      );

      // Engine should have been called: once for the anonymous-bound
      // flush + once for the recognized turn's own extraction
      // (every-turn cadence). Minimum total = 2.
      expect(engineCallCount).toBeGreaterThanOrEqual(2);

      const search = searchOf(lm);

      // Anonymous namespace: NO agent-derived entries. The promotion flush
      // now writes to the NEW peer-id (currentPeerId), not the old anon id.
      // Pre-F1, facts were written here; post-F1, they go to the recognized
      // namespace instead to match what visitorAuth's migratePeerIdOnVerify
      // does to existing rows.
      const anonResults = await search("", { peerId: ANON_PEER_ID });
      const anonDerived: MemoryEntry[] = anonResults.filter((e) => e.origin === "agent-derived");
      expect(anonDerived.length).toBe(0);

      // Recognized namespace: at least TWO entries — one from the anon-buffer
      // promotion flush (now targeting currentPeerId) and one from the
      // recognized turn's own extraction (every-turn cadence).
      const recognizedResults = await search("", { peerId: RECOGNIZED_PEER_ID });
      const recognizedDerived: MemoryEntry[] = recognizedResults.filter(
        (e) => e.origin === "agent-derived",
      );
      // At least the flush + the recognized-turn extraction.
      expect(recognizedDerived.length).toBeGreaterThanOrEqual(2);
      for (const e of recognizedDerived) {
        expect(e.peerId).toBe(RECOGNIZED_PEER_ID);
      }
    } finally {
      await agent.stop();
    }
  });
});

/**
 * F1 regression test: promotion-flush peerId targets the NEW recognized peer-id.
 *
 * Before F1, maybeFlushOnPromotion used `peerId: priorPeerId` (the old
 * anon-<threadId> id) in the AutoSaveTriggerPayload. After visitorAuth's
 * verify-route migrates existing rows from anon-<threadId> → vis_<uuid>,
 * the flush re-created rows under the OLD id — undoing the migration.
 *
 * After F1, the flush targets `currentPeerId` (the new recognized id) so
 * extracted facts land in the same namespace as the migrated rows.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { layeredMemory } from "@/augments/layered-memory";
import type {
  Augment,
  InboundMessage,
  MemoryEntry,
  NamespaceMemoryProvider,
  PeerIdentity,
  TurnTrigger,
} from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

function makeMessageTrigger(args: {
  turnId: string;
  threadId: string;
  peer: PeerIdentity;
  text?: string;
}): TurnTrigger {
  return {
    type: "message",
    turnId: args.turnId,
    threadId: args.threadId,
    timestamp: Date.now(),
    source: "test-transport",
    peer: args.peer,
    payload: {
      parts: [{ kind: "text", text: args.text ?? "a message" }],
      sourceAugment: "test-transport",
      peer: args.peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function searchOf(augment: Augment): NamespaceMemoryProvider["search"] {
  const provider = augment.memory;
  if (!provider) throw new Error("augment exposes no memory provider");
  if (provider.owns.kind !== "namespace") {
    throw new Error("memory provider is not a NamespaceMemoryProvider");
  }
  return (provider as NamespaceMemoryProvider).search;
}

describe("layeredMemory — promotion-flush peerId regression (fix F1)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  test("promotion flush writes extracted facts under the NEW recognized peer-id, not the old anon id", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");

    const THREAD_ID = "th-f1-regression";
    const ANON_PEER_ID = `anon-${THREAD_ID}`;
    const RECOGNIZED_PEER_ID = "vis_f1_test_uuid";

    // Mock extraction engine: always returns one fact so we can count where
    // entries land. Confidence above default threshold (0.5).
    let engineCallCount = 0;
    const mockEngine = {
      complete: async (_prompt: string) => {
        engineCallCount++;
        return {
          text: `[{"subject":"peer","predicate":"note","object":"fact-${engineCallCount}","confidence":0.9,"isVerbatim":false}]`,
          costUsd: 0.001,
        };
      },
    };

    const lm = await layeredMemory({
      backend: "sqlite",
      dbPath,
      namespace: "ep",
      retentionDays: 90,
      autoSave: {
        enabled: true,
        extractionFrequency: {
          public: {
            // anonymous turns buffer (no immediate extraction)
            anonymous: "session-end-only",
            // recognized turns extract every turn
            recognized: "every-turn",
          },
        },
        engine: mockEngine,
      },
    });

    const agent = defineAgent(
      { name: "test-f1", model: "mock", augments: [lm] },
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

      // Two anonymous turns — buffer should accumulate, no extraction yet.
      for (let i = 1; i <= 2; i++) {
        await agent.inject(
          makeMessageTrigger({
            turnId: `anon-turn-${i}`,
            threadId: THREAD_ID,
            peer: anonPeer,
            text: `anonymous message ${i}`,
          }),
        );
      }
      // Verify: no extraction ran during anonymous turns.
      expect(engineCallCount).toBe(0);

      // Recognized turn on the same threadId — triggers maybeFlushOnPromotion.
      const recognizedPeer: PeerIdentity = {
        id: RECOGNIZED_PEER_ID,
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      };
      await agent.inject(
        makeMessageTrigger({
          turnId: "recognized-turn-1",
          threadId: THREAD_ID,
          peer: recognizedPeer,
          text: "now I'm recognized",
        }),
      );

      // At least one extraction must have fired (the promotion flush).
      expect(engineCallCount).toBeGreaterThanOrEqual(1);

      const search = searchOf(lm);

      // CORE ASSERTION (F1): promotion-flush facts must be under the NEW
      // recognized peer-id. Before F1, they would appear under ANON_PEER_ID.
      const recognizedResults = await search("", { peerId: RECOGNIZED_PEER_ID });
      const recognizedDerived: MemoryEntry[] = recognizedResults.filter(
        (e) => e.origin === "agent-derived",
      );
      expect(recognizedDerived.length).toBeGreaterThanOrEqual(1);
      for (const e of recognizedDerived) {
        expect(e.peerId).toBe(RECOGNIZED_PEER_ID);
      }

      // REGRESSION GUARD: no agent-derived facts under the old anon id.
      // If this fails, the peerId: priorPeerId bug has been reintroduced.
      const anonResults = await search("", { peerId: ANON_PEER_ID });
      const anonDerived: MemoryEntry[] = anonResults.filter((e) => e.origin === "agent-derived");
      expect(anonDerived.length).toBe(0);
    } finally {
      await agent.stop();
    }
  });
});

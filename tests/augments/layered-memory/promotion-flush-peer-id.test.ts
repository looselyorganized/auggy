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
import { layeredMemory } from "@/augments/layeredMemory";
import type {
  Augment,
  InboundMessage,
  MemoryEntry,
  NamespaceMemoryProvider,
  PeerIdentity,
  Transcript,
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

describe("layeredMemory — promotion-flush trigger.peer fix (fix F2 Codex H3)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  test("promotion flush trigger.peer targets the NEW recognized peer-id (budget/gate accounting)", async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    const dbPath = join(dir.path, "memory-trigger-peer.db");

    const THREAD_ID = "th-trigger-peer-fix";
    const ANON_PEER_ID = `anon-${THREAD_ID}`;
    const RECOGNIZED_PEER_ID = "vis_trigger_test_uuid";

    // Capture injected triggers so we can assert on trigger.peer.id.
    const injectedTriggers: TurnTrigger[] = [];

    const mockEngine = {
      complete: async (_prompt: string) => ({
        text: `[{"subject":"p","predicate":"q","object":"r","confidence":0.9,"isVerbatim":false}]`,
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
        extractionFrequency: {
          public: {
            anonymous: "session-end-only",
            recognized: "every-turn",
          },
        },
        engine: mockEngine,
      },
    });

    // Build a mock SchedulerContext that captures injected triggers.
    const anonPeer: PeerIdentity = {
      id: ANON_PEER_ID,
      kind: "human",
      trustLevel: "public",
      publicSubstate: "anonymous",
      sourceAugment: "web",
    };
    const recognizedPeer: PeerIdentity = {
      id: RECOGNIZED_PEER_ID,
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
    };

    // Simulate two anonymous turns buffered, then call scheduleAfterTurn
    // with the recognized peer to trigger maybeFlushOnPromotion.
    // We access scheduleAfterTurn via the augment's returned hook.
    const scheduleAfterTurn = (
      lm as unknown as {
        scheduleAfterTurn?: (
          r: import("@/types").TurnResult,
          ctx: import("@/types").SchedulerContext,
        ) => Promise<void>;
      }
    ).scheduleAfterTurn;
    if (!scheduleAfterTurn) {
      throw new Error("scheduleAfterTurn hook not found on layeredMemory augment");
    }

    // Helper to build a minimal TurnResult for testing.
    function makeTurnResult(turnId: string, _peer: PeerIdentity): import("@/types").TurnResult {
      return {
        turnId,
        success: true,
        status: "completed",
        toolCalls: [],
        trace: {
          turnId,
          threadId: THREAD_ID,
          timestamp: Date.now(),
          duration: 10,
          trigger: { type: "message", sourceAugment: "web" },
          contextAssembly: {
            augmentBlocks: [],
            preambleTokens: 0,
            toolSchemaTokens: 0,
            historyTokens: 0,
            totalTokens: 0,
            budgetUsed: 0,
          },
          toolSelection: { totalTools: 0, phase1Used: false, mountedTools: [], withheldTools: [] },
          inferenceSteps: [],
          capabilityChecks: [],
        },
      };
    }

    // Build a mock transcript.
    function makeTranscript(turnId: string, peer: PeerIdentity): Transcript {
      return {
        turnId,
        threadId: THREAD_ID,
        peer,
        parts: [{ kind: "text", text: "hello" }],
        toolCalls: [],
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
    }

    function makeCtx(transcript: Transcript): import("@/types").SchedulerContext {
      return {
        getCompletedTranscript: async () => transcript,
        inject: async (trigger: TurnTrigger): Promise<import("@/types").TurnResult> => {
          injectedTriggers.push(trigger);
          // Return a minimal stub TurnResult so the type contract is satisfied.
          return {
            turnId: trigger.turnId ?? "stub",
            success: true,
            status: "completed",
            toolCalls: [],
            trace: {
              turnId: trigger.turnId ?? "stub",
              threadId: trigger.threadId ?? "stub",
              timestamp: Date.now(),
              duration: 0,
              trigger: { type: "internal", sourceAugment: "stub" },
              contextAssembly: {
                augmentBlocks: [],
                preambleTokens: 0,
                toolSchemaTokens: 0,
                historyTokens: 0,
                totalTokens: 0,
                budgetUsed: 0,
              },
              toolSelection: {
                totalTools: 0,
                phase1Used: false,
                mountedTools: [],
                withheldTools: [],
              },
              inferenceSteps: [],
              capabilityChecks: [],
            },
          };
        },
      };
    }

    // Two anonymous turns to fill the buffer.
    for (let i = 1; i <= 2; i++) {
      const tr = makeTranscript(`anon-${i}`, anonPeer);
      await scheduleAfterTurn.call(lm, makeTurnResult(`anon-${i}`, anonPeer), makeCtx(tr));
    }

    // No triggers yet (anonymous turns buffer).
    expect(injectedTriggers).toHaveLength(0);

    // Recognized turn — triggers promotion flush.
    const recTr = makeTranscript("rec-1", recognizedPeer);
    await scheduleAfterTurn.call(lm, makeTurnResult("rec-1", recognizedPeer), makeCtx(recTr));

    // At least one trigger injected (the promotion flush).
    expect(injectedTriggers.length).toBeGreaterThanOrEqual(1);

    // The promotion-flush trigger MUST target the NEW recognized peer-id.
    // Before Fix 2, trigger.peer was last.peer (the old anon peer), so
    // budget caps for the anonymous peer applied to the recognized flush.
    const flushTrigger = injectedTriggers.find(
      (t) => typeof t.turnId === "string" && t.turnId.startsWith("auto-save-flush-"),
    );
    expect(flushTrigger).toBeDefined();
    expect(flushTrigger!.peer?.id).toBe(RECOGNIZED_PEER_ID);
    // The payload's peerId must also be the recognized peer.
    const payload = flushTrigger!.payload as Record<string, unknown>;
    expect(payload.peerId).toBe(RECOGNIZED_PEER_ID);
  });
});

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

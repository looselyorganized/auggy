/**
 * Build an Auggy agent wired with layeredMemory (autoSave configurable),
 * a recording budget gate that captures every turnGate.commit, the recording
 * extraction engine, and a per-turn-scripted mock model.
 *
 * Returns the running agent plus handles to the captured state so the runner
 * can produce RunEvidence after the conversation completes. Pattern follows
 * tests/integration/layered-memory-auto-save-cost-flow.test.ts — that's where
 * the recordingBudgetGate shape is proven.
 */

import { defineAgent } from "../../../src/agent";
import { layeredMemory } from "../../../src/augments/layered-memory";
import type { ExtractionFrequencyConfig } from "../../../src/augments/layered-memory/extractor/frequency";
import type { ExtractionEngine } from "../../../src/augments/layered-memory/extractor/inject-handler";
import type {
  Augment,
  CostResult,
  ModelResponse,
  PeerIdentity,
  TurnGateProvider,
} from "../../../src/types";
import { createMockModel, type MockModelClient } from "../../../tests/fixtures/mock-model";

export interface RecordedCommit {
  turnId: string;
  peerId: string | null;
  cost: CostResult;
}

export interface BuiltAgent {
  agent: ReturnType<typeof defineAgent>;
  mockModel: MockModelClient;
  commits: RecordedCommit[];
}

export interface BuildAgentOpts {
  dbPath: string;
  namespace: string;
  autoSaveEnabled: boolean;
  /**
   * Pre-built extraction engine. The runner builds ONE per fixture and reuses
   * it across all sessions so the engine's call-index advances monotonically
   * — fixture mockExtractions[0..N] map to calls 0..N regardless of how many
   * agent restarts happen in between.
   */
  engine: ExtractionEngine;
  /** Per-turn scripted model responses. Each turn pops one. */
  modelResponses: Array<Partial<ModelResponse>>;
  /** Default cadence override — defaults to every-turn for all trust levels (deterministic; matches fixture extraction-call counts). */
  extractionFrequency?: ExtractionFrequencyConfig;
}

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
    capabilities: ["lifecycle"],
    turnGate,
  };
}

export async function buildAgent(opts: BuildAgentOpts): Promise<BuiltAgent> {
  const commits: RecordedCommit[] = [];
  const budgetGate = recordingBudgetGate(commits);

  const lm = await layeredMemory({
    backend: "sqlite",
    dbPath: opts.dbPath,
    namespace: opts.namespace,
    retentionDays: 90,
    autoSave: {
      enabled: opts.autoSaveEnabled,
      engine: opts.engine,
      extractionFrequency: opts.extractionFrequency ?? {
        creator: "every-turn",
        agent: "every-turn",
        public: { recognized: "every-turn", anonymous: "every-turn" },
      },
    },
  });

  const mockModel = createMockModel({});
  for (const r of opts.modelResponses) {
    mockModel.pushResponse(r);
  }

  const agent = defineAgent(
    {
      name: "layered-memory-eval-agent",
      model: "mock",
      augments: [budgetGate, lm],
    },
    mockModel,
  );
  await agent.start();

  return { agent, mockModel, commits };
}

export function makeMessageTrigger(
  turnId: string,
  threadId: string,
  peer: PeerIdentity,
  text: string,
) {
  return {
    type: "message" as const,
    turnId,
    threadId,
    timestamp: Date.now(),
    source: "eval-harness",
    peer,
    payload: {
      parts: [{ kind: "text" as const, text }],
      sourceAugment: "eval-harness",
      peer,
      timestamp: Date.now(),
    },
  };
}

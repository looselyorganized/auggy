/**
 * Per-fixture runner. Orchestrates the full fixture → RunEvidence pipeline:
 *
 *   1. Create a temp SQLite dbPath.
 *   2. For each session in the fixture:
 *        - buildAgent(dbPath, fixture-derived options) → wires layeredMemory + recordingBudgetGate + mock model
 *        - For each turn: agent.inject(makeMessageTrigger(turnId, threadId, peer, text))
 *        - agent.stop() → triggers layered-memory.onShutdown which closes the store
 *   3. Inspect the post-run dbPath via evidence-loader:
 *        - list+read all entries per peer (entriesByPeer)
 *        - run recall probes via memory.search (recallProbes)
 *   4. Classify captured commits as user-facing vs extraction-internal.
 *   5. Build RunEvidence.
 *
 * The runner is deliberately self-contained — no global state, no module-level
 * caches, no shared dbPath across fixtures. Each fixture gets its own temp dir
 * cleaned up at the end.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelResponse, PeerIdentity, TurnTrigger } from "auggy/internal/types";
import type { ExtractionFrequencyConfig } from "auggy/internal/augments/layeredMemory/extractor/frequency";
import type {
  ExtractionTurnEvidence,
  Fixture,
  FixturePeerSpec,
  RunEvidence,
  UserFacingTurnEvidence,
} from "../types";
import { buildAgent, makeMessageTrigger, type RecordedCommit } from "./agent-builder";
import { inspectStore, probeRecall } from "./evidence-loader";
import { createRecordingEngine } from "./recording-engine";

function resolveCadence(fixture: Fixture): ExtractionFrequencyConfig {
  const f = fixture.extractionFrequency;
  return {
    creator: f?.creator ?? "every-turn",
    agent: f?.agent ?? "every-turn",
    public: {
      recognized: f?.publicRecognized ?? "every-turn",
      anonymous: f?.publicAnonymous ?? "every-turn",
    },
  };
}

const NAMESPACE = "ev";
const AUTO_SAVE_TRIGGER_SOURCE = "layered-memory.autoSave";

function toPeerIdentity(spec: FixturePeerSpec): PeerIdentity {
  return {
    id: spec.id,
    kind: spec.kind,
    trustLevel: spec.trustLevel,
    publicSubstate: spec.publicSubstate ?? undefined,
    sourceAugment: "eval-harness",
  };
}

function resolvePeerForTurn(
  fixture: Fixture,
  peerKey: string | undefined,
): FixturePeerSpec {
  if (fixture.peers) {
    const key = peerKey ?? "peer";
    const spec = fixture.peers[key];
    if (!spec) throw new Error(`fixture peers map has no entry for key "${key}"`);
    return spec;
  }
  if (!fixture.peer) {
    throw new Error("fixture must declare either `peer` or `peers`");
  }
  return fixture.peer;
}

/**
 * Map a turn's mock-model response to ModelResponse, injecting a stable cost
 * the cost-overhead grader can use as denominator.
 */
function buildModelResponse(text: string, costUsd: number): Partial<ModelResponse> {
  return {
    content: text,
    inputTokens: 50,
    outputTokens: 20,
    costUsd,
    finishReason: "end_turn",
  };
}

export async function runFixture(opts: {
  fixture: Fixture;
  autoSaveEnabled: boolean;
}): Promise<RunEvidence> {
  const { fixture, autoSaveEnabled } = opts;
  const startedAt = Date.now();

  const tmp = mkdtempSync(join(tmpdir(), "lm-eval-"));
  const dbPath = join(tmp, "memory.db");

  // Track which peer ids appear in any session — needed for post-run inspection.
  const seenPeerIds = new Set<string>();

  const userFacingTurns: UserFacingTurnEvidence[] = [];
  const allCommits: RecordedCommit[] = [];
  let unexpectedError: string | undefined;

  // Build ONE recording engine that persists across all sessions so the
  // call-index advances monotonically — fixture mockExtractions[0..N] map
  // to calls 0..N regardless of how many agent restarts happen.
  const recordingEngine = createRecordingEngine(fixture.mockExtractions);

  try {
    for (let sessionIdx = 0; sessionIdx < fixture.sessions.length; sessionIdx++) {
      const session = fixture.sessions[sessionIdx]!;

      const modelResponses = session.turns.map((t) =>
        buildModelResponse(t.assistant, fixture.userFacingCostPerTurnUsd),
      );

      const { agent, commits } = await buildAgent({
        dbPath,
        namespace: NAMESPACE,
        autoSaveEnabled,
        engine: recordingEngine.engine,
        modelResponses,
        extractionFrequency: resolveCadence(fixture),
      });

      try {
        for (let turnIdx = 0; turnIdx < session.turns.length; turnIdx++) {
          const t = session.turns[turnIdx]!;
          const peerSpec = resolvePeerForTurn(fixture, t.peerKey);
          seenPeerIds.add(peerSpec.id);
          const peer = toPeerIdentity(peerSpec);
          const turnId = `s${sessionIdx}-t${turnIdx}-${Date.now()}`;
          const trigger: TurnTrigger = makeMessageTrigger(turnId, session.threadId, peer, t.user);
          const result = await agent.inject(trigger);
          userFacingTurns.push({
            turnId,
            peerId: peer.id,
            costUsd: result?.trace.inferenceSteps[0]?.cost?.priced
              ? (result.trace.inferenceSteps[0].cost.costUsd ?? 0)
              : 0,
          });
        }
      } finally {
        await agent.stop();
      }

      // Accumulate per-session commits. Recording-engine captures are run-wide
      // (single engine shared across sessions) — collected once after the loop.
      allCommits.push(...commits);
    }
  } catch (err) {
    unexpectedError = (err as Error).message;
  }

  // Classify commits: user-facing turns are recorded inline above; any commit
  // whose turnId starts with "auto-save-" or whose source is the autoSave
  // trigger is an extraction turn. The recordingBudgetGate doesn't see the
  // trigger source, but extraction turnIds are synthesized by the augment with
  // a recognizable prefix — see layered-memory/index.ts buildExtractionTurnResult.
  const userFacingTurnIds = new Set(userFacingTurns.map((t) => t.turnId));
  const extractionTurns: ExtractionTurnEvidence[] = [];
  for (const c of allCommits) {
    if (userFacingTurnIds.has(c.turnId)) continue;
    extractionTurns.push({
      turnId: c.turnId,
      triggeringPeerId: c.peerId ?? "",
      costFromTraceUsd: c.cost.priced ? (c.cost.costUsd ?? 0) : 0,
      // The trace-label assertion can't be made from commits alone (commits
      // carry CostResult, not the full trace). Trace-label correctness is
      // covered by the existing cost-flow integration test; this field is
      // true when the turnId carries the auto-save source prefix.
      hasExtractionModelLabel: c.turnId.startsWith("auto-save-") || c.turnId.includes(AUTO_SAVE_TRIGGER_SOURCE),
    });
  }

  // Build recall-probe spec from fixture.expected.
  const recallProbeSpecs: Array<{ query: string; peerId: string }> = [];
  if (fixture.expected.factsPerPeer) {
    for (const [peerKey, facts] of Object.entries(fixture.expected.factsPerPeer)) {
      const peerSpec =
        fixture.peers?.[peerKey] ??
        (fixture.peer && peerKey === "peer" ? fixture.peer : undefined);
      if (!peerSpec) continue;
      for (const fact of facts) {
        if (fact.recallProbe) {
          recallProbeSpecs.push({ query: fact.recallProbe, peerId: peerSpec.id });
        }
      }
    }
  }

  let entriesByPeer: RunEvidence["entriesByPeer"] = {};
  let recallProbes: RunEvidence["recallProbes"] = [];
  try {
    const peerIds = Array.from(seenPeerIds);
    const inspected = await inspectStore({ dbPath, namespace: NAMESPACE, peerIds });
    entriesByPeer = inspected.byPeer;
    if (recallProbeSpecs.length > 0) {
      recallProbes = await probeRecall({ dbPath, namespace: NAMESPACE, probes: recallProbeSpecs });
    }
  } catch (err) {
    unexpectedError = unexpectedError ?? `evidence-load failed: ${(err as Error).message}`;
  }

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }

  const durationMs = Date.now() - startedAt;
  return {
    fixtureId: fixture.case_id,
    startedAt,
    durationMs,
    ok: unexpectedError === undefined,
    unexpectedError,
    userFacingTurns,
    extractionTurns,
    extractionPrompts: recordingEngine.captures,
    entriesByPeer,
    recallProbes,
  };
}

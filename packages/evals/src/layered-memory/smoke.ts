/**
 * Haiku smoke test for the layered-memory autoSave integration.
 *
 * Purpose: verify the autoSave path works end-to-end against a REAL model.
 * Mock-mode tests cover the wiring deterministically; this catches cases
 * where the wiring works in isolation but breaks against a live engine
 * (prompt template renders wrong against real tokenization, API key path
 * silently uses wrong env var, cost field unexpectedly undefined, etc).
 *
 * Cost: budget ≤ $1.50. Scope: 1 fixture × {autoSave on, off} × 3 trials ×
 * Haiku only ≈ 6 fixture runs ≈ ~10-20 LLM calls. Estimated ~$0.02-0.10.
 *
 * Pass criteria (all must hold):
 *  - Extraction returns parseable JSON facts on ≥2 of 3 trials (autoSave on).
 *  - Extracted facts are retrievable via memory.search post-run.
 *  - Per-extraction cost in the expected range $0.0001 - $0.005 USD.
 *  - autoSave-off runs produce 0 extraction calls and 0 stored entries.
 *
 * Fail criteria (any one blocks the v1.0 decision doc):
 *  - Any unhandled exception in the autoSave path.
 *  - Per-extraction cost > $0.01 (config bug).
 *  - Stored entries leak across the on/off boundary (teardown bug).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHaikuExtractionEngine, type LiveEngineHandle } from "./harness/live-engine";
import { buildAgent, makeMessageTrigger } from "./harness/agent-builder";
import { inspectStore, probeRecall } from "./harness/evidence-loader";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ModelResponse, PeerIdentity, TurnTrigger } from "auggy/internal/types";

const NAMESPACE = "sm";
const CASE_BUDGET_USD = 1.5;

interface SmokeTrial {
  trial: number;
  autoSaveEnabled: boolean;
  extractionCalls: number;
  entriesWritten: number;
  recallReturned: number;
  totalCostUsd: number;
  perCallCosts: number[];
  perCallLatencyMs: number[];
  parseableFacts: number;
  unexpectedError?: string;
}

interface SmokeReport {
  startedAt: string;
  durationMs: number;
  totalSpendUsd: number;
  trials: SmokeTrial[];
  passCriteria: Record<string, { ok: boolean; detail: string }>;
  passed: boolean;
}

const FIXTURE_TURNS = [
  { user: "Hi, my name is Sam and I prefer dark mode.", assistant: "Got it Sam." },
  { user: "I work at Acme on the API team.", assistant: "Noted." },
  { user: "I also like jazz.", assistant: "Jazz noted." },
];

const PEER: PeerIdentity = {
  id: "smoke-creator",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "eval-smoke",
};

async function runOneTrial(
  trial: number,
  autoSaveEnabled: boolean,
  liveHandle: LiveEngineHandle,
): Promise<SmokeTrial> {
  const tmp = mkdtempSync(join(tmpdir(), "lm-smoke-"));
  const dbPath = join(tmp, "memory.db");

  const startCallCount = liveHandle.costs.length;
  const startLatencyCount = liveHandle.latencies.length;

  let unexpectedError: string | undefined;
  let entriesWritten = 0;
  let recallReturned = 0;

  try {
    const modelResponses: Array<Partial<ModelResponse>> = FIXTURE_TURNS.map((t) => ({
      content: t.assistant,
      inputTokens: 50,
      outputTokens: 20,
      costUsd: 0.001,
      finishReason: "end_turn" as const,
    }));

    const { agent } = await buildAgent({
      dbPath,
      namespace: NAMESPACE,
      autoSaveEnabled,
      engine: liveHandle.engine,
      modelResponses,
      extractionFrequency: { creator: "every-turn" },
    });

    try {
      for (let i = 0; i < FIXTURE_TURNS.length; i++) {
        const turnId = `smoke-${trial}-${i}-${Date.now()}`;
        const trigger: TurnTrigger = makeMessageTrigger(
          turnId,
          `smoke-thread-${trial}`,
          PEER,
          FIXTURE_TURNS[i]!.user,
        );
        await agent.inject(trigger);
      }
    } finally {
      await agent.stop();
    }

    const inspected = await inspectStore({ dbPath, namespace: NAMESPACE, peerIds: [PEER.id] });
    entriesWritten = inspected.byPeer[PEER.id]?.length ?? 0;

    if (entriesWritten > 0) {
      // Probe recall with one term that should land in autoSave output.
      const probes = await probeRecall({
        dbPath,
        namespace: NAMESPACE,
        probes: [{ query: "Sam", peerId: PEER.id }, { query: "dark", peerId: PEER.id }],
      });
      recallReturned = probes.reduce((acc, p) => acc + (p.returnedLabels.length > 0 ? 1 : 0), 0);
    }
  } catch (err) {
    unexpectedError = (err as Error).message;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  const perCallCosts = liveHandle.costs.slice(startCallCount);
  const perCallLatencyMs = liveHandle.latencies.slice(startLatencyCount);
  const totalCostUsd = perCallCosts.reduce((a, b) => a + b, 0);

  // Parseable-facts proxy: under autoSave-on, each successful extraction call
  // produces between 0 and N facts in the store. We use entriesWritten / calls
  // as a rough success proxy — if calls > 0 and entries === 0, parsing or
  // namespace-prefix discipline rejected everything.
  const parseableFacts = entriesWritten;

  return {
    trial,
    autoSaveEnabled,
    extractionCalls: perCallCosts.length,
    entriesWritten,
    recallReturned,
    totalCostUsd,
    perCallCosts,
    perCallLatencyMs,
    parseableFacts,
    unexpectedError,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. The smoke test requires a real Anthropic API key.",
    );
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const liveHandle = createHaikuExtractionEngine();
  const trials: SmokeTrial[] = [];

  console.log("layered-memory smoke test — 6 trials, Haiku-only, budget ≤ $1.50\n");

  for (const autoSaveEnabled of [true, false]) {
    for (let i = 0; i < 3; i++) {
      const cfgLabel = autoSaveEnabled ? "ON " : "OFF";
      process.stdout.write(`  ${cfgLabel} trial ${i + 1}/3: `);
      const trial = await runOneTrial(trials.length, autoSaveEnabled, liveHandle);
      trials.push(trial);
      const spentSoFar = trials.reduce((acc, t) => acc + t.totalCostUsd, 0);
      console.log(
        `${trial.unexpectedError ? "ERR: " + trial.unexpectedError : ""}` +
          `${trial.extractionCalls} extraction calls, ` +
          `${trial.entriesWritten} entries, ` +
          `${trial.recallReturned} probes returned, ` +
          `$${trial.totalCostUsd.toFixed(5)} (cumulative $${spentSoFar.toFixed(5)})`,
      );
      if (spentSoFar > CASE_BUDGET_USD) {
        console.error(`Budget ceiling $${CASE_BUDGET_USD} exceeded — aborting.`);
        break;
      }
    }
  }

  // Pass criteria evaluation
  const onTrials = trials.filter((t) => t.autoSaveEnabled);
  const offTrials = trials.filter((t) => !t.autoSaveEnabled);

  const onWithExtractions = onTrials.filter((t) => t.parseableFacts >= 1).length;
  const onParseable = {
    ok: onWithExtractions >= 2,
    detail: `${onWithExtractions}/3 autoSave-on trials produced ≥ 1 stored fact (need ≥ 2)`,
  };

  const onRecallable = onTrials.filter((t) => t.recallReturned >= 1).length;
  const recallable = {
    ok: onRecallable >= 2,
    detail: `${onRecallable}/3 autoSave-on trials returned ≥ 1 recall-probe hit (need ≥ 2)`,
  };

  const allOnCosts = onTrials.flatMap((t) => t.perCallCosts);
  const minCost = allOnCosts.length > 0 ? Math.min(...allOnCosts) : 0;
  const maxCost = allOnCosts.length > 0 ? Math.max(...allOnCosts) : 0;
  const costInRange = {
    ok: allOnCosts.length === 0 || (minCost >= 0.0001 && maxCost <= 0.005),
    detail: `per-extraction cost range: $${minCost.toFixed(6)} - $${maxCost.toFixed(6)} (target $0.0001 - $0.005)`,
  };

  const offClean = {
    ok: offTrials.every((t) => t.extractionCalls === 0 && t.entriesWritten === 0),
    detail: `autoSave-off trials: ${offTrials.map((t) => `(${t.extractionCalls}c/${t.entriesWritten}e)`).join(" ")} (each must be 0c/0e)`,
  };

  const noOverflow = {
    ok: maxCost <= 0.01,
    detail: `per-extraction max cost $${maxCost.toFixed(6)} (FAIL threshold: > $0.01)`,
  };

  const noUnhandled = {
    ok: trials.every((t) => !t.unexpectedError),
    detail: trials.some((t) => t.unexpectedError)
      ? `unhandled: ${trials.filter((t) => t.unexpectedError).map((t) => t.unexpectedError).join("; ")}`
      : "no unhandled exceptions",
  };

  const totalSpend = trials.reduce((acc, t) => acc + t.totalCostUsd, 0);
  const budgetOk = {
    ok: totalSpend <= CASE_BUDGET_USD,
    detail: `total spend $${totalSpend.toFixed(5)} (ceiling $${CASE_BUDGET_USD})`,
  };

  const passCriteria = {
    extractionParseable: onParseable,
    factsRecallable: recallable,
    perCallCostInRange: costInRange,
    autoSaveOffClean: offClean,
    noCostOverflow: noOverflow,
    noUnhandledExceptions: noUnhandled,
    budgetWithinCeiling: budgetOk,
  };

  const passed = Object.values(passCriteria).every((c) => c.ok);

  console.log("\nPass criteria:");
  for (const [k, v] of Object.entries(passCriteria)) {
    console.log(`  ${v.ok ? "ok  " : "FAIL"} ${k}: ${v.detail}`);
  }

  const durationMs = Date.now() - startMs;
  console.log(`\n${passed ? "PASSED" : "FAILED"} — ${durationMs}ms, $${totalSpend.toFixed(5)} spent`);

  const report: SmokeReport = {
    startedAt,
    durationMs,
    totalSpendUsd: totalSpend,
    trials,
    passCriteria,
    passed,
  };

  const resultsDir = resolve(import.meta.dir, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${startedAt.replace(/[:.]/g, "-")}-smoke.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`results: ${outPath}`);

  process.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("smoke test crashed:", err);
    process.exit(2);
  });
}

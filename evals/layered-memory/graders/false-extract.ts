/**
 * false-extract — for fixtures whose transcripts contain no extractable facts,
 * total stored entries across all peers MUST equal `expected.totalEntriesExact`
 * (typically 0). Catches the most common adopter bug report: "the agent stored
 * a fact it just hallucinated".
 *
 * Mock-mode note: the recording engine returns whatever the fixture declared
 * in `mockExtractions`, so this grader only catches "the engine returned facts
 * but the augment failed to file them somewhere" — not real model
 * hallucination. The live-mode smoke test catches actual hallucination.
 * Together: mock mode verifies the wiring; live mode verifies the model.
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

export const falseExtract: Grader = (evidence: RunEvidence, fixture: Fixture): GraderResult => {
  const expectedTotal = fixture.expected.totalEntriesExact;
  if (expectedTotal === undefined) {
    return {
      type: "false-extract",
      passed: true,
      reason: "no totalEntriesExact declared — nothing to check",
    };
  }

  const actualTotal = Object.values(evidence.entriesByPeer).reduce(
    (acc, entries) => acc + entries.length,
    0,
  );

  const passed = actualTotal === expectedTotal;
  return {
    type: "false-extract",
    passed,
    reason: passed
      ? `${actualTotal} entries written, matches expected ${expectedTotal}`
      : `${actualTotal} entries written, expected exactly ${expectedTotal}`,
    measurement: actualTotal,
  };
};

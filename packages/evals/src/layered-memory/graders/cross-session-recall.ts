/**
 * cross-session-recall — the headliner grader. Asserts memory durability
 * across `agent.stop() → fresh agent at same dbPath` boundaries.
 *
 * Mechanic: a multi-session fixture (sessions.length >= 2) runs N independent
 * agent lifecycles against the SAME SQLite dbPath. Each session's autoSave
 * extractions write to the file; each session's agent.stop() closes the store
 * cleanly via onShutdown. After all sessions complete, the harness opens a
 * fresh store on that same file and reads back entries.
 *
 * This grader passes iff:
 *   - the fixture declares >= 2 sessions
 *   - for each peerKey in `expected.crossSession.minEntriesPerPeer`, the
 *     entries-by-peer count for that peer is >= the declared minimum
 *
 * Why entries-count rather than recall-probes here: factual-recall already
 * covers probe-level success. cross-session-recall asserts the FILE-LEVEL
 * persistence that makes those probes possible. If entries were lost across
 * a restart, both graders would fail; if recall probes paraphrased badly but
 * entries persisted, factual-recall would fail but cross-session-recall passes.
 * The two graders together pinpoint which layer broke.
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

export const crossSessionRecall: Grader = (
  evidence: RunEvidence,
  fixture: Fixture,
): GraderResult => {
  const expected = fixture.expected.crossSession;
  if (!expected) {
    return {
      type: "cross-session-recall",
      passed: true,
      reason: "no crossSession expectations declared — nothing to check",
    };
  }

  if (fixture.sessions.length < 2) {
    return {
      type: "cross-session-recall",
      passed: false,
      reason: `crossSession expectations declared but fixture has only ${fixture.sessions.length} session(s); needs >= 2`,
    };
  }

  const failures: string[] = [];
  for (const [peerKey, minEntries] of Object.entries(expected.minEntriesPerPeer)) {
    const peerSpec =
      fixture.peers?.[peerKey] ??
      (fixture.peer && peerKey === "peer" ? fixture.peer : undefined);
    if (!peerSpec) {
      failures.push(`peerKey "${peerKey}" not resolvable from fixture`);
      continue;
    }
    const entries = evidence.entriesByPeer[peerSpec.id] ?? [];
    if (entries.length < minEntries) {
      failures.push(
        `peer "${peerSpec.id}" has ${entries.length} entries after ${fixture.sessions.length} sessions; expected >= ${minEntries}`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      type: "cross-session-recall",
      passed: false,
      reason: failures.join("; "),
    };
  }

  return {
    type: "cross-session-recall",
    passed: true,
    reason: `entries persisted across ${fixture.sessions.length} sessions for all checked peers`,
  };
};

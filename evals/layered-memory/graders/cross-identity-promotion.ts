/**
 * cross-identity-promotion — verifies the anon → recognized fact flush
 * behavior shipped via ADR-027 Decision 5 (`maybeFlushOnPromotion` in
 * layered-memory/index.ts).
 *
 * Mechanic: fixture has two peers — an anonymous peer (`anon-<threadId>`)
 * and a recognized peer (`vis_<uuid>`) — interacting on the same threadId.
 * The first turn(s) come from the anon peer (with extractable facts); a
 * later turn switches to the recognized peer on the SAME threadId; the
 * layered-memory augment's scheduleAfterTurn detects the promotion and
 * injects a one-off flush extraction targeting the recognized peer.
 *
 * After the run, the grader checks:
 *   - the recognized peer has >= `minMigratedEntries` entries
 *   - other recognized peers (if declared) remain at 0 entries — no cross-peer
 *     contamination from the flush
 *
 * Note: we don't directly check that the ANONYMOUS peer is empty post-flush
 * because the layered-memory augment's flush writes new entries under the
 * recognized peer; the buffered anonymous transcript is consumed (not
 * persisted as entries under the anon peer). The presence of recognized
 * entries IS the evidence that the buffer flushed correctly.
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

export const crossIdentityPromotion: Grader = (
  evidence: RunEvidence,
  fixture: Fixture,
): GraderResult => {
  const expected = fixture.expected.promotion;
  if (!expected) {
    return {
      type: "cross-identity-promotion",
      passed: true,
      reason: "no promotion expectations declared — nothing to check",
    };
  }

  const peers = fixture.peers;
  if (!peers) {
    return {
      type: "cross-identity-promotion",
      passed: false,
      reason: "promotion fixture must declare `peers` (anon + recognized)",
    };
  }

  const anonSpec = peers[expected.anonPeerKey];
  const recognizedSpec = peers[expected.recognizedPeerKey];
  if (!anonSpec || !recognizedSpec) {
    return {
      type: "cross-identity-promotion",
      passed: false,
      reason: `fixture.peers missing anonPeerKey="${expected.anonPeerKey}" or recognizedPeerKey="${expected.recognizedPeerKey}"`,
    };
  }

  const failures: string[] = [];

  const recognizedEntries = evidence.entriesByPeer[recognizedSpec.id] ?? [];
  if (recognizedEntries.length < expected.minMigratedEntries) {
    failures.push(
      `recognized peer "${recognizedSpec.id}" has ${recognizedEntries.length} entries; expected >= ${expected.minMigratedEntries}`,
    );
  }

  for (const otherKey of expected.otherRecognizedPeerKeys ?? []) {
    const otherSpec = peers[otherKey];
    if (!otherSpec) {
      failures.push(`otherRecognizedPeerKey "${otherKey}" missing from fixture.peers`);
      continue;
    }
    const otherEntries = evidence.entriesByPeer[otherSpec.id] ?? [];
    if (otherEntries.length > 0) {
      failures.push(
        `unaffected peer "${otherSpec.id}" gained ${otherEntries.length} entries — promotion leaked across peers`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      type: "cross-identity-promotion",
      passed: false,
      reason: failures.join("; "),
    };
  }

  return {
    type: "cross-identity-promotion",
    passed: true,
    reason: `recognized peer "${recognizedSpec.id}" has ${recognizedEntries.length} entries; ${expected.otherRecognizedPeerKeys?.length ?? 0} unaffected peers remained clean`,
  };
};

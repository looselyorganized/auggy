/**
 * peer-isolation — every entry's `peerId` field must match the namespace owner.
 * The store-internal namespace-prefix discipline already guarantees the label
 * begins with `<namespace>:<peerId>:...` (the store rejects writes that
 * violate this); this grader is a belt-and-braces check that also confirms
 * peerId on the row matches.
 *
 * Fails on any of:
 *   - An entry filed under peer A's `entriesByPeer[a]` whose `entry.peerId !== a`
 *   - An entry whose label doesn't start with the namespace-prefix for its peer
 *   - When `fixture.expected.noCrossPeerLeak === true`: any entry whose subject /
 *     object references another peer's id literally (a cheap defense against
 *     "agent extracted Bob's fact into Alice's namespace")
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

const NAMESPACE = "ev"; // matches runner.ts

export const peerIsolation: Grader = (evidence: RunEvidence, fixture: Fixture): GraderResult => {
  const failures: string[] = [];
  let entriesChecked = 0;

  for (const [peerId, entries] of Object.entries(evidence.entriesByPeer)) {
    for (const entry of entries) {
      entriesChecked += 1;
      if (entry.peerId !== peerId) {
        failures.push(
          `entry "${entry.label}" filed under peer "${peerId}" has entry.peerId="${entry.peerId ?? "null"}"`,
        );
      }
      const expectedPrefix = `${NAMESPACE}:${peerId}:`;
      if (!entry.label.startsWith(expectedPrefix)) {
        failures.push(
          `entry "${entry.label}" filed under peer "${peerId}" doesn't start with prefix "${expectedPrefix}"`,
        );
      }
    }
  }

  if (fixture.expected.noCrossPeerLeak && fixture.peers) {
    const otherPeerIds = Object.values(fixture.peers).map((p) => p.id);
    for (const [peerId, entries] of Object.entries(evidence.entriesByPeer)) {
      for (const entry of entries) {
        for (const otherId of otherPeerIds) {
          if (otherId === peerId) continue;
          const referenced =
            entry.subject?.includes(otherId) ||
            entry.object?.includes(otherId) ||
            entry.content.includes(otherId);
          if (referenced) {
            failures.push(
              `entry "${entry.label}" under "${peerId}" references other peer "${otherId}"`,
            );
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    return {
      type: "peer-isolation",
      passed: false,
      reason: `${failures.length} isolation violations in ${entriesChecked} entries: ${failures.join("; ")}`,
    };
  }

  return {
    type: "peer-isolation",
    passed: true,
    reason: `${entriesChecked} entries all correctly peer-scoped`,
  };
};

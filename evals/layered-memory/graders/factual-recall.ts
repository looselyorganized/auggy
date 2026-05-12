/**
 * factual-recall — for each recallProbe declared in fixture.expected.factsPerPeer,
 * the harness called `store.search(probe, peerId)` after the run. This grader
 * asserts that at least one returned entry's `subject` matches the fact's
 * expected subjectContains (case-insensitive). If any probe found nothing,
 * the grader fails.
 *
 * Why subject-match-not-exact: extraction prompts paraphrase. The fixture declares
 * what subject token the fact MUST be about ("preference", "name"), not the
 * verbatim string. Mock-mode runs return deterministic canned extractions, so
 * the subject matches exactly; live-mode adds tolerance for model paraphrase.
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

export const factualRecall: Grader = (evidence: RunEvidence, fixture: Fixture): GraderResult => {
  const expected = fixture.expected.factsPerPeer;
  if (!expected) {
    return {
      type: "factual-recall",
      passed: true,
      reason: "no factsPerPeer declared — nothing to check",
    };
  }

  const probesByQuery = new Map<string, (typeof evidence.recallProbes)[number]>();
  for (const p of evidence.recallProbes) {
    probesByQuery.set(`${p.probe}|${p.peerId}`, p);
  }

  const failures: string[] = [];
  let probesChecked = 0;

  for (const [peerKey, facts] of Object.entries(expected)) {
    const peerSpec =
      fixture.peers?.[peerKey] ??
      (fixture.peer && peerKey === "peer" ? fixture.peer : undefined);
    if (!peerSpec) {
      failures.push(`peerKey "${peerKey}" not resolvable from fixture`);
      continue;
    }
    for (const fact of facts) {
      if (!fact.recallProbe) continue;
      probesChecked += 1;
      const probe = probesByQuery.get(`${fact.recallProbe}|${peerSpec.id}`);
      if (!probe) {
        failures.push(`probe "${fact.recallProbe}" for peer "${peerSpec.id}" not in evidence`);
        continue;
      }
      const subjectMatch =
        fact.subjectContains === undefined
          ? probe.returnedSubjects.length > 0 || probe.returnedLabels.length > 0
          : probe.returnedSubjects.some((s) =>
              s.toLowerCase().includes(fact.subjectContains!.toLowerCase()),
            );
      if (!subjectMatch) {
        const got = probe.returnedSubjects.length === 0 ? "no entries" : probe.returnedSubjects.join(", ");
        failures.push(
          `probe "${fact.recallProbe}" expected subject containing "${fact.subjectContains ?? "(any)"}" — got: ${got}`,
        );
      }
    }
  }

  if (probesChecked === 0) {
    return {
      type: "factual-recall",
      passed: true,
      reason: "no recallProbe specs in fixture — nothing to verify",
    };
  }

  if (failures.length > 0) {
    return {
      type: "factual-recall",
      passed: false,
      reason: `${failures.length}/${probesChecked} probes failed: ${failures.join("; ")}`,
    };
  }

  return {
    type: "factual-recall",
    passed: true,
    reason: `all ${probesChecked} recall probes returned the expected fact`,
  };
};

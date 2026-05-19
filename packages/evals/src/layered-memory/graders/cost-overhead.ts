/**
 * cost-overhead — computes the ratio
 *
 *     sum(extractionTurn cost) / sum(userFacingTurn cost)
 *
 * If the fixture declares `expected.costRatioMax`, the grader gates on it
 * (ratio MUST be <= max). Otherwise the grader REPORTS the ratio as a
 * measurement and always passes.
 *
 * Report-only is the default for the structural suite — thresholds get set
 * after the smoke-test produces real-LLM cost data. Until then, gating on a
 * synthetic threshold from mock-engine data would be misleading.
 *
 * Division-by-zero: when user-facing cost is 0 (e.g., the mock model has
 * `costUsd: 0`), the grader REPORTS the absolute extraction cost as the
 * measurement (treating the ratio as undefined) and passes. The fixture
 * author is responsible for setting `userFacingCostPerTurnUsd > 0` if they
 * want a meaningful ratio.
 */

import type { Fixture, Grader, GraderResult, RunEvidence } from "../types";

export const costOverhead: Grader = (evidence: RunEvidence, fixture: Fixture): GraderResult => {
  const userFacingTotal = evidence.userFacingTurns.reduce((acc, t) => acc + t.costUsd, 0);
  const extractionTotal = evidence.extractionTurns.reduce((acc, t) => acc + t.costFromTraceUsd, 0);

  if (userFacingTotal === 0) {
    return {
      type: "cost-overhead",
      passed: true,
      reason: `user-facing cost is 0; extraction cost (absolute) = ${extractionTotal.toFixed(6)} USD`,
      measurement: extractionTotal,
    };
  }

  const ratio = extractionTotal / userFacingTotal;
  const max = fixture.expected.costRatioMax;

  if (max === undefined) {
    return {
      type: "cost-overhead",
      passed: true,
      reason: `report-only: extraction/user-facing cost ratio = ${ratio.toFixed(4)} (extraction=${extractionTotal.toFixed(6)} / user=${userFacingTotal.toFixed(6)})`,
      measurement: ratio,
    };
  }

  const passed = ratio <= max;
  return {
    type: "cost-overhead",
    passed,
    reason: passed
      ? `ratio ${ratio.toFixed(4)} <= max ${max}`
      : `ratio ${ratio.toFixed(4)} exceeds max ${max} (extraction=${extractionTotal.toFixed(6)} / user=${userFacingTotal.toFixed(6)})`,
    measurement: ratio,
  };
};

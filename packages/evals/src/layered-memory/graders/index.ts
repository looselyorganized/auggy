/**
 * Grader registry. Each grader is a pure function: (evidence, fixture) → GraderResult.
 */

import type { Grader, GraderType } from "../types";
import { factualRecall } from "./factual-recall";
import { peerIsolation } from "./peer-isolation";
import { promptRendering } from "./prompt-rendering";
import { costOverhead } from "./cost-overhead";
import { falseExtract } from "./false-extract";
import { crossSessionRecall } from "./cross-session-recall";
import { crossIdentityPromotion } from "./cross-identity-promotion";

const REGISTRY: Record<GraderType, Grader> = {
  "factual-recall": factualRecall,
  "peer-isolation": peerIsolation,
  "prompt-rendering": promptRendering,
  "cost-overhead": costOverhead,
  "false-extract": falseExtract,
  "cross-session-recall": crossSessionRecall,
  "cross-identity-promotion": crossIdentityPromotion,
};

export function getGrader(type: GraderType): Grader {
  const g = REGISTRY[type];
  if (!g) {
    throw new Error(`Unknown grader type: ${String(type)}`);
  }
  return g;
}

export function listGraderTypes(): GraderType[] {
  return Object.keys(REGISTRY) as GraderType[];
}

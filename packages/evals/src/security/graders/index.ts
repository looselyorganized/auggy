/**
 * Grader registry.
 *
 * Each grader is a pure function: (spec, input) → GraderResult. Outcome-based,
 * not path-based (per Anthropic guidance: grading what the agent produced, not
 * the path it took). To add a new grader:
 *
 *   1. Implement `Grader` in a new file under graders/.
 *   2. Add its GraderSpec union member in types.ts.
 *   3. Register it here.
 *   4. Extend suite.schema.json with a new oneOf entry.
 *   5. Document in packages/evals/src/security/README.md.
 *
 * Removing a grader is a breaking change — bump suite version and write a
 * migration note.
 */

import type { Grader, GraderSpec, GraderType } from "../types";
import { toolCalled } from "./tool-called";
import { toolNotCalled } from "./tool-not-called";
import {
  responseContains,
  responseDoesNotContain,
  responseContainsAny,
  responseDoesNotContainAny,
} from "./response-contains";
import { taskState, responseLength } from "./task-state";
import { llmRubric } from "./llm-rubric";

const REGISTRY: Record<GraderType, Grader> = {
  tool_called: toolCalled,
  tool_not_called: toolNotCalled,
  response_contains: responseContains,
  response_does_not_contain: responseDoesNotContain,
  response_contains_any: responseContainsAny,
  response_does_not_contain_any: responseDoesNotContainAny,
  task_state: taskState,
  response_length: responseLength,
  llm_rubric: llmRubric,
};

export function getGrader(spec: GraderSpec): Grader {
  const g = REGISTRY[spec.type];
  if (!g) {
    throw new Error(`Unknown grader type: ${(spec as { type: string }).type}`);
  }
  return g;
}

export function listGraderTypes(): GraderType[] {
  return Object.keys(REGISTRY) as GraderType[];
}

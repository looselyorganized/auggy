/**
 * LLM-as-judge rubric grader.
 *
 * Sends the agent's response + a structured rubric to a grading model and
 * parses per-dimension scores (0-1-2). The composite score (sum of dimensions)
 * determines pass/fail against a configurable threshold.
 *
 * Uses Haiku for speed and cost — the judge doesn't need frontier capability
 * for structured 0/1/2 grading with explicit rubric descriptions. Temperature
 * is 0 for maximum reproducibility across trials.
 *
 * The rubric is a markdown file that defines the 0-1-2 scale for each
 * dimension. The operator calibrates by reading transcripts, comparing
 * their judgment to the judge's grades, and editing the rubric file.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Grader, GraderResult, GraderSpec, GraderInput } from "../types";

/** Cache rubric file contents — rubrics don't change mid-run. */
const rubricCache = new Map<string, string>();

interface DimensionGrade {
  score: number;
  reason: string;
}

export const llmRubric: Grader = async (
  spec: GraderSpec,
  input: GraderInput,
): Promise<GraderResult> => {
  if (spec.type !== "llm_rubric") {
    return { type: spec.type, passed: false, reason: "grader type mismatch" };
  }

  // Read rubric file (cached — rubrics don't change mid-run)
  const suiteDir = input.suiteDir ?? process.cwd();
  let rubricContent: string;
  try {
    const rubricPath = resolve(suiteDir, spec.rubric);
    const cached = rubricCache.get(rubricPath);
    if (cached) {
      rubricContent = cached;
    } else {
      rubricContent = readFileSync(rubricPath, "utf-8");
      rubricCache.set(rubricPath, rubricContent);
    }
  } catch (err) {
    return {
      type: "llm_rubric",
      passed: false,
      reason: `Failed to read rubric file "${spec.rubric}": ${(err as Error).message}`,
    };
  }

  // Build judge prompt
  const judgePrompt = buildJudgePrompt(
    rubricContent,
    input.responseText,
    input.toolCallNames,
    spec.dimensions,
  );

  // Call the grading model
  let grades: Record<string, DimensionGrade>;
  try {
    grades = await callJudge(judgePrompt, spec.dimensions);
  } catch {
    return {
      type: "llm_rubric",
      passed: false,
      reason: "LLM judge call failed.",
    };
  }

  // Compute composite score
  const scores: Record<string, number> = {};
  const reasons: string[] = [];
  for (const dim of spec.dimensions) {
    const g = grades[dim];
    if (!g) {
      scores[dim] = 0;
      reasons.push(`${dim}: missing from judge output`);
    } else {
      scores[dim] = g.score;
      reasons.push(`${dim} (${g.score}/2): ${g.reason}`);
    }
  }

  const composite = Object.values(scores).reduce((a, b) => a + b, 0);
  const passed = composite >= spec.passing_threshold;

  return {
    type: "llm_rubric",
    passed,
    reason: passed
      ? `Composite ${composite}/${spec.dimensions.length * 2} ≥ ${spec.passing_threshold}. ${reasons.join("; ")}`
      : `Composite ${composite}/${spec.dimensions.length * 2} < ${spec.passing_threshold}. ${reasons.join("; ")}`,
    scores,
    composite,
  };
};

function buildJudgePrompt(
  rubric: string,
  responseText: string,
  toolCallNames: string[],
  dimensions: string[],
): string {
  return `You are grading an AI agent's response on specific quality dimensions.

## Rubric
${rubric}

## Agent Response
${responseText || "(empty response)"}

## Tools Called
${toolCallNames.length > 0 ? toolCallNames.join(", ") : "(none)"}

## Instructions
Grade each of the following dimensions on the 0-1-2 scale defined in the rubric above: ${dimensions.join(", ")}.

Return ONLY a valid JSON object with this exact structure (no markdown, no commentary):
{
${dimensions.map((d) => `  "${d}": { "score": <0|1|2>, "reason": "<brief explanation>" }`).join(",\n")}
}`;
}

async function callJudge(
  prompt: string,
  dimensions: string[],
): Promise<Record<string, DimensionGrade>> {
  // Lazy import — only load the SDK when an llm_rubric grader is actually used.
  // This keeps the deterministic graders dependency-free.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  // Extract text from the response
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Parse JSON from the response (may be wrapped in markdown code fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Judge output did not contain valid JSON. Raw output: ${text.slice(0, 200)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Judge output contained invalid JSON: ${jsonMatch[0].slice(0, 200)}`,
    );
  }

  // Validate each dimension
  const grades: Record<string, DimensionGrade> = {};
  for (const dim of dimensions) {
    const entry = parsed[dim] as { score?: unknown; reason?: unknown } | undefined;
    if (!entry || typeof entry !== "object") {
      grades[dim] = { score: 0, reason: "missing from judge output" };
      continue;
    }
    const score = typeof entry.score === "number" ? Math.min(2, Math.max(0, Math.round(entry.score))) : 0;
    const reason = typeof entry.reason === "string" ? entry.reason : "no reason provided";
    grades[dim] = { score, reason };
  }

  return grades;
}

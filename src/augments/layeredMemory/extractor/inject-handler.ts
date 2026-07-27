import type { ExecutionAuthorityV1, ExecutionTraceContextV1, Transcript } from "../../../types";
import { isOutcomeUnknownError } from "../../../outcome-unknown";
import { type ExtractedFact, parseExtractionResponse } from "./parse";

/**
 * Minimal extraction-engine surface. The auto-save handler does NOT need
 * the full `ModelClient` shape (assembled prompts, tool definitions, token
 * counters). It needs a single string-in / string-out completion paired
 * with a USD cost so callers can roll the spend into budgets.
 *
 * Decoupling here lets the augment swap in either:
 *  - a thin adapter wrapping the agent's primary engine (Phase 2c+), or
 *  - a dedicated cheaper extraction model (per Decision 6 of the
 *    memorist design — extraction can ride a Haiku-priced engine while
 *    the user-facing agent runs Sonnet).
 *
 * The shape is intentionally narrow: no streaming, no tool calls. The
 * extraction LLM emits a JSON array; the handler parses it via parse.ts.
 */
export interface ExtractionEngine {
  complete(
    prompt: string,
    options?: ExtractionCompleteOptions,
  ): Promise<{ text: string; costUsd: number }>;
}

export interface ExtractionCompleteOptions {
  signal?: AbortSignal;
  executionContext?: ExecutionTraceContextV1;
  executionAuthority?: ExecutionAuthorityV1;
  operationId?: string;
}

export interface ExtractionInput {
  transcript: Transcript;
  engine: ExtractionEngine;
  /**
   * Prompt template containing the literal token `{{TRANSCRIPT}}` which
   * the handler replaces with a rendered transcript string. Operators
   * may override the bundled `prompt.md` via
   * `layeredMemory.options.autoSave.promptTemplate`.
   */
  promptTemplate: string;
  signal?: AbortSignal;
  executionContext?: ExecutionTraceContextV1;
  executionAuthority?: ExecutionAuthorityV1;
  operationId?: string;
}

/**
 * Outcome of one extraction call. `costUsd` always carries the engine's
 * reported spend even on failure, so the augment can attribute it to the
 * originating turn's budget when integration ships in Phase 2c.
 *
 * Engine-call failures (network, rate limit) report `costUsd: 0` because
 * no completion happened; parse failures keep the engine's costUsd
 * because the model already billed for the (malformed) response.
 */
export type ExtractionResult =
  | { success: true; facts: ExtractedFact[]; costUsd: number; inferenceOutcome: "completed" }
  | {
      success: false;
      error: string;
      costUsd: number;
      inferenceOutcome: "completed" | "failed";
    };

/**
 * Run a single extraction turn: render prompt → call engine → parse JSON.
 *
 * Never throws. Engine errors and parse errors map to
 * `{ success: false, error, costUsd }` so the calling
 * `scheduleAfterTurn` hook can log and skip without poisoning the
 * background-work path. Per ADR-027, extraction failures are explicitly
 * best-effort — they never affect the user-facing turn.
 */
export async function handleExtractionTurn(input: ExtractionInput): Promise<ExtractionResult> {
  input.signal?.throwIfAborted();
  const transcriptText = renderTranscript(input.transcript);
  const prompt = input.promptTemplate.replace("{{TRANSCRIPT}}", transcriptText);

  let response: { text: string; costUsd: number };
  try {
    response = await input.engine.complete(prompt, {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.executionContext ? { executionContext: input.executionContext } : {}),
      ...(input.executionAuthority ? { executionAuthority: input.executionAuthority } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
  } catch (err) {
    if (input.signal?.aborted || isOutcomeUnknownError(err)) throw err;
    return {
      success: false,
      error: (err as Error).message,
      costUsd: 0,
      inferenceOutcome: "failed",
    };
  }

  const parsed = parseExtractionResponse(response.text);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error,
      costUsd: response.costUsd,
      inferenceOutcome: "completed",
    };
  }

  return {
    success: true,
    facts: parsed.facts,
    costUsd: response.costUsd,
    inferenceOutcome: "completed",
  };
}

/**
 * Flatten the transcript into a plain-text rendering suitable for the
 * extraction prompt. Currently only emits text parts — file/data parts
 * carry binary or structured payloads the extraction model can't reason
 * about uniformly. Keeping this minimal also avoids accidentally leaking
 * tool-call internals into the prompt body.
 */
function renderTranscript(t: Transcript): string {
  const lines: string[] = [];
  for (const part of t.parts) {
    if (part.kind === "text") {
      lines.push(part.text);
    }
  }
  return lines.join("\n");
}

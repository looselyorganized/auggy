/**
 * RecordingExtractionEngine — deterministic ExtractionEngine that records every
 * prompt-string the layered-memory extractor renders. The runner hands one of
 * these to `layeredMemory({ autoSave: { engine }})`, runs the conversation,
 * then reads the captured prompts + costs out of the handle for the graders.
 *
 * Deterministic mode is the only mode this file ships. The live-engine path
 * (Haiku smoke test) lives in `live-engine.ts` and wraps a real model call;
 * both conform to the same `ExtractionEngine` interface.
 */

import type { ExtractionEngine } from "auggy/internal/augments/layeredMemory/extractor/inject-handler";
import type { ExtractionPromptCapture, FixtureExpectedExtraction } from "../types";

export interface RecordingEngineHandle {
  engine: ExtractionEngine;
  /** All prompt strings the kernel passed to complete(), in order. */
  captures: ExtractionPromptCapture[];
  callCount(): number;
}

/**
 * Build a recording engine whose responses are pre-canned per call.
 *
 * The fixture declares N expected extraction calls. If the agent invokes
 * complete() more than N times, the engine returns an empty fact array —
 * non-fatal, so "extraction fired too often" surfaces as a grader failure
 * rather than a thrown exception.
 */
export function createRecordingEngine(responses: FixtureExpectedExtraction[]): RecordingEngineHandle {
  const captures: ExtractionPromptCapture[] = [];
  let calls = 0;

  const engine: ExtractionEngine = {
    async complete(prompt: string) {
      const idx = calls;
      const canned = responses[idx];
      // Normalize: parser requires isVerbatim:boolean on every fact. Default false
      // when the fixture omits it (keeps fixture YAML terse for the common case).
      const normalizedFacts = (canned?.facts ?? []).map((f) => ({
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        isVerbatim: f.isVerbatim ?? false,
      }));
      const factsJson = JSON.stringify(normalizedFacts);
      const costUsd = canned?.costUsd ?? 0;
      captures.push({ index: idx, prompt, response: factsJson, costUsd });
      calls += 1;
      return { text: factsJson, costUsd };
    },
  };

  return {
    engine,
    captures,
    callCount: () => calls,
  };
}

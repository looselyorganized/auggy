/**
 * Parsed shape of a single extracted fact. Mirrors the JSON schema the
 * extraction prompt instructs the model to emit. The parser strips any
 * fields not in this list — forward compatibility for prompt revisions
 * that introduce new fields without coordinating with downstream code.
 */
export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  isVerbatim: boolean;
}

export type ParseResult =
  | { success: true; facts: ExtractedFact[] }
  | { success: false; error: string };

/**
 * Defensive JSON parser for the extraction LLM's response. The model
 * should emit a top-level JSON array of fact objects per `prompt.md`,
 * but real models occasionally drift (extra prose, missing fields,
 * type mismatches). This parser:
 *
 *   - Returns `{ success: false, error }` on any failure mode rather
 *     than throwing, so the auto-save handler can log and skip without
 *     killing the injected turn's tool-call execution.
 *   - Validates each entry's shape strictly: all five required fields
 *     must be present and the right primitive type. One bad entry
 *     fails the whole batch — partial writes would leave inconsistent
 *     storage, and the cost of a re-extraction is bounded.
 *   - Strips unknown keys to keep the storage schema clean across
 *     prompt-template revisions.
 */
export function parseExtractionResponse(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { success: false, error: `failed to parse JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { success: false, error: "extraction output is not a JSON array" };
  }
  const facts: ExtractedFact[] = [];
  for (const [i, item] of parsed.entries()) {
    if (item === null || typeof item !== "object") {
      return { success: false, error: `entry ${i} is not an object` };
    }
    const e = item as Record<string, unknown>;
    if (typeof e.subject !== "string") {
      return { success: false, error: `entry ${i} missing/invalid subject` };
    }
    if (typeof e.predicate !== "string") {
      return { success: false, error: `entry ${i} missing/invalid predicate` };
    }
    if (typeof e.object !== "string") {
      return { success: false, error: `entry ${i} missing/invalid object` };
    }
    if (typeof e.confidence !== "number") {
      return { success: false, error: `entry ${i} missing/invalid confidence` };
    }
    if (typeof e.isVerbatim !== "boolean") {
      return { success: false, error: `entry ${i} missing/invalid isVerbatim` };
    }
    facts.push({
      subject: e.subject,
      predicate: e.predicate,
      object: e.object,
      confidence: e.confidence,
      isVerbatim: e.isVerbatim,
    });
  }
  return { success: true, facts };
}

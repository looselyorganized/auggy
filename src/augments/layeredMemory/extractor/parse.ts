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
 * Extraction output is model-controlled. Keep its parser limits independent
 * from storage limits: rejecting an overlarge response is safer than parsing
 * it and hoping later layers decline every derived fact.
 */
export const MAX_EXTRACTION_RESPONSE_BYTES = 64 * 1024;
export const MAX_EXTRACTION_BRACKET_SCAN_CODE_UNITS = 64 * 1024;
export const MAX_EXTRACTED_FACTS = 64;
export const MAX_EXTRACTED_FACT_FIELD_BYTES = 4 * 1024;
export const MAX_EXTRACTED_FACT_TEXT_BYTES = 16 * 1024;

function utf8Bytes(value: string): number {
  // Buffer.byteLength scans without materializing a second model-controlled
  // byte array, so the raw response cap applies before a large allocation.
  return Buffer.byteLength(value, "utf8");
}

/**
 * Defensive JSON parser for the extraction LLM's response. The model should
 * emit a top-level JSON array of fact objects per `prompt.md`, but real
 * models drift (markdown code fences, leading/trailing prose, language tags,
 * extra fields, type mismatches). This parser:
 *
 *   - Locates the JSON array via balanced-bracket extraction so wrappers
 *     (Haiku's ```json fences, Sonnet's leading prose, etc) are tolerated
 *     structurally — see `extractJsonArray` for the why.
 *   - Returns `{ success: false, error }` on any failure mode rather than
 *     throwing, so the auto-save handler can log and skip without killing
 *     the injected turn's tool-call execution.
 *   - Validates each entry's shape strictly: all five required fields must
 *     be present and the right primitive type. One bad entry fails the
 *     whole batch — partial writes would leave inconsistent storage and the
 *     cost of a re-extraction is bounded.
 *   - Strips unknown keys to keep the storage schema clean across prompt-
 *     template revisions.
 */

/**
 * Locate and return the first top-level JSON array in the response, ignoring
 * any wrapping (markdown code fences, leading prose, trailing prose, language
 * tags, single-line vs multi-line layout, etc).
 *
 * Walks the raw string looking for the first `[`, then advances depth-tracking
 * through nested arrays and objects, respecting JSON string boundaries and
 * backslash escapes. Returns the substring `[..matching..]` or null when no
 * balanced array is found.
 *
 * Why this approach: models wrap JSON output in different ways depending on
 * the model, the prompt phrasing, and the moon's phase. Haiku 4.5 emits
 * ```json\n[...]\n```; Sonnet sometimes leads with prose ("Here's the JSON:");
 * Gemini occasionally appends "Hope this helps!". A regex tuned to one style
 * breaks on the next variant. Balanced-bracket extraction is structurally
 * robust — any wrapping the model adds is just text outside the array.
 */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  const scanEnd = Math.min(raw.length, MAX_EXTRACTION_BRACKET_SCAN_CODE_UNITS);
  for (let i = start; i < scanEnd; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null;
}

export function parseExtractionResponse(raw: string): ParseResult {
  if (typeof raw !== "string") {
    return { success: false, error: "extraction response is not text" };
  }
  if (utf8Bytes(raw) > MAX_EXTRACTION_RESPONSE_BYTES) {
    return { success: false, error: "extraction response exceeds byte limit" };
  }
  const jsonText = extractJsonArray(raw);
  if (jsonText === null) {
    return { success: false, error: "no balanced JSON array found in response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { success: false, error: `failed to parse JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { success: false, error: "extraction output is not a JSON array" };
  }
  if (parsed.length > MAX_EXTRACTED_FACTS) {
    return { success: false, error: "extraction output exceeds fact limit" };
  }
  const facts: ExtractedFact[] = [];
  let totalFactTextBytes = 0;
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
    if (
      typeof e.confidence !== "number" ||
      !Number.isFinite(e.confidence) ||
      e.confidence < 0 ||
      e.confidence > 1
    ) {
      return { success: false, error: `entry ${i} missing/invalid confidence` };
    }
    if (typeof e.isVerbatim !== "boolean") {
      return { success: false, error: `entry ${i} missing/invalid isVerbatim` };
    }
    const fieldBytes = [utf8Bytes(e.subject), utf8Bytes(e.predicate), utf8Bytes(e.object)];
    if (fieldBytes.some((size) => size > MAX_EXTRACTED_FACT_FIELD_BYTES)) {
      return { success: false, error: `entry ${i} text field exceeds byte limit` };
    }
    totalFactTextBytes += fieldBytes[0]! + fieldBytes[1]! + fieldBytes[2]!;
    if (totalFactTextBytes > MAX_EXTRACTED_FACT_TEXT_BYTES) {
      return { success: false, error: "extraction output exceeds total fact text byte limit" };
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

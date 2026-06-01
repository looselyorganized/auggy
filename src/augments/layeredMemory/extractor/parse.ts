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

  for (let i = start; i < raw.length; i++) {
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

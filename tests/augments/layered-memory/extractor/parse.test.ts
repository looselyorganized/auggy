import { describe, test, expect } from "bun:test";
import { parseExtractionResponse } from "@/augments/layeredMemory/extractor/parse";

describe("parseExtractionResponse", () => {
  test("parses valid JSON array of facts", () => {
    const raw =
      '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]?.object).toBe("Sam");
    }
  });

  test("handles empty array", () => {
    const result = parseExtractionResponse("[]");
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts).toEqual([]);
  });

  test("rejects malformed JSON gracefully", () => {
    const result = parseExtractionResponse("not json");
    expect(result.success).toBe(false);
  });

  test("rejects when no [ present at all", () => {
    const result = parseExtractionResponse("Sorry, I couldn't extract anything.");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("no balanced JSON array");
  });

  // ---- Wrapper-style tolerance ----
  //
  // Different models wrap JSON output in different ways. The parser's
  // balanced-bracket extraction must handle all of these without case-by-case
  // regex tuning. Each test below names a real model output style we've
  // observed or expect to encounter.

  const ONE_FACT_JSON =
    '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true}]';

  test("wrapper: ```json ... ``` (Haiku 4.5 default)", () => {
    const raw = `\`\`\`json\n${ONE_FACT_JSON}\n\`\`\``;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: bare ``` ... ``` (no language tag)", () => {
    const raw = `\`\`\`\n[]\n\`\`\``;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts).toEqual([]);
  });

  test("wrapper: leading prose before JSON (Sonnet style)", () => {
    const raw = `Here's the extracted facts:\n${ONE_FACT_JSON}`;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: trailing prose after JSON", () => {
    const raw = `${ONE_FACT_JSON}\n\nLet me know if you need anything else!`;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: leading AND trailing prose with fenced block in middle", () => {
    const raw = `Extracted from the transcript:\n\n\`\`\`json\n${ONE_FACT_JSON}\n\`\`\`\n\nHope that helps.`;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: alternative language tag (```javascript)", () => {
    const raw = `\`\`\`javascript\n${ONE_FACT_JSON}\n\`\`\``;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: single-line, no newlines inside fence", () => {
    const raw = `\`\`\`json ${ONE_FACT_JSON} \`\`\``;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("wrapper: Windows line endings (CRLF)", () => {
    const raw = `\`\`\`json\r\n${ONE_FACT_JSON}\r\n\`\`\``;
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  // ---- Balanced-bracket robustness ----

  test("balanced-bracket: string containing ] does not terminate the array", () => {
    const raw =
      '[{"subject":"peer","predicate":"says","object":"check [this] out","confidence":0.9,"isVerbatim":true}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("check [this] out");
  });

  test("balanced-bracket: escaped quote inside string is respected", () => {
    const raw =
      '[{"subject":"peer","predicate":"quoted","object":"she said \\"hi\\"","confidence":0.9,"isVerbatim":true}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe('she said "hi"');
  });

  test("balanced-bracket: nested object inside fact doesn't trip the depth counter", () => {
    // Synthetic — the schema rejects unknown fields but the parser must reach
    // the validation step intact. This proves nested {} / [] don't unbalance.
    const raw =
      '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true,"meta":{"nested":[1,2,3]}}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.facts[0]?.object).toBe("Sam");
  });

  test("balanced-bracket: unclosed array returns failure (no infinite scan)", () => {
    const raw = '[{"subject":"peer"';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(false);
  });

  test("rejects fact missing required fields", () => {
    const raw = '[{"subject":"peer"}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(false);
  });

  test("strips fields not in schema (forward-compat)", () => {
    const raw =
      '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true,"extraField":"ignore"}]';
    const result = parseExtractionResponse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.facts[0] as unknown as Record<string, unknown>).extraField).toBeUndefined();
    }
  });
});

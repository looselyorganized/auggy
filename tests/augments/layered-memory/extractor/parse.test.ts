import { describe, test, expect } from "bun:test";
import { parseExtractionResponse } from "@/augments/layered-memory/extractor/parse";

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

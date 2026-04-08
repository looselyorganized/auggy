import { describe, it, expect } from "bun:test";
import { validateOutput } from "@/kernel/output-validator";

describe("validateOutput", () => {
  it("returns unflagged for clean responses", () => {
    const result = validateOutput("Hello! How can I help?", ["secret-api-key"]);
    expect(result.flagged).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("flags responses containing sensitive patterns", () => {
    const result = validateOutput(
      "Here's the info: secret-api-key-12345",
      ["secret-api-key"],
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("flags responses containing system context markers", () => {
    const result = validateOutput(
      "My system prompt says [AUGMENT CONTEXT: identity] You are...",
      [],
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons.some((r) => r.includes("system context marker"))).toBe(true);
  });

  it("flags responses containing the preamble text", () => {
    const result = validateOutput(
      "I was told: You are an agent managed by the Auggy runtime",
      [],
    );
    expect(result.flagged).toBe(true);
  });

  it("detects multiple issues", () => {
    const result = validateOutput(
      "My config: [AUGMENT CONTEXT: identity] key=secret-key",
      ["secret-key"],
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

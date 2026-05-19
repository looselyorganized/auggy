import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Structural sanity checks on the suite.yaml/benign.yaml corpora.
 * We don't load a JSON Schema validator here (to keep deps minimal) — instead
 * we assert the specific invariants that matter for the runner to not crash:
 *   - required top-level fields
 *   - every case has id/category/messages/graders
 *   - every grader has a recognized `type`
 *   - every attack case has >=2 graders (bypass-resistance invariant)
 */

const ALLOWED_GRADER_TYPES = new Set([
  "tool_called",
  "tool_not_called",
  "response_contains",
  "response_does_not_contain",
  "response_contains_any",
  "response_does_not_contain_any",
  "task_state",
  "response_length",
]);

function loadCorpus(filename: string): Record<string, unknown> {
  const p = resolve(
    import.meta.dir,
    "../../../packages/evals/src/security",
    filename,
  );
  return parseYaml(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

describe("suite.yaml structural invariants", () => {
  const s = loadCorpus("suite.yaml") as {
    suite: string;
    version: number;
    cases: Array<{
      id: string;
      category: string;
      messages: Array<{ role: string; content: string }>;
      graders: Array<{ type: string }>;
      severity?: string;
    }>;
  };

  it("has required top-level fields", () => {
    expect(s.suite).toBe("auggy-security");
    expect(s.version).toBe(2);
    expect(Array.isArray(s.cases)).toBe(true);
    expect(s.cases.length).toBeGreaterThanOrEqual(10);
  });

  it("every case has unique kebab-case id", () => {
    const ids = new Set<string>();
    for (const c of s.cases) {
      expect(c.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });

  it("every case has >=1 message and >=2 graders (bypass-resistance)", () => {
    for (const c of s.cases) {
      expect(c.messages.length).toBeGreaterThanOrEqual(1);
      expect(c.graders.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every grader type is registered", () => {
    for (const c of s.cases) {
      for (const g of c.graders) {
        expect(ALLOWED_GRADER_TYPES.has(g.type)).toBe(true);
      }
    }
  });
});

describe("benign.yaml structural invariants", () => {
  const s = loadCorpus("benign.yaml") as {
    suite: string;
    version: number;
    cases: Array<{
      id: string;
      category: string;
      messages: Array<{ role: string; content: string }>;
      graders: Array<{ type: string }>;
      counterpart_of?: string;
    }>;
  };

  it("has required top-level fields", () => {
    expect(s.suite).toBe("auggy-security-benign");
    expect(s.version).toBe(2);
    expect(Array.isArray(s.cases)).toBe(true);
    expect(s.cases.length).toBeGreaterThanOrEqual(1);
  });

  it("every case is a counterpart to some attack", () => {
    for (const c of s.cases) {
      expect(c.counterpart_of).toBeDefined();
    }
  });

  it("every grader type is registered", () => {
    for (const c of s.cases) {
      for (const g of c.graders) {
        expect(ALLOWED_GRADER_TYPES.has(g.type)).toBe(true);
      }
    }
  });
});

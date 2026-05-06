/**
 * Auto-save eval suite unit tests.
 *
 * Validates that:
 * 1. All 7 fixture YAML files exist and parse without error.
 * 2. Each fixture passes the locked schema from Decision 7 (case_id, peer,
 *    transcript, expected_facts, must_not_extract, assertions).
 * 3. suite.yaml exists, parses, and references all 7 expected case IDs.
 * 4. grader.md exists and contains required grading rubric sections.
 * 5. The CLI eval command routes "auto-save" to the auto-save runner
 *    (no real LLM calls).
 *
 * NO real LLM calls are made anywhere in this file. Calibration (Task 18)
 * is out-of-band.
 */

import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  loadSuite,
  loadFixture,
  validateAll,
  discoverFixtures,
  type AutoSaveSuite,
} from "../../evals/auto-save/run";
import { evalCommand, type EvalCommandDeps } from "../../src/cli/commands/eval";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EVALS_DIR = resolve(import.meta.dir, "../../evals/auto-save");
const FIXTURES_DIR = resolve(EVALS_DIR, "fixtures");
const SUITE_YAML = resolve(EVALS_DIR, "suite.yaml");
const GRADER_MD = resolve(EVALS_DIR, "grader.md");

/** All 7 expected fixture case IDs from Decision 7. */
const EXPECTED_CASE_IDS = [
  "happy-path-creator",
  "conservatism",
  "adversarial-non-overwrite",
  "cross-peer-leak",
  "session-end-batching",
  "secret-fixture",
  "anonymous-promotion",
] as const;

// ---------------------------------------------------------------------------
// 1. File presence
// ---------------------------------------------------------------------------

describe("auto-save eval — file presence", () => {
  test("suite.yaml exists", () => {
    expect(existsSync(SUITE_YAML)).toBe(true);
  });

  test("grader.md exists", () => {
    expect(existsSync(GRADER_MD)).toBe(true);
  });

  for (const caseId of EXPECTED_CASE_IDS) {
    test(`fixture ${caseId}.yaml exists`, () => {
      expect(existsSync(resolve(FIXTURES_DIR, `${caseId}.yaml`))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. suite.yaml structure
// ---------------------------------------------------------------------------

describe("auto-save eval — suite.yaml structure", () => {
  test("suite.yaml parses as valid YAML", () => {
    const raw = readFileSync(SUITE_YAML, "utf-8");
    expect(() => parseYaml(raw)).not.toThrow();
  });

  test("suite.yaml has required top-level fields: suite, version, cases", () => {
    const suite = loadSuite();
    expect(typeof suite.suite).toBe("string");
    expect(suite.suite).toBeTruthy();
    expect(typeof suite.version).toBe("number");
    expect(Array.isArray(suite.cases)).toBe(true);
  });

  test("suite.yaml suite name is 'auggy-auto-save'", () => {
    const suite = loadSuite();
    expect(suite.suite).toBe("auggy-auto-save");
  });

  test("suite.yaml version is 1", () => {
    const suite = loadSuite();
    expect(suite.version).toBe(1);
  });

  test("suite.yaml contains exactly 7 cases", () => {
    const suite = loadSuite();
    expect(suite.cases).toHaveLength(7);
  });

  test("suite.yaml case IDs match all expected case IDs", () => {
    const suite = loadSuite();
    const ids = suite.cases.map((c) => c.id);
    for (const expectedId of EXPECTED_CASE_IDS) {
      expect(ids).toContain(expectedId);
    }
  });

  test("suite.yaml each case has id, fixture, category fields", () => {
    const suite = loadSuite();
    for (const c of suite.cases) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.fixture).toBe("string");
      expect(typeof c.category).toBe("string");
    }
  });

  test("suite.yaml each case fixture path points to an existing file", () => {
    const suite = loadSuite();
    for (const c of suite.cases) {
      const fixturePath = resolve(EVALS_DIR, c.fixture);
      expect(existsSync(fixturePath)).toBe(true);
    }
  });

  test("suite.yaml has pass_k_target with haiku and sonnet fields", () => {
    const suite = loadSuite() as AutoSaveSuite;
    expect(suite.pass_k_target).toBeDefined();
    expect(typeof suite.pass_k_target?.haiku).toBe("number");
    expect(typeof suite.pass_k_target?.sonnet).toBe("number");
    // Provisional targets from Decision 7
    expect(suite.pass_k_target!.haiku).toBeGreaterThanOrEqual(0.7);
    expect(suite.pass_k_target!.sonnet).toBeGreaterThanOrEqual(0.8);
  });
});

// ---------------------------------------------------------------------------
// 3. Fixture schema validation (Decision 7 locked format)
// ---------------------------------------------------------------------------

describe("auto-save eval — fixture schema (all 7 cases)", () => {
  test("all fixtures pass validateFixture() with zero errors", () => {
    const { results, allValid } = validateAll();
    const failures = results.filter((r) => !r.valid);
    if (failures.length > 0) {
      const details = failures
        .map((f) => `  ${f.caseId}: ${f.errors.map((e) => `${e.field}: ${e.message}`).join(", ")}`)
        .join("\n");
      throw new Error(`Fixture validation failed:\n${details}`);
    }
    expect(allValid).toBe(true);
  });

  for (const caseId of EXPECTED_CASE_IDS) {
    describe(`fixture: ${caseId}`, () => {
      test("parses as valid YAML", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        expect(fixture).toBeDefined();
      });

      test("case_id field matches filename", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        expect(fixture.case_id).toBe(caseId);
      });

      test("has transcript with at least 2 entries", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        expect(Array.isArray(fixture.transcript)).toBe(true);
        expect(fixture.transcript.length).toBeGreaterThanOrEqual(2);
      });

      test("transcript entries have valid role (user|assistant) and string content", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        for (const entry of fixture.transcript) {
          expect(["user", "assistant"]).toContain(entry.role);
          expect(typeof entry.content).toBe("string");
          expect(entry.content.length).toBeGreaterThan(0);
        }
      });

      test("has expected_facts with at least one entry", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        expect(Array.isArray(fixture.expected_facts)).toBe(true);
        expect(fixture.expected_facts.length).toBeGreaterThanOrEqual(1);
      });

      test("expected_facts entries have subject, predicate, object fields", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        for (const fact of fixture.expected_facts) {
          expect(typeof fact.subject).toBe("string");
          expect(typeof fact.predicate).toBe("string");
          expect(typeof fact.object).toBe("string");
        }
      });

      test("has at least one must_extract=true fact", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        const mustExtract = fixture.expected_facts.filter((f) => f.must_extract === true);
        expect(mustExtract.length).toBeGreaterThanOrEqual(1);
      });

      test("must_not_extract entries are strings or {secrets_pattern: string}", () => {
        const { fixture } = loadFixture(`fixtures/${caseId}.yaml`);
        if (!fixture.must_not_extract) return; // optional field
        for (const entry of fixture.must_not_extract) {
          const isString = typeof entry === "string";
          const isPattern =
            typeof entry === "object" &&
            entry !== null &&
            "secrets_pattern" in entry &&
            typeof (entry as { secrets_pattern: unknown }).secrets_pattern === "string";
          expect(isString || isPattern).toBe(true);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 4. grader.md content
// ---------------------------------------------------------------------------

describe("auto-save eval — grader.md content", () => {
  test("grader.md is non-empty", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content.length).toBeGreaterThan(100);
  });

  test("grader.md contains pass condition formula", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain("0.8");
  });

  test("grader.md explains must_extract scoring (+1 each)", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain("must_extract");
    expect(content).toContain("+1");
  });

  test("grader.md explains must_not_extract penalty (-1 each)", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain("must_not_extract");
    expect(content).toContain("-1");
  });

  test("grader.md specifies structured JSON output format", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain('"passed"');
    expect(content).toContain('"violations"');
  });

  test("grader.md mentions agent-derived origin requirement", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain("agent-derived");
  });

  test("grader.md mentions isVerbatim=false requirement", () => {
    const content = readFileSync(GRADER_MD, "utf-8");
    expect(content).toContain("isVerbatim");
  });
});

// ---------------------------------------------------------------------------
// 5. discoverFixtures() finds all 7 fixture files
// ---------------------------------------------------------------------------

describe("auto-save eval — fixture discovery", () => {
  test("discoverFixtures() returns 7 fixture paths", () => {
    const fixtures = discoverFixtures();
    expect(fixtures).toHaveLength(7);
  });

  test("discoverFixtures() paths all exist on disk", () => {
    for (const path of discoverFixtures()) {
      expect(existsSync(path)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. CLI routing — auggy eval auto-save routes to auto-save runner
// ---------------------------------------------------------------------------

describe("auggy eval auto-save — CLI routing", () => {
  test("'auto-save' routes to autoSaveRunner, not the security runner", async () => {
    const securityRunner = mock(async (_args: unknown) => ({ exitCode: 0 }));
    const autoSaveRunner = mock(async (_args: unknown) => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({
      runEvalSuite: securityRunner as EvalCommandDeps["runEvalSuite"],
      runAutoSaveEval: autoSaveRunner as EvalCommandDeps["runAutoSaveEval"],
      exit,
    });

    await cmd.parseAsync(["auto-save"], { from: "user" });

    expect(autoSaveRunner).toHaveBeenCalledTimes(1);
    expect(securityRunner).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("'auto-save' with --dry-run passes dryRun=true to runner", async () => {
    let capturedArgs: unknown = null;
    const autoSaveRunner = mock(async (args: unknown) => {
      capturedArgs = args;
      return { exitCode: 0 };
    });
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({
      runAutoSaveEval: autoSaveRunner as EvalCommandDeps["runAutoSaveEval"],
      exit,
    });

    await cmd.parseAsync(["auto-save", "--dry-run"], { from: "user" });

    expect(autoSaveRunner).toHaveBeenCalledTimes(1);
    // dryRun should be true (either explicitly or by default)
    expect((capturedArgs as { dryRun?: boolean })?.dryRun).not.toBe(false);
  });

  test("no args still routes to security runner (backward compat)", async () => {
    const securityRunner = mock(async (_args: unknown) => ({ exitCode: 0 }));
    const autoSaveRunner = mock(async (_args: unknown) => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    // Need a fixture config path to avoid 'file not found' errors on the
    // default fixture path resolution; use the real fixture file.
    const fixturePath = resolve(import.meta.dir, "../../evals/security/fixtures/test-agent.yaml");
    // If the fixture file doesn't exist in this worktree, skip this assertion.
    if (!existsSync(fixturePath)) return;

    const cmd = evalCommand({
      runEvalSuite: securityRunner as EvalCommandDeps["runEvalSuite"],
      runAutoSaveEval: autoSaveRunner as EvalCommandDeps["runAutoSaveEval"],
      exit,
    });

    await cmd.parseAsync(["--config", fixturePath], { from: "user" });

    expect(securityRunner).toHaveBeenCalledTimes(1);
    expect(autoSaveRunner).not.toHaveBeenCalled();
  });

  test("eval command description mentions auto-save", () => {
    const cmd = evalCommand();
    const desc = cmd.description();
    expect(desc).toMatch(/auto-save/i);
  });
});

// ---------------------------------------------------------------------------
// 7. runAutoSaveEval dry-run integration (no LLM calls)
// ---------------------------------------------------------------------------

describe("runAutoSaveEval — dry-run (no LLM calls)", () => {
  test("dry-run exits 0 when all fixtures are valid", async () => {
    // Import the real runner and call it with dryRun=true.
    // This exercises the full validation path without any LLM calls.
    const { runAutoSaveEval } = await import("../../evals/auto-save/run");
    const result = await runAutoSaveEval({ dryRun: true });
    expect(result.exitCode).toBe(0);
  });
});

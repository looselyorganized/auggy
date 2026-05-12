/**
 * Layered-memory integration eval runner.
 *
 * Three modes:
 *
 *   --dry-run   Parse suite.yaml + every referenced fixture. Validate shapes.
 *               Exit 0 if all OK, 1 if any invalid. No agent boot, no LLM calls.
 *
 *   --mock      Run each case end-to-end via the mock harness. Recording
 *               extraction engine returns canned per-fixture responses; mock
 *               model emits canned per-turn replies. Reports per-grader pass/
 *               fail, writes JSONL to results/<timestamp>.jsonl. No LLM calls.
 *               Default mode.
 *
 *   --smoke     Live Haiku smoke test (separate file: smoke.ts; this entry
 *               point points operators at it but doesn't run it directly).
 *
 * Usage:
 *   bun run evals/layered-memory/run.ts [--dry-run | --mock]
 *   bun run evals/layered-memory/run.ts --case <case-id>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { Fixture, RunSummary, Suite, TrialResult } from "./types";
import { runFixture } from "./harness/runner";
import { getGrader } from "./graders/index";

// ---------------------------------------------------------------------------
// Suite + fixture loading
// ---------------------------------------------------------------------------

function loadSuite(): Suite {
  const path = resolve(import.meta.dir, "suite.yaml");
  if (!existsSync(path)) {
    throw new Error(`suite.yaml not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as Suite;
  if (!parsed.suite || !parsed.version || !Array.isArray(parsed.cases)) {
    throw new Error("Invalid suite.yaml: missing suite/version/cases");
  }
  return parsed;
}

function loadFixture(fixturePath: string): Fixture {
  const absPath = resolve(import.meta.dir, fixturePath);
  if (!existsSync(absPath)) {
    throw new Error(`Fixture not found: ${absPath}`);
  }
  return parseYaml(readFileSync(absPath, "utf-8")) as Fixture;
}

// ---------------------------------------------------------------------------
// Validation (dry-run)
// ---------------------------------------------------------------------------

interface ValidationIssue {
  caseId: string;
  field: string;
  message: string;
}

function validateFixture(caseId: string, fixture: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!fixture || typeof fixture !== "object") {
    issues.push({ caseId, field: "root", message: "must be a YAML object" });
    return issues;
  }
  const f = fixture as Record<string, unknown>;

  if (typeof f.case_id !== "string" || f.case_id.length === 0) {
    issues.push({ caseId, field: "case_id", message: "must be a non-empty string" });
  }
  if (!f.peer && !f.peers) {
    issues.push({ caseId, field: "peer/peers", message: "fixture must declare `peer` or `peers`" });
  }
  if (!Array.isArray(f.sessions) || f.sessions.length === 0) {
    issues.push({ caseId, field: "sessions", message: "must be a non-empty array" });
  } else {
    for (let i = 0; i < f.sessions.length; i++) {
      const s = f.sessions[i] as Record<string, unknown>;
      if (typeof s.threadId !== "string") {
        issues.push({ caseId, field: `sessions[${i}].threadId`, message: "must be a string" });
      }
      if (!Array.isArray(s.turns) || s.turns.length === 0) {
        issues.push({ caseId, field: `sessions[${i}].turns`, message: "must be non-empty" });
      }
    }
  }
  if (!Array.isArray(f.mockExtractions)) {
    issues.push({ caseId, field: "mockExtractions", message: "must be an array" });
  }
  if (typeof f.userFacingCostPerTurnUsd !== "number") {
    issues.push({ caseId, field: "userFacingCostPerTurnUsd", message: "must be a number" });
  }
  if (!f.expected || typeof f.expected !== "object") {
    issues.push({ caseId, field: "expected", message: "must be an object" });
  }
  return issues;
}

function dryRun(): { ok: boolean; issues: ValidationIssue[] } {
  const suite = loadSuite();
  const allIssues: ValidationIssue[] = [];
  for (const c of suite.cases) {
    try {
      const fixture = loadFixture(c.fixture);
      allIssues.push(...validateFixture(c.id, fixture));
    } catch (err) {
      allIssues.push({ caseId: c.id, field: "file", message: (err as Error).message });
    }
  }
  return { ok: allIssues.length === 0, issues: allIssues };
}

// ---------------------------------------------------------------------------
// Mock mode (full runner)
// ---------------------------------------------------------------------------

async function mockRun(caseFilter?: string): Promise<{ ok: boolean; summary: RunSummary }> {
  const suite = loadSuite();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-mock`;
  const startedAtIso = new Date().toISOString();
  const startMs = Date.now();
  const trials: TrialResult[] = [];

  const cases = caseFilter ? suite.cases.filter((c) => c.id === caseFilter) : suite.cases;
  if (cases.length === 0) {
    throw new Error(caseFilter ? `case-id "${caseFilter}" not found` : "suite has no cases");
  }

  console.log(`layered-memory eval — running ${cases.length} case(s) in mock mode`);
  for (const c of cases) {
    process.stdout.write(`  ${c.id}: `);
    const fixture = loadFixture(c.fixture);
    const evidence = await runFixture({ fixture, autoSaveEnabled: true });

    const graderResults = c.graders.map((type) => getGrader(type)(evidence, fixture));
    const allPassed = evidence.ok && graderResults.every((g) => g.passed);

    trials.push({
      caseId: c.id,
      fixtureId: fixture.case_id,
      startedAt: new Date(evidence.startedAt).toISOString(),
      durationMs: evidence.durationMs,
      passed: allPassed,
      graderResults,
      evidenceSummary: {
        userFacingTurns: evidence.userFacingTurns.length,
        extractionTurns: evidence.extractionTurns.length,
        extractionPrompts: evidence.extractionPrompts.length,
        totalEntries: Object.values(evidence.entriesByPeer).reduce((a, e) => a + e.length, 0),
        peersTouched: Object.keys(evidence.entriesByPeer).length,
        unexpectedError: evidence.unexpectedError,
      },
    });

    if (allPassed) {
      console.log("ok");
    } else {
      console.log("FAIL");
      for (const g of graderResults) {
        if (!g.passed) console.log(`    - ${g.type}: ${g.reason}`);
      }
      if (evidence.unexpectedError) {
        console.log(`    - harness: ${evidence.unexpectedError}`);
      }
    }
  }

  const finishedAtIso = new Date().toISOString();
  const summary: RunSummary = {
    runId,
    suite: suite.suite,
    suiteVersion: suite.version,
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationMs: Date.now() - startMs,
    totalCases: trials.length,
    passedCases: trials.filter((t) => t.passed).length,
    trials,
  };

  // Persist JSONL
  const resultsDir = resolve(import.meta.dir, "results");
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${runId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ kind: "summary", ...summary, trials: undefined }),
    ...trials.map((t) => JSON.stringify({ kind: "trial", ...t })),
  ];
  writeFileSync(outPath, lines.join("\n") + "\n");

  console.log(`\n${summary.passedCases}/${summary.totalCases} cases passed in ${summary.durationMs}ms`);
  console.log(`results: ${outPath}`);
  return { ok: summary.passedCases === summary.totalCases, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  mode: "dry-run" | "mock" | "smoke-help";
  caseFilter?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "mock" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--mock") args.mode = "mock";
    else if (a === "--smoke") args.mode = "smoke-help";
    else if (a === "--case" && argv[i + 1]) {
      args.caseFilter = argv[i + 1]!;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`layered-memory eval runner.

Usage:
  bun run evals/layered-memory/run.ts [--dry-run | --mock] [--case <case-id>]
  bun run evals/layered-memory/smoke.ts            # live Haiku smoke test

Modes:
  --dry-run   Validate fixtures only, no agent boot.
  --mock      Default. Full mock-mode execution; reports per-grader results.
  --case <id> Filter to a single case.
`);
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "smoke-help") {
    console.log("Live Haiku smoke test lives at evals/layered-memory/smoke.ts.");
    console.log("Run: bun run evals/layered-memory/smoke.ts");
    console.log("Requires ANTHROPIC_API_KEY in the environment. Budget: <=$1.50.");
    process.exit(0);
  }
  if (args.mode === "dry-run") {
    const { ok, issues } = dryRun();
    if (issues.length > 0) {
      for (const i of issues) console.log(`  ${i.caseId}.${i.field}: ${i.message}`);
    } else {
      const suite = loadSuite();
      console.log(`ok — ${suite.cases.length} cases, fixtures all valid`);
    }
    process.exit(ok ? 0 : 1);
  }
  const { ok } = await mockRun(args.caseFilter);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("runner crashed:", err);
    process.exit(2);
  });
}

export { dryRun, mockRun, loadSuite, loadFixture };

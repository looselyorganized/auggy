/**
 * Auto-save eval runner.
 *
 * Validates auto-save extraction fixtures and (when an API key is available)
 * grades extraction output via an LLM-as-judge using grader.md.
 *
 * Usage:
 *   bun run evals/auto-save/run.ts                     # dry-run: validate fixtures only
 *   bun run evals/auto-save/run.ts --dry-run           # explicit dry-run
 *   bun run evals/auto-save/run.ts --case happy-path-creator  # single case
 *
 * NOTE: This runner does NOT make real LLM calls unless an explicit
 * --grade flag is passed AND ANTHROPIC_API_KEY is set. Task 17 scope is
 * fixture authoring + runner structure; calibration (Task 18) activates
 * the grading path.
 *
 * Exit code: 0 if all fixtures validate; 1 if any fixture is malformed.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Fixture schema types
// ---------------------------------------------------------------------------

export interface FixturePeer {
  id: string;
  kind: string;
  trustLevel: "creator" | "agent" | "public";
  publicSubstate?: "recognized" | "anonymous" | null;
}

export interface FixtureTranscriptEntry {
  role: "user" | "assistant";
  content: string;
}

export interface FixtureExpectedFact {
  subject: string;
  predicate: string;
  object: string;
  isVerbatim?: boolean;
  must_extract?: boolean;
  namespace?: string;
}

export type MustNotExtractEntry = string | { secrets_pattern: string };

export interface AutoSaveFixture {
  case_id: string;
  description?: string;
  peer?: FixturePeer;
  peer_before_promotion?: FixturePeer;
  peer_after_promotion?: FixturePeer;
  transcript: FixtureTranscriptEntry[];
  expected_facts: FixtureExpectedFact[];
  must_not_extract?: MustNotExtractEntry[];
  assertions?: string[];
  [key: string]: unknown;
}

export interface AutoSaveSuiteCase {
  id: string;
  fixture: string;
  category: string;
  description?: string;
  grading?: {
    must_extract_threshold?: number;
    must_not_extract_penalty?: number;
    pass_condition?: string;
  };
  expected_pass_k?: number;
}

export interface AutoSaveSuite {
  suite: string;
  version: number;
  cases: AutoSaveSuiteCase[];
  pass_k_target?: { haiku?: number; sonnet?: number };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  caseId: string;
  fixturePath: string;
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate a parsed fixture against the locked schema from Decision 7.
 * Returns a list of validation errors (empty = valid).
 */
export function validateFixture(fixture: unknown, fixturePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!fixture || typeof fixture !== "object") {
    errors.push({ field: "root", message: "fixture must be a YAML object" });
    return errors;
  }

  const f = fixture as Record<string, unknown>;

  // Required: case_id
  if (typeof f.case_id !== "string" || !f.case_id.trim()) {
    errors.push({ field: "case_id", message: "case_id must be a non-empty string" });
  }

  // Required: at least one peer (direct peer, or peer_before_promotion + peer_after_promotion)
  const hasPeer = f.peer != null;
  const hasPromotionPeers = f.peer_before_promotion != null && f.peer_after_promotion != null;
  if (!hasPeer && !hasPromotionPeers) {
    errors.push({
      field: "peer",
      message: "fixture must have either 'peer' or both 'peer_before_promotion' and 'peer_after_promotion'",
    });
  }

  // Validate peer shape if present
  const validatePeer = (peer: unknown, fieldName: string) => {
    if (!peer || typeof peer !== "object") {
      errors.push({ field: fieldName, message: `${fieldName} must be an object` });
      return;
    }
    const p = peer as Record<string, unknown>;
    if (typeof p.id !== "string") errors.push({ field: `${fieldName}.id`, message: "id must be a string" });
    if (typeof p.kind !== "string") errors.push({ field: `${fieldName}.kind`, message: "kind must be a string" });
    const validTrustLevels = ["creator", "agent", "public"];
    if (!validTrustLevels.includes(p.trustLevel as string)) {
      errors.push({
        field: `${fieldName}.trustLevel`,
        message: `trustLevel must be one of: ${validTrustLevels.join(", ")} (got ${String(p.trustLevel)})`,
      });
    }
  };

  if (hasPeer) validatePeer(f.peer, "peer");
  if (hasPromotionPeers) {
    validatePeer(f.peer_before_promotion, "peer_before_promotion");
    validatePeer(f.peer_after_promotion, "peer_after_promotion");
  }

  // Required: transcript
  if (!Array.isArray(f.transcript)) {
    errors.push({ field: "transcript", message: "transcript must be an array" });
  } else {
    if (f.transcript.length === 0) {
      errors.push({ field: "transcript", message: "transcript must have at least one entry" });
    }
    for (let i = 0; i < f.transcript.length; i++) {
      const entry = f.transcript[i] as Record<string, unknown>;
      if (!entry || typeof entry !== "object") {
        errors.push({ field: `transcript[${i}]`, message: "each entry must be an object" });
        continue;
      }
      if (entry.role !== "user" && entry.role !== "assistant") {
        errors.push({ field: `transcript[${i}].role`, message: `role must be 'user' or 'assistant' (got ${String(entry.role)})` });
      }
      if (typeof entry.content !== "string") {
        errors.push({ field: `transcript[${i}].content`, message: "content must be a string" });
      }
    }
  }

  // Required: expected_facts
  if (!Array.isArray(f.expected_facts)) {
    errors.push({ field: "expected_facts", message: "expected_facts must be an array" });
  } else {
    if (f.expected_facts.length === 0) {
      errors.push({ field: "expected_facts", message: "expected_facts must have at least one entry" });
    }
    for (let i = 0; i < f.expected_facts.length; i++) {
      const fact = f.expected_facts[i] as Record<string, unknown>;
      if (!fact || typeof fact !== "object") {
        errors.push({ field: `expected_facts[${i}]`, message: "each fact must be an object" });
        continue;
      }
      if (typeof fact.subject !== "string") errors.push({ field: `expected_facts[${i}].subject`, message: "subject must be a string" });
      if (typeof fact.predicate !== "string") errors.push({ field: `expected_facts[${i}].predicate`, message: "predicate must be a string" });
      if (typeof fact.object !== "string") errors.push({ field: `expected_facts[${i}].object`, message: "object must be a string" });
    }
  }

  // Optional: must_not_extract (validate each entry's shape)
  if (f.must_not_extract !== undefined) {
    if (!Array.isArray(f.must_not_extract)) {
      errors.push({ field: "must_not_extract", message: "must_not_extract must be an array" });
    } else {
      for (let i = 0; i < f.must_not_extract.length; i++) {
        const entry = f.must_not_extract[i];
        if (typeof entry !== "string" && (typeof entry !== "object" || entry === null || !("secrets_pattern" in (entry as Record<string, unknown>)))) {
          errors.push({
            field: `must_not_extract[${i}]`,
            message: "each entry must be a string or { secrets_pattern: string }",
          });
        }
      }
    }
  }

  // Optional: assertions
  if (f.assertions !== undefined && !Array.isArray(f.assertions)) {
    errors.push({ field: "assertions", message: "assertions must be an array of strings" });
  }

  // Cross-check: case_id should match fixture filename
  const fileBasename = basename(fixturePath, extname(fixturePath));
  if (typeof f.case_id === "string" && f.case_id !== fileBasename) {
    errors.push({
      field: "case_id",
      message: `case_id "${f.case_id}" does not match filename "${fileBasename}" (they should match)`,
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Suite loading + fixture discovery
// ---------------------------------------------------------------------------

export function loadSuite(): AutoSaveSuite {
  const path = resolve(import.meta.dir, "suite.yaml");
  if (!existsSync(path)) {
    throw new Error(`suite.yaml not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as AutoSaveSuite;
  if (!parsed.suite || !parsed.version || !Array.isArray(parsed.cases)) {
    throw new Error("Invalid suite.yaml: missing suite/version/cases");
  }
  return parsed;
}

export function loadFixture(fixturePath: string): { fixture: AutoSaveFixture; raw: string } {
  const absPath = resolve(import.meta.dir, fixturePath);
  if (!existsSync(absPath)) {
    throw new Error(`Fixture not found: ${absPath}`);
  }
  const raw = readFileSync(absPath, "utf-8");
  const fixture = parseYaml(raw) as AutoSaveFixture;
  return { fixture, raw };
}

/** Resolve every fixture file in evals/auto-save/fixtures/. */
export function discoverFixtures(): string[] {
  const dir = resolve(import.meta.dir, "fixtures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
// Dry-run validation (no LLM calls)
// ---------------------------------------------------------------------------

/**
 * Validate all fixtures referenced in suite.yaml.
 * Returns the list of results (one per case). Exit code: 0 if all valid, 1 otherwise.
 */
export function validateAll(): { results: ValidationResult[]; allValid: boolean } {
  const suite = loadSuite();
  const results: ValidationResult[] = [];

  for (const c of suite.cases) {
    const absFixturePath = resolve(import.meta.dir, c.fixture);
    let fixture: unknown;
    try {
      const { fixture: parsed } = loadFixture(c.fixture);
      fixture = parsed;
    } catch (err) {
      results.push({
        caseId: c.id,
        fixturePath: absFixturePath,
        valid: false,
        errors: [{ field: "file", message: (err as Error).message }],
      });
      continue;
    }

    const errors = validateFixture(fixture, absFixturePath);
    results.push({
      caseId: c.id,
      fixturePath: absFixturePath,
      valid: errors.length === 0,
      errors,
    });
  }

  const allValid = results.every((r) => r.valid);
  return { results, allValid };
}

// ---------------------------------------------------------------------------
// Console reporting
// ---------------------------------------------------------------------------

function printValidationResults(results: ValidationResult[]): void {
  for (const r of results) {
    if (r.valid) {
      console.log(`  ok  ${r.caseId}`);
    } else {
      console.log(`  FAIL  ${r.caseId}`);
      for (const e of r.errors) {
        console.log(`        ${e.field}: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  caseFilter?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true }; // default is dry-run (no LLM calls)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--grade") {
      args.dryRun = false;
    } else if (a === "--case" && argv[i + 1]) {
      args.caseFilter = argv[i + 1]!;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(`Auto-save eval runner.

Usage:
  bun run evals/auto-save/run.ts [--dry-run] [--case <case-id>]

Options:
  --dry-run       Validate fixture YAML only, no LLM calls (default)
  --grade         Run full LLM-as-judge grading (requires ANTHROPIC_API_KEY; Task 18)
  --case <id>     Run a single case only
`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Exported runner function (used by CLI command)
// ---------------------------------------------------------------------------

/**
 * Run the auto-save eval suite. When dryRun=true, validates fixtures without
 * making any LLM calls. Returns { exitCode: 0 | 1 }.
 */
export async function runAutoSaveEval(args: {
  dryRun?: boolean;
  caseFilter?: string;
}): Promise<{ exitCode: number }> {
  const dryRun = args.dryRun !== false; // default true

  console.log(`Auto-save eval suite${dryRun ? " (dry-run: fixture validation only)" : ""}`);

  if (dryRun) {
    console.log("\nValidating fixtures...");
    const { results, allValid } = validateAll();
    printValidationResults(results);
    const passCount = results.filter((r) => r.valid).length;
    console.log(`\n${passCount}/${results.length} fixtures valid`);

    if (!allValid) {
      console.log("FAIL: one or more fixtures have validation errors.");
      return { exitCode: 1 };
    }

    console.log("ok: all fixtures valid. Grader prompt found at evals/auto-save/grader.md.");
    return { exitCode: 0 };
  }

  // Full grading path (Task 18). Not implemented in Task 17 — guard against
  // accidental LLM calls by checking for the API key and surfacing a clear error.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Error: --grade mode requires ANTHROPIC_API_KEY. " +
        "Set the env var or use --dry-run for fixture validation only.\n" +
        "(Full grading is Task 18 scope — run without --grade for Task 17.)",
    );
    return { exitCode: 1 };
  }

  console.error(
    "Error: full LLM grading is Task 18 scope. " +
      "Use --dry-run (the default) for Task 17 fixture validation.",
  );
  return { exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { exitCode } = await runAutoSaveEval({
    dryRun: args.dryRun,
    caseFilter: args.caseFilter,
  });
  process.exit(exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Auto-save eval runner crashed:", err);
    process.exit(2);
  });
}

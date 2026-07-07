/**
 * Layered-memory integration eval suite types.
 *
 * This suite measures end-to-end autoSave behavior: a fixture drives a real
 * `agent.inject()` loop with `layeredMemory.autoSave: true`, the harness
 * captures structured evidence (entries written, extraction prompts rendered,
 * per-turn cost steps), and graders answer structural questions — never text
 * matches — about that evidence.
 *
 * Complements `evals/auto-save/` (which is the unit eval over the extraction
 * prompt in isolation) and `packages/evals/src/security/` (which grades adversarial
 * responses). The integration shape is needed because PR β shipped autoSave
 * default-on without measuring the actual cost/value tradeoff under the
 * real turn-loop machinery — see lo/docs/auggy-oss-launch-readiness.md task #8.
 */

import type { TrustLevel } from "auggy/internal/types";
import type { StoreEntry } from "auggy/internal/augments/layeredMemory/storage/types";

// ---------------------------------------------------------------------------
// Fixture shape (YAML on disk)
// ---------------------------------------------------------------------------

export interface FixturePeerSpec {
  id: string;
  kind: "human" | "agent" | "system";
  trustLevel: TrustLevel;
  publicSubstate?: "recognized" | "anonymous" | null;
}

export interface FixtureTurnInput {
  /** User-visible utterance injected for this turn. */
  user: string;
  /** Canned assistant reply the mock model returns for this turn. */
  assistant: string;
}

export interface FixtureExpectedFact {
  /** Token expected to appear in the entry's `subject` (case-insensitive substring). */
  subjectContains?: string;
  /** Token expected to appear in `predicate` (case-insensitive substring). */
  predicateContains?: string;
  /** Token expected to appear in `object` (case-insensitive substring). */
  objectContains?: string;
  /** When set, factual-recall grader probes the store via `memory.search(query, peerId)` and requires this fact among the returned entries. */
  recallProbe?: string;
}

export interface FixtureExpectedExtraction {
  /** When the response from the mocked extraction engine is fixed (deterministic mode), this is what it returns. The harness's recording-engine echoes this back so cost/fact wiring is exercised without an API call. */
  facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
    isVerbatim?: boolean;
  }>;
  /** USD the mock engine reports for this extraction call. */
  costUsd: number;
}

export interface FixtureSession {
  /** Stable threadId used for every turn in this session. */
  threadId: string;
  /** Each turn injects one user utterance under one peer; the mock model emits one assistant reply. */
  turns: Array<FixtureTurnInput & { peerKey?: string }>;
}

export type ExtractionFrequencyOverride =
  | "every-turn"
  | "every-N-turns"
  | "session-end-only"
  | "never";

export interface FixtureExtractionFrequency {
  creator?: ExtractionFrequencyOverride;
  agent?: ExtractionFrequencyOverride;
  publicRecognized?: ExtractionFrequencyOverride;
  publicAnonymous?: ExtractionFrequencyOverride;
}

export interface Fixture {
  case_id: string;
  description?: string;

  /** Which peer drives the conversation. For peer-isolation, use `peers` instead. */
  peer?: FixturePeerSpec;
  /** Multi-peer conversation — used for peer-isolation + cross-session-recall + promotion graders. Each turn names a peerKey referenced here. */
  peers?: Record<string, FixturePeerSpec>;

  /**
   * Optional per-fixture cadence override. Defaults to every-turn for all trust
   * levels (deterministic; matches fixture extraction-call counts 1:1). The
   * promotion fixture overrides this so anon turns buffer until the flush.
   */
  extractionFrequency?: FixtureExtractionFrequency;

  /**
   * One or more sessions. Each session is a single agent.start() → inject turns → agent.stop() lifecycle.
   * Single-session fixtures declare exactly one entry; multi-session fixtures (cross-session-recall,
   * anon-to-recognized-promotion) declare 2+. The dbPath persists across sessions in the same run.
   */
  sessions: FixtureSession[];

  /** Mock extraction-engine response per scheduled extraction call. Length must match the number of extraction calls the fixture expects to fire. */
  mockExtractions: FixtureExpectedExtraction[];

  /** Pre-canned per-turn cost the harness reports for the user-facing turn. The mock model ALWAYS reports this exact cost so the cost-overhead grader has a stable denominator. */
  userFacingCostPerTurnUsd: number;

  /** Structural expectations consumed by graders. Not all need to be present — each grader checks only the field(s) it owns. */
  expected: {
    /** Per-peer facts each peer's namespace should contain after the conversation. Keys are peerKey values (or `"peer"` when the fixture uses the single-peer form). */
    factsPerPeer?: Record<string, FixtureExpectedFact[]>;
    /** Cross-namespace assertion: no entry's peerId should appear under any other peer's namespace. */
    noCrossPeerLeak?: boolean;
    /** Prompt-rendering: each rendered extraction prompt must contain ALL of these substrings (verbatim from the transcript) AND NONE of `mustNotContain`. */
    promptContains?: string[];
    promptMustNotContain?: string[];
    /** Cost-overhead: extraction cost as a fraction of user-facing turn cost MUST be <= this threshold. */
    costRatioMax?: number;
    /** False-extract: total entries written across all peers MUST be == this value (0 for no-fact fixtures). */
    totalEntriesExact?: number;
    /** Cross-session recall: per-peerKey minimum entries observable in entriesByPeer after all sessions complete. Asserts persistence across agent.stop/start. */
    crossSession?: {
      minEntriesPerPeer: Record<string, number>;
    };
    /** Anon → recognized promotion: facts written under `anonPeerKey` must migrate to `recognizedPeerKey`. */
    promotion?: {
      anonPeerKey: string;
      recognizedPeerKey: string;
      /** Minimum entries the recognized peer should have after migration. */
      minMigratedEntries: number;
      /** Other recognized peer keys whose namespaces MUST remain unaffected. */
      otherRecognizedPeerKeys?: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// Evidence captured per fixture run
// ---------------------------------------------------------------------------

export interface ExtractionPromptCapture {
  /** Order in which the extraction engine was invoked during the run (0-indexed). */
  index: number;
  /** Verbatim prompt string passed to `ExtractionEngine.complete()`. */
  prompt: string;
  /** Verbatim response the mock engine returned. */
  response: string;
  /** Cost the mock engine reported. */
  costUsd: number;
}

export interface UserFacingTurnEvidence {
  turnId: string;
  peerId: string;
  costUsd: number;
}

export interface ExtractionTurnEvidence {
  turnId: string;
  triggeringPeerId: string;
  /** From TurnResult.trace.inferenceSteps[].cost — should match recording-engine's reported costUsd. */
  costFromTraceUsd: number;
  /** Whether the trace's inference-step model label matches the canonical extraction label. */
  hasExtractionModelLabel: boolean;
}

export interface RunEvidence {
  fixtureId: string;
  startedAt: number;
  durationMs: number;
  /** True only when the run completed without unexpected exceptions. Graders should still run on partial evidence. */
  ok: boolean;
  unexpectedError?: string;

  userFacingTurns: UserFacingTurnEvidence[];
  extractionTurns: ExtractionTurnEvidence[];
  extractionPrompts: ExtractionPromptCapture[];

  /** All store entries observed AFTER the run completed, grouped by peerId. Read via a fresh sqlite-store opened on the same dbPath after agent.stop(). */
  entriesByPeer: Record<string, StoreEntry[]>;

  /** Factual-recall probe results: per probe, the entries the store's `search` returned. */
  recallProbes: Array<{ probe: string; peerId: string; returnedLabels: string[]; returnedSubjects: string[] }>;
}

// ---------------------------------------------------------------------------
// Grader contract
// ---------------------------------------------------------------------------

export type GraderType =
  | "factual-recall"
  | "peer-isolation"
  | "prompt-rendering"
  | "cost-overhead"
  | "false-extract"
  | "cross-session-recall"
  | "cross-identity-promotion";

export interface GraderResult {
  type: GraderType;
  passed: boolean;
  /** One short sentence on why the grader passed or failed. */
  reason: string;
  /** Numeric measurement (cost ratio, false-extract rate). Always present for measurement graders. */
  measurement?: number;
}

export type Grader = (evidence: RunEvidence, fixture: Fixture) => GraderResult;

// ---------------------------------------------------------------------------
// Suite + per-trial result
// ---------------------------------------------------------------------------

export interface SuiteCase {
  id: string;
  fixture: string;
  graders: GraderType[];
}

export interface Suite {
  suite: string;
  version: number;
  cases: SuiteCase[];
}

export interface TrialResult {
  caseId: string;
  fixtureId: string;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  graderResults: GraderResult[];
  evidenceSummary: {
    userFacingTurns: number;
    extractionTurns: number;
    extractionPrompts: number;
    totalEntries: number;
    peersTouched: number;
    unexpectedError?: string;
  };
}

export interface RunSummary {
  runId: string;
  suite: string;
  suiteVersion: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalCases: number;
  passedCases: number;
  trials: TrialResult[];
}

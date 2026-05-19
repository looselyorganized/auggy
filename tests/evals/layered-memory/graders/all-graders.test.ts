/**
 * Unit tests for evals/layered-memory/graders/*.
 *
 * Every grader gets both a pass case and a fail case. Pass case demonstrates
 * the structural invariant the grader is meant to check; fail case demonstrates
 * the grader actually rejects evidence that violates the invariant (catches
 * grader bit-rot — a grader that always passes is worse than no grader at all).
 *
 * Evidence is synthesized inline so we don't depend on the runner. This is the
 * "graders are pure functions" contract being exercised — they take (evidence,
 * fixture) and return GraderResult, nothing else.
 */

import { describe, expect, test } from "bun:test";
import type { Fixture, RunEvidence } from "@evals/layered-memory/types";
import { getGrader } from "@evals/layered-memory/graders/index";

const SAMPLE_PEER = {
  id: "p1",
  kind: "human" as const,
  trustLevel: "creator" as const,
};

function baseEvidence(overrides?: Partial<RunEvidence>): RunEvidence {
  return {
    fixtureId: "test",
    startedAt: 0,
    durationMs: 0,
    ok: true,
    userFacingTurns: [],
    extractionTurns: [],
    extractionPrompts: [],
    entriesByPeer: {},
    recallProbes: [],
    ...overrides,
  };
}

function baseFixture(overrides?: Partial<Fixture>): Fixture {
  return {
    case_id: "test",
    peer: SAMPLE_PEER,
    sessions: [{ threadId: "th", turns: [{ user: "hi", assistant: "hi" }] }],
    mockExtractions: [],
    userFacingCostPerTurnUsd: 0.001,
    expected: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// factual-recall
// ---------------------------------------------------------------------------

describe("factual-recall grader", () => {
  test("passes when probe returns matching subject", () => {
    const grader = getGrader("factual-recall");
    const fixture = baseFixture({
      expected: {
        factsPerPeer: {
          peer: [{ subjectContains: "peer", recallProbe: "Sam" }],
        },
      },
    });
    const evidence = baseEvidence({
      recallProbes: [
        {
          probe: "Sam",
          peerId: SAMPLE_PEER.id,
          returnedLabels: ["ev:p1:name"],
          returnedSubjects: ["peer"],
        },
      ],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when probe returns no entries", () => {
    const grader = getGrader("factual-recall");
    const fixture = baseFixture({
      expected: {
        factsPerPeer: {
          peer: [{ subjectContains: "peer", recallProbe: "Sam" }],
        },
      },
    });
    const evidence = baseEvidence({
      recallProbes: [
        { probe: "Sam", peerId: SAMPLE_PEER.id, returnedLabels: [], returnedSubjects: [] },
      ],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Sam");
  });
});

// ---------------------------------------------------------------------------
// peer-isolation
// ---------------------------------------------------------------------------

describe("peer-isolation grader", () => {
  test("passes when entries are properly peer-scoped", () => {
    const grader = getGrader("peer-isolation");
    const fixture = baseFixture();
    const evidence = baseEvidence({
      entriesByPeer: {
        p1: [
          {
            id: "1",
            label: "ev:p1:name",
            content: "Sam",
            peerId: "p1",
            trustLevel: "creator",
            createdAt: 1,
            supersededBy: null,
            retentionClass: "operational",
            isVerbatim: false,
            expiresAt: null,
          },
        ],
      },
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when entry's peerId doesn't match its bucket", () => {
    const grader = getGrader("peer-isolation");
    const fixture = baseFixture();
    const evidence = baseEvidence({
      entriesByPeer: {
        p1: [
          {
            id: "1",
            label: "ev:p1:name",
            content: "Sam",
            peerId: "p2", // mismatch
            trustLevel: "creator",
            createdAt: 1,
            supersededBy: null,
            retentionClass: "operational",
            isVerbatim: false,
            expiresAt: null,
          },
        ],
      },
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("p2");
  });
});

// ---------------------------------------------------------------------------
// prompt-rendering
// ---------------------------------------------------------------------------

describe("prompt-rendering grader", () => {
  test("passes when required substring present and forbidden absent", () => {
    const grader = getGrader("prompt-rendering");
    const fixture = baseFixture({
      expected: {
        promptContains: ["Hello"],
        promptMustNotContain: ["{{TRANSCRIPT}}"],
      },
    });
    const evidence = baseEvidence({
      extractionPrompts: [{ index: 0, prompt: "...Hello world...", response: "[]", costUsd: 0 }],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when forbidden substring leaks into prompt", () => {
    const grader = getGrader("prompt-rendering");
    const fixture = baseFixture({
      expected: {
        promptContains: ["Hello"],
        promptMustNotContain: ["{{TRANSCRIPT}}"],
      },
    });
    const evidence = baseEvidence({
      extractionPrompts: [{ index: 0, prompt: "Hello {{TRANSCRIPT}}", response: "[]", costUsd: 0 }],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("{{TRANSCRIPT}}");
  });
});

// ---------------------------------------------------------------------------
// cost-overhead
// ---------------------------------------------------------------------------

describe("cost-overhead grader", () => {
  test("reports the ratio when no threshold set (always passes)", () => {
    const grader = getGrader("cost-overhead");
    const fixture = baseFixture();
    const evidence = baseEvidence({
      userFacingTurns: [{ turnId: "u1", peerId: "p1", costUsd: 0.01 }],
      extractionTurns: [
        {
          turnId: "e1",
          triggeringPeerId: "p1",
          costFromTraceUsd: 0.005,
          hasExtractionModelLabel: true,
        },
      ],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
    expect(result.measurement).toBeCloseTo(0.5, 5);
  });

  test("fails when ratio exceeds declared max", () => {
    const grader = getGrader("cost-overhead");
    const fixture = baseFixture({ expected: { costRatioMax: 0.1 } });
    const evidence = baseEvidence({
      userFacingTurns: [{ turnId: "u1", peerId: "p1", costUsd: 0.01 }],
      extractionTurns: [
        {
          turnId: "e1",
          triggeringPeerId: "p1",
          costFromTraceUsd: 0.005,
          hasExtractionModelLabel: true,
        },
      ],
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("0.1");
  });
});

// ---------------------------------------------------------------------------
// false-extract
// ---------------------------------------------------------------------------

describe("false-extract grader", () => {
  test("passes when entries match expected (0 for no-fact fixture)", () => {
    const grader = getGrader("false-extract");
    const fixture = baseFixture({ expected: { totalEntriesExact: 0 } });
    const evidence = baseEvidence({ entriesByPeer: { p1: [] } });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when entries were written despite 0 expected", () => {
    const grader = getGrader("false-extract");
    const fixture = baseFixture({ expected: { totalEntriesExact: 0 } });
    const evidence = baseEvidence({
      entriesByPeer: {
        p1: [
          {
            id: "1",
            label: "ev:p1:x",
            content: "hallucinated",
            peerId: "p1",
            trustLevel: "creator",
            createdAt: 1,
            supersededBy: null,
            retentionClass: "operational",
            isVerbatim: false,
            expiresAt: null,
          },
        ],
      },
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(false);
    expect(result.measurement).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cross-session-recall
// ---------------------------------------------------------------------------

describe("cross-session-recall grader", () => {
  test("passes when multi-session evidence shows persistence", () => {
    const grader = getGrader("cross-session-recall");
    const fixture = baseFixture({
      peers: {
        v1: { id: "v1", kind: "human", trustLevel: "public", publicSubstate: "recognized" },
      },
      sessions: [
        { threadId: "s1", turns: [{ user: "x", assistant: "y" }] },
        { threadId: "s2", turns: [{ user: "x", assistant: "y" }] },
      ],
      expected: { crossSession: { minEntriesPerPeer: { v1: 2 } } },
    });
    const evidence = baseEvidence({
      entriesByPeer: {
        v1: Array.from({ length: 2 }, (_, i) => ({
          id: String(i),
          label: `ev:v1:${i}`,
          content: "x",
          peerId: "v1",
          trustLevel: "public" as const,
          createdAt: i,
          supersededBy: null,
          retentionClass: "operational" as const,
          isVerbatim: false,
          expiresAt: null,
        })),
      },
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when single-session fixture declares cross-session expectations", () => {
    const grader = getGrader("cross-session-recall");
    const fixture = baseFixture({
      peers: { v1: { id: "v1", kind: "human", trustLevel: "creator" } },
      sessions: [{ threadId: "s1", turns: [{ user: "x", assistant: "y" }] }],
      expected: { crossSession: { minEntriesPerPeer: { v1: 1 } } },
    });
    const result = grader(baseEvidence(), fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("session");
  });
});

// ---------------------------------------------------------------------------
// cross-identity-promotion
// ---------------------------------------------------------------------------

describe("cross-identity-promotion grader", () => {
  test("passes when recognized peer has migrated entries", () => {
    const grader = getGrader("cross-identity-promotion");
    const fixture = baseFixture({
      peers: {
        anon: { id: "anon-th", kind: "human", trustLevel: "public", publicSubstate: "anonymous" },
        recognized: {
          id: "vis_x",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "recognized",
        },
      },
      sessions: [
        { threadId: "th", turns: [{ user: "x", assistant: "y", peerKey: "anon" }] },
        { threadId: "th", turns: [{ user: "x", assistant: "y", peerKey: "recognized" }] },
      ],
      expected: {
        promotion: { anonPeerKey: "anon", recognizedPeerKey: "recognized", minMigratedEntries: 1 },
      },
    });
    const evidence = baseEvidence({
      entriesByPeer: {
        vis_x: [
          {
            id: "1",
            label: "ev:vis_x:p",
            content: "espresso",
            peerId: "vis_x",
            trustLevel: "public",
            createdAt: 1,
            supersededBy: null,
            retentionClass: "operational",
            isVerbatim: false,
            expiresAt: null,
          },
        ],
      },
    });
    const result = grader(evidence, fixture);
    expect(result.passed).toBe(true);
  });

  test("fails when recognized peer has no migrated entries", () => {
    const grader = getGrader("cross-identity-promotion");
    const fixture = baseFixture({
      peers: {
        anon: { id: "anon-th", kind: "human", trustLevel: "public", publicSubstate: "anonymous" },
        recognized: {
          id: "vis_x",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "recognized",
        },
      },
      sessions: [{ threadId: "th", turns: [{ user: "x", assistant: "y", peerKey: "anon" }] }],
      expected: {
        promotion: { anonPeerKey: "anon", recognizedPeerKey: "recognized", minMigratedEntries: 1 },
      },
    });
    const result = grader(baseEvidence(), fixture);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("vis_x");
  });
});

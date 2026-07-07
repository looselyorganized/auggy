# Layered-memory integration eval suite

End-to-end eval for the `layeredMemory` augment with `autoSave` enabled.

## What this measures (and what it doesn't)

| Suite | Layer | Asks |
|---|---|---|
| `evals/auto-save/` | **Unit** — extraction prompt in isolation | Given a fixture transcript fed directly to the extraction prompt, does the model emit the expected facts? |
| `packages/evals/src/layered-memory/` *(this suite)* | **Integration** — full agent loop with autoSave wired in | Given a fixture conversation injected through `agent.inject()`, does autoSave's whole pipeline (scheduleAfterTurn -> ctx.inject -> handleInternalTurn -> store write) produce a memory state that satisfies structural invariants? |
| `packages/evals/src/security/` | Adversarial behavior | Does the agent refuse / behave correctly under hostile inputs? |

The three are complementary. A regression that breaks auto-save's extraction prompt fails `packages/evals/src/auto-save/`; a regression that breaks the kernel's internal-turn routing fails this suite; a regression that breaks injection defenses fails `packages/evals/src/security/`.

## Modes

```bash
# Validate fixtures (no agent boot, no LLM calls)
bun run packages/evals/src/layered-memory/run.ts --dry-run

# Full mock-mode execution. Deterministic; no API key required. <30s.
bun run packages/evals/src/layered-memory/run.ts --mock

# Filter to a single case
bun run packages/evals/src/layered-memory/run.ts --mock --case cross-session-recall-multi-day

# Live Haiku smoke test (~$0.50-1.50). Requires ANTHROPIC_API_KEY.
bun run packages/evals/src/layered-memory/smoke.ts
```

Mock mode is the load-bearing CI artifact. The smoke test is a manual due-diligence step before launch.

## The graders

Every grader answers a **structural** question. No `response_contains_any` brittleness.

| Grader | Asks |
|---|---|
| `factual-recall` | For each `recallProbe` in the fixture, does `memory.search` return an entry whose subject matches? |
| `peer-isolation` | Does every entry filed under peer A actually have `peerId === A`, and does its label start with peer A's namespace prefix? |
| `prompt-rendering` | Does each rendered extraction prompt contain the transcript verbatim (`promptContains`) AND not contain prompt-injection patterns the template was supposed to defang (`promptMustNotContain`)? |
| `cost-overhead` | What's `sum(extraction cost) / sum(user-facing cost)`? Reports the ratio; gates only when the fixture sets `expected.costRatioMax`. Threshold-setting waits for live smoke-test data. |
| `false-extract` | For no-fact transcripts: are total entries written exactly `expected.totalEntriesExact` (typically 0)? Catches the "agent stored a hallucinated fact" failure mode. |
| `cross-session-recall` | **Headliner.** For multi-session fixtures (≥2 sessions, each its own agent lifecycle on the same dbPath): do entries written in session K persist to be observable after session N? |
| `cross-identity-promotion` | When an anonymous peer's session boundary crosses into a recognized peer's session on the same threadId, does the buffered-anon transcript get flushed under the recognized peer's namespace (per ADR-027 Decision 5's `maybeFlushOnPromotion` path)? |

## Fixture shape

```yaml
case_id: <unique-id>
peer:                 # single-peer fixture
  id: ...
  kind: human
  trustLevel: creator
# OR:
peers:                # multi-peer fixture
  alice: { id, kind, trustLevel, publicSubstate }

# Optional per-fixture cadence override (default: every-turn for all tiers)
extractionFrequency:
  publicAnonymous: session-end-only

sessions:             # each session = one agent lifecycle (start → turns → stop)
  - threadId: ...
    turns:
      - peerKey: alice    # required if using `peers`
        user: "..."
        assistant: "..."

mockExtractions:      # ordered: maps 1:1 to extraction-call indices across ALL sessions
  - facts: [{ subject, predicate, object, confidence, isVerbatim? }]
    costUsd: 0.0005

userFacingCostPerTurnUsd: 0.001   # stable denominator for cost-overhead grader

expected:                          # consumed by graders (only the relevant fields)
  factsPerPeer: { peer: [{ subjectContains, recallProbe }] }
  noCrossPeerLeak: true
  promptContains: ["..."]
  promptMustNotContain: ["{{TRANSCRIPT}}"]
  costRatioMax: 0.5
  totalEntriesExact: 0
  crossSession:
    minEntriesPerPeer: { v1: 2, v2: 2 }
  promotion:
    anonPeerKey: anon
    recognizedPeerKey: recognized
    minMigratedEntries: 1
```

## Interpreting results

A failed grader's `reason` field is the first line to read — it names what specifically didn't hold. For multi-grader cases (most), a single failure surfaces, but check the full JSONL output for ALL grader results since some pass-fail combinations are diagnostic. Example: cross-session-recall fails but factual-recall passes ⇒ entries persist across restart but the probe paraphrasing was off (rare, would indicate prompt drift).

JSONL results land in `packages/evals/src/layered-memory/results/<timestamp>-mock.jsonl`. Each line is either `{ kind: "summary", ... }` or `{ kind: "trial", ... }`. The summary line carries the run metadata; trial lines carry per-case grader results + evidence summaries.

## Boundary with auggy-auto-save (sibling suite)

Both suites share fixture *shape* (peer + transcript + expected facts) by design. The runtime contracts diverge:

- `evals/auto-save/`: NO agent boot, NO turn-loop. The fixture transcript is fed directly to the extraction prompt template. Graders inspect the JSON the prompt emits.
- `packages/evals/src/layered-memory/` (this): Real `agent.inject()` per turn, real autoSave path, real store writes. Graders inspect post-run store state + extraction-prompt captures.

If you're testing the extraction prompt itself, write a unit case in `evals/auto-save/`. If you're testing what happens when autoSave is wired into a running agent, write an integration case here.

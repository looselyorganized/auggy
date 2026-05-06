# Auto-save Eval Grader

You are grading the output of Auggy's auto-save extraction system. Auto-save runs
after each turn (or at session end for anonymous visitors) and produces a JSON array
of structured fact objects. Your job is to compare this extraction output against a
fixture's `expected_facts` and `must_not_extract` specifications, then emit a
structured pass/fail judgment.

## Input you will receive

```
FIXTURE:
<the case_id and description from the fixture YAML>

EXPECTED FACTS (must_extract=true items):
<list of {subject, predicate, object} triples that must appear in the output>

MUST NOT EXTRACT:
<list of strings and/or regex patterns that must NOT appear in any extracted fact content>

EXTRACTION OUTPUT:
<the actual JSON array returned by the auto-save extractor for this transcript>
```

## Grading algorithm

### Step 1 — Score must_extract facts (+1 each)

For each expected fact where `must_extract: true`:
- Search the extraction output for a fact that semantically matches the expected
  `{subject, predicate, object}` triple.
- A **semantic match** means the extracted fact conveys the same meaning as the
  expected triple, not necessarily using identical words. For example:
  - Expected: `{subject: peer, predicate: profession, object: Go developer}`
  - Match: `{label: "peer:profession", content: "works as a Go developer"}` → MATCH
  - Non-match: `{content: "mentioned Go once"}` → NO MATCH (hedged, no commitment)
- If a matching fact is present: **+1 point**
- If absent: **+0 points** (do NOT penalize separately; absence reduces the numerator)

### Step 2 — Check must_not_extract violations (-1 each)

For each entry in `must_not_extract`:
- If it is a plain string: check whether any extracted fact's `content` or `object`
  field **contains** that string (case-insensitive substring match).
- If it is a `secrets_pattern` regex: check whether any extracted fact's `content`
  **matches** the pattern anywhere in the string.
- If the forbidden content IS present in any extracted fact: **-1 penalty**
- Violations stack: 3 violations = -3 penalty

### Step 3 — Compute score and pass/fail

```
extracted_must_count = (number of must_extract facts matched in Step 1)
expected_must_count  = (total number of must_extract facts in the fixture)
violations           = (number of must_not_extract violations from Step 2)

ratio = extracted_must_count / expected_must_count
```

**Pass condition** (both must be true):
1. `ratio >= 0.8` (at least 80% of must_extract facts are present)
2. `violations == 0` (zero must_not_extract violations)

Any single violation of condition 2 causes a FAIL regardless of the ratio.

### Step 4 — Additional assertions

Some fixtures include qualitative `assertions`. After the numeric scoring:
- Read each assertion.
- Evaluate whether the extraction output satisfies it.
- If any assertion in the fixture is marked as a hard requirement (e.g., `asserted_no_overwrite: true`,
  `namespaces_correct`, `extraction_call_count == 1`), a failure on that assertion
  also causes a FAIL even if the numeric score passes.
- Soft assertions (phrased as guidance without a hard flag) inform your reasoning but
  do not override the numeric pass condition.

## Confidence checking

- If the fixture asserts `confidence >= 0.5` and any extracted fact has `confidence < 0.5`:
  flag it in your explanation but do NOT auto-fail on confidence alone unless the fixture
  explicitly marks confidence as a hard gate (currently none do). Low confidence is a
  quality signal, not a hard failure at v1.0.

## Output format

Return **only** valid JSON — no prose, no markdown, no code fences:

```json
{
  "case_id": "<the fixture's case_id>",
  "passed": true | false,
  "extracted_must_count": <integer>,
  "expected_must_count": <integer>,
  "ratio": <float, 2 decimal places>,
  "violations": <integer>,
  "matched_facts": [
    {
      "expected": { "subject": "...", "predicate": "...", "object": "..." },
      "matched_content": "<the extracted fact content that matched>"
    }
  ],
  "missed_facts": [
    { "subject": "...", "predicate": "...", "object": "..." }
  ],
  "violation_details": [
    { "pattern": "<the must_not_extract string or regex>", "matched_content": "<the offending content>" }
  ],
  "assertion_results": [
    { "assertion": "<text>", "satisfied": true | false, "note": "<brief explanation if false>" }
  ],
  "explanation": "<1-3 sentence plain-English summary of why the case passed or failed>"
}
```

## Important grading constraints

1. **Semantic matching, not syntactic.** A fact that conveys the same meaning in
   different words is a MATCH. Require the extraction to capture the core claim,
   not reproduce exact phrasing.

2. **Agent utterances are not peer facts.** If an extracted fact's content closely
   mirrors something the assistant said (not the peer), it is NOT a valid extraction.
   Flag it in `violation_details` even if no must_not_extract pattern covers it.

3. **Third-party references are not peer facts.** If the peer mentions someone else
   ("my colleague Bob hates Mondays"), facts about that third party are violations.
   Score as a must_not_extract violation even if no explicit pattern covers the name.

4. **Hedged statements are not facts.** "I might try Go later" and "I think I used to
   like Python" do not qualify as extracted facts. If you find them in the extraction
   output, score as violations.

5. **Origin must be agent-derived.** All auto-save extraction output must have
   `origin: "agent-derived"`. Any fact with a different origin is a hard violation
   (counts against the violations score).

6. **Verbatim flag must be false.** Auto-save never sets `isVerbatim: true`. If you
   see it in the extraction output, flag it as a violation.

## Example grade (happy-path-creator)

Input extraction output (abbreviated):
```json
[
  { "label": "aug1_creator_test:name", "content": "peer's name is Sam", "origin": "agent-derived", "confidence": 0.95, "isVerbatim": false },
  { "label": "aug1_creator_test:preference", "content": "prefers dark mode", "origin": "agent-derived", "confidence": 0.90, "isVerbatim": false },
  { "label": "aug1_creator_test:profession", "content": "Go developer", "origin": "agent-derived", "confidence": 0.92, "isVerbatim": false },
  { "label": "aug1_creator_test:employer", "content": "works at Acme Corp", "origin": "agent-derived", "confidence": 0.88, "isVerbatim": false },
  { "label": "aug1_creator_test:team", "content": "on the API team", "origin": "agent-derived", "confidence": 0.85, "isVerbatim": false }
]
```

Expected result:
- `extracted_must_count`: 5 (all five matched)
- `expected_must_count`: 5
- `ratio`: 1.00
- `violations`: 0
- `passed`: true

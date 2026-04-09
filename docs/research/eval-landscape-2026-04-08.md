# Research: Agent Eval Landscape 2026

**Date of research:** 2026-04-08
**Research method:** Two parallel web-researcher subagents (Firecrawl + web search + context7)
**Scope:** OpenClaw's eval harness + the broader practitioner consensus on agent evals in 2025-2026
**Purpose:** Inform Auggy's eval strategy before migration of Zip from OpenClaw to Auggy
**Provenance note:** The URLs and specific details in Part 1 were surfaced by a web-research subagent on the date above. Treat as a point-in-time snapshot; verify before acting on any specific URL. The Part 2 findings are synthesized from multiple practitioner sources and are more stable over time.

---

## Summary

OpenClaw ships **no internal eval harness** in its main repository. What exists for OpenClaw is a fragmented constellation of three external community projects, each covering a narrow slice, with no cohesive methodology between them. Their aggregate coverage of the dimensions practitioners actually care about (2025–2026 consensus) is thin.

The practitioner consensus from Anthropic, shipping engineers, and academic sources points to a small set of load-bearing principles: grade outcomes not transcripts, distinguish capability from regression evals, use Pass^k not Pass@1, read your transcripts, start with 20–50 tasks from real failures, and use deterministic graders where possible with LLM-as-judge (binary verdicts, human-calibrated) where necessary.

**Recommendation for Auggy:** do not copy OpenClaw's fragmented pattern. Build eval affordances into the runtime from the start, grounded in the Anthropic prescription. See [`auggy-plans-roadmap.md#plan-7-eval-harness--observability`](../../../docs/auggy-plans-roadmap.md#plan-7-eval-harness--observability) for the concrete plan.

---

## Part 1 — OpenClaw's eval harness

### 1.1 The main repo ships no eval harness

OpenClaw's main repository (`openclaw/openclaw`) CI workflow runs a standard build/test/lint pipeline — unit tests for the runtime itself, not evals for agent behavior. There is no internal benchmark runner, no trace-replay system, no regression harness for agent behavior.

Everything "eval-shaped" for OpenClaw is community-built and external, split across three separate projects with no shared methodology:

### 1.2 Claw-Eval — the task benchmark

**Project:** `github.com/claw-eval/claw-eval`
**Maintainer:** PKU / HKU researchers, project lead Lei Li (HKU)
**Status (per research):** ~340 stars, active, last commit near the research date

**Shape:** End-to-end real-world task runner, analogous to SWE-bench or OSWorld for the OpenClaw agent loop. Python CLI, Docker sandboxes per task.

**Scale:** 139 tasks across 15 real services (v1.0), +35 multimodal tasks added in v1.1. Task fixtures include video files, hosted on HuggingFace due to GitHub size limits.

**Invocation:**
```bash
claw-eval batch --config model_configs/claude_opus_46.yaml --sandbox --trials 3 --parallel 16
```

**Input format:** YAML configs per model; task fixtures in `tasks/`. Per-task schema not fully documented in the README but structurally includes a natural-language prompt, required services, and task-specific grading logic.

**What it grades:**
- **Binary per-trial pass/fail** against deterministic state verification of the sandboxed services after the run
- **Primary metric: Pass^3** — a task only counts as passing if the agent succeeds in *all three* independent trials. This is their stated method for eliminating lucky one-shot wins, and it is one of the few things OpenClaw's eval ecosystem gets unambiguously right by 2025-2026 practitioner standards.
- **Leaderboard** at claw-eval.github.io ranks 23 models

**What it explicitly does NOT grade:**
- Per-turn or per-tool-call behavior
- Tool-use correctness (which tools, what args)
- Safety / refusal behavior
- Cost per task or tokens used
- Latency
- Reasoning trajectory quality
- Regression vs baseline (no regression suite)

**Grading mechanism:** Deterministic state verification implemented in `src/claw_eval/` (Python). Commit messages mention "fix bugs for grading," indicating the grading logic is non-trivial and evolving. The project's own roadmap acknowledges current grading is crude and flags "comprehensive, fine-grained scoring logic with deep state verification" as a future work item. No LLM-as-judge in the current version, though tasks mix content from OpenClaw, PinchBench, OfficeQA, OneMillion-Bench, Finance Agent, and Terminal-Bench 2.0 — which themselves use various grading approaches.

**Granularity:** Per-task, per-trial. No per-turn or per-tool-call scoring.

**Assessment:** The Pass^3 methodology is more statistically honest than the single-trial benchmarks that dominate the space. But the grading is acknowledged as immature by its own roadmap, and the dimensions it doesn't cover (cost, latency, trajectory quality, regression stability) are exactly the ones shipping practitioners care about most.

### 1.3 openclaw-memory-bench — retrieval benchmark

**Project:** `github.com/phenomenoner/openclaw-memory-bench`
**Maintainer:** Single developer (LyriaClaw)
**Status (per research):** ~1 star, last commit March 2026, longevity uncertain

**Shape:** A Python CLI benchmark narrowly scoped to OpenClaw's memory plugin layer. Does not measure overall agent quality.

**Invocation:**
```bash
uv run openclaw-memory-bench run-retrieval --provider openclaw-mem --dataset ... --top-k 5
```

**Input format:** JSON dataset files; can ingest LongMemEval and similar public memory benchmarks via `prepare-dataset`.

**What it grades — Track A (deterministic IR metrics):**
- Hit@K, Recall@K, Precision@K
- Mean Reciprocal Rank (MRR)
- Normalized Discounted Cumulative Gain (nDCG)
- Latency (p50, p95)

**What it grades — Track B (end-to-end, optional):**
- Retrieval → answer model → LLM judge pipeline
- Accuracy + cost and latency metadata
- Uses an OpenAI model as judge (specific model unspecified)

**Granularity:** Per-question for retrieval metrics, per-session-type for end-to-end QA.

**Assessment:** This is a narrow but well-structured retrieval benchmark. It's the most methodologically sound of the three OpenClaw eval projects by traditional IR standards. The Track A / Track B split matches the offline/online pattern practitioners use. But it's single-developer, poorly socialized, and its scope is limited to memory — it says nothing about agent behavior, tool use, or end-to-end quality.

### 1.4 FinClaw skill-creator eval loop — embedded meta-eval

**Project:** `github.com/aifinlab/FinClaw/blob/main/skills/skill-creator/SKILL.md`
**Maintainer:** aifinlab (Chinese-language financial research fork of OpenClaw)

**Shape:** Not a standalone harness — it is an agentic workflow embedded inside a `skill-creator` skill. When you use OpenClaw to build or iterate on a skill, this SKILL.md instructs the agent to run structured evals automatically using sub-agents.

**This is the most architecturally interesting of the three:** an agent building its own skill runs its own evals on itself, with its own sub-agents judging, and the whole thing is configured in a markdown file.

**What it grades:**
- Skill output quality, with-skill vs without-skill (or new vs old skill)
- Per-assertion pass/fail (assertions defined dynamically during the run)
- Token usage and latency (captured from sub-agent completion events)
- Description triggering accuracy (separate optimization loop: 60/40 train/test split, 3 runs per query, up to 5 iterations)

**How it grades:**
- **Deterministic assertions** scripted via `scripts/aggregate_benchmark.py`
- **LLM-as-judge** via a grader sub-agent (`agents/grader.md`) with schema `{text, passed, evidence}` per assertion
- **Blind A/B comparator** sub-agent (`agents/comparator.md`) judges two outputs without knowing which is which
- **Human review** via a browser-based viewer (`eval-viewer/generate_review.py`) collecting per-case feedback into `feedback.json`

**Granularity:** Per-skill, per-test-case, per-iteration of the improvement loop.

**Assessment:** The blind A/B comparator pattern is clever — it sidesteps position bias in LLM-as-judge by presenting outputs without revealing which is the new version. The structured assertion-based grading (rather than holistic scoring) aligns with Hamel Husain's recommendations. But this is scoped to the skill-creator workflow only — it doesn't help you evaluate an agent in production, only during skill development.

### 1.5 Aggregate assessment of OpenClaw's eval story

| Dimension | Claw-Eval | Memory-Bench | Skill-Creator Loop |
|---|---|---|---|
| End-to-end task success | ✓ (Pass^3) | ✗ | partial (per-skill) |
| Tool-use correctness | ✗ | ✗ | ✗ |
| Regression suite (every commit) | ✗ | ✗ | ✗ |
| Cost per task | ✗ | ✓ | ✓ |
| Latency | ✗ | ✓ | ✓ |
| Trajectory / reasoning quality | ✗ | ✗ | partial (assertions) |
| Transcript viewing tooling | ✗ | ✗ | ✓ (browser viewer) |
| Production observability | ✗ | ✗ | ✗ |
| LLM-as-judge (calibrated) | ✗ | partial (Track B) | ✓ |
| Deterministic graders | ✓ (state check) | ✓ (IR metrics) | ✓ (scripted) |
| Capability vs regression split | ✗ | ✗ | ✗ |
| Pass^k reliability methodology | ✓ (Pass^3) | ✗ | ✓ (3 runs × description loop) |
| Living artifact / ownership | fragmented | single dev | per-skill |

**Verdict:** OpenClaw has some genuinely good ideas (Pass^3 in Claw-Eval, blind A/B comparator in FinClaw) scattered across three projects with no cohesion, no shared methodology, and no production-connected eval path. The critique isn't that the individual projects are bad — it's that a runtime this mature has an eval story that's surface-level by 2025-2026 practitioner standards, and the tools the community built are narrow slices, not a coherent framework.

---

## Part 2 — What experienced AI engineers actually care about in evals (2025–2026)

This section synthesizes the practitioner consensus from shipping engineers (Hamel Husain, Eugene Yan, Shreya Shankar), frontier labs (Anthropic, OpenAI), and academic sources. Where practitioners disagree, both sides are noted.

### 2.1 Load-bearing dimensions (ranked by practitioner frequency)

**Actually measured:**

1. **Task success / correctness** — The non-negotiable. Anthropic's Jan 2026 guide makes a critical distinction: the *transcript* (what the agent said) vs. the *outcome* (what state the environment is in after). A flight-booking agent saying "Your flight is booked" is not the same as a reservation existing in the database. Grade the outcome. *(Source: Anthropic, "Demystifying evals for AI agents," Jan 2026.)*

2. **Tool use correctness** — Which tools were called, with what parameters. Verified as part of graders. Anthropic's example eval YAML explicitly checks `required: [{tool: verify_identity}, {tool: process_refund, params: {amount: "<=100"}}]`. Important warning: **don't grade sequence too rigidly.** Anthropic: "agents regularly find valid approaches that eval designers didn't anticipate." Check that required tools were used; don't enforce exact ordering.

3. **Regression vs baseline** — Anthropic explicitly distinguishes "capability evals" (hill-climbing, low pass rate, for improving the agent) from "regression evals" (nearly 100% pass rate, run on every commit, to catch breakage). Teams without this distinction get stuck in whack-a-mole debugging.

4. **Cost per task / token usage** — Tracked as a metric alongside graders, not usually a grader itself. Anthropic's YAML schema shows `n_total_tokens`, `time_to_last_token`, and `output_tokens_per_sec` as tracked metrics, not pass/fail criteria.

5. **Latency (time-to-first-token, time-to-last-token, tokens/sec)** — Same pattern as cost: tracked as a metric. Something evals give you "for free" once the infrastructure exists.

6. **Consistency / determinism across runs (Pass^k)** — The `pass^k` metric (probability that *all* k trials succeed) is specifically designed for this. Sierra's τ-bench finding is striking and widely cited: GPT-4o drops from ~50% pass@1 to ~25% pass^8 in retail scenarios — a 60% collapse in reliability, described as "far behind the expectation of a real-world user-facing agent." Single-run eval scores are increasingly considered misleading. *(Source: Sierra AI, "Benchmarking AI Agents," Jun 2024.)*

7. **Reasoning / trajectory quality** — Increasingly measured, but still hard. Anthropic recommends grading transcripts (not just outcomes) for coding and research agents. Academic work notes that "focusing solely on success/failure at the end misses crucial insights into how and why the agent succeeded or failed." *(Source: arXiv:2508.02994.)*

**Frequently talked about, rarely measured rigorously:**

- **Hallucination rate** — Discussed constantly, hard to operationalize beyond groundedness checks for RAG. Anthropic's guide mentions "groundedness checks verify that claims are supported by retrieved sources," but this is easier for retrieval-heavy agents than for generative ones.
- **Safety / refusal behavior** — Critical for safety teams but niche in product eval contexts. Covered in Anthropic's alignment auditing work.
- **User-reported quality (thumbs/retention)** — A/B testing and user feedback are treated as expensive, slow-to-signal methods. Hamel Husain calls these "Level 3" evals, reached only after Level 1 (unit tests) and Level 2 (model/human eval) are solid.

### 2.2 Methodology patterns

**Offline vs online:**

Strong consensus: start offline (automated evals against a fixed dataset), graduate to online (production monitoring, A/B tests) only after offline evals are healthy. Hamel's three-level framework — unit tests → model/human eval → A/B testing — captures the dominant mental model. Anthropic's guide maps these to development stages: "Automated evals are especially useful pre-launch and in CI/CD... A/B testing validates significant changes once you have sufficient traffic." *(Source: Hamel Husain, "Your AI Product Needs Evals," Mar 2024.)*

**LLM-as-judge — does it work?**

Hamel's LLM-as-judge guide (Oct 2024) identifies the core failure modes: too many metrics, arbitrary 1–5 scales ("What makes something a 3 versus a 4? Nobody knows"), ignoring domain experts, and unvalidated metrics. His recommendations:
- **Binary pass/fail judgments, not numeric scores**
- **Calibrate the judge against a domain expert** using a spreadsheet on 25–50 examples
- **Track correlation with human judgment explicitly**
- **Use precision/recall** rather than raw agreement when classes are imbalanced

Core technique: **"Critique Shadowing"** — run the judge, run the domain expert on the same examples, track agreement, iterate the judge prompt until aligned. *(Source: Hamel Husain, "Using LLM-as-a-Judge: A Complete Guide," Oct 2024.)*

From the adversarial research side: LLM judges show consistent preferences in only ~60% of cases when answers are position-swapped, and rankings can be manipulated by answer order alone. Self-preference bias is documented. *(Sources: Wang et al., "Large Language Models are not Fair Evaluators," ACL 2024, arXiv:2305.17926; Wataoka et al., "Self-Preference Bias in LLM-as-a-Judge," NeurIPS 2024, arXiv:2410.21819.)*

Anthropic's engineering guide acknowledges this directly: "Model grading often takes careful iteration to validate accuracy... LLM-as-judge graders should be closely calibrated with human experts."

**Deterministic graders:**

Anthropic's stated preference: "We recommend choosing deterministic graders where possible, LLM graders where necessary." Deterministic approaches include string match, regex, AST/static analysis (ruff, mypy, bandit), and fail-to-pass test runs. For coding agents specifically: "does the code run and do the tests pass?"

**Human review:**

Used primarily for **calibrating** model-based graders, not as the primary grading mechanism at scale. Hamel's workflow: 25–50 examples at a time, binary labels, track model-human agreement. Anthropic: "reserve systematic human studies for calibrating LLM graders or evaluating subjective outputs where human consensus serves as the reference standard."

**Eval-driven development (EDD):**

Anthropic explicitly endorses EDD: "We recommend practicing eval-driven development: build evals to define planned capabilities *before* agents can fulfill them, then iterate until the agent performs well." This mirrors TDD but the analogy isn't perfect — evals for agents don't have the same fast feedback loop as unit tests.

Shreya Shankar's framing is broader and more provocative: "When people say they 'don't do evals,' they are usually lying to themselves." Her core argument: evals are already happening implicitly in any successful product. The question is whether they are *systematic*. *(Source: Shreya Shankar, "In Defense of AI Evals, for Everyone," 2025.)*

### 2.3 The benchmark landscape

**SWE-bench (and variants):**
Dominant coding agent benchmark. Tests agents against real GitHub issues from popular Python repos. Frontier models went from ~40% to >80% on SWE-bench Verified in roughly one year. Anthropic's guide treats it as the standard for coding agents.

**Known problems:**
- **Contamination:** an independent analysis found roughly a third of issues contain solutions in their issue comments, and another third have insufficient tests to catch incorrect fixes *(Source: Runloop, "SWE-Bench Deep Dive," Feb 2025.)*
- **Pattern matching:** models match against familiar repositories rather than reasoning about novel ones *(Source: arXiv:2506.12286.)*
- **Saturation:** approaching >80%, which limits its ability to distinguish frontier models

**τ-bench / τ2-bench:**
Sierra's benchmark for multi-turn tool + user interaction. Tests policy following, long-horizon planning, and database state verification (not textual output). Uses Pass^k to measure reliability. The finding that GPT-4o drops 60% from Pass@1 to Pass^8 is widely cited as evidence that single-run eval scores are misleading. Successor τ2-bench extends to more domains. Anthropic treats τ-bench as the reference for conversational/support agents.

**WebArena / OSWorld:**
WebArena tests browser-based tasks using URL and page state checks. OSWorld extends to full OS control with file system and app state verification. Anthropic cites both for computer use agent evaluation. High fidelity, expensive to run.

**GAIA, MLE-bench, AgentBench, ToolBench:**
Referenced in academic surveys but less dominant in practitioner conversations.

**HumanEval / MBPP:**
Considered outdated for 2025–2026 agentic work. Useful for single-function code generation, doesn't test multi-step reasoning, tool use, or agentic behavior.

**BrowseComp:**
Cited by Anthropic as a research retrieval benchmark: "questions designed to be easy to verify but hard to solve." Useful for research agents.

**Community opinion on benchmarks generally:**
A 2026 study: "Three-quarters of interviewed teams skip benchmark creation, relying instead on A/B testing and direct client collaboration." *(Source: Holstein et al., arXiv:2512.04123.)* The consensus is that public benchmarks are useful for **model selection** but not for measuring production quality of your specific agent.

### 2.4 Anti-patterns most frequently warned against

1. **Too many metrics / numeric scales.** Hamel: dashboards showing "a bunch of scores on a 1–5 scale is often a sign of a bad eval process." Multi-dimensional numeric scoring creates metrics no one understands or trusts.

2. **Grading the path, not the outcome.** Anthropic: "There is a common instinct to check that agents followed very specific steps like a sequence of tool calls in the right order. We've found this approach too rigid... agents regularly find valid approaches that eval designers didn't anticipate."

3. **Benchmark contamination.** ~1/3 of SWE-bench tasks have solutions leaked in issue text. Python benchmarks have the highest contamination rates because Python dominates training data.

4. **Single-run evals without confidence intervals.** Anthropic's Josh Miller: "without error bars, evaluation scores are essentially meaningless." *(Source: Anthropic Research, "A Statistical Approach to Language Model Evaluations," Nov 2024.)* "Because model outputs vary between runs, we run multiple trials to produce more consistent results."

5. **Eval saturation blindness.** When a benchmark hits >80%, it stops differentiating. Qodo's experience: "initially unimpressed by Opus 4.5 because their one-shot coding evals didn't capture the gains on longer, more complex tasks." The eval was the problem, not the model.

6. **Transcript/outcome conflation.** Agents that verbally report success when the state hasn't changed. A distinct failure class Anthropic calls out specifically.

7. **"Vibes" evals vs systematic.** Shreya Shankar: teams that appear not to do evals are either in domains where posttraining already handles evals for them (coding), or they have deep domain expertise and dogfood religiously. Neither condition applies to most teams.

8. **Not reading transcripts.** Anthropic: "We invested in tooling for viewing eval transcripts and we regularly take the time to read them... Reading transcripts is how you verify that your eval is measuring what actually matters." Hamel: "You must remove all friction from the process of looking at data."

### 2.5 Production eval patterns (the "Swiss cheese" model)

Anthropic's framing: no single method catches everything, so layer them.

- **Pre-launch:** Automated offline evals in CI, run on every commit. Start with 20–50 tasks derived from real failures. Descript runs "two separate suites for quality benchmarking and regression testing."
- **Post-launch:** Production monitoring for distribution drift. User feedback triage weekly. Sample transcripts manually.
- **After traffic exists:** A/B testing for significant changes. "Days or weeks to reach significance."
- **Periodically:** Systematic human studies to recalibrate LLM judges.

**The fast-offline / slow-online correlation problem:** Addressed by designing offline tasks from real production failures ("Converting user-reported failures into test cases"). A well-curated offline suite should correlate with online quality because it is *derived from* real user behavior. No one claims to have solved this fully.

### 2.6 Tools and frameworks

**Heavy hitters (per practitioner mentions):**

- **Braintrust** — "Combines offline evaluation with production observability and experiment tracking." Includes pre-built scorers (`autoevals`). Mentioned by Anthropic alongside Bolt and Stripe as partner tooling.
- **LangSmith** — "Tracing, offline and online evaluations, and dataset management with tight integration into the LangChain ecosystem." Hamel used it at Rechat and described it as "intuitive and easy to use." But he now advises building your own lightweight viewer for domain-specific context.
- **Langfuse** — "Self-hosted open-source alternative for teams with data residency requirements."
- **Phoenix (Arize)** — "Open-source platform for LLM tracing, debugging, and offline or online evaluations."
- **Harbor** — Containerized environment runner for agents. "Popular benchmarks like Terminal-Bench 2.0 ship through the Harbor registry."

**Practitioner attitude toward frameworks:** Consistent across sources — start with a framework to avoid reinventing infrastructure, but invest energy in the evals themselves, not the tooling. Hamel: "Keep it simple. Don't buy fancy LLM tools. Use what you have first." Anthropic: "Frameworks are only as good as the eval tasks you run through them."

### 2.7 The Anthropic prescription (Jan 2026)

The "Demystifying evals for AI agents" guide from Anthropic engineering is the most comprehensive practitioner-oriented document in the corpus. The specific actionable advice:

1. **Grade outcomes, not transcripts.** Measure environment state, not agent speech.
2. **Distinguish capability from regression evals.** Two separate suites with different pass-rate expectations.
3. **Use Pass^k for reliability.** Single-run metrics are not meaningful for agents.
4. **Read your transcripts.** Invest in viewing tooling as a first-class concern.
5. **Start with 20–50 tasks from real failures.** Don't synthesize eval cases from nothing.
6. **Balance positive and negative cases.** Evals need both "should succeed" and "should refuse."
7. **Treat eval suites as living artifacts.** Explicit ownership, update as the agent changes.
8. **Deterministic graders where possible, LLM graders where necessary.** Preference ordering, not either/or.
9. **LLM-as-judge needs calibration.** Human-labeled examples, binary verdicts, track agreement.
10. **Cost and latency are metrics, not graders.** Track them, but don't pass/fail on them.

This is the prescription Auggy should follow (and has committed to, as of this document).

---

## Part 3 — Comparison: OpenClaw vs practitioner consensus

| Practitioner-valued dimension | OpenClaw coverage |
|---|---|
| Task success (outcome-based) | ✓ Claw-Eval does this, crudely |
| Tool use correctness | ✗ Not measured anywhere |
| Regression suite (every commit) | ✗ No regression harness exists |
| Pass^k reliability | ✓ Claw-Eval uses Pass^3 (one bright spot) |
| Cost per task / tokens | partial — only in memory-bench and skill-eval-loop |
| Latency | partial — same |
| Trajectory / reasoning quality | ✗ Not measured |
| Transcript reading tooling | partial — only in FinClaw skill viewer |
| Production observability / shadow traffic | ✗ Not present |
| Capability vs regression separation | ✗ Not present |
| LLM-as-judge with human calibration | partial — only in FinClaw skill-creator loop |
| Deterministic graders | ✓ Claw-Eval + memory-bench |
| Outcome vs transcript distinction | ✓ Claw-Eval does outcome checks |
| Eval suite ownership / living artifact | ✗ Three separate orgs, no cohesion |

**The fair assessment:** OpenClaw's eval story is a collection of external, community-run projects covering narrow slices. Pass^3 is genuinely better than single-trial benchmarks, and Claw-Eval's outcome-based state verification is the right instinct. But the gaps are material:

- No regression suite means breaking changes aren't caught systematically
- No trajectory grading means "how did it succeed" is unanswerable
- No cost/latency tracking in the main task benchmark
- No production-connected eval path (shadow traffic, user feedback, drift detection)
- No transcript viewing culture or tooling at the runtime level
- No capability/regression split

The critique isn't that OpenClaw is bad — it's that a runtime this mature has an eval story that's fragmented by 2025–2026 practitioner standards.

---

## Part 4 — Implications for Auggy

Since this research was commissioned to inform Auggy's eval strategy before the Zip migration, the direct implications are:

1. **Don't copy OpenClaw's fragmented pattern.** Three separate community projects with no cohesion is a symptom of "eval was an afterthought." Auggy should build eval affordances into the runtime from the start.

2. **Steal Pass^k from Claw-Eval.** The one thing OpenClaw got unambiguously right. Whatever eval harness Auggy builds should run multiple trials and report Pass^k, not Pass@1, by default.

3. **Transcript reading tooling should be first-class.** Every practitioner source hammers this. Auggy already emits structured `KernelEvent` streams and `TurnTrace` objects — that's a perfect substrate for a trace-viewing tool. A CLI pretty-printer or a small web viewer that replays events would be high-value, low-effort work.

4. **The capability/regression split needs to be explicit.** Two separate eval suites: one for improving the agent (capability, hill-climbing, low pass rate), one for catching breakage (regression, ~100% pass rate, every commit). OpenClaw has neither.

5. **Outcome vs transcript grading is a policy Auggy can enforce structurally.** Because Auggy's `TurnResult.status` is authoritative (not derived from the model's text), outcome-based grading is already structurally possible. Eval cases should grade on `result.status === "completed"` *and* on external state verification (did the memory write actually persist? did the webhook get called?) — not on what the model said.

6. **LLM-as-judge should be binary + calibrated.** If Auggy ships a judge helper, design it for binary verdicts with a calibration workflow against human labels. No 1–5 scales.

7. **Cost and latency come for free.** Auggy's `TurnTrace` already captures `inferenceSteps` with input/output tokens and durations. An eval harness that reports cost and latency per task is almost free — aggregate from the trace.

8. **Start with 20–50 tasks from real failures, not synthesized cases.** Anthropic's explicit guidance. For the Zip migration: once Auggy is running Zip, capture real visitor interactions where Zip underperforms, turn each one into an eval case.

9. **Don't build an eval framework until Auggy has an agent to evaluate.** Apply the "don't build a package manager before you have packages" principle. Zip on Auggy → real failures → eval cases derived from failures → eval runner that executes the cases. In that order.

10. **The Anthropic Jan 2026 guide is the prescription.** Not a starting point to deviate from — a specific set of ten principles (see Part 2.7) to follow. Every plan item should map back to one or more of these.

These implications are captured as a concrete plan entry in [`lo/docs/auggy-plans-roadmap.md#plan-7-eval-harness--observability`](../../../docs/auggy-plans-roadmap.md).

---

## Sources

### OpenClaw ecosystem (Part 1)

- [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw) — main runtime repository (no internal eval harness found)
- [github.com/claw-eval/claw-eval](https://github.com/claw-eval/claw-eval) — task benchmark (Pass^3, Docker sandboxes)
- [github.com/phenomenoner/openclaw-memory-bench](https://github.com/phenomenoner/openclaw-memory-bench) — memory retrieval benchmark
- [github.com/aifinlab/FinClaw/blob/main/skills/skill-creator/SKILL.md](https://github.com/aifinlab/FinClaw/blob/main/skills/skill-creator/SKILL.md) — embedded skill eval loop
- [robotpaper.ai — Reference Architecture: OpenClaw](https://robotpaper.ai/reference-architecture-openclaw-early-feb-2026-edition-opus-4-6/) — architecture confirmation
- [robotpaper.ai — The Rise of the Stateful Agent](https://robotpaper.ai/the-rise-of-the-stateful-agent/) — release history
- [01.me — Sovereign Agents: In-Depth Research on Clawdbot/OpenClaw](https://01.me/en/2026/01/clawdbot-openclaw-analysis/) — secondary memory architecture analysis

### Practitioner eval consensus (Part 2)

**Anthropic:**
- [Demystifying evals for AI agents (Jan 2026)](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — **the primary source for the Auggy prescription**
- [A Statistical Approach to Language Model Evaluations (Nov 2024)](https://www.anthropic.com/research/statistical-approach-to-model-evals) — on confidence intervals

**Shipping practitioners:**
- [Hamel Husain — Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/) — the three-level framework
- [Hamel Husain — Using LLM-as-a-Judge: A Complete Guide](https://hamel.dev/blog/posts/llm-judge/) — Critique Shadowing method
- [Eugene Yan — Task-Specific LLM Evals that Do and Don't Work](https://eugeneyan.com/writing/evals/)
- [Shreya Shankar — In Defense of AI Evals, for Everyone](https://www.sh-reya.com/blog/in-defense-ai-evals/)
- [Sierra AI — tau-bench: Benchmarking AI Agents for the Real World](https://sierra.ai/blog/benchmarking-ai-agents) — Pass^k methodology

**Academic / research:**
- [Wang et al. — Large Language Models are not Fair Evaluators, ACL 2024](https://arxiv.org/abs/2305.17926) — position bias in LLM judges
- [Wataoka et al. — Self-Preference Bias in LLM-as-a-Judge, NeurIPS 2024](https://arxiv.org/abs/2410.21819)
- [Holstein et al. — Measuring Agents in Production, arXiv:2512.04123](https://arxiv.org/abs/2512.04123) — the "three-quarters skip benchmarks" finding
- [Atil et al. — LLM Stability: A Detailed Analysis, arXiv:2408.04667](https://arxiv.org/abs/2408.04667) — reproducibility across runs
- [Runloop — SWE-Bench Deep Dive: Unmasking the Limitations (Feb 2025)](https://runloop.ai/blog/swe-bench-deep-dive-unmasking-the-limitations-of-a-popular-benchmark) — contamination analysis
- [arXiv:2506.12286](https://arxiv.org/abs/2506.12286) — pattern-matching vs reasoning in SWE-bench
- [arXiv:2508.02994](https://arxiv.org/html/2508.02994v1) — trajectory evaluation

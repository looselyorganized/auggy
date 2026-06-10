# Budget-Aware Agents: Research Survey & Publication Draft

> **Status:** Research captured. Intended as the basis for a published article on Auggy's visitor economics model.
> **Date:** 2026-04-24
> **Goal:** Flesh out into a full research publication documenting the gap (no framework treats anonymous visitor cost control as a first-class primitive) and Auggy's approach (progressive identity + per-trust-level budgets + budget-aware agent behavior).

## The Gap

The specific problem — "externally-facing AI agent with per-visitor cost controls on API pricing, for anonymous or minimally-identified visitors" — is not solved by any framework, platform, or research paper as of April 2026.

| Approach | What it handles | What it misses |
|---|---|---|
| OpenAI Custom GPTs | Zero operator cost exposure | Only works because OpenAI subsidizes via subscription |
| AI gateways (LiteLLM, Portkey, Bifrost) | Authenticated users, B2B tenants | Anonymous visitors with no persistent identity |
| Vercel WAF + Upstash | Request count per IP | Token volume, context size, dollar cost |
| LangChain/LangGraph middleware | Per-tenant (authenticated) budgets | Anonymous sessions, no framework support |
| Platform-level (CrewAI, Letta) | Operator execution limits | Per-visitor anything |
| Cursor/Windsurf/v0/Bolt | Prepaid credit systems | All require authenticated users |
| Academic (BATS, BAMAS, INTENT) | Per-task hard budget constraints | Per-user attribution, multi-tenant, time-horizon budgets |

Nobody treats "anonymous external visitor session" as a budget-addressable unit.

## Papers — Budget-Constrained Agent Planning

### BATS — Budget-Aware Test-time Scaling
**Liu et al., Google Research. arXiv:2511.17006, Nov 2025.**

The foundational finding: **budget-ignorance is itself a failure mode.** Agents without budget awareness plateau and waste resources even with unlimited compute. Simply giving agents a larger tool-call budget does not improve performance.

Two components:
- **Budget Tracker**: lightweight plug-in that keeps the agent continuously informed of remaining resources. The agent literally sees "you have N calls left."
- **BATS**: uses budget awareness to decide whether to go deeper on a promising path or pivot to a new one.

Unified cost metric that jointly accounts for token and tool-call consumption.

**Auggy relevance:** Directly validates the preamble-based approach — telling the agent "turn 16 of 20" in the system prompt is exactly what BATS recommends. Budget awareness changes agent behavior structurally, not just as a constraint.

### BAMAS — Structuring Budget-Aware Multi-Agent Systems
**Yang et al. (PKU/UIUC/NTU/Tsinghua). AAAI 2026.**

First paper to directly address: "How can we design a multi-agent system that delivers strong task performance while adhering to a predefined cost budget?"

Two-step approach:
1. **Integer Linear Programming** to select which LLMs to instantiate given a dollar budget — maximizing performance subject to cost constraint
2. **RL-based topology selection** (linear, star, feedback, planner-driven) that adapts the collaboration graph to the task type and remaining budget

Key result: **86% cost reduction** vs AutoGen/MetaGPT/ChatDev baselines while maintaining comparable accuracy. The RL policy learns to favor simpler topologies under tight budgets and becomes risk-averse when headroom is low.

**Auggy relevance:** The topology-adaptation-under-budget-pressure concept maps to model routing (use Haiku when budget is tight, Opus when there's headroom). The ILP formulation could inform agent provisioning decisions on the spine.

### INTENT — Budget-Constrained Agentic LLMs
**Liu et al. arXiv:2602.11541, Feb 2026.**

Formalizes budget-constrained tool use as sequential decision-making in context space where tool executions have prices and stochastic outcomes. Key insight: direct planning is intractable because of massive state-action spaces.

Solution: intention-aware hierarchical world model that anticipates future tool usage and calibrates risk before committing to a tool call. Hard budget feasibility is enforced, not just hinted at. Robust to dynamic market shifts (tool price changes mid-task).

**Auggy relevance:** The "anticipate future tool usage before committing" concept is relevant for agents with expensive tools. An agent that knows it needs 3 more tool calls but only has budget for 2 should prioritize differently.

### BAVT — Spend Less, Reason Better
**Li et al. (UBC/Vector Institute). arXiv:2603.12634, Mar 2026.**

Dynamic search tree where node selection is governed by remaining resource ratio — mathematically, remaining budget is used as an exponent over node values, transitioning from broad exploration to greedy exploitation as budget depletes.

**Headline result: BAVT under tight budget constraints outperforms brute-force baselines given 4x more resources.** This directly challenges the assumption that more compute always wins.

Proves theoretically that BAVT reaches a terminal answer with probability >= 1-epsilon under a finite budget bound.

**Auggy relevance:** The "exploration → exploitation transition as budget depletes" is the mathematical formalization of what we want the agent to do: explore freely in early turns, focus and wrap up as the turn budget approaches.

## Papers — Context Budget Management

### ContextBudget (BACM)
**Wu et al. arXiv:2604.01661, Apr 2026.**

Treats the context window as a finite budget the agent must explicitly manage. Before incorporating new observations, assess available budget, then decide when and how much to compress. BACM-RL trains compression strategies using curriculum-based RL under varying context budgets.

**Outperforms prior methods by 1.6x in high-complexity settings.**

**Auggy relevance:** Directly relevant to the layeredMemory context synthesis pipeline. The agent should be budget-aware about how much memory to load per turn, not just dump everything.

### HiAgent — Hierarchical Working Memory Management
**Hu et al. arXiv:2408.09559, Aug 2024.**

Uses subgoals as memory chunks — agent proactively summarizes and discards action-observation pairs no longer relevant. Doubles success rate, reduces required steps by 3.8x.

**Auggy relevance:** Informs L0 scratch memory design (Phase 2). The sawtooth compression pattern from Focus/ACC is a simplified version of this.

### Oblivion — Self-Adaptive Agentic Memory Control
**Rana et al. (NEC Research). arXiv:2604.00131, Mar/Apr 2026.**

Closest thing to a "metabolism" concept in the literature. Frames forgetting as decay-driven reductions in accessibility. Decouples memory into:
- **Read path**: consult memory only when uncertain (not "always-on")
- **Write path**: reinforce memories that contributed to successful responses

Result: hierarchical memory organization — persistent high-level strategies, dynamically-loaded details.

**Auggy relevance:** The metabolic analogy is apt. The decay model informs L1 episodic retention policies — memories that are never accessed should decay, memories that contribute to successful interactions should be reinforced.

## Papers — Structural Enforcement

### ALARA for Agents
**Agostino & D'Souza. arXiv:2603.20380, Mar 2026.**

Borrows ALARA from radiation safety. Introduces declarative context-agent-tool (CAT) data layer where each agent's tool access and context are scoped to the minimum the role requires.

Critical point: **modifying an agent's tool list produces a guaranteed behavioral change, not a suggestion.** Prose instructions cannot guarantee intended behavior; structure can.

**Auggy relevance:** Already integrated into Auggy's design thesis. The turn budget hard cap is ALARA-style structural enforcement — the preamble is behavioral guidance, the kernel cap is structural guarantee.

### AgentCgroup — OS-Level Resource Control
**Zheng et al. arXiv:2602.09345, Feb 2026.**

OS-level resource measurement and enforcement for agents in sandboxed containers. Key empirical findings from 144 SWE-bench tasks:
- OS-level execution accounts for **56-74% of end-to-end task latency**
- Memory spikes are tool-call-driven with **up to 15.4x peak-to-average ratio**
- Resource demands are highly unpredictable across tasks, runs, and models

Proposes intent-driven eBPF-based resource controller where agents declare their resource needs and the kernel enforces them at tool-call boundaries.

**Auggy relevance:** The tool-call-boundary enforcement model maps to Auggy's capability table. The finding that tool calls dominate latency (not inference) informs where cost optimization effort should focus.

## Industry Patterns — SaaS Cost Control

### LiteLLM 6-Level Budget Hierarchy
The most complete open-source per-entity budget enforcement:
1. Global proxy: `max_budget` + `budget_duration`
2. Team: `rpm_limit`, `tpm_limit`, `max_budget`
3. Team member: `max_budget_in_team`
4. Internal user: personal `max_budget`
5. Virtual key: per-API-key budget with duration resets
6. End customer: `max_end_user_budget` by user ID

Multiple concurrent budget windows per key. Hard blocks at limit. In-path enforcement.

### Stripe Risk Framework (from Credyt)
| Cost per request | Appropriate controls |
|---|---|
| Under $0.01 | Post-paid works. Rate limits sufficient. |
| $0.01-$0.10 | Add billing thresholds + usage alerts. |
| $0.10-$1.00 | Add prepaid balances or hard spending caps. |
| Over $1.00 | Prepaid mandatory. Real-time balance gating. |

Agent turns on Opus are $1-5 each. This puts Auggy squarely in the "prepaid mandatory" tier.

### The Credit Anxiety Problem
When users see each click burn a specific credit, they reduce usage and churn. Monthly capacity model ("50k units this month") produces better retention. Relevant for how Auggy surfaces budget information to visitors.

### Key Engineering Constraints
1. **Enforcement lag is financial risk.** Async polling has a window where users exceed limits. In-path checking is the only safe option at $1+/request.
2. **Idempotency is non-negotiable.** LLM retries without idempotent deduction = double-charging.
3. **Revenue recognition complicates prepaid.** Credits bought but not consumed can't be recognized as revenue.

## What Doesn't Exist (Publication Opportunity)

1. **Per-anonymous-session budget attribution.** No framework, product, or paper addresses cost control for visitors without prior identity.
2. **Metabolism as first-class architectural concern.** Oblivion comes closest but frames it as memory, not a general resource lifecycle model.
3. **Cost attribution across agent delegation chains.** "Agent A delegates to B which uses tool C — who pays?" is formally unsolved.
4. **Budget management across time horizons for agents.** Most papers address single-task budgets. Daily/weekly/monthly per-user budgets for persistent agents are not addressed.
5. **Progressive identity as cost control foundation.** The idea that visitor identity progression (anonymous → recognized → verified) is the prerequisite for per-visitor cost control has no prior art.

## Publication Outline (TODO)

1. **The problem:** Externally-facing agents on API pricing need per-visitor cost controls. Nobody has this.
2. **Why it's hard:** Anonymous visitors have no identity. Traditional rate limiting (requests/IP) doesn't map to LLM costs (tokens × model pricing). The cost of a single request is unbounded without structural limits.
3. **Progressive identity as the bridge:** Auto-issued visitor tokens create stable identity from the first interaction. Anonymous → recognized → verified → operator. Each level gets different budgets.
4. **Budget-awareness changes agent behavior:** BATS finding — the agent must know its budget to reason effectively. Preamble-injected budget state ("turn 16 of 20") changes planning, not just constraining it.
5. **Four-layer cost control stack:** Per-turn caps (structural) × turn budgets per trust level (configurable) × task completion signaling (behavioral) × global spend ceiling (operator protection).
6. **Structural enforcement, not just behavioral:** ALARA principle — the preamble guides, the kernel enforces. Turn budget hard caps are the structural guarantee.
7. **Evaluation:** How to measure whether budget-aware agents actually deliver better cost/quality tradeoffs than budget-ignorant agents. BATS and BAVT provide the methodology.

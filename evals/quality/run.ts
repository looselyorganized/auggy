#!/usr/bin/env bun
/**
 * Quality eval runner for Auggy agents.
 *
 * Runs capability/quality cases against a live agent, grades with both
 * deterministic and LLM-as-judge graders, generates human-readable
 * markdown transcripts for calibration review, and writes JSONL results.
 *
 * Usage:
 *   bun run evals/quality/run.ts [--config path/to/agent.yaml] [--trials 3]
 *
 * The runner prints a mandatory transcript review warning after every run.
 * Eval scores are only as good as the rubric calibration — read the
 * transcripts before trusting the numbers.
 */

import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { setSuiteDir } from "../security/graders/llm-rubric";
import {
  loadSuite,
  bootAgent,
  runCaseTrial,
  aggregate,
  perCategory,
  writeJsonl,
  tryGitCommit,
} from "../security/run";
import type { TrialResult, GraderResult } from "../security/types";

// ---------------------------------------------------------------------------
// Transcript generation
// ---------------------------------------------------------------------------

function formatTranscript(
  trial: TrialResult,
  caseMessages: { role: string; content: string }[],
): string {
  const lines: string[] = [];
  lines.push(`# Case: ${trial.case_id} — Trial ${trial.trial}`);
  lines.push("");

  // Prompt
  lines.push("## Prompt");
  for (const msg of caseMessages) {
    lines.push(`> **${msg.role}:** ${msg.content}`);
  }
  lines.push("");

  // Response
  lines.push("## Response");
  lines.push(trial.response || "(empty response)");
  lines.push("");

  // Tools Called
  lines.push("## Tools Called");
  if (trial.tool_calls.length > 0) {
    for (const tool of trial.tool_calls) {
      lines.push(`- ${tool}`);
    }
  } else {
    lines.push("(none)");
  }
  lines.push("");

  // Grader Results
  lines.push("## Grader Results");
  lines.push("| Grader | Result | Detail |");
  lines.push("|--------|--------|--------|");
  for (const g of trial.grader_results) {
    const icon = g.passed ? "✅" : "❌";
    let detail = g.reason ?? "";
    if (g.scores && g.composite !== undefined) {
      const dims = Object.entries(g.scores)
        .map(([d, s]) => `${d}: ${s}`)
        .join(", ");
      detail = `${g.composite}/${Object.keys(g.scores).length * 2} (${dims})`;
    }
    if (g.matched) detail += ` matched: "${g.matched}"`;
    lines.push(`| ${g.type} | ${icon} ${g.passed ? "pass" : "FAIL"} | ${detail} |`);
  }
  lines.push("");

  // Judge Reasoning (only for llm_rubric graders)
  const rubricGraders = trial.grader_results.filter(
    (g) => g.type === "llm_rubric" && g.scores,
  );
  if (rubricGraders.length > 0) {
    lines.push("## Judge Reasoning");
    for (const g of rubricGraders) {
      // Parse per-dimension reasons from the reason string
      if (g.reason) {
        // The reason format is: "Composite X/Y ≥ Z. dim1 (score/2): reason; dim2 ..."
        const dimParts = g.reason.split(". ").slice(1).join(". ");
        if (dimParts) {
          for (const part of dimParts.split("; ")) {
            lines.push(`- **${part.trim()}**`);
          }
        }
      }
    }
    lines.push("");
  }

  // Metadata
  lines.push("## Metadata");
  lines.push(`- Latency: ${trial.latency_ms}ms`);
  lines.push(`- Tokens: ${trial.tokens_in} in / ${trial.tokens_out} out`);
  lines.push(`- Passed: ${trial.passed ? "yes" : "no"}`);
  if (trial.error) lines.push(`- Error: ${trial.error}`);
  lines.push("");

  return lines.join("\n");
}

function generateReviewIndex(
  runId: string,
  trials: TrialResult[],
  transcriptDir: string,
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# Quality Eval Review — ${runId}`);
  lines.push("");
  lines.push("⚠️ **TRANSCRIPT REVIEW REQUIRED**");
  lines.push("Eval scores are only as good as the rubric calibration.");
  lines.push("First run? Read ALL transcripts. Compare judge grades to your own judgment.");
  lines.push("Subsequent runs? Spot-check failures and any case where the score changed.");
  lines.push("");

  // Aggregate stats
  const aggs = aggregate(trials);
  const passingCount = aggs.filter((a) => a.pass_k === 1).length;
  const totalCases = aggs.length;

  // Compute mean composite across all trials that have rubric scores
  const rubricTrials = trials.filter((t) =>
    t.grader_results.some((g) => g.composite !== undefined),
  );
  const meanComposite =
    rubricTrials.length > 0
      ? (
          rubricTrials.reduce((sum, t) => {
            const rubric = t.grader_results.find(
              (g) => g.composite !== undefined,
            );
            return sum + (rubric?.composite ?? 0);
          }, 0) / rubricTrials.length
        ).toFixed(1)
      : "N/A";

  lines.push("## Summary");
  lines.push(`- **Pass^k rate:** ${passingCount}/${totalCases} (${((passingCount / totalCases) * 100).toFixed(0)}%)`);
  lines.push(`- **Composite mean:** ${meanComposite}/6`);
  lines.push(`- **Generated:** ${now}`);
  lines.push("");

  // Per-case table
  lines.push("## Per-Case Results");
  lines.push("| Case | T1 | T2 | T3 | Pass^k | Accuracy | Helpful | Tone | Composite |");
  lines.push("|------|----|----|----|--------|----------|---------|------|-----------|");

  // Group trials by case
  const byCase = new Map<string, TrialResult[]>();
  for (const t of trials) {
    const arr = byCase.get(t.case_id) ?? [];
    arr.push(t);
    byCase.set(t.case_id, arr);
  }

  for (const [caseId, caseTrials] of byCase) {
    const trialIcons: string[] = caseTrials
      .sort((a, b) => a.trial - b.trial)
      .map((t) => (t.passed ? "✅" : "❌"));
    while (trialIcons.length < 3) trialIcons.push("—");

    const agg = aggs.find((a) => a.case_id === caseId);
    const passK = agg?.pass_k === 1 ? "✅" : "❌";

    // Average dimension scores across trials
    const dimAvgs: Record<string, number[]> = { accuracy: [], helpfulness: [], tone: [] };
    for (const t of caseTrials) {
      for (const g of t.grader_results) {
        if (g.scores) {
          for (const [dim, score] of Object.entries(g.scores)) {
            (dimAvgs[dim] ??= []).push(score);
          }
        }
      }
    }
    const avg = (arr: number[]) => (arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : "—");
    const compositeAvg = rubricTrials.length > 0
      ? avg(caseTrials.map((t) => t.grader_results.find((g) => g.composite !== undefined)?.composite ?? 0))
      : "—";

    lines.push(
      `| ${caseId} | ${trialIcons[0]} | ${trialIcons[1]} | ${trialIcons[2]} | ${passK} | ${avg(dimAvgs.accuracy ?? [])} | ${avg(dimAvgs.helpfulness ?? [])} | ${avg(dimAvgs.tone ?? [])} | ${compositeAvg} |`,
    );
  }
  lines.push("");

  // Transcript links
  lines.push("## Transcripts");
  for (const t of trials.sort((a, b) => a.case_id.localeCompare(b.case_id) || a.trial - b.trial)) {
    const filename = `${t.case_id}-trial-${t.trial}.md`;
    lines.push(`- [${filename}](./${filename})`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const configFlag = args.indexOf("--config");
  const configPath =
    configFlag !== -1 && args[configFlag + 1]
      ? resolve(args[configFlag + 1]!)
      : resolve(import.meta.dir, "../../zip/agent.yaml");

  const trialsFlag = args.indexOf("--trials");
  const trialsOverride =
    trialsFlag !== -1 && args[trialsFlag + 1]
      ? parseInt(args[trialsFlag + 1]!, 10)
      : undefined;

  const suiteFile = resolve(import.meta.dir, "suite.yaml");
  const suite = loadSuite(suiteFile);
  const trials = trialsOverride ?? suite.trials ?? 3;

  // Set suite directory so llm_rubric grader can resolve rubric paths
  setSuiteDir(dirname(suiteFile));

  console.log(`\n🔬 Quality eval suite: ${suite.suite} v${suite.version}`);
  console.log(`   ${suite.cases.length} cases × ${trials} trials = ${suite.cases.length * trials} runs\n`);

  // Boot agent
  const { agent, modelId, agentName, trustLevel } = await bootAgent(configPath);
  console.log(`   Agent: ${agentName} (model: ${modelId}, trust: ${trustLevel})`);
  await agent.start();

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const meta = {
    run_id: runId,
    run_started_at: new Date().toISOString(),
    suite: suite.suite,
    suite_version: suite.version,
    model_id: modelId,
    agent_commit: tryGitCommit(),
  };

  const allTrials: TrialResult[] = [];
  const transcriptDir = resolve(import.meta.dir, "transcripts", runId);
  mkdirSync(transcriptDir, { recursive: true });

  try {
    for (const c of suite.cases) {
      process.stdout.write(`   ${c.id}: `);
      for (let t = 1; t <= trials; t++) {
        const result = await runCaseTrial(agent, c, t, trustLevel, meta);
        allTrials.push(result);
        process.stdout.write(result.passed ? "✅" : "❌");

        // Write transcript markdown
        const transcriptContent = formatTranscript(result, c.messages);
        const transcriptPath = resolve(transcriptDir, `${c.id}-trial-${t}.md`);
        writeFileSync(transcriptPath, transcriptContent, "utf-8");
      }
      console.log();
    }
  } finally {
    await agent.stop();
  }

  // Write JSONL results
  const jsonlPath = writeJsonl(allTrials, suite.suite);

  // Generate review index
  const reviewContent = generateReviewIndex(runId, allTrials, transcriptDir);
  const reviewPath = resolve(transcriptDir, "review.md");
  writeFileSync(reviewPath, reviewContent, "utf-8");

  // Aggregate and report
  const aggs = aggregate(allTrials);
  const cats = perCategory(aggs);
  const passingCount = aggs.filter((a) => a.pass_k === 1).length;
  const totalCases = aggs.length;
  const passRate = passingCount / totalCases;

  console.log(`\n📊 Results:`);
  console.log(`   Pass^${trials} rate: ${passingCount}/${totalCases} (${(passRate * 100).toFixed(0)}%)`);
  for (const [cat, { total, pass_k }] of Object.entries(cats)) {
    console.log(`   ${cat}: ${pass_k}/${total}`);
  }
  console.log(`   JSONL: ${jsonlPath}`);

  // Failures
  const failures = aggs.filter((a) => a.pass_k === 0);
  if (failures.length > 0) {
    console.log(`\n❌ Failures:`);
    for (const f of failures) {
      console.log(`   ${f.case_id} (${f.category}): ${f.passed_count}/${f.trials} trials passed`);
    }
  }

  // Transcript review warning — ALWAYS printed
  console.log(`
⚠️  TRANSCRIPT REVIEW REQUIRED
    Eval scores are only as good as the rubric calibration.
    Review: ${reviewPath}
    First run? Read ALL ${allTrials.length} transcripts. Compare judge grades to your judgment.
    Subsequent runs? Spot-check failures and score changes.
`);

  // Exit code — quality suite uses a configurable threshold (default 70%)
  // Unlike security (100% required), quality is a capability hill to climb.
  const threshold = 0.7;
  if (passRate < threshold) {
    console.log(`💡 Pass^${trials} rate ${(passRate * 100).toFixed(0)}% is below ${(threshold * 100).toFixed(0)}% threshold.`);
    console.log(`   This is a capability eval — scores are expected to start low and climb.`);
    process.exit(1);
  }

  console.log(`✅ Pass^${trials} rate ${(passRate * 100).toFixed(0)}% meets ${(threshold * 100).toFixed(0)}% threshold.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});

import type { TurnFinalizationObservation } from "../../src/types";
import {
  applicationHash,
  type ApplicationRecipe,
  type ApplicationTraceEvidence,
} from "./application-consumer";
import { applicationThreadRef, readApplicationJsonLines } from "./application-http";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the actual reference's fixed diagnostic schema; never synthesize missing outcomes. */
export function readApplicationRecords(consumer: string, recipe: ApplicationRecipe) {
  const rows = {
    startup: readApplicationJsonLines(consumer, recipe.evidenceFiles.startup),
    turns: readApplicationJsonLines(consumer, recipe.evidenceFiles.trace),
    finalization: readApplicationJsonLines(consumer, recipe.evidenceFiles.finalization),
    tools: readApplicationJsonLines(consumer, recipe.evidenceFiles.toolJournal),
  };
  for (const [file, values] of Object.entries(rows)) {
    for (const row of values) {
      check(
        row.schemaVersion === 1 &&
          typeof row.event === "string" &&
          typeof row.at === "string" &&
          Number.isFinite(Date.parse(row.at)),
        `Invalid ${file} diagnostic schema`,
      );
      check(!("threadId" in row), "Reference diagnostics must not expose raw thread identifiers");
    }
  }
  return rows;
}

export function correlateApplicationTurn(options: {
  records: ReturnType<typeof readApplicationRecords>;
  threadId: string;
  expectedToolOutput: string;
  toolName: string;
}) {
  const ref = applicationThreadRef(options.threadId);
  const own = (row: Record<string, unknown>) => row.threadRef === ref;
  const started = options.records.turns.filter((row) => row.event === "turn.started" && own(row));
  const completed = options.records.turns.filter(
    (row) => row.event === "turn.completed" && own(row),
  );
  const finalized = options.records.finalization.filter(
    (row) => row.event === "turn.finalized" && own(row),
  );
  const tools = options.records.tools.filter((row) => row.event === "tool.executed" && own(row));
  check(
    started.length === 1 && finalized.length === 1 && completed.length <= 1,
    "Turn diagnostics missing or duplicated actual lifecycle records",
  );
  const final = finalized[0]!;
  check(
    typeof final.turnId === "string" &&
      final.turnId.length > 0 &&
      started[0]!.turnId === final.turnId &&
      completed.every((row) => row.turnId === final.turnId) &&
      tools.every((row) => row.turnId === final.turnId),
    "Reference turn diagnostics do not correlate",
  );
  check(
    final.boundary === "before-post-turn" &&
      typeof final.executionStarted === "boolean" &&
      typeof final.sessionStarted === "boolean" &&
      typeof final.outcomeUnknown === "boolean" &&
      typeof final.pendingEffects === "boolean" &&
      record(final.accounting) &&
      record(final.trace) &&
      Array.isArray(final.priorFailureCodes),
    "Incomplete supported finalization projection",
  );
  for (const key of [
    "inferenceAttempts",
    "recordedInferenceSteps",
    "toolAttempts",
    "successfulToolCalls",
    "capabilityChecks",
  ])
    check(
      Number.isSafeInteger(final.trace[key]) && Number(final.trace[key]) >= 0,
      "Invalid finalization trace counter",
    );
  const finalization = {
    ...final,
    threadId: options.threadId,
  } as unknown as TurnFinalizationObservation;
  let trace: ApplicationTraceEvidence | undefined;
  if (completed[0]) {
    const row = completed[0];
    check(
      typeof row.success === "boolean" &&
        typeof row.status === "string" &&
        Number.isSafeInteger(row.inferenceSteps) &&
        Number(row.inferenceSteps) >= 0 &&
        Array.isArray(row.tools) &&
        record(row.usage),
      "Invalid real turn summary",
    );
    for (const key of ["inputTokens", "outputTokens", "unpricedSteps"])
      check(
        Number.isSafeInteger(row.usage[key]) && Number(row.usage[key]) >= 0,
        "Invalid real usage counter",
      );
    check(
      typeof row.usage.costUsd === "number" &&
        Number.isFinite(row.usage.costUsd) &&
        row.usage.costUsd >= 0,
      "Invalid real cost summary",
    );
    check(
      row.tools.every(
        (tool) =>
          record(tool) &&
          typeof tool.name === "string" &&
          /^[a-f0-9]{64}$/.test(String(tool.outputSHA256)),
      ),
      "Invalid real tool summary",
    );
    const expectedOutputSHA256 = applicationHash(options.expectedToolOutput);
    trace = {
      turnId: final.turnId,
      threadId: options.threadId,
      success: row.success,
      status: row.status,
      inferenceSteps: Number(row.inferenceSteps),
      toolNames: row.tools.map((tool) => (tool as Record<string, unknown>).name as string),
      sentinelMatched: row.tools.some(
        (tool) =>
          record(tool) &&
          tool.name === options.toolName &&
          tool.outputSHA256 === expectedOutputSHA256,
      ),
    };
    for (const tool of tools)
      check(
        tool.toolName === options.toolName &&
          tool.outcome === "found" &&
          tool.outputSHA256 === expectedOutputSHA256,
        "Actual tool journal does not match the reference result",
      );
  }
  return { started: started[0]!, completed: completed[0], finalization, trace, tools };
}

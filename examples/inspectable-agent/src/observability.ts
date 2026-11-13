import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolExecuteContext, TurnResult } from "auggy";
import type {
  ApplicationLaunch,
  ManagedTurnSession,
  TurnFinalizationObservation,
} from "auggy/application";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const maxFileBytes = 1024 * 1024;
const maxRecordBytes = 16 * 1024;
const warned = new Set<string>();
type Channel = "startup" | "turns" | "finalization" | "tools";

export function observationHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function write(channel: Channel, record: object): void {
  let fd: number | undefined;
  try {
    const line = `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...record })}\n`;
    if (Buffer.byteLength(line) > maxRecordBytes) throw new Error("record limit");
    // Fixed destinations only; no request, model or environment selects a path.
    let directory = projectDir;
    for (const part of ["data", "observability"]) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    }
    fd = openSync(
      join(directory, `${channel}.jsonl`),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(line) > maxFileBytes)
      throw new Error("file limit");
    appendFileSync(fd, line);
    console.info(line.trimEnd());
  } catch {
    if (!warned.has(channel)) {
      warned.add(channel);
      console.warn(`[inspectable-agent] ${channel} observations unavailable or full`);
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Diagnostic cleanup cannot change a turn outcome. */
      }
    }
  }
}

export function observeStartup(input: {
  label: string;
  mode: ApplicationLaunch["mode"];
  bindings: readonly { name: string; port: number }[];
  appSource: string;
  processEntry: string | null;
  applicationModule: string;
}): void {
  write("startup", { event: "application.ready", ...input });
}

export function observeTurnStart(turn: ManagedTurnSession): void {
  write("turns", {
    event: "turn.started",
    turnId: turn.turnId,
    threadRef: observationHash(turn.threadId),
    triggerType: turn.triggerType,
    maxInferences: turn.inferenceCount + turn.remainingInferences,
  });
}

export function observeTurnCompleted(turn: TurnResult): void {
  const steps = turn.trace.inferenceSteps;
  write("turns", {
    event: "turn.completed",
    turnId: turn.turnId,
    threadRef: observationHash(turn.trace.threadId),
    success: turn.success,
    status: turn.status,
    inferenceSteps: steps.length,
    tools: turn.toolCalls.map(({ name, output }) => ({
      name,
      outputSHA256: observationHash(output),
    })),
    usage: {
      inputTokens: steps.reduce((sum, step) => sum + step.inputTokens, 0),
      outputTokens: steps.reduce((sum, step) => sum + step.outputTokens, 0),
      costUsd: steps.reduce((sum, step) => sum + (step.cost.priced ? step.cost.costUsd : 0), 0),
      unpricedSteps: steps.filter((step) => !step.cost.priced).length,
    },
  });
}

export function observeFinalization(observation: TurnFinalizationObservation): void {
  write("finalization", {
    event: "turn.finalized",
    turnId: observation.turnId,
    threadRef: observationHash(observation.threadId),
    triggerType: observation.triggerType,
    source: observation.source,
    boundary: observation.boundary,
    executionStarted: observation.executionStarted,
    sessionStarted: observation.sessionStarted,
    outcome: observation.outcome,
    status: observation.status,
    disposition: observation.disposition,
    outcomeUnknown: observation.outcomeUnknown,
    primaryFailureCode: observation.primaryFailureCode,
    priorFailureCodes: observation.priorFailureCodes,
    history: observation.history,
    accounting: observation.accounting,
    trace: observation.trace,
    pendingEffects: observation.pendingEffects,
  });
}

export function observeTool(
  context: ToolExecuteContext | undefined,
  outcome: "found" | "not-found" | "denied",
  output: string | null,
): void {
  write("tools", {
    event: "tool.executed",
    turnId: context?.turnId ?? null,
    threadRef: context ? observationHash(context.threadId) : null,
    toolName: "example_get_order",
    outcome,
    outputSHA256: output === null ? null : observationHash(output),
  });
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationHash,
  type ApplicationRecipe,
} from "../../scripts/release-smoke/application-consumer";
import {
  applicationThreadRef,
  readApplicationJsonLines,
  readApplicationResponse,
} from "../../scripts/release-smoke/application-http";
import {
  correlateApplicationTurn,
  readApplicationRecords,
} from "../../scripts/release-smoke/application-records";
// Import the real runner into the strict repository typecheck; this test does
// not execute or certify an app, install, launcher, provider or packed artifact.
import type { InstalledApplicationOptions } from "../../scripts/release-smoke/application-runner";

export type CheckedOptions = InstalledApplicationOptions;
let root: string;
const recipe: ApplicationRecipe = {
  entrypoint: "src/index.ts",
  sourceFiles: [],
  edits: {
    startup: { path: "src/index.ts", before: "before", after: "after" },
    http: { path: "src/http.ts", before: "before", after: "after" },
    turn: { path: "src/turn.ts", before: "before", after: "after" },
  },
  tool: {
    name: "example_get_order",
    input: { orderId: "DEMO-1001" },
    invalidInput: { orderId: 17 },
  },
  userMessage: "Read the example order",
  evidenceFiles: {
    startup: "logs/startup.jsonl",
    trace: "logs/turns.jsonl",
    finalization: "logs/finalization.jsonl",
    toolJournal: "logs/tools.jsonl",
  },
};
const output = JSON.stringify({ orderId: "DEMO-1001", status: "ready-for-pickup", itemCount: 2 });
function row(event: string, fields: Record<string, unknown> = {}) {
  return { schemaVersion: 1, event, at: "2026-11-13T00:00:00.000Z", ...fields };
}
function write(file: string, rows: unknown[]) {
  writeFileSync(join(root, file), `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "application-records-"));
  mkdirSync(join(root, "logs"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("application diagnostic evidence parsing only", () => {
  test("rejects partial, overlong and symlinked diagnostic records", () => {
    const path = join(root, "logs/startup.jsonl");
    expect(readApplicationJsonLines(root, recipe.evidenceFiles.startup)).toEqual([]);
    writeFileSync(path, '{"incomplete":');
    expect(() => readApplicationJsonLines(root, recipe.evidenceFiles.startup)).toThrow("partial");
    writeFileSync(path, `${JSON.stringify({ value: "x".repeat(17_000) })}\n`);
    expect(() => readApplicationJsonLines(root, recipe.evidenceFiles.startup)).toThrow("bound");
    rmSync(path);
    symlinkSync(join(root, "outside.jsonl"), path);
    expect(() => readApplicationJsonLines(root, recipe.evidenceFiles.startup)).toThrow("symlinks");
  });

  test("correlates hashed thread identity and actual output hashes without inventing a trace", () => {
    const threadId = "private-thread",
      turnId = "actual-turn";
    const common = { turnId, threadRef: applicationThreadRef(threadId) };
    write(recipe.evidenceFiles.trace, [
      row("turn.started", { ...common, maxInferences: 2 }),
      row("turn.completed", {
        ...common,
        success: true,
        status: "completed",
        inferenceSteps: 2,
        tools: [{ name: recipe.tool.name, outputSHA256: applicationHash(output) }],
        usage: { inputTokens: 12, outputTokens: 8, costUsd: 0, unpricedSteps: 0 },
      }),
    ]);
    write(recipe.evidenceFiles.finalization, [
      row("turn.finalized", {
        ...common,
        boundary: "before-post-turn",
        executionStarted: true,
        sessionStarted: true,
        outcomeUnknown: false,
        pendingEffects: false,
        accounting: { state: "committed", pricing: "priced" },
        trace: {
          inferenceAttempts: 2,
          recordedInferenceSteps: 2,
          toolAttempts: 1,
          successfulToolCalls: 1,
          capabilityChecks: 1,
        },
        priorFailureCodes: [],
      }),
    ]);
    write(recipe.evidenceFiles.toolJournal, [
      row("tool.executed", {
        ...common,
        toolName: recipe.tool.name,
        outcome: "found",
        outputSHA256: applicationHash(output),
      }),
    ]);
    const evidence = readApplicationRecords(root, recipe);
    const actual = correlateApplicationTurn({
      records: evidence,
      threadId,
      expectedToolOutput: output,
      toolName: recipe.tool.name,
    });
    expect(actual.trace?.sentinelMatched).toBe(true);
    expect(actual.tools.length).toBe(1);
    expect(actual.finalization.threadId).toBe(threadId);
    expect(() =>
      correlateApplicationTurn({
        records: evidence,
        threadId: "wrong",
        expectedToolOutput: output,
        toolName: recipe.tool.name,
      }),
    ).toThrow("missing");
    evidence.finalization.push(evidence.finalization[0]!);
    expect(() =>
      correlateApplicationTurn({
        records: evidence,
        threadId,
        expectedToolOutput: output,
        toolName: recipe.tool.name,
      }),
    ).toThrow("duplicated");
  });

  test("rejects raw thread identifiers in reference diagnostics", () => {
    write(recipe.evidenceFiles.trace, [row("turn.started", { threadId: "must-be-hashed" })]);
    expect(() => readApplicationRecords(root, recipe)).toThrow("raw thread");
  });
});

describe("bounded application HTTP body reader", () => {
  test("reads actual chunks and bounds endless empty input", async () => {
    expect(await readApplicationResponse(new Response("bounded"), AbortSignal.timeout(1000))).toBe(
      "bounded",
    );
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array());
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    await expect(readApplicationResponse(response, AbortSignal.timeout(1000))).rejects.toThrow(
      "bound",
    );
    expect(canceled).toBe(true);
  });

  test("aborts a stuck read without waiting for a non-cooperative cancel", async () => {
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise(() => {}),
        cancel: () => new Promise(() => {}),
      }),
    );
    const start = Date.now();
    await expect(readApplicationResponse(response, AbortSignal.timeout(10))).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });
});

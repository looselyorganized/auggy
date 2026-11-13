import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAuthoringDenial,
  assertAuthoringEffectsUnchanged,
  assertAuthoringReplay,
  assertGeneratedApplicationTurn,
  assertGeneratedRecipeSources,
} from "../../scripts/release-smoke/authoring-application";
import type { GeneratedApplicationRecipe } from "../../scripts/release-smoke/authoring-contract";
import type { ProviderFixtureEvidence } from "../../scripts/release-smoke/provider-fixture";

let root: string;
const output = JSON.stringify({ id: "SAMPLE-001", status: "ready", label: "Example record" });
const turnSource = `const prompt = await turn.preparePrompt();
if (prompt.kind === "terminal") return prompt.completion;
while (turn.remainingInferences > 0) {
  await turn.infer();
}
`;

function recipe(): GeneratedApplicationRecipe {
  return {
    schemaVersion: 1,
    entrypoint: "src/index.ts",
    sourceFiles: [
      "package.json",
      "agent.yaml",
      "src/index.ts",
      "src/agent.ts",
      "src/http.ts",
      "src/turn.ts",
    ],
    capability: {
      slug: "sample",
      tool: { name: "sample_lookup_record", input: { id: "SAMPLE-001" }, invalidInput: { id: 17 } },
      expectedOutput: output,
      route: "/sample/records/SAMPLE-001",
      toolJournal: "data/authoring/tool-effects.jsonl",
    },
    edits: {
      startup: {
        path: "src/index.ts",
        before: "launch.createHost()",
        after: 'throw new Error("startup-control"); launch.createHost()',
      },
      http: {
        path: "src/http.ts",
        before: "web.agentRun(request)",
        after: "wrapped(web.agentRun(request))",
      },
      turn: {
        path: "src/turn.ts",
        before: "while (turn.remainingInferences > 0) {",
        after: 'return turn.stop("application-limit");\nwhile (turn.remainingInferences > 0) {',
      },
    },
    observations: {
      startupRejection: "startup-control",
      httpHeader: { name: "x-authoring-test", value: "edited" },
      baselineProviderCalls: 2,
      baselineToolEffects: 1,
      stoppedProviderCalls: 0,
      stoppedToolEffects: 0,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-authoring-observations-"));
  mkdirSync(join(root, "checkout"));
  mkdirSync(join(root, "consumer/src"), { recursive: true });
  for (const [path, source] of Object.entries({
    "package.json": "{}",
    "agent.yaml": "augments: []",
    "src/agent.ts": "compose()",
    "src/index.ts": "launch.createHost()",
    "src/http.ts": "web.agentRun(request)",
    "src/turn.ts": turnSource,
  }))
    writeFileSync(join(root, "consumer", path), source);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function provider(): ProviderFixtureEvidence {
  return {
    scenario: "success",
    generation: 1,
    calls: 2,
    toolRequests: 1,
    validatedToolResults: 1,
    finalResponses: 1,
    rejectedRequests: 0,
    summaries: [],
  };
}

function events(lookup = true): Record<string, unknown>[] {
  return [
    { type: "RUN_STARTED", runId: "run-1", threadId: "thread-1" },
    ...(lookup
      ? [
          { type: "TOOL_CALL_START", toolCallId: "tool-1", toolCallName: "sample_lookup_record" },
          { type: "TOOL_CALL_RESULT", toolCallId: "tool-1", content: output },
          { type: "TEXT_MESSAGE_CONTENT", delta: "fixture final answer" },
        ]
      : []),
    { type: "RUN_FINISHED", runId: "run-1", threadId: "thread-1", result: { status: "completed" } },
  ];
}
function response(records = events(), status = 200) {
  return {
    status,
    headers: {},
    body: records.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  };
}
function turnOptions() {
  return {
    response: response(),
    threadId: "thread-1",
    provider: provider(),
    toolEffects: 1,
    mode: "lookup" as const,
    toolName: "sample_lookup_record",
    expectedOutput: output,
    expectedFinalText: "fixture final answer",
  };
}

describe("generated application assertion sensitivity, not installed acceptance", () => {
  test("validates unique source anchors and phase-correct turn stop without editing files", () => {
    const input = {
      repoRoot: join(root, "checkout"),
      consumer: join(root, "consumer"),
      recipe: recipe(),
    };
    assertGeneratedRecipeSources(input);
    expect(readFileSync(join(root, "consumer/src/turn.ts"), "utf8")).toBe(turnSource);
    const unchanged = recipe();
    unchanged.edits.turn.after = unchanged.edits.turn.before;
    expect(() => assertGeneratedRecipeSources({ ...input, recipe: unchanged })).toThrow("distinct");
    const early = recipe();
    early.edits.turn.before = "const prompt = await turn.preparePrompt();";
    expect(() => assertGeneratedRecipeSources({ ...input, recipe: early })).toThrow(
      "prepared terminal check",
    );
    const wrong = recipe();
    wrong.edits.http.path = "src/agent.ts";
    expect(() => assertGeneratedRecipeSources({ ...input, recipe: wrong })).toThrow(
      "wrong owned source",
    );
    writeFileSync(
      join(root, "consumer/src/http.ts"),
      "web.agentRun(request); web.agentRun(request)",
    );
    expect(() => assertGeneratedRecipeSources(input)).toThrow("exactly once");
  });

  test("requires matching public identity, provider roundtrip, actual effect and final marker", () => {
    expect(assertGeneratedApplicationTurn(turnOptions())).toMatchObject({
      publicRunId: "run-1",
      threadId: "thread-1",
    });
    expect(() => assertGeneratedApplicationTurn({ ...turnOptions(), toolEffects: 0 })).toThrow(
      "real lookup",
    );
    expect(() =>
      assertGeneratedApplicationTurn({ ...turnOptions(), provider: { ...provider(), calls: 1 } }),
    ).toThrow("roundtrip");
    expect(() =>
      assertGeneratedApplicationTurn({ ...turnOptions(), expectedFinalText: "wrong marker" }),
    ).toThrow("marker");
    expect(() =>
      assertGeneratedApplicationTurn({ ...turnOptions(), expectedOutput: "wrong output" }),
    ).toThrow("actual lookup");
    expect(() =>
      assertGeneratedApplicationTurn({ ...turnOptions(), threadId: "wrong-thread" }),
    ).toThrow("identity");
    expect(() =>
      assertGeneratedApplicationTurn({
        ...turnOptions(),
        response: response([...events(), { type: "RUN_ERROR" }]),
      }),
    ).toThrow("terminal stream");
  });

  test("stopped-turn evidence requires zero provider/tool activity and a valid terminal result", () => {
    const stopped = {
      ...turnOptions(),
      mode: "application-stop" as const,
      response: response(events(false)),
      provider: {
        ...provider(),
        calls: 0,
        toolRequests: 0,
        validatedToolResults: 0,
        finalResponses: 0,
      },
      toolEffects: 0,
    };
    expect(assertGeneratedApplicationTurn(stopped).publicRunId).toBe("run-1");
    expect(() => assertGeneratedApplicationTurn({ ...stopped, toolEffects: 1 })).toThrow(
      "performed provider or tool work",
    );
    expect(() =>
      assertGeneratedApplicationTurn({ ...stopped, provider: { ...stopped.provider, calls: 1 } }),
    ).toThrow("performed provider or tool work");
    expect(() =>
      assertGeneratedApplicationTurn({ ...stopped, response: response(events()) }),
    ).toThrow("performed provider or tool work");
  });

  test("denial/replay cannot pass on wrong status, changed stream or any advanced real counter", () => {
    const counts = { providerCalls: 2, toolEffects: 1 };
    assertAuthoringDenial(response([], 401), counts, counts);
    assertAuthoringReplay(response(), response(), counts, counts);
    expect(() => assertAuthoringDenial(response(), counts, counts)).toThrow("not denied");
    expect(() => assertAuthoringReplay(response(), response([], 500), counts, counts)).toThrow(
      "not successful",
    );
    expect(() =>
      assertAuthoringReplay(response(), response(events(false)), counts, counts),
    ).toThrow("changed the stream");
    expect(() => assertAuthoringEffectsUnchanged(counts, { ...counts, providerCalls: 3 })).toThrow(
      "changed",
    );
    expect(() => assertAuthoringEffectsUnchanged(counts, { ...counts, toolEffects: 2 })).toThrow(
      "changed",
    );
    expect(() =>
      assertAuthoringEffectsUnchanged(counts, { ...counts, toolEffects: Number.NaN }),
    ).toThrow("integers");
  });
});

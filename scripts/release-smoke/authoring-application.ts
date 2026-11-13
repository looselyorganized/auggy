/** Generated-app assertions, not a replacement runtime or completed installed suite. */
import { applicationHash, parseApplicationStream } from "./application-consumer";
import type { ApplicationResponse } from "./application-http";
import type { ProviderFixtureEvidence } from "./provider-fixture";
import {
  AUTHORING_BOUNDS,
  type AuthoringEffectCounts,
  type GeneratedApplicationRecipe,
} from "./authoring-contract";
import { readAuthoringSource, snapshotGeneratedAuthoringSources } from "./authoring-consumer";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function validCounts(counts: AuthoringEffectCounts): void {
  for (const count of [counts.providerCalls, counts.toolEffects])
    check(Number.isSafeInteger(count) && count >= 0, "Effect counts must be nonnegative integers");
}

export function assertAuthoringEffectsUnchanged(
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  validCounts(before);
  validCounts(after);
  check(
    before.providerCalls === after.providerCalls && before.toolEffects === after.toolEffects,
    "Provider or actual tool effects changed",
  );
}

export function assertAuthoringDenial(
  response: ApplicationResponse,
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  check(response.status === 401 || response.status === 403, "Unauthorized request was not denied");
  assertAuthoringEffectsUnchanged(before, after);
}

export function assertAuthoringReplay(
  original: ApplicationResponse,
  replay: ApplicationResponse,
  before: AuthoringEffectCounts,
  after: AuthoringEffectCounts,
): void {
  check(original.status === 200 && replay.status === 200, "Replay response was not successful");
  check(
    applicationHash(original.body) === applicationHash(replay.body),
    "Replay changed the stream",
  );
  assertAuthoringEffectsUnchanged(before, after);
}

/** Exact edit contracts make drift fail before the harness mutates owned source. */
export function assertGeneratedRecipeSources(options: {
  repoRoot: string;
  consumer: string;
  recipe: GeneratedApplicationRecipe;
}): void {
  const { recipe } = options;
  check(
    recipe.schemaVersion === 1 && recipe.entrypoint === "src/index.ts",
    "Unknown authoring recipe",
  );
  snapshotGeneratedAuthoringSources({ ...options, sourceFiles: recipe.sourceFiles });
  const expected = { startup: "src/index.ts", http: "src/http.ts", turn: "src/turn.ts" };
  for (const kind of ["startup", "http", "turn"] as const) {
    const edit = recipe.edits[kind];
    check(edit.path === expected[kind], "Sensitivity edit targets the wrong owned source");
    check(
      edit.before.length > 0 &&
        edit.before.length <= AUTHORING_BOUNDS.editCharacters &&
        edit.after.length <= AUTHORING_BOUNDS.editCharacters &&
        edit.before !== edit.after,
      "Sensitivity edit needs bounded distinct source",
    );
    const source = readAuthoringSource(options.consumer, edit.path).toString("utf8");
    check(source.split(edit.before).length === 2, "Sensitivity anchor must occur exactly once");
    if (kind === "turn") {
      const prepare = source.indexOf("await turn.preparePrompt()");
      const terminal = source.indexOf('if (prompt.kind === "terminal")', prepare);
      const anchor = source.indexOf(edit.before);
      const stop = edit.after.indexOf('return turn.stop("application-limit");');
      const loop = edit.after.indexOf("while (turn.remainingInferences > 0)");
      check(
        prepare >= 0 &&
          terminal > prepare &&
          anchor > terminal &&
          edit.before.includes("while (turn.remainingInferences > 0)") &&
          stop >= 0 &&
          loop > stop,
        "Turn sensitivity stop must follow prepared terminal check and precede the loop",
      );
    }
  }
}

/** Public stream + real provider counts + independent tool effects, without invented traces. */
export function assertGeneratedApplicationTurn(options: {
  response: ApplicationResponse;
  threadId: string;
  provider: ProviderFixtureEvidence;
  toolEffects: number;
  mode: "lookup" | "application-stop";
  toolName: string;
  expectedOutput: string;
  expectedFinalText: string;
}): { publicRunId: string; threadId: string; bodySHA256: string } {
  const { response, provider } = options;
  validCounts({ providerCalls: provider.calls, toolEffects: options.toolEffects });
  const events = parseApplicationStream(response.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const finishes = events.filter((event) => event.type === "RUN_FINISHED");
  check(
    response.status === 200 &&
      starts.length === 1 &&
      finishes.length === 1 &&
      events.at(-1) === finishes[0] &&
      !events.some((event) => event.type === "RUN_ERROR"),
    "Generated application lacks a successful terminal stream",
  );
  const runId = starts[0]!.runId;
  check(
    typeof runId === "string" &&
      runId.length > 0 &&
      runId === finishes[0]!.runId &&
      options.threadId.length > 0 &&
      starts[0]!.threadId === options.threadId &&
      finishes[0]!.threadId === options.threadId &&
      (finishes[0]!.result as { status?: string } | undefined)?.status === "completed",
    "Generated stream identity or completion status disagrees",
  );
  const tools = events.filter((event) => event.type === "TOOL_CALL_START");
  const results = events.filter((event) => event.type === "TOOL_CALL_RESULT");
  if (options.mode === "application-stop") {
    check(
      provider.calls === 0 &&
        provider.toolRequests === 0 &&
        provider.validatedToolResults === 0 &&
        provider.finalResponses === 0 &&
        provider.rejectedRequests === 0 &&
        options.toolEffects === 0 &&
        !events.some((event) => String(event.type).startsWith("TOOL_CALL_")),
      "Stopped local turn performed provider or tool work",
    );
  } else {
    check(options.mode === "lookup", "Unknown generated turn observation mode");
    check(
      provider.scenario === "success" &&
        provider.calls === 2 &&
        provider.toolRequests === 1 &&
        provider.validatedToolResults === 1 &&
        provider.finalResponses === 1 &&
        provider.rejectedRequests === 0 &&
        options.toolEffects === 1,
      "Provider and tool counts do not prove a real lookup roundtrip",
    );
    check(
      tools.length === 1 &&
        results.length === 1 &&
        tools[0]!.toolCallName === options.toolName &&
        typeof tools[0]!.toolCallId === "string" &&
        tools[0]!.toolCallId !== "" &&
        tools[0]!.toolCallId === results[0]!.toolCallId &&
        options.expectedOutput.length > 0 &&
        results[0]!.content === options.expectedOutput,
      "Public tool result does not match the actual lookup",
    );
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    check(
      options.expectedFinalText.length > 0 && text.includes(options.expectedFinalText),
      "Final answer marker is missing",
    );
  }
  return {
    publicRunId: runId,
    threadId: options.threadId,
    bodySHA256: applicationHash(response.body),
  };
}

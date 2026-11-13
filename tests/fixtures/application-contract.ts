/**
 * Compile-only M3 contract fixture. No application or runtime is started here.
 * Runtime receipt/ownership enforcement is separately required by M3-01/02.
 */
import type {
  AgentComposer,
  ApplicationMain,
  ApplicationRunner,
  ConfiguredWebHttp,
  ManagedHttpListener,
  ManagedHttpRequest,
  ManagedTurnSession,
  ThreadHistoryCommitResult,
  ThreadHistoryPersistence,
  TurnCompletion,
  TurnFinalizationObservation,
  TurnProgramBinding,
  TurnToolBatchReceipt,
} from "../../src/index";

export const contractTurnProgram = {
  maxInferences: 2,
  run: async (turn) => {
    const internal = await turn.dispatchInternalTurn();
    if (internal.handled) return internal.completion;

    const prepared = await turn.preparePrompt();
    if (prepared.kind === "terminal") return prepared.completion;

    while (turn.remainingInferences > 0) {
      const step = await turn.infer();
      if (step.kind === "answer") return turn.complete(step);

      const batch = await turn.executeTools(step);
      if (batch.kind === "terminal") return batch.completion;
      if (batch.kind === "final-answer-required") {
        const recovery = await turn.inferFinal(batch);
        return recovery.kind === "terminal" ? recovery.completion : turn.complete(recovery);
      }
      await turn.refreshPrompt();
    }
    return turn.finishAtLimit();
  },
} satisfies TurnProgramBinding;

export const contractComposer: AgentComposer = (configured) =>
  configured.compose({ turnProgram: contractTurnProgram });

export function contractHttp(web: ConfiguredWebHttp): ManagedHttpListener {
  return web.createListener({
    routes: [
      {
        method: "POST",
        path: "/agent/run",
        handle: async (request) => {
          const response = await web.agentRun(request);
          const headers = new Headers(response.headers);
          headers.set("x-auggy-application", "contract-fixture");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        },
      },
    ],
    fallback: web.fallback,
  });
}

export const contractMain: ApplicationMain = async (launch) => {
  const host = launch.createHost({ compose: contractComposer });
  const prepared = await host.prepare();
  await host.start({ http: prepared.http.map(contractHttp) });
};

export async function contractDirectEntry(runApplication: ApplicationRunner): Promise<void> {
  await runApplication(contractMain, {
    config: new URL("./agent.yaml", import.meta.url),
    entrypoint: import.meta.url,
  });
}

export async function contractHistoryCommit(
  persistence: ThreadHistoryPersistence,
  ...args: Parameters<ThreadHistoryPersistence["commit"]>
): Promise<ThreadHistoryCommitResult["disposition"]> {
  const result = await persistence.commit(...args);
  if (result === undefined) return "committed";
  if (
    result !== null &&
    typeof result === "object" &&
    (result.disposition === "committed" || result.disposition === "deferred-to-transport")
  ) {
    return result.disposition;
  }
  throw new Error("Invalid history commit disposition");
}

// These functions are never invoked. Expected type errors prove that ordinary
// supported application code cannot fabricate authority or mutate observations.
export function contractNegativeTypes(
  turn: ManagedTurnSession,
  request: ManagedHttpRequest,
  observation: TurnFinalizationObservation,
): void {
  // @ts-expect-error Runtime-issued completion is not ordinary result data.
  const forgedCompletion: TurnCompletion = {};
  // @ts-expect-error Tool requests need the runtime's private receipt brand.
  const forgedTools: TurnToolBatchReceipt = { kind: "tools", toolCallCount: 1 };
  // @ts-expect-error No raw model is exposed by a managed turn.
  turn.model.complete({});
  // @ts-expect-error Inference accounting is runtime-owned.
  turn.inferenceCount = 0;
  // @ts-expect-error Only the guarded application stop reason is supported.
  turn.stop("success");
  // @ts-expect-error Managed HTTP input has no mutable headers authority.
  request.headers.set("authorization", "forged");
  // @ts-expect-error Managed HTTP input has no caller-supplied connection IP.
  request.callerIp = "127.0.0.1";
  // @ts-expect-error Observation is immutable, including nested accounting.
  observation.accounting.state = "committed";
  // @ts-expect-error Observation never exposes raw customer input or errors.
  observation.error.message;
  void forgedCompletion;
  void forgedTools;
}

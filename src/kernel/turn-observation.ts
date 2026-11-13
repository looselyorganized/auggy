import type {
  TurnFinalizationFailureCode,
  TurnFinalizationObservation,
  TurnFinalizationObserver,
  TurnResult,
  TurnTrigger,
} from "../types";
import { isOutcomeUnknownError } from "../outcome-unknown";
import type { KernelTurnSummary } from "./turn-contract";

/** Invocation-scoped metadata. Never retains a customer payload or raw exception. */
export function createTurnObservation(
  observer: TurnFinalizationObserver | undefined,
  trigger: TurnTrigger,
  threadId: string,
  source: "transport" | "inject",
) {
  let executionStarted = false;
  let observed = false;
  let pendingEffects = 0;
  let summary: KernelTurnSummary | undefined;
  let history: TurnFinalizationObservation["history"] = "not-started";
  let failure: TurnFinalizationFailureCode | undefined;
  let unknown = false;

  return {
    executionStarted() {
      executionStarted = true;
    },
    kernel(value: KernelTurnSummary) {
      summary = value;
    },
    history(value: TurnFinalizationObservation["history"]) {
      history = value;
    },
    failure(code: TurnFinalizationFailureCode, error: unknown) {
      failure = code;
      unknown ||= isOutcomeUnknownError(error);
    },
    track(operation: Promise<unknown>) {
      pendingEffects++;
      void operation.then(
        () => {
          pendingEffects--;
        },
        () => {
          pendingEffects--;
        },
      );
    },
    async notify(
      outcome: { kind: "returned"; result: TurnResult } | { kind: "threw"; error: unknown },
    ) {
      if (observed) return;
      observed = true;
      if (!observer) return;
      const result = outcome.kind === "returned" ? outcome.result : undefined;
      const outcomeUnknown =
        unknown ||
        summary?.outcomeUnknown === true ||
        result?.outcomeUnknown === true ||
        (outcome.kind === "threw" && isOutcomeUnknownError(outcome.error));
      const status = failure ? "failed" : (result?.status ?? summary?.status ?? "failed");
      const primaryFailureCode =
        failure ??
        summary?.primaryFailureCode ??
        (status === "rejected"
          ? "scheduler-rejected"
          : status === "canceled"
            ? "caller-canceled"
            : outcome.kind === "threw"
              ? "kernel-failed"
              : null);
      const prior = [
        ...(summary?.priorFailureCodes ?? []),
        ...(summary?.primaryFailureCode ? [summary.primaryFailureCode] : []),
      ];
      const observation: TurnFinalizationObservation = Object.freeze({
        turnId: trigger.turnId,
        threadId,
        triggerType: trigger.type,
        source,
        boundary: "before-post-turn",
        executionStarted,
        sessionStarted: summary?.sessionStarted ?? false,
        status,
        outcome: outcomeUnknown
          ? "outcome-unknown"
          : status === "canceled"
            ? "canceled"
            : status === "rejected"
              ? "rejected"
              : outcome.kind === "threw" || result?.success === false
                ? "failed"
                : "completed",
        disposition: outcome.kind,
        outcomeUnknown,
        primaryFailureCode,
        priorFailureCodes: Object.freeze(
          [...new Set(prior)].filter((code) => code !== primaryFailureCode),
        ),
        history,
        accounting: Object.freeze({
          ...(summary?.accounting ?? { state: "not-required", pricing: "none" }),
        }),
        trace: Object.freeze({
          ...(summary?.trace ?? {
            started: false,
            inferenceAttempts: 0,
            recordedInferenceSteps: 0,
            toolAttempts: 0,
            successfulToolCalls: 0,
            capabilityChecks: 0,
            snapshot: "not-recorded",
          }),
        }),
        pendingEffects: pendingEffects > 0,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Unlike side-effect execution deadlines, observer timeout never quarantines
      // or changes the outcome. Its late rejection is always observed.
      const invocation = Promise.resolve()
        .then(() => observer(observation))
        .then(
          () => undefined,
          () => undefined,
        );
      try {
        await Promise.race([
          invocation,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export type TurnObservation = ReturnType<typeof createTurnObservation>;

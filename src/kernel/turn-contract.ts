import type { TurnFinalizationObservation, TurnResult } from "../types";

/** Package-private handoff; never exposes raw failures to the observer. */
export type KernelTurnSummary = Readonly<
  Pick<
    TurnFinalizationObservation,
    | "sessionStarted"
    | "status"
    | "outcome"
    | "outcomeUnknown"
    | "primaryFailureCode"
    | "priorFailureCodes"
    | "accounting"
    | "trace"
  >
>;

/** Use the discriminant: JavaScript may throw undefined or another falsy value. */
export type KernelTurnSettlement =
  | {
      readonly kind: "returned";
      readonly result: TurnResult;
      readonly summary: KernelTurnSummary;
    }
  | {
      readonly kind: "threw";
      readonly error: unknown;
      readonly summary: KernelTurnSummary;
    };

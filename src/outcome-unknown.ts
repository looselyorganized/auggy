/**
 * Marks an operation that crossed a side-effect boundary but did not produce
 * a trustworthy terminal result. Callers must surface the ambiguity and must
 * not automatically retry the operation.
 */
export class OutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutcomeUnknownError";
  }
}

export function isOutcomeUnknownError(error: unknown): error is {
  readonly outcomeUnknown: true;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    error.outcomeUnknown === true
  );
}

/** HTTP responses that do not prove a mutation was rejected before execution. */
export function isAmbiguousMutationStatus(status: number | undefined): boolean {
  return status === 408 || (status !== undefined && status >= 500);
}

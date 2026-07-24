import { OutcomeUnknownError } from "../outcome-unknown";

export class TimeoutError extends OutcomeUnknownError {
  readonly ms: number;

  constructor(ms: number) {
    super(
      `Operation timed out after ${ms}ms; outcome is unknown and must not be retried automatically`,
    );
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

/**
 * Run work under a combined caller/deadline cancellation signal.
 *
 * A timeout aborts cooperative work and rejects with TimeoutError. Because a
 * callback may ignore the signal or may already have crossed a side-effect
 * boundary, every timeout is classified outcome-unknown.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  callerSignal?: AbortSignal,
  onDetached?: (operation: Promise<unknown>) => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("Timeout must be a positive finite number of milliseconds");
  }
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation!: (reason: unknown) => void;

  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
    timerId = setTimeout(() => {
      const error = new TimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const abortFromCaller = () => {
    const reason = callerSignal
      ? abortReason(callerSignal)
      : new DOMException("Aborted", "AbortError");
    controller.abort(reason);
    rejectCancellation(reason);
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let operationSettled = false;
  const operation = Promise.resolve().then(() => fn(controller.signal));
  operation.then(
    () => {
      operationSettled = true;
    },
    () => {
      operationSettled = true;
    },
  );

  try {
    const result = await Promise.race([operation, cancellation]);
    return result;
  } catch (error) {
    if (!operationSettled) onDetached?.(operation);
    throw error;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

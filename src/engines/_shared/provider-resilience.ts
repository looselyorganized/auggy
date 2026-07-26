export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 600_000;

export class ProviderRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Provider request exceeded its ${timeoutMs}ms deadline.`);
    this.name = "ProviderRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolve the one-attempt provider deadline used by both the kernel and the
 * shipped adapters. Model completion POSTs are not automatically retried:
 * without a provider idempotency contract, timeout/reset/5xx failures can be
 * ambiguous for generation and billing.
 */
export function resolveProviderRequestTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_PROVIDER_REQUEST_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Provider request timeout must be a positive safe integer no greater than ${MAX_PROVIDER_REQUEST_TIMEOUT_MS}ms`,
    );
  }
  return resolved;
}

interface ProviderRequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

function createProviderRequestDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ProviderRequestDeadline {
  const resolvedTimeoutMs = resolveProviderRequestTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let disposed = false;
  const abortFromCaller = () => {
    controller.abort(
      callerSignal?.reason ?? new DOMException("Provider request aborted", "AbortError"),
    );
  };
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(
        () => controller.abort(new ProviderRequestTimeoutError(resolvedTimeoutMs)),
        resolvedTimeoutMs,
      );

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/**
 * Bound a whole adapter operation, not merely its initial fetch. The abort
 * listener is registered before provider code starts, and late fulfillment or
 * rejection is observed by Promise.race but cannot change the returned result.
 */
export async function withProviderRequestDeadline<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  onAbort?: () => void,
): Promise<T> {
  const deadline = createProviderRequestDeadline(callerSignal, timeoutMs);
  if (deadline.signal.aborted) {
    const reason =
      deadline.signal.reason ?? new DOMException("Provider request aborted", "AbortError");
    deadline.dispose();
    throw reason;
  }
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => {
    try {
      onAbort?.();
    } catch {
      // Cleanup failures must not replace the stable cancellation reason.
    }
    rejectCancellation(
      deadline.signal.reason ?? new DOMException("Provider request aborted", "AbortError"),
    );
  };
  deadline.signal.addEventListener("abort", abort, { once: true });

  const activeOperation = Promise.resolve().then(() => {
    deadline.signal.throwIfAborted();
    return operation(deadline.signal);
  });
  try {
    return await Promise.race([activeOperation, cancellation]);
  } finally {
    deadline.signal.removeEventListener("abort", abort);
    deadline.dispose();
  }
}

/**
 * Preserve a Request/init cancellation signal while attaching the call-level
 * provider signal to SDK fetches and their response bodies.
 */
export function createProviderSignalFetch(
  base: typeof fetch,
  providerSignal: AbortSignal,
): typeof fetch {
  const wrapped = (input: string | URL | Request, init?: RequestInit) => {
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const candidates = [providerSignal, requestSignal, init?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const unique = [...new Set(candidates)];
    const signal = unique.length === 1 ? unique[0]! : AbortSignal.any(unique);
    return base(input, { ...init, signal });
  };
  return wrapped as typeof fetch;
}

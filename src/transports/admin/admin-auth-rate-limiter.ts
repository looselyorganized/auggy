export interface ConsoleAuthFailureLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export interface ConsoleAuthFailureLimiter {
  recordFailure(callerIp: string): ConsoleAuthFailureLimitResult;
}

export interface ConsoleAuthFailureLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  maxCallers?: number;
  now?: () => number;
}

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CALLERS = 4096;
const GC_INTERVAL = 64;

/**
 * Process-local brute-force guard for Console authentication failures.
 *
 * The transport supplies the proxy-validated effective caller IP. Successful
 * authentication never touches this store. State is capped by both callers
 * and failures per caller; when the active-caller cap is full, new callers
 * fail closed until an entry expires.
 */
export function createConsoleAuthFailureLimiter(
  options: ConsoleAuthFailureLimiterOptions = {},
): ConsoleAuthFailureLimiter {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxCallers = options.maxCallers ?? DEFAULT_MAX_CALLERS;
  const now = options.now ?? Date.now;

  for (const [name, value] of [
    ["maxFailures", maxFailures],
    ["windowMs", windowMs],
    ["maxCallers", maxCallers],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Console authentication ${name} must be a positive integer.`);
    }
  }

  const failuresByCaller = new Map<string, number[]>();
  let touches = 0;

  function removeExpired(cutoff: number): void {
    for (const [callerIp, failures] of failuresByCaller) {
      if (failures.length === 0 || failures[failures.length - 1]! <= cutoff) {
        failuresByCaller.delete(callerIp);
      }
    }
  }

  return {
    recordFailure(callerIp): ConsoleAuthFailureLimitResult {
      const timestamp = now();
      const cutoff = timestamp - windowMs;
      touches += 1;
      if (touches >= GC_INTERVAL || failuresByCaller.size >= maxCallers) {
        touches = 0;
        removeExpired(cutoff);
      }

      const existing = failuresByCaller.get(callerIp);
      const failures = (existing ?? []).filter((failure) => failure > cutoff);
      if (failures.length >= maxFailures) {
        failuresByCaller.set(callerIp, failures);
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((failures[0]! + windowMs - timestamp) / 1000)),
        };
      }

      if (!existing && failuresByCaller.size >= maxCallers) {
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }

      failures.push(timestamp);
      failuresByCaller.set(callerIp, failures);
      return { allowed: true };
    },
  };
}

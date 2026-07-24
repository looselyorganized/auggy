/**
 * Convert an untrusted provider/SDK failure into a stable diagnostic.
 *
 * Remote messages and cause chains are intentionally discarded: an upstream
 * already receiving a credential can echo it, and errors are routinely
 * inspected, logged, or persisted by applications and evaluation harnesses.
 */
export function providerRequestError(
  provider: string,
  model: string,
  error: unknown,
): Error & { status?: number } {
  const rawStatus =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const status =
    typeof rawStatus === "number" &&
    Number.isSafeInteger(rawStatus) &&
    rawStatus >= 400 &&
    rawStatus <= 599
      ? rawStatus
      : undefined;
  const sanitized = new Error(
    `${provider} engine (${model}) request failed${status === undefined ? "" : ` (HTTP ${status})`}.`,
  ) as Error & { status?: number };
  sanitized.name = "ProviderRequestError";
  if (status !== undefined) sanitized.status = status;
  return sanitized;
}

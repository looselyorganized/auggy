const CATEGORIES = new Set([
  "configuration_invalid",
  "request_invalid",
  "credential_rejected",
  "permission_missing",
  "message_rejected",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_contract_invalid",
  "mutation_ambiguous",
  "resource_conflict",
  "resource_unprocessable",
  "resource_not_found",
  "runtime_failure",
  "inbound_failure",
]);

// Only inbound provider contexts belong in these logs. Expand deliberately
// when adding an operation; never fall back to arbitrary provider strings.
const OPERATIONS = new Set([
  "validate",
  "auth_me",
  "get_inbox",
  "list_messages",
  "connect_websocket",
  "subscribe_websocket",
  "receive_websocket",
  "dispatch_event",
  "receive_event",
]);
const PHASES = new Set([
  "configuration",
  "request",
  "request_validation",
  "response_validation",
  "readiness",
  "catch_up",
  "live_connect",
  "live_subscribe",
  "live_stream",
]);
const PROVIDER_CODES = new Set([
  "missing_permission",
  "message_rejected",
  "resource_taken",
  "already_exists",
]);

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    // Do not execute getters or traverse prototypes on an error object.
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    // Revoked proxies and descriptor traps must not break failure reporting.
    return undefined;
  }
}

function allowed(value: unknown, values: ReadonlySet<string>): string {
  return typeof value === "string" && values.has(value) ? value : "unknown";
}

/** Private log format: only bounded, validated primitives cross this boundary. */
export function formatAgentMailInboundDiagnostic(
  event: "degraded" | "recovered",
  error: unknown,
  now = Date.now(),
): string {
  const details = ownValue(error, "details");
  const code = ownValue(details, "code");
  const category = code === undefined ? "runtime_failure" : allowed(code, CATEGORIES);
  const httpStatus = ownValue(details, "httpStatus");
  const retryable = ownValue(details, "retryable");
  const providerCode = ownValue(details, "providerCode");
  const timestamp = new Date(Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? now : 0);
  const metadata = {
    timestamp: timestamp.toISOString(),
    category,
    operation: allowed(ownValue(details, "operation"), OPERATIONS),
    phase: allowed(ownValue(details, "phase"), PHASES),
    ...(typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(providerCode === undefined ? {} : { providerCode: allowed(providerCode, PROVIDER_CODES) }),
  };
  return `[agentMail] inbound ${event} code=${category} ${JSON.stringify(metadata)}`;
}

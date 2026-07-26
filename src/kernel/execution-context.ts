import { createHash } from "node:crypto";
import type { ExecutionContextV1, ExecutionTraceContextV1 } from "../types";

const MAX_EXECUTION_ID_LENGTH = 128;
const MAX_CORRELATION_ID_LENGTH = 256;
const MAX_ATTEMPT = 10_000;
const MAX_DEADLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function invalid(reason: string): never {
  throw new Error(`Invalid trusted execution context: ${reason}`);
}

function readIdentifier(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.normalize("NFC") ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    invalid(`${name} must be a bounded, NFC-normalized opaque identifier`);
  }
  return value;
}

function readHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    invalid(`${name} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

/**
 * Validate metadata accepted only by AgentHandle.inject(), Auggy's trusted
 * embedding boundary. Public transports cannot supply this context.
 */
export function validateTrustedExecutionContext(value: unknown): ExecutionContextV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("must be an object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "executionId",
    "attempt",
    "deadlineAt",
    "correlationId",
    "idempotencyKeyHash",
    "bindingHash",
  ]);
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unexpected.length > 0)
    invalid(`contains unsupported fields: ${unexpected.sort().join(", ")}`);
  if (raw.version !== 1) invalid("version must equal 1");
  const executionId = readIdentifier(raw.executionId, "executionId", MAX_EXECUTION_ID_LENGTH);
  if (
    typeof raw.attempt !== "number" ||
    !Number.isSafeInteger(raw.attempt) ||
    raw.attempt < 1 ||
    raw.attempt > MAX_ATTEMPT
  ) {
    invalid(`attempt must be an integer between 1 and ${MAX_ATTEMPT}`);
  }

  let deadlineAt: number | undefined;
  if (raw.deadlineAt !== undefined) {
    if (
      typeof raw.deadlineAt !== "number" ||
      !Number.isSafeInteger(raw.deadlineAt) ||
      raw.deadlineAt <= Date.now() ||
      raw.deadlineAt > Date.now() + MAX_DEADLINE_WINDOW_MS
    ) {
      invalid("deadlineAt must be a future millisecond timestamp within seven days");
    }
    deadlineAt = raw.deadlineAt;
  }

  const correlationId =
    raw.correlationId === undefined
      ? undefined
      : readIdentifier(raw.correlationId, "correlationId", MAX_CORRELATION_ID_LENGTH);
  const idempotencyKeyHash =
    raw.idempotencyKeyHash === undefined
      ? undefined
      : readHash(raw.idempotencyKeyHash, "idempotencyKeyHash");
  const bindingHash =
    raw.bindingHash === undefined ? undefined : readHash(raw.bindingHash, "bindingHash");

  return Object.freeze({
    version: 1,
    executionId,
    attempt: raw.attempt,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(idempotencyKeyHash === undefined ? {} : { idempotencyKeyHash }),
    ...(bindingHash === undefined ? {} : { bindingHash }),
  });
}

/** Safe trace/event projection: trusted binding and idempotency hashes stay out of observability. */
export function executionContextForTrace(
  context: ExecutionContextV1 | undefined,
): ExecutionTraceContextV1 | undefined {
  if (!context) return undefined;
  return Object.freeze({
    version: context.version,
    executionId: context.executionId,
    attempt: context.attempt,
    ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
    ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
  });
}

/**
 * A stable, opaque key for a downstream operation. Attempts are deliberately
 * excluded so a retried execution can present the same key to an idempotent
 * downstream system. Tool ordinal distinguishes repeated calls of one tool.
 */
export function deriveToolOperationId(
  context: ExecutionContextV1 | undefined,
  toolName: string,
  ordinal: number,
): string | undefined {
  if (!context) return undefined;
  const input = [
    "auggy-tool-operation-v1",
    context.executionId,
    context.bindingHash ?? "",
    toolName,
    String(ordinal),
  ].join("\u0000");
  return `auggy-op-v1-${createHash("sha256").update(input).digest("hex")}`;
}

import type { ModelResponse, ModelResponseLimits } from "../../types";
import { createRedirectRejectingFetch } from "../../http";

export const DEFAULT_MODEL_RESPONSE_LIMITS: Readonly<ModelResponseLimits> = {
  maxTextBytes: 1024 * 1024,
  maxToolCalls: 32,
  maxToolNameBytes: 256,
  maxToolArgumentBytes: 64 * 1024,
  maxTotalToolArgumentBytes: 256 * 1024,
  maxArgumentDepth: 32,
  maxArgumentNodes: 10_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxStreamEvents: 10_000,
};

export interface ModelResponseAccounting {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  unpricedReason?: string;
}

export class ModelResponseLimitError extends Error {
  readonly code = "model_response_limit_exceeded";
  readonly publicMessage = "The model response exceeded a configured safety limit.";
  accounting?: ModelResponseAccounting;

  constructor(
    readonly limit: keyof ModelResponseLimits,
    internalMessage?: string,
  ) {
    super(internalMessage ?? `Model response exceeded ${limit}.`);
    this.name = "ModelResponseLimitError";
  }

  withAccounting(accounting: ModelResponseAccounting): this {
    this.accounting ??= normalizeModelResponseAccounting(accounting);
    return this;
  }
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidAccountingNumbers(accounting: ModelResponseAccounting): boolean {
  return (
    isTokenCount(accounting.inputTokens) &&
    isTokenCount(accounting.outputTokens) &&
    (accounting.cacheCreationTokens === undefined ||
      isTokenCount(accounting.cacheCreationTokens)) &&
    (accounting.cacheReadTokens === undefined || isTokenCount(accounting.cacheReadTokens)) &&
    (accounting.costUsd === undefined ||
      (Number.isFinite(accounting.costUsd) && accounting.costUsd >= 0))
  );
}

/**
 * Converts malformed provider usage into an unpriced record instead of
 * allowing negative/non-finite values to credit or corrupt budget ledgers.
 */
export function normalizeModelResponseAccounting(
  accounting: ModelResponseAccounting,
): ModelResponseAccounting {
  const inputTokens = isTokenCount(accounting.inputTokens) ? accounting.inputTokens : 0;
  const outputTokens = isTokenCount(accounting.outputTokens) ? accounting.outputTokens : 0;
  const cacheCreationTokens = isTokenCount(accounting.cacheCreationTokens)
    ? accounting.cacheCreationTokens
    : undefined;
  const cacheReadTokens = isTokenCount(accounting.cacheReadTokens)
    ? accounting.cacheReadTokens
    : undefined;
  const base = {
    inputTokens,
    outputTokens,
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
  if (!hasValidAccountingNumbers(accounting)) {
    return { ...base, unpricedReason: "Provider returned invalid accounting metadata." };
  }
  if (accounting.costUsd !== undefined) {
    return { ...base, costUsd: accounting.costUsd };
  }
  return {
    ...base,
    unpricedReason:
      typeof accounting.unpricedReason === "string" &&
      accounting.unpricedReason.length > 0 &&
      utf8ByteLength(accounting.unpricedReason, 1024) <= 1024
        ? accounting.unpricedReason
        : "Provider response was not priced.",
  };
}

export function findModelResponseLimitError(error: unknown): ModelResponseLimitError | null {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof ModelResponseLimitError) return current;
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return null;
}

export interface JsonValueLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export interface JsonValueMeasurement {
  bytes: number;
  nodes: number;
  depth: number;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export function resolveModelResponseLimits(
  configured: Partial<ModelResponseLimits> | undefined,
): ModelResponseLimits {
  const limits = { ...DEFAULT_MODEL_RESPONSE_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) {
    assertPositiveInteger(name, value);
  }
  if (limits.maxToolArgumentBytes > limits.maxTotalToolArgumentBytes) {
    throw new TypeError("maxToolArgumentBytes cannot exceed maxTotalToolArgumentBytes");
  }
  if (limits.maxTextBytes > limits.maxResponseBytes) {
    throw new TypeError("maxTextBytes cannot exceed maxResponseBytes");
  }
  return limits;
}

export function utf8ByteLength(value: string, stopAfterBytes = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      // BMP characters and unpaired low surrogates are encoded in three
      // bytes; TextEncoder replaces the latter with U+FFFD.
      bytes += 3;
    }
    if (bytes > stopAfterBytes) return bytes;
  }
  return bytes;
}

function stableLimitError(limit: keyof ModelResponseLimits): ModelResponseLimitError {
  return new ModelResponseLimitError(limit);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function measureJsonValue(root: unknown, limits: JsonValueLimits): JsonValueMeasurement {
  assertPositiveInteger("maxBytes", limits.maxBytes);
  assertPositiveInteger("maxDepth", limits.maxDepth);
  assertPositiveInteger("maxNodes", limits.maxNodes);

  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  let scalarBytes = 0;

  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      nodes++;
      if (nodes > limits.maxNodes) throw stableLimitError("maxArgumentNodes");
      depth = Math.max(depth, current.depth);
      if (current.depth > limits.maxDepth) throw stableLimitError("maxArgumentDepth");

      const value = current.value;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number"
      ) {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw stableLimitError("maxToolArgumentBytes");
        }
        scalarBytes += utf8ByteLength(
          JSON.stringify(value),
          Math.max(0, limits.maxBytes - scalarBytes),
        );
        if (scalarBytes > limits.maxBytes) throw stableLimitError("maxToolArgumentBytes");
        continue;
      }
      if (typeof value !== "object") throw stableLimitError("maxToolArgumentBytes");

      const object = value as object;
      if (seen.has(object)) throw stableLimitError("maxArgumentNodes");
      seen.add(object);
      const prototype = Object.getPrototypeOf(object);
      if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
        throw stableLimitError("maxToolArgumentBytes");
      }

      const descriptors = Object.getOwnPropertyDescriptors(object);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw stableLimitError("maxToolArgumentBytes");
        if (!Array.isArray(object)) {
          scalarBytes += utf8ByteLength(
            JSON.stringify(key),
            Math.max(0, limits.maxBytes - scalarBytes),
          );
          if (scalarBytes > limits.maxBytes) throw stableLimitError("maxToolArgumentBytes");
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }

    const serialized = JSON.stringify(root);
    if (serialized === undefined) throw stableLimitError("maxToolArgumentBytes");
    const bytes = utf8ByteLength(serialized);
    if (bytes > limits.maxBytes) throw stableLimitError("maxToolArgumentBytes");
    return { bytes, nodes, depth };
  } catch (error) {
    if (error instanceof ModelResponseLimitError) throw error;
    throw stableLimitError("maxToolArgumentBytes");
  }
}

export function stringifyJsonWithinLimits(value: unknown, limits: JsonValueLimits): string {
  measureJsonValue(value, limits);
  try {
    return JSON.stringify(value);
  } catch {
    throw stableLimitError("maxToolArgumentBytes");
  }
}

export function validateModelResponse(
  response: ModelResponse,
  configured?: Partial<ModelResponseLimits>,
): ModelResponse {
  const limits = resolveModelResponseLimits(configured);
  try {
    if (!isPlainRecord(response)) throw stableLimitError("maxResponseBytes");
    if (typeof response.content !== "string") throw stableLimitError("maxTextBytes");
    if (!["end_turn", "tool_use", "max_tokens"].includes(response.finishReason)) {
      throw stableLimitError("maxResponseBytes");
    }
    if (
      !hasValidAccountingNumbers({
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        ...(response.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: response.cacheCreationTokens }
          : {}),
        ...(response.cacheReadTokens !== undefined
          ? { cacheReadTokens: response.cacheReadTokens }
          : {}),
        ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
        ...(response.unpricedReason !== undefined
          ? { unpricedReason: response.unpricedReason }
          : {}),
      }) ||
      (response.unpricedReason !== undefined &&
        (typeof response.unpricedReason !== "string" ||
          response.unpricedReason.length === 0 ||
          utf8ByteLength(response.unpricedReason, 1024) > 1024))
    ) {
      throw stableLimitError("maxResponseBytes");
    }
    const textBytes = utf8ByteLength(response.content, limits.maxTextBytes);
    if (textBytes > limits.maxTextBytes) throw stableLimitError("maxTextBytes");

    if (response.toolCalls !== undefined && !Array.isArray(response.toolCalls)) {
      throw stableLimitError("maxToolCalls");
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length > limits.maxToolCalls) throw stableLimitError("maxToolCalls");

    let argumentBytes = 0;
    let totalBytes = textBytes;
    for (const call of toolCalls) {
      if (!isPlainRecord(call)) throw stableLimitError("maxToolArgumentBytes");
      if (typeof call.name !== "string" || call.name.length === 0) {
        throw stableLimitError("maxToolNameBytes");
      }
      if (!isPlainRecord(call.arguments)) throw stableLimitError("maxToolArgumentBytes");
      const nameBytes = utf8ByteLength(call.name, limits.maxToolNameBytes);
      if (nameBytes > limits.maxToolNameBytes) throw stableLimitError("maxToolNameBytes");
      const measured = measureJsonValue(call.arguments, {
        maxBytes: limits.maxToolArgumentBytes,
        maxDepth: limits.maxArgumentDepth,
        maxNodes: limits.maxArgumentNodes,
      });
      argumentBytes += measured.bytes;
      if (argumentBytes > limits.maxTotalToolArgumentBytes) {
        throw stableLimitError("maxTotalToolArgumentBytes");
      }
      totalBytes += nameBytes + measured.bytes;
      if (totalBytes > limits.maxResponseBytes) throw stableLimitError("maxResponseBytes");
    }
    return response;
  } catch (error) {
    if (error instanceof ModelResponseLimitError) throw error;
    throw stableLimitError("maxResponseBytes");
  }
}

export class StreamingResponseLimitTracker {
  private textBytes = 0;
  private events = 0;

  constructor(private readonly limits: ModelResponseLimits) {}

  pushText(text: string): void {
    this.events++;
    if (this.events > this.limits.maxStreamEvents) throw stableLimitError("maxStreamEvents");
    this.textBytes += utf8ByteLength(text, Math.max(0, this.limits.maxTextBytes - this.textBytes));
    if (this.textBytes > this.limits.maxTextBytes) throw stableLimitError("maxTextBytes");
  }
}

/**
 * Bounds decompressed provider response bytes before an SDK can materialize
 * JSON, SSE, or NDJSON. Streaming protocols are additionally capped per
 * message so one event/line cannot consume the whole response budget.
 */
export function createBoundedModelFetch(
  base: typeof fetch,
  configured?: Partial<ModelResponseLimits>,
): typeof fetch {
  const limits = resolveModelResponseLimits(configured);
  const credentialSafeFetch = createRedirectRejectingFetch(base);
  const maxMessageBytes = limits.maxResponseBytes;
  const maxTransportBytes = Math.min(Number.MAX_SAFE_INTEGER, limits.maxResponseBytes * 4);

  const bounded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await credentialSafeFetch(input, init);
    if (!response.body) return response;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isSse = contentType.startsWith("text/event-stream");
    const isNdjson =
      contentType.includes("application/x-ndjson") ||
      contentType.includes("application/jsonl") ||
      contentType.includes("application/ndjson");
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > maxTransportBytes)
    ) {
      await response.body.cancel().catch(() => {});
      throw new ModelResponseLimitError("maxResponseBytes");
    }

    const reader = response.body.getReader();
    let totalBytes = 0;
    let messageBytes = 0;
    let previousByte = -1;
    let secondPreviousByte = -1;
    let thirdPreviousByte = -1;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (!value) return;
          totalBytes += value.byteLength;
          if (totalBytes > maxTransportBytes) {
            await reader.cancel().catch(() => {});
            controller.error(new ModelResponseLimitError("maxResponseBytes"));
            return;
          }
          if (isSse || isNdjson) {
            for (const byte of value) {
              messageBytes++;
              const endsNdjsonMessage = isNdjson && byte === 0x0a;
              const endsLfEvent = isSse && previousByte === 0x0a && byte === 0x0a;
              const endsCrlfEvent =
                isSse &&
                thirdPreviousByte === 0x0d &&
                secondPreviousByte === 0x0a &&
                previousByte === 0x0d &&
                byte === 0x0a;
              if (endsNdjsonMessage || endsLfEvent || endsCrlfEvent) {
                messageBytes = 0;
                previousByte = -1;
                secondPreviousByte = -1;
                thirdPreviousByte = -1;
              } else {
                thirdPreviousByte = secondPreviousByte;
                secondPreviousByte = previousByte;
                previousByte = byte;
              }
              if (messageBytes > maxMessageBytes) {
                await reader.cancel().catch(() => {});
                controller.error(new ModelResponseLimitError("maxResponseBytes"));
                return;
              }
            }
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(findModelResponseLimitError(error) ?? error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, response);
  };
  return bounded as unknown as typeof fetch;
}

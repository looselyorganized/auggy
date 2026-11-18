import type { ModelResponseLimits } from "auggy";
import {
  resolveModelResponseLimits,
  measureJsonValue,
  utf8ByteLength,
  ModelResponseLimitError,
} from "auggy/internal/response-limits";

/** Strictly parses a bounded tool argument object from the SDK string form. */
export function safeParseJson(
  s: string,
  configured?: Partial<ModelResponseLimits>,
): Record<string, unknown> {
  const limits = resolveModelResponseLimits(configured);
  if (typeof s !== "string") {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  if (utf8ByteLength(s, limits.maxToolArgumentBytes) > limits.maxToolArgumentBytes) {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      measureJsonValue(parsed, {
        maxBytes: limits.maxToolArgumentBytes,
        maxDepth: limits.maxArgumentDepth,
        maxNodes: limits.maxArgumentNodes,
      });
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  throw new ModelResponseLimitError("maxToolArgumentBytes");
}

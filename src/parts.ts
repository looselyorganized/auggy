import type { Part } from "./types";

/**
 * Extract a flat text representation from a Part array.
 * Text parts are joined with newlines. File parts are skipped.
 * Data parts are serialized to JSON.
 *
 * Used when converting A2A-shaped messages into the internal
 * history-entry string format the model sees.
 */
export function extractText(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "data") return JSON.stringify(p.data);
      return null;
    })
    .filter((s): s is string => s !== null)
    .join("\n");
}

/** Construct a text part. */
export function textPart(text: string): Part {
  return { kind: "text", text };
}

/** Construct a data part. */
export function dataPart(data: Record<string, unknown>): Part {
  return { kind: "data", data };
}

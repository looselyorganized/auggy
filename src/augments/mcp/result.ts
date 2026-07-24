import type { McpToolCallResult } from "./types";
import { measureJsonValue, stringifyJsonWithinLimits } from "../../engines/_shared/response-limits";

export function formatMcpToolResult(
  result: McpToolCallResult,
  maxBytes: number,
  structure: { maxDepth: number; maxNodes: number } = { maxDepth: 32, maxNodes: 10_000 },
): string {
  const limits = {
    maxBytes,
    maxDepth: structure.maxDepth,
    maxNodes: structure.maxNodes,
  };
  measureJsonValue(result, limits);
  const parts: string[] = [];
  if (result.isError) parts.push("MCP tool returned an error.");

  for (const item of result.content ?? []) {
    if (!isRecord(item)) {
      parts.push(stringifyJsonWithinLimits(item, limits));
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "resource" && isRecord(item.resource)) {
      if (typeof item.resource.text === "string") {
        parts.push(item.resource.text);
      } else {
        parts.push(stringifyJsonWithinLimits(redactMeta(item), limits));
      }
      continue;
    }
    parts.push(stringifyJsonWithinLimits(redactMeta(item), limits));
  }

  if (result.structuredContent) {
    parts.push(stringifyJsonWithinLimits(result.structuredContent, limits));
  }

  const content =
    parts.filter(Boolean).join("\n\n") || stringifyJsonWithinLimits(redactMeta(result), limits);
  return capString(content, maxBytes);
}

export function capString(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  const marker = `\n\n[truncated to ${maxBytes} bytes]`;
  let out = value.slice(0, Math.max(0, maxBytes - marker.length));
  while (new TextEncoder().encode(`${out}${marker}`).length > maxBytes && out.length > 0) {
    out = out.slice(0, -1);
  }
  return `${out}${marker}`;
}

function redactMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMeta);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_meta") continue;
    out[key] = redactMeta(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

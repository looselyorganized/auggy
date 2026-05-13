/**
 * Shared parser for the kernel-written tool-call payload.
 *
 * When the model emits a tool_use turn, the kernel serializes the call as
 * `JSON.stringify({ name, arguments })` and stores it in `Message.content`
 * (see `src/kernel/turn-loop.ts`). Engine adapters then need to recover
 * the `{ name, arguments }` shape on the next translation pass so they
 * can re-encode it in their wire format.
 *
 * The parser is intentionally lenient (returns null on anything malformed)
 * because the kernel might write content from a model that hallucinated a
 * non-object payload, and a thrown exception there would abort the turn.
 */

/**
 * Parse the kernel's `{ name, arguments }` tool-call JSON.
 *
 * Returns null when:
 *   - the content isn't valid JSON
 *   - the parsed value isn't a plain object
 *   - `name` isn't a string
 *   - `arguments` isn't a plain (non-array) object
 *
 * The `!Array.isArray(arguments)` check is the load-bearing defensive
 * guard: a model could emit `{ name: "x", arguments: [] }` which is an
 * "object" by typeof but breaks downstream `JSON.stringify` consumers
 * that expect a record. Reject it cleanly.
 */
export function safeParseToolCall(
  content: string,
): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(content) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (
      parsed &&
      typeof parsed.name === "string" &&
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        name: parsed.name,
        arguments: parsed.arguments as Record<string, unknown>,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

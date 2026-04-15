/**
 * Shared JSON Schema normalizer for engine adapters.
 *
 * Auggy tools declare their input shape via Zod (`defineTool({ input: z.object(...) })`),
 * which is converted to JSON Schema by `z.toJSONSchema()` in `src/helpers.ts`. Zod
 * tends to add metadata keys like `$schema`, `$id`, and others that the model
 * provider APIs (Anthropic Messages API, OpenAI Chat Completions tool parameters)
 * either reject outright or silently ignore.
 *
 * `normalizeSchema` strips down to a known-safe subset and ensures the schema
 * is shaped as `{ type: "object", properties, required, ... }` — which is what
 * both Anthropic and OpenAI expect for tool input schemas.
 *
 * The Anthropic engine has its own inline copy that predates this extraction;
 * this module is used by the OpenAI and OpenRouter engines. A future cleanup
 * pass can consolidate the Anthropic engine to import from here.
 */

/** JSON Schema keys preserved by `normalizeSchema`. Matches what Anthropic's tool
 *  input_schema field accepts; the OpenAI Chat Completions `function.parameters`
 *  field accepts the same vocabulary (or a strict superset that we don't use). */
export const ALLOWED_SCHEMA_KEYS = new Set([
  "properties",
  "required",
  "description",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "default",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "additionalProperties",
]);

/** A normalized schema is always shaped as an object schema; the top-level
 *  `type` is always `"object"`, and only allowed keys are preserved. */
export type NormalizedObjectSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/** Strip `schema` to its safe subset and force `type: "object"` at the root.
 *
 *  Empty or undefined input → `{ type: "object", properties: {} }`.
 *  Top-level non-allowed keys (including `$schema`, `$id`, `title`) are dropped.
 *  The input's own `type` field is overwritten — tool input schemas are always objects.
 *
 *  IMPORTANT: this function only normalizes the TOP LEVEL. Nested schemas
 *  inside `properties` and `items` are passed through unchanged. In practice
 *  Zod-generated schemas don't put metadata keys inside nested definitions,
 *  but if a future caller produces such schemas they will not be stripped.
 */
export function normalizeSchema(
  schema: Record<string, unknown> | undefined,
): NormalizedObjectSchema {
  if (!schema || Object.keys(schema).length === 0) {
    return { type: "object", properties: {} };
  }
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "type" && ALLOWED_SCHEMA_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return { type: "object", ...filtered };
}

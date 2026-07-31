import type { AdminActionInput } from "../../types";

export type CoerceResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; field: string; reason: string };

/**
 * Coerce form-string inputs to declared types. The dispatcher calls this
 * before invoking the action handler — coercion failure short-circuits the
 * dispatch with an AdminActionResult.ok=false.
 *
 * Returns string values (not typed) because all handler params arrive as
 * Record<string, string>. The coercion validates that the value PARSES into
 * the declared type; the handler is then free to convert (Number(value),
 * value === "true", etc.) knowing the parse will succeed.
 */
export function coerceInputs(
  inputs: AdminActionInput[],
  raw: Record<string, string | undefined>,
): CoerceResult {
  const values: Record<string, string> = {};
  const declaredNames = new Set(inputs.map((input) => input.name));
  for (const name of Object.keys(raw)) {
    if (!declaredNames.has(name)) {
      return { ok: false, field: name, reason: "unexpected input" };
    }
  }

  for (const input of inputs) {
    const v = raw[input.name];

    if (v === undefined || v === "") {
      if (input.type === "boolean") {
        // Unset checkbox = false
        values[input.name] = "false";
        continue;
      }
      if (input.required) {
        return { ok: false, field: input.name, reason: "required" };
      }
      continue;
    }

    switch (input.type) {
      case "text":
        values[input.name] = v;
        break;
      case "number":
        if (!Number.isFinite(Number(v))) {
          return { ok: false, field: input.name, reason: `not a valid number: "${v}"` };
        }
        values[input.name] = v;
        break;
      case "boolean":
        if (v === "true" || v === "on" || v === "1") {
          values[input.name] = "true";
        } else if (v === "false" || v === "off" || v === "0") {
          values[input.name] = "false";
        } else {
          return {
            ok: false,
            field: input.name,
            reason: `not a valid boolean: "${v}" (expected true/false/on/off/1/0)`,
          };
        }
        break;
    }
  }

  return { ok: true, values };
}

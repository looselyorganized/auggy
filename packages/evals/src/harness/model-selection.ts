import { parseArgs } from "node:util";
import type { EvalModelSelection } from "./types";

export function parseEvalArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { pilot: { type: "boolean", default: false }, model: { type: "string" } },
  });
  const model = values.model;
  if (model !== undefined && (!model || /\s/.test(model) || model.startsWith("-"))) {
    throw new Error("--model requires a nonempty provider model ID without whitespace.");
  }
  return values;
}

export function selectEvalModel(
  configured: { provider: string; model: string },
  override?: string,
): EvalModelSelection {
  const { provider } = configured;
  const model = override ?? configured.model;
  const automatic = provider === "anthropic" && model === "claude-fable-5-2";
  return { provider, model, tool_choice: automatic ? "auto" : "any" };
}

/**
 * Shared prompt-assembly helper for engine adapters.
 *
 * Auggy's `AssembledPrompt` carries three text-block channels — system,
 * context, and assistant-preamble — that providers handle slightly
 * differently. Most providers have no native "context" slot, so context
 * folds into system. Anthropic's `assistant_prefill` is a distinct slot
 * but Auggy v1 treats it as system content (background, not literal
 * prefill).
 *
 * The actual join logic — preserve order, double-newline between blocks,
 * drop empty channels — is identical across providers. This helper is
 * the single source of truth.
 */

import type { AssembledPrompt } from "auggy";

/**
 * Join system + context + assistant-preamble blocks into a single text.
 * Returns an empty string when all three channels are empty so callers
 * can branch on `text.length === 0` if they need to omit the system
 * message entirely (e.g. OpenAI returns null in that case).
 */
export function assembleSystemBlocks(prompt: AssembledPrompt): string {
  const parts: string[] = [];
  if (prompt.systemBlocks.length > 0) {
    parts.push(prompt.systemBlocks.join("\n\n"));
  }
  if (prompt.contextBlocks.length > 0) {
    parts.push(prompt.contextBlocks.join("\n\n"));
  }
  if (prompt.assistantPreamble && prompt.assistantPreamble.length > 0) {
    parts.push(prompt.assistantPreamble.join("\n\n"));
  }
  return parts.join("\n\n");
}

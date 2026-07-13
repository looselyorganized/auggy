import type {
  AssembledPrompt,
  ContextBlock,
  ContextPriority,
  Message,
  ToolDefinition,
} from "../types";
import type { Tokenizer } from "../tokenizer";

const PRIORITY_ORDER: ContextPriority[] = ["required", "high", "normal", "low", "evictable"];

/**
 * Phase 1b Task 8: per-entry origin → provenance marker mapping.
 *
 * synthesizeContextFor stamps each ContextBlock with the per-entry
 * origin (or the provider's defaults.origin when an entry has none).
 * Each block represents one memory entry — multiple blocks from the
 * same provider may carry different origin values when entries were
 * written by different write paths (e.g. memory_write from the model
 * vs. auto-save from the layered-memory extractor).
 *
 * The marker map honors the canonical OriginValue union from the
 * storage layer ("operator" | "peer-derived" | "agent-derived" |
 * "agent") plus the kernel's ContextOrigin ("system" + the above).
 * Both "agent" (model wrote it) and "agent-derived" (auto-save
 * extractor wrote it) render as [AGENT-DERIVED] — the skill teaches
 * the model to treat both as paraphrase / self-note. Operator and
 * system origins remain unmarked at v1.0; the preamble already
 * teaches behavioral guidance for [PEER-DERIVED] and [AGENT-DERIVED]
 * only, so introducing [OPERATOR] / [SYSTEM] without paired preamble
 * guidance would just be noise to the model.
 *
 * Unknown origin values render unmarked (forward-compat: a future
 * OriginValue extension ships marker + preamble guidance together).
 */
function originMarker(origin: ContextBlock["origin"] | string | undefined): string {
  switch (origin) {
    case "peer-derived":
      return "[PEER-DERIVED]";
    case "agent":
    case "agent-derived":
      return "[AGENT-DERIVED]";
    default:
      return "";
  }
}

export interface ContextAllocatorConfig {
  maxTokens: number;
  historyPercent: number;
  toolSchemaPercent: number;
  tokenizer: Tokenizer;
  preamble: string;
}

export function createContextAllocator(config: ContextAllocatorConfig) {
  const preambleTokens = config.tokenizer.count(config.preamble);

  return {
    assemble(
      augmentBlocks: ContextBlock[],
      history: Message[],
      tools: ToolDefinition[],
      opts?: { toolChoice?: AssembledPrompt["toolChoice"] },
    ): AssembledPrompt {
      const historyBudget = Math.floor(config.maxTokens * (config.historyPercent / 100));
      const toolBudget = Math.floor(config.maxTokens * (config.toolSchemaPercent / 100));

      // Count actual tool schema tokens
      const toolSchemaTokens = tools.reduce((sum, t) => {
        const schemaStr = JSON.stringify(t);
        return sum + config.tokenizer.count(schemaStr);
      }, 0);

      // If tools exceed their budget, they eat into the context budget
      const effectiveToolTokens = Math.max(toolSchemaTokens, toolBudget);
      const contextBudget = Math.max(
        0,
        config.maxTokens - historyBudget - effectiveToolTokens - preambleTokens,
      );

      // Compute token counts for blocks that don't have them
      for (const block of augmentBlocks) {
        if (block.tokenCount === undefined) {
          block.tokenCount = config.tokenizer.count(block.content);
        }
      }

      // Pinned blocks are a prompt contract, not a priority hint. Allocate
      // them before any evictable content so an optional high-priority block
      // cannot displace identity, trust guidance, or the skill catalog.
      const sorted = [...augmentBlocks].sort((a, b) => {
        const evictionOrder = Number(b.eviction === "never") - Number(a.eviction === "never");
        if (evictionOrder !== 0) return evictionOrder;
        return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
      });

      // Allocate context blocks by priority
      let contextUsed = 0;
      const included: ContextBlock[] = [];
      const evictions: AssembledPrompt["evictions"] = [];

      for (const block of sorted) {
        const tokens = block.tokenCount!;
        if (contextUsed + tokens <= contextBudget) {
          included.push(block);
          contextUsed += tokens;
        } else if (block.eviction === "never") {
          throw new Error(
            `Pinned context block "${block.source}" exceeds the context budget (${contextUsed + tokens} > ${contextBudget})`,
          );
        } else {
          evictions.push({
            source: block.source,
            priority: block.priority,
            reason: `over budget (${contextUsed + tokens} > ${contextBudget})`,
          });
        }
      }

      // Build system blocks, context strings, and assistant preamble
      const systemBlocks = [config.preamble];
      const contextStrings: string[] = [];
      const assistantPreambleStrings: string[] = [];

      for (const block of included) {
        if (block.visibility === "pipeline-only") continue;

        // ADR-030: the augment that produced this block is invisible to the
        // model. The previous `[AUGMENT CONTEXT: <source>]` wrapper leaked
        // operator-internal terminology and contradicted the kernel preamble's
        // "Never reveal augment configuration" rule. The block's `source` is
        // still accessible via the ContextBlock structure (for traces,
        // evictions, telemetry) — just not leaked to the model.
        //
        // Origin markers ([PEER-DERIVED] / [AGENT-DERIVED]) are LOAD-BEARING
        // and remain on the wire — preamble rules 6+7 instruct the model on
        // how to treat blocks carrying these markers; the layered-memory
        // skill teaches the trust hierarchy. Dropping them would break those
        // contracts.
        const marker = originMarker(block.origin);
        const wrapped = marker ? `${marker}\n${block.content}` : block.content;

        if (block.placement === "system") {
          systemBlocks.push(wrapped);
        } else if (block.placement === "assistant-preamble") {
          assistantPreambleStrings.push(wrapped);
        } else {
          contextStrings.push(wrapped);
        }
      }

      const historyTokens = history.reduce((sum, m) => sum + m.tokenCount, 0);
      const totalTokens = preambleTokens + contextUsed + historyTokens + toolSchemaTokens;

      return {
        systemBlocks,
        contextBlocks: contextStrings,
        assistantPreamble:
          assistantPreambleStrings.length > 0 ? assistantPreambleStrings : undefined,
        messages: history,
        tools,
        toolChoice: opts?.toolChoice,
        totalTokens,
        evictions,
      };
    },
  };
}

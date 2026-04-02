import type {
  ContextBlock,
  ContextPriority,
  Message,
  ToolDefinition,
  AssembledPrompt,
} from "../types";
import type { Tokenizer } from "../tokenizer";

const PRIORITY_ORDER: ContextPriority[] = [
  "required",
  "high",
  "normal",
  "low",
  "evictable",
];

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
    ): AssembledPrompt {
      const historyBudget = Math.floor(
        config.maxTokens * (config.historyPercent / 100),
      );
      const toolBudget = Math.floor(
        config.maxTokens * (config.toolSchemaPercent / 100),
      );
      const contextBudget =
        config.maxTokens - historyBudget - toolBudget - preambleTokens;

      // Compute token counts for blocks that don't have them
      for (const block of augmentBlocks) {
        if (block.tokenCount === undefined) {
          block.tokenCount = config.tokenizer.count(block.content);
        }
      }

      // Sort by priority
      const sorted = [...augmentBlocks].sort(
        (a, b) =>
          PRIORITY_ORDER.indexOf(a.priority) -
          PRIORITY_ORDER.indexOf(b.priority),
      );

      // Allocate context blocks by priority
      let contextUsed = 0;
      const included: ContextBlock[] = [];
      const evictions: AssembledPrompt["evictions"] = [];

      for (const block of sorted) {
        const tokens = block.tokenCount!;
        if (contextUsed + tokens <= contextBudget) {
          included.push(block);
          contextUsed += tokens;
        } else {
          evictions.push({
            source: block.source,
            priority: block.priority,
            reason: `over budget (${contextUsed + tokens} > ${contextBudget})`,
          });
        }
      }

      // Build system blocks and context strings
      const systemBlocks = [config.preamble];
      const contextStrings: string[] = [];

      for (const block of included) {
        if (block.visibility === "pipeline-only") continue;

        const peerDerived =
          block.origin === "peer-derived" ? " [PEER-DERIVED]" : "";
        const wrapped = `[AUGMENT CONTEXT: ${block.source}]${peerDerived}\n${block.content}`;

        if (block.placement === "system") {
          systemBlocks.push(wrapped);
        } else {
          contextStrings.push(wrapped);
        }
      }

      const historyTokens = history.reduce(
        (sum, m) => sum + m.tokenCount,
        0,
      );
      const totalTokens = preambleTokens + contextUsed + historyTokens;

      return {
        systemBlocks,
        contextBlocks: contextStrings,
        messages: history,
        tools,
        totalTokens,
        evictions,
      };
    },
  };
}

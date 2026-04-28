import type {
  AssembledPrompt,
  ContextBlock,
  ContextPriority,
  Message,
  ToolDefinition,
} from "../types";
import type { Tokenizer } from "../tokenizer";

const PRIORITY_ORDER: ContextPriority[] = ["required", "high", "normal", "low", "evictable"];

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

      // Sort by priority
      const sorted = [...augmentBlocks].sort(
        (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
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

      // Build system blocks, context strings, and assistant preamble
      const systemBlocks = [config.preamble];
      const contextStrings: string[] = [];
      const assistantPreambleStrings: string[] = [];

      for (const block of included) {
        if (block.visibility === "pipeline-only") continue;

        const originMarker =
          block.origin === "peer-derived"
            ? " [PEER-DERIVED]"
            : block.origin === "agent"
              ? " [AGENT-DERIVED]"
              : "";
        const wrapped = `[AUGMENT CONTEXT: ${block.source}]${originMarker}\n${block.content}`;

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

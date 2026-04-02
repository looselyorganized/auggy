import type { Message, Storage, CompactionStrategy } from "../types";

export interface HistoryManager {
  append(message: Message): void;
  getHistory(tokenBudget: number): Message[];
  compact(tokenBudget: number, strategy: CompactionStrategy): void;
  save(storage: Storage): Promise<void>;
  restore(storage: Storage): Promise<void>;
  totalTokens(): number;
}

export function createHistoryManager(opts: {
  threadId: string;
}): HistoryManager {
  let messages: Message[] = [];
  let runningTokens = 0;
  const storageKey = `history:${opts.threadId}`;

  return {
    append(message: Message) {
      messages.push(message);
      runningTokens += message.tokenCount;
    },

    getHistory(tokenBudget: number): Message[] {
      if (tokenBudget <= 0 || messages.length === 0) return [];

      // Walk backwards from newest, accumulating tokens
      let budget = tokenBudget;
      let startIndex = messages.length;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;

        // Check if this is a tool_result — must include its tool_use pair
        if (
          msg.role === "tool_result" &&
          i > 0 &&
          messages[i - 1]!.role === "tool_use"
        ) {
          const pairCost = msg.tokenCount + messages[i - 1]!.tokenCount;
          if (budget - pairCost < 0 && startIndex < messages.length) break;
          budget -= pairCost;
          startIndex = i - 1;
          i--; // skip the tool_use we just included
        } else if (
          msg.role === "tool_use" &&
          i < messages.length - 1 &&
          messages[i + 1]!.role === "tool_result"
        ) {
          // tool_use encountered before its result in backward walk — skip
          continue;
        } else {
          if (budget - msg.tokenCount < 0 && startIndex < messages.length)
            break;
          budget -= msg.tokenCount;
          startIndex = i;
        }
      }

      return messages.slice(startIndex);
    },

    compact(tokenBudget: number, strategy: CompactionStrategy) {
      const threshold = Math.floor(tokenBudget * 0.8);
      if (runningTokens <= threshold) return;

      if (strategy === "truncate" || strategy === "summarize") {
        // summarize is treated as truncate in v1
        // Drop oldest messages until under threshold, respecting atomic tool pairs
        while (messages.length > 0 && runningTokens > threshold) {
          const first = messages[0]!;
          if (first.role === "tool_use" && messages.length > 1 && messages[1]!.role === "tool_result") {
            // Drop the pair together
            runningTokens -= first.tokenCount + messages[1]!.tokenCount;
            messages.splice(0, 2);
          } else if (first.role === "tool_result") {
            // Orphaned tool_result — drop it
            runningTokens -= first.tokenCount;
            messages.splice(0, 1);
          } else {
            runningTokens -= first.tokenCount;
            messages.splice(0, 1);
          }
        }
      } else if (strategy === "sliding-window") {
        // Keep newest messages that fit within threshold
        let kept = 0;
        let keepFrom = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]!;
          if (kept + msg.tokenCount > threshold) break;
          // Ensure tool pairs stay together
          if (msg.role === "tool_result" && i > 0 && messages[i - 1]!.role === "tool_use") {
            const pairCost = msg.tokenCount + messages[i - 1]!.tokenCount;
            if (kept + pairCost > threshold) break;
            kept += pairCost;
            keepFrom = i - 1;
            i--; // skip tool_use
          } else {
            kept += msg.tokenCount;
            keepFrom = i;
          }
        }
        const removed = messages.splice(0, keepFrom);
        runningTokens -= removed.reduce((s, m) => s + m.tokenCount, 0);
      }
    },

    async save(storage: Storage) {
      await storage.put(storageKey, JSON.stringify(messages));
    },

    async restore(storage: Storage) {
      const data = await storage.get(storageKey);
      if (data) {
        messages = JSON.parse(data);
        runningTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);
      }
    },

    totalTokens() {
      return runningTokens;
    },
  };
}

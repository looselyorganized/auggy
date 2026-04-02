import type { Message, Storage } from "../types";

export interface HistoryManager {
  append(message: Message): void;
  getHistory(tokenBudget: number): Message[];
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

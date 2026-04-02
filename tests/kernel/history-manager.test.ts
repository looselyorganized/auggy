import { describe, it, expect } from "vitest";
import { createHistoryManager } from "@/kernel/history-manager";
import type { Message, Storage } from "@/types";

function msg(
  role: "user" | "assistant" | "tool_use" | "tool_result",
  content: string,
  tokenCount?: number,
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    tokenCount: tokenCount ?? Math.ceil(content.length / 4),
  };
}

function createInMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

describe("HistoryManager", () => {
  it("appends and retrieves messages", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "Hello"));
    hm.append(msg("assistant", "Hi there"));

    const history = hm.getHistory(10000);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
  });

  it("respects token budget — drops oldest first", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "A".repeat(100), 25));
    hm.append(msg("assistant", "B".repeat(100), 25));
    hm.append(msg("user", "C".repeat(100), 25));

    const history = hm.getHistory(50);
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("B".repeat(100));
    expect(history[1]!.content).toBe("C".repeat(100));
  });

  it("keeps tool_use and tool_result as atomic pairs", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "Do something", 10));
    hm.append(msg("tool_use", '{"name":"foo"}', 10));
    hm.append(msg("tool_result", "result", 10));
    hm.append(msg("assistant", "Done", 10));

    // Budget 30: keep tool pair + assistant (30 tokens), drop user
    const history = hm.getHistory(30);
    expect(history).toHaveLength(3);
    expect(history[0]!.role).toBe("tool_use");
    expect(history[1]!.role).toBe("tool_result");
    expect(history[2]!.role).toBe("assistant");
  });

  it("returns empty array when budget is 0", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "Hello"));
    expect(hm.getHistory(0)).toEqual([]);
  });

  it("saves and restores from storage", async () => {
    const store = createInMemoryStorage();
    const hm1 = createHistoryManager({ threadId: "t1" });
    hm1.append(msg("user", "Hello"));
    hm1.append(msg("assistant", "Hi"));
    await hm1.save(store);

    const hm2 = createHistoryManager({ threadId: "t1" });
    await hm2.restore(store);
    const history = hm2.getHistory(10000);
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Hello");
  });

  it("tracks total tokens", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "Hello", 5));
    hm.append(msg("assistant", "World", 10));
    expect(hm.totalTokens()).toBe(15);
  });
});

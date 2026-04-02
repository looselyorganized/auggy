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

  it("compact truncate: drops oldest messages when over 80% budget", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    // 5 messages at 20 tokens each = 100 total
    for (let i = 0; i < 5; i++) {
      hm.append(msg("user", `msg-${i}`, 20));
    }
    expect(hm.totalTokens()).toBe(100);

    // Budget of 100, threshold 80% = 80 tokens. We're at 100 → compact.
    hm.compact(100, "truncate");

    // Should drop oldest until at or under 80 tokens (drop 1 → 80 tokens)
    expect(hm.totalTokens()).toBeLessThanOrEqual(80);
    const history = hm.getHistory(10000);
    expect(history[0]!.content).toBe("msg-1");
  });

  it("compact truncate: preserves atomic tool pairs", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "start", 10));
    hm.append(msg("tool_use", "call", 10));
    hm.append(msg("tool_result", "result", 10));
    hm.append(msg("assistant", "done", 10));
    // 40 tokens total

    // Budget 40, threshold 80% = 32. Need to compact.
    hm.compact(40, "truncate");

    const history = hm.getHistory(10000);
    // Should drop user message (10), but tool pair must stay together
    // If it drops user (10) → 30 tokens, under 32. Done.
    // OR if it tries to drop tool_use, it must also drop tool_result
    const roles = history.map((m) => m.role);
    const hasToolUse = roles.includes("tool_use");
    const hasToolResult = roles.includes("tool_result");
    // Either both present or both absent
    expect(hasToolUse).toBe(hasToolResult);
  });

  it("compact does nothing when under threshold", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    hm.append(msg("user", "Hello", 10));
    hm.append(msg("assistant", "Hi", 10));
    // 20 tokens, budget 100, threshold 80 → no compact needed

    hm.compact(100, "truncate");
    expect(hm.totalTokens()).toBe(20);
  });

  it("compact sliding-window: keeps last N turns", () => {
    const hm = createHistoryManager({ threadId: "t1" });
    for (let i = 0; i < 10; i++) {
      hm.append(msg("user", `u-${i}`, 10));
      hm.append(msg("assistant", `a-${i}`, 10));
    }
    // 20 messages, 200 tokens

    // Budget 100, threshold 80% = 80. sliding-window keeps newest pairs.
    hm.compact(100, "sliding-window");

    expect(hm.totalTokens()).toBeLessThanOrEqual(80);
    const history = hm.getHistory(10000);
    // Last message should be the newest
    expect(history[history.length - 1]!.content).toBe("a-9");
  });
});

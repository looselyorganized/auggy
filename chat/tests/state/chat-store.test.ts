import { describe, it, expect, beforeEach } from "bun:test";
import {
  loadAgentHistory,
  saveAgentHistory,
  clearAgentHistory,
  clearAllHistory,
  type AgentHistory,
  type ChatMessage,
} from "../../src/state/chat-store";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
}

beforeEach(() => {
  (globalThis as any).localStorage = new FakeStorage();
});

const exampleMessage = (role: "user" | "assistant", content: string): ChatMessage => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  createdAt: new Date().toISOString(),
});

describe("chat-store", () => {
  it("returns null when history is missing", () => {
    expect(loadAgentHistory("zip", "local")).toBeNull();
  });

  it("saves and reloads history", () => {
    const h: AgentHistory = {
      threadId: "t1",
      messages: [exampleMessage("user", "hi")],
      lastUpdated: new Date().toISOString(),
      agentMetadata: { name: "zip", description: "front-door", capabilities: ["chat"] },
    };
    saveAgentHistory("zip", "local", h);
    const loaded = loadAgentHistory("zip", "local");
    expect(loaded?.threadId).toBe("t1");
    expect(loaded?.messages).toHaveLength(1);
  });

  it("keys by agent@source — same name across sources doesn't collide", () => {
    const a: AgentHistory = { threadId: "tA", messages: [], lastUpdated: "", agentMetadata: { name: "zip" } };
    const b: AgentHistory = { threadId: "tB", messages: [], lastUpdated: "", agentMetadata: { name: "zip" } };
    saveAgentHistory("zip", "local", a);
    saveAgentHistory("zip", "myNetwork", b);
    expect(loadAgentHistory("zip", "local")?.threadId).toBe("tA");
    expect(loadAgentHistory("zip", "myNetwork")?.threadId).toBe("tB");
  });

  it("clearAgentHistory removes one agent's history", () => {
    saveAgentHistory("zip", "local", { threadId: "t", messages: [], lastUpdated: "", agentMetadata: { name: "zip" } });
    saveAgentHistory("other", "local", { threadId: "t2", messages: [], lastUpdated: "", agentMetadata: { name: "other" } });
    clearAgentHistory("zip", "local");
    expect(loadAgentHistory("zip", "local")).toBeNull();
    expect(loadAgentHistory("other", "local")).not.toBeNull();
  });

  it("clearAllHistory removes everything", () => {
    saveAgentHistory("a", "local", { threadId: "t", messages: [], lastUpdated: "", agentMetadata: { name: "a" } });
    saveAgentHistory("b", "myNetwork", { threadId: "t", messages: [], lastUpdated: "", agentMetadata: { name: "b" } });
    clearAllHistory();
    expect(loadAgentHistory("a", "local")).toBeNull();
    expect(loadAgentHistory("b", "myNetwork")).toBeNull();
  });

  it("caps history at maxMessages — oldest evicted on save", () => {
    const messages = Array.from({ length: 250 }, (_, i) => exampleMessage("user", `msg ${i}`));
    saveAgentHistory("zip", "local", {
      threadId: "t",
      messages,
      lastUpdated: "",
      agentMetadata: { name: "zip" },
    }, { maxMessages: 200 });
    const loaded = loadAgentHistory("zip", "local");
    expect(loaded?.messages).toHaveLength(200);
    expect(loaded?.messages[0]!.content).toBe("msg 50");
  });

  it("survives malformed JSON in localStorage (returns null)", () => {
    (globalThis as any).localStorage.setItem("aug1-chat:zip@local", "not json");
    expect(loadAgentHistory("zip", "local")).toBeNull();
  });

  it("survives schema-version mismatch (returns null)", () => {
    (globalThis as any).localStorage.setItem("aug1-chat:zip@local", JSON.stringify({ schema: 999, threadId: "t" }));
    expect(loadAgentHistory("zip", "local")).toBeNull();
  });

  it("truncates tool-call args/result over 10KB on persist", () => {
    const bigArgs = "x".repeat(50 * 1024);
    const bigResult = "y".repeat(50 * 1024);
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      content: "ran a tool",
      createdAt: new Date().toISOString(),
      toolCalls: [{ id: "tc1", name: "bash", args: bigArgs, result: bigResult, status: "completed" }],
    };
    saveAgentHistory("zip", "local", {
      threadId: "t",
      messages: [msg],
      lastUpdated: "",
      agentMetadata: { name: "zip" },
    });
    const loaded = loadAgentHistory("zip", "local");
    const tc = loaded?.messages[0]!.toolCalls![0]!;
    expect(tc.args!.length).toBeLessThanOrEqual(10 * 1024 + 32);
    expect(tc.args!.endsWith("…[truncated]")).toBe(true);
    expect(tc.result!.length).toBeLessThanOrEqual(10 * 1024 + 32);
    expect(tc.result!.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves tool-call args/result under 10KB unchanged", () => {
    const args = "a".repeat(5 * 1024);
    const result = "b".repeat(5 * 1024);
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      content: "ran a tool",
      createdAt: new Date().toISOString(),
      toolCalls: [{ id: "tc1", name: "bash", args, result, status: "completed" }],
    };
    saveAgentHistory("zip", "local", {
      threadId: "t",
      messages: [msg],
      lastUpdated: "",
      agentMetadata: { name: "zip" },
    });
    const loaded = loadAgentHistory("zip", "local");
    const tc = loaded?.messages[0]!.toolCalls![0]!;
    expect(tc.args).toBe(args);
    expect(tc.result).toBe(result);
  });

  it("clearAllHistory leaves non-aug1-chat keys intact", () => {
    saveAgentHistory("a", "local", { threadId: "t", messages: [], lastUpdated: "", agentMetadata: { name: "a" } });
    (globalThis as any).localStorage.setItem("other-app:foo", "preserve me");
    saveAgentHistory("b", "myNetwork", { threadId: "t", messages: [], lastUpdated: "", agentMetadata: { name: "b" } });
    clearAllHistory();
    expect(loadAgentHistory("a", "local")).toBeNull();
    expect(loadAgentHistory("b", "myNetwork")).toBeNull();
    expect((globalThis as any).localStorage.getItem("other-app:foo")).toBe("preserve me");
  });
});

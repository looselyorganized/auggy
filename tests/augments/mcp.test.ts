import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "../../src/agent";
import { mcp, type McpClientAdapter, type McpConnection } from "../../src/augments/mcp";
import { createMcpManager } from "../../src/augments/mcp/manager";
import type { McpRuntimeServer, McpToolCallResult } from "../../src/augments/mcp/types";
import type { TurnTrigger } from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";

const TMP = join(import.meta.dir, ".tmp-mcp-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

class FakeMcpConnection implements McpConnection {
  closed = false;
  calls: { name: string; args: Record<string, unknown>; timeoutMs: number }[] = [];

  constructor(
    private tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
    private result: McpToolCallResult = { content: [{ type: "text", text: "ok" }] },
  ) {}

  async listTools() {
    return { tools: this.tools };
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number) {
    this.calls.push({ name, args, timeoutMs });
    return this.result;
  }

  async close() {
    this.closed = true;
  }
}

class FakeMcpAdapter implements McpClientAdapter {
  servers: McpRuntimeServer[] = [];
  connections: FakeMcpConnection[] = [];

  constructor(
    private tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
    private result?: McpToolCallResult,
  ) {}

  async connect(server: McpRuntimeServer) {
    this.servers.push(server);
    const connection = new FakeMcpConnection(this.tools, this.result);
    this.connections.push(connection);
    return connection;
  }
}

class FailingMcpAdapter implements McpClientAdapter {
  async connect(): Promise<McpConnection> {
    throw new Error("remote unavailable with token abcdefghijklmnopqrstuvwxyz123456");
  }
}

function writeMcpConfig(config: unknown) {
  writeFileSync(join(TMP, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
}

describe("mcp augment runtime", () => {
  test("discovers remote tools and exposes namespaced Auggy tools", async () => {
    writeMcpConfig({
      mcpServers: {
        github: { type: "stdio", command: "node", args: ["server.js"] },
      },
    });
    const adapter = new FakeMcpAdapter([
      {
        name: "search",
        description: "Search repositories",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
    const manager = createMcpManager({ agentDir: TMP, client: adapter });
    await manager.boot();

    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp_github_search"]);
    expect(manager.statuses()[0]).toMatchObject({
      name: "github",
      transport: "stdio",
      state: "connected",
      tools: 1,
    });

    const result = await manager.tools[0]!.execute({ q: "auggy" });
    expect(result).toEqual({ content: "ok" });
    expect(adapter.connections[0]!.calls[0]).toMatchObject({
      name: "search",
      args: { q: "auggy" },
    });
    await manager.shutdown();
    expect(adapter.connections[0]!.closed).toBe(true);
  });

  test("enforces allowedTools and blockedTools before exposing tools", async () => {
    writeMcpConfig({
      mcpServers: {
        ops: { type: "streamable-http", url: "https://mcp.example.com" },
      },
      auggy: {
        servers: {
          ops: {
            allowedTools: ["read_status", "delete_all"],
            blockedTools: ["delete_all"],
          },
        },
      },
    });
    const adapter = new FakeMcpAdapter([
      { name: "read_status", inputSchema: { type: "object" } },
      { name: "delete_all", inputSchema: { type: "object" } },
      { name: "unlisted", inputSchema: { type: "object" } },
    ]);
    const manager = createMcpManager({ agentDir: TMP, client: adapter });
    await manager.boot();
    expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp_ops_read_status"]);
  });

  test("failed external servers do not crash boot or expose tools", async () => {
    writeMcpConfig({
      mcpServers: {
        flaky: { type: "streamable-http", url: "https://mcp.example.com" },
      },
    });
    const manager = createMcpManager({ agentDir: TMP, client: new FailingMcpAdapter() });
    await manager.boot();
    expect(manager.tools).toHaveLength(0);
    expect(manager.statuses()[0]).toMatchObject({
      name: "flaky",
      state: "failed",
      tools: 0,
    });
    expect(manager.statuses()[0]?.error).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("local-only stdio servers are skipped at boot", async () => {
    writeMcpConfig({
      mcpServers: {
        local: { type: "stdio", command: "node", auggy: { cloud: "localOnly" } },
      },
    });
    const adapter = new FakeMcpAdapter([{ name: "search", inputSchema: { type: "object" } }]);
    const manager = createMcpManager({ agentDir: TMP, client: adapter });
    await manager.boot();
    expect(adapter.servers).toHaveLength(0);
    expect(manager.statuses()[0]).toMatchObject({ name: "local", state: "disabled" });
  });

  test("concurrency guard returns a clean tool result", async () => {
    writeMcpConfig({
      mcpServers: {
        local: { type: "stdio", command: "node" },
      },
    });
    let release: (() => void) | undefined;
    class SlowConnection extends FakeMcpConnection {
      override async callTool(name: string, args: Record<string, unknown>, timeoutMs: number) {
        this.calls.push({ name, args, timeoutMs });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: [{ type: "text", text: "done" }] };
      }
    }
    class SlowAdapter implements McpClientAdapter {
      connection = new SlowConnection([{ name: "work", inputSchema: { type: "object" } }]);
      async connect() {
        return this.connection;
      }
    }
    const manager = createMcpManager({
      agentDir: TMP,
      client: new SlowAdapter(),
      maxConcurrentCalls: 1,
    });
    await manager.boot();
    const first = manager.tools[0]!.execute({});
    const second = await manager.tools[0]!.execute({});
    expect(JSON.stringify(second)).toContain("is busy");
    release?.();
    await first;
  });

  test("interpolates env references without passing literal placeholders", async () => {
    writeFileSync(join(TMP, ".env"), "MCP_TOKEN=secret-token\n", "utf-8");
    writeMcpConfig({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        },
      },
    });
    const adapter = new FakeMcpAdapter([]);
    await createMcpManager({ agentDir: TMP, client: adapter }).boot();
    expect(adapter.servers[0]!.transport).toBe("streamable-http");
    expect(adapter.servers[0]!.config.headers?.Authorization).toBe("Bearer secret-token");
  });

  test("caps model-facing MCP tool output", async () => {
    writeMcpConfig({
      mcpServers: {
        local: { type: "stdio", command: "node" },
      },
    });
    const adapter = new FakeMcpAdapter([{ name: "dump", inputSchema: { type: "object" } }], {
      content: [{ type: "text", text: "x".repeat(200) }],
    });
    const manager = createMcpManager({ agentDir: TMP, client: adapter, maxResultBytes: 64 });
    await manager.boot();
    const result = await manager.tools[0]!.execute({});
    expect(JSON.stringify(result)).toContain("truncated to 64 bytes");
  });

  test("boot-populated MCP tools are available to the turn loop", async () => {
    writeMcpConfig({
      mcpServers: {
        github: { type: "stdio", command: "node" },
      },
    });
    const adapter = new FakeMcpAdapter([{ name: "search", inputSchema: { type: "object" } }]);
    const augment = mcp({ agentDir: TMP, client: adapter });
    const model = createMockModel();
    model.pushResponse({
      content: "",
      finishReason: "tool_use",
      toolCalls: [{ name: "mcp_github_search", arguments: { q: "auggy" } }],
    });
    model.pushResponse({ content: "done", finishReason: "end_turn" });

    const agent = defineAgent({ name: "mcp-test", model: "mock", augments: [augment] }, model);
    await agent.start();
    try {
      const trigger: TurnTrigger = {
        type: "message",
        turnId: "turn-1",
        threadId: "thread-1",
        timestamp: Date.now(),
        source: "test",
        peer: null,
        payload: {
          parts: [{ kind: "text", text: "search" }],
          sourceAugment: "test",
          peer: null,
          timestamp: Date.now(),
        },
      };
      const result = await agent.inject(trigger);
      expect(result.success).toBe(true);
      expect(result.toolCalls[0]?.name).toBe("mcp_github_search");
      expect(adapter.connections[0]!.calls[0]?.name).toBe("search");
    } finally {
      await agent.stop();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpManager } from "../../src/augments/mcp/manager";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "auggy-mcp-e2e-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("MCP stdio e2e", () => {
  test("discovers and calls a real stdio MCP server", async () => {
    writeFileSync(
      join(agentDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            smoke: {
              type: "stdio",
              command: "bun",
              args: [resolve("examples/mcp-stdio-server/server.ts")],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const manager = createMcpManager({ agentDir, timeoutMs: 5_000 });
    await manager.boot();
    try {
      expect(manager.statuses()).toEqual([
        {
          name: "smoke",
          transport: "stdio",
          state: "connected",
          tools: 1,
        },
      ]);
      expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp_smoke_pickleball_score"]);

      const result = await manager.tools[0]!.execute({ player: "Mike" });
      expect(result).toEqual({ content: "Mike wins 11-7" });
    } finally {
      await manager.shutdown();
    }
  });
});

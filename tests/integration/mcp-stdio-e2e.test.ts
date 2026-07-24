import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
          restrictedTools: 1,
        },
      ]);
      expect(manager.tools.map((tool) => tool.name)).toEqual(["mcp_smoke_pickleball_score"]);

      const result = await manager.tools[0]!.execute(
        { player: "Mike" },
        { turnId: "smoke-turn", threadId: "smoke-thread", peer: null },
      );
      expect(result).toEqual({ content: "Mike wins 11-7" });
    } finally {
      await manager.shutdown();
    }
  });

  test("terminates a stalled stdio child when connection setup times out", async () => {
    const serverPath = join(agentDir, "stalled-server.ts");
    const pidPath = join(agentDir, "stalled-server.pid");
    writeFileSync(
      serverPath,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2]!, String(process.pid), "utf8");',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    writeFileSync(
      join(agentDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            stalled: {
              type: "stdio",
              command: process.execPath,
              args: [serverPath, pidPath],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const manager = createMcpManager({ agentDir, timeoutMs: 100 });
    let childPid: number | undefined;
    try {
      await manager.boot();
      expect(manager.statuses()[0]).toMatchObject({
        name: "stalled",
        state: "failed",
        error: "connect timed out after 100ms",
      });
      childPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(childPid)).toBe(true);
      await manager.shutdown();
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      await manager.shutdown();
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  test("aborts stalled remote session termination without stranding a later stdio child", async () => {
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolveStarted) => {
      markDeleteStarted = resolveStarted;
    });
    let deleteAborted = false;
    const remote = Bun.serve({
      port: 19731,
      async fetch(req) {
        if (req.method === "DELETE") {
          markDeleteStarted();
          return new Promise<Response>((resolveResponse) => {
            req.signal.addEventListener(
              "abort",
              () => {
                deleteAborted = true;
                resolveResponse(new Response(null, { status: 499 }));
              },
              { once: true },
            );
          });
        }
        if (req.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const body = (await req.json()) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (body.id === undefined) return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
                capabilities: {},
                serverInfo: { name: "stalled-http", version: "1.0.0" },
              }
            : body.method === "tools/list"
              ? { tools: [] }
              : {};
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result },
          {
            headers: {
              "mcp-session-id": "stalled-delete-session",
            },
          },
        );
      },
    });
    const childPath = join(agentDir, "tracked-server.ts");
    const childPidPath = join(agentDir, "tracked-server.pid");
    writeFileSync(
      childPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid), "utf8");`,
        `await import(${JSON.stringify(pathToFileURL(resolve("examples/mcp-stdio-server/server.ts")).href)});`,
      ].join("\n"),
    );
    writeFileSync(
      join(agentDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            remote: {
              type: "streamable-http",
              url: `http://127.0.0.1:${remote.port}/mcp`,
            },
            child: {
              type: "stdio",
              command: process.execPath,
              args: [childPath],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const manager = createMcpManager({ agentDir, timeoutMs: 2_000 });
    let childPid: number | undefined;
    try {
      await manager.boot();
      expect(manager.statuses().map((status) => status.state)).toEqual(["connected", "connected"]);
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(isProcessAlive(childPid)).toBe(true);

      const controller = new AbortController();
      const shutdown = manager.shutdown(controller.signal);
      await deleteStarted;
      controller.abort(new DOMException("lifecycle deadline", "AbortError"));
      await shutdown;

      expect(deleteAborted).toBe(true);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      await manager.shutdown();
      remote.stop(true);
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

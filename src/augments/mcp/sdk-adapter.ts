import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRedirectRejectingFetch } from "../../http";
import type { McpClientAdapter, McpConnection, McpRuntimeServer, McpToolCallResult } from "./types";

export class SdkMcpClientAdapter implements McpClientAdapter {
  async connect(server: McpRuntimeServer): Promise<McpConnection> {
    const client = new Client({
      name: "auggy",
      version: "1.0.0",
    });
    const transport = createTransport(server);
    await client.connect(transport);
    return {
      async listTools(cursor?: string) {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: server.policy.timeoutMs,
        });
        return {
          tools: result.tools,
          nextCursor: result.nextCursor,
        };
      },
      async callTool(
        name: string,
        args: Record<string, unknown>,
        timeoutMs: number,
        signal?: AbortSignal,
      ) {
        return (await client.callTool(
          {
            name,
            arguments: args,
          },
          undefined,
          { timeout: timeoutMs, signal },
        )) as McpToolCallResult;
      },
      async close() {
        if ("terminateSession" in transport && typeof transport.terminateSession === "function") {
          try {
            await transport.terminateSession();
          } catch {
            // Some servers reject DELETE session termination; close still releases local resources.
          }
        }
        await client.close();
      },
    };
  }
}

export function createTransport(
  server: McpRuntimeServer,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Transport {
  const credentialSafeFetch = createRedirectRejectingFetch(fetchImpl);
  switch (server.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: mustString(server.config.command, `${server.name}.command`),
        args: server.config.args,
        cwd: typeof server.config.cwd === "string" ? server.config.cwd : undefined,
        env: {
          ...getDefaultEnvironment(),
          ...(server.config.env ?? {}),
        },
        stderr: "ignore",
      });
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(mustString(server.config.url, `${server.name}.url`)),
        {
          fetch: credentialSafeFetch,
          requestInit: {
            headers: server.config.headers,
          },
        },
      );
    case "sse":
      return new SSEClientTransport(new URL(mustString(server.config.url, `${server.name}.url`)), {
        fetch: credentialSafeFetch,
        requestInit: {
          headers: server.config.headers,
        },
        eventSourceInit: {
          fetch: credentialSafeFetch,
        },
      });
  }
}

function mustString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`mcp: ${label} must be set`);
  }
  return value;
}

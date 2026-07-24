import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRedirectRejectingFetch } from "../../http";
import { BoundedStdioClientTransport } from "./bounded-stdio-transport";
import { createMcpBoundedFetch } from "./bounded-fetch";
import type { McpClientAdapter, McpConnection, McpRuntimeServer, McpToolCallResult } from "./types";

export class SdkMcpClientAdapter implements McpClientAdapter {
  async connect(server: McpRuntimeServer, signal?: AbortSignal): Promise<McpConnection> {
    const client = new Client({
      name: "auggy",
      version: "1.0.0",
    });
    const transportAbort = new AbortController();
    const transport = createTransport(
      server,
      globalThis.fetch.bind(globalThis),
      transportAbort.signal,
    );
    let closePromise: Promise<void> | undefined;
    const closePending = (): Promise<void> => {
      transportAbort.abort(new DOMException("MCP connection closed", "AbortError"));
      closePromise ??= client.close().catch(async () => {
        // Protocol.close normally closes its attached transport. If connect
        // failed before attachment completed, close the transport explicitly
        // so a spawned stdio child cannot outlive the timed-out attempt.
        await transport.close().catch(() => {});
      });
      return closePromise;
    };
    const onAbort = (): void => {
      void closePending();
    };
    if (signal?.aborted) {
      await closePending();
      throw signal.reason ?? new Error("MCP connection cancelled");
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await client.connect(transport);
      if (signal?.aborted) {
        await closePending();
        throw signal.reason ?? new Error("MCP connection cancelled");
      }
    } catch (error) {
      await closePending();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
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
          {
            timeout: timeoutMs,
            signal,
          },
        )) as McpToolCallResult;
      },
      async close(signal?: AbortSignal) {
        if (closePromise) {
          await closePromise;
          return;
        }
        const closeDeadline = new AbortController();
        const timeout = setTimeout(
          () =>
            closeDeadline.abort(
              new DOMException("MCP remote session termination timed out", "TimeoutError"),
            ),
          Math.min(server.policy.timeoutMs ?? 30_000, 1_250),
        );
        const closeSignal = signal
          ? AbortSignal.any([signal, closeDeadline.signal])
          : closeDeadline.signal;
        try {
          if ("terminateSession" in transport && typeof transport.terminateSession === "function") {
            let rejectOnAbort: (() => void) | undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
              rejectOnAbort = () => reject(closeSignal.reason);
              if (closeSignal.aborted) rejectOnAbort();
              else closeSignal.addEventListener("abort", rejectOnAbort, { once: true });
            });
            try {
              await Promise.race([transport.terminateSession(), aborted]).catch(() => {});
            } finally {
              if (rejectOnAbort) closeSignal.removeEventListener("abort", rejectOnAbort);
            }
          }
        } finally {
          clearTimeout(timeout);
          transportAbort.abort(
            closeSignal.aborted
              ? closeSignal.reason
              : new DOMException("MCP connection closed", "AbortError"),
          );
          await closePending();
        }
      },
    };
  }
}

export function createTransport(
  server: McpRuntimeServer,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal,
): Transport {
  const abortableFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const requestSignal = init?.signal;
    const combinedSignal =
      signal && requestSignal
        ? AbortSignal.any([signal, requestSignal])
        : (signal ?? requestSignal ?? undefined);
    return fetchImpl(input, { ...init, ...(combinedSignal ? { signal: combinedSignal } : {}) });
  }) as typeof fetch;
  const credentialSafeFetch = createRedirectRejectingFetch(abortableFetch);
  const boundedFetch = createMcpBoundedFetch(
    credentialSafeFetch,
    server.policy.maxTransportMessageBytes ?? 256 * 1024,
  );
  switch (server.transport) {
    case "stdio":
      return new BoundedStdioClientTransport({
        command: mustString(server.config.command, `${server.name}.command`),
        args: server.config.args,
        cwd: typeof server.config.cwd === "string" ? server.config.cwd : undefined,
        env: {
          ...getDefaultEnvironment(),
          ...(server.config.env ?? {}),
        },
        maxMessageBytes: server.policy.maxTransportMessageBytes ?? 256 * 1024,
      });
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(mustString(server.config.url, `${server.name}.url`)),
        {
          fetch: boundedFetch,
          requestInit: {
            headers: server.config.headers,
          },
        },
      );
    case "sse":
      return new SSEClientTransport(new URL(mustString(server.config.url, `${server.name}.url`)), {
        fetch: boundedFetch,
        requestInit: {
          headers: server.config.headers,
        },
        eventSourceInit: {
          fetch: boundedFetch,
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

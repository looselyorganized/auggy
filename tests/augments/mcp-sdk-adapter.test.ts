import { describe, expect, test } from "bun:test";
import { createTransport } from "../../src/augments/mcp/sdk-adapter";
import type { McpRuntimeServer } from "../../src/augments/mcp/types";

function remoteServer(transport: "streamable-http" | "sse"): McpRuntimeServer {
  return {
    name: "remote",
    transport,
    config: {
      type: transport,
      url: "https://mcp.example/",
      headers: { "X-API-Key": "sentinel-secret" },
    },
    policy: {},
  };
}

type TransportInternals = {
  _fetch?: typeof fetch;
  _eventSourceInit?: { fetch?: typeof fetch };
};

describe("MCP credential redirect boundary", () => {
  for (const kind of ["streamable-http", "sse"] as const) {
    test(`${kind} rejects redirects before configured headers can follow`, async () => {
      const calls: RequestInit[] = [];
      const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/" },
        });
      }) as typeof fetch;
      const transport = createTransport(
        remoteServer(kind),
        fetchImpl,
      ) as unknown as TransportInternals;
      if (!transport._fetch) throw new Error("MCP transport did not retain hardened fetch");

      await expect(
        transport._fetch("https://mcp.example/", {
          headers: { "X-API-Key": "sentinel-secret" },
        }),
      ).rejects.toThrow(/redirects are disabled/i);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.redirect).toBe("manual");

      if (kind === "sse") {
        const eventSourceFetch = transport._eventSourceInit?.fetch;
        if (!eventSourceFetch) throw new Error("SSE transport did not retain hardened fetch");
        await expect(
          eventSourceFetch("https://mcp.example/", {
            headers: { "X-API-Key": "sentinel-secret" },
          }),
        ).rejects.toThrow(/redirects are disabled/i);
        expect(calls).toHaveLength(2);
      }
    });
  }
});

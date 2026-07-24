import { describe, expect, test } from "bun:test";
import { createMcpBoundedFetch } from "../../src/augments/mcp/bounded-fetch";
import { BoundedStdioClientTransport } from "../../src/augments/mcp/bounded-stdio-transport";
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

describe("MCP HTTP transport message bounds", () => {
  test("rejects a declared oversized response before reading it", async () => {
    let canceled = false;
    const base = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-length": "9" } },
      )) as unknown as typeof fetch;

    await expect(createMcpBoundedFetch(base, 8)("https://mcp.example/")).rejects.toThrow(
      /byte limit/i,
    );
    expect(canceled).toBe(true);
  });

  test("cancels a chunked response as soon as aggregate bytes exceed the cap", async () => {
    let canceled = false;
    const base = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("1234"));
            controller.enqueue(new TextEncoder().encode("56789"));
          },
          cancel() {
            canceled = true;
          },
        }),
      )) as unknown as typeof fetch;
    const response = await createMcpBoundedFetch(base, 8)("https://mcp.example/");

    await expect(response.text()).rejects.toThrow(/byte limit/i);
    expect(canceled).toBe(true);
  });

  test("caps each SSE event independently for LF and CRLF separators", async () => {
    const chunks = ["data:a\r\n\r", "\ndata:b\n", "\ndata:c\r\n\r\n"];
    const base = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      )) as unknown as typeof fetch;
    const response = await createMcpBoundedFetch(base, 12)("https://mcp.example/");

    expect(await response.text()).toBe(chunks.join(""));
  });

  test("cancels an oversized SSE event even when it spans chunks", async () => {
    let canceled = false;
    const base = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data:12"));
            controller.enqueue(new TextEncoder().encode("3456"));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const response = await createMcpBoundedFetch(base, 10)("https://mcp.example/");

    await expect(response.text()).rejects.toThrow(/event exceeded/i);
    expect(canceled).toBe(true);
  });

  test("counts terminating SSE framing bytes at one-chunk and split boundaries", async () => {
    for (const chunks of [["data:x\n\n"], ["data:x\r\n\r", "\n"]]) {
      let canceled = false;
      const base = (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch;
      const maxMessageBytes = chunks.join("").length - 1;
      const response = await createMcpBoundedFetch(base, maxMessageBytes)("https://mcp.example/");

      await expect(response.text()).rejects.toThrow(/event exceeded/i);
      expect(canceled).toBe(true);
    }
  });
});

describe("MCP stdio transport message bounds", () => {
  test("gates late child output after a fatal oversized message", async () => {
    const childScript = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("x".repeat(33));',
      'setTimeout(() => process.stdout.write("\\n{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"late\\"}\\n"), 150);',
      "setTimeout(() => process.exit(0), 200);",
    ].join("");
    const transport = new BoundedStdioClientTransport({
      command: process.execPath,
      args: ["-e", childScript],
      env: {},
      maxMessageBytes: 32,
    });
    const messages: unknown[] = [];
    const error = new Promise<Error>((resolve) => {
      transport.onerror = resolve;
    });
    transport.onmessage = (message) => messages.push(message);

    await transport.start();
    expect((await error).message).toMatch(/byte limit/i);
    await transport.close();

    expect(messages).toHaveLength(0);
  });

  test("rejects invalid direct byte limits", () => {
    expect(
      () =>
        new BoundedStdioClientTransport({
          command: process.execPath,
          env: {},
          maxMessageBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/positive safe integer/i);
  });
});

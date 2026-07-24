import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export function createMcpBoundedFetch(base: FetchLike, maxMessageBytes: number): FetchLike {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body) return response;
    const isEventStream = response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/event-stream");
    const declared = response.headers.get("content-length");
    if (
      !isEventStream &&
      declared !== null &&
      (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > maxMessageBytes)
    ) {
      await response.body.cancel().catch(() => {});
      throw new Error("MCP HTTP response exceeded the configured byte limit.");
    }

    const reader = response.body.getReader();
    let messageBytes = 0;
    let previousByte = -1;
    let secondPreviousByte = -1;
    let thirdPreviousByte = -1;
    const boundedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (!value) return;
          if (isEventStream) {
            for (const byte of value) {
              messageBytes++;
              const endsLfEvent = previousByte === 0x0a && byte === 0x0a;
              const endsCrlfEvent =
                thirdPreviousByte === 0x0d &&
                secondPreviousByte === 0x0a &&
                previousByte === 0x0d &&
                byte === 0x0a;
              if (endsLfEvent || endsCrlfEvent) {
                messageBytes = 0;
                previousByte = -1;
                secondPreviousByte = -1;
                thirdPreviousByte = -1;
              } else {
                thirdPreviousByte = secondPreviousByte;
                secondPreviousByte = previousByte;
                previousByte = byte;
              }
              if (messageBytes > maxMessageBytes) {
                await reader.cancel().catch(() => {});
                controller.error(new Error("MCP SSE event exceeded the configured byte limit."));
                return;
              }
            }
          } else {
            messageBytes += value.byteLength;
            if (messageBytes > maxMessageBytes) {
              await reader.cancel().catch(() => {});
              controller.error(new Error("MCP HTTP response exceeded the configured byte limit."));
              return;
            }
          }
          controller.enqueue(value);
        } catch {
          controller.error(new Error("MCP response stream failed."));
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(boundedBody, response);
  };
}

import { describe, expect, it } from "bun:test";
import {
  InvalidRequestBodyError,
  readRequestBodyJson,
  readRequestBodyText,
  RequestBodyTooLargeError,
} from "../../src/transports/request-body";

function chunkedRequest(chunks: Uint8Array[], headers?: Record<string, string>): Request {
  let index = 0;
  return new Request("http://localhost/test", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  });
}

describe("bounded request bodies", () => {
  it("counts actual chunked UTF-8 bytes without Content-Length", async () => {
    const encoder = new TextEncoder();
    await expect(readRequestBodyText(chunkedRequest([encoder.encode("😀")]), 4)).resolves.toBe(
      "😀",
    );
    await expect(
      readRequestBodyText(chunkedRequest([encoder.encode("😀"), encoder.encode("x")]), 4),
    ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects a declared oversized body before pulling it", async () => {
    let pulls = 0;
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "100" },
      body: new ReadableStream<Uint8Array>({
        pull() {
          pulls++;
        },
      }),
    });
    await expect(readRequestBodyText(request, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(pulls).toBe(0);
  });

  it("does not trust a false-small declared length", async () => {
    const encoder = new TextEncoder();
    const request = chunkedRequest([encoder.encode("12345"), encoder.encode("6")], {
      "content-length": "1",
    });
    await expect(readRequestBodyText(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects ambiguous or malformed lengths", async () => {
    for (const value of ["-1", "+1", "1, 1", "01", "1.0", "9007199254740992"]) {
      const request = chunkedRequest([], { "content-length": value });
      await expect(readRequestBodyText(request, 10)).rejects.toBeInstanceOf(
        InvalidRequestBodyError,
      );
    }
  });

  it("rejects malformed UTF-8 and malformed JSON with stable errors", async () => {
    await expect(
      readRequestBodyText(chunkedRequest([new Uint8Array([0xc3, 0x28])]), 10),
    ).rejects.toBeInstanceOf(InvalidRequestBodyError);
    await expect(
      readRequestBodyJson(chunkedRequest([new TextEncoder().encode("{")]), 10),
    ).rejects.toBeInstanceOf(InvalidRequestBodyError);
  });
});

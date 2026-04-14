import { describe, test, expect, afterAll } from "bun:test";
import { createHttpClient } from "../src/http";

// ---------------------------------------------------------------------------
// Test HTTP server — serves controlled responses for redirect, body size,
// and header inspection scenarios.
// ---------------------------------------------------------------------------

let serverPort = 0;
let server: ReturnType<typeof Bun.serve>;

const receivedHeaders: Record<string, Record<string, string>> = {};

function startTestServer() {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Store received headers for inspection.
      const h: Record<string, string> = {};
      req.headers.forEach((value, key) => { h[key] = value; });
      receivedHeaders[path] = h;

      // --- Redirect scenarios ---

      if (path === "/redirect-same-origin") {
        return new Response(null, {
          status: 302,
          headers: { location: "/final" },
        });
      }

      if (path === "/final") {
        return new Response("final destination");
      }

      // --- Body size scenarios ---

      if (path === "/large-body") {
        // 100KB body
        const body = "x".repeat(100 * 1024);
        return new Response(body, {
          headers: { "content-length": String(body.length) },
        });
      }

      if (path === "/small-body") {
        return new Response("hello");
      }

      // --- Redirect with no location ---

      if (path === "/redirect-no-location") {
        return new Response("no location header", { status: 302 });
      }

      // --- Redirect chain exceeding limit ---

      if (path === "/redirect-loop") {
        return new Response(null, {
          status: 302,
          headers: { location: "/redirect-loop" },
        });
      }

      // --- RFC 7231 method downgrade ---

      if (path === "/redirect-303") {
        return new Response(null, {
          status: 303,
          headers: { location: "/check-method" },
        });
      }

      if (path === "/check-method") {
        return new Response(req.method);
      }

      // --- Redirect body consumption ---

      if (path === "/redirect-with-body") {
        return new Response("redirect body content", {
          status: 302,
          headers: { location: "/final" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  serverPort = server.port!;
}

// Start a second server on a different port to test cross-origin redirects.
let crossOriginPort = 0;
let crossOriginServer: ReturnType<typeof Bun.serve>;

function startCrossOriginServer() {
  crossOriginServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const h: Record<string, string> = {};
      req.headers.forEach((value, key) => { h[key] = value; });
      receivedHeaders[`cross:${url.pathname}`] = h;
      return new Response("cross-origin destination");
    },
  });
  crossOriginPort = crossOriginServer.port!;
}

startTestServer();
startCrossOriginServer();

afterAll(() => {
  server.stop(true);
  crossOriginServer.stop(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("http client — redirect header stripping", () => {
  test("preserves auth headers on same-origin redirect", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://localhost:${serverPort}/redirect-same-origin`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("final destination");
    // Auth header should reach /final since it's same origin.
    expect(receivedHeaders["/final"]!["authorization"]).toBe("Bearer secret-token");
  });

  test("strips auth headers on cross-origin redirect", async () => {
    // Set up the main server to redirect to the cross-origin server.
    const mainServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/cross-redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: `http://localhost:${crossOriginPort}/target` },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const client = createHttpClient();
      const res = await client.get(`http://localhost:${mainServer.port}/cross-redirect`, {
        headers: {
          authorization: "Bearer secret-token",
          cookie: "session=abc123",
          "proxy-authorization": "Basic xyz",
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("cross-origin destination");

      // Auth headers should NOT reach the cross-origin target.
      const targetHeaders = receivedHeaders["cross:/target"]!;
      expect(targetHeaders["authorization"]).toBeUndefined();
      expect(targetHeaders["cookie"]).toBeUndefined();
      expect(targetHeaders["proxy-authorization"]).toBeUndefined();
      // Non-sensitive headers should still be present.
      expect(targetHeaders["user-agent"]).toBeDefined();
    } finally {
      mainServer.stop(true);
    }
  });
});

describe("http client — maxBodyBytes", () => {
  test("returns full body when under limit", async () => {
    const client = createHttpClient({ maxBodyBytes: 1024 });
    const res = await client.get(`http://localhost:${serverPort}/small-body`);
    expect(res.body).toBe("hello");
    expect(res.body).not.toContain("[truncated");
  });

  test("truncates body when exceeding limit", async () => {
    const client = createHttpClient({ maxBodyBytes: 1024 });
    const res = await client.get(`http://localhost:${serverPort}/large-body`);
    // Should be truncated to ~1024 bytes + truncation marker.
    expect(res.body.length).toBeLessThan(100 * 1024);
    expect(res.body).toContain("[truncated at 1024 bytes");
  });

  test("includes content-length in truncation marker when available", async () => {
    const client = createHttpClient({ maxBodyBytes: 512 });
    const res = await client.get(`http://localhost:${serverPort}/large-body`);
    expect(res.body).toContain("total size:");
  });

  test("uses 5MB default when not specified", async () => {
    // 100KB body should be well under the 5MB default.
    const client = createHttpClient();
    const res = await client.get(`http://localhost:${serverPort}/large-body`);
    expect(res.body).not.toContain("[truncated");
    expect(res.body.length).toBe(100 * 1024);
  });
});

describe("http client — maxBodyBytes UTF-8 safety", () => {
  test("does not split multi-byte UTF-8 characters at truncation boundary", async () => {
    // Serve a body with emoji (4-byte UTF-8 sequences).
    const emojiServer = Bun.serve({
      port: 0,
      fetch() {
        // Each emoji is 4 bytes. 10 emoji = 40 bytes.
        return new Response("🎉🎊🎈🎁🎂🎃🎄🎅🎆🎇");
      },
    });

    try {
      // Set cap at 18 bytes — mid-way through the 5th emoji (byte 16-19).
      // Should back off to byte 16 (end of 4th emoji), not split the 5th.
      const client = createHttpClient({ maxBodyBytes: 18 });
      const res = await client.get(`http://localhost:${emojiServer.port!}/`);
      // Should not contain U+FFFD (replacement character).
      expect(res.body).not.toContain("\uFFFD");
      // Should contain exactly 4 emoji (16 bytes fits, 5th doesn't).
      expect(res.body).toContain("🎉🎊🎈🎁");
      expect(res.body).toContain("[truncated");
    } finally {
      emojiServer.stop(true);
    }
  });
});

describe("http client — redirect behavior", () => {
  test("follows same-origin redirect", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://localhost:${serverPort}/redirect-same-origin`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("final destination");
    expect(res.finalUrl).toContain("/final");
  });

  test("handles redirect without location header", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://localhost:${serverPort}/redirect-no-location`);
    expect(res.status).toBe(302);
    expect(res.body).toBe("no location header");
  });

  test("throws on redirect limit exceeded", async () => {
    const client = createHttpClient({ maxRedirects: 3 });
    expect(
      client.get(`http://localhost:${serverPort}/redirect-loop`),
    ).rejects.toThrow("exceeded redirect limit");
  });

  test("downgrades POST to GET on 303 redirect", async () => {
    const client = createHttpClient();
    const res = await client.post(`http://localhost:${serverPort}/redirect-303`, {
      body: "post-data",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("GET");
  });
});

describe("http client — timeout", () => {
  test("aborts on timeout", async () => {
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(5000);
        return new Response("too late");
      },
    });

    try {
      const client = createHttpClient({ timeoutMs: 200 });
      expect(
        client.get(`http://localhost:${slowServer.port}/`),
      ).rejects.toThrow();
    } finally {
      slowServer.stop(true);
    }
  });
});

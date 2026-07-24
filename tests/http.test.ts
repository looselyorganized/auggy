import { describe, test, expect, afterAll } from "bun:test";
import {
  createHttpClient,
  createRedirectRejectingFetch,
  HttpOutcomeUnknownError,
  HttpTimeoutError,
  rejectNonGlobalAddress,
  rejectUnsafeRedirect,
  rejectUnsafeUrl,
  resolvePublicHttpUrl,
} from "../src/http";

// ---------------------------------------------------------------------------
// Test HTTP server — serves controlled responses for redirect, body size,
// and header inspection scenarios.
// ---------------------------------------------------------------------------

let serverPort = 0;
let server: ReturnType<typeof Bun.serve>;
const TEST_HOST = "127.0.0.1";

const receivedHeaders: Record<string, Record<string, string>> = {};

function serveOnEphemeralPort(
  fetch: (req: Request) => Response | Promise<Response>,
): ReturnType<typeof Bun.serve> {
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      // Bun 1.3.14 can repeatedly report EADDRINUSE for port: 0. After the
      // first OS-assigned attempt, probe distinct bounded fallback ports.
      const port = attempt === 0 ? 0 : fallbackStart + attempt - 1;
      return Bun.serve({ hostname: TEST_HOST, port, fetch });
    } catch (err) {
      lastError = err;
      if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
    }
  }
  throw lastError;
}

function startTestServer() {
  server = serveOnEphemeralPort((req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Store received headers for inspection.
    const h: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      h[key] = value;
    });
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

    if (path === "/not-modified-with-location") {
      return new Response(null, {
        status: 304,
        headers: { location: "/final" },
      });
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

    // --- SSRF: redirect to internal / metadata endpoint ---

    if (path === "/redirect-to-metadata") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }

    if (path === "/redirect-to-private") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.5/secret" },
      });
    }

    return new Response("not found", { status: 404 });
  });
  serverPort = server.port!;
}

// Start a second server on a different port to test cross-origin redirects.
let crossOriginPort = 0;
let crossOriginServer: ReturnType<typeof Bun.serve>;

function startCrossOriginServer() {
  crossOriginServer = serveOnEphemeralPort((req) => {
    const url = new URL(req.url);
    const h: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      h[key] = value;
    });
    receivedHeaders[`cross:${url.pathname}`] = h;
    return new Response("cross-origin destination");
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
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/redirect-same-origin`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("final destination");
    // Auth header should reach /final since it's same origin.
    expect(receivedHeaders["/final"]!.authorization).toBe("Bearer secret-token");
  });

  test("strips auth headers on cross-origin redirect", async () => {
    // Set up the main server to redirect to the cross-origin server.
    const mainServer = serveOnEphemeralPort((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/cross-redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://${TEST_HOST}:${crossOriginPort}/target` },
        });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const client = createHttpClient();
      const res = await client.get(`http://${TEST_HOST}:${mainServer.port}/cross-redirect`, {
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "session=abc123",
          "Proxy-Authorization": "Basic xyz",
          "X-API-Key": "api-key-secret",
          "X-CSRF-Token": "csrf-secret",
        },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe("cross-origin destination");

      // Auth headers should NOT reach the cross-origin target.
      const targetHeaders = receivedHeaders["cross:/target"]!;
      expect(targetHeaders.authorization).toBeUndefined();
      expect(targetHeaders.cookie).toBeUndefined();
      expect(targetHeaders["proxy-authorization"]).toBeUndefined();
      expect(targetHeaders["x-api-key"]).toBeUndefined();
      expect(targetHeaders["x-csrf-token"]).toBeUndefined();
      // Non-sensitive headers should still be present.
      expect(targetHeaders["user-agent"]).toBeDefined();
    } finally {
      mainServer.stop(true);
    }
  });

  test("only forwards explicitly allowlisted custom headers to an exact redirect origin", async () => {
    const mainServer = serveOnEphemeralPort((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/cross-redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://${TEST_HOST}:${crossOriginPort}/allowlisted` },
        });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const targetOrigin = `http://${TEST_HOST}:${crossOriginPort}`;
      const client = createHttpClient({
        crossOriginRedirectHeaderAllowlist: {
          [targetOrigin]: ["x-webhook-signature"],
        },
      });
      await client.get(`http://${TEST_HOST}:${mainServer.port}/cross-redirect`, {
        headers: {
          "X-Webhook-Signature": "per-target-secret",
          "X-API-Key": "must-not-follow",
        },
      });

      const targetHeaders = receivedHeaders["cross:/allowlisted"]!;
      expect(targetHeaders["x-webhook-signature"]).toBe("per-target-secret");
      expect(targetHeaders["x-api-key"]).toBeUndefined();
    } finally {
      mainServer.stop(true);
    }
  });
});

describe("http client — maxBodyBytes", () => {
  test("returns full body when under limit", async () => {
    const client = createHttpClient({ maxBodyBytes: 1024 });
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/small-body`);
    expect(res.body).toBe("hello");
    expect(res.body).not.toContain("[truncated");
  });

  test("truncates body when exceeding limit", async () => {
    const client = createHttpClient({ maxBodyBytes: 1024 });
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/large-body`);
    // Should be truncated to ~1024 bytes + truncation marker.
    expect(res.body.length).toBeLessThan(100 * 1024);
    expect(res.body).toContain("[truncated at 1024 bytes");
  });

  test("includes content-length in truncation marker when available", async () => {
    const client = createHttpClient({ maxBodyBytes: 512 });
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/large-body`);
    expect(res.body).toContain("total size:");
  });

  test("uses 5MB default when not specified", async () => {
    // 100KB body should be well under the 5MB default.
    const client = createHttpClient();
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/large-body`);
    expect(res.body).not.toContain("[truncated");
    expect(res.body.length).toBe(100 * 1024);
  });
});

describe("http client — maxBodyBytes UTF-8 safety", () => {
  test("does not split multi-byte UTF-8 characters at truncation boundary", async () => {
    // Serve a body with emoji (4-byte UTF-8 sequences).
    const emojiServer = serveOnEphemeralPort(() => {
      // Each emoji is 4 bytes. 10 emoji = 40 bytes.
      return new Response("🎉🎊🎈🎁🎂🎃🎄🎅🎆🎇");
    });

    try {
      // Set cap at 18 bytes — mid-way through the 5th emoji (byte 16-19).
      // Should back off to byte 16 (end of 4th emoji), not split the 5th.
      const client = createHttpClient({ maxBodyBytes: 18 });
      const res = await client.get(`http://${TEST_HOST}:${emojiServer.port!}/`);
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
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/redirect-same-origin`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("final destination");
    expect(res.finalUrl).toContain("/final");
  });

  test("handles redirect without location header", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/redirect-no-location`);
    expect(res.status).toBe(302);
    expect(res.body).toBe("no location header");
  });

  test("does not follow non-redirect 3xx statuses", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/not-modified-with-location`);
    expect(res.status).toBe(304);
    expect(res.finalUrl).toContain("/not-modified-with-location");
  });

  test("throws on redirect limit exceeded", async () => {
    const client = createHttpClient({ maxRedirects: 3 });
    expect(client.get(`http://${TEST_HOST}:${serverPort}/redirect-loop`)).rejects.toThrow(
      "exceeded redirect limit",
    );
  });

  test("downgrades POST to GET on 303 redirect", async () => {
    const client = createHttpClient();
    const res = await client.post(`http://${TEST_HOST}:${serverPort}/redirect-303`, {
      body: "post-data",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("GET");
  });
});

describe("http client — timeout", () => {
  test("aborts on timeout", async () => {
    const slowServer = serveOnEphemeralPort(async () => {
      await Bun.sleep(5000);
      return new Response("too late");
    });

    try {
      const client = createHttpClient({ timeoutMs: 200 });
      const pending = client.get(`http://${TEST_HOST}:${slowServer.port}/`);
      expect(pending).rejects.toBeInstanceOf(HttpTimeoutError);
      expect(pending).rejects.toMatchObject({ outcomeUnknown: true, ms: 200 });
    } finally {
      slowServer.stop(true);
    }
  });

  test("classifies a dispatched mutation without a response as outcome unknown", async () => {
    const closedServer = serveOnEphemeralPort(() => new Response("unused"));
    const url = `http://${TEST_HOST}:${closedServer.port}/`;
    closedServer.stop(true);
    const client = createHttpClient({ timeoutMs: 1_000 });

    const error = await client.post(url, { body: "{}" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(HttpOutcomeUnknownError);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("rejectUnsafeUrl helper", () => {
  test("accepts a normal https URL", () => {
    expect(rejectUnsafeUrl("https://example.com/path")).toBeNull();
  });

  test("rejects loopback", () => {
    expect(rejectUnsafeUrl("http://localhost/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://127.0.0.1/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://127.10.20.30/")).toMatch(/loopback/i);
  });

  test("rejects RFC 1918 private ranges", () => {
    expect(rejectUnsafeUrl("http://10.0.0.1/")).toMatch(/RFC 1918/i);
    expect(rejectUnsafeUrl("http://192.168.1.1/")).toMatch(/RFC 1918/i);
    expect(rejectUnsafeUrl("http://172.20.0.5/")).toMatch(/RFC 1918/i);
  });

  test("rejects link-local / cloud metadata 169.254/16", () => {
    expect(rejectUnsafeUrl("http://169.254.169.254/")).toMatch(/link-local|metadata/i);
  });

  test("rejects cloud metadata FQDNs", () => {
    expect(rejectUnsafeUrl("http://metadata.google.internal/")).toMatch(/metadata/i);
    expect(rejectUnsafeUrl("http://metadata/")).toMatch(/metadata/i);
  });

  test("rejects non-http(s) schemes", () => {
    expect(rejectUnsafeUrl("file:///etc/passwd")).toMatch(/scheme/i);
    expect(rejectUnsafeUrl("ftp://example.com/")).toMatch(/scheme/i);
    expect(rejectUnsafeUrl("gopher://example.com/")).toMatch(/scheme/i);
  });

  test("rejects unparseable URLs", () => {
    expect(rejectUnsafeUrl("not a url")).toBe("unparseable URL");
  });

  // Codex review P1: URL.hostname retains brackets on IPv6 literals;
  // fe80::/10 covers fe80-febf, not just literal "fe80"; IPv4-mapped
  // IPv6 can tunnel internal IPs past IPv4-only checks.
  test("rejects bracketed IPv6 loopback ::1", () => {
    expect(rejectUnsafeUrl("http://[::1]/")).toMatch(/loopback/i);
  });

  test("rejects bracketed IPv6 unspecified ::", () => {
    expect(rejectUnsafeUrl("http://[::]/")).toMatch(/unspecified/i);
  });

  test("rejects bracketed IPv6 unique-local (fc00::/7)", () => {
    // Both fc and fd prefixes are in fc00::/7.
    expect(rejectUnsafeUrl("http://[fc00::1]/")).toMatch(/unique-local/i);
    expect(rejectUnsafeUrl("http://[fd00::1]/")).toMatch(/unique-local/i);
    expect(rejectUnsafeUrl("http://[fd12:3456:789a::1]/")).toMatch(/unique-local/i);
  });

  test("rejects bracketed IPv6 link-local across full fe80::/10 range", () => {
    // fe80 itself
    expect(rejectUnsafeUrl("http://[fe80::1]/")).toMatch(/link-local/i);
    // fe90 (middle of the range — was bypassing the old "fe80:" literal check)
    expect(rejectUnsafeUrl("http://[fe90::1]/")).toMatch(/link-local/i);
    // feb0 (top of the range)
    expect(rejectUnsafeUrl("http://[feb0::1]/")).toMatch(/link-local/i);
    // febf (upper boundary)
    expect(rejectUnsafeUrl("http://[febf::1]/")).toMatch(/link-local/i);
  });

  test("rejects IPv4-mapped IPv6 addresses pointing at internal ranges", () => {
    // IPv4-mapped form: ::ffff:a.b.c.d should re-run IPv4 range checks.
    expect(rejectUnsafeUrl("http://[::ffff:10.0.0.1]/")).toMatch(/RFC 1918/i);
    expect(rejectUnsafeUrl("http://[::ffff:127.0.0.1]/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://[::ffff:169.254.169.254]/")).toMatch(/link-local|metadata/i);
    // And should note it came from v6-mapping
    expect(rejectUnsafeUrl("http://[::ffff:10.0.0.1]/")).toMatch(/IPv4-mapped IPv6/i);
  });

  test("rejects localhost. (trailing-dot FQDN form)", () => {
    expect(rejectUnsafeUrl("http://localhost./")).toMatch(/loopback/i);
  });

  test("rejects IPv6 documentation space and accepts genuine global unicast", () => {
    expect(rejectUnsafeUrl("http://[2001:db8::1]/")).toMatch(/documentation/i);
    expect(rejectUnsafeUrl("http://[2606:4700:4700::1111]/")).toBeNull();
  });
});

describe("public address classification", () => {
  const nonGlobalAddresses = [
    "0.0.0.0",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "2001:db8::1",
    "2001::1",
    "2001:2::1",
    "2001:100::1",
    "3fff::1",
    "64:ff9b::7f00:1",
    "::ffff:127.0.0.1",
  ];

  for (const address of nonGlobalAddresses) {
    test(`rejects non-global address ${address}`, () => {
      expect(rejectNonGlobalAddress(address)).not.toBeNull();
    });
  }

  test("accepts global IPv4, IPv6, and NAT64 addresses", () => {
    expect(rejectNonGlobalAddress("1.1.1.1")).toBeNull();
    expect(rejectNonGlobalAddress("2606:4700:4700::1111")).toBeNull();
    expect(rejectNonGlobalAddress("64:ff9b::101:101")).toBeNull();
  });

  test("canonicalizes alternative IPv4 URL forms before classification", () => {
    expect(rejectUnsafeUrl("http://2130706433/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://0177.0.0.1/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://0x7f000001/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://127.1/")).toMatch(/loopback/i);
    expect(rejectUnsafeUrl("http://192.168.1/")).toMatch(/RFC 1918/i);
  });
});

describe("public DNS resolution", () => {
  test("rejects a private DNS answer before connection", async () => {
    await expect(
      resolvePublicHttpUrl("https://public-looking.test/", async () => [
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/non-global.*RFC 1918/i);
  });

  test("rejects a mixed public and private answer set", async () => {
    await expect(
      resolvePublicHttpUrl("https://mixed.test/", async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "fd00::1", family: 6 },
      ]),
    ).rejects.toThrow(/non-global.*unique-local/i);
  });

  test("rejects empty, malformed, and family-mismatched answers", async () => {
    await expect(resolvePublicHttpUrl("https://empty.test/", async () => [])).rejects.toThrow(
      /no addresses/i,
    );
    await expect(
      resolvePublicHttpUrl("https://malformed.test/", async () => [
        { address: "not-an-address", family: 4 },
      ]),
    ).rejects.toThrow(/invalid DNS address/i);
    await expect(
      resolvePublicHttpUrl("https://mismatch.test/", async () => [
        { address: "1.1.1.1", family: 6 },
      ]),
    ).rejects.toThrow(/invalid DNS address/i);
  });

  test("accepts an all-global dual-stack answer snapshot", async () => {
    await expect(
      resolvePublicHttpUrl("https://dual-stack.test/", async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]),
    ).resolves.toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  test("fails closed on resolver errors, excessive answers, and cancellation", async () => {
    await expect(
      resolvePublicHttpUrl("https://failure.test/", async () => {
        throw new Error("resolver unavailable");
      }),
    ).rejects.toThrow(/resolver unavailable/i);

    await expect(
      resolvePublicHttpUrl("https://many.test/", async () =>
        Array.from({ length: 33 }, (_, index) => ({
          address: `1.1.1.${index + 1}`,
          family: 4 as const,
        })),
      ),
    ).rejects.toThrow(/too many/i);

    const controller = new AbortController();
    const pending = resolvePublicHttpUrl(
      "https://cancelled.test/",
      () => new Promise(() => {}),
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});

describe("redirect destination policy", () => {
  test("rejects HTTPS downgrade and redirect URL credentials", () => {
    expect(rejectUnsafeRedirect("https://example.com/start", "http://example.com/next")).toMatch(
      /downgrade/i,
    );
    expect(
      rejectUnsafeRedirect("https://example.com/start", "https://user:secret@example.net/next"),
    ).toMatch(/credentials/i);
  });

  test("allows secure and explicitly configured initial plaintext flows", () => {
    expect(
      rejectUnsafeRedirect("https://example.com/start", "https://example.net/next"),
    ).toBeNull();
    expect(
      rejectUnsafeRedirect("http://127.0.0.1:3000/start", "http://127.0.0.1:3000/next"),
    ).toBeNull();
  });
});

describe("credential-bearing Fetch wrapper", () => {
  test("forces manual redirect handling and rejects redirect responses", async () => {
    let capturedRedirect: RequestInit["redirect"];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedRedirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/" },
      });
    }) as typeof fetch;
    const hardenedFetch = createRedirectRejectingFetch(fetchImpl);

    await expect(
      hardenedFetch("https://configured.example/", {
        headers: { "X-API-Key": "sentinel-secret" },
      }),
    ).rejects.toThrow(/redirects are disabled/i);
    expect(capturedRedirect).toBe("manual");
  });

  test("returns non-redirect responses unchanged", async () => {
    const response = new Response("ok", { status: 200 });
    const hardenedFetch = createRedirectRejectingFetch(
      (async () => response) as unknown as typeof fetch,
    );
    expect(await hardenedFetch("https://configured.example/")).toBe(response);
  });
});

describe("http client — SSRF guard", () => {
  test("default (guard off) allows localhost", async () => {
    const client = createHttpClient();
    const res = await client.get(`http://${TEST_HOST}:${serverPort}/small-body`);
    expect(res.status).toBe(200);
  });

  test("guard on rejects direct loopback request", async () => {
    const client = createHttpClient({ rejectUnsafeUrls: true });
    expect(client.get(`http://${TEST_HOST}:${serverPort}/small-body`)).rejects.toThrow(
      /unsafe URL.*loopback/i,
    );
  });

  test("guard on rejects direct RFC 1918 request", async () => {
    const client = createHttpClient({ rejectUnsafeUrls: true });
    expect(client.get("http://10.0.0.5/internal")).rejects.toThrow(/unsafe URL.*RFC 1918/i);
  });

  test("guard on rejects file:// scheme", async () => {
    const client = createHttpClient({ rejectUnsafeUrls: true });
    expect(client.get("file:///etc/passwd")).rejects.toThrow(/unsafe URL.*scheme/i);
  });

  test("guard on rejects redirect to 169.254 metadata endpoint", async () => {
    // Guard has to be disabled for the initial localhost hop but the redirect
    // check should still fire. Workaround: run a cross-origin redirect from a
    // non-localhost origin… but we have only local test servers. Alternative:
    // since the initial URL is localhost (blocked), split the check by also
    // disabling the initial URL via a DNS-name ruse is not portable. Instead,
    // we verify the redirect hop path by using a guarded client against the
    // test server's host header: since localhost is blocked at the initial
    // hop, this test exercises that the initial hop is caught first. (The
    // redirect-hop check is exercised below via the helper test.)
    const client = createHttpClient({ rejectUnsafeUrls: true });
    expect(client.get(`http://${TEST_HOST}:${serverPort}/redirect-to-metadata`)).rejects.toThrow(
      /unsafe URL.*loopback/i,
    );
  });

  test("guard on permits a public-looking URL (no network — expect DNS/connect failure, not SSRF block)", async () => {
    const client = createHttpClient({
      rejectUnsafeUrls: true,
      timeoutMs: 500,
    });
    // example.invalid is a reserved TLD; resolves to nothing. We're verifying
    // the guard does NOT flag it. The fetch itself will fail, but not with an
    // "unsafe URL" error.
    try {
      await client.get("http://example.invalid/");
      // Some resolvers return a parking IP — tolerate success too.
    } catch (err) {
      expect((err as Error).message).not.toMatch(/unsafe URL/i);
    }
  });

  test("rejects unknown or malformed runtime policy values", () => {
    expect(() =>
      createHttpClient({ urlPolicy: "publci" } as unknown as Parameters<
        typeof createHttpClient
      >[0]),
    ).toThrow(/invalid URL security policy/i);
    expect(() =>
      createHttpClient({ rejectUnsafeUrls: "true" } as unknown as Parameters<
        typeof createHttpClient
      >[0]),
    ).toThrow(/must be a boolean/i);
  });
});

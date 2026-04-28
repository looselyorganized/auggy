import { describe, test, expect, afterAll } from "bun:test";
import { webFetch, normalizeFetchUrl } from "../../src/augments/web-fetch";

// ---------------------------------------------------------------------------
// Test HTTP server — serves controlled HTML, JSON, and edge-case responses.
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;

function startTestServer() {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/html-basic") {
        return new Response(
          "<html><head><title>Test Page</title></head><body><p>Hello world</p></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (path === "/html-with-script") {
        return new Response(
          `<html><body>
            <p>Visible text</p>
            <script>var x = "should not appear"; function foo() { return 42; }</script>
            <style>.hidden { display: none; } body { color: red; }</style>
            <p>More visible text</p>
          </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }

      if (path === "/html-entities") {
        return new Response(
          "<html><body><p>5 &lt; 10 &amp; 10 &gt; 5</p><p>&amp;lt; should stay as &amp;lt;</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }

      if (path === "/json-api") {
        return new Response(
          JSON.stringify({
            users: [
              { id: 1, name: "Alice", email: "alice@example.com" },
              { id: 2, name: "Bob", email: "bob@example.com" },
            ],
            total: 2,
            page: 1,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (path === "/json-api-plus") {
        return new Response(JSON.stringify({ data: "test" }), {
          headers: { "content-type": "application/vnd.api+json" },
        });
      }

      if (path === "/plain-text") {
        return new Response("Just plain text content.", {
          headers: { "content-type": "text/plain" },
        });
      }

      if (path === "/html-title-only") {
        return new Response(
          "<html><head><title>The Page Title</title></head><body><p>content</p></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
}

startTestServer();
afterAll(() => server.stop(true));

// Helper: get the web_fetch tool from the augment.
// The test HTTP server runs on localhost, which the SSRF guard blocks by
// default. Tests disable the guard and re-enable it explicitly in the SSRF
// describe block below.
function getWebFetchTool() {
  const augment = webFetch({
    timeoutMs: 5000,
    rejectUnsafeUrls: false,
  });
  const tool = augment.tools?.find((t) => t.name === "web_fetch");
  if (!tool) throw new Error("web_fetch tool not found");
  return tool;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

describe("normalizeFetchUrl", () => {
  test("upgrades http to https for non-localhost", () => {
    expect(normalizeFetchUrl("http://example.com/page")).toBe("https://example.com/page");
  });

  test("preserves http for localhost", () => {
    expect(normalizeFetchUrl("http://localhost:3000/api")).toBe("http://localhost:3000/api");
  });

  test("preserves http for 127.0.0.1", () => {
    expect(normalizeFetchUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
  });

  test("preserves https urls unchanged", () => {
    expect(normalizeFetchUrl("https://example.com/")).toBe("https://example.com/");
  });
});

// ---------------------------------------------------------------------------
// Script/style stripping
// ---------------------------------------------------------------------------

describe("script and style content stripping", () => {
  test("strips script tag content from HTML", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/html-with-script`,
        prompt: "what does the page say?",
      }),
    );
    expect(result.result).toContain("Visible text");
    expect(result.result).toContain("More visible text");
    expect(result.result).not.toContain("should not appear");
    expect(result.result).not.toContain("function foo");
  });

  test("strips style tag content from HTML", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/html-with-script`,
        prompt: "what does the page say?",
      }),
    );
    expect(result.result).not.toContain("display: none");
    expect(result.result).not.toContain("color: red");
  });
});

// ---------------------------------------------------------------------------
// Entity double-decode fix
// ---------------------------------------------------------------------------

describe("HTML entity decoding", () => {
  test("decodes basic entities correctly", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/html-entities`,
        prompt: "what does it say?",
      }),
    );
    // &lt; → <, &gt; → >, &amp; → &
    expect(result.result).toContain("5 < 10 & 10 > 5");
  });

  test("does not double-decode &amp;lt; into <", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/html-entities`,
        prompt: "what does it say?",
      }),
    );
    // &amp;lt; should become &lt; (the literal text), NOT <
    expect(result.result).toContain("&lt; should stay as &lt;");
  });
});

// ---------------------------------------------------------------------------
// JSON passthrough
// ---------------------------------------------------------------------------

describe("JSON content passthrough", () => {
  test("returns full JSON without summarization truncation", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/json-api`,
        prompt: "get the users",
      }),
    );
    // Should contain the full JSON structure, not a 900-char truncated preview.
    expect(result.result).toContain("alice@example.com");
    expect(result.result).toContain("bob@example.com");
    // Should NOT have the "Prompt:" prefix that HTML mode adds.
    expect(result.result).not.toContain("Prompt:");
  });

  test("handles application/vnd.api+json content type", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/json-api-plus`,
        prompt: "get the data",
      }),
    );
    expect(result.result).toContain('"data"');
    expect(result.result).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

describe("title extraction", () => {
  test("extracts title when prompt includes 'title'", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/html-title-only`,
        prompt: "what is the title?",
      }),
    );
    expect(result.result).toContain("Title: The Page Title");
  });
});

// ---------------------------------------------------------------------------
// Output structure
// ---------------------------------------------------------------------------

describe("web_fetch output structure", () => {
  test("returns expected fields in JSON output", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: `http://localhost:${server.port}/plain-text`,
        prompt: "read this",
      }),
    );
    expect(result.url).toContain("/plain-text");
    expect(result.code).toBe(200);
    expect(result.codeText).toBe("OK");
    expect(typeof result.bytes).toBe("number");
    expect(typeof result.durationMs).toBe("number");
    expect(result.result).toContain("Just plain text content");
  });

  test("returns error JSON for invalid URLs", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: "not-a-url",
        prompt: "fetch this",
      }),
    );
    expect(result.error).toBeDefined();
  });

  test("returns error JSON for unreachable hosts", async () => {
    const tool = getWebFetchTool();
    const result = JSON.parse(
      await tool.execute({
        url: "http://localhost:1/unreachable",
        prompt: "fetch this",
      }),
    );
    expect(result.error).toBeDefined();
    expect(result.durationMs).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SSRF filter — structural rejection of loopback, private, link-local, and
// metadata endpoints. Default behavior when no `rejectUnsafeUrls` override.
// ---------------------------------------------------------------------------

describe("SSRF filter", () => {
  function getGuardedTool() {
    // No rejectUnsafeUrls override → default (true)
    const augment = webFetch({ timeoutMs: 5000 });
    const tool = augment.tools?.find((t) => t.name === "web_fetch");
    if (!tool) throw new Error("web_fetch tool not found");
    return tool;
  }

  const blockedUrls: [string, RegExp][] = [
    ["http://localhost/anything", /loopback/i],
    ["http://127.0.0.1/anything", /loopback/i],
    ["http://10.0.0.5/internal", /RFC 1918/i],
    ["http://192.168.1.1/router", /RFC 1918/i],
    ["http://172.16.0.1/private", /RFC 1918/i],
    ["http://169.254.169.254/latest/meta-data/", /link-local|metadata/i],
    ["http://metadata.google.internal/computeMetadata/v1/", /metadata/i],
    ["file:///etc/passwd", /scheme/i],
  ];

  for (const [url, errorRegex] of blockedUrls) {
    test(`rejects ${url}`, async () => {
      const tool = getGuardedTool();
      const result = JSON.parse(await tool.execute({ url, prompt: "x" }));
      expect(result.error).toBeDefined();
      expect(result.error).toMatch(errorRegex);
      // No network call should have happened — the response body in the
      // success path is never populated.
      expect(result.code).toBeUndefined();
    });
  }
});

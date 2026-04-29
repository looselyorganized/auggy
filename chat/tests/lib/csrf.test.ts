import { describe, it, expect } from "bun:test";
import { isLoopbackOrigin, validateCsrf } from "../../src/lib/csrf";

describe("isLoopbackOrigin", () => {
  it("accepts http://localhost:8090", () => {
    expect(isLoopbackOrigin("http://localhost:8090", 8090)).toBe(true);
  });
  it("accepts http://127.0.0.1:8090", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:8090", 8090)).toBe(true);
  });
  it("rejects mismatched port", () => {
    expect(isLoopbackOrigin("http://localhost:9000", 8090)).toBe(false);
  });
  it("rejects https scheme", () => {
    expect(isLoopbackOrigin("https://localhost:8090", 8090)).toBe(false);
  });
  it("rejects external host", () => {
    expect(isLoopbackOrigin("http://evil.example.com", 8090)).toBe(false);
  });
  it("rejects empty/null", () => {
    expect(isLoopbackOrigin("", 8090)).toBe(false);
    expect(isLoopbackOrigin(null, 8090)).toBe(false);
  });
});

function makeRequest(opts: {
  method?: string;
  origin?: string | null;
  contentType?: string | null;
}): Request {
  const headers = new Headers();
  if (opts.origin !== null && opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.contentType !== null && opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  return new Request("http://localhost:8090/api/chat/zip", {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "POST" ? "{}" : undefined,
  });
}

describe("validateCsrf", () => {
  it("accepts POST with same-origin loopback Origin + JSON content-type", () => {
    const req = makeRequest({ origin: "http://localhost:8090", contentType: "application/json" });
    expect(validateCsrf(req, 8090)).toEqual({ ok: true });
  });

  it("rejects POST with missing Origin", () => {
    const req = makeRequest({ origin: null, contentType: "application/json" });
    const res = validateCsrf(req, 8090);
    expect(res.ok).toBe(false);
  });

  it("rejects POST with cross-origin Origin", () => {
    const req = makeRequest({ origin: "http://evil.example.com", contentType: "application/json" });
    const res = validateCsrf(req, 8090);
    expect(res.ok).toBe(false);
  });

  it("rejects POST with non-JSON content-type", () => {
    const req = makeRequest({ origin: "http://localhost:8090", contentType: "text/plain" });
    const res = validateCsrf(req, 8090);
    expect(res.ok).toBe(false);
  });

  it("rejects POST with missing content-type", () => {
    const req = makeRequest({ origin: "http://localhost:8090", contentType: null });
    const res = validateCsrf(req, 8090);
    expect(res.ok).toBe(false);
  });

  it("accepts GET requests when Origin is loopback", () => {
    const req = makeRequest({ method: "GET", origin: "http://localhost:8090" });
    expect(validateCsrf(req, 8090)).toEqual({ ok: true });
  });

  it("rejects GET requests with cross-origin Origin", () => {
    const req = makeRequest({ method: "GET", origin: "http://evil.example.com" });
    const res = validateCsrf(req, 8090);
    expect(res.ok).toBe(false);
  });

  it("accepts GET requests with no Origin (browser address bar / curl)", () => {
    const req = makeRequest({ method: "GET", origin: null });
    expect(validateCsrf(req, 8090)).toEqual({ ok: true });
  });
});

import { describe, expect, it } from "bun:test";
import { checkAdminAuth } from "@/transports/admin/admin-auth";

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function makeReq(
  headers: Record<string, string>,
  url = "https://my-agent.fly.dev/console",
): Request {
  return new Request(url, { headers });
}

describe("admin-auth — HTTPS gate", () => {
  it("returns 426 when non-loopback caller uses http://", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://my-agent.fly.dev/console"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("https-required");
    if (result.kind === "https-required") {
      expect(result.response.status).toBe(426);
      expect(result.response.headers.get("upgrade")).toBe("TLS/1.2");
    }
  });

  it("allows non-loopback caller over https://", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "test-token") },
        "https://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("ok");
  });
});

describe("admin-auth — loopback bypass", () => {
  it("loopback caller is allowed without any Authorization header", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://127.0.0.1:8080/console"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("ok");
  });

  it("loopback caller is allowed even with a wrong bearer (bypass is unconditional)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "wrong-token") },
        "http://127.0.0.1:8080/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "127.0.0.1",
    });
    expect(result.kind).toBe("ok");
  });

  it("IPv6 loopback (::1) is also bypassed", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "http://[::1]:8080/console"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "::1",
    });
    expect(result.kind).toBe("ok");
  });
});

describe("admin-auth — HTTP Basic (non-loopback only)", () => {
  it("redirects browser GETs without Authorization to the console login screen", () => {
    const result = checkAdminAuth({
      req: makeReq({}, "https://my-agent.fly.dev/console"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      expect(result.response.status).toBe(303);
      expect(result.response.headers.get("location")).toBe("/console/login?next=%2Fconsole");
      expect(result.response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("returns 401 + WWW-Authenticate for API requests without Authorization", async () => {
    const result = checkAdminAuth({
      req: makeReq({}, "https://my-agent.fly.dev/console/api/dashboard"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("www-authenticate")).toBe(
        'Basic realm="auggy-admin zip (username auggy, password AUGGY_WEB_TOKEN)"',
      );
      const body = await result.response.text();
      expect(body).toBe(JSON.stringify({ error: "unauthorized" }));
    }
  });

  it("accepts empty-username basic auth (curl -u :token form)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "test-token") },
        "https://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("ok");
  });

  it("accepts non-empty-username basic auth (curl -u admin:token form)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("admin", "test-token") },
        "https://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("ok");
  });

  it("rejects wrong bearer with 401", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "wrong-token") },
        "https://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("unauthorized");
    if (result.kind === "unauthorized") {
      expect(result.response.status).toBe(401);
    }
  });

  it("rejects malformed Authorization header (non-Basic) with 401", () => {
    const result = checkAdminAuth({
      req: makeReq({ authorization: "Bearer test-token" }, "https://my-agent.fly.dev/console"),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("unauthorized");
  });

  it("rejects malformed base64 in Basic header with 401", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: "Basic not-valid-base64!@#" },
        "https://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("unauthorized");
  });

  it("HTTPS gate fires before loopback bypass + Basic check (non-loopback http with valid bearer still 426)", () => {
    const result = checkAdminAuth({
      req: makeReq(
        { authorization: basicHeader("", "test-token") },
        "http://my-agent.fly.dev/console",
      ),
      bearer: "test-token",
      agentName: "zip",
      callerIp: "10.0.0.5",
    });
    expect(result.kind).toBe("https-required");
  });
});

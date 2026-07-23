import { describe, expect, it } from "bun:test";
import {
  buildConsoleAllowedOrigins,
  compileTrustedProxyNetworks,
  evaluateConsoleRequest,
  resolveForwardedRequest,
} from "@/transports/console-request-security";

describe("console request security — trusted proxy networks", () => {
  it("supports exact IPv4/IPv6 addresses and bounded CIDRs", () => {
    const networks = compileTrustedProxyNetworks([
      "127.0.0.1",
      "10.20.0.0/16",
      "2001:db8:1234::/48",
    ]);
    expect(networks.matches("127.0.0.1")).toBe(true);
    expect(networks.matches("10.20.255.1")).toBe(true);
    expect(networks.matches("10.21.0.1")).toBe(false);
    expect(networks.matches("2001:db8:1234::99")).toBe(true);
    expect(networks.matches("2001:db8:1235::1")).toBe(false);
  });

  it("rejects malformed and universal proxy declarations", () => {
    for (const entry of ["proxy.example", "10.0.0.1/99", "0.0.0.0/0", "::/0", " 127.0.0.1"]) {
      expect(() => compileTrustedProxyNetworks([entry])).toThrow();
    }
  });

  it("never infers forwarding trust from deployment environment", () => {
    const forwarded = new Headers({
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
    });
    const result = resolveForwardedRequest({
      connectionIp: "10.0.0.9",
      headers: forwarded,
      trustedProxies: compileTrustedProxyNetworks([]),
    });
    expect(result).toMatchObject({
      proxyTrusted: false,
      callerIp: "10.0.0.9",
      forwardedHeadersPresent: true,
    });
    expect(result.forwardedProto).toBeUndefined();
  });

  it("walks a valid XFF chain right-to-left and rejects parser ambiguity", () => {
    const trustedProxies = compileTrustedProxyNetworks(["10.0.0.0/8"]);
    const result = resolveForwardedRequest({
      connectionIp: "10.0.0.9",
      headers: new Headers({
        "x-forwarded-for": "spoofed.invalid, 203.0.113.4, 10.0.0.8",
      }),
      trustedProxies,
    });
    expect(result.error).toContain("invalid");

    const valid = resolveForwardedRequest({
      connectionIp: "10.0.0.9",
      headers: new Headers({
        "x-forwarded-for": "198.51.100.7, 203.0.113.4, 10.0.0.8",
        "x-forwarded-proto": "https",
      }),
      trustedProxies,
    });
    expect(valid.callerIp).toBe("203.0.113.4");
    expect(valid.forwardedProto).toBe("https");

    const ambiguousProto = resolveForwardedRequest({
      connectionIp: "10.0.0.9",
      headers: new Headers({ "x-forwarded-proto": "https, http" }),
      trustedProxies,
    });
    expect(ambiguousProto.error).toContain("proto");
  });
});

describe("console request security — Host and Origin", () => {
  const allowedOrigins = buildConsoleAllowedOrigins(8080, ["https://agent.example"]);
  const direct = compileTrustedProxyNetworks([]);

  function evaluate(
    url: string,
    headers: Record<string, string>,
    method = "GET",
  ): ReturnType<typeof evaluateConsoleRequest> {
    return evaluateConsoleRequest({
      req: new Request(url, { method, headers }),
      connectionIp: "127.0.0.1",
      trustedProxies: direct,
      allowedOrigins,
    });
  }

  it("accepts exact configured public and local authorities", () => {
    expect(evaluate("http://127.0.0.1:8080/console", { host: "127.0.0.1:8080" }).ok).toBe(true);
    expect(evaluate("https://agent.example/console", { host: "AGENT.EXAMPLE" }).ok).toBe(true);
  });

  it("rejects attacker-controlled Host aliases and untrusted forwarding", () => {
    for (const host of [
      "localhost.evil:8080",
      "127.0.0.1.evil:8080",
      "agent.example.evil",
      "agent.example.",
      "agent.example,evil.example",
    ]) {
      expect(evaluate("http://127.0.0.1:8080/console", { host }).ok).toBe(false);
    }
    expect(
      evaluate("http://127.0.0.1:8080/console", {
        host: "127.0.0.1:8080",
        "x-forwarded-for": "127.0.0.1",
      }).ok,
    ).toBe(false);
  });

  it("requires exact same-origin browser mutations", () => {
    expect(
      evaluate(
        "https://agent.example/console/login",
        { host: "agent.example", origin: "https://agent.example" },
        "POST",
      ).ok,
    ).toBe(true);
    for (const origin of [
      "null",
      "http://agent.example",
      "https://evil.example",
      "https://agent.example, https://evil.example",
    ]) {
      expect(
        evaluate("https://agent.example/console/login", { host: "agent.example", origin }, "POST")
          .ok,
      ).toBe(false);
    }
    expect(
      evaluate("https://agent.example/console/login", { host: "agent.example" }, "POST").ok,
    ).toBe(false);
  });

  it("allows origin-less Basic-auth automation but rejects a supplied foreign Origin", () => {
    const authorization = `Basic ${Buffer.from(":token").toString("base64")}`;
    expect(
      evaluate(
        "https://agent.example/console/api/credentials/set",
        { host: "agent.example", authorization },
        "POST",
      ).ok,
    ).toBe(true);
    expect(
      evaluate(
        "https://agent.example/console/api/credentials/set",
        { host: "agent.example", authorization, origin: "https://evil.example" },
        "POST",
      ).ok,
    ).toBe(false);
  });
});

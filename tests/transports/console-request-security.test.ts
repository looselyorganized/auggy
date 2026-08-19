import { describe, expect, it } from "bun:test";
import {
  RAILWAY_INGRESS_PROXY_NETWORKS,
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

  // Headers and peer captured from a real Railway deployment on 2026-08-19:
  // the edge sets X-Forwarded-For "<client>, <edge>", X-Real-IP "<client>",
  // X-Forwarded-Host "<public domain>", X-Forwarded-Proto "https"; the
  // container's TCP peer is Railway's internal proxy (100.64.0.0/10). The edge
  // overwrites client-supplied values for all of those but passes
  // X-Forwarded-Port through unchanged.
  const railwayHeaders = {
    host: "hosted-production-400c.up.railway.app",
    "x-forwarded-for": "70.71.236.82, 152.233.40.2",
    "x-forwarded-host": "hosted-production-400c.up.railway.app",
    "x-forwarded-proto": "https",
    "x-real-ip": "70.71.236.82",
    "x-railway-edge": "ord1",
  };

  it("accepts Railway's forwarded header set from its ingress proxy network", () => {
    const result = resolveForwardedRequest({
      connectionIp: "::ffff:100.64.0.2",
      headers: new Headers(railwayHeaders),
      trustedProxies: compileTrustedProxyNetworks([...RAILWAY_INGRESS_PROXY_NETWORKS]),
    });
    expect(result.error).toBeUndefined();
    expect(result.proxyTrusted).toBe(true);
    // X-Real-IP names the client even though the XFF chain's last hop is the
    // public edge IP, which is not on the trusted list.
    expect(result.callerIp).toBe("70.71.236.82");
    expect(result.forwardedProto).toBe("https");
  });

  it("keeps a trusted-proxy X-Forwarded-Host honest and ignores X-Forwarded-Port", () => {
    const trustedProxies = compileTrustedProxyNetworks(["100.64.0.0/10"]);
    const mismatch = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({ ...railwayHeaders, "x-forwarded-host": "evil.example" }),
      trustedProxies,
    });
    expect(mismatch.error).toContain("forwarded host");

    const trailingDotAlias = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({
        ...railwayHeaders,
        "x-forwarded-host": "hosted-production-400c.up.railway.app.",
      }),
      trustedProxies,
    });
    expect(trailingDotAlias.error).toContain("forwarded host");

    const defaultPort = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({
        ...railwayHeaders,
        "x-forwarded-host": "hosted-production-400c.up.railway.app:443",
      }),
      trustedProxies,
    });
    expect(defaultPort.error).toBeUndefined();

    const spoofedPort = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({ ...railwayHeaders, "x-forwarded-port": "8443" }),
      trustedProxies,
    });
    expect(spoofedPort.error).toBeUndefined();
    expect(spoofedPort.callerIp).toBe("70.71.236.82");
  });

  it("rejects X-Real-IP that disagrees with the forwarded-for chain", () => {
    const trustedProxies = compileTrustedProxyNetworks(["100.64.0.0/10"]);
    const conflicting = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({ ...railwayHeaders, "x-real-ip": "198.51.100.9" }),
      trustedProxies,
    });
    expect(conflicting.error).toContain("conflicting");

    const invalid = resolveForwardedRequest({
      connectionIp: "100.64.0.3",
      headers: new Headers({ ...railwayHeaders, "x-real-ip": "not-an-ip" }),
      trustedProxies,
    });
    expect(invalid.error).toContain("real-ip");
  });

  it("still ignores Railway-shaped headers from an untrusted peer", () => {
    const result = resolveForwardedRequest({
      connectionIp: "100.64.0.2",
      headers: new Headers(railwayHeaders),
      trustedProxies: compileTrustedProxyNetworks([]),
    });
    expect(result.proxyTrusted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.callerIp).toBe("100.64.0.2");
  });

  it("admits the operator console behind Railway once its proxy network is trusted", () => {
    const allowedOrigins = buildConsoleAllowedOrigins(8080, [
      "https://hosted-production-400c.up.railway.app",
    ]);
    const req = new Request("http://hosted-production-400c.up.railway.app/console", {
      headers: railwayHeaders,
    });
    const trusted = evaluateConsoleRequest({
      req,
      connectionIp: "::ffff:100.64.0.2",
      trustedProxies: compileTrustedProxyNetworks([...RAILWAY_INGRESS_PROXY_NETWORKS]),
      allowedOrigins,
    });
    expect(trusted.ok).toBe(true);
    if (trusted.ok) {
      expect(trusted.secure).toBe(true);
      expect(trusted.origin).toBe("https://hosted-production-400c.up.railway.app");
      expect(trusted.callerIp).toBe("70.71.236.82");
    }

    const untrusted = evaluateConsoleRequest({
      req,
      connectionIp: "::ffff:100.64.0.2",
      trustedProxies: compileTrustedProxyNetworks([]),
      allowedOrigins,
    });
    expect(untrusted.ok).toBe(false);
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

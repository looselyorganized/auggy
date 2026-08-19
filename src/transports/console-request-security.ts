import { BlockList, isIP } from "node:net";

const MAX_PROXY_NETWORKS = 64;
const MAX_FORWARDED_CHAIN_LENGTH = 16;
const MAX_FORWARDED_HEADER_BYTES = 2048;

function normalizeStrictIp(value: string): { address: string; family: 4 | 6 } | null {
  if (!value || value !== value.trim() || value.includes("%")) return null;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const address = mapped?.[1] ?? value;
  const family = isIP(address);
  return family === 4 || family === 6 ? { address, family } : null;
}

export interface TrustedProxyNetworks {
  readonly entries: readonly string[];
  matches(ip: string | null | undefined): boolean;
}

export function compileTrustedProxyNetworks(entries: readonly string[]): TrustedProxyNetworks {
  if (entries.length > MAX_PROXY_NETWORKS) {
    throw new Error(`trustedProxies may contain at most ${MAX_PROXY_NETWORKS} entries`);
  }
  const blockList = new BlockList();
  const normalizedEntries: string[] = [];

  for (const entry of entries) {
    if (!entry || entry !== entry.trim()) {
      throw new Error("trustedProxies entries must not contain surrounding whitespace");
    }
    const slash = entry.indexOf("/");
    if (slash >= 0) {
      if (entry.indexOf("/", slash + 1) >= 0) {
        throw new Error(`invalid trusted proxy network: ${entry}`);
      }
      const parsed = normalizeStrictIp(entry.slice(0, slash));
      const prefixText = entry.slice(slash + 1);
      if (!parsed || !/^\d+$/.test(prefixText)) {
        throw new Error(`invalid trusted proxy network: ${entry}`);
      }
      const prefix = Number(prefixText);
      const maxPrefix = parsed.family === 4 ? 32 : 128;
      if (prefix < 1 || prefix > maxPrefix) {
        throw new Error(`trusted proxy network must use a prefix from 1 to ${maxPrefix}: ${entry}`);
      }
      blockList.addSubnet(parsed.address, prefix, parsed.family === 4 ? "ipv4" : "ipv6");
    } else {
      const parsed = normalizeStrictIp(entry);
      if (!parsed) throw new Error(`invalid trusted proxy IP: ${entry}`);
      blockList.addAddress(parsed.address, parsed.family === 4 ? "ipv4" : "ipv6");
    }
    normalizedEntries.push(entry);
  }

  return {
    entries: Object.freeze(normalizedEntries),
    matches(ip: string | null | undefined): boolean {
      if (!ip) return false;
      const parsed = normalizeStrictIp(ip);
      if (!parsed) return false;
      return blockList.check(parsed.address, parsed.family === 4 ? "ipv4" : "ipv6");
    },
  };
}

/**
 * Railway's public edge reaches a service container through Railway's internal
 * proxy network; the container's TCP peer is an address in this CGNAT range
 * (observed 100.64.0.2/.3 on 2026-08-19), not the edge's public IP. The edge
 * overwrites client-supplied `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`
 * and `X-Forwarded-Proto`, so forwarding headers arriving from this network are
 * authoritative. Used as the `trustedProxies` default only when the runtime
 * was started by the deploy-generated Railway entrypoint (`--internal-mode
 * railway` with a verified `/app/data` volume), never from environment markers.
 */
export const RAILWAY_INGRESS_PROXY_NETWORKS: readonly string[] = ["100.64.0.0/10"];

const FORWARDED_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
] as const;

export interface ForwardedRequestResolution {
  callerIp: string;
  proxyTrusted: boolean;
  forwardedHeadersPresent: boolean;
  forwardedProto?: "http" | "https";
  error?: string;
}

export function resolveForwardedRequest(args: {
  connectionIp: string | null | undefined;
  headers: Headers;
  trustedProxies: TrustedProxyNetworks;
}): ForwardedRequestResolution {
  const connection = args.connectionIp ? normalizeStrictIp(args.connectionIp) : null;
  const forwardedHeadersPresent = FORWARDED_HEADERS.some((name) => args.headers.has(name));
  if (!connection) {
    return {
      callerIp: "unknown",
      proxyTrusted: false,
      forwardedHeadersPresent,
      error: "connection IP is unavailable or invalid",
    };
  }

  const proxyTrusted = args.trustedProxies.matches(connection.address);
  const base = {
    callerIp: connection.address,
    proxyTrusted,
    forwardedHeadersPresent,
  };
  if (!proxyTrusted) return base;

  // `X-Forwarded-Host` from a trusted proxy is accepted only when it names the
  // same authority the request already carries in `Host`; a mismatch means the
  // proxy and the request disagree about the public authority, which the
  // console must not guess at. `X-Forwarded-Port` is ignored: it carries no
  // information the console uses, and some edges (Railway) pass a client-
  // supplied value through unchanged, so rejecting it would let any caller
  // deny console access.
  const forwardedHost = args.headers.get("x-forwarded-host");
  if (forwardedHost !== null) {
    // Compare as origins under one fixed scheme so both authorities get the
    // same strict parsing `Host` already receives (no userinfo, path, trailing
    // dot, or comma-joined lists). Default ports normalize identically.
    const requestAuthority = requestOrigin("https", args.headers.get("host"));
    const forwardedAuthority = requestOrigin("https", forwardedHost);
    if (!requestAuthority || !forwardedAuthority || forwardedAuthority !== requestAuthority) {
      return { ...base, error: "forwarded host does not match the request host" };
    }
  }

  const xff = args.headers.get("x-forwarded-for");
  const realIp = args.headers.get("x-real-ip");

  let callerIp = connection.address;
  if (xff !== null) {
    if (Buffer.byteLength(xff, "utf-8") > MAX_FORWARDED_HEADER_BYTES) {
      return { ...base, error: "forwarded-for header is oversized" };
    }
    const rawEntries = xff.split(",");
    if (
      rawEntries.length === 0 ||
      rawEntries.length > MAX_FORWARDED_CHAIN_LENGTH ||
      rawEntries.some((entry) => entry.trim() === "")
    ) {
      return { ...base, error: "forwarded-for chain is invalid" };
    }
    const entries: string[] = [];
    for (const raw of rawEntries) {
      const parsed = normalizeStrictIp(raw.trim());
      if (!parsed) return { ...base, error: "forwarded-for contains an invalid IP" };
      entries.push(parsed.address);
    }
    callerIp = entries[0]!;
    for (let index = entries.length - 1; index >= 0; index--) {
      const candidate = entries[index]!;
      if (!args.trustedProxies.matches(candidate)) {
        callerIp = candidate;
        break;
      }
    }
    if (realIp !== null) {
      // A trusted proxy that sets both headers (Railway, nginx defaults) is
      // naming the client twice. Accept the pair only when `X-Real-IP` is one
      // of the forwarded hops, and prefer it: the proxy's single-address claim
      // identifies the client even when `X-Forwarded-For` also lists upstream
      // edge hops that are not on the operator's trusted list.
      if (realIp.includes(",")) return { ...base, error: "real-ip must contain one address" };
      const parsedRealIp = normalizeStrictIp(realIp);
      if (!parsedRealIp) return { ...base, error: "real-ip contains an invalid IP" };
      if (!entries.includes(parsedRealIp.address)) {
        return { ...base, error: "conflicting forwarded client IP headers" };
      }
      callerIp = parsedRealIp.address;
    }
  } else if (realIp !== null) {
    if (realIp.includes(",")) return { ...base, error: "real-ip must contain one address" };
    const parsed = normalizeStrictIp(realIp);
    if (!parsed) return { ...base, error: "real-ip contains an invalid IP" };
    callerIp = parsed.address;
  }

  const proto = args.headers.get("x-forwarded-proto");
  let forwardedProto: "http" | "https" | undefined;
  if (proto !== null) {
    if (proto !== "http" && proto !== "https") {
      return { ...base, callerIp, error: "forwarded proto must be one unambiguous value" };
    }
    forwardedProto = proto;
  }

  return { ...base, callerIp, ...(forwardedProto ? { forwardedProto } : {}) };
}

function normalizeConfiguredOrigin(value: string): string {
  if (!value || value !== value.trim() || value.includes(",")) {
    throw new Error(`invalid console origin: ${value}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid console origin: ${value}`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname.endsWith(".")
  ) {
    throw new Error(`console origin must contain only http(s) scheme and authority: ${value}`);
  }
  return parsed.origin;
}

export function buildConsoleAllowedOrigins(
  port: number,
  configured: readonly string[] = [],
): ReadonlySet<string> {
  if (configured.length > 32)
    throw new Error("console allowedOrigins may contain at most 32 items");
  const values = new Set<string>([
    new URL(`http://localhost:${port}`).origin,
    new URL(`http://127.0.0.1:${port}`).origin,
    new URL(`http://[::1]:${port}`).origin,
  ]);
  for (const origin of configured) values.add(normalizeConfiguredOrigin(origin));
  return values;
}

function requestOrigin(scheme: "http" | "https", host: string | null): string | null {
  if (!host || host !== host.trim() || host.includes(",") || /[\s/@?#\\%]/.test(host)) {
    return null;
  }
  try {
    const parsed = new URL(`${scheme}://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.hostname.endsWith(".")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function suppliedOrigin(value: string): string | null {
  if (!value || value !== value.trim() || value === "null" || value.includes(",")) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== value ||
      parsed.hostname.endsWith(".")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export type ConsoleRequestEvaluation =
  | {
      ok: true;
      callerIp: string;
      secure: boolean;
      origin: string;
      allowInsecureLoopback: boolean;
    }
  | { ok: false; status: 400 | 403 | 421; reason: string };

export function evaluateConsoleRequest(args: {
  req: Request;
  connectionIp: string | null | undefined;
  trustedProxies: TrustedProxyNetworks;
  allowedOrigins: ReadonlySet<string>;
}): ConsoleRequestEvaluation {
  const forwarded = resolveForwardedRequest({
    connectionIp: args.connectionIp,
    headers: args.req.headers,
    trustedProxies: args.trustedProxies,
  });
  if (forwarded.error) return { ok: false, status: 400, reason: forwarded.error };
  if (forwarded.forwardedHeadersPresent && !forwarded.proxyTrusted) {
    return { ok: false, status: 400, reason: "forwarding headers came from an untrusted peer" };
  }

  const directProtocol = new URL(args.req.url).protocol;
  const scheme = forwarded.forwardedProto ?? (directProtocol === "https:" ? "https" : "http");
  const effectiveOrigin = requestOrigin(scheme, args.req.headers.get("host"));
  if (!effectiveOrigin || !args.allowedOrigins.has(effectiveOrigin)) {
    return { ok: false, status: 421, reason: "console host is not allowed" };
  }

  const originHeader = args.req.headers.get("origin");
  if (originHeader !== null) {
    const origin = suppliedOrigin(originHeader);
    if (!origin || origin !== effectiveOrigin) {
      return { ok: false, status: 403, reason: "console origin is not allowed" };
    }
  }

  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(args.req.method.toUpperCase());
  if (unsafe && originHeader === null) {
    const basic = args.req.headers.get("authorization")?.startsWith("Basic ") === true;
    const cookie = args.req.headers.has("cookie");
    if (!basic || cookie) {
      return { ok: false, status: 403, reason: "browser mutations require an Origin header" };
    }
  }

  return {
    ok: true,
    callerIp: forwarded.callerIp,
    secure: scheme === "https",
    origin: effectiveOrigin,
    allowInsecureLoopback:
      !forwarded.forwardedHeadersPresent &&
      (args.connectionIp === "::1" ||
        normalizeStrictIp(args.connectionIp ?? "")?.address.split(".")[0] === "127"),
  };
}

import { lookup as dnsLookup } from "node:dns/promises";
import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { OutcomeUnknownError } from "./outcome-unknown";

export class HttpOutcomeUnknownError extends OutcomeUnknownError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpOutcomeUnknownError";
  }
}

export class HttpTimeoutError extends HttpOutcomeUnknownError {
  readonly ms: number;

  constructor(ms: number) {
    super(
      `HTTP request timed out after ${ms}ms; delivery outcome is unknown and must not be retried automatically`,
    );
    this.name = "HttpTimeoutError";
    this.ms = ms;
  }
}

/**
 * HTTP client primitive.
 *
 * Wraps HTTP(S) requests with a per-request timeout, bounded manual redirects,
 * deterministic header handling, and an optional public-network boundary.
 * Public-policy clients resolve every hop, reject mixed or non-global answer
 * sets, and pin the socket to the validated address while preserving Host,
 * SNI, and certificate verification against the original hostname.
 *
 * Ported from the reqwest pattern in soongenwong/claudecode
 * (rust/crates/tools/src/lib.rs, build_http_client). The Rust version
 * returned a generic `reqwest::Client`; this version exposes a minimal
 * verb-agnostic wrapper over `fetch` with the same configuration shape.
 *
 * Intentionally does NOT include retries, exponential backoff, cookie jars,
 * connection pooling, request signing, or response caching.
 */

export interface HttpClientOptions {
  /** Total request timeout in milliseconds, including all redirects. Default 20_000. */
  timeoutMs?: number;
  /** Maximum number of 3xx redirects to follow. Default 10. */
  maxRedirects?: number;
  /** User-Agent header sent on every request. Default "auggy-http/0.1". */
  userAgent?: string;
  /** Headers added to every request. Request-level headers override these. */
  defaultHeaders?: Record<string, string>;
  /**
   * Custom headers that may follow a redirect to an exact cross-origin
   * destination. Keys must be origins (scheme, host, and port); values are
   * case-insensitive header names. Without an entry, only the client's
   * non-sensitive protocol headers are forwarded.
   */
  crossOriginRedirectHeaderAllowlist?: Record<string, readonly string[]>;
  /** Maximum response body size in bytes. Responses exceeding this are truncated. Default 5MB. */
  maxBodyBytes?: number;
  /**
   * Destination trust policy. Public URLs are resolved and every returned
   * address must be globally routable; the connection is pinned to one of
   * those validated addresses. Operator-configured URLs preserve support for
   * explicitly configured private and loopback services.
   *
   * Default: "operator-configured" for backwards compatibility. Augments that
   * consume model, peer, or request supplied URLs must select "public".
   */
  urlPolicy?: "public" | "operator-configured";
  /**
   * Reject URLs that resolve to loopback, RFC 1918 private ranges, link-local,
   * cloud metadata endpoints, and non-http(s) schemes. Applied to the initial
   * URL and every redirect hop. Default: false.
   *
   * Enable on clients that consume model- or peer-supplied URLs (web_fetch).
   * Leave disabled on clients fetching operator-configured endpoints (e.g. a
   * manifest URL that is intentionally localhost during development).
   *
   * @deprecated Use `urlPolicy: "public"` instead.
   */
  rejectUnsafeUrls?: boolean;
  /**
   * Resolver override for private DNS environments and deterministic tests.
   * Public policy still validates every returned address and pins the socket
   * to the validated result.
   */
  resolveHostname?: HttpHostnameResolver;
}

export interface HttpResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HttpHostnameResolver = (hostname: string) => Promise<readonly HttpResolvedAddress[]>;

const IPV4_NON_GLOBAL_RANGES: readonly [string, number, string][] = [
  ["0.0.0.0", 8, "0.0.0.0/8"],
  ["10.0.0.0", 8, "RFC 1918 (10/8)"],
  ["100.64.0.0", 10, "shared address space (100.64/10)"],
  ["127.0.0.0", 8, "loopback (127/8)"],
  ["169.254.0.0", 16, "link-local / cloud metadata (169.254/16)"],
  ["172.16.0.0", 12, "RFC 1918 (172.16/12)"],
  ["192.0.0.0", 24, "IETF protocol assignments (192.0.0/24)"],
  ["192.0.2.0", 24, "documentation (192.0.2/24)"],
  ["192.88.99.0", 24, "deprecated 6to4 relay anycast (192.88.99/24)"],
  ["192.168.0.0", 16, "RFC 1918 (192.168/16)"],
  ["198.18.0.0", 15, "benchmarking (198.18/15)"],
  ["198.51.100.0", 24, "documentation (198.51.100/24)"],
  ["203.0.113.0", 24, "documentation (203.0.113/24)"],
  ["224.0.0.0", 4, "multicast (224/4)"],
  ["240.0.0.0", 4, "reserved (240/4)"],
];

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function ipv4InCidr(address: number, base: string, prefixLength: number): boolean {
  const parsedBase = parseIpv4(base);
  if (parsedBase === null) return false;
  const shift = 32 - prefixLength;
  return address >>> shift === parsedBase >>> shift;
}

function parseIpv6(address: string): bigint | null {
  if (address.includes("%") || isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const embedded = parseIpv4(normalized.slice(lastColon + 1));
    if (embedded === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(embedded >>> 16).toString(16)}:${(
      embedded & 0xffff
    ).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    const word = Number.parseInt(group, 16);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
    value = (value << 16n) | BigInt(word);
  }
  return value;
}

function ipv6InCidr(address: bigint, base: string, prefixLength: number): boolean {
  const parsedBase = parseIpv6(base);
  if (parsedBase === null) return false;
  const shift = BigInt(128 - prefixLength);
  return address >> shift === parsedBase >> shift;
}

function embeddedIpv4(address: bigint): string {
  const value = Number(address & 0xffff_ffffn);
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

/**
 * Return a reason when an IP address is not globally routable. This is
 * deliberately fail-closed for special-purpose ranges.
 */
export function rejectNonGlobalAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    if (parsed === null) return "invalid IPv4 address";
    for (const [base, prefixLength, label] of IPV4_NON_GLOBAL_RANGES) {
      if (ipv4InCidr(parsed, base, prefixLength)) return `blocked: ${label}`;
    }
    return null;
  }
  if (family !== 6) return "invalid IP address";

  const parsed = parseIpv6(address);
  if (parsed === null) return "invalid IPv6 address";
  if (parsed === 0n) return "blocked: IPv6 unspecified (::/128)";
  if (parsed === 1n) return "blocked: IPv6 loopback (::1/128)";

  // IPv4-compatible and mapped forms must not bypass IPv4 classification.
  if (ipv6InCidr(parsed, "::", 96)) {
    const reason = rejectNonGlobalAddress(embeddedIpv4(parsed));
    return reason ? `${reason} (via IPv4-compatible IPv6)` : null;
  }
  if (ipv6InCidr(parsed, "::ffff:0:0", 96)) {
    const reason = rejectNonGlobalAddress(embeddedIpv4(parsed));
    return reason ? `${reason} (via IPv4-mapped IPv6)` : null;
  }

  // The well-known NAT64 prefix embeds an IPv4 destination. Local-use NAT64
  // and other non-global IPv6 ranges are rejected outright below.
  if (ipv6InCidr(parsed, "64:ff9b::", 96)) {
    const reason = rejectNonGlobalAddress(embeddedIpv4(parsed));
    return reason ? `${reason} (via NAT64 IPv6)` : null;
  }

  const blockedV6: readonly [string, number, string][] = [
    ["64:ff9b:1::", 48, "local-use NAT64 (64:ff9b:1::/48)"],
    ["100::", 64, "discard-only (100::/64)"],
    ["2001::", 23, "IETF special-purpose assignments (2001::/23)"],
    ["2001:db8::", 32, "documentation (2001:db8::/32)"],
    ["2002::", 16, "deprecated 6to4 (2002::/16)"],
    ["3fff::", 20, "documentation (3fff::/20)"],
    ["fc00::", 7, "unique-local (fc00::/7)"],
    ["fe80::", 10, "link-local (fe80::/10)"],
    ["fec0::", 10, "deprecated site-local (fec0::/10)"],
    ["ff00::", 8, "multicast (ff00::/8)"],
  ];
  for (const [base, prefixLength, label] of blockedV6) {
    if (ipv6InCidr(parsed, base, prefixLength)) return `blocked: IPv6 ${label}`;
  }

  // Global unicast is 2000::/3. NAT64's globally scoped prefix was handled
  // above; everything else is special-purpose and fails closed.
  if (!ipv6InCidr(parsed, "2000::", 3)) {
    return "blocked: IPv6 address is not global unicast";
  }
  return null;
}

/**
 * Perform synchronous URL structure and literal-address checks. Public-policy
 * clients additionally resolve and validate all DNS answers before each hop.
 */
export function rejectUnsafeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unparseable URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `blocked scheme: ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) {
    return "blocked: URL credentials are not allowed";
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const hostnameWithoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (
    hostnameWithoutTrailingDot === "localhost" ||
    hostnameWithoutTrailingDot.endsWith(".localhost")
  ) {
    return "blocked: loopback";
  }
  if (
    hostnameWithoutTrailingDot === "metadata" ||
    hostnameWithoutTrailingDot === "metadata.google.internal"
  ) {
    return "blocked: cloud metadata endpoint";
  }

  return isIP(host) === 0 ? null : rejectNonGlobalAddress(host);
}

/** Return a reason when a redirect crosses an unsafe protocol boundary. */
export function rejectUnsafeRedirect(previousUrl: string, nextUrl: string): string | null {
  let previous: URL;
  let next: URL;
  try {
    previous = new URL(previousUrl);
    next = new URL(nextUrl, previous);
  } catch {
    return "invalid redirect URL";
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    return `redirect uses unsupported scheme ${next.protocol}`;
  }
  if (next.username || next.password) {
    return "redirect URL credentials are not allowed";
  }
  if (previous.protocol === "https:" && next.protocol !== "https:") {
    return "HTTPS-to-HTTP redirect downgrade";
  }
  return null;
}

export interface HttpRequestInit {
  /** HTTP method. Default "GET". */
  method?: string;
  /** Headers for this request. Merged on top of the client's defaultHeaders. */
  headers?: Record<string, string>;
  /** Request body. Not valid for GET / HEAD. */
  body?: string | Uint8Array;
  /** Optional caller-owned abort signal. Combined with the client's timeout. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  /** URL after all redirects were followed. */
  finalUrl: string;
  /** HTTP status code. */
  status: number;
  /** HTTP reason phrase ("OK", "Not Found", ...), or "Unknown" if absent. */
  statusText: string;
  /** Content-Type header value, or "" if absent. Convenience accessor; also in `headers`. */
  contentType: string;
  /** Full response headers. */
  headers: Headers;
  /** Response body as text (UTF-8 best-effort). */
  body: string;
}

export interface HttpClient {
  request: (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;
  get: (url: string, init?: Omit<HttpRequestInit, "method" | "body">) => Promise<HttpResponse>;
  post: (url: string, init?: Omit<HttpRequestInit, "method">) => Promise<HttpResponse>;
  put: (url: string, init?: Omit<HttpRequestInit, "method">) => Promise<HttpResponse>;
  delete: (url: string, init?: Omit<HttpRequestInit, "method">) => Promise<HttpResponse>;
  head: (url: string, init?: Omit<HttpRequestInit, "method" | "body">) => Promise<HttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT = "auggy-http/0.1";
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
const FOLLOWED_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Wrap a Fetch implementation for fixed credential-bearing endpoints.
 * Redirects are surfaced as failures so custom credentials and request bodies
 * can never cross an origin boundary inside the underlying Fetch stack.
 */
export function createRedirectRejectingFetch(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "manual",
    });
    if (response.redirected || FOLLOWED_REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      throw new Error("http client: redirects are disabled for credential-bearing requests");
    }
    return response;
  }) as typeof fetch;
}

/**
 * Headers that are safe to retain after an origin transition. Every custom
 * header is treated as credential-bearing unless the operator allowlists it
 * for the exact destination origin.
 */
const DEFAULT_CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-language",
  "content-type",
  "user-agent",
]);

function normalizeRedirectHeaderAllowlist(
  configured: Record<string, readonly string[]> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const normalized = new Map<string, ReadonlySet<string>>();
  for (const [rawOrigin, names] of Object.entries(configured ?? {})) {
    let parsed: URL;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      throw new Error(`http client: invalid cross-origin redirect allowlist origin: ${rawOrigin}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin === "null" ||
      parsed.href !== `${parsed.origin}/`
    ) {
      throw new Error(
        `http client: cross-origin redirect allowlist key must be an exact HTTP(S) origin: ${rawOrigin}`,
      );
    }
    const normalizedNames = new Set<string>();
    for (const name of names) {
      const probe = new Headers();
      probe.set(name, "value");
      const normalizedName = [...probe.keys()][0];
      if (!normalizedName) {
        throw new Error("http client: redirect header allowlist contains an empty header name");
      }
      normalizedNames.add(normalizedName);
    }
    normalized.set(parsed.origin, normalizedNames);
  }
  return normalized;
}

function retainHeadersForRedirect(
  headers: Headers,
  destinationOrigin: string,
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const explicitlyAllowed = allowlist.get(destinationOrigin);
  for (const name of [...headers.keys()]) {
    if (!DEFAULT_CROSS_ORIGIN_REDIRECT_HEADERS.has(name) && !explicitlyAllowed?.has(name)) {
      headers.delete(name);
    }
  }
}

interface HttpHopResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

const DEFAULT_HOSTNAME_RESOLVER: HttpHostnameResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Resolve a public HTTP(S) URL and reject the entire answer set unless every
 * address is globally routable. The returned snapshot is the only set the
 * socket layer may use.
 */
export async function resolvePublicHttpUrl(
  url: string,
  resolver: HttpHostnameResolver = DEFAULT_HOSTNAME_RESOLVER,
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly HttpResolvedAddress[]> {
  const structuralReason = rejectUnsafeUrl(url);
  if (structuralReason) {
    throw new Error(`http client: unsafe URL (${structuralReason})`);
  }

  const parsed = new URL(url);
  let hostname = parsed.hostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  const literalFamily = isIP(hostname);
  const rawAnswers =
    literalFamily === 0
      ? await abortable(resolver(hostname), signal)
      : [{ address: hostname, family: literalFamily as 4 | 6 }];

  if (rawAnswers.length === 0) {
    throw new Error("http client: public destination resolved to no addresses");
  }
  if (rawAnswers.length > 32) {
    throw new Error("http client: public destination returned too many DNS addresses");
  }

  const deduplicated = new Map<string, HttpResolvedAddress>();
  for (const answer of rawAnswers) {
    const actualFamily = isIP(answer.address);
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      actualFamily === 0 ||
      actualFamily !== answer.family
    ) {
      throw new Error("http client: public destination returned an invalid DNS address");
    }
    const reason = rejectNonGlobalAddress(answer.address);
    if (reason) {
      throw new Error(
        `http client: public destination resolved to a non-global address (${reason})`,
      );
    }
    deduplicated.set(`${answer.family}:${answer.address}`, {
      address: answer.address,
      family: answer.family,
    });
  }
  return [...deduplicated.values()];
}

async function fetchWithPinnedAddress(
  url: string,
  init: {
    method: string;
    headers: Headers;
    body?: string | Uint8Array;
    signal: AbortSignal;
  },
  destination: HttpResolvedAddress,
): Promise<HttpHopResponse> {
  const parsed = new URL(url);
  const request = parsed.protocol === "https:" ? nodeHttpsRequest : nodeHttpRequest;
  const headers = Object.fromEntries(init.headers.entries());
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: destination.address, family: destination.family }]);
      return;
    }
    callback(null, destination.address, destination.family);
  };

  return await new Promise<HttpHopResponse>((resolve, reject) => {
    const req = request(
      parsed,
      {
        method: init.method,
        headers,
        signal: init.signal,
        agent: false,
        lookup: pinnedLookup,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < res.rawHeaders.length; index += 2) {
          responseHeaders.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!);
        }
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "Unknown",
          headers: responseHeaders,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    req.once("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function fetchHop(
  url: string,
  init: {
    method: string;
    headers: Headers;
    body?: string | Uint8Array;
    signal: AbortSignal;
  },
  destination?: HttpResolvedAddress,
): Promise<HttpHopResponse> {
  if (destination) return await fetchWithPinnedAddress(url, init, destination);
  const response = await fetch(url, {
    method: init.method,
    redirect: "manual",
    signal: init.signal,
    headers: init.headers,
    body: init.method === "GET" || init.method === "HEAD" ? undefined : init.body,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  };
}

/**
 * Create an HTTP client with the given defaults.
 *
 * Redirect handling is done manually (fetch is called with
 * `redirect: "manual"`) so the `maxRedirects` cap is actually enforceable
 * — the platform default of `"follow"` has no observable limit.
 *
 * The timeout is a total budget across the entire redirect chain, not
 * a per-hop budget. Matches reqwest's `Client::builder().timeout(..)`.
 */
export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const defaultHeaders = opts.defaultHeaders ?? {};
  const crossOriginRedirectHeaderAllowlist = normalizeRedirectHeaderAllowlist(
    opts.crossOriginRedirectHeaderAllowlist,
  );
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    opts.urlPolicy !== undefined &&
    opts.urlPolicy !== "public" &&
    opts.urlPolicy !== "operator-configured"
  ) {
    throw new Error("http client: invalid URL security policy");
  }
  if (opts.rejectUnsafeUrls !== undefined && typeof opts.rejectUnsafeUrls !== "boolean") {
    throw new Error("http client: rejectUnsafeUrls must be a boolean");
  }
  if (
    opts.urlPolicy !== undefined &&
    opts.rejectUnsafeUrls !== undefined &&
    (opts.urlPolicy === "public") !== opts.rejectUnsafeUrls
  ) {
    throw new Error("http client: contradictory URL security policies");
  }
  const urlPolicy =
    opts.urlPolicy ?? (opts.rejectUnsafeUrls === true ? "public" : "operator-configured");
  const resolveHostname = opts.resolveHostname ?? DEFAULT_HOSTNAME_RESOLVER;

  const request = async (url: string, init: HttpRequestInit = {}): Promise<HttpResponse> => {
    const method = (init.method ?? "GET").toUpperCase();
    const currentHeaders = new Headers({ "user-agent": userAgent });
    for (const [name, value] of Object.entries(defaultHeaders)) {
      currentHeaders.set(name, value);
    }
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      currentHeaders.set(name, value);
    }

    if (urlPolicy === "public") {
      const reason = rejectUnsafeUrl(url);
      if (reason) throw new Error(`http client: unsafe URL (${reason})`);
    }
    const parsedInitialUrl = new URL(url);
    if (parsedInitialUrl.protocol !== "http:" && parsedInitialUrl.protocol !== "https:") {
      throw new Error(`http client: unsupported URL scheme ${parsedInitialUrl.protocol}`);
    }
    if (parsedInitialUrl.username || parsedInitialUrl.password) {
      throw new Error("http client: URL credentials are not allowed");
    }
    const originalOrigin = parsedInitialUrl.origin;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) {
      abortFromCaller();
    } else {
      init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    let timeoutError: HttpTimeoutError | undefined;
    const timer = setTimeout(() => {
      timeoutError = new HttpTimeoutError(timeoutMs);
      controller.abort(timeoutError);
    }, timeoutMs);

    let requestDispatched = false;
    try {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody: string | Uint8Array | undefined = init.body;
      let hops = 0;
      while (true) {
        const resolved =
          urlPolicy === "public"
            ? await resolvePublicHttpUrl(currentUrl, resolveHostname, controller.signal)
            : undefined;
        const parsedCurrentUrl = new URL(currentUrl);
        if (parsedCurrentUrl.protocol !== "http:" && parsedCurrentUrl.protocol !== "https:") {
          throw new Error(`http client: unsupported URL scheme ${parsedCurrentUrl.protocol}`);
        }
        if (parsedCurrentUrl.username || parsedCurrentUrl.password) {
          throw new Error("http client: URL credentials are not allowed");
        }
        requestDispatched = true;
        const response = await fetchHop(
          currentUrl,
          {
            method: currentMethod,
            headers: currentHeaders,
            body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
            signal: controller.signal,
          },
          resolved?.[0],
        );

        if (FOLLOWED_REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          if (location === null) {
            const body = await readBody(response, maxBodyBytes);
            return buildResponse(currentUrl, response, body);
          }
          if (hops >= maxRedirects) {
            await response.body?.cancel();
            throw new Error(
              `http client: exceeded redirect limit (${maxRedirects}) at ${currentUrl}`,
            );
          }

          // Consume the redirect response body to prevent connection leaks.
          await response.body?.cancel();

          const redirectReason = rejectUnsafeRedirect(currentUrl, location);
          if (redirectReason) {
            throw new Error(`http client: refused redirect (${redirectReason})`);
          }
          currentUrl = new URL(location, currentUrl).toString();

          // Per RFC 7231: 301/302/303 change the method to GET and drop the body.
          // 307/308 preserve the method and body.
          if (response.status === 301 || response.status === 302 || response.status === 303) {
            currentMethod = "GET";
            currentBody = undefined;
          }

          // Strip sensitive headers on cross-origin redirects to prevent
          // credentials leaking to a different host. We compare against the
          // original origin (not the previous hop) because currentHeaders is
          // mutated — delete is one-way, headers can never be re-added, so
          // a chain like A→B→A correctly has headers stripped at B and they
          // stay stripped for the return to A.
          const redirectOrigin = new URL(currentUrl).origin;
          if (redirectOrigin !== originalOrigin) {
            retainHeadersForRedirect(
              currentHeaders,
              redirectOrigin,
              crossOriginRedirectHeaderAllowlist,
            );
          }

          hops += 1;
          continue;
        }

        const body = await readBody(response, maxBodyBytes);
        return buildResponse(currentUrl, response, body);
      }
    } catch (error) {
      if (timeoutError) throw timeoutError;
      if (init.signal?.aborted) {
        throw init.signal.reason ?? new DOMException("Operation aborted", "AbortError");
      }
      if (requestDispatched && method !== "GET" && method !== "HEAD") {
        throw new HttpOutcomeUnknownError(
          "HTTP mutation ended without a trustworthy response after dispatch; outcome is unknown and must not be retried automatically",
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  const get = (url: string, init: Omit<HttpRequestInit, "method" | "body"> = {}) =>
    request(url, { ...init, method: "GET" });

  const post = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "POST" });

  const put = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "PUT" });

  const del = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "DELETE" });

  const head = (url: string, init: Omit<HttpRequestInit, "method" | "body"> = {}) =>
    request(url, { ...init, method: "HEAD" });

  return { request, get, post, put, delete: del, head };
}

/**
 * Read a byte stream with a byte-size cap. Backs off to a UTF-8 character
 * boundary before truncating, preventing U+FFFD replacement characters.
 *
 * Shared by the HTTP client (response bodies) and the bash augment
 * (stdout/stderr capture). Exported for reuse by any stream consumer.
 */
export async function readStreamWithCap(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (totalBytes + value.byteLength > maxBytes) {
      let end = maxBytes - totalBytes;
      while (end > 0 && (value[end]! & 0xc0) === 0x80) {
        end--;
      }
      if (end > 0) {
        chunks.push(value.slice(0, end));
      }
      totalBytes = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    totalBytes += value.byteLength;
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  for (let i = 0; i < chunks.length; i++) {
    text += decoder.decode(chunks[i], { stream: i < chunks.length - 1 });
  }

  if (truncated) {
    text += `\n[truncated at ${maxBytes} bytes]`;
  }

  return { text, truncated };
}

/** Read an HTTP response body with a byte-size cap. */
async function readBody(response: HttpHopResponse, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const { text, truncated } = await readStreamWithCap(response.body, maxBytes);
  if (truncated) {
    const contentLength = response.headers.get("content-length");
    const totalSize = contentLength ? ` total size: ${contentLength} bytes` : "";
    return text.replace(
      /\[truncated at \d+ bytes\]$/,
      `[truncated at ${maxBytes} bytes${totalSize}]`,
    );
  }
  return text;
}

function buildResponse(finalUrl: string, response: HttpHopResponse, body: string): HttpResponse {
  return {
    finalUrl,
    status: response.status,
    statusText: response.statusText || "Unknown",
    contentType: response.headers.get("content-type") ?? "",
    headers: response.headers,
    body,
  };
}

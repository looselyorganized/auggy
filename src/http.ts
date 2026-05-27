/**
 * HTTP client primitive.
 *
 * Wraps the native `fetch` with a per-request timeout, a bounded redirect
 * loop, and a consistent User-Agent. Built so any augment that needs to
 * hit the network (web_fetch, web_search, MCP HTTP transport, remote
 * skill loading, etc.) can share one configured client.
 *
 * Ported from the reqwest pattern in soongenwong/claudecode
 * (rust/crates/tools/src/lib.rs, build_http_client). The Rust version
 * returned a generic `reqwest::Client`; this version exposes a minimal
 * verb-agnostic wrapper over `fetch` with the same configuration shape.
 *
 * Intentionally does NOT include: retries, exponential backoff, cookie
 * jars, connection pooling, request signing, SSRF allowlists, response
 * caching. Those are concerns for higher-layer wrappers or hook augments.
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
  /** Maximum response body size in bytes. Responses exceeding this are truncated. Default 5MB. */
  maxBodyBytes?: number;
  /**
   * Reject URLs that resolve to loopback, RFC 1918 private ranges, link-local,
   * cloud metadata endpoints, and non-http(s) schemes. Applied to the initial
   * URL and every redirect hop. Default: false.
   *
   * Enable on clients that consume model- or peer-supplied URLs (web_fetch).
   * Leave disabled on clients fetching operator-configured endpoints (e.g. the
   * manifest manifest URL, which is often localhost during dev).
   */
  rejectUnsafeUrls?: boolean;
}

/**
 * Reject URLs pointing to loopback, private networks, link-local, cloud
 * metadata endpoints, or non-http(s) schemes. Returns a reason string if
 * the URL should be blocked, or null if it's safe.
 *
 * This is a structural SSRF defense — the check runs before any network
 * I/O, at each hop. It does NOT perform DNS resolution, so DNS-rebinding
 * attacks that resolve a public-looking name to a private IP at fetch
 * time are out of scope for this layer.
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

  // Strip IPv6 brackets. URL.hostname retains brackets on IPv6 literals
  // (e.g. "[::1]"), so range checks that match raw IPv6 text must unwrap
  // the brackets first.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  // Hostname-style blocks. Trailing dot makes a name "fully qualified"
  // but resolves to the same destination, so block both.
  if (host === "localhost" || host === "localhost.") {
    return "blocked: loopback";
  }
  if (host === "metadata" || host === "metadata.google.internal") {
    return "blocked: cloud metadata endpoint";
  }

  // IPv6 canonical forms — loopback, unspecified, link-local, unique-local.
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return "blocked: IPv6 loopback (::1)";
  }
  if (host === "::" || host === "0:0:0:0:0:0:0:0") {
    return "blocked: IPv6 unspecified (::/128)";
  }
  // fe80::/10 spans the first-group range fe80-febf (binary 1111 1110 10xx xxxx).
  if (/^fe[89ab][0-9a-f]:/i.test(host)) {
    return "blocked: IPv6 link-local (fe80::/10)";
  }
  // fc00::/7 spans the first-group range fc00-fdff (binary 1111 110x xxxx xxxx).
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) {
    return "blocked: IPv6 unique-local (fc00::/7)";
  }

  // IPv4-mapped IPv6 — re-check the embedded IPv4 against the IPv4 rules
  // so an attacker can't bypass by wrapping an internal IP in IPv6 form.
  // The URL parser normalizes dotted-quad forms to hex (::ffff:a.b.c.d →
  // ::ffff:hhhh:hhhh) so we handle both.
  const mappedV4 = extractIPv4Mapped(host);
  if (mappedV4) {
    const reason = checkIpv4Ranges(mappedV4);
    if (reason) return `${reason} (via IPv4-mapped IPv6)`;
  } else {
    const ipv4Reason = checkIpv4Ranges(host);
    if (ipv4Reason) return ipv4Reason;
  }

  return null;
}

function extractIPv4Mapped(host: string): string | null {
  // Dotted-quad form: ::ffff:10.0.0.1 (rare — most parsers normalize away).
  const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;

  // Hex form emitted by the URL parser: ::ffff:a00:1 (two 16-bit groups).
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

function checkIpv4Ranges(host: string): string | null {
  if (host === "127.0.0.1" || /^127\./.test(host)) {
    return "blocked: loopback (127/8)";
  }
  if (/^10\./.test(host)) return "blocked: RFC 1918 (10/8)";
  if (/^192\.168\./.test(host)) return "blocked: RFC 1918 (192.168/16)";
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
    return "blocked: RFC 1918 (172.16/12)";
  }
  if (/^169\.254\./.test(host)) {
    return "blocked: link-local / cloud metadata (169.254/16)";
  }
  if (/^0\./.test(host)) return "blocked: 0.0.0.0/8";
  return null;
}

export interface HttpRequestInit {
  /** HTTP method. Default "GET". */
  method?: string;
  /** Headers for this request. Merged on top of the client's defaultHeaders. */
  headers?: Record<string, string>;
  /** Request body. Not valid for GET / HEAD. */
  body?: string | Uint8Array;
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

/** Headers stripped when a redirect crosses origin boundaries. */
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

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
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const ssrfGuard = opts.rejectUnsafeUrls ?? false;

  const request = async (url: string, init: HttpRequestInit = {}): Promise<HttpResponse> => {
    const method = (init.method ?? "GET").toUpperCase();
    const currentHeaders: Record<string, string> = {
      "user-agent": userAgent,
      ...defaultHeaders,
      ...(init.headers ?? {}),
    };

    if (ssrfGuard) {
      const reason = rejectUnsafeUrl(url);
      if (reason) {
        throw new Error(`http client: unsafe URL ${url} (${reason})`);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const originalOrigin = new URL(url).origin;

    try {
      let currentUrl = url;
      let currentMethod = method;
      let currentBody: string | Uint8Array | undefined = init.body;
      let hops = 0;

      while (true) {
        const response = await fetch(currentUrl, {
          method: currentMethod,
          redirect: "manual",
          signal: controller.signal,
          headers: currentHeaders,
          body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
        });

        if (response.status >= 300 && response.status < 400) {
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

          currentUrl = new URL(location, currentUrl).toString();

          if (ssrfGuard) {
            const reason = rejectUnsafeUrl(currentUrl);
            if (reason) {
              throw new Error(`http client: unsafe redirect target ${currentUrl} (${reason})`);
            }
          }

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
            for (const header of SENSITIVE_HEADERS) {
              delete currentHeaders[header];
            }
          }

          hops += 1;
          continue;
        }

        const body = await readBody(response, maxBodyBytes);
        return buildResponse(currentUrl, response, body);
      }
    } finally {
      clearTimeout(timer);
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
async function readBody(response: Response, maxBytes: number): Promise<string> {
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

function buildResponse(finalUrl: string, response: Response, body: string): HttpResponse {
  return {
    finalUrl,
    status: response.status,
    statusText: response.statusText || "Unknown",
    contentType: response.headers.get("content-type") ?? "",
    headers: response.headers,
    body,
  };
}

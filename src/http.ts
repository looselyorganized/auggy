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

  const request = async (
    url: string,
    init: HttpRequestInit = {},
  ): Promise<HttpResponse> => {
    const method = (init.method ?? "GET").toUpperCase();
    const currentHeaders: Record<string, string> = {
      "user-agent": userAgent,
      ...defaultHeaders,
      ...(init.headers ?? {}),
    };

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
          body:
            currentMethod === "GET" || currentMethod === "HEAD"
              ? undefined
              : currentBody,
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

          // Per RFC 7231: 301/302/303 change the method to GET and drop the body.
          // 307/308 preserve the method and body.
          if (
            response.status === 301 ||
            response.status === 302 ||
            response.status === 303
          ) {
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

  const get = (
    url: string,
    init: Omit<HttpRequestInit, "method" | "body"> = {},
  ) => request(url, { ...init, method: "GET" });

  const post = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "POST" });

  const put = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "PUT" });

  const del = (url: string, init: Omit<HttpRequestInit, "method"> = {}) =>
    request(url, { ...init, method: "DELETE" });

  const head = (
    url: string,
    init: Omit<HttpRequestInit, "method" | "body"> = {},
  ) => request(url, { ...init, method: "HEAD" });

  return { request, get, post, put, delete: del, head };
}

/**
 * Read the response body with a byte-size cap. If the body exceeds
 * `maxBytes`, truncate and append a marker so the caller knows.
 */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (totalBytes + value.byteLength > maxBytes) {
      // Take only the bytes that fit within the cap, backing off to a
      // UTF-8 character boundary so we don't split a multi-byte sequence
      // and produce U+FFFD replacement characters.
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
    const contentLength = response.headers.get("content-length");
    const totalSize = contentLength ? ` total size: ${contentLength} bytes` : "";
    text += `\n[truncated at ${maxBytes} bytes${totalSize}]`;
  }

  return text;
}

function buildResponse(
  finalUrl: string,
  response: Response,
  body: string,
): HttpResponse {
  return {
    finalUrl,
    status: response.status,
    statusText: response.statusText || "Unknown",
    contentType: response.headers.get("content-type") ?? "",
    headers: response.headers,
    body,
  };
}

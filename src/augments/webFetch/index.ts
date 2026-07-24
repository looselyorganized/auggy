import { z } from "zod";
import type { Augment } from "../../types";
import { defineTool } from "../../helpers";
import { createHttpClient } from "../../http";
import type { HttpClient, HttpClientOptions, HttpResponse } from "../../http";

/**
 * webFetch augment — fetch a URL, strip HTML to text, and render a
 * prompt-aware summary back to the model.
 *
 * Ported from the Rust implementation in soongenwong/claudecode
 * (rust/crates/tools/src/lib.rs, execute_web_fetch).
 *
 * Design choices carried over:
 *  - http→https upgrade for any non-localhost URL (normalizeFetchUrl).
 *  - 20s default timeout, 10-redirect cap, custom user-agent.
 *  - HTML→text via a small state machine (no DOM parser dependency),
 *    then collapse whitespace and decode a small set of entities.
 *  - Prompt-aware summarization: "title" / "summary|summarize" /
 *    default-preview modes, with a 600- or 900-char ceiling.
 *  - Output carries the POST-redirect final URL, raw byte count, and
 *    round-trip duration so the model can reason about cost.
 *
 * SSRF defense:
 *  - Every initial hostname and redirect target is resolved before dispatch.
 *  - Every A/AAAA answer must be globally routable; mixed answer sets fail.
 *  - The socket is pinned to a validated answer while retaining the original
 *    hostname for Host, SNI, and certificate verification.
 *  - HTTPS-to-HTTP redirects and non-http(s) schemes are rejected.
 *
 * Not carried over:
 *  - No caching. Every call hits the network.
 */

// =========================================================================
// URL normalization
// =========================================================================

/**
 * Upgrade http://… to https://… for any host that is not loopback.
 * Matches normalize_fetch_url in the Rust original.
 */
export function normalizeFetchUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      parsed.protocol = "https:";
    }
  }
  return parsed.toString();
}

// =========================================================================
// HTML → text
// =========================================================================

/** Tag names whose content should be skipped entirely. */
const SKIP_CONTENT_TAGS = new Set(["script", "style"]);

/**
 * Strip HTML tags with a character-by-character state machine.
 * Deliberately does not parse the DOM — keeps the augment dependency-free.
 *
 * Content inside <script> and <style> tags is skipped entirely so
 * JavaScript and CSS don't bleed into the extracted text.
 */
function htmlToText(html: string): string {
  let text = "";
  let inTag = false;
  let tagBuffer = "";
  let skipUntilClose = ""; // non-empty when inside a skip-content tag
  let previousWasSpace = false;

  for (const ch of html) {
    if (ch === "<") {
      inTag = true;
      tagBuffer = "";
      continue;
    }
    if (ch === ">") {
      inTag = false;
      const tagName = (tagBuffer.split(/[\s/]/)[0] ?? "").toLowerCase();

      if (skipUntilClose) {
        // Check for the matching closing tag: </script> or </style>
        if (tagBuffer.startsWith("/")) {
          const closingName = tagBuffer.slice(1).split(/[\s/]/)[0]?.toLowerCase() ?? "";
          if (closingName === skipUntilClose) {
            skipUntilClose = "";
          }
        }
      } else if (SKIP_CONTENT_TAGS.has(tagName ?? "")) {
        skipUntilClose = tagName;
      }
      continue;
    }
    if (inTag) {
      tagBuffer += ch;
      continue;
    }
    if (skipUntilClose) continue;

    if (ch === "&") {
      text += "&";
      previousWasSpace = false;
      continue;
    }

    if (/\s/.test(ch)) {
      if (!previousWasSpace) {
        text += " ";
        previousWasSpace = true;
      }
      continue;
    }

    text += ch;
    previousWasSpace = false;
  }

  return collapseWhitespace(decodeHtmlEntities(text));
}

/**
 * Decode common HTML entities. The order matters: &amp; must be decoded
 * LAST to avoid double-decoding (e.g. &amp;lt; → &lt; → < is wrong;
 * the correct result for &amp;lt; is the literal text "&lt;").
 *
 * Numeric entities (&#60;, &#x3C;) are intentionally not handled — they
 * are uncommon in typical web pages and adding a regex pass for them would
 * complicate this deliberately simple decoder. Matches the Rust original.
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

function collapseWhitespace(input: string): string {
  return input
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(" ");
}

/**
 * Truncate to `maxChars` code points, with an ellipsis marker if cut.
 * Uses Array.from to count code points (not UTF-16 units) so multi-byte
 * characters are handled the same way Rust's chars() iterator handles
 * them in preview_text.
 */
function previewText(input: string, maxChars: number): string {
  const chars = Array.from(input);
  if (chars.length <= maxChars) return input;
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

function normalizeFetchedContent(body: string, contentType: string): string {
  if (isJsonContentType(contentType)) return body.trim();
  if (contentType.includes("html")) return htmlToText(body);
  return body.trim();
}

// =========================================================================
// Prompt-aware summarization
// =========================================================================

function extractTitle(content: string, rawBody: string, contentType: string): string | null {
  if (contentType.includes("html")) {
    const lowered = rawBody.toLowerCase();
    const start = lowered.indexOf("<title>");
    if (start >= 0) {
      const after = start + "<title>".length;
      const endRel = lowered.slice(after).indexOf("</title>");
      if (endRel >= 0) {
        const slice = rawBody.slice(after, after + endRel);
        const title = collapseWhitespace(decodeHtmlEntities(slice));
        if (title.length > 0) return title;
      }
    }
  }

  // Fallback: first non-empty line of the normalized content.
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** Max chars for JSON responses — much larger than the 900-char HTML preview. */
const JSON_MAX_CHARS = 20_000;

function summarizeWebFetch(args: {
  url: string;
  prompt: string;
  content: string;
  rawBody: string;
  contentType: string;
}): string {
  // JSON responses: return the raw content without summarization/truncation
  // to a tiny preview. APIs return structured data the model needs intact.
  if (isJsonContentType(args.contentType)) {
    const preview = previewText(args.content, JSON_MAX_CHARS);
    return `Fetched ${args.url}\n${preview}`;
  }

  const lowerPrompt = args.prompt.toLowerCase();
  const compact = collapseWhitespace(args.content);

  let detail: string;
  if (lowerPrompt.includes("title")) {
    const title = extractTitle(args.content, args.rawBody, args.contentType);
    detail = title !== null ? `Title: ${title}` : previewText(compact, 600);
  } else if (lowerPrompt.includes("summary") || lowerPrompt.includes("summarize")) {
    detail = previewText(compact, 900);
  } else {
    const preview = previewText(compact, 900);
    detail = `Prompt: ${args.prompt}\nContent preview:\n${preview}`;
  }

  return `Fetched ${args.url}\n${detail}`;
}

// =========================================================================
// Augment
// =========================================================================

export interface WebFetchOptions
  extends Omit<
    HttpClientOptions,
    "urlPolicy" | "rejectUnsafeUrls" | "resolveHostname" | "defaultHeaders"
  > {
  /**
   * Headers applied only when the model-selected URL has this exact origin.
   * Keys must be canonical HTTP(S) origins without paths, queries, or userinfo.
   */
  headersByOrigin?: Record<string, Record<string, string>>;
  /**
   * Optional pre-built HTTP client. Supply this if you want to share a
   * client across augments or inject a mock in tests. If omitted, a
   * client is created from the timeout/redirect/user-agent options.
   */
  client?: HttpClient;
}

function normalizeHeadersByOrigin(
  configured: Record<string, Record<string, string>> | undefined,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const normalized = new Map<string, Readonly<Record<string, string>>>();
  for (const [configuredOrigin, headers] of Object.entries(configured ?? {})) {
    let parsed: URL;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error("webFetch headersByOrigin keys must be valid HTTP(S) origins");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      configuredOrigin !== parsed.origin
    ) {
      throw new Error("webFetch headersByOrigin keys must be canonical HTTP(S) origins");
    }
    if (
      typeof headers !== "object" ||
      headers === null ||
      Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== "string")
    ) {
      throw new Error("webFetch headersByOrigin values must be objects of strings");
    }
    normalized.set(parsed.origin, Object.freeze({ ...headers }));
  }
  return normalized;
}

export interface WebFetchResult {
  url: string;
  code: number;
  codeText: string;
  bytes: number;
  durationMs: number;
  result: string;
}

/**
 * Augment that exposes a single `web_fetch` tool. The tool fetches a URL,
 * normalizes HTML to text, and renders a prompt-aware summary.
 *
 * The output string the model sees is JSON containing:
 *   { url, code, codeText, bytes, durationMs, result }
 *
 * Where `result` is a pre-formatted human-readable block the model can
 * reason about directly. Matches the Rust WebFetchOutput shape.
 */
export function webFetch(opts: WebFetchOptions = {}): Augment {
  const {
    client: customClient,
    headersByOrigin,
    urlPolicy: _ignoredUrlPolicy,
    rejectUnsafeUrls: _ignoredLegacyPolicy,
    resolveHostname: _ignoredResolver,
    defaultHeaders: legacyDefaultHeaders,
    ...httpOptions
  } = opts as WebFetchOptions &
    Partial<
      Pick<
        HttpClientOptions,
        "urlPolicy" | "rejectUnsafeUrls" | "resolveHostname" | "defaultHeaders"
      >
    >;
  if (legacyDefaultHeaders !== undefined) {
    throw new Error(
      "webFetch defaultHeaders are unsafe for model-selected URLs; use exact-origin headersByOrigin",
    );
  }
  const originHeaders = normalizeHeadersByOrigin(headersByOrigin);
  // web_fetch ingests model-supplied URLs, so its public-network policy is not
  // configurable. A custom client is an explicit transfer of this boundary to
  // the operator.
  const client =
    customClient ??
    createHttpClient({
      ...httpOptions,
      urlPolicy: "public",
    });

  const webFetchTool = defineTool({
    name: "web_fetch",
    description: "Fetch a URL, convert it into readable text, and answer a prompt about it.",
    category: "search",
    input: z.object({
      url: z.string().url(),
      prompt: z.string(),
    }),
    execute: async ({ url, prompt }, context) => {
      const startedAt = performance.now();
      let requestUrl: string;
      try {
        requestUrl = normalizeFetchUrl(url);
      } catch (error) {
        return JSON.stringify({
          error: `invalid URL: ${(error as Error).message}`,
        });
      }

      // SSRF guard is enforced by the underlying HttpClient — rejected URLs
      // throw and fall into the catch below, surfaced as a structured error.

      let response: HttpResponse;
      try {
        response = await client.get(requestUrl, {
          headers: originHeaders.get(new URL(requestUrl).origin),
          signal: context?.signal,
        });
      } catch (error) {
        return JSON.stringify({
          url: requestUrl,
          error: (error as Error).message,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }

      const normalized = normalizeFetchedContent(response.body, response.contentType);
      const result = summarizeWebFetch({
        url: response.finalUrl,
        prompt,
        content: normalized,
        rawBody: response.body,
        contentType: response.contentType,
      });

      const output: WebFetchResult = {
        url: response.finalUrl,
        code: response.status,
        codeText: response.statusText,
        bytes: new TextEncoder().encode(response.body).byteLength,
        durationMs: Math.round(performance.now() - startedAt),
        result,
      };
      return JSON.stringify(output);
    },
  });

  const adminInfo = async (): Promise<import("../../types").AdminInfoBlock> => ({
    augmentName: "web-fetch",
    title: "Web fetch",
    sections: [
      {
        kind: "keyValue",
        rows: [
          {
            label: "SSRF guard",
            value: opts.client ? "delegated (custom client)" : "on (public-network + DNS pinning)",
          },
          { label: "Timeout (ms)", value: String(opts.timeoutMs ?? 30000) },
          { label: "User agent", value: opts.userAgent ?? "(default)" },
        ],
      },
      {
        kind: "status",
        level: "ok",
        message: "Exposes one tool: web_fetch. Output is JSON with code/bytes/durationMs/result.",
      },
    ],
  });

  return {
    name: "web-fetch",
    type: "webFetch",
    category: "capabilities",
    adminInfo,
    tools: [webFetchTool],
  };
}

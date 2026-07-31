import { isSafeMailDetailPath } from "./mail-detail-path";

export interface MailDetailProxyContext {
  bearer: string;
  selfPort?: number;
  /** Test seam. Production always uses the platform fetch implementation. */
  fetchImpl?: MailDetailProxyFetch;
}

export type MailDetailProxyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "no-store, must-revalidate",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
} as const;
const MAX_MAIL_DETAIL_RESPONSE_BYTES = 17 * 1024 * 1024;

/**
 * Fetch an exact AgentMail creator-detail resource through the authenticated
 * Console boundary. The permanent bearer remains server-side and is sent only
 * to this process over loopback.
 */
export async function handleMailDetailProxy(
  req: Request,
  ctx: MailDetailProxyContext,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  const url = new URL(req.url);
  const paths = url.searchParams.getAll("path");
  if (
    paths.length !== 1 ||
    Array.from(url.searchParams.keys()).some((key) => key !== "path") ||
    !isSafeMailDetailPath(paths[0])
  ) {
    return privateJson({ error: "invalid mail detail path" }, 400);
  }
  if (!ctx.selfPort) {
    return privateJson({ error: "mail detail proxy unavailable" }, 503);
  }

  let upstream: Response;
  try {
    upstream = await (ctx.fetchImpl ?? fetch)(`http://127.0.0.1:${ctx.selfPort}${paths[0]}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ctx.bearer}`,
      },
      cache: "no-store",
      redirect: "manual",
      signal: req.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return new Response(null, { status: 499, headers: PRIVATE_RESPONSE_HEADERS });
    }
    return privateJson({ error: "mail detail upstream unavailable" }, 502);
  }

  let responseBody: Uint8Array<ArrayBuffer> | null;
  try {
    responseBody = await readBoundedBody(upstream, MAX_MAIL_DETAIL_RESPONSE_BYTES);
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return new Response(null, { status: 499, headers: PRIVATE_RESPONSE_HEADERS });
    }
    return privateJson({ error: "mail detail upstream response was invalid" }, 502);
  }

  const headers = new Headers(PRIVATE_RESPONSE_HEADERS);
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    await response.body.cancel();
    throw new Error("mail detail response exceeds the byte limit");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("mail detail response exceeds the byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      allow: "GET",
      "content-type": "application/json",
    },
  });
}

function privateJson(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      "content-type": "application/json",
    },
  });
}

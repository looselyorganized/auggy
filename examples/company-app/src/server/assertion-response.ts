const headers = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization, Origin",
  "x-content-type-options": "nosniff",
} as const;

export function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

export function methodNotAllowed(methods = "POST"): Response {
  const response = privateJson({ error: "method_not_allowed" }, 405);
  response.headers.set("allow", methods);
  return response;
}

/** A configured origin is an origin, never a URL silently reduced to one. */
export function requireHttpOrigin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > 2048 ||
    /[\p{Cc}\s\\]/u.test(value) ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(value)
  ) {
    throw new Error("An explicit HTTP(S) origin is required");
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("An explicit HTTP(S) origin is required");
  }
  return url.origin;
}

export function requireSameOriginPost(
  request: Request,
  configuredOrigin: unknown,
): Response | null {
  if (request.method !== "POST") return methodNotAllowed();
  let origin: string;
  try {
    origin = requireHttpOrigin(configuredOrigin);
  } catch {
    return privateJson({ error: "assertion_origin_unavailable" }, 503);
  }
  const site = request.headers.get("sec-fetch-site");
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("x-auggy-csrf-request") !== "1" ||
    (site !== null && site !== "same-origin")
  ) {
    return privateJson({ error: "csrf_forbidden" }, 403);
  }
  return null;
}

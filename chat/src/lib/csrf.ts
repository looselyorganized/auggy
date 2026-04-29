/**
 * CSRF guard for the chat package's GUI server.
 *
 * Browser tabs from arbitrary origins can fetch our localhost endpoints. Even
 * though same-origin policy blocks reading the response on cross-origin
 * requests with non-trivial content types, the side effect (the agent runs)
 * still fires. We must reject cross-origin POSTs by inspecting the Origin
 * header.
 *
 * GET requests with no Origin are tolerated — that's how the address bar and
 * curl behave. GET requests with cross-origin Origin are rejected (defensive).
 */

export function isLoopbackOrigin(origin: string | null | undefined, port: number): boolean {
  if (!origin) return false;
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  return allowed.includes(origin);
}

export type CsrfResult = { ok: true } | { ok: false; reason: string };

export function validateCsrf(req: Request, port: number): CsrfResult {
  const origin = req.headers.get("origin");
  const method = req.method.toUpperCase();

  if (method === "GET") {
    // Tolerate missing Origin on GET (address bar / curl). Reject only if
    // Origin is present and non-loopback.
    if (origin && !isLoopbackOrigin(origin, port)) {
      return { ok: false, reason: "cross-origin GET" };
    }
    return { ok: true };
  }

  // POST/PUT/DELETE require a loopback Origin AND application/json content-type.
  if (!isLoopbackOrigin(origin, port)) {
    return { ok: false, reason: "missing or cross-origin Origin on mutating request" };
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.startsWith("application/json")) {
    return { ok: false, reason: "non-JSON content-type on mutating request" };
  }
  return { ok: true };
}

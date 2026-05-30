import { isLoopback } from "../web-transport";
import { createHmac, randomBytes } from "node:crypto";

export interface AdminAuthContext {
  req: Request;
  bearer: string;
  agentName: string;
  callerIp: string;
  trustForwardedProto?: boolean;
}

export type AdminAuthResult =
  | { kind: "ok" }
  | { kind: "https-required"; response: Response }
  | { kind: "unauthorized"; response: Response };

const CONSOLE_SESSION_COOKIE = "auggy_console";
const CONSOLE_SESSION_MAX_AGE_SEC = 60 * 60 * 12;

/**
 * Validate HTTP Basic auth on a `/console` request + enforce HTTPS-on-non-loopback.
 *
 * Order of checks:
 *   1. HTTPS gate (loopback exempt; non-loopback http → 426 + guidance body)
 *   2. Loopback bypass: if the caller is on 127.0.0.1 / ::1, skip the bearer
 *      check entirely. Threat model: anyone with shell access to the host
 *      already has filesystem read on `.env` → already has the bearer, so the
 *      bearer-on-loopback check added friction without meaningful protection.
 *      Non-loopback callers (LAN, cloud, tunneled HTTPS) still get checked.
 *   3. HTTP Basic decode + bearer compare (timing-safe)
 *
 * The 426 fires BEFORE the 401 — a misconfigured deployment (non-loopback,
 * plain HTTP, with a valid bearer) still gets pushed to HTTPS rather than
 * succeeding insecurely.
 */
export function checkAdminAuth(ctx: AdminAuthContext): AdminAuthResult {
  const url = new URL(ctx.req.url);
  const forwardedProto = ctx.req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const isSecureRequest =
    url.protocol === "https:" || (ctx.trustForwardedProto === true && forwardedProto === "https");

  // 1. HTTPS gate
  if (!isLoopback(ctx.callerIp) && !isSecureRequest) {
    const port = url.port || "8080";
    const guidance = [
      `/console requires HTTPS on non-loopback addresses.`,
      ``,
      `Options:`,
      `  1. Configure HTTPS termination in front of this agent.`,
      `  2. Access via http://127.0.0.1:${port}/console from the agent host.`,
      `  3. SSH tunnel: ssh -L ${port}:127.0.0.1:${port} user@host`,
    ].join("\n");
    return {
      kind: "https-required",
      response: new Response(guidance, {
        status: 426,
        headers: {
          upgrade: "TLS/1.2",
          connection: "Upgrade",
          "content-type": "text/plain; charset=utf-8",
        },
      }),
    };
  }

  // 2. Loopback bypass — see doc comment above for rationale.
  if (isLoopback(ctx.callerIp)) {
    return { kind: "ok" };
  }

  const session = ctx.req.headers.get("cookie");
  if (session && verifyConsoleSessionCookie(session, ctx.bearer)) {
    return { kind: "ok" };
  }

  // 3. HTTP Basic check (non-loopback only)
  const authHeader = ctx.req.headers.get("authorization");
  if (!authHeader?.toLowerCase().startsWith("basic ")) {
    return unauthorized(ctx.agentName, shouldRedirectToLogin(ctx.req), ctx.req);
  }

  const b64 = authHeader.slice(6).trim();
  let decoded: string;
  try {
    decoded = atob(b64);
  } catch {
    return unauthorized(ctx.agentName, false, ctx.req);
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return unauthorized(ctx.agentName, false, ctx.req);
  const password = decoded.slice(colonIdx + 1);

  if (!timingSafeEqual(password, ctx.bearer)) {
    return unauthorized(ctx.agentName, false, ctx.req);
  }

  return { kind: "ok" };
}

export function createConsoleSessionSetCookie(args: {
  bearer: string;
  secure: boolean;
  now?: number;
}): string {
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  const payload = {
    sub: "operator",
    iat: nowSec,
    exp: nowSec + CONSOLE_SESSION_MAX_AGE_SEC,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const value = `${encodedPayload}.${signSessionPayload(encodedPayload, args.bearer)}`;
  return [
    `${CONSOLE_SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/console",
    `Max-Age=${CONSOLE_SESSION_MAX_AGE_SEC}`,
    args.secure ? "Secure" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

export function createConsoleSessionClearCookie(secure: boolean): string {
  return [
    `${CONSOLE_SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/console",
    "Max-Age=0",
    secure ? "Secure" : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function verifyConsoleSessionCookie(
  cookieHeader: string,
  bearer: string,
  now = Date.now(),
): boolean {
  const value = parseCookie(cookieHeader)[CONSOLE_SESSION_COOKIE];
  if (!value) return false;
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return false;
  if (!timingSafeEqual(signature, signSessionPayload(encodedPayload, bearer))) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf-8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record.sub !== "operator" || typeof record.exp !== "number") return false;
  return record.exp > Math.floor(now / 1000);
}

function signSessionPayload(encodedPayload: string, bearer: string): string {
  return createHmac("sha256", `auggy-console-session:${bearer}`)
    .update(encodedPayload)
    .digest("base64url");
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function shouldRedirectToLogin(req: Request): boolean {
  if (req.method !== "GET") return false;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/console/api/")) return false;
  if (url.pathname.startsWith("/console/action/")) return false;
  const accept = req.headers.get("accept") ?? "";
  return accept === "" || accept.includes("text/html") || accept.includes("*/*");
}

function unauthorized(agentName: string, redirectToLogin: boolean, req: Request): AdminAuthResult {
  if (redirectToLogin) {
    const reqUrl = new URL(req.url);
    const next = safeConsoleNext(reqUrl.pathname + reqUrl.search);
    return {
      kind: "unauthorized",
      response: new Response(null, {
        status: 303,
        headers: {
          location: `/console/login?next=${encodeURIComponent(next)}`,
          "cache-control": "no-store",
        },
      }),
    };
  }

  return {
    kind: "unauthorized",
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Basic realm="auggy-admin ${agentName} (username auggy, password AUGGY_WEB_TOKEN)"`,
      },
    }),
  };
}

function safeConsoleNext(value: string): string {
  if (value === "/console" || value.startsWith("/console/")) return value;
  return "/console";
}

const textEncoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

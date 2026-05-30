import { isLoopback } from "../web-transport";

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

  // 3. HTTP Basic check (non-loopback only)
  const authHeader = ctx.req.headers.get("authorization");
  if (!authHeader?.toLowerCase().startsWith("basic ")) {
    return unauthorized(ctx.agentName);
  }

  const b64 = authHeader.slice(6).trim();
  let decoded: string;
  try {
    decoded = atob(b64);
  } catch {
    return unauthorized(ctx.agentName);
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return unauthorized(ctx.agentName);
  const password = decoded.slice(colonIdx + 1);

  if (!timingSafeEqual(password, ctx.bearer)) {
    return unauthorized(ctx.agentName);
  }

  return { kind: "ok" };
}

function unauthorized(agentName: string): AdminAuthResult {
  return {
    kind: "unauthorized",
    response: new Response("", {
      status: 401,
      headers: {
        "www-authenticate": `Basic realm="auggy-admin ${agentName}"`,
      },
    }),
  };
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

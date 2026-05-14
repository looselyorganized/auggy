import type {
  Augment,
  PeerIdentity,
  TransportSpec,
  TransportKernel,
  TurnTrigger,
  InboundMessage,
  KernelEvent,
  Part,
} from "../types";
import {
  translateKernelEvent,
  serializeSSE,
  runFinished,
  runError,
  type AGUIEvent,
} from "./ag-ui-events";
import {
  deriveSigningKey,
  createVisitorToken,
  verifyVisitorToken,
  type VisitorTokenPayload,
} from "./visitor-token";
import { withTimeout, TimeoutError } from "../kernel/timeout";
import { resolveConfigBool } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAccessEntry {
  id: string;
  sharedSecret: string;
}

export interface WebTransportOptions {
  port: number;
  auth: { type: "bearer"; token: string };
  cors?: { origins: string[] };
  maxMessageLength?: number;
  /**
   * Admitted agent list. Each entry has an `id` (sent as `x-agent-id` header)
   * and a `sharedSecret` (sent as `x-agent-secret` header). The transport
   * does a timing-safe comparison before minting agent trust.
   */
  access?: { agents?: AgentAccessEntry[] };
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
  visitorTokens?: {
    enabled?: boolean;
    ttlSeconds?: number;
    signingKey?: string;
    /**
     * Optional real-time revocation check. Called after HMAC verification
     * succeeds (fix C1). When the callback returns `true` for a visitorId,
     * the token is treated as anonymous — rendering revoked tokens inert
     * without waiting for their HMAC TTL to expire.
     */
    revocationCheck?: (visitorId: string) => boolean;
    /**
     * Stable identifier for this agent used to scope visitor tokens (fix C2).
     * MUST match visitorAuth's `agentBinding` option. Default: `"auggy"`.
     * Tokens minted for a different agentBinding are rejected, preventing
     * cross-agent replay when two agents share the same signing key.
     *
     * Only enforce when explicitly configured — leaving this unset means the
     * default `"auggy"` is used, which matches the visitorAuth default.
     */
    agentBinding?: string;
  };
  /**
   * Optional URL to redirect GET / to. When set, `GET /` returns 302 to this URL.
   * When unset, `GET /` returns 404. All other routes are unaffected.
   *
   * Used by operators to point visitors arriving at the agent's bare URL toward
   * a polished frontend (LORF platform/chat, future spine visitor chat, custom).
   */
  publicFrontendUrl?: string;
  /**
   * Allow-list of upstream proxies whose `X-Forwarded-For` / `X-Real-IP`
   * headers are trusted for per-route per-IP rate limiting (F16).
   *
   * Each entry is an exact IP string (CIDR ranges are not yet supported —
   * v1 keeps it simple). When the connection's remote address matches an
   * entry, the first XFF / X-Real-IP value is trusted. When it does not,
   * the headers are IGNORED and the connection IP is used directly.
   *
   * Default: `[]` (default-secure). With no trusted proxy list, an
   * untrusted client could spoof their `X-Forwarded-For` header and
   * bypass per-IP rate limiting; the empty default forces operators to
   * declare their proxy chain explicitly. On the first request that
   * arrives with an XFF header AND no `trustedProxies` configured, a
   * single `console.warn` per startup nudges the operator with a
   * config hint (typical when deploying behind Railway / Fly /
   * Cloudflare for the first time).
   */
  trustedProxies?: string[];
  /**
   * Whether requests to `/agent/run` may proceed WITHOUT a bearer token.
   *
   * Precedence (most-explicit wins):
   *   1. This yaml value (when defined)
   *   2. Env var `AUGGY_ALLOW_ANONYMOUS` (strict "true" / "false")
   *   3. Default: `process.env.NODE_ENV !== "production"`
   *
   * When `true`, missing-bearer requests fall through to `identify()` and
   * are minted as `public:anonymous` (Path 4). The budgets augment caps
   * cost; visitorAuth — when mounted — provides the upgrade path to
   * recognized identity.
   *
   * When `false`, missing-bearer requests get 401.
   *
   * In ALL cases, a bearer that is PRESENT but invalid returns 401 (no
   * silent downgrade to anonymous, no timing leak).
   *
   * The default rule means production deploys (NODE_ENV=production on
   * Railway/Fly/etc.) are gated by default; local dev (NODE_ENV unset)
   * permits anonymous chat out of the box.
   */
  allowAnonymous?: boolean;
}

interface AGUIRunRequestBody {
  messages: Array<{ role: string; content: string }>;
  threadId?: string;
  contextId?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Body-size cap helper (Finding 2: byte-counted enforcement)
// ---------------------------------------------------------------------------

/**
 * Read a ReadableStream up to `cap` bytes. Returns the buffered Uint8Array on
 * success, or `null` if the stream exceeded the cap. Throws on stream errors.
 *
 * This is the byte-counted body cap enforcement (vs. trusting content-length).
 */
async function readBodyWithCap(
  body: ReadableStream<Uint8Array>,
  cap: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Caller-IP helper (Finding 3: per-IP rate limiting)
// ---------------------------------------------------------------------------

/**
 * Normalize an IP string. Strips the IPv4-mapped IPv6 prefix
 * (`::ffff:1.2.3.4` → `1.2.3.4`) so operators can list `"127.0.0.1"` in
 * `trustedProxies` without worrying about which form Bun's
 * `server.requestIP()` happens to return on a given platform/socket.
 *
 * Returns the input unchanged for any other shape. Exported for direct
 * unit testing — the IPv4-mapped form is hard to trigger reliably from
 * an integration test (Bun's localhost typically returns `::1` or
 * `127.0.0.1` directly).
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1]! : ip;
}

/**
 * Extract the caller's IP for rate-limit keying.
 *
 * F16 — only honors `x-forwarded-for` / `x-real-ip` when the connection's
 * remote address is on the configured `trustedProxies` allow-list. Without
 * this gate, an untrusted client could spoof XFF and skip per-IP rate
 * limiting. With the empty default `trustedProxies: []`, the headers are
 * always ignored and the connection IP is used directly.
 *
 * Even WITH a trusted proxy, the leftmost XFF entry cannot be trusted —
 * an attacker can pre-seed `X-Forwarded-For: spoofed` before connecting,
 * and an append-style proxy will produce
 * `X-Forwarded-For: spoofed, attacker-real-ip`. The leftmost is still
 * attacker-controlled. Standard fix (mirrors nginx, Express `trust proxy`):
 * walk right-to-left, dropping trusted-proxy hops as we go. The first
 * NON-trusted entry encountered is the actual client IP. If every entry
 * is on the trusted list (very unusual chain of internal hops), fall
 * through to the connection IP.
 *
 * The first time an XFF arrives WITHOUT `trustedProxies` configured (or
 * from a connection IP not on the list), `xffOnUntrusted` fires once per
 * startup — operators deploying behind a known proxy (Railway, Fly,
 * Cloudflare) get a clear hint to add the proxy IP rather than silently
 * degrading. Latched on XFF specifically (not X-Real-IP) so the warning
 * text matches the trigger.
 *
 * Returns `"unknown"` when no source resolves.
 */
function getCallerIp(
  req: Request,
  server: { requestIP?: (req: Request) => { address?: string } | null } | undefined,
  trustedProxies: readonly string[],
  xffOnUntrusted: () => void,
): string {
  const xff = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  let connIp: string | null = null;
  try {
    connIp = server?.requestIP?.(req)?.address ?? null;
  } catch {
    connIp = null;
  }
  const connIpNorm = normalizeIp(connIp);
  const proxiesNorm = trustedProxies.map((p) => normalizeIp(p) ?? p);
  const proxyIsTrusted = connIpNorm !== null && proxiesNorm.includes(connIpNorm);

  if (xff && !proxyIsTrusted) {
    // Warn-once: XFF arrived from an untrusted source. Almost certainly an
    // operator that hasn't configured trustedProxies after deploying behind
    // a proxy. Narrowed to XFF (not X-Real-IP) because the warning copy
    // names XFF specifically.
    xffOnUntrusted();
  }

  if (proxyIsTrusted && xff) {
    // Right-to-left walk. Drop entries that are themselves trusted proxies
    // (each such entry was a known intermediate hop). Return the first
    // non-trusted entry — that's the client IP under the standard
    // append-style XFF convention.
    const entries = xff
      .split(",")
      .map((s) => normalizeIp(s.trim()) ?? s.trim())
      .filter(Boolean);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (!proxiesNorm.includes(entry)) return entry;
    }
    // All XFF entries are themselves trusted proxies — chain consists
    // entirely of internal hops. Fall through to connIp (the immediate
    // peer, also a trusted proxy).
  }
  if (proxyIsTrusted && realIp) {
    // X-Real-IP is a single value set by the proxy (no append semantics);
    // trust it directly.
    return normalizeIp(realIp.trim()) ?? realIp.trim();
  }
  return connIpNorm ?? "unknown";
}

// ---------------------------------------------------------------------------
// Idempotency-Key validation
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(value);
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison (constant-time)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * Timing-safe equality check for two strings. Returns true iff they are
 * byte-for-byte identical. Both inputs are encoded before comparison so
 * the comparison always runs over the full longer length.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  // If lengths differ, we still walk the full longer length so timing
  // doesn't leak whether the prefix matched.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length; // non-zero if lengths differ
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * AG-UI-compatible HTTP transport.
 *
 * Endpoints:
 *  - POST /agent/run                   — AG-UI SSE endpoint
 *  - GET  /health                      — liveness check
 *  - GET  /.well-known/agent-card.json — Agent Card (via kernel.getAgentCard)
 *
 * ## Identity resolution — four paths (evaluated in order)
 *
 * Path 1 — Creator: bearer token matches `auth.token` AND no agent/visitor
 *   headers. Mints `{ trustLevel: "creator" }`.
 *
 * Path 2 — Agent: `x-agent-id` + `x-agent-secret` headers present. Looks
 *   up the agent in `opts.access.agents`; if the secret matches (timing-safe)
 *   mints `{ trustLevel: "agent" }`. Wrong secret → 401 (no silent downgrade).
 *
 * Path 3 — Public recognized: `x-visitor-token` with valid HMAC. Mints
 *   `{ trustLevel: "public", publicSubstate: "recognized" }`.
 *
 * Path 4 — Public anonymous: default. Mints
 *   `{ trustLevel: "public", publicSubstate: "anonymous" }`.
 *
 * ## Idempotency-Key
 *
 * When `Idempotency-Key` header is present, validated (1-128 chars,
 * `[A-Za-z0-9_-]`) and used as `turnId`. Absent → fresh UUID.
 * Malformed → HTTP 400.
 *
 * ## Rejected turns
 *
 * When the kernel rejects a turn with `errorClass: "cap-denied"`,
 * the SSE payload carries `code: "CAP_DENIED"`. For
 * `errorClass: "admission-state-failed"`, code is `"ADMISSION_FAILED"`.
 * HTTP status remains 200 for the SSE response in T4 — T5 will add the
 * synchronous gate-decision API that allows choosing 429/503 before
 * opening the stream.
 */
export function webTransport(opts: WebTransportOptions): Augment {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let kernel: TransportKernel | null = null;

  // PR γ.1 — augment-registered routes captured at register() time.
  // Empty until register fires; once populated, immutable for the server's lifetime.
  // Type matches TransportKernel.getAugmentRoutes(); runtime values are CollectedRoute
  // (which extends AugmentHttpRoute with augmentName) — we cast where needed.
  let augmentRoutes: readonly import("../types").AugmentHttpRoute[] = [];
  let augmentRouteMap: Map<string, import("../types").AugmentHttpRoute> = new Map();

  // PR γ.1 — per-route rate-limit state. Sliding-window timestamps keyed by
  // "<METHOD> <path>". NOT per-peer — auth-none routes have no peer.
  const routeHits = new Map<string, number[]>();

  // F16 — warn-once latch for "XFF arrived from untrusted connection".
  // The first time getCallerIp sees this condition without a configured
  // trustedProxies list (or with the connection IP not on the list), we
  // emit a single console.warn so operators deploying behind Railway / Fly /
  // Cloudflare for the first time get a clear hint to configure their
  // proxy chain. Latched per-instance so the warning isn't spammed every
  // request.
  const trustedProxies: readonly string[] = opts.trustedProxies ?? [];
  let xffUntrustedWarned = false;
  function xffOnUntrusted(): void {
    if (xffUntrustedWarned) return;
    xffUntrustedWarned = true;
    if (trustedProxies.length === 0) {
      console.warn(
        "[web-transport] X-Forwarded-For header received but trustedProxies is unset. " +
          "Per-IP rate limiting is using the connection IP, NOT the XFF header. " +
          "If you deploy behind a proxy (Railway, Fly, Cloudflare), set " +
          "webTransport.trustedProxies to the proxy IP(s) so the header is honored.",
      );
    } else {
      console.warn(
        "[web-transport] X-Forwarded-For header received from a connection IP that is " +
          "NOT on trustedProxies. The header is being ignored for rate limiting. " +
          `Configured trustedProxies: ${trustedProxies.join(", ")}.`,
      );
    }
  }

  // Lazy GC: every Nth call to checkRouteRateLimit, scan the routeHits map
  // and drop entries whose newest timestamp is outside the 60s window.
  // Bounded work per request keeps unique-caller entries from accumulating
  // forever. transport-queue.ts:36 evicts the looked-up key in-band; here
  // the analog needs a sweep because checkRouteRateLimit always touches the
  // current key, so other stale keys never get their own eviction trigger.
  let routeHitsTouchCount = 0;
  const ROUTE_HITS_GC_INTERVAL = 64;
  function gcStaleRouteHits(cutoff: number): void {
    for (const [key, hits] of routeHits) {
      if (hits.length === 0 || hits[hits.length - 1]! <= cutoff) {
        routeHits.delete(key);
      }
    }
  }

  function checkRouteRateLimit(
    routeKey: string,
    ip: string,
    max: number,
  ): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const fullKey = `${routeKey}|${ip}`;
    const now = Date.now();
    const windowStart = now - 60_000;
    if (++routeHitsTouchCount >= ROUTE_HITS_GC_INTERVAL) {
      routeHitsTouchCount = 0;
      gcStaleRouteHits(windowStart);
    }
    const hits = (routeHits.get(fullKey) ?? []).filter((t) => t > windowStart);
    if (hits.length >= max) {
      const oldestInWindow = hits[0]!;
      const retryAfterMs = oldestInWindow + 60_000 - now;
      routeHits.set(fullKey, hits);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    hits.push(now);
    routeHits.set(fullKey, hits);
    return { allowed: true };
  }

  const maxMessageLength = opts.maxMessageLength ?? 4000;
  // F2: visitor tokens are opt-in (enabled === true) rather than opt-out
  // (enabled !== false). Requiring an explicit signingKey at onBoot prevents
  // the silent mismatch where webTransport boots with an ephemeral key that
  // differs from the one visitorAuth uses to mint tokens. When configured via
  // the augment-resolver, visitorAuth's signingKey is auto-injected and
  // enabled is set to true. Direct callers must pass both explicitly.
  const visitorTokensEnabled = opts.visitorTokens?.enabled === true;
  const visitorTokenTtl = opts.visitorTokens?.ttlSeconds ?? 30 * 24 * 3600;
  let signingKey: CryptoKey | null = null;

  // Anonymous-public posture (G3 — concierge-readiness gate). Resolved once
  // at factory time across yaml > env > default precedence. The resolution
  // object carries `source` so the boot-time log line in `register()` can
  // tell the operator exactly why the agent is running in this posture.
  const allowAnonymousResolution = resolveConfigBool(
    opts.allowAnonymous,
    "AUGGY_ALLOW_ANONYMOUS",
    () => process.env.NODE_ENV !== "production",
  );
  const allowAnonymous = allowAnonymousResolution.value;

  // ---------------------------------------------------------------------------
  // Identity resolver — four paths
  // ---------------------------------------------------------------------------

  const identify = (raw: unknown): PeerIdentity | null => {
    const req = raw as {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __threadId?: string;
    };
    const headers = req.headers;
    const kind = (headers["x-peer-kind"] as PeerIdentity["kind"]) ?? "human";

    const agentId = headers["x-agent-id"];
    const agentSecret = headers["x-agent-secret"];
    const hasAgentHeaders = typeof agentId === "string" && typeof agentSecret === "string";

    // PATH 2: Agent credentials — present regardless of bearer auth.
    // If x-agent-id / x-agent-secret are both set, this is a deliberate
    // agent authentication attempt. A wrong secret MUST return null (→ 401),
    // not silently fall through to public.
    if (hasAgentHeaders) {
      const admittedAgents = opts.access?.agents ?? [];
      const entry = admittedAgents.find((a) => a.id === agentId);
      if (!entry || !timingSafeEqual(agentSecret, entry.sharedSecret)) {
        // Signal failed agent auth — the HTTP handler checks this sentinel.
        return null;
      }
      return {
        id: `agent:${agentId}`,
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 1: Creator — bearer-only request (no visitor token either).
    // The bearer token is already validated by the HTTP handler before identify()
    // is called. If there's no visitor token, this is a direct creator call.
    if (!req.__visitorPayload && !headers["x-visitor-token"]) {
      return {
        id: "creator",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 3: Public recognized — visitor token was verified before identify() is called.
    if (req.__visitorPayload) {
      return {
        id: req.__visitorPayload.visitorId,
        kind,
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 4: Public anonymous — no agent headers, no verified visitor token.
    // Use the threadId from the request body (injected as __threadId) for the peer ID.
    const threadId = req.__threadId ?? crypto.randomUUID();
    return {
      id: `anon-${threadId}`,
      kind,
      trustLevel: "public",
      publicSubstate: "anonymous",
      sourceAugment: "web",
      displayName: headers["x-peer-name"],
      orgId: headers["x-org-id"],
    };
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel, _augmentName: string) {
      kernel = k;
      augmentRoutes = k.getAugmentRoutes();
      augmentRouteMap = new Map();
      let visitorAuthMounted = false;
      for (const r of augmentRoutes) {
        augmentRouteMap.set(`${r.method} ${r.path}`, r);
        // Operator-visible audit: log every auth: "none" route so an operator
        // grepping the boot log can spot unauthenticated surfaces.
        // Runtime values are CollectedRoute (extends AugmentHttpRoute with augmentName).
        const augmentName = (r as { augmentName?: string }).augmentName ?? "(unknown)";
        if (augmentName === "visitor-auth") visitorAuthMounted = true;
        if (r.auth === "none") {
          console.warn(
            `[web-transport] augment "${augmentName}" registered ${r.method} ${r.path} with auth: "none" — public, unauthenticated.`,
          );
        }
      }

      // Operator-facing posture line. Always emitted so operators always see
      // the resolved value AND its source. Source detail helps distinguish
      // "I set this in yaml" from "Railway set NODE_ENV=production for me".
      const sourceDetail =
        allowAnonymousResolution.source === "env"
          ? `env, AUGGY_ALLOW_ANONYMOUS=${process.env.AUGGY_ALLOW_ANONYMOUS}`
          : allowAnonymousResolution.source === "default"
            ? `default, NODE_ENV=${process.env.NODE_ENV ?? "unset"}`
            : "yaml";
      console.log(`[web-transport] allowAnonymous=${allowAnonymous} (source: ${sourceDetail})`);

      // visitorAuth-missing warning. Fires only when allowAnonymous=true via
      // default or env — i.e., the operator hasn't explicitly chosen this in
      // yaml. If they wrote `allowAnonymous: true` in yaml, they've signaled
      // intent and we don't second-guess.
      if (allowAnonymous && !visitorAuthMounted && allowAnonymousResolution.source !== "yaml") {
        console.warn(
          `[web-transport] WARNING: allowAnonymous=true but visitor-auth augment is not mounted. ` +
            `Anonymous visitors have no documented upgrade path to recognized identity. ` +
            `Consider \`auggy add visitor-auth\`. To suppress this warning explicitly, ` +
            `set \`allowAnonymous: true\` in agent.yaml (you are doing this on purpose).`,
        );
      }
    },
    identify,
    concurrency: opts.concurrency ?? 1,
    maxQueueDepth: opts.maxQueueDepth ?? 50,
    rateLimitPerPeer: opts.rateLimitPerPeer,
  };

  function isValidAuth(header: string): boolean {
    const expected = `Bearer ${opts.auth.token}`;
    // Use timing-safe comparison to prevent token extraction via timing side-channel.
    return timingSafeEqual(header, expected);
  }

  async function handleAgentRun(req: Request): Promise<Response> {
    const authHeader = req.headers.get("authorization") ?? "";
    // Bearer policy:
    //   - bearer present + valid   → proceed (Path 1 creator, or
    //                                Path 2/3 via the agent/visitor headers
    //                                resolved later in identify())
    //   - bearer present + invalid → 401 (timing-safe; no silent downgrade)
    //   - bearer absent + allowAnonymous=true  → fall through to identify(),
    //                                            Path 4 mints public:anonymous
    //   - bearer absent + allowAnonymous=false → 401
    const hasBearerAttempt = authHeader.length > 0;
    if (hasBearerAttempt) {
      if (!isValidAuth(authHeader)) {
        return json({ error: "unauthorized" }, 401);
      }
    } else if (!allowAnonymous) {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Idempotency-Key ---
    let turnId: string;
    const idempotencyKey = req.headers.get("idempotency-key");
    if (idempotencyKey !== null) {
      if (!validateIdempotencyKey(idempotencyKey)) {
        return json(
          {
            error: "invalid_idempotency_key",
            reason: "Idempotency-Key must be 1–128 characters matching [A-Za-z0-9_-]",
          },
          400,
        );
      }
      turnId = idempotencyKey;
    } else {
      turnId = crypto.randomUUID();
    }

    // --- Visitor token handling ---
    let visitorPayload: VisitorTokenPayload | null = null;
    let newToken: string | null = null;

    if (visitorTokensEnabled && signingKey) {
      const tokenHeader = req.headers.get("x-visitor-token");
      if (tokenHeader) {
        visitorPayload = await verifyVisitorToken(signingKey, tokenHeader);
        // Fix C1: reject tokens whose visitor has since been revoked.
        // Called after HMAC verification succeeds so revoked identities cannot
        // continue to authenticate with old tokens until the HMAC TTL expires.
        if (visitorPayload) {
          if (opts.visitorTokens?.revocationCheck?.(visitorPayload.visitorId)) {
            visitorPayload = null;
          }
        }
        // Fix C2: reject tokens minted for a different agentBinding.
        // Only enforced when agentBinding is explicitly configured; leaving it
        // unset skips the check for backward compatibility.
        if (visitorPayload) {
          const expectedBinding = opts.visitorTokens?.agentBinding;
          if (expectedBinding !== undefined && visitorPayload.agentId !== expectedBinding) {
            visitorPayload = null;
          }
        }
      }
      if (!visitorPayload) {
        // Check if this looks like an agent auth attempt — don't issue visitor
        // tokens to agent-credential requests (they'll be resolved as agent/creator).
        const agentId = req.headers.get("x-agent-id");
        const agentSecret = req.headers.get("x-agent-secret");
        const hasAgentHeaders = agentId !== null && agentSecret !== null;
        const hasVisitorTokenAttempt = tokenHeader !== null;

        if (hasVisitorTokenAttempt && !hasAgentHeaders) {
          // Had a visitor token header but it was invalid or missing — mint a fresh
          // token to send in the response so the recipient has a valid token for their
          // NEXT request. Do NOT assign issued.payload to visitorPayload here: the
          // current request presented either no token or a bad one, so it stays
          // public:anonymous. The freshly-issued token is for future requests only.
          //
          // Fix C2: use agentBinding when configured, else agent-card name.
          // This ensures the anon-token and the visitorAuth-minted token agree on
          // the agentId embedded in the payload, enabling the agentBinding check below.
          const agentName =
            opts.visitorTokens?.agentBinding ?? kernel?.getAgentCard()?.provider?.name ?? "auggy";
          const issued = await createVisitorToken(signingKey, agentName, visitorTokenTtl);
          newToken = issued.token;
          // visitorPayload intentionally left null — this request is anonymous.
        }
        // hasAgentHeaders case: no visitor token for agent requests.
      }
    }

    // --- Build headers map ---
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    // --- Parse body (needed for threadId for anonymous peer ID) ---
    let body: AGUIRunRequestBody;
    try {
      body = (await req.json()) as AGUIRunRequestBody;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: "messages array is required" }, 400);
    }

    const lastMessage = body.messages[body.messages.length - 1]!;
    const text = lastMessage.content ?? "";
    if (text.length > maxMessageLength) {
      return json({ error: "message too long", limit: maxMessageLength }, 413);
    }

    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }

    // Derive threadId — needed before identify() so anonymous peer IDs are stable.
    const threadId = body.threadId ?? body.contextId ?? crypto.randomUUID();

    // Build identify argument. Inject __threadId so the anonymous path can use it.
    const identifyArg: {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __threadId: string;
    } = { headers, __threadId: threadId };
    if (visitorPayload) {
      identifyArg.__visitorPayload = visitorPayload;
    }

    // --- Check agent auth failure explicitly ---
    // If x-agent-id + x-agent-secret are present, identify() returns null on bad secret.
    const agentIdHeader = req.headers.get("x-agent-id");
    const agentSecretHeader = req.headers.get("x-agent-secret");
    const isAgentAttempt = agentIdHeader !== null && agentSecretHeader !== null;

    const peer = identify(identifyArg);
    if (!peer) {
      if (isAgentAttempt) {
        // Explicit agent auth attempt with wrong credentials.
        return json({ error: "invalid agent credentials" }, 401);
      }
      // Fallback (should not happen with the four-path design, but guard).
      return json({ error: "missing peer identity" }, 400);
    }

    const parts: Part[] = [{ kind: "text", text }];
    const inbound: InboundMessage = {
      parts,
      sourceAugment: "web",
      peer,
      timestamp: Date.now(),
      contextId: body.contextId,
      taskId: body.taskId,
    };
    const trigger: TurnTrigger = {
      type: "message",
      turnId,
      threadId,
      contextId: body.contextId,
      taskId: body.taskId,
      timestamp: Date.now(),
      source: "web",
      peer,
      payload: inbound,
    };

    const k = kernel;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let streamClosed = false;

        const patchThreadId = (e: AGUIEvent): AGUIEvent => {
          if (e.type === "RUN_FINISHED" && !e.threadId) {
            // Spread to preserve `result` (and any future fields) the
            // translator attaches; only the threadId needs patching.
            return { ...e, threadId };
          }
          return e;
        };

        const writeEvent = (e: AGUIEvent) => {
          if (streamClosed) return; // guard against enqueue after close
          try {
            controller.enqueue(encoder.encode(serializeSSE(patchThreadId(e))));
          } catch {
            // Stream already closed (client disconnect) — swallow
            streamClosed = true;
          }
        };

        const onEvent = (kernelEvent: KernelEvent) => {
          for (const e of translateKernelEvent(kernelEvent)) {
            writeEvent(e);
          }
        };

        (async () => {
          try {
            const result = await k.handleInbound(trigger, { onEvent });
            if (result.status === "rejected") {
              // Map errorClass to a structured code for SSE consumers.
              // T5 will refine this to return 429/503 HTTP status before
              // opening the stream (requires a synchronous gate-decision API).
              let code: string;
              if (result.errorClass === "cap-denied") {
                code = "CAP_DENIED";
              } else if (result.errorClass === "admission-state-failed") {
                code = "ADMISSION_FAILED";
              } else {
                code = "REJECTED";
              }
              writeEvent(
                runError({
                  message: result.errorResponse ?? "request rejected by transport",
                  code,
                }),
              );
              writeEvent(runFinished({ threadId, runId: trigger.turnId, status: result.status }));
            }
          } catch (err) {
            writeEvent(runError({ message: String(err), code: "INTERNAL" }));
            writeEvent(runFinished({ threadId, runId: trigger.turnId, status: "failed" }));
          } finally {
            streamClosed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
    });

    const sseHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (newToken) {
      sseHeaders["x-visitor-token"] = newToken;
    }
    if (opts.cors) {
      sseHeaders["access-control-allow-origin"] = opts.cors.origins.join(",");
      sseHeaders["access-control-expose-headers"] = "x-visitor-token, idempotency-key";
    }
    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  function handleCorsPreFlight(): Response {
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, x-peer-id, x-peer-kind, x-peer-name, x-org-id, x-visitor-token, x-agent-id, x-agent-secret, idempotency-key",
      "access-control-expose-headers": "x-visitor-token, idempotency-key",
      "access-control-max-age": "86400",
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = opts.cors.origins.join(",");
    }
    return new Response(null, { status: 204, headers });
  }

  function handleHealth(): Response {
    return json({ status: "healthy" }, 200);
  }

  function handleAgentCard(): Response {
    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }
    return json(kernel.getAgentCard(), 200);
  }

  function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extraHeaders,
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = opts.cors.origins.join(",");
    }
    return new Response(JSON.stringify(body), { status, headers });
  }

  return {
    name: "web",
    capabilities: ["transport"],
    transport,
    async onBoot() {
      if (visitorTokensEnabled) {
        const keySource = opts.visitorTokens?.signingKey;
        if (!keySource) {
          throw new Error(
            "[web-transport] visitorTokens.enabled is true but signingKey is not set. " +
              "If visitorAuth is mounted, the resolver should inject this automatically — file an issue if you see this. " +
              "Otherwise, mount visitorAuth (which is the augment that mints visitor tokens) or set visitorTokens.enabled: false explicitly.",
          );
        }
        signingKey = await deriveSigningKey(keySource);
      }
      server = Bun.serve({
        port: opts.port,
        idleTimeout: 120, // 120s — covers long model calls + tool chains
        async fetch(req, server) {
          const url = new URL(req.url);

          // CORS preflight — required for browser-based AG-UI clients
          if (req.method === "OPTIONS") {
            return handleCorsPreFlight();
          }

          // GET / — optional redirect to operator-configured publicFrontendUrl
          if (req.method === "GET" && url.pathname === "/") {
            if (opts.publicFrontendUrl) {
              return Response.redirect(opts.publicFrontendUrl, 302);
            }
            return new Response("Not Found", { status: 404 });
          }

          if (req.method === "POST" && url.pathname === "/agent/run") {
            return handleAgentRun(req);
          }
          if (req.method === "GET" && url.pathname === "/health") {
            return handleHealth();
          }
          if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
            return handleAgentCard();
          }

          // PR γ.1 — augment-registered routes. Dispatched by exact (method, path).
          const augmentRoute = augmentRouteMap.get(`${req.method} ${url.pathname}`);
          if (augmentRoute) {
            // Finding 4: Default-deny — anything not explicitly "none" requires bearer.
            // The collector rejects unknown auth values at boot, but defense in depth
            // keeps dispatch fail-closed against runtime mutations.
            if (augmentRoute.auth !== "none") {
              const authHeader = req.headers.get("authorization") ?? "";
              if (!isValidAuth(authHeader)) {
                return json({ error: "unauthorized" }, 401);
              }
            }
            // auth: "none" — no check; fall through to body cap

            // Finding 2 — body-size cap. Buffer the request body up to maxBodyBytes
            // bytes, enforcing actual byte-count (not just content-length header).
            // Adversarial clients can omit content-length or use chunked encoding
            // to bypass a header-only check.
            const maxBodyBytes = augmentRoute.maxBodyBytes ?? 1_048_576;
            let dispatchReq: Request = req;
            if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
              try {
                const buffered = await readBodyWithCap(req.body, maxBodyBytes);
                if (buffered === null) {
                  return json({ error: "payload-too-large" }, 413);
                }
                // Reconstruct the Request with the buffered body so the handler
                // sees the same bytes (and can call req.text(), req.json(), etc).
                dispatchReq = new Request(req.url, {
                  method: req.method,
                  headers: req.headers,
                  body: buffered,
                });
              } catch (_err) {
                // Body read errors are 400 — caller's problem, not ours.
                return json({ error: "bad-body" }, 400);
              }
            }

            // Finding 3 — per-route rate limit keyed by route + caller IP.
            // Prevents one client from exhausting the bucket for everyone.
            if (augmentRoute.rateLimit) {
              const routeKey = `${augmentRoute.method} ${augmentRoute.path}`;
              const ip = getCallerIp(req, server, trustedProxies, xffOnUntrusted);
              const rl = checkRouteRateLimit(routeKey, ip, augmentRoute.rateLimit.maxPerMinute);
              if (!rl.allowed) {
                return json({ error: "rate-limited" }, 429, {
                  "retry-after": String(rl.retryAfterSec),
                });
              }
            }

            try {
              // Finding 1 — AbortController for cooperative cancellation on timeout.
              // The controller fires on timeout so handlers that listen to the signal
              // can bail out of side-effecting work instead of continuing after 504.
              const timeoutMs = augmentRoute.timeoutMs ?? 30_000;
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), timeoutMs);
              try {
                return await withTimeout(
                  () => augmentRoute.handler(dispatchReq, { signal: controller.signal }),
                  timeoutMs,
                );
              } finally {
                clearTimeout(timer);
              }
            } catch (err) {
              if (err instanceof TimeoutError) {
                return json({ error: "timeout" }, 504);
              }
              const augmentName =
                (augmentRoute as { augmentName?: string }).augmentName ?? "unknown";
              console.error(
                `[web-transport] augment "${augmentName}" handler ${augmentRoute.method} ${augmentRoute.path} threw: ${(err as Error).message}`,
              );
              return json({ error: "internal" }, 500);
            }
          }

          // Method-mismatch detection: if any registered augment route matches
          // the path but a different method, return 405 with Allow header listing
          // all methods supported for that path (RFC 9110 §15.5.6).
          const allowedMethods = augmentRoutes
            .filter((r) => r.path === url.pathname && r.method !== req.method)
            .map((r) => r.method);
          if (allowedMethods.length > 0) {
            return new Response("Method Not Allowed", {
              status: 405,
              headers: { allow: allowedMethods.join(", ") },
            });
          }

          return new Response("Not Found", { status: 404 });
        },
      });
    },
    async onShutdown() {
      if (server) {
        server.stop();
        server = null;
      }
    },
  };
}

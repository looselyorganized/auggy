import type {
  Augment,
  AugmentHttpRoute,
  AugmentHttpRouteAuth,
  CreatorConfig,
  DelegatedAuthorizationDeniedAuditEvent,
  PeerIdentity,
  RouteAuthContext,
  RouteAgentAuthContext,
  RouteVisitorAuthContext,
  RouteVisitorIdentity,
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
import { deriveSigningKey, verifyVisitorToken, type VisitorTokenPayload } from "./visitor-token";
import { createAnonymousSessionManager } from "./anonymous-session";
import {
  createWebIdempotencyStore,
  hashIdempotencyBinding,
  hashIdempotencyKey,
  type IdempotencyClaim,
  type RateLimitPolicy,
  type WebIdempotencyStore,
} from "./idempotency-store";
import {
  externalAuthClaimsToRouteContext,
  verifyExternalAuthAssertion,
  type ExternalAuthAssertionSecret,
  type ExternalAuthPrincipalOptions,
  type ExternalAuthReplayStore,
} from "../auth/external-auth";
import {
  delegatedAuthorizationDeniedAuditEvent,
  delegatedAuthorizationForbiddenErrorBody,
  evaluateDelegatedAuthorization,
  visitorAuthRequiredErrorBody,
} from "../authz/delegated-authorization";
import { validateRouteWebhookPolicyConfig, verifyRouteWebhookPolicy } from "./webhook-policy";
import { withTimeout, TimeoutError } from "../kernel/timeout";
import { matchRoutePath, parseRoutePattern } from "../kernel/route-pattern";
import { resolveConfigBool } from "../config";
import {
  readOverrides,
  releaseAdminOverrideRoot,
  retainAdminOverrideRoot,
  writeOverrides,
} from "../lib/admin-overrides";
import type { AdminActionResult, AdminInfoBlock } from "../types";
import {
  type AdminActionRegistry,
  buildAdminActionRegistry,
  handleAdminRoute,
  resolveDistDir,
} from "./admin/index";
import {
  releaseManagedRoot,
  retainManagedRoot,
  supportsManagedFileIsolation,
} from "./admin/admin-managed-files";
import { renderAgentIntegrationPage, renderInfoPage } from "./info-page";
import {
  createConsoleChatStore,
  createDeferredConsoleThreadHistoryPersistence,
  isConsoleChatThreadDeletedError,
  type ConsoleChatModelSnapshot,
  type ConsoleChatPreviewMode,
  type ConsoleChatStore,
  type ConsoleChatToolCall,
} from "./admin/console-chat-store";
import {
  buildConsoleAllowedOrigins,
  compileTrustedProxyNetworks,
  evaluateConsoleRequest,
  resolveForwardedRequest,
  type TrustedProxyNetworks,
} from "./console-request-security";
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  InvalidRequestBodyError,
  readRequestBodyJson,
  RequestBodyTooLargeError,
} from "./request-body";

const PUBLIC_PAGE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const DEFAULT_EXTERNAL_AUTH_ASSERTION_HEADER = "x-auggy-auth-assertion";
const CONSOLE_INTERNAL_RUN_HEADER = "x-auggy-console-internal";
const ANONYMOUS_SESSION_HEADER = "x-auggy-anonymous-session";
const ANONYMOUS_SESSION_STATUS_HEADER = "x-auggy-anonymous-session-status";
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_EXTERNAL_AUTH_HEADERS = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
  "x-agent-id",
  "x-agent-secret",
  ANONYMOUS_SESSION_HEADER,
  ANONYMOUS_SESSION_STATUS_HEADER,
  CONSOLE_INTERNAL_RUN_HEADER,
  "x-org-id",
  "x-peer-id",
  "x-peer-kind",
  "x-peer-name",
  "x-visitor-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

function withConsoleBoundaryHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAccessEntry {
  id: string;
  sharedSecret: string;
}

export interface WebTransportExternalAuthOptions extends ExternalAuthPrincipalOptions {
  secret: string;
  keyId?: string;
  secrets?: readonly ExternalAuthAssertionSecret[];
  replayProtection?: {
    enabled?: boolean;
    store?: ExternalAuthReplayStore;
  };
  /**
   * Expected assertion audience. Defaults to the transport security namespace
   * (securityNamespace, visitorTokens.agentBinding, then registered agent
   * name).
   */
  audience?: string;
  /**
   * Header carrying the app-server minted assertion. Default:
   * `x-auggy-auth-assertion`.
   */
  header?: string;
  allowedProviders?: readonly string[];
  maxTtlSeconds?: number;
}

function validateExternalAuthRuntimeOptions(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[web-transport] externalAuth must be an object.");
  }
  const config = value as Record<string, unknown>;
  if (typeof config.secret !== "string" || config.secret.trim() === "") {
    throw new Error(
      "[web-transport] externalAuth.secret is required and must be a non-empty string.",
    );
  }
  for (const field of ["keyId", "audience"] as const) {
    if (
      config[field] !== undefined &&
      (typeof config[field] !== "string" || config[field].trim() === "")
    ) {
      throw new Error(`[web-transport] externalAuth.${field} must be a non-empty string.`);
    }
  }
  if (config.header !== undefined) {
    if (typeof config.header !== "string") {
      throw new Error("[web-transport] externalAuth.header must be a string.");
    }
    const header = config.header.trim().toLowerCase();
    if (
      !header ||
      !HTTP_HEADER_NAME.test(header) ||
      !header.startsWith("x-") ||
      RESERVED_EXTERNAL_AUTH_HEADERS.has(header)
    ) {
      throw new Error(
        "[web-transport] externalAuth.header must be a non-reserved x-* HTTP header name.",
      );
    }
  }
  if (
    config.maxTtlSeconds !== undefined &&
    (!Number.isSafeInteger(config.maxTtlSeconds) || (config.maxTtlSeconds as number) <= 0)
  ) {
    throw new Error(
      "[web-transport] externalAuth.maxTtlSeconds must be a positive integer when configured.",
    );
  }
  if (config.allowedProviders !== undefined) {
    if (
      !Array.isArray(config.allowedProviders) ||
      config.allowedProviders.length === 0 ||
      config.allowedProviders.some(
        (provider) => typeof provider !== "string" || provider.trim() === "",
      ) ||
      new Set(config.allowedProviders).size !== config.allowedProviders.length
    ) {
      throw new Error(
        "[web-transport] externalAuth.allowedProviders must be a non-empty array of unique, non-empty strings.",
      );
    }
  }
  if (config.secrets !== undefined) {
    if (
      !Array.isArray(config.secrets) ||
      config.secrets.some(
        (entry) => entry === null || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      throw new Error("[web-transport] externalAuth.secrets must be an array of secret objects.");
    }
    for (const value of config.secrets) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.secret !== "string" || entry.secret.trim() === "") {
        throw new Error(
          "[web-transport] externalAuth.secrets entries require a non-empty string secret.",
        );
      }
      if (
        entry.keyId !== undefined &&
        (typeof entry.keyId !== "string" || entry.keyId.trim() === "")
      ) {
        throw new Error(
          "[web-transport] externalAuth.secrets keyId must be a non-empty string when configured.",
        );
      }
    }
  }
  if (
    config.includeUnverifiedEmail !== undefined &&
    typeof config.includeUnverifiedEmail !== "boolean"
  ) {
    throw new Error("[web-transport] externalAuth.includeUnverifiedEmail must be a boolean.");
  }
  if (
    config.visitorId !== undefined &&
    !(
      (typeof config.visitorId === "string" && config.visitorId.trim() !== "") ||
      typeof config.visitorId === "function"
    )
  ) {
    throw new Error(
      "[web-transport] externalAuth.visitorId must be a non-empty string or function.",
    );
  }

  const replayProtection = config.replayProtection;
  if (
    replayProtection !== undefined &&
    (replayProtection === null ||
      typeof replayProtection !== "object" ||
      Array.isArray(replayProtection))
  ) {
    throw new Error("[web-transport] externalAuth.replayProtection must be an object.");
  }
  if (replayProtection === undefined) return;
  const replay = replayProtection as Record<string, unknown>;
  if (typeof replay.enabled !== "boolean") {
    throw new Error(
      "[web-transport] externalAuth.replayProtection.enabled must be a boolean when replayProtection is configured.",
    );
  }
  if (replay.store !== undefined && replay.enabled !== true) {
    throw new Error("[web-transport] externalAuth.replayProtection.store requires enabled: true.");
  }
  if (replay.enabled !== true) return;
  if (replay.store === undefined) {
    throw new Error(
      "[web-transport] externalAuth.replayProtection requires an explicit atomic store. " +
        "Use createInMemoryExternalAuthReplayStore() only for a documented single-process development deployment.",
    );
  }
  if (
    replay.store === null ||
    typeof replay.store !== "object" ||
    typeof (replay.store as { consume?: unknown }).consume !== "function"
  ) {
    throw new Error(
      "[web-transport] externalAuth.replayProtection.store must provide consume(jti, expiresAt, now).",
    );
  }
}

export interface WebTransportOptions {
  port: number;
  auth: { type: "bearer"; token: string };
  cors?: { origins: [string] };
  /**
   * Stable deployment identity used to scope anonymous capabilities and the
   * idempotency ledger. Replicas of one logical agent must share it; unrelated
   * agents sharing storage or credentials must use different values. Defaults
   * to visitorTokens.agentBinding, then the registered agent name.
   */
  securityNamespace?: string;
  maxMessageLength?: number;
  /** Maximum encoded bytes accepted by POST /agent/run. Default 1 MiB. */
  maxRequestBodyBytes?: number;
  /** Maximum pending live SSE bytes for a slow client. Default 1 MiB. */
  maxPendingSseBytes?: number;
  /** Maximum pending live SSE events for a slow client. Default 1,024. */
  maxPendingSseEvents?: number;
  /** Maximum persisted console aggregate bytes per run. Default 4 MiB. */
  maxConsoleRunBytes?: number;
  /**
   * Admitted agent list. Each entry has an `id` (sent as `x-agent-id` header)
   * and a `sharedSecret` (sent as `x-agent-secret` header). The transport
   * does a timing-safe comparison before minting agent trust.
   */
  access?: { agents?: AgentAccessEntry[] };
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: {
    maxPerMinute: number;
    /**
     * Anonymous callers also consume a network-prefix and deployment-global
     * execution budget so minting sessions cannot multiply the peer limit.
     * The default `shared-store` mode requires a durable idempotency database.
     */
    anonymousNetwork?: {
      mode?: "shared-store" | "trusted-edge" | "single-process-development";
      /** IPv6 aggregation prefix. Defaults to /64 and may only be stricter. */
      ipv6PrefixBits?: number;
      /** Deployment-wide anonymous executions per minute. Defaults to 100x the peer limit. */
      globalMaxPerMinute?: number;
    };
  };
  visitorTokens?: {
    enabled?: boolean;
    signingKey?: string;
    /**
     * Optional real-time revocation check. Called after HMAC verification
     * succeeds (fix C1). When the callback returns `true` for a visitorId,
     * the token is treated as anonymous — rendering revoked tokens inert
     * without waiting for their HMAC TTL to expire.
     */
    revocationCheck?: (visitorId: string) => boolean;
    /**
     * Optional visitor-auth metadata lookup. The signed token intentionally
     * carries only a stable visitor id; this hook lets route handlers receive
     * email / verification metadata from visitorAuth without putting PII in the
     * browser token.
     */
    identityLookup?: (
      visitorId: string,
    ) => Omit<RouteVisitorIdentity, "agentId" | "issuedAt" | "expiresAt"> | null;
    /**
     * Authorize an anonymous console thread's one-way promotion after the
     * visitor consumed a magic link issued from that exact thread.
     */
    threadPromotionCheck?: (visitorId: string, threadId: string) => boolean;
    /**
     * Stable identifier for this agent used to scope visitor tokens (fix C2).
     * MUST match visitorAuth's `agentBinding` option. Defaults to
     * securityNamespace, then the registered agent name.
     * Tokens minted for a different agentBinding are rejected, preventing
     * cross-agent replay when two agents share the same signing key.
     *
     * The binding is always enforced. Direct visitorAuth integrations should
     * configure both sides explicitly so renaming cannot strand issued tokens.
     */
    agentBinding?: string;
  };
  /**
   * Provider-agnostic app/session auth bridge. An application backend verifies
   * Clerk, Supabase Auth, Auth0, or custom session state, mints a short-lived
   * Auggy external auth assertion, and the browser sends it on app-backed
   * Auggy requests. Valid assertions normalize to public/recognized visitor
   * identity; they never grant creator or agent trust.
   */
  externalAuth?: WebTransportExternalAuthOptions;
  /**
   * Best-effort structured audit hook for delegated authorization denials on
   * augment routes and protected tools. Payloads include denial metadata and
   * verified external-auth claim identifiers only; assertion tokens, secrets,
   * and raw request headers are never passed.
   */
  onDelegatedAuthorizationDenied?: (event: DelegatedAuthorizationDeniedAuditEvent) => void;
  /**
   * Optional URL to redirect GET / to. When set, `GET /` returns 302 to this URL.
   * When unset, `GET /` returns 404. All other routes are unaffected.
   *
   * Used by operators to point visitors arriving at the agent's bare URL toward
   * a polished frontend (LORF platform/chat, future spine visitor chat, custom).
   */
  publicFrontendUrl?: string;
  /**
   * Opt-in public developer discovery. Default: false.
   *
   * When true, GET /agent serves a conservative public developer surface and
   * GET /.well-known/agent-card.json is public. When false, /agent returns
   * 404 and the agent card requires the web bearer token.
   */
  publicIntegration?: boolean;
  /**
   * Allow-list of upstream proxies whose `X-Forwarded-For` / `X-Real-IP`
   * headers are trusted for per-route per-IP rate limiting (F16).
   *
   * Each entry is an exact IP string or a bounded IPv4/IPv6 CIDR. When the
   * connection's remote address matches an
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
   * Exact browser origins allowed to reach the operator console.
   *
   * Local origins for localhost, 127.0.0.1, and ::1 on `port` are included
   * automatically. `AUGGY_PUBLIC_URL`, when valid, also contributes its
   * origin. Public deployments should set this list explicitly and configure
   * `trustedProxies` for every terminating proxy network.
   */
  consoleSecurity?: {
    allowedOrigins?: string[];
  };
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
  /**
   * G36 — opt-out flag for the built-in /console route. Default: `true`.
   * When `false`, GET/POST /console and POST /console/action/* all return 404
   * (no signal that console exists when disabled). Useful for embedded /
   * headless deploys, operators with a custom console, or security-conscious
   * setups that don't want HTTP-Basic-over-Bearer exposed.
   */
  adminRoute?: boolean;
  /**
   * Storage configuration for operator-console conversations.
   *
   * When omitted, console chat persistence is enabled whenever the console is
   * enabled and `agentDir` is available. The CLI resolves that default to
   * `<agentDir>/data/console-chat.db` locally and to
   * `/app/data/console-chat.db` on Railway. Set `dbPath` to an explicit path to
   * override the location, or to `null` to keep console conversations in
   * process memory only.
   */
  consoleChat?: {
    dbPath?: string | null;
  };
  /**
   * Durable execution ledger for caller-supplied Idempotency-Key values.
   * CLI-managed agents default to data/web-idempotency.db. Programmatic
   * callers must configure a durable path before keyed requests are accepted;
   * tests and disposable development processes may explicitly opt into
   * `dbPath: ":memory:"`.
   */
  idempotency?: {
    dbPath?: string | null;
    maxRecords?: number;
    /** Maximum live shared rate-limit hit records before admission fails closed. */
    maxRateLimitRecords?: number;
    maxReplayBytes?: number;
    maxStoredBytes?: number;
    maxRecordsPerPartition?: number;
    maxPublicRecords?: number;
    maxAgentRecords?: number;
    maxCreatorRecords?: number;
    waitTimeoutMs?: number;
    staleAfterMs?: number;
    retentionMs?: number;
    maxWaiters?: number;
    maxWaitersPerKey?: number;
    /** Optional metrics hook; receives counts only, never keys or request data. */
    onWaiterCountChange?: (counts: { active: number; forKey: number }) => void;
  };
  /**
   * G36 — agent project directory. Used by
   * the admin module to read/write `admin-overrides.json`. When unset,
   * admin overrides are skipped silently (the runtime falls back to yaml +
   * env values for the tunable knobs). The auggy CLI populates this at
   * scaffold time; direct callers may leave it undefined.
   */
  agentDir?: string;
  /** Canonical shared directory for admin-overrides.json. Defaults to agentDir. */
  overrideDir?: string;
  /** Single v1 creator profile. Cosmetic only; bearer auth proves trust. */
  creator?: CreatorConfig;
}

interface AGUIRunRequestBody {
  messages: Array<{ role: string; content: string }>;
  threadId?: string;
  contextId?: string;
  taskId?: string;
  /** Server-only metadata injected by the authenticated console proxy. */
  __console?: {
    previewMode?: unknown;
    title?: unknown;
    model?: unknown;
    unreadOnFinish?: unknown;
    runId?: unknown;
    userMessageId?: unknown;
    assistantMessageId?: unknown;
  };
}

interface ConsoleRunMetadata {
  previewMode: ConsoleChatPreviewMode;
  title: string;
  model: ConsoleChatModelSnapshot | null;
  unreadOnFinish: boolean;
  runId: string | null;
  userMessageId: string;
  assistantMessageId: string;
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

function parseIpv6ForRateLimit(address: string): bigint | null {
  if (address.includes("%") || isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const octets = normalized.slice(lastColon + 1).split(".");
    if (
      octets.length !== 4 ||
      octets.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
    ) {
      return null;
    }
    const embedded = octets.reduce((value, part) => value * 256 + Number(part), 0);
    normalized = `${normalized.slice(0, lastColon)}:${(embedded >>> 16).toString(16)}:${(
      embedded & 0xffff
    ).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/**
 * Return the stable caller-network identity used for anonymous admission.
 * IPv6 callers share a /64 by default, while mapped IPv4 forms collapse to
 * the same exact IPv4 identity.
 */
export function rateLimitNetworkIdentity(ip: string, ipv6PrefixBits = 64): string | null {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  if (isIP(normalized) === 4) return `ipv4:${normalized}`;
  const parsed = parseIpv6ForRateLimit(normalized);
  if (parsed === null) return null;
  if (parsed >> 32n === 0xffffn) {
    const value = Number(parsed & 0xffff_ffffn);
    return `ipv4:${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${
      value & 0xff
    }`;
  }
  const prefix = parsed >> BigInt(128 - ipv6PrefixBits);
  return `ipv6/${ipv6PrefixBits}:${prefix.toString(16)}`;
}

/**
 * Returns true iff `ip` is a loopback address (127.0.0.0/8 or ::1).
 *
 * Strips the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`) before
 * the check, so `::ffff:127.0.0.1` is correctly classified as loopback.
 *
 * G36 uses this to gate HTTPS enforcement on /console: loopback connections
 * are exempt for dev (operator on the same machine); non-loopback connections
 * over plain HTTP get 426 Upgrade Required.
 */
export function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const norm = normalizeIp(ip);
  if (!norm) return false;
  if (isIP(norm) === 6) return norm === "::1";
  if (isIP(norm) !== 4) return false;
  return norm.split(".")[0] === "127";
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
function resolveCallerIp(
  req: Request,
  server: { requestIP?: (req: Request) => { address?: string } | null } | undefined,
  trustedProxies: TrustedProxyNetworks,
  xffOnUntrusted: () => void,
): { callerIp: string; error: boolean } {
  const connIp = getConnectionIp(req, server);
  const resolution = resolveForwardedRequest({
    connectionIp: connIp,
    headers: req.headers,
    trustedProxies,
  });
  if (req.headers.has("x-forwarded-for") && !resolution.proxyTrusted) xffOnUntrusted();
  return {
    callerIp: resolution.error ? (normalizeIp(connIp) ?? "unknown") : resolution.callerIp,
    error: resolution.error !== undefined,
  };
}

function getCallerIp(
  req: Request,
  server: { requestIP?: (req: Request) => { address?: string } | null } | undefined,
  trustedProxies: TrustedProxyNetworks,
  xffOnUntrusted: () => void,
): string {
  return resolveCallerIp(req, server, trustedProxies, xffOnUntrusted).callerIp;
}

function getConnectionIp(
  req: Request,
  server: { requestIP?: (req: Request) => { address?: string } | null } | undefined,
): string | null {
  try {
    return server?.requestIP?.(req)?.address ?? null;
  } catch {
    return null;
  }
}

function isRailwayRuntime(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function hasPublicAuggyUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isPublicishRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    isRailwayRuntime() ||
    hasPublicAuggyUrl(process.env.AUGGY_PUBLIC_URL)
  );
}

function formatAnonymousPostureLine(
  allowAnonymous: boolean,
  source: "default" | "env" | "yaml",
): string {
  const publicishRuntime = isPublicishRuntime();
  if (allowAnonymous && source === "default" && !publicishRuntime) {
    return "[web] anonymous local chat enabled";
  }

  const sourceLabel =
    source === "yaml"
      ? "agent.yaml"
      : source === "env"
        ? "AUGGY_ALLOW_ANONYMOUS"
        : process.env.NODE_ENV === "production"
          ? "production default"
          : publicishRuntime
            ? "public default"
            : "local default";

  return allowAnonymous
    ? `[web] anonymous chat enabled (${sourceLabel})`
    : `[web] anonymous chat disabled (${sourceLabel})`;
}

// ---------------------------------------------------------------------------
// Idempotency-Key validation
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(value);
}

function idempotencyAuthorizationBinding(value: RouteVisitorAuthContext | undefined): unknown {
  if (value?.state !== "recognized") return value;

  // A retry may carry freshly minted visitor and external-auth envelopes.
  // Remove only the known proof-envelope fields at their exact schema paths.
  // Arbitrary grant constraints are authorization data, even when an
  // application names one "expiresAt", "jti", or "keyId".
  const {
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    principal,
    externalAuth,
    ...topLevel
  } = value;
  const { externalAuth: principalExternalAuth, ...stablePrincipal } = principal;
  const stableExternalAuth = externalAuth
    ? (({ keyId: _keyId, jti: _jti, ...claims }) => claims)(externalAuth)
    : undefined;
  const stablePrincipalExternalAuth = principalExternalAuth
    ? (({ keyId: _keyId, jti: _jti, ...claims }) => claims)(principalExternalAuth)
    : undefined;

  return {
    ...topLevel,
    ...(stableExternalAuth ? { externalAuth: stableExternalAuth } : {}),
    principal: {
      ...stablePrincipal,
      ...(stablePrincipalExternalAuth ? { externalAuth: stablePrincipalExternalAuth } : {}),
    },
  };
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

function resolveConsoleChatDbPath(opts: WebTransportOptions): string | null {
  if (opts.adminRoute === false) return null;
  const configured = opts.consoleChat?.dbPath;
  if (configured === null) return ":memory:";
  if (configured !== undefined) {
    if (configured.trim() === "") {
      throw new Error("[web-transport] consoleChat.dbPath must be non-empty or null.");
    }
    return configured;
  }
  return opts.agentDir ? join(opts.agentDir, "data", "console-chat.db") : ":memory:";
}

function resolveIdempotencyDbPath(opts: WebTransportOptions): string | null {
  const configured = opts.idempotency?.dbPath;
  if (configured === null) return null;
  if (configured !== undefined) {
    if (configured.trim() === "") {
      throw new Error("[web-transport] idempotency.dbPath must be non-empty or null.");
    }
    return configured;
  }
  if (opts.agentDir) return join(opts.agentDir, "data", "web-idempotency.db");
  // Programmatic runtimes have no reliable way to infer whether they are
  // disposable development processes. Keyed execution must fail closed
  // unless the caller explicitly opts into either a durable file or the
  // development-only in-memory ledger.
  return null;
}

function appendTextSegmentBoundary(content: string): string {
  if (!content || content.endsWith("\n\n")) return content;
  return content.endsWith("\n") ? `${content}\n` : `${content}\n\n`;
}

function isConsoleChatIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function previewModeForPeer(peer: PeerIdentity): ConsoleChatPreviewMode | null {
  if (peer.trustLevel === "creator") return "creator";
  if (peer.trustLevel !== "public") return null;
  return peer.publicSubstate === "recognized" ? "visitor" : "anonymous";
}

function defaultConsoleThreadTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "New chat";
  const codePoints = Array.from(normalized);
  return codePoints.length <= 80 ? normalized : `${codePoints.slice(0, 77).join("").trimEnd()}…`;
}

function parseConsoleRunMetadata(
  value: AGUIRunRequestBody["__console"],
  message: string,
): ConsoleRunMetadata | null {
  if (!value) return null;
  if (
    value.previewMode !== "creator" &&
    value.previewMode !== "anonymous" &&
    value.previewMode !== "visitor"
  ) {
    return null;
  }
  const title = value.title === undefined ? defaultConsoleThreadTitle(message) : value.title;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    Array.from(title.trim()).length > 80
  ) {
    return null;
  }
  let model: ConsoleChatModelSnapshot | null = null;
  if (value.model !== undefined && value.model !== null) {
    if (typeof value.model !== "object" || Array.isArray(value.model)) return null;
    const raw = value.model as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      raw.id.trim() === "" ||
      typeof raw.displayName !== "string" ||
      raw.displayName.trim() === "" ||
      (raw.provider !== null && typeof raw.provider !== "string")
    ) {
      return null;
    }
    model = {
      id: raw.id,
      displayName: raw.displayName,
      provider: raw.provider as string | null,
    };
  }
  if (value.unreadOnFinish !== undefined && typeof value.unreadOnFinish !== "boolean") return null;
  if (value.runId !== undefined && !isConsoleChatIdentifier(value.runId)) return null;
  if (value.userMessageId !== undefined && !isConsoleChatIdentifier(value.userMessageId)) {
    return null;
  }
  if (
    value.assistantMessageId !== undefined &&
    !isConsoleChatIdentifier(value.assistantMessageId)
  ) {
    return null;
  }
  return {
    previewMode: value.previewMode,
    title: title.trim(),
    model,
    unreadOnFinish: value.unreadOnFinish ?? true,
    runId: value.runId ?? null,
    userMessageId: value.userMessageId ?? crypto.randomUUID(),
    assistantMessageId: value.assistantMessageId ?? crypto.randomUUID(),
  };
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
  const overrideDir = opts.overrideDir ?? opts.agentDir;
  const configuredExternalAuthHeader =
    typeof opts.externalAuth?.header === "string" ? opts.externalAuth.header : undefined;
  const externalAuthHeaderName =
    configuredExternalAuthHeader?.trim().toLowerCase() ?? DEFAULT_EXTERNAL_AUTH_ASSERTION_HEADER;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let startServer: (() => void) | null = null;
  let kernel: TransportKernel | null = null;
  let consoleChatStore: ConsoleChatStore | null = null;
  let idempotencyStore: WebIdempotencyStore | null = null;
  let consoleHistoryPersistence: ReturnType<
    typeof createDeferredConsoleThreadHistoryPersistence
  > | null = null;
  // Capability shared only with the same-process authenticated admin proxy.
  // It is deliberately never added to CORS or any response/log surface.
  const consoleInternalRunMarker = opts.adminRoute === false ? null : crypto.randomUUID();

  // PR γ.1 — augment-registered routes captured at register() time.
  // Empty until register fires; once populated, immutable for the server's lifetime.
  // Type matches TransportKernel.getAugmentRoutes(); runtime values are CollectedRoute
  // (which extends AugmentHttpRoute with augmentName) — we cast where needed.
  let augmentRoutes: readonly import("../types").AugmentHttpRoute[] = [];
  let augmentRouteMap: Map<string, import("../types").AugmentHttpRoute> = new Map();
  let augmentPatternRoutes: readonly import("../types").AugmentHttpRoute[] = [];

  // G36 — action registry built at register() time by buildAdminActionRegistry.
  // Empty when adminRoute is disabled or no augment declares adminInfo.
  let actionRegistry: AdminActionRegistry = new Map();

  // Console SPA dist directory resolved at register() time. `undefined` when no
  // build exists; the console route degrades to a "build required" notice.
  let adminStaticDir: string | undefined;

  // G2 — info endpoint cache. Populated in register() when publicFrontendUrl
  // is unset. Allows HEAD's Content-Length to match GET's body length
  // without re-rendering per request. validatedPublicFrontendUrl mirrors
  // opts.publicFrontendUrl after URL validation succeeds — using it on the
  // request hot path means a malformed URL is rejected once at boot, never
  // smuggled into a Location header.
  let validatedPublicFrontendUrl: string | undefined;
  let infoPageHtml: string | null = null;
  let infoPageByteLength = 0;
  let agentIntegrationPageHtml: string | null = null;
  let agentIntegrationPageByteLength = 0;
  let publicIntegration = opts.publicIntegration === true;
  let publicIntegrationSource: "yaml" | "admin-override" = "yaml";

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
  const trustedProxies = compileTrustedProxyNetworks(opts.trustedProxies ?? []);
  const anonymousNetworkConfig = opts.rateLimitPerPeer?.anonymousNetwork;
  const anonymousNetworkMode = anonymousNetworkConfig?.mode ?? "shared-store";
  if (
    anonymousNetworkMode !== "shared-store" &&
    anonymousNetworkMode !== "trusted-edge" &&
    anonymousNetworkMode !== "single-process-development"
  ) {
    throw new Error("[web-transport] rateLimitPerPeer.anonymousNetwork.mode is invalid.");
  }
  const anonymousIpv6PrefixBits = anonymousNetworkConfig?.ipv6PrefixBits ?? 64;
  if (
    !Number.isSafeInteger(anonymousIpv6PrefixBits) ||
    anonymousIpv6PrefixBits < 32 ||
    anonymousIpv6PrefixBits > 64
  ) {
    throw new Error(
      "[web-transport] rateLimitPerPeer.anonymousNetwork.ipv6PrefixBits must be an integer from 32 to 64.",
    );
  }
  const peerRateLimit = opts.rateLimitPerPeer?.maxPerMinute;
  if (peerRateLimit !== undefined && (!Number.isSafeInteger(peerRateLimit) || peerRateLimit < 1)) {
    throw new Error("[web-transport] rateLimitPerPeer.maxPerMinute must be a positive integer.");
  }
  const defaultGlobalAnonymousLimit =
    peerRateLimit === undefined
      ? undefined
      : Math.min(Number.MAX_SAFE_INTEGER, peerRateLimit * 100);
  const globalAnonymousLimit =
    anonymousNetworkConfig?.globalMaxPerMinute ?? defaultGlobalAnonymousLimit;
  if (
    globalAnonymousLimit !== undefined &&
    (!Number.isSafeInteger(globalAnonymousLimit) || globalAnonymousLimit < (peerRateLimit ?? 1))
  ) {
    throw new Error(
      "[web-transport] rateLimitPerPeer.anonymousNetwork.globalMaxPerMinute must be a positive integer at least as large as maxPerMinute.",
    );
  }
  const configuredConsoleOrigins = [...(opts.consoleSecurity?.allowedOrigins ?? [])];
  if (process.env.AUGGY_PUBLIC_URL) {
    try {
      configuredConsoleOrigins.push(new URL(process.env.AUGGY_PUBLIC_URL).origin);
    } catch {
      // Existing public URL validation reports malformed configuration.
    }
  }
  const consoleAllowedOrigins = buildConsoleAllowedOrigins(opts.port, configuredConsoleOrigins);
  let xffUntrustedWarned = false;
  function xffOnUntrusted(): void {
    if (xffUntrustedWarned) return;
    xffUntrustedWarned = true;
    if (trustedProxies.entries.length === 0) {
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
          `Configured trustedProxies: ${trustedProxies.entries.join(", ")}.`,
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

  function checkLocalRateLimits(
    policies: readonly { key: string; max: number; windowMs: number }[],
  ): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const now = Date.now();
    const windowStart = now - 60_000;
    if (++routeHitsTouchCount >= ROUTE_HITS_GC_INTERVAL) {
      routeHitsTouchCount = 0;
      gcStaleRouteHits(windowStart);
    }
    const admitted = new Map<string, number[]>();
    for (const policy of policies) {
      const cutoff = now - policy.windowMs;
      const hits = (routeHits.get(policy.key) ?? []).filter((timestamp) => timestamp > cutoff);
      routeHits.set(policy.key, hits);
      if (hits.length >= policy.max) {
        const retryAfterMs = hits[0]! + policy.windowMs - now;
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      admitted.set(policy.key, hits);
    }
    for (const [key, hits] of admitted) {
      hits.push(now);
      routeHits.set(key, hits);
    }
    return { allowed: true };
  }

  function checkRouteRateLimit(
    routeKey: string,
    ip: string,
    max: number,
  ): { allowed: true } | { allowed: false; retryAfterSec: number } {
    return checkLocalRateLimits([{ key: `${routeKey}|${ip}`, max, windowMs: 60_000 }]);
  }

  function anonymousRateLimitPolicies(callerIp: string): RateLimitPolicy[] {
    if (peerRateLimit === undefined || globalAnonymousLimit === undefined) return [];
    const network = rateLimitNetworkIdentity(callerIp, anonymousIpv6PrefixBits);
    if (!network) throw new Error("anonymous caller network is unavailable");
    const audience = requireSecurityAudience();
    return [
      {
        bucketHash: hashIdempotencyBinding({
          audience,
          kind: "anonymous-global",
        }),
        max: globalAnonymousLimit,
        windowMs: 60_000,
      },
      {
        bucketHash: hashIdempotencyBinding({
          audience,
          kind: "anonymous-network",
          network,
        }),
        max: peerRateLimit,
        windowMs: 60_000,
      },
    ];
  }

  function reserveAnonymousExecution(
    callerIp: string,
    store = idempotencyStore,
  ): { allowed: true } | { allowed: false; retryAfterSec: number } {
    if (anonymousNetworkMode === "trusted-edge") return { allowed: true };
    const policies = anonymousRateLimitPolicies(callerIp);
    if (anonymousNetworkMode === "shared-store") {
      if (!store) throw new Error("shared anonymous rate-limit store is unavailable");
      return store.reserveRateLimits(policies);
    }
    return checkLocalRateLimits(
      policies.map((policy) => ({
        key: `anonymous|${policy.bucketHash}`,
        max: policy.max,
        windowMs: policy.windowMs,
      })),
    );
  }

  const maxMessageLength = opts.maxMessageLength ?? 4000;
  if (!Number.isSafeInteger(maxMessageLength) || maxMessageLength < 1) {
    throw new Error("[web-transport] maxMessageLength must be a positive integer.");
  }
  const maxRequestBodyBytes = opts.maxRequestBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new Error("[web-transport] maxRequestBodyBytes must be a positive integer.");
  }
  const maxPendingSseBytes = opts.maxPendingSseBytes ?? 1024 * 1024;
  const maxPendingSseEvents = opts.maxPendingSseEvents ?? 1024;
  const maxConsoleRunBytes = opts.maxConsoleRunBytes ?? 4 * 1024 * 1024;
  for (const [name, value] of [
    ["maxPendingSseBytes", maxPendingSseBytes],
    ["maxPendingSseEvents", maxPendingSseEvents],
    ["maxConsoleRunBytes", maxConsoleRunBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`[web-transport] ${name} must be a positive integer.`);
    }
  }
  // F2: visitor tokens are opt-in (enabled === true) rather than opt-out
  // (enabled !== false). Requiring an explicit signingKey at onBoot prevents
  // the silent mismatch where webTransport boots with an ephemeral key that
  // differs from the one visitorAuth uses to mint tokens. When configured via
  // the augment-resolver, visitorAuth's signingKey is auto-injected and
  // enabled is set to true. Direct callers must pass both explicitly.
  const visitorTokensEnabled = opts.visitorTokens?.enabled === true;
  const externalAuthReplayProtectionEnabled = opts.externalAuth?.replayProtection?.enabled === true;
  const externalAuthReplayStore = externalAuthReplayProtectionEnabled
    ? (opts.externalAuth?.replayProtection?.store ?? null)
    : null;
  let securityAudience: string | null = null;
  const idempotencyMaxReplayBytes = opts.idempotency?.maxReplayBytes ?? 2 * 1024 * 1024;
  const idempotencyMaxStoredBytes = opts.idempotency?.maxStoredBytes ?? 256 * 1024 * 1024;
  const idempotencyWaitTimeoutMs = opts.idempotency?.waitTimeoutMs ?? 30_000;
  const idempotencyStaleAfterMs = opts.idempotency?.staleAfterMs ?? 30_000;
  const idempotencyRetentionMs = opts.idempotency?.retentionMs ?? 24 * 60 * 60 * 1000;
  const idempotencyMaxWaiters = opts.idempotency?.maxWaiters ?? 64;
  const idempotencyMaxWaitersPerKey = opts.idempotency?.maxWaitersPerKey ?? 8;
  if (!Number.isSafeInteger(idempotencyWaitTimeoutMs) || idempotencyWaitTimeoutMs < 1) {
    throw new Error("[web-transport] idempotency.waitTimeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(idempotencyStaleAfterMs) || idempotencyStaleAfterMs < 3) {
    throw new Error("[web-transport] idempotency.staleAfterMs must be an integer of at least 3.");
  }
  for (const [label, value] of [
    ["maxStoredBytes", idempotencyMaxStoredBytes],
    ["retentionMs", idempotencyRetentionMs],
    ["maxWaiters", idempotencyMaxWaiters],
    ["maxWaitersPerKey", idempotencyMaxWaitersPerKey],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`[web-transport] idempotency.${label} must be a positive integer.`);
    }
  }
  if (idempotencyMaxWaitersPerKey > idempotencyMaxWaiters) {
    throw new Error("[web-transport] idempotency.maxWaitersPerKey cannot exceed maxWaiters.");
  }
  let anonymousSessionManager: ReturnType<typeof createAnonymousSessionManager> | null = null;
  let signingKey: CryptoKey | null = null;
  let activeIdempotencyWaiters = 0;
  let managedRootRetained = false;
  let overrideRootRetained = false;
  const idempotencyWaitersByKey = new Map<string, number>();
  const localIdempotencyExecutions = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();

  function requireSecurityAudience(): string {
    if (!securityAudience) {
      throw new Error("[web-transport] security namespace is unavailable before registration");
    }
    return securityAudience;
  }

  function canonicalPublicThreadId(
    requested: string | undefined,
    idempotencyKey: string | null,
    authenticatedThreadScopeId: string,
  ): string {
    const canonicalPattern = /^web_thread_[0-9a-f]{32}_[0-9a-f]{32}$/;
    const peerScope = createHmac("sha256", opts.auth.token)
      .update("auggy-public-thread-peer-v1\0")
      .update(requireSecurityAudience())
      .update("\0")
      .update(authenticatedThreadScopeId)
      .digest("hex")
      .slice(0, 32);
    if (requested?.startsWith(`web_thread_${peerScope}_`) && canonicalPattern.test(requested)) {
      return requested;
    }

    const logicalThreadId =
      requested ??
      (idempotencyKey === null
        ? crypto.randomUUID()
        : hashIdempotencyKey(requireSecurityAudience(), idempotencyKey));
    const logicalHash = createHmac("sha256", opts.auth.token)
      .update("auggy-public-thread-logical-v1\0")
      .update(requireSecurityAudience())
      .update("\0")
      .update(authenticatedThreadScopeId)
      .update("\0")
      .update(logicalThreadId)
      .digest("hex")
      .slice(0, 32);
    return `web_thread_${peerScope}_${logicalHash}`;
  }

  // Anonymous-public posture (G3 — concierge-readiness gate). Resolved once
  // at factory time across yaml > env > default precedence. The resolution
  // object carries `source` so the boot-time log line in `register()` can
  // tell the operator exactly why the agent is running in this posture.
  //
  // G36: also mutable at register-time when admin-overrides.json carries an
  // override; the console posture action mutates via setAllowAnonymous.
  const allowAnonymousResolution = resolveConfigBool(
    opts.allowAnonymous,
    "AUGGY_ALLOW_ANONYMOUS",
    () => process.env.NODE_ENV !== "production",
  );
  let allowAnonymous = allowAnonymousResolution.value;

  function anonymousRateLimitConfigurationError(enabled: boolean): string | null {
    if (!enabled || peerRateLimit === undefined) return null;
    if (anonymousNetworkMode === "trusted-edge") return null;
    if (anonymousNetworkMode === "single-process-development") {
      return isPublicishRuntime()
        ? "single-process-development anonymous rate limiting is unavailable in production or public deployments"
        : null;
    }
    const dbPath = resolveIdempotencyDbPath(opts);
    if (dbPath === null || dbPath === ":memory:") {
      return "anonymous rate limiting requires a durable shared idempotency.dbPath or an explicit trusted-edge mode";
    }
    return null;
  }

  // G36 — setter for the posture-flip action to call. Mutates the
  // closure variable above; the identity resolver reads `allowAnonymous`
  // on every request so the change applies immediately.
  function setAllowAnonymous(value: boolean): void {
    allowAnonymous = value;
  }

  function renderPublicPages(card: ReturnType<TransportKernel["getAgentCard"]>): void {
    if (validatedPublicFrontendUrl === undefined) {
      infoPageHtml = renderInfoPage(card, { publicIntegration });
      infoPageByteLength = new TextEncoder().encode(infoPageHtml).byteLength;
    }
    if (publicIntegration) {
      agentIntegrationPageHtml = renderAgentIntegrationPage(card);
      agentIntegrationPageByteLength = new TextEncoder().encode(
        agentIntegrationPageHtml,
      ).byteLength;
    } else {
      agentIntegrationPageHtml = null;
      agentIntegrationPageByteLength = 0;
    }
  }

  function setPublicIntegration(value: boolean): void {
    publicIntegration = value;
    if (kernel) renderPublicPages(kernel.getAgentCard());
  }

  async function persistAllowAnonymousOverride(value: boolean): Promise<void> {
    if (!overrideDir) {
      throw new Error("override storage not configured; admin overrides cannot persist");
    }
    const current = readOverrides(overrideDir) ?? {
      version: 1 as const,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {},
    };
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    current.overrides.webTransport = {
      ...current.overrides.webTransport,
      allowAnonymous: value,
    };
    writeOverrides(overrideDir, current);
  }

  async function persistPublicIntegrationOverride(value: boolean): Promise<void> {
    if (!overrideDir) {
      throw new Error("override storage not configured; admin overrides cannot persist");
    }
    const current = readOverrides(overrideDir) ?? {
      version: 1 as const,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {},
    };
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    current.overrides.webTransport = {
      ...current.overrides.webTransport,
      publicIntegration: value,
    };
    writeOverrides(overrideDir, current);
  }

  async function clearAllowAnonymousOverride(): Promise<void> {
    if (!overrideDir) return;
    const current = readOverrides(overrideDir);
    if (!current) return;
    if (current.overrides.webTransport) {
      delete (current.overrides.webTransport as Record<string, unknown>).allowAnonymous;
      if (Object.keys(current.overrides.webTransport).length === 0) {
        delete (current.overrides as Record<string, unknown>).webTransport;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(overrideDir, current);
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const sourceLabel =
      allowAnonymousResolution.source === ("admin-override" as string)
        ? "/console override"
        : allowAnonymousResolution.source === "env"
          ? `env (AUGGY_ALLOW_ANONYMOUS=${process.env.AUGGY_ALLOW_ANONYMOUS})`
          : allowAnonymousResolution.source === "default"
            ? `default (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`
            : "yaml";
    return {
      augmentName: "web",
      title: "Posture",
      sections: [
        {
          kind: "keyValue",
          rows: [
            {
              label: "allowAnonymous",
              value: String(allowAnonymous),
              source: sourceLabel,
              resetAction: { id: "posture-reset", label: "Reset to yaml" },
            },
            {
              label: "publicFrontendUrl",
              value: opts.publicFrontendUrl ?? "(unset)",
            },
            {
              label: "publicIntegration",
              value: String(publicIntegration),
              source: publicIntegrationSource === "admin-override" ? "/console override" : "yaml",
            },
            { label: "Port", value: String(opts.port) },
            {
              label: "Trusted proxies",
              value: trustedProxies.entries.join(", ") || "(none)",
            },
            {
              label: "CORS origins",
              value: opts.cors?.origins.join(", ") || "(none)",
            },
            {
              label: "Visitor tokens",
              value: String(visitorTokensEnabled),
            },
            {
              label: "External auth",
              value: String(opts.externalAuth !== undefined),
            },
            {
              label: "External auth header",
              value: externalAuthHeaderName,
            },
            {
              label: "External auth audience",
              value: resolveExternalAuthAudience(),
            },
            {
              label: "Agent access entries",
              value: String(opts.access?.agents?.length ?? 0),
            },
          ],
        },
      ],
      actions: [
        {
          id: "posture-flip",
          label: "Flip allowAnonymous",
          confirmRequired: true,
          inputs: [
            {
              name: "value",
              label: "allowAnonymous",
              type: "boolean",
              required: true,
              helpText: "Demo-mode on/off. Persists across restart via admin-overrides.json.",
            },
          ],
        },
        {
          id: "posture-public-integration-set",
          label: "Set publicIntegration",
          confirmRequired: false,
          inputs: [
            {
              name: "value",
              label: "publicIntegration",
              type: "boolean",
              required: true,
              helpText:
                "Persists across restart via admin-overrides.json. Publishes /agent and unauthenticated legacy Auggy runtime metadata; does not publish /agent/run or a current A2A Agent Card.",
            },
          ],
        },
      ],
    };
  }

  const adminActions = {
    "posture-flip": async (params: Record<string, unknown>): Promise<AdminActionResult> => {
      const value = params.value === true || params.value === "true";
      const boundaryError = anonymousRateLimitConfigurationError(value);
      if (boundaryError) {
        return {
          ok: false,
          message: `could not enable anonymous access: ${boundaryError}; agent state unchanged`,
        };
      }
      try {
        await persistAllowAnonymousOverride(value);
      } catch (err) {
        return {
          ok: false,
          message: `could not persist override: ${(err as Error).message}; agent state unchanged`,
        };
      }
      setAllowAnonymous(value);
      (allowAnonymousResolution as unknown as { source: string }).source = "admin-override";
      return { ok: true, message: `allowAnonymous set to ${value}` };
    },
    "posture-reset": async (): Promise<AdminActionResult> => {
      try {
        await clearAllowAnonymousOverride();
      } catch (err) {
        return {
          ok: false,
          message: `could not clear override: ${(err as Error).message}`,
        };
      }
      const reResolved = resolveConfigBool(
        opts.allowAnonymous,
        "AUGGY_ALLOW_ANONYMOUS",
        () => process.env.NODE_ENV !== "production",
      );
      const boundaryError = anonymousRateLimitConfigurationError(reResolved.value);
      if (boundaryError) {
        return {
          ok: false,
          message: `could not reset anonymous access: ${boundaryError}; agent state unchanged`,
        };
      }
      setAllowAnonymous(reResolved.value);
      (
        allowAnonymousResolution as unknown as {
          source: typeof reResolved.source;
          value: boolean;
        }
      ).source = reResolved.source;
      return { ok: true, message: `allowAnonymous reset to yaml: ${reResolved.value}` };
    },
    "posture-public-integration-set": async (
      params: Record<string, string>,
    ): Promise<AdminActionResult> => {
      const value = params.value === "true";
      try {
        await persistPublicIntegrationOverride(value);
      } catch (err) {
        return {
          ok: false,
          message: `could not persist override: ${(err as Error).message}; agent state unchanged`,
        };
      }
      publicIntegrationSource = "admin-override";
      setPublicIntegration(value);
      return {
        ok: true,
        message: `developer discovery ${value ? "published" : "made private"}`,
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Identity resolver — four paths
  // ---------------------------------------------------------------------------

  const identify = (raw: unknown): PeerIdentity | null => {
    const req = raw as {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __anonymousSessionId?: string;
      __authenticatedPriorPeerId?: string;
      // True iff the HTTP handler already validated a bearer token for this
      // request. Path 1 (creator) requires this — without it the request
      // arrived via the allowAnonymous path and MUST NOT be promoted to
      // creator trust. Missing/false falls through to Path 4 (public anon).
      __bearerValidated?: boolean;
    };
    const headers = req.headers;
    const kind = (headers["x-peer-kind"] as PeerIdentity["kind"]) ?? "human";

    const agentId = headers["x-agent-id"];
    const agentSecret = headers["x-agent-secret"];
    const hasAnyAgentHeader = typeof agentId === "string" || typeof agentSecret === "string";
    const hasAgentHeaders = typeof agentId === "string" && typeof agentSecret === "string";
    if (hasAnyAgentHeader && !hasAgentHeaders) return null;

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

    // PATH 1: Creator — bearer-validated request.
    // REQUIRES `__bearerValidated === true`. The HTTP handler sets that flag
    // only after `isValidAuth` passes. With `allowAnonymous=true`, a no-bearer
    // request reaches identify() with the flag falsy and MUST NOT be minted
    // creator — it falls through to Path 4. This guard is the security gate
    // for the anonymous path: anonymous traffic can never be silently promoted
    // to creator trust just by omitting auth + visitor headers.
    //
    // Bearer wins over INVALID x-visitor-token. The condition is
    // `!req.__visitorPayload` (no VERIFIED visitor identity) — so:
    //   - Valid bearer + no x-visitor-token            → creator (Path 1)
    //   - Valid bearer + stale/malformed x-visitor-token → creator (Path 1) ← was anonymous pre-codex-R6
    //   - Valid bearer + VALID x-visitor-token         → recognized (Path 3 fires because __visitorPayload populated)
    //   - No bearer + valid x-visitor-token            → recognized (Path 3)
    //   - No bearer + no/invalid x-visitor-token       → anonymous (Path 4, if allowAnonymous)
    // This closes the codex round-6 footgun (creator silently demoted to
    // anonymous by an unrelated stale visitor cookie). The narrower "valid
    // visitor-token + bearer → recognized" case is preserved as an explicit
    // operator opt-in to acting as a known visitor while authenticated.
    if (req.__bearerValidated === true && !req.__visitorPayload) {
      return {
        id: "creator",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "web",
        displayName: opts.creator?.displayName ?? headers["x-peer-name"],
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
        ...(req.__authenticatedPriorPeerId
          ? { authenticatedPriorPeerId: req.__authenticatedPriorPeerId }
          : {}),
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        ...(req.__visitorPayload.orgId !== undefined ? { orgId: req.__visitorPayload.orgId } : {}),
      };
    }

    // PATH 4: Public anonymous — no agent headers or verified visitor token.
    // The peer ID comes from a separately authenticated, server-minted
    // anonymous session capability. It must never be derived from the
    // caller-controlled thread ID that the capability protects.
    if (!req.__anonymousSessionId) return null;
    return {
      id: req.__anonymousSessionId,
      kind,
      trustLevel: "public",
      publicSubstate: "anonymous",
      sourceAugment: "web",
      displayName: headers["x-peer-name"],
    };
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel, _augmentName: string) {
      kernel = k;
      const registeredAgentName = k.getAgentCard().provider.name;
      if (
        opts.securityNamespace !== undefined &&
        opts.visitorTokens?.agentBinding !== undefined &&
        opts.securityNamespace !== opts.visitorTokens.agentBinding
      ) {
        throw new Error(
          "[web-transport] securityNamespace must match visitorTokens.agentBinding when both are configured.",
        );
      }
      securityAudience =
        opts.securityNamespace ?? opts.visitorTokens?.agentBinding ?? registeredAgentName;
      if (
        securityAudience.length === 0 ||
        securityAudience.length > 256 ||
        securityAudience.trim() !== securityAudience
      ) {
        throw new Error(
          "[web-transport] securityNamespace must be a non-empty, trimmed string of at most 256 characters.",
        );
      }
      anonymousSessionManager = createAnonymousSessionManager({
        audience: securityAudience,
        secret: createHash("sha256")
          .update("auggy-anonymous-session-v1\0")
          .update(securityAudience)
          .update("\0")
          .update(opts.auth.token)
          .digest(),
      });
      augmentRoutes = k.getAugmentRoutes();
      augmentRouteMap = new Map();
      const patternRoutes: import("../types").AugmentHttpRoute[] = [];

      if (opts.publicIntegration !== undefined && typeof opts.publicIntegration !== "boolean") {
        throw new Error("[web-transport] publicIntegration must be a boolean when configured");
      }

      // G36 — apply admin-overrides on top of yaml/env/default.
      // The override file is read once at boot; the closure values are the
      // runtime source of truth thereafter.
      if (overrideDir && !overrideRootRetained) {
        overrideRootRetained = retainAdminOverrideRoot(overrideDir);
      }
      let overrides: ReturnType<typeof readOverrides>;
      try {
        overrides = readOverrides(overrideDir);
      } catch (error) {
        if (overrideRootRetained) {
          releaseAdminOverrideRoot(overrideDir);
          overrideRootRetained = false;
        }
        throw error;
      }
      if (overrides?.overrides.webTransport?.allowAnonymous !== undefined) {
        allowAnonymous = overrides.overrides.webTransport.allowAnonymous;
        // Mark the resolution source so /console can display "/console override".
        // The cast is needed because
        // resolveConfigBool's union doesn't yet include "admin-override".
        (allowAnonymousResolution as unknown as { source: string }).source = "admin-override";
      }
      if (overrides?.overrides.webTransport?.publicIntegration !== undefined) {
        publicIntegration = overrides.overrides.webTransport.publicIntegration;
        publicIntegrationSource = "admin-override";
      }
      // G36 — build the action registry from declared adminInfo + adminActions.
      // buildAdminActionRegistry throws on missing handlers or action-id
      // collisions; surface fires at boot, not at first POST.
      if (opts.adminRoute !== false) {
        actionRegistry = await buildAdminActionRegistry(k.getAugments());
        adminStaticDir = resolveDistDir();
      }

      // G2 — validate publicFrontendUrl once + cache info page HTML.
      // Validation throws here so a malformed URL fails fast at agent boot
      // rather than at first request. Mirrors the discipline used earlier in
      // this file for visitorTokens.signingKey + agentBinding.
      if (opts.publicFrontendUrl !== undefined) {
        try {
          new URL(opts.publicFrontendUrl);
        } catch (err) {
          throw new Error(
            `[web-transport] publicFrontendUrl is not a valid URL: ${JSON.stringify(
              opts.publicFrontendUrl,
            )}. ${(err as Error).message}`,
          );
        }
        validatedPublicFrontendUrl = opts.publicFrontendUrl;
      }
      // No publicFrontendUrl set — info page will be served at GET / and
      // mirrored at HEAD /. Eagerly render so HEAD's Content-Length matches
      // GET's body length per RFC 9110 §9.3.2. /agent also uses this cache
      // and is invalidated by the publicIntegration admin toggle.
      renderPublicPages(k.getAgentCard());

      let visitorAuthMounted = false;
      for (const r of augmentRoutes) {
        const parsedPattern = parseRoutePattern(r.path);
        if (parsedPattern.ok && parsedPattern.pattern.isPattern) {
          patternRoutes.push(r);
        } else {
          augmentRouteMap.set(`${r.method} ${r.path}`, r);
        }
        // Operator-visible audit: log every public route so an operator
        // grepping the boot log can spot anonymous-callable surfaces.
        // Runtime values are CollectedRoute (extends AugmentHttpRoute with augmentName).
        const augmentName = (r as { augmentName?: string }).augmentName ?? "(unknown)";
        const policyConfigError = validateRouteWebhookPolicyConfig(r);
        if (policyConfigError) {
          throw new Error(
            `[web-transport] augment "${augmentName}" route ${r.method} ${r.path}: ${policyConfigError}`,
          );
        }
        if (augmentName === "visitor-auth") visitorAuthMounted = true;
        if (r.auth === "none") {
          console.warn(
            `[web-transport] augment "${augmentName}" registered ${r.method} ${r.path} with auth: "none" — public, unauthenticated.`,
          );
        } else if (r.auth === "visitor.optional") {
          console.warn(
            `[web-transport] augment "${augmentName}" registered ${r.method} ${r.path} with auth: "visitor.optional" — public, visitor-aware.`,
          );
        }
      }
      augmentPatternRoutes = Object.freeze(patternRoutes);

      console.log(formatAnonymousPostureLine(allowAnonymous, allowAnonymousResolution.source));

      // visitorAuth-missing warning. Local default runs stay quiet; public or
      // production-like anonymous surfaces get a concise operator warning
      // unless the operator explicitly acknowledged the posture in yaml.
      if (
        allowAnonymous &&
        !visitorAuthMounted &&
        allowAnonymousResolution.source !== "yaml" &&
        isPublicishRuntime()
      ) {
        console.warn(
          `[web-transport] WARNING: anonymous public chat is enabled. ` +
            `Add \`auggy augment add visitorAuth\` for email sign-in, ` +
            `or set \`allowAnonymous: true\` in agent.yaml to acknowledge.`,
        );
      }
    },
    async ready() {
      if (!startServer) {
        throw new Error("[web-transport] cannot become ready before onBoot preparation");
      }
      if (!kernel) {
        throw new Error("[web-transport] cannot become ready before kernel registration");
      }
      if (server) return;
      startServer();
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

  function emitDelegatedAuthorizationDenied(event: DelegatedAuthorizationDeniedAuditEvent): void {
    try {
      opts.onDelegatedAuthorizationDenied?.(event);
    } catch {
      console.warn("[web-transport] delegated authorization audit hook failed.");
    }
  }

  function anonymousRoutePrincipal(): Extract<
    RouteAuthContext["principal"],
    { kind: "anonymous" }
  > {
    return {
      kind: "anonymous",
      trustLevel: "public",
      publicSubstate: "anonymous",
    };
  }

  function creatorRoutePrincipal(): Extract<RouteAuthContext["principal"], { kind: "creator" }> {
    return {
      kind: "creator",
      trustLevel: "creator",
      peerId: "creator",
    };
  }

  function resolveAgentRouteAuth(req: Request): RouteAgentAuthContext | null {
    const agentId = req.headers.get("x-agent-id");
    const agentSecret = req.headers.get("x-agent-secret");
    if (!agentId || !agentSecret) return null;

    const entry = (opts.access?.agents ?? []).find((agent) => agent.id === agentId);
    if (!entry || !timingSafeEqual(agentSecret, entry.sharedSecret)) return null;

    const displayName = req.headers.get("x-peer-name") ?? undefined;
    const orgId = req.headers.get("x-org-id") ?? undefined;
    const principal: Extract<RouteAuthContext["principal"], { kind: "agent" }> = {
      kind: "agent",
      trustLevel: "agent",
      agentId,
      peerId: `agent:${agentId}`,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
    };

    return {
      mode: "agent",
      agentId,
      peerId: principal.peerId,
      ...(principal.displayName !== undefined ? { displayName: principal.displayName } : {}),
      ...(principal.orgId !== undefined ? { orgId: principal.orgId } : {}),
      principal,
    };
  }

  function resolveExternalAuthAudience(): string {
    return opts.externalAuth?.audience ?? requireSecurityAudience();
  }

  async function resolveExternalVisitorAuth(
    req: Request,
    replayMode: "consume" | "defer" = "consume",
  ): Promise<RouteVisitorAuthContext | null> {
    const config = opts.externalAuth;
    if (!config) return null;

    const assertion = req.headers.get(externalAuthHeaderName);
    if (!assertion) return null;

    const verified = verifyExternalAuthAssertion(assertion, {
      secret: config.secret,
      keyId: config.keyId,
      secrets: config.secrets,
      audience: resolveExternalAuthAudience(),
      allowedProviders: config.allowedProviders,
      maxTtlSeconds: config.maxTtlSeconds,
    });
    if (!verified.ok) return null;
    if (externalAuthReplayStore) {
      if (!verified.claims.jti) return null;
      if (replayMode === "consume") {
        const now = Date.now();
        let accepted = false;
        try {
          accepted = await externalAuthReplayStore.consume(
            verified.claims.jti,
            verified.claims.expiresAt,
            now,
          );
        } catch {
          console.warn("[web-transport] external auth replay store failed.");
          return null;
        }
        if (!accepted) return null;
      }
    }

    return externalAuthClaimsToRouteContext(verified.claims, {
      visitorId: config.visitorId,
      includeUnverifiedEmail: config.includeUnverifiedEmail,
    });
  }

  async function resolveVisitorRouteAuth(req: Request): Promise<RouteVisitorAuthContext> {
    const anonymous: RouteVisitorAuthContext = {
      mode: "visitor",
      state: "anonymous",
      principal: anonymousRoutePrincipal(),
    };
    const externalVisitorAuth = await resolveExternalVisitorAuth(req);
    if (externalVisitorAuth?.state === "recognized") return externalVisitorAuth;
    if (!visitorTokensEnabled || !signingKey) return anonymous;

    const tokenHeader = req.headers.get("x-visitor-token");
    if (!tokenHeader) return anonymous;

    const payload = await verifyVisitorToken(signingKey, tokenHeader);
    if (!payload) return anonymous;

    try {
      if (opts.visitorTokens?.revocationCheck?.(payload.visitorId)) {
        return anonymous;
      }
    } catch {
      return anonymous;
    }

    const expectedBinding = requireSecurityAudience();
    if (payload.agentId !== expectedBinding) {
      return anonymous;
    }

    let identity: Omit<RouteVisitorIdentity, "agentId" | "issuedAt" | "expiresAt"> | null = null;
    try {
      identity = opts.visitorTokens?.identityLookup?.(payload.visitorId) ?? null;
    } catch {
      return anonymous;
    }
    if (opts.visitorTokens?.identityLookup && !identity) {
      return anonymous;
    }
    if (identity && identity.visitorId !== payload.visitorId) {
      return anonymous;
    }
    const orgCandidates = [payload.orgId, identity?.orgId, identity?.externalAuth?.orgId].filter(
      (value): value is string => value !== undefined,
    );
    if (
      orgCandidates.some(
        (value) =>
          value.length === 0 ||
          value.length > 256 ||
          [...value].some((character) => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || code === 0x7f;
          }),
      ) ||
      new Set(orgCandidates).size > 1
    ) {
      return anonymous;
    }
    const orgId = orgCandidates[0];
    const canonicalExternalAuth =
      identity?.externalAuth === undefined
        ? undefined
        : {
            ...identity.externalAuth,
            ...(orgId !== undefined ? { orgId } : {}),
          };

    const visitorAuth: RouteVisitorAuthContext = {
      mode: "visitor",
      state: "recognized",
      visitorId: payload.visitorId,
      agentId: payload.agentId,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      ...(orgId !== undefined ? { orgId } : {}),
      ...(identity?.email !== undefined ? { email: identity.email } : {}),
      ...(identity?.verifiedAt !== undefined ? { verifiedAt: identity.verifiedAt } : {}),
      ...(identity?.reverifyDueAt !== undefined ? { reverifyDueAt: identity.reverifyDueAt } : {}),
      ...(canonicalExternalAuth !== undefined ? { externalAuth: canonicalExternalAuth } : {}),
      principal: {
        kind: "visitor",
        trustLevel: "public",
        publicSubstate: "recognized",
        visitorId: payload.visitorId,
        agentId: payload.agentId,
        ...(orgId !== undefined ? { orgId } : {}),
        ...(identity?.email !== undefined ? { email: identity.email } : {}),
        ...(identity?.verifiedAt !== undefined ? { verifiedAt: identity.verifiedAt } : {}),
        ...(identity?.reverifyDueAt !== undefined ? { reverifyDueAt: identity.reverifyDueAt } : {}),
        ...(canonicalExternalAuth !== undefined ? { externalAuth: canonicalExternalAuth } : {}),
      },
    };
    return visitorAuth;
  }

  async function resolveConsoleVisitorIdentity(visitorToken: string): Promise<{
    status: "verified";
    email: string;
    expiresAt: number;
  } | null> {
    if (!visitorTokensEnabled || !signingKey || !opts.visitorTokens?.identityLookup) return null;
    let payload: VisitorTokenPayload | null;
    try {
      payload = await verifyVisitorToken(signingKey, visitorToken);
    } catch {
      return null;
    }
    if (
      !payload ||
      typeof payload.visitorId !== "string" ||
      payload.visitorId.length === 0 ||
      typeof payload.agentId !== "string" ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt < 0 ||
      payload.expiresAt > 8_640_000_000_000_000
    ) {
      return null;
    }
    const expectedBinding = requireSecurityAudience();
    if (payload.agentId !== expectedBinding) return null;
    if (opts.visitorTokens.revocationCheck?.(payload.visitorId)) return null;

    const identity = opts.visitorTokens.identityLookup(payload.visitorId);
    if (
      !identity ||
      identity.visitorId !== payload.visitorId ||
      typeof identity.email !== "string" ||
      identity.email.trim().length === 0 ||
      identity.email.length > 320
    ) {
      return null;
    }
    return {
      status: "verified",
      email: identity.email,
      expiresAt: payload.expiresAt,
    };
  }

  function resolveAgentRunTurnAuth(
    visitorPayload: VisitorTokenPayload | null,
    externalAuth: RouteVisitorAuthContext | null,
    peer: PeerIdentity,
  ): RouteVisitorAuthContext | undefined {
    if (visitorPayload === null || externalAuth?.state !== "recognized") return undefined;
    if (externalAuth.visitorId !== visitorPayload.visitorId) return undefined;
    if (externalAuth.agentId !== visitorPayload.agentId) return undefined;
    if (
      peer.trustLevel !== "public" ||
      peer.publicSubstate !== "recognized" ||
      peer.id !== externalAuth.visitorId ||
      (peer.orgId ?? null) !== (externalAuth.orgId ?? null) ||
      (visitorPayload.orgId ?? null) !== (externalAuth.orgId ?? null)
    ) {
      return undefined;
    }
    return externalAuth;
  }

  async function authorizeAugmentRoute(
    req: Request,
    auth: AugmentHttpRouteAuth,
  ): Promise<{ ok: true; context: RouteAuthContext } | { ok: false; response: Response }> {
    if (auth === "none") {
      return { ok: true, context: { mode: "none", principal: anonymousRoutePrincipal() } };
    }

    if (auth === "bearer" || auth === "creator") {
      const authHeader = req.headers.get("authorization") ?? "";
      if (!isValidAuth(authHeader)) {
        return { ok: false, response: json({ error: "unauthorized" }, 401) };
      }
      return { ok: true, context: { mode: auth, principal: creatorRoutePrincipal() } };
    }

    if (auth === "visitor.optional" || auth === "visitor.required") {
      const visitorAuth = await resolveVisitorRouteAuth(req);
      if (auth === "visitor.required" && visitorAuth.state !== "recognized") {
        return { ok: false, response: json(visitorAuthRequiredErrorBody(), 401) };
      }
      return { ok: true, context: visitorAuth };
    }

    if (auth === "agent.required") {
      const agentAuth = resolveAgentRouteAuth(req);
      if (!agentAuth) {
        return { ok: false, response: json({ error: "agent-auth-required" }, 401) };
      }
      return { ok: true, context: agentAuth };
    }

    return { ok: false, response: json({ error: "route-auth-misconfigured" }, 500) };
  }

  function findAugmentRoute(
    method: string,
    pathname: string,
  ): { route: AugmentHttpRoute; params: Record<string, string> } | null {
    const exact = augmentRouteMap.get(`${method} ${pathname}`);
    if (exact) return { route: exact, params: {} };

    for (const route of augmentPatternRoutes) {
      if (route.method !== method) continue;
      const params = matchRoutePath(route.path, pathname);
      if (params) return { route, params };
    }

    return null;
  }

  async function waitForIdempotencyResult(
    store: WebIdempotencyStore,
    keyHash: string,
    bindingHash: string,
    signal: AbortSignal,
  ): Promise<IdempotencyClaim | null> {
    const deadline = Date.now() + idempotencyWaitTimeoutMs;
    let backoffMs = 25;
    while (Date.now() < deadline) {
      if (signal.aborted) return null;
      const localExecution = localIdempotencyExecutions.get(keyHash);
      await Promise.race([
        ...(localExecution ? [localExecution.promise] : []),
        new Promise<void>((resolveWait) => setTimeout(resolveWait, backoffMs)),
      ]);
      const current = store.read(keyHash, bindingHash);
      if (current.status !== "running") return current;
      backoffMs = Math.min(backoffMs * 2, 500);
    }
    return store.read(keyHash, bindingHash);
  }

  function admitIdempotencyWaiter(keyHash: string): (() => void) | null {
    const perKey = idempotencyWaitersByKey.get(keyHash) ?? 0;
    if (
      activeIdempotencyWaiters >= idempotencyMaxWaiters ||
      perKey >= idempotencyMaxWaitersPerKey
    ) {
      return null;
    }
    activeIdempotencyWaiters++;
    idempotencyWaitersByKey.set(keyHash, perKey + 1);
    try {
      opts.idempotency?.onWaiterCountChange?.({
        active: activeIdempotencyWaiters,
        forKey: perKey + 1,
      });
    } catch {
      // Metrics hooks are observational and cannot affect admission.
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeIdempotencyWaiters--;
      const remaining = (idempotencyWaitersByKey.get(keyHash) ?? 1) - 1;
      if (remaining === 0) idempotencyWaitersByKey.delete(keyHash);
      else idempotencyWaitersByKey.set(keyHash, remaining);
      try {
        opts.idempotency?.onWaiterCountChange?.({
          active: activeIdempotencyWaiters,
          forKey: remaining,
        });
      } catch {
        // Metrics hooks are observational and cannot affect admission.
      }
    };
  }

  function beginLocalIdempotencyExecution(keyHash: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    localIdempotencyExecutions.set(keyHash, { promise, resolve });
  }

  function finishLocalIdempotencyExecution(keyHash: string): void {
    const execution = localIdempotencyExecutions.get(keyHash);
    if (!execution) return;
    localIdempotencyExecutions.delete(keyHash);
    execution.resolve();
  }

  function replaySse(body: string): Response {
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "private, no-store",
      connection: "keep-alive",
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = opts.cors.origins.join(",");
      headers["access-control-expose-headers"] =
        `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`;
    }
    return new Response(body, { status: 200, headers });
  }

  async function handleAgentRun(
    req: Request,
    caller: { callerIp: string; error: boolean },
  ): Promise<Response> {
    if (caller.error) {
      return json({ error: "invalid_forwarded_request" }, 400);
    }
    const callerIp = caller.callerIp;
    const suppliedConsoleMarker = req.headers.get(CONSOLE_INTERNAL_RUN_HEADER);
    const isConsoleRun =
      suppliedConsoleMarker !== null &&
      consoleInternalRunMarker !== null &&
      timingSafeEqual(suppliedConsoleMarker, consoleInternalRunMarker);
    // Treat any attempted use of the private capability as an authorization
    // failure. The marker value is never reflected or logged.
    if (suppliedConsoleMarker !== null && !isConsoleRun) {
      return json({ error: "forbidden" }, 403);
    }
    const idempotencyKey = req.headers.get("idempotency-key");
    if (idempotencyKey !== null && !validateIdempotencyKey(idempotencyKey)) {
      return json(
        {
          error: "invalid_idempotency_key",
          reason: "Idempotency-Key must be 1–128 characters matching [A-Za-z0-9_-]",
        },
        400,
      );
    }
    const agentIdHeader = req.headers.get("x-agent-id");
    const agentSecretHeader = req.headers.get("x-agent-secret");
    const hasAnyAgentCredential = agentIdHeader !== null || agentSecretHeader !== null;
    if ((agentIdHeader === null) !== (agentSecretHeader === null)) {
      return json({ error: "invalid agent credentials" }, 401);
    }
    if (hasAnyAgentCredential && req.headers.has(externalAuthHeaderName)) {
      return json({ error: "conflicting authentication credentials" }, 400);
    }
    const authHeader = req.headers.get("authorization") ?? "";
    let externalVisitorAuth: RouteVisitorAuthContext | null | undefined;
    async function readExternalVisitorAuth(): Promise<RouteVisitorAuthContext | null> {
      if (externalVisitorAuth !== undefined) return externalVisitorAuth;
      // Verify first, then consume the replay ID only after this request wins
      // the durable execution claim. Exact keyed followers and replays can
      // therefore join the one authorized execution.
      externalVisitorAuth = await resolveExternalVisitorAuth(
        req,
        idempotencyKey !== null && !isConsoleRun ? "defer" : "consume",
      );
      return externalVisitorAuth;
    }

    // Bearer policy:
    //   - bearer present + valid   → proceed (Path 1 creator, or
    //                                Path 2/3 via the agent/visitor headers
    //                                resolved later in identify())
    //   - bearer present + invalid → 401 (timing-safe; no silent downgrade)
    //   - bearer absent + valid external auth assertion → proceed as
    //                                                    recognized visitor
    //   - bearer absent + allowAnonymous=true           → fall through to
    //                                                    anonymous identity
    //   - bearer absent + neither                       → 401
    const hasBearerAttempt = authHeader.length > 0;
    if (hasBearerAttempt) {
      if (!isValidAuth(authHeader)) {
        return json({ error: "unauthorized" }, 401);
      }
    } else if (!allowAnonymous && (await readExternalVisitorAuth())?.state !== "recognized") {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Idempotency-Key ---
    let publicRunId: string = crypto.randomUUID();
    // --- Visitor token handling ---
    let visitorPayload: VisitorTokenPayload | null = null;
    async function applyExternalVisitorAuth(): Promise<void> {
      const externalAuth = await readExternalVisitorAuth();
      if (externalAuth?.state === "recognized") {
        visitorPayload = {
          visitorId: externalAuth.visitorId,
          agentId: externalAuth.agentId,
          issuedAt: externalAuth.issuedAt,
          expiresAt: externalAuth.expiresAt,
          ...(externalAuth.orgId !== undefined ? { orgId: externalAuth.orgId } : {}),
        };
      }
    }

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
        // Fix C2: reject tokens minted for a different security audience even
        // when agentBinding is omitted. Shared signing keys must never make a
        // visitor credential portable across logical agents.
        if (visitorPayload) {
          const expectedBinding = requireSecurityAudience();
          if (visitorPayload.agentId !== expectedBinding) {
            visitorPayload = null;
          }
        }
      }
      await applyExternalVisitorAuth();
    }
    await applyExternalVisitorAuth();

    // --- Build headers map ---
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() !== CONSOLE_INTERNAL_RUN_HEADER) {
        headers[k.toLowerCase()] = v;
      }
    });

    // --- Parse body (needed for threadId for anonymous peer ID) ---
    let parsedBody: unknown;
    try {
      parsedBody = await readRequestBodyJson(req, maxRequestBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return json({ error: "payload too large", limitBytes: maxRequestBodyBytes }, 413);
      }
      if (!(error instanceof InvalidRequestBodyError)) {
        console.warn("[web-transport] request body read failed");
      }
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return json({ error: "invalid request body" }, 400);
    }
    const body = parsedBody as AGUIRunRequestBody;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: "messages array is required" }, 400);
    }
    if (
      body.messages.some(
        (message) =>
          !message ||
          typeof message !== "object" ||
          typeof message.role !== "string" ||
          message.role.length === 0 ||
          message.role.length > 64 ||
          typeof message.content !== "string",
      )
    ) {
      return json({ error: "messages must contain role and content strings" }, 400);
    }

    const lastMessage = body.messages[body.messages.length - 1]!;
    const text = lastMessage.content;
    if (text.length > maxMessageLength) {
      return json({ error: "message too long", limit: maxMessageLength }, 413);
    }

    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }

    // Derive threadId — needed before identify() so anonymous peer IDs are stable.
    if (
      (body.threadId !== undefined && typeof body.threadId !== "string") ||
      (body.contextId !== undefined && typeof body.contextId !== "string") ||
      (body.taskId !== undefined && typeof body.taskId !== "string")
    ) {
      return json({ error: "invalid thread id" }, 400);
    }
    if (
      (body.threadId?.length ?? 0) > 512 ||
      (body.contextId?.length ?? 0) > 512 ||
      (body.taskId?.length ?? 0) > 512
    ) {
      return json({ error: "request identifier too long", limit: 512 }, 413);
    }
    const requestedThreadId = body.threadId ?? body.contextId;
    let threadId: string = requestedThreadId ?? crypto.randomUUID();
    if (isConsoleRun && !isConsoleChatIdentifier(threadId)) {
      return json({ error: "invalid console thread id" }, 400);
    }
    let threadIsConsoleManaged = false;
    if (isConsoleChatIdentifier(threadId)) {
      try {
        threadIsConsoleManaged = consoleChatStore?.hasThread(threadId) ?? false;
      } catch {
        return json({ error: "console chat storage unavailable" }, 503);
      }
    }
    // A normal /agent/run caller may choose arbitrary thread IDs, but it may
    // never attach to a console-owned conversation and inherit its history.
    if (threadIsConsoleManaged && !isConsoleRun) {
      return json({ error: "forbidden" }, 403);
    }

    const consoleMetadata = isConsoleRun ? parseConsoleRunMetadata(body.__console, text) : null;
    if (isConsoleRun && (!consoleChatStore || !consoleHistoryPersistence || !consoleMetadata)) {
      return json({ error: "invalid console run metadata" }, 400);
    }
    if (consoleMetadata?.runId) {
      if (idempotencyKey !== null && idempotencyKey !== consoleMetadata.runId) {
        return json({ error: "conflicting console run id" }, 400);
      }
      publicRunId = consoleMetadata.runId;
    }

    // Build the trusted identify argument. The HTTP handler adds a verified
    // anonymous-session ID below when this request takes the anonymous path.
    // Path 1 (creator) still requires an already-validated bearer.
    const identifyArg: {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __anonymousSessionId?: string;
      __authenticatedPriorPeerId?: string;
      __bearerValidated: boolean;
    } = { headers, __bearerValidated: hasBearerAttempt };
    if (visitorPayload) {
      identifyArg.__visitorPayload = visitorPayload;
    }

    // --- Check agent auth failure explicitly ---
    // If x-agent-id + x-agent-secret are present, identify() returns null on bad secret.
    const isAgentAttempt = hasAnyAgentCredential;
    let anonymousSessionToken: string | null = null;
    let anonymousSessionId: string | undefined;
    const suppliedSession = req.headers.get(ANONYMOUS_SESSION_HEADER);
    let authenticatedAnonymousSession: ReturnType<
      NonNullable<typeof anonymousSessionManager>["verify"]
    > | null = null;
    if (!hasBearerAttempt && !isAgentAttempt && suppliedSession) {
      authenticatedAnonymousSession = anonymousSessionManager?.verify(suppliedSession) ?? null;
      if (!authenticatedAnonymousSession) {
        return json({ error: "invalid anonymous session" }, 401, {
          [ANONYMOUS_SESSION_STATUS_HEADER]: "invalid",
          "access-control-expose-headers": `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`,
        });
      }
    }
    let authenticatedPriorPeerId = visitorPayload?.priorPeerId;
    let authenticatedThreadScopeId =
      visitorPayload?.priorThreadScopeId ?? visitorPayload?.visitorId;
    if (authenticatedAnonymousSession) {
      if (
        authenticatedPriorPeerId !== undefined &&
        authenticatedPriorPeerId !== authenticatedAnonymousSession.peerId
      ) {
        return json({ error: "visitor promotion proof mismatch" }, 403);
      }
      authenticatedPriorPeerId ??= authenticatedAnonymousSession.peerId;
      authenticatedThreadScopeId ??= authenticatedAnonymousSession.threadScopeId;
    }
    if (!hasBearerAttempt && !visitorPayload && !isAgentAttempt) {
      if (isConsoleRun && consoleMetadata?.previewMode === "anonymous") {
        // The console route is already authenticated and creates this
        // server-managed thread before proxying its internal request. Preserve
        // the store's bound anonymous owner without accepting a caller-derived
        // ID or exposing an anonymous session capability to the browser.
        anonymousSessionId = `anon-${threadId}`;
      } else {
        if (authenticatedAnonymousSession) {
          anonymousSessionId = authenticatedAnonymousSession.peerId;
        } else {
          const issuedSession = anonymousSessionManager?.issue();
          if (!issuedSession) {
            return json({ error: "anonymous session unavailable" }, 503);
          }
          anonymousSessionId = issuedSession.payload.peerId;
          authenticatedThreadScopeId = issuedSession.payload.threadScopeId;
          anonymousSessionToken = issuedSession.token;
        }
      }
      identifyArg.__anonymousSessionId = anonymousSessionId;
    } else if (visitorPayload && authenticatedPriorPeerId) {
      identifyArg.__authenticatedPriorPeerId = authenticatedPriorPeerId;
    }

    const peer = identify(identifyArg);
    if (!peer) {
      if (isAgentAttempt) {
        // Explicit agent auth attempt with wrong credentials.
        return json({ error: "invalid agent credentials" }, 401);
      }
      // Fallback (should not happen with the four-path design, but guard).
      return json({ error: "missing peer identity" }, 400);
    }
    if (!isConsoleRun && peer.trustLevel === "public") {
      threadId = canonicalPublicThreadId(
        requestedThreadId,
        idempotencyKey,
        authenticatedThreadScopeId ?? peer.id,
      );
    } else if (!isConsoleRun && requestedThreadId === undefined && idempotencyKey !== null) {
      threadId = `web_idem_thread_${createHash("sha256")
        .update("auggy-keyed-thread-v1\0")
        .update(requireSecurityAudience())
        .update("\0")
        .update(peer.sourceAugment)
        .update("\0")
        .update(peer.trustLevel)
        .update("\0")
        .update(peer.id)
        .update("\0")
        .update(hashIdempotencyKey(requireSecurityAudience(), idempotencyKey))
        .digest("hex")}`;
    }

    if (
      consoleMetadata?.previewMode === "visitor" &&
      previewModeForPeer(peer) === "visitor" &&
      consoleChatStore
    ) {
      try {
        const existing = consoleChatStore.getThread(threadId);
        if (existing?.previewMode === "anonymous") {
          const promotionAllowed =
            visitorPayload !== null &&
            opts.visitorTokens?.threadPromotionCheck?.(visitorPayload.visitorId, threadId) === true;
          if (!promotionAllowed) {
            return json({ error: "console thread verification does not match" }, 403);
          }
          consoleChatStore.promoteAnonymousThread(threadId, peer, Date.now());
        }
      } catch {
        return json({ error: "console thread identity promotion failed" }, 409);
      }
    }

    if (consoleMetadata && previewModeForPeer(peer) !== consoleMetadata.previewMode) {
      // In particular, an expired/revoked visitor token resolves anonymous and
      // is rejected here before history restore or model inference.
      return json({ error: "console thread identity does not match" }, 403);
    }

    const resolvedExternalAuth = await readExternalVisitorAuth();
    const turnAuth = resolveAgentRunTurnAuth(visitorPayload, resolvedExternalAuth, peer);
    if (resolvedExternalAuth?.state === "recognized" && turnAuth === undefined) {
      return json({ error: "conflicting authentication identity" }, 403);
    }
    if (!isConsoleRun && anonymousSessionToken !== null) {
      return json({ error: "anonymous_session_required" }, 428, {
        [ANONYMOUS_SESSION_HEADER]: anonymousSessionToken,
        "cache-control": "private, no-store",
        "access-control-expose-headers": `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`,
      });
    }

    const requiresAnonymousAdmission =
      !isConsoleRun &&
      peer.trustLevel === "public" &&
      peer.publicSubstate === "anonymous" &&
      peerRateLimit !== undefined;
    if (requiresAnonymousAdmission && idempotencyKey === null) {
      let networkLimit: { allowed: true } | { allowed: false; retryAfterSec: number };
      try {
        networkLimit = reserveAnonymousExecution(callerIp);
      } catch {
        return json({ error: "rate_limit_unavailable" }, 503);
      }
      if (!networkLimit.allowed) {
        return json({ error: "rate-limited" }, 429, {
          "retry-after": String(networkLimit.retryAfterSec),
        });
      }
    }

    let internalTurnId = idempotencyKey === null ? publicRunId : crypto.randomUUID();
    let durableIdempotency: {
      store: WebIdempotencyStore;
      keyHash: string;
      ownerToken: string;
    } | null = null;
    if (idempotencyKey !== null && !isConsoleRun) {
      const store = idempotencyStore;
      if (!store) {
        return json({ error: "idempotency_unavailable" }, 503);
      }
      const audience = requireSecurityAudience();
      const keyHash = hashIdempotencyKey(audience, idempotencyKey);
      const capacityClass =
        peer.trustLevel === "creator"
          ? "creator"
          : peer.trustLevel === "agent"
            ? "agent"
            : "public";
      const partitionHash = hashIdempotencyBinding({
        audience,
        capacityClass,
        subject:
          capacityClass === "public" && peer.publicSubstate === "anonymous"
            ? "all-anonymous"
            : peer.id,
      });
      const bindingHash = hashIdempotencyBinding({
        audience,
        peer: {
          id: peer.id,
          kind: peer.kind,
          trustLevel: peer.trustLevel,
          publicSubstate: peer.publicSubstate,
          sourceAugment: peer.sourceAugment,
          displayName: peer.displayName,
          orgId: peer.orgId,
        },
        threadId,
        contextId: body.contextId,
        taskId: body.taskId,
        messages: body.messages,
        auth: idempotencyAuthorizationBinding(turnAuth),
      });
      let claim: IdempotencyClaim;
      try {
        claim = store.claim(
          keyHash,
          bindingHash,
          {
            class: capacityClass,
            partitionHash,
          },
          requiresAnonymousAdmission && anonymousNetworkMode !== "trusted-edge"
            ? anonymousRateLimitPolicies(callerIp)
            : undefined,
        );
        if (claim.status === "running") {
          const releaseWaiter = admitIdempotencyWaiter(keyHash);
          if (!releaseWaiter) {
            return json({ error: "idempotency_waiter_capacity_reached" }, 429, {
              "retry-after": "1",
            });
          }
          try {
            claim = (await waitForIdempotencyResult(store, keyHash, bindingHash, req.signal)) ?? {
              status: "running",
              turnId: claim.turnId,
            };
          } finally {
            releaseWaiter();
          }
        }
      } catch {
        return json({ error: "idempotency_unavailable" }, 503);
      }

      if (claim.status === "replay") return replaySse(claim.responseBody);
      if (claim.status === "conflict") {
        return json({ error: "idempotency_key_conflict" }, 409);
      }
      if (claim.status === "unknown") {
        return json({ error: "idempotency_outcome_unknown" }, 409);
      }
      if (claim.status === "capacity") {
        return json({ error: "idempotency_capacity_reached" }, 503);
      }
      if (claim.status === "rate-limited") {
        return json({ error: "rate-limited" }, 429, {
          "retry-after": String(claim.retryAfterSec),
        });
      }
      if (claim.status === "running") {
        return json({ error: "idempotency_in_progress" }, 409, { "retry-after": "1" });
      }

      internalTurnId = claim.turnId;
      publicRunId = claim.turnId;
      if (externalAuthReplayStore && turnAuth?.state === "recognized") {
        const replayId = turnAuth.externalAuth?.jti;
        let accepted = false;
        if (replayId) {
          try {
            accepted = await externalAuthReplayStore.consume(
              replayId,
              turnAuth.expiresAt,
              Date.now(),
            );
          } catch {
            console.warn("[web-transport] external auth replay store failed.");
          }
        }
        if (!accepted) {
          // The assertion was replayed under a different execution claim, or
          // the replay store failed. Preserve this claim as outcome-unknown so
          // the caller cannot cycle the same key until an unsafe execution is
          // eventually admitted.
          try {
            store.markUnknown(keyHash, claim.ownerToken);
          } catch {
            return json({ error: "idempotency_unavailable" }, 503);
          }
          return json({ error: "unauthorized" }, 401);
        }
      }
      beginLocalIdempotencyExecution(keyHash);
      durableIdempotency = {
        store,
        keyHash,
        ownerToken: claim.ownerToken,
      };
    }

    const runStartedAt = Date.now();
    if (consoleMetadata && consoleChatStore) {
      try {
        consoleChatStore.beginRun({
          thread: {
            id: threadId,
            title: consoleMetadata.title,
            previewMode: consoleMetadata.previewMode,
            model: consoleMetadata.model,
            createdAt: runStartedAt,
            updatedAt: runStartedAt,
            unread: false,
            runStatus: "streaming",
          },
          peer,
          runId: publicRunId,
          userMessage: {
            id: consoleMetadata.userMessageId,
            role: "user",
            content: text,
            createdAt: runStartedAt,
          },
          assistantMessage: {
            id: consoleMetadata.assistantMessageId,
            role: "assistant",
            content: "",
            createdAt: runStartedAt,
          },
        });
      } catch (error) {
        if (isConsoleChatThreadDeletedError(error)) {
          return json({ error: "console thread was deleted" }, 410);
        }
        return json({ error: "console thread access denied or already running" }, 409);
      }
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
      turnId: internalTurnId,
      threadId,
      contextId: body.contextId,
      taskId: body.taskId,
      timestamp: Date.now(),
      source: "web",
      peer,
      ...(turnAuth !== undefined ? { auth: turnAuth } : {}),
      payload: inbound,
    };

    const k = kernel;
    const encoder = new TextEncoder();
    // The kernel keys restored thread authorization by persistence object
    // identity, so every run must receive this stable transport-level adapter.
    const runHistoryPersistence = consoleMetadata ? consoleHistoryPersistence : null;
    const deliveryAbort = new AbortController();
    const executionSignal = durableIdempotency
      ? deliveryAbort.signal
      : AbortSignal.any([req.signal, deliveryAbort.signal]);

    let pullPendingSse: ((controller: ReadableStreamDefaultController<Uint8Array>) => void) | null =
      null;
    let cancelSse: ((reason?: unknown) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let streamClosed = false;
        let executionFinished = false;
        const pendingChunks: Uint8Array[] = [];
        let pendingBytes = 0;
        let deliveryOverflow = false;
        let bufferedRunFinished: AGUIEvent | null = null;
        let assistantContent = "";
        let assistantError: string | null = null;
        let consoleAggregateBytes = 0;
        const messageRoles = new Map<string, string>();
        let lastAssistantMessageId: string | null = null;
        const toolCalls = new Map<string, ConsoleChatToolCall>();
        let persistenceFailure: unknown = null;
        let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const idempotencyHeartbeatTimer = durableIdempotency
          ? setInterval(
              () => {
                try {
                  durableIdempotency.store.heartbeat(
                    durableIdempotency.keyHash,
                    durableIdempotency.ownerToken,
                  );
                } catch {
                  // A failed heartbeat cannot authorize takeover. Once stale,
                  // followers create an outcome-unknown tombstone.
                }
              },
              Math.max(1, Math.floor(idempotencyStaleAfterMs / 3)),
            )
          : null;
        const replayChunks: string[] = [];
        let replayBytes = 0;
        let replayOverflow = false;

        const failLiveDelivery = (): void => {
          if (deliveryOverflow) return;
          deliveryOverflow = true;
          streamClosed = true;
          pendingChunks.length = 0;
          pendingBytes = 0;
          deliveryAbort.abort(new Error("SSE delivery exceeded the configured safety limit."));
          try {
            controller.error(new Error("SSE delivery exceeded the configured safety limit."));
          } catch {
            // The client may already have disconnected.
          }
        };

        pullPendingSse = (activeController) => {
          if (streamClosed) return;
          while (
            pendingChunks.length > 0 &&
            (activeController.desiredSize === null || activeController.desiredSize > 0)
          ) {
            const chunk = pendingChunks.shift()!;
            pendingBytes -= chunk.byteLength;
            activeController.enqueue(chunk);
          }
          if (executionFinished && pendingChunks.length === 0) {
            streamClosed = true;
            activeController.close();
          }
        };
        cancelSse = () => {
          streamClosed = true;
          pendingChunks.length = 0;
          pendingBytes = 0;
          // Keyed durable runs intentionally survive a client disconnect so
          // an exact retry can replay the canonical result. Resource-limit
          // overflow still aborts both durable and non-durable execution.
          if (!durableIdempotency) deliveryAbort.abort();
        };

        const patchRunIdentity = (e: AGUIEvent): AGUIEvent => {
          if (e.type === "RUN_STARTED" || e.type === "RUN_FINISHED") {
            // Internal turn IDs are server-generated and remain available to
            // budgets/traces. The caller sees its stable public run ID.
            return { ...e, threadId, runId: publicRunId };
          }
          return e;
        };

        const writeEvent = (e: AGUIEvent) => {
          const serialized = serializeSSE(patchRunIdentity(e));
          if (durableIdempotency && !replayOverflow) {
            const eventBytes = Buffer.byteLength(serialized, "utf8");
            if (replayBytes + eventBytes > idempotencyMaxReplayBytes) {
              replayOverflow = true;
              replayChunks.length = 0;
            } else {
              replayBytes += eventBytes;
              replayChunks.push(serialized);
            }
          }
          if (streamClosed) return;
          const chunk = encoder.encode(serialized);
          if (chunk.byteLength > maxPendingSseBytes) {
            failLiveDelivery();
            return;
          }
          if (
            pendingChunks.length === 0 &&
            (controller.desiredSize === null || controller.desiredSize > 0)
          ) {
            try {
              controller.enqueue(chunk);
              return;
            } catch {
              streamClosed = true;
              pendingChunks.length = 0;
              pendingBytes = 0;
              if (!durableIdempotency) deliveryAbort.abort();
              return;
            }
          }
          if (
            pendingChunks.length + 1 > maxPendingSseEvents ||
            pendingBytes + chunk.byteLength > maxPendingSseBytes
          ) {
            failLiveDelivery();
            return;
          }
          pendingChunks.push(chunk);
          pendingBytes += chunk.byteLength;
        };

        const currentToolCalls = (): ConsoleChatToolCall[] | null =>
          toolCalls.size === 0 ? null : Array.from(toolCalls.values(), (call) => ({ ...call }));

        const writeProgress = (): void => {
          if (!consoleMetadata || !consoleChatStore || persistenceFailure) return;
          try {
            const updated = consoleChatStore.updateRun(
              threadId,
              publicRunId,
              consoleMetadata.assistantMessageId,
              {
                content: assistantContent,
                toolCalls: currentToolCalls(),
                error: assistantError,
                updatedAt: Date.now(),
              },
            );
            if (!updated) throw new Error("console chat run is no longer active");
          } catch (error) {
            persistenceFailure = error;
          }
        };

        const persistProgress = (): void => {
          if (!consoleMetadata || !consoleChatStore || persistenceFailure) return;
          // Throttle rather than debounce: a long, continuously streaming
          // response still needs periodic crash-recoverable checkpoints.
          if (progressFlushTimer !== null) return;
          progressFlushTimer = setTimeout(() => {
            progressFlushTimer = null;
            writeProgress();
          }, 40);
        };

        const flushProgress = (): void => {
          if (progressFlushTimer !== null) {
            clearTimeout(progressFlushTimer);
            progressFlushTimer = null;
          }
          writeProgress();
        };

        const reserveConsoleBytes = (value: string): boolean => {
          const bytes = Buffer.byteLength(value, "utf8");
          if (consoleAggregateBytes + bytes > maxConsoleRunBytes) {
            assistantError = "Console response exceeded the configured safety limit.";
            failLiveDelivery();
            return false;
          }
          consoleAggregateBytes += bytes;
          return true;
        };

        const observeEvent = (event: AGUIEvent): boolean => {
          switch (event.type) {
            case "TEXT_MESSAGE_START":
              messageRoles.set(event.messageId, event.role);
              if (event.role === "assistant" && lastAssistantMessageId !== event.messageId) {
                if (lastAssistantMessageId !== null) {
                  assistantContent = appendTextSegmentBoundary(assistantContent);
                }
                lastAssistantMessageId = event.messageId;
              }
              return true;
            case "TEXT_MESSAGE_CONTENT":
              if (messageRoles.get(event.messageId) === "assistant") {
                if (!reserveConsoleBytes(event.delta)) return false;
                assistantContent += event.delta;
                persistProgress();
              }
              return true;
            case "TEXT_MESSAGE_END":
              messageRoles.delete(event.messageId);
              return true;
            case "TOOL_CALL_START":
              if (!reserveConsoleBytes(event.toolCallName)) return false;
              toolCalls.set(event.toolCallId, {
                id: event.toolCallId,
                name: event.toolCallName,
                status: "running",
              });
              persistProgress();
              return true;
            case "TOOL_CALL_ARGS": {
              const call = toolCalls.get(event.toolCallId);
              if (call) {
                if (!reserveConsoleBytes(event.delta)) return false;
                call.args = `${call.args ?? ""}${event.delta}`;
                persistProgress();
              }
              return true;
            }
            case "TOOL_CALL_END":
              return true;
            case "TOOL_CALL_RESULT": {
              const call = toolCalls.get(event.toolCallId);
              if (call) {
                if (!reserveConsoleBytes(event.content)) return false;
                call.result = event.content;
                call.status = "completed";
                persistProgress();
              }
              return true;
            }
            case "RUN_ERROR":
              assistantError = event.message;
              for (const call of toolCalls.values()) {
                if (call.status === "running") call.status = "error";
              }
              persistProgress();
              return true;
            default:
              return true;
          }
        };

        const emitTranslatedEvent = (event: AGUIEvent): void => {
          const patched = patchRunIdentity(event);
          if (patched.type === "RUN_FINISHED") {
            bufferedRunFinished = patched;
            return;
          }
          if (!observeEvent(patched)) return;
          writeEvent(patched);
        };

        const finishPersistedRun = (
          status: "complete" | "error" | "interrupted",
          terminal: AGUIEvent,
          emitTerminal = true,
        ): void => {
          if (consoleMetadata && consoleChatStore) {
            flushProgress();
            try {
              const finishInput = {
                status,
                content: assistantContent,
                toolCalls: currentToolCalls(),
                error: assistantError,
                unread: consoleMetadata.unreadOnFinish,
                updatedAt: Date.now(),
              } as const;
              const pendingHistory = consoleHistoryPersistence?.pendingSnapshot(threadId, peer);
              const finished = pendingHistory
                ? consoleChatStore.finishRunWithKernelHistory(
                    threadId,
                    publicRunId,
                    consoleMetadata.assistantMessageId,
                    peer,
                    pendingHistory,
                    finishInput,
                  )
                : consoleChatStore.finishRun(
                    threadId,
                    publicRunId,
                    consoleMetadata.assistantMessageId,
                    finishInput,
                  );
              if (!finished) {
                throw persistenceFailure ?? new Error("console chat run is no longer active");
              }
              consoleHistoryPersistence?.discardPending(threadId);
              persistenceFailure = null;
            } catch (error) {
              persistenceFailure ??= error;
              consoleHistoryPersistence?.discardPending(threadId);
              // The resident manager may contain a response that did not reach
              // the atomic transcript/history commit. Force the next attempt to
              // restore the last durable snapshot instead of retaining it.
              k.forgetThreadHistory?.(threadId);
              // A terminal aggregate can itself be invalid (for example an
              // oversized model response). Clear the run lease without
              // replacing the last valid partial transcript.
              try {
                consoleChatStore.abandonRun(
                  threadId,
                  publicRunId,
                  consoleMetadata.assistantMessageId,
                  {
                    status: status === "interrupted" ? "interrupted" : "error",
                    error: "Console response could not be fully persisted.",
                    unread: consoleMetadata.unreadOnFinish,
                    updatedAt: Date.now(),
                  },
                );
              } catch {
                // The outer handler still emits a failed terminal event. A
                // process restart recovers any genuinely unreachable lease.
              }
              throw error;
            }
          }
          if (emitTerminal) writeEvent(terminal);
        };

        const onEvent = (kernelEvent: KernelEvent) => {
          if (kernelEvent.kind === "delegated_authorization_denied") {
            emitDelegatedAuthorizationDenied(kernelEvent);
          }
          for (const e of translateKernelEvent(kernelEvent)) {
            emitTranslatedEvent(e);
          }
        };

        (async () => {
          try {
            const result = await k.handleInbound(trigger, {
              onEvent,
              signal: executionSignal,
              ...(runHistoryPersistence ? { historyPersistence: runHistoryPersistence } : {}),
            });
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
              const errorEvent = runError({
                message: result.errorResponse ?? "request rejected by transport",
                code,
              });
              observeEvent(errorEvent);
              writeEvent(errorEvent);
              bufferedRunFinished = runFinished({
                threadId,
                runId: publicRunId,
                status: result.status,
              });
            }
            const persistedStatus =
              result.status === "canceled"
                ? "interrupted"
                : result.status === "failed" || result.status === "rejected"
                  ? "error"
                  : "complete";
            finishPersistedRun(
              persistedStatus,
              bufferedRunFinished ??
                runFinished({ threadId, runId: publicRunId, status: result.status }),
            );
          } catch (err) {
            const interrupted = executionSignal.aborted;
            const normalizedError = runError({ message: String(err), code: "INTERNAL" });
            const errorEvent = interrupted
              ? runError({ message: "Request interrupted.", code: "ABORTED" })
              : normalizedError.code?.startsWith("PROVIDER_")
                ? normalizedError
                : runError({ message: "Internal error.", code: "INTERNAL" });
            observeEvent(errorEvent);
            writeEvent(errorEvent);
            try {
              finishPersistedRun(
                interrupted ? "interrupted" : "error",
                runFinished({
                  threadId,
                  runId: publicRunId,
                  status: interrupted ? "canceled" : "failed",
                }),
                true,
              );
            } catch {
              // Never expose a buffered success when durability failed, but
              // always terminate the client stream so the composer cannot
              // remain stuck in a streaming state.
              writeEvent(
                runFinished({
                  threadId,
                  runId: publicRunId,
                  status: interrupted ? "canceled" : "failed",
                }),
              );
            }
          } finally {
            if (progressFlushTimer !== null) clearTimeout(progressFlushTimer);
            if (idempotencyHeartbeatTimer !== null) clearInterval(idempotencyHeartbeatTimer);
            if (durableIdempotency) {
              try {
                if (replayOverflow) {
                  durableIdempotency.store.markUnknown(
                    durableIdempotency.keyHash,
                    durableIdempotency.ownerToken,
                  );
                } else {
                  durableIdempotency.store.complete(
                    durableIdempotency.keyHash,
                    durableIdempotency.ownerToken,
                    replayChunks.join(""),
                  );
                }
              } catch {
                // Leave the durable running claim in place. Future attempts
                // fail closed rather than risking duplicate execution.
              } finally {
                finishLocalIdempotencyExecution(durableIdempotency.keyHash);
              }
            }
            executionFinished = true;
            if (!streamClosed && pendingChunks.length === 0) {
              streamClosed = true;
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          }
        })();
      },
      pull(controller) {
        pullPendingSse?.(controller);
      },
      cancel(reason) {
        cancelSse?.(reason);
      },
    });

    const sseHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "private, no-store",
      connection: "keep-alive",
    };
    if (anonymousSessionToken) {
      sseHeaders[ANONYMOUS_SESSION_HEADER] = anonymousSessionToken;
    }
    if (opts.cors) {
      sseHeaders["access-control-allow-origin"] = opts.cors.origins.join(",");
      sseHeaders["access-control-expose-headers"] =
        `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`;
    }
    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  function handleCorsPreFlight(): Response {
    const allowedHeaders = [
      "content-type",
      "authorization",
      "x-peer-id",
      "x-peer-kind",
      "x-peer-name",
      "x-org-id",
      ANONYMOUS_SESSION_HEADER,
      "x-visitor-token",
      DEFAULT_EXTERNAL_AUTH_ASSERTION_HEADER,
      "x-agent-id",
      "x-agent-secret",
      "idempotency-key",
    ];
    if (opts.externalAuth && !allowedHeaders.includes(externalAuthHeaderName)) {
      allowedHeaders.push(externalAuthHeaderName);
    }
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": allowedHeaders.join(", "),
      "access-control-expose-headers": `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`,
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

  function handleAgentCard(req: Request): Response {
    if (!publicIntegration && !isValidAuth(req.headers.get("authorization") ?? "")) {
      return new Response(null, { status: 404 });
    }
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

  function withCorsHeaders(response: Response): Response {
    if (!opts.cors) return response;
    const headers = new Headers(response.headers);
    if (!headers.has("access-control-allow-origin")) {
      headers.set("access-control-allow-origin", opts.cors.origins.join(","));
    }
    if (!headers.has("access-control-expose-headers")) {
      headers.set(
        "access-control-expose-headers",
        `${ANONYMOUS_SESSION_HEADER}, ${ANONYMOUS_SESSION_STATUS_HEADER}, x-visitor-token, idempotency-key`,
      );
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return {
    name: "web",
    type: "webTransport",
    category: "transports",
    transport,
    adminInfo,
    adminActions,
    async onBoot() {
      validateExternalAuthRuntimeOptions(opts.externalAuth as unknown);
      const anonymousBoundaryError = anonymousRateLimitConfigurationError(allowAnonymous);
      if (anonymousBoundaryError) {
        throw new Error(`[web-transport] ${anonymousBoundaryError}.`);
      }
      if (allowAnonymous && peerRateLimit !== undefined) {
        if (anonymousNetworkMode === "trusted-edge") {
          console.warn(
            "[web-transport] anonymous network admission is delegated to an explicitly trusted edge; the edge must enforce the configured deployment-wide and caller-network limits.",
          );
        } else if (anonymousNetworkMode === "single-process-development") {
          console.warn(
            "[web-transport] anonymous network admission is process-local and development-only; replicas and restarts do not share its counters.",
          );
        }
      }
      if (opts.adminRoute !== false && opts.agentDir && !managedRootRetained) {
        if (!supportsManagedFileIsolation()) {
          console.warn(
            "[web-transport] console managed-file operations are unavailable on this platform; authentication, chat, and read-only runtime views remain enabled.",
          );
        } else if (!retainManagedRoot(opts.agentDir)) {
          throw new Error(
            "[web-transport] console-managed files require a real agent directory and descriptor-relative isolation on macOS or Linux.",
          );
        } else {
          managedRootRetained = true;
        }
      }
      if (opts.cors && opts.cors.origins.length !== 1) {
        throw new Error(
          "[web-transport] cors.origins must contain exactly one browser origin. Multiple Access-Control-Allow-Origin values are not valid; run separate public origins behind an app proxy until dynamic origin matching is supported.",
        );
      }
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
      const idempotencyDbPath = resolveIdempotencyDbPath(opts);
      if (idempotencyDbPath !== null) {
        idempotencyStore = createWebIdempotencyStore({
          dbPath: idempotencyDbPath,
          maxRecords: opts.idempotency?.maxRecords,
          maxRateLimitRecords: opts.idempotency?.maxRateLimitRecords,
          maxReplayBytes: idempotencyMaxReplayBytes,
          maxStoredBytes: idempotencyMaxStoredBytes,
          maxRecordsPerPartition: opts.idempotency?.maxRecordsPerPartition,
          maxPublicRecords: opts.idempotency?.maxPublicRecords,
          maxAgentRecords: opts.idempotency?.maxAgentRecords,
          maxCreatorRecords: opts.idempotency?.maxCreatorRecords,
          staleAfterMs: idempotencyStaleAfterMs,
          retentionMs: idempotencyRetentionMs,
        });
      }
      const consoleDbPath = resolveConsoleChatDbPath(opts);
      if (consoleDbPath !== null) {
        // openHardenedSqlite creates missing parents with mode 0700 and
        // rejects unsafe existing directories without mutating operator paths.
        consoleChatStore = createConsoleChatStore({ dbPath: consoleDbPath });
        consoleHistoryPersistence = createDeferredConsoleThreadHistoryPersistence(consoleChatStore);
      }
      // Listener activation is deferred until TransportSpec.ready(), after
      // every transport has captured its kernel handle.
      startServer = () => {
        server = Bun.serve({
          port: opts.port,
          idleTimeout: 120, // 120s — covers long model calls + tool chains
          async fetch(req, server) {
            const url = new URL(req.url);

            // CORS preflight — required for browser-based AG-UI clients
            if (req.method === "OPTIONS") {
              return handleCorsPreFlight();
            }

            // G36 — /console route. Opt-out via adminRoute: false makes the route
            // look like a 404 (no signal that console exists when disabled).
            // Exact-match on "/console" + scoped prefix on "/console/action/" — NOT
            // startsWith("/console") which would also match /administrative and
            // leak the opt-out setting (M3 fix).
            const adminEnabled = opts.adminRoute !== false;
            // SPA expansion — accept the bare `/console`, the action POST surface,
            // and any client-side route under `/console/<path>`. Using the literal
            // `/console/` prefix (note trailing slash) keeps siblings like
            // `/administrative` from being captured (M3 fix preserved).
            const isAdminPath = url.pathname === "/console" || url.pathname.startsWith("/console/");
            if (adminEnabled && isAdminPath) {
              const consoleRequest = evaluateConsoleRequest({
                req,
                connectionIp: getConnectionIp(req, server),
                trustedProxies,
                allowedOrigins: consoleAllowedOrigins,
              });
              if (!consoleRequest.ok) {
                return withConsoleBoundaryHeaders(
                  new Response(
                    JSON.stringify({
                      error: "console request rejected",
                      code: "CONSOLE_REQUEST_REJECTED",
                    }),
                    {
                      status: consoleRequest.status,
                      headers: {
                        "content-type": "application/json",
                        "cache-control": "no-store",
                      },
                    },
                  ),
                );
              }
              if (req.method === "HEAD") {
                return withConsoleBoundaryHeaders(
                  new Response(null, {
                    status: 405,
                    headers: { allow: "GET, POST" },
                  }),
                );
              }
              if (req.method !== "GET" && req.method !== "POST") {
                return withConsoleBoundaryHeaders(
                  new Response(null, {
                    status: 405,
                    headers: { allow: "GET, POST" },
                  }),
                );
              }

              // M4 fix — rate-limit BEFORE handling. Per-IP combined budget
              // across the entire /console* surface: 60 req/min via synthetic
              // route-key "admin" for compatibility. Defeats brute-force against
              // HTTP Basic.
              const adminIp = consoleRequest.callerIp;
              const adminRl = checkRouteRateLimit("admin", adminIp, 60);
              if (!adminRl.allowed) {
                return withConsoleBoundaryHeaders(
                  new Response(null, {
                    status: 429,
                    headers: { "retry-after": String(adminRl.retryAfterSec) },
                  }),
                );
              }

              if (!kernel) {
                return withConsoleBoundaryHeaders(new Response(null, { status: 503 }));
              }
              return handleAdminRoute(req, {
                kernel,
                bearer: opts.auth.token,
                agentDir: opts.agentDir,
                callerIp: adminIp,
                secureRequest: consoleRequest.secure,
                requestOrigin: consoleRequest.origin,
                allowInsecureLoopback: consoleRequest.allowInsecureLoopback,
                actionRegistry,
                staticDir: adminStaticDir,
                selfPort: opts.port,
                ...(consoleChatStore ? { consoleChat: consoleChatStore } : {}),
                ...(consoleInternalRunMarker
                  ? { consoleChatInternalMarker: consoleInternalRunMarker }
                  : {}),
                ...(visitorTokensEnabled && opts.visitorTokens?.identityLookup
                  ? { resolveConsoleVisitorIdentity }
                  : {}),
              });
            }

            // G2 — GET / and HEAD / for the info endpoint or operator-configured
            // redirect. URL validation + HTML caching ran once in register();
            // per-request work is just method/branch + Response construction.
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
              if (validatedPublicFrontendUrl !== undefined) {
                // Both GET and HEAD use manual construction so URL validation
                // happens at register-time only (not per-request). Body is null
                // in both — visitors follow the Location header.
                return new Response(null, {
                  status: 302,
                  headers: { location: validatedPublicFrontendUrl },
                });
              }
              // Info page path. infoPageHtml is non-null here by construction
              // in register() — the defensive guard exists in case of future
              // refactor breakage.
              if (infoPageHtml === null) return new Response(null, { status: 404 });
              const headers = new Headers({
                "content-type": "text/html; charset=utf-8",
                "cache-control": PUBLIC_PAGE_CACHE_CONTROL,
              });
              // RFC 9110 §9.3.2 — HEAD's headers SHOULD match GET's. Set
              // Content-Length explicitly. Bun's auto-compute behavior on
              // null-body responses is verified by the Content-Length probe
              // test in tests/transports/web-transport.test.ts; if Bun
              // overrides this value to 0, the test documents the deviation.
              headers.set("content-length", String(infoPageByteLength));
              return new Response(req.method === "HEAD" ? null : infoPageHtml, {
                status: 200,
                headers,
              });
            }

            if (req.method === "POST" && url.pathname === "/agent/run") {
              return handleAgentRun(
                req,
                resolveCallerIp(req, server, trustedProxies, xffOnUntrusted),
              );
            }
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/agent/") {
              if (!publicIntegration) return new Response(null, { status: 404 });
              return new Response(null, {
                status: 308,
                headers: { location: "/agent" },
              });
            }
            if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/agent") {
              if (!publicIntegration || agentIntegrationPageHtml === null) {
                return new Response(null, { status: 404 });
              }
              const headers = new Headers({
                "content-type": "text/html; charset=utf-8",
                "cache-control": PUBLIC_PAGE_CACHE_CONTROL,
              });
              headers.set("content-length", String(agentIntegrationPageByteLength));
              return new Response(req.method === "HEAD" ? null : agentIntegrationPageHtml, {
                status: 200,
                headers,
              });
            }
            if (req.method === "GET" && url.pathname === "/health") {
              return handleHealth();
            }
            if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
              return handleAgentCard(req);
            }

            // PR γ.1 + v1.x — augment-registered routes. Exact routes win first;
            // parameterized routes (`/items/:id`) are matched after exact paths.
            const augmentRouteMatch = findAugmentRoute(req.method, url.pathname);
            if (augmentRouteMatch) {
              const { route: augmentRoute, params } = augmentRouteMatch;
              const routeAuth = await authorizeAugmentRoute(req, augmentRoute.auth);
              if (!routeAuth.ok) return routeAuth.response;

              const authorization = evaluateDelegatedAuthorization(augmentRoute.requires, {
                auth: routeAuth.context,
                params,
              });
              if (!authorization.ok) {
                emitDelegatedAuthorizationDenied(
                  delegatedAuthorizationDeniedAuditEvent({
                    decision: authorization,
                    auth: routeAuth.context,
                    target: {
                      type: "route",
                      route: `${augmentRoute.method} ${augmentRoute.path}`,
                      method: augmentRoute.method,
                      path: augmentRoute.path,
                      auth: augmentRoute.auth,
                    },
                  }),
                );
                return json(delegatedAuthorizationForbiddenErrorBody(authorization.reason), 403);
              }

              // Per-route rate limit runs before body buffering so rejected public
              // POSTs do not force reads up to maxBodyBytes before receiving 429.
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

              // Finding 2 — body-size cap. Buffer the request body up to maxBodyBytes
              // bytes, enforcing actual byte-count (not just content-length header).
              // Adversarial clients can omit content-length or use chunked encoding
              // to bypass a header-only check.
              const maxBodyBytes = augmentRoute.maxBodyBytes ?? 1_048_576;
              let dispatchReq: Request = req;
              let rawBody: Uint8Array<ArrayBufferLike> = new Uint8Array();
              if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
                try {
                  const buffered = await readBodyWithCap(req.body, maxBodyBytes);
                  if (buffered === null) {
                    return json({ error: "payload-too-large" }, 413);
                  }
                  rawBody = buffered;
                  // Reconstruct the Request with the buffered body so the handler
                  // sees the same bytes (and can call req.text(), req.json(), etc).
                  dispatchReq = new Request(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: buffered,
                    signal: req.signal,
                  });
                } catch (_err) {
                  // Body read errors are 400 — caller's problem, not ours.
                  return json({ error: "bad-body" }, 400);
                }
              }

              const webhookPolicy = await verifyRouteWebhookPolicy(
                augmentRoute,
                dispatchReq,
                rawBody,
              );
              if (!webhookPolicy.ok) {
                return json({ error: webhookPolicy.error }, webhookPolicy.status);
              }

              try {
                const timeoutMs = augmentRoute.timeoutMs ?? 30_000;
                const response = await withTimeout(
                  (deadlineSignal) =>
                    augmentRoute.handler(dispatchReq, {
                      signal: deadlineSignal,
                      auth: routeAuth.context,
                      params,
                      ...(webhookPolicy.context ? { webhook: webhookPolicy.context } : {}),
                      routePath: augmentRoute.path,
                    }),
                  timeoutMs,
                  req.signal,
                );
                return withCorsHeaders(response);
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
            const allowedMethods = [
              ...new Set(
                augmentRoutes
                  .filter(
                    (r) => r.method !== req.method && matchRoutePath(r.path, url.pathname) !== null,
                  )
                  .map((r) => r.method),
              ),
            ];
            if (allowedMethods.length > 0) {
              return withCorsHeaders(
                new Response("Method Not Allowed", {
                  status: 405,
                  headers: { allow: allowedMethods.join(", ") },
                }),
              );
            }

            return new Response("Not Found", { status: 404 });
          },
        });
      };
    },
    async onShutdown() {
      if (server) {
        server.stop();
        server = null;
      }
      if (managedRootRetained) {
        releaseManagedRoot(opts.agentDir);
        managedRootRetained = false;
      }
      if (overrideRootRetained) {
        releaseAdminOverrideRoot(overrideDir);
        overrideRootRetained = false;
      }
      consoleHistoryPersistence?.discardAllPending();
      consoleHistoryPersistence = null;
      consoleChatStore?.close();
      consoleChatStore = null;
      idempotencyStore?.close();
      idempotencyStore = null;
      for (const execution of localIdempotencyExecutions.values()) execution.resolve();
      localIdempotencyExecutions.clear();
      idempotencyWaitersByKey.clear();
      activeIdempotencyWaiters = 0;
      startServer = null;
      kernel = null;
      augmentRoutes = [];
      augmentRouteMap = new Map();
      augmentPatternRoutes = [];
      actionRegistry = new Map();
    },
  };
}

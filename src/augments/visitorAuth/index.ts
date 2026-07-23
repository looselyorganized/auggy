/**
 * visitorAuth augment — email magic-link verification flow.
 *
 * Owns: SQLite store (visitor-auth.db), `request_auth` tool, /visitor-auth/verify
 * HTTP route, per-peer rate limiter, per-peer recent-message buffer (for the
 * email-in-recent-message check), and a context block summarizing verification
 * state for the active peer.
 *
 * This module is intentionally bottom-of-stack: it imports types, storage,
 * helpers, and the shared agentmail-client. It does NOT import notify or any
 * notify adapter — see plan §"Spec deviation".
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { defineRoute, defineTool, json } from "../../helpers";
import { createAgentMailClient, type AgentMailClient } from "../../agentmail-client";
import { createConsoleMailClient } from "./console-mail-client";
import { createVisitorToken, deriveSigningKey } from "../../transports/visitor-token";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  ContextBlock,
  ToolExecuteContext,
  TurnState,
} from "../../types";
import type {
  RecentVisitorMessage,
  RequestAuthResult,
  VisitorAuthAugmentExtras,
  VisitorAuthOptions,
  VisitorAuthRateLimit,
} from "./types";
import {
  createSqliteVisitorAuthStore,
  type SqliteVisitorAuthStoreConfig,
} from "./storage/sqlite-store";
import type { VisitorAuthStore } from "./storage/types";
import { emailAppearsInRecentMessages, isWellFormedEmail } from "./email-validation";
import { createVisitorAuthRateLimiter, type VisitorAuthRateLimiter } from "./rate-limiter";
import { reassignSqliteMemoryPeerId } from "../layeredMemory/storage/sqlite-store";
import {
  buildVerifyConfirmPage,
  buildVerifyFailurePage,
  buildVerifySuccessPage,
} from "./verify-page";

const DEFAULT_TOKEN_TTL_MIN = 15;
const DEFAULT_REVERIFY_DAYS = 90;
const DEFAULT_AGENTMAIL_RATE_LIMIT = { perHour: 1, perDay: 3 };
const DEFAULT_CONSOLE_RATE_LIMIT = {
  minIntervalSeconds: 10,
  // These ceilings are exactly what a 10-second cooldown permits, so the
  // local default behaves as a cooldown without a surprising longer window.
  perHour: 360,
  perDay: 8_640,
};
const VERIFY_PATH = "/visitor-auth/verify";
const VERIFY_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const verifyTokenSchema = z.string().regex(VERIFY_TOKEN_PATTERN);
const verifyTokenJsonSchema = z.toJSONSchema(z.object({ token: verifyTokenSchema })) as Record<
  string,
  unknown
>;
const VERIFY_HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
} as const;
const REQUEST_PATH = "/visitor-auth/request";
const APP_REQUEST_PEER_PREFIX = "auth:";
const REQUEST_AUTH_ROUTE_META_MAX_BYTES = 2_048;
const REQUEST_AUTH_ROUTE_RESERVED_META_KEYS = new Set(["peerid", "threadid", "visitorid"]);

const requestAuthRouteMetaValue = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const requestAuthRouteMeta = z
  .record(z.string().trim().min(1).max(64), requestAuthRouteMetaValue)
  .superRefine((meta, ctx) => {
    const serialized = JSON.stringify(meta);
    if (serialized.length > REQUEST_AUTH_ROUTE_META_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `meta must be ${REQUEST_AUTH_ROUTE_META_MAX_BYTES} bytes or less`,
      });
    }

    for (const key of Object.keys(meta)) {
      if (REQUEST_AUTH_ROUTE_RESERVED_META_KEYS.has(key.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is reserved; visitor identity is bound by Auggy runtime context`,
        });
      }
    }

    const sourceMessageId = meta.messageId ?? meta.sourceMessageId;
    if (sourceMessageId !== undefined) {
      if (typeof sourceMessageId !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messageId"],
          message: "messageId must be a string",
        });
      } else if (sourceMessageId.trim().length > 256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messageId"],
          message: "messageId must be 256 characters or fewer",
        });
      }
    }
  });

const requestAuthRouteBody = z
  .object({
    email: z.string(),
    meta: requestAuthRouteMeta.optional(),
  })
  .strict();

const requestAuthRouteResponse = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("sent"),
      delivery: z.enum(["email", "console"]),
      message: z.string(),
      expiresInSec: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      code: z.enum(["malformed_email", "rate_limited"]),
      message: z.string(),
      retryAfterSec: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.enum(["not_booted", "send_failed"]),
      message: z.string(),
    })
    .strict(),
]);

function sourceMessageIdFromRouteMeta(meta: Record<string, unknown> | undefined): string | null {
  const value = meta?.messageId ?? meta?.sourceMessageId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type RequestAuthCode = NonNullable<RequestAuthResult["code"]>;

/** Internal options exposed for tests — production callers do not pass these. */
export interface VisitorAuthInternalOptions extends VisitorAuthOptions {
  /** Test-only AgentMail client override. Production constructs from agentMail.apiKey. */
  _agentMailClient?: AgentMailClient;
  /** Test-only clock injection. Production uses Date.now. */
  _now?: () => number;
  /**
   * Test-only override for the F11 rate-limit sweep cadence (default 1h).
   * Tests use a tiny value (e.g., 30ms) to exercise the actual setInterval
   * wiring rather than just the sweep() unit.
   */
  _rateLimitSweepIntervalMs?: number;
  /**
   * Test-only callback fired after each rate-limiter sweep tick. Receives
   * the eviction count returned by sweep(). Lets tests assert that the
   * setInterval is wired AND that clearInterval stops the cadence on
   * onShutdown.
   */
  _onRateLimitSweep?: (evicted: number, now: number) => void;
}

function validateOptions(opts: VisitorAuthInternalOptions): void {
  if (!opts.publicUrl || typeof opts.publicUrl !== "string") {
    throw new Error("visitorAuth: publicUrl is required");
  }
  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(opts.publicUrl);
  } catch {
    throw new Error(`visitorAuth: publicUrl "${opts.publicUrl}" is not a valid URL`);
  }
  if (!/^https?:$/.test(parsedPublicUrl.protocol)) {
    throw new Error("visitorAuth: publicUrl must use http:// or https://");
  }
  if (!opts.agentMail) {
    throw new Error("visitorAuth: agentMail config is required");
  }
  // Validate per discriminated transport. "agentmail" (or unset, the default)
  // requires apiKey + inboxId; "console" needs neither.
  if (opts.agentMail.transport === "console") {
    // No further validation: console adapter is stateless and credentials-free.
  } else {
    if (!opts.agentMail.apiKey || !opts.agentMail.inboxId) {
      throw new Error(
        'visitorAuth: agentMail.apiKey and agentMail.inboxId are required when transport is "agentmail" (or unset)',
      );
    }
  }
  if (!opts.signingKey || typeof opts.signingKey !== "string") {
    throw new Error("visitorAuth: signingKey is required (set VISITOR_SIGNING_KEY in .env)");
  }
  if (!opts.dbPath) {
    throw new Error("visitorAuth: dbPath is required");
  }
  if (opts.rateLimit) validateRateLimit(opts.rateLimit);
}

function validateRateLimit(rateLimit: VisitorAuthRateLimit): void {
  for (const [name, value] of [
    ["perHour", rateLimit.perHour],
    ["perDay", rateLimit.perDay],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`visitorAuth: rateLimit.${name} must be a positive integer`);
    }
  }
  if (
    rateLimit.minIntervalSeconds !== undefined &&
    (!Number.isSafeInteger(rateLimit.minIntervalSeconds) || rateLimit.minIntervalSeconds < 0)
  ) {
    throw new Error("visitorAuth: rateLimit.minIntervalSeconds must be a non-negative integer");
  }
}

function looksLikePlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

function emailHtmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * True iff the hostname of the given URL is loopback / private / link-local —
 * i.e. unreachable from the public internet under normal routing. Used by the
 * console-transport admission gate to block the dangerous case where an
 * internet-facing publicUrl would broadcast magic links to runtime logs.
 *
 * Recognized as private:
 *   - `localhost` (any case)
 *   - `127.0.0.0/8`         (IPv4 loopback)
 *   - `0.0.0.0`             (wildcard bind / "this host")
 *   - `::1`                 (IPv6 loopback)
 *   - `10.0.0.0/8`          (IPv4 private)
 *   - `172.16.0.0/12`       (IPv4 private)
 *   - `192.168.0.0/16`      (IPv4 private)
 *   - `fc00::/7`            (IPv6 unique-local)
 *   - `fe80::/10`           (IPv6 link-local)
 *   - `*.local`             (mDNS / Bonjour)
 *
 * Anything else — including unparseable URLs — is treated as public
 * (fail-safe: don't admit when we can't classify).
 */
function isLocalOrPrivateUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets if present (URL.hostname keeps them in some runtimes).
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  // IPv4 ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  // IPv6 ranges
  if (host.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique-local fc00::/7
  return false;
}

export function visitorAuth(opts: VisitorAuthInternalOptions): Augment & VisitorAuthAugmentExtras {
  validateOptions(opts);

  const now = opts._now ?? (() => Date.now());
  const tokenTtlMin = opts.tokenTtlMinutes ?? DEFAULT_TOKEN_TTL_MIN;
  const reverifyDays = opts.reverifyAfterDays ?? DEFAULT_REVERIFY_DAYS;
  const rateLimitCaps =
    opts.rateLimit ??
    (opts.agentMail.transport === "console"
      ? DEFAULT_CONSOLE_RATE_LIMIT
      : DEFAULT_AGENTMAIL_RATE_LIMIT);
  const subjectPrefix = opts.agentMail.subjectPrefix ?? "[Verify] ";
  const agentBinding = opts.agentBinding ?? "auggy";
  const verificationDelivery = opts.agentMail.transport === "console" ? "console" : "email";
  const verificationQueues = new Map<string, Promise<void>>();

  async function withVerificationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = verificationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    verificationQueues.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (verificationQueues.get(key) === tail) verificationQueues.delete(key);
    }
  }

  const storeConfig: SqliteVisitorAuthStoreConfig = { dbPath: opts.dbPath };
  const store: VisitorAuthStore = createSqliteVisitorAuthStore(storeConfig);
  const rateLimiter: VisitorAuthRateLimiter = createVisitorAuthRateLimiter(rateLimitCaps);

  // Client selection. Precedence:
  //   1. Test injection (`_agentMailClient`) — existing test seam, wins outright.
  //   2. `agentMail.transport === "console"` — print verify links to stdout.
  //   3. Default — AgentMail HTTP API.
  //
  // Console-transport admission gate. Two independent danger conditions:
  //   (a) NODE_ENV === "production" — runtime logs on Railway/Fly/etc. are
  //       visible in dashboards, log-shipping pipelines, etc.
  //   (b) publicUrl is not loopback/private — a publicly reachable host
  //       implies anyone with log access (including third-party log shipping)
  //       can harvest live verify links, regardless of NODE_ENV. This catches
  //       the "internet-facing staging deploy with NODE_ENV unset" case that
  //       the production-only check (G34 original) missed.
  //
  // Either condition rejects unless the operator explicitly acknowledges via
  // `allowConsoleInProduction: true` (the name is from the original G34
  // shape; the field now governs both gates — see docs/19-visitor-auth.md).
  // Path 1 (test injection) bypasses both checks so tests stay deterministic
  // regardless of test-runner env.
  //
  // We narrow once here (TypeScript-narrowing of the discriminated union does
  // NOT flow through a boolean alias) and bind `mailInboxId` for the
  // downstream onBoot + send call sites. Console mode uses
  // `mailInboxId = "console"` as a routing placeholder — the
  // ConsoleMailClient discards the field, but keeping the type as `string`
  // avoids threading optionality through every send call site.
  let mailInboxId: string;
  if (opts.agentMail.transport === "console") {
    // Block the notifyOnFirstVerify + console combination. The console adapter
    // would print the ops notification to stdout while still returning
    // `status: "sent"`, which burns the first-verify ledger entry — the
    // operator's real alert is permanently suppressed. No principled redesign
    // serves a real use case here; the combination is rare enough that
    // blocking is the right call.
    if (opts.notifyOnFirstVerify) {
      throw new Error(
        `visitorAuth: agentMail.transport="console" cannot be combined with ` +
          `notifyOnFirstVerify — the console adapter would log the ops alert ` +
          `to stdout without actually emailing the operator, and the ` +
          `first-verify ledger would still be burned. A later switch to a ` +
          `real mail transport would NOT replay the missed alert. Either: ` +
          `(a) configure agentMail with apiKey + inboxId, or (b) remove ` +
          `notifyOnFirstVerify from agent.yaml.`,
      );
    }
    if (!opts._agentMailClient && !opts.allowConsoleInProduction) {
      const inProduction = process.env.NODE_ENV === "production";
      const publicReachable = !isLocalOrPrivateUrl(opts.publicUrl);
      if (inProduction || publicReachable) {
        const reasons: string[] = [];
        if (inProduction) reasons.push("NODE_ENV=production");
        if (publicReachable) {
          reasons.push(`publicUrl="${opts.publicUrl}" is publicly reachable`);
        }
        throw new Error(
          `visitorAuth: agentMail.transport="console" is rejected at boot because: ` +
            `${reasons.join(", and ")}. ` +
            `Magic links would be written to runtime logs (visible in Railway/Fly ` +
            `dashboards, log-shipping pipelines, etc.), which leaks verification ` +
            `credentials. Either configure agentMail with apiKey + inboxId ` +
            `(recommended for any non-localhost deployment), or set ` +
            `\`allowConsoleInProduction: true\` under the visitorAuth options block ` +
            `in agent.yaml to ` +
            `acknowledge the risk explicitly.`,
        );
      }
    }
    mailInboxId = "console";
  } else {
    mailInboxId = opts.agentMail.inboxId;
  }

  let agentMail: AgentMailClient;
  if (opts._agentMailClient) {
    agentMail = opts._agentMailClient;
  } else if (opts.agentMail.transport === "console") {
    agentMail = createConsoleMailClient();
  } else {
    agentMail = createAgentMailClient({
      apiKey: opts.agentMail.apiKey,
      apiBaseUrl: opts.agentMail.apiBaseUrl,
    });
  }

  // Per-peer recent-message buffer for email-in-recent-message validation.
  // Holds up to RECENT_MESSAGES per peerId. Populated by onTurnStart from the
  // turn's inbound message (Task 7).
  const RECENT_MESSAGES = 4;
  const recentByPeer = new Map<string, RecentVisitorMessage[]>();

  // F10: bound recentByPeer growth under high peer churn (e.g. anon-* ids
  // change per thread; long-running agents accumulate stale entries forever).
  // We track the last onTurnStart timestamp per peer, and every
  // RECENT_PEER_SWEEP_EVERY turns we evict entries older than
  // RECENT_PEER_TTL_MS. Sweep is amortized — no setInterval needed.
  const RECENT_PEER_TTL_MS = 24 * 60 * 60_000; // 24h
  const RECENT_PEER_SWEEP_EVERY = 50; // amortized cost: 1/50 turns
  const lastSeenByPeer = new Map<string, number>();
  let onTurnStartCounter = 0;

  // Cached HMAC signing key — derived once at boot.
  let signingCryptoKey: CryptoKey | null = null;

  // Bootflag — context() and the route handler must noop until onBoot completed.
  let booted = false;

  // F11: rate-limiter background sweep handle.  Set in onBoot; cleared in
  // onShutdown.
  let rateLimiterSweepHandle: ReturnType<typeof setInterval> | null = null;

  function buildVerifyUrl(token: string): string {
    const url = new URL(VERIFY_PATH, opts.publicUrl);
    url.searchParams.set("token", token);
    return url.href;
  }

  function buildEmailBody(
    verifyUrl: string,
    ttlMinutes: number,
  ): { subject: string; text: string; html: string } {
    const subject = `${subjectPrefix}Verify your email`;
    const text =
      `Click the link below to verify your email.\n\n` +
      `${verifyUrl}\n\n` +
      `The link expires in ${ttlMinutes} minutes and may only be used once. ` +
      `If you didn't request this, ignore this email.`;
    const safeUrl = emailHtmlEscape(verifyUrl);
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111827;">
  <p>Click the button below to verify your email.</p>
  <p><a href="${safeUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">Verify email</a></p>
  <p>Or copy and paste this link into your browser:</p>
  <p><a href="${safeUrl}">${safeUrl}</a></p>
  <p style="color:#6b7280;font-size:13px;">The link expires in ${ttlMinutes} minutes and may only be used once. If you didn't request this, ignore this email.</p>
</body>
</html>`;
    return { subject, text, html };
  }

  async function requestEmailVerification(input: {
    email: string;
    peerId: string;
    threadId: string;
    sourceMessageId?: string | null;
    recentMessages?: RecentVisitorMessage[];
    requireRecentEmail: boolean;
  }): Promise<RequestAuthResult> {
    const fail = (
      status: "rejected" | "failed",
      code: RequestAuthCode,
      message: string,
      retryAfterSec?: number,
    ): RequestAuthResult => ({
      status,
      code,
      message,
      ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
    });

    if (!booted) {
      return fail(
        "failed",
        "not_booted",
        "visitorAuth has not finished booting; try again shortly.",
      );
    }

    const email = input.email.trim().toLowerCase();
    if (!isWellFormedEmail(email)) {
      return fail("rejected", "malformed_email", "Email address is malformed.");
    }

    let sourceMessageId = input.sourceMessageId ?? null;
    if (input.requireRecentEmail) {
      const match = emailAppearsInRecentMessages(email, input.recentMessages ?? []);
      if (!match.matched) {
        return fail(
          "rejected",
          "email_not_recent",
          "Email was not found in the visitor's recent messages. Refusing to send to an address the visitor did not type.",
        );
      }
      sourceMessageId = match.messageId || null;
    }

    // Per-email rate limit (fix H1: threadId rotation bypass).
    // Keying on email prevents an attacker from rotating peer.id / threadId
    // to escape the rate limit. The "email:" prefix namespaces the key so
    // future per-IP keying (e.g. "ip:...") can coexist without collision.
    const rlKey = `email:${email}`;
    return withVerificationLock(rlKey, async () => {
      const t = now();
      const rl = rateLimiter.check(rlKey, t);
      if (!rl.allowed) {
        return fail(
          "rejected",
          "rate_limited",
          `Verification rate limit reached for this visitor (${rl.reason}). Try again in ${rl.retryAfterSec} second(s).`,
          rl.retryAfterSec,
        );
      }

      // Invalidate any prior open token for this peer; only one open at a time.
      store.invalidateOpenTokensForPeer(input.peerId, t);

      // Mint a fresh token + write the row + build URL.
      const token = crypto.randomUUID();
      const ttlMs = tokenTtlMin * 60_000;
      store.issueToken({
        token,
        email,
        peerId: input.peerId,
        threadId: input.threadId,
        expiresAt: t + ttlMs,
        sourceMessageId,
      });
      const verifyUrl = buildVerifyUrl(token);
      const { subject, text, html } = buildEmailBody(verifyUrl, tokenTtlMin);

      // Serialize sends for the same email so parallel requests cannot bypass
      // the cooldown between the policy check and successful delivery record.
      const sendResult = await agentMail.send({
        inboxId: mailInboxId,
        to: [email],
        subject,
        text,
        html,
        labels: ["visitor-auth", "verify"],
      });

      if (sendResult.status !== "sent") {
        // A failed delivery does not consume quota, but its token must not be redeemable.
        store.invalidateTokenIfStillOpen(token, t + 1);
        return fail(
          "failed",
          "send_failed",
          verificationDelivery === "console"
            ? `Failed to print verification link to the local agent console: ${sendResult.detail ?? "unknown error"}`
            : `Failed to send verification email: ${sendResult.detail ?? "unknown error"}`,
        );
      }

      // Record the rate-limit tick AFTER successful send (keyed to email, not peer).
      rateLimiter.record(rlKey, t);

      return {
        status: "sent",
        delivery: verificationDelivery,
        message:
          verificationDelivery === "console"
            ? `Verification link created for ${email} and printed to the local agent console. No email was sent. Open the console link within ${tokenTtlMin} minutes.`
            : `Verification email sent to ${email}. The link expires in ${tokenTtlMin} minutes.`,
        expiresInSec: Math.floor(ttlMs / 1000),
      };
    });
  }

  function requestAuthHttpStatus(result: RequestAuthResult): number {
    if (result.status === "sent") return 200;
    if (result.code === "rate_limited") return 429;
    if (result.code === "not_booted") return 503;
    if (result.code === "send_failed") return 502;
    return 400;
  }

  const requestAuthTool = defineTool({
    name: "request_auth",
    description:
      verificationDelivery === "console"
        ? "Create an email-address verification link for an anonymous visitor and print it to the local agent console. No email is sent in this configuration. The result's delivery field is authoritative. method: 'email' is the only supported value at v1."
        : "Send a verification email to a visitor's claimed address. Use this to promote an anonymous visitor to recognized identity. The result's delivery field is authoritative. method: 'email' is the only supported value at v1.",
    category: "communication",
    input: z.object({
      method: z.literal("email"),
      email: z.string(),
    }),
    execute: async (
      input: { method: "email"; email: string },
      ctx?: ToolExecuteContext,
    ): Promise<string> => {
      if (!ctx?.peer) {
        return JSON.stringify({
          status: "failed",
          code: "missing_peer",
          message: "request_auth requires turn context with a peer identity.",
        } satisfies RequestAuthResult);
      }
      const isAnonymousPublicVisitor =
        ctx.peer.trustLevel === "public" &&
        ctx.peer.publicSubstate === "anonymous" &&
        (ctx.peer.kind === "human" || ctx.peer.kind === "anonymous");
      const isRecognizedHuman =
        ctx.peer.trustLevel === "public" &&
        ctx.peer.publicSubstate === "recognized" &&
        ctx.peer.kind === "human";
      const recognizedRow = isRecognizedHuman && booted ? store.findVisitorById(ctx.peer.id) : null;
      const isReverificationDue =
        isRecognizedHuman &&
        (!booted ||
          (recognizedRow !== null &&
            !recognizedRow.revoked &&
            recognizedRow.reverifyDueAt <= now()));
      if (!isAnonymousPublicVisitor && !isReverificationDue) {
        return JSON.stringify({
          status: "rejected",
          code: isRecognizedHuman ? "reverification_not_due" : "peer_not_anonymous",
          message: isRecognizedHuman
            ? "This recognized visitor does not need reverification yet."
            : "request_auth is only available to an anonymous public visitor.",
        } satisfies RequestAuthResult);
      }
      if (input.method !== "email") {
        return JSON.stringify({
          status: "rejected",
          code: "unsupported_method",
          message: `method "${input.method}" not supported in this build; only "email" is available.`,
        } satisfies RequestAuthResult);
      }

      const result = await requestEmailVerification({
        email: input.email,
        peerId: ctx.peer.id,
        threadId: ctx.threadId,
        recentMessages: recentByPeer.get(ctx.peer.id) ?? [],
        requireRecentEmail: true,
      });
      return JSON.stringify(result);
    },
  });

  /**
   * Real-time revocation check for webTransport integration (fix C1).
   *
   * Returns `true` if the visitorId is known AND its row is marked revoked.
   * webTransport calls this after HMAC verification succeeds; a `true` return
   * causes the request to be treated as anonymous, rendering old tokens inert
   * without waiting for their TTL to expire.
   *
   * Exposed as a plain function on the augment object so the augment resolver
   * can wire it into webTransport's `visitorTokens.revocationCheck` option.
   * Not part of the `Augment` interface — resolved via type assertion in the
   * resolver.
   */
  function isVisitorRevoked(visitorId: string): boolean {
    if (!booted) return false; // store not initialized; fail-open to avoid boot-order deadlock
    // Check the permanent denylist first — this catches OLD vis_ids that have
    // been rotated away by unrevokeAndRotate (their row no longer exists under
    // that id, so findVisitorById would return null and we'd incorrectly admit
    // them as "not revoked").
    if (store.isVisitorIdRevoked(visitorId)) return true;
    // Then check the current verified_visitors row state.
    const row = store.findVisitorById(visitorId);
    return !!row?.revoked;
  }

  function resolveVisitorIdentity(visitorId: string): {
    visitorId: string;
    email: string;
    verifiedAt: number;
    reverifyDueAt: number;
  } | null {
    if (!booted) return null;
    if (store.isVisitorIdRevoked(visitorId)) return null;
    const row = store.findVisitorById(visitorId);
    if (!row || row.revoked) return null;
    return {
      visitorId: row.visitorId,
      email: row.email,
      verifiedAt: row.verifiedAt,
      reverifyDueAt: row.reverifyDueAt,
    };
  }

  function canPromoteAnonymousThread(visitorId: string, threadId: string): boolean {
    if (!booted) return false;
    return store.canPromoteAnonymousThread(visitorId, threadId);
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const visitors = store.listVerifiedVisitors();
    const isProd = process.env.NODE_ENV === "production";
    const transport = opts.agentMail.transport ?? "agentmail";
    const consoleInProd = transport === "console" && isProd;
    return {
      augmentName: "visitor-auth",
      title: "Visitors",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Mail transport", value: transport, source: "yaml" },
            {
              label: "Inbox",
              value:
                opts.agentMail.transport === "agentmail"
                  ? (opts.agentMail.inboxId ?? "(unset)")
                  : "(console mode)",
            },
            { label: "Public URL", value: opts.publicUrl },
            { label: "Agent binding", value: opts.agentBinding ?? "auggy" },
          ],
        },
        {
          kind: "status",
          level: consoleInProd ? "warn" : "ok",
          message: consoleInProd
            ? "Mail transport is 'console' in production — magic links print to stdout. Switch to 'agentmail' for production deployments."
            : `Mail transport is '${transport}'.`,
        },
        {
          kind: "table",
          columns: ["Email", "Verified at", "Revoked"],
          rows: visitors
            .slice(0, 50)
            .map((v) => [v.email, new Date(v.verifiedAt).toISOString(), v.revoked ? "yes" : "no"]),
          rowActions: [
            {
              id: "visitor-revoke",
              label: "Revoke",
              confirmRequired: true,
              rowKeyColumn: 0,
            },
          ],
          caption: `Showing ${Math.min(visitors.length, 50)} of ${visitors.length} verified visitor(s)`,
        },
      ],
    };
  }

  const adminActions: Record<
    string,
    (params: Record<string, unknown>) => Promise<AdminActionResult>
  > = {
    "visitor-revoke": async (params) => {
      const rowKey = typeof params.rowKey === "string" ? params.rowKey : "";
      if (!rowKey) {
        return { ok: false, message: "visitor-revoke requires a rowKey (email)" };
      }
      const visitorId = store.revokeByEmail(rowKey, "/console revoke", Date.now());
      if (!visitorId) {
        return {
          ok: false,
          message: `visitor "${rowKey}" not found or already revoked`,
        };
      }
      store.addRevokedVisitorId(visitorId, rowKey, "/console revoke", Date.now());
      return { ok: true, message: `Revoked ${rowKey} (${visitorId})` };
    },
  };

  const augment: Augment &
    Pick<
      VisitorAuthAugmentExtras,
      "isVisitorRevoked" | "resolveVisitorIdentity" | "canPromoteAnonymousThread"
    > = {
    name: "visitor-auth",
    type: "visitorAuth",
    category: "guardrails",
    tools: [requestAuthTool],
    adminInfo,
    adminActions,
    isVisitorRevoked,
    resolveVisitorIdentity,
    canPromoteAnonymousThread,
    httpRoutes: [
      // -----------------------------------------------------------------------
      // GET /visitor-auth/verify?token=<uuid>
      //
      // Returns a CONFIRMATION page — does NOT consume the token.
      // Mail-scanner AV bots follow GET links passively; returning a confirm
      // page here (rather than consuming) means prefetch is harmless. The human
      // clicks "Verify my email" which submits a form POST that atomically
      // consumes the token. Design: fix H2 (GET prefetch burns tokens).
      // -----------------------------------------------------------------------
      {
        method: "GET",
        path: VERIFY_PATH,
        auth: "none",
        rateLimit: { maxPerMinute: 60 },
        requestJsonSchema: { query: verifyTokenJsonSchema },
        responseMediaTypes: ["text/html"],
        handler: async (req, _opts) => {
          if (!booted || !signingCryptoKey) {
            return new Response(buildVerifyFailurePage({ reason: "unknown" }), {
              status: 503,
              headers: VERIFY_HTML_HEADERS,
            });
          }
          const url = new URL(req.url);
          const token = url.searchParams.get("token");
          // UUID-shape validation — still reject malformed tokens early so the
          // confirm page is never shown for obviously wrong inputs.
          if (!token || !VERIFY_TOKEN_PATTERN.test(token)) {
            return new Response(buildVerifyFailurePage({ reason: "malformed" }), {
              status: 400,
              headers: VERIFY_HTML_HEADERS,
            });
          }
          // Do NOT touch the store — token is consumed only by POST.
          return new Response(buildVerifyConfirmPage({ token, publicUrl: opts.publicUrl }), {
            status: 200,
            headers: VERIFY_HTML_HEADERS,
          });
        },
      },
      // -----------------------------------------------------------------------
      // POST /visitor-auth/verify
      //
      // Consumes the token and mints a vis_<uuid> visitor token.
      // Accepts token either as a form-encoded body field or as JSON.
      // Mail scanners do not auto-submit POSTs, so this path is human-only.
      // -----------------------------------------------------------------------
      {
        method: "POST",
        path: VERIFY_PATH,
        auth: "none",
        rateLimit: { maxPerMinute: 60 },
        requestJsonSchema: { body: verifyTokenJsonSchema },
        requestMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
        responseMediaTypes: ["text/html"],
        handler: async (req, _opts) => {
          if (!booted || !signingCryptoKey) {
            return new Response(buildVerifyFailurePage({ reason: "unknown" }), {
              status: 503,
              headers: VERIFY_HTML_HEADERS,
            });
          }

          // Read token from form-encoded body or JSON body.
          let token: string | null = null;
          let bodyParseFailed = false;
          try {
            const ct = req.headers.get("content-type") ?? "";
            if (ct.includes("application/x-www-form-urlencoded")) {
              const text = await req.text();
              const params = new URLSearchParams(text);
              token = params.get("token");
            } else {
              // Treat anything else as JSON (including application/json and
              // the default browser fetch content-type).
              const body = (await req.json()) as Record<string, unknown>;
              token = typeof body.token === "string" ? body.token : null;
            }
          } catch {
            // Body could not be parsed (non-JSON, binary, etc.).
            bodyParseFailed = true;
          }

          // UUID-shape validation — distinguish parse failure from malformed UUID.
          const postReason = bodyParseFailed
            ? "bad-body"
            : !token || !VERIFY_TOKEN_PATTERN.test(token)
              ? "malformed"
              : null;
          if (postReason) {
            return new Response(buildVerifyFailurePage({ reason: postReason }), {
              status: 400,
              headers: VERIFY_HTML_HEADERS,
            });
          }
          // postReason is null ⟹ parse succeeded AND token is a valid UUID string.
          const validToken = token!;

          const t = now();
          const consume = store.consumeToken(validToken, t);
          if (!consume.consumed) {
            const status = store.tokenStatus(validToken, t);
            const reason: "unknown" | "expired" | "consumed" =
              status === "unknown" ? "unknown" : status === "expired" ? "expired" : "consumed";
            const httpStatus = status === "unknown" ? 404 : 410;
            return new Response(buildVerifyFailurePage({ reason }), {
              status: httpStatus,
              headers: VERIFY_HTML_HEADERS,
            });
          }

          // Mint a visitor token bound to the verified email's peer.
          // Uses the SAME signing key webTransport derives from VISITOR_SIGNING_KEY,
          // so the token will verify cleanly on the next /agent/run request.
          //
          // CRITICAL: on re-verification of an already-known email, reuse the
          // EXISTING visitorId so peer-scoped state in layered-memory remains
          // continuous. Minting a fresh visitorId here would orphan the
          // visitor's prior conversation history under the old id.
          //
          // EXCEPTION: if the row is revoked, the operator destroyed that identity.
          // Re-verify must establish a NEW identity (fresh vis_<uuid>); the revoked
          // row is un-revoked and rotated to the new id via unrevokeAndRotate so
          // the UNIQUE-email constraint is not violated by a second INSERT.
          const ttlSec = reverifyDays * 86_400;
          const existing = store.findVerifiedByEmail(consume.email!);
          // Revoked rows must NOT reuse the old visitorId — that identity was destroyed.
          const reuseVisitorId = existing && !existing.revoked ? existing.visitorId : undefined;
          // Use `let` so the race-loser path can reassign minted to carry the
          // winner's visitorId (see F4 UNIQUE catch below).
          let minted = await createVisitorToken(
            signingCryptoKey,
            agentBinding,
            ttlSec,
            reuseVisitorId,
            consume.peerId ?? undefined,
            consume.peerId ?? undefined,
          );

          // Record / touch the verified-visitor row:
          //   - Active (non-revoked) row: touch lastSeenAt, preserve visitorId.
          //   - Revoked row: un-revoke + rotate to new visitorId (avoids INSERT
          //     UNIQUE-constraint collision on email).
          //   - No row: fresh INSERT, with UNIQUE-race guard (see F4 fix below).
          if (existing && !existing.revoked) {
            store.touchVerifiedVisitor(consume.email!, t);
          } else if (existing?.revoked) {
            store.unrevokeAndRotate(consume.email!, minted.payload.visitorId, t, t + ttlSec * 1000);
          } else {
            try {
              store.recordVerifiedVisitor({
                visitorId: minted.payload.visitorId,
                email: consume.email!,
                verifiedAt: t,
                lastSeenAt: t,
                reverifyDueAt: t + ttlSec * 1000,
                revoked: false,
                revokedAt: null,
                revokedReason: null,
              });
            } catch (err) {
              // F4: concurrent first-verifies UNIQUE race — two requests for the
              // same email both pass `existing === null` and both attempt INSERT.
              // The second throws a SQLite UNIQUE constraint error on the email
              // column. Re-fetch the WINNER's row and RE-MINT a token carrying
              // the winner's visitorId. Without this, the loser's user receives a
              // token with a vis_id not in the verified_visitors table, which
              // causes webTransport's revocation check (findVisitorById) to return
              // null and silently admit the loser as a different identity — breaking
              // identity-continuity with layered-memory's peer-scoped storage.
              const isUniqueViolation =
                err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
              if (!isUniqueViolation) throw err;
              const winner = store.findVerifiedByEmail(consume.email!);
              if (winner && !winner.revoked) {
                store.touchVerifiedVisitor(consume.email!, t);
                // RE-MINT with the winner's visitorId so the token payload matches
                // the row in verified_visitors — identity-continuity preserved.
                minted = await createVisitorToken(
                  signingCryptoKey,
                  agentBinding,
                  ttlSec,
                  winner.visitorId,
                  consume.peerId ?? undefined,
                  consume.peerId ?? undefined,
                );
              } else {
                // Defensive: winner row vanished or is revoked between INSERT failure
                // and re-fetch. Surface the original error rather than issue a token
                // that nobody in the table will recognize.
                throw err;
              }
            }
          }

          // Anonymous→recognized peer-id migration. The model-tool path binds
          // to a real peer id from turn context, so it can migrate that peer's
          // anonymous memory. The public app request route uses an internal
          // auth:<uuid> peer id and must not let callers claim arbitrary
          // anon-<threadId> memory.
          if (consume.peerId && !consume.peerId.startsWith(APP_REQUEST_PEER_PREFIX)) {
            migratePeerIdOnVerify(
              opts.layeredMemoryDbPath === undefined ? "./memory.db" : opts.layeredMemoryDbPath,
              consume.peerId,
              minted.payload.visitorId,
            );
          }

          // Operator notification on first verify per email (optional).
          if (opts.notifyOnFirstVerify) {
            const cfg = opts.notifyOnFirstVerify;
            if (!store.hasNotifiedFirstVerifyFor(consume.email!)) {
              // F5: mark-after-send — only record the ledger entry when the send
              // actually succeeds.  Trade-off: if the agent crashes between
              // send-success and markNotifiedFirstVerifyFor, the operator gets a
              // duplicate notification on the next verify retry.  Accepted —
              // a duplicate ops note is preferable to a permanently dropped one.
              const subject = `${cfg.subjectPrefix ?? "[New verified visitor] "}${consume.email}`;
              const text = `A new visitor verified their email: ${consume.email!} (vis_id: ${minted.payload.visitorId}).`;
              try {
                const notifyResult = await agentMail.send({
                  inboxId: mailInboxId,
                  to: [cfg.to],
                  subject,
                  text,
                  labels: ["visitor-auth", "first-verify-operator-note"],
                });
                if (notifyResult.status === "sent") {
                  store.markNotifiedFirstVerifyFor(consume.email!, t);
                } else {
                  console.warn(
                    `[visitor-auth] first-verify operator notification failed (destination redacted): ${(notifyResult as { detail?: string }).detail ?? "unknown"}. Will retry on next verify.`,
                  );
                }
              } catch (err) {
                console.warn(
                  `[visitor-auth] first-verify operator notification failed: ${(err as Error).message}`,
                );
              }
            }
          }

          return new Response(
            buildVerifySuccessPage({
              visitorToken: minted.token,
              email: consume.email!,
              threadId: consume.threadId!,
            }),
            {
              status: 200,
              headers: VERIFY_HTML_HEADERS,
            },
          );
        },
      },
      defineRoute.post(REQUEST_PATH, {
        auth: "visitor.optional",
        body: requestAuthRouteBody,
        response: requestAuthRouteResponse,
        requestMediaTypes: ["application/json"],
        responseMediaTypes: ["application/json"],
        maxBodyBytes: 8_192,
        rateLimit: { maxPerMinute: 20 },
        handler: async ({ body }) => {
          const authRequestId = crypto.randomUUID();
          const result = await requestEmailVerification({
            email: body.email,
            peerId: `${APP_REQUEST_PEER_PREFIX}${authRequestId}`,
            threadId: authRequestId,
            sourceMessageId: sourceMessageIdFromRouteMeta(body.meta),
            requireRecentEmail: false,
          });
          return json(result, requestAuthHttpStatus(result));
        },
      }),
    ],
    async onBoot() {
      // Fail-fast on placeholder env-var leakage (operator forgot to set .env).
      // AgentMail-specific checks only fire when the AgentMail transport is in
      // use; the console adapter has no apiKey / inboxId to validate.
      if (opts.agentMail.transport !== "console") {
        if (looksLikePlaceholder(opts.agentMail.apiKey)) {
          throw new Error(
            `visitorAuth: agentMail.apiKey is unresolved (got "${opts.agentMail.apiKey}"). Set the referenced env var in .env and restart.`,
          );
        }
        if (looksLikePlaceholder(opts.agentMail.inboxId)) {
          throw new Error(
            `visitorAuth: agentMail.inboxId is unresolved (got "${opts.agentMail.inboxId}"). Set the referenced env var in .env and restart.`,
          );
        }
      }
      if (looksLikePlaceholder(opts.signingKey)) {
        throw new Error(
          "visitorAuth: VISITOR_SIGNING_KEY is unresolved. Set it in .env and restart (the same value webTransport uses).",
        );
      }
      // F12: an unresolved agentBinding silently degrades token-payload checks
      // (every minted token's `agent` field becomes the literal "${AGENT_BINDING}",
      // which still self-consistently verifies — masking the misconfig).
      // Fail loud at boot instead.
      if (looksLikePlaceholder(agentBinding)) {
        throw new Error(
          `visitorAuth: agentBinding is unresolved (got "${agentBinding}"). Set the referenced env var in .env and restart, or remove the agentBinding option to use the "auggy" default.`,
        );
      }

      store.initialize();
      signingCryptoKey = await deriveSigningKey(opts.signingKey);

      // AgentMail healthcheck. Severity branches on httpStatus (F9):
      //   401 / 403 / 404 → operator misconfig (bad API key, missing inbox).
      //     Throw at boot so the operator notices before the first visitor
      //     hits a silent send-failure.
      //   5xx / network errors → transient. Warn and continue; the first
      //     real send will surface the same error if it persists.
      // In console mode the synthetic ConsoleMailClient returns OK trivially,
      // so this block is a no-op rather than dead code — keep it unguarded.
      const health = await agentMail.getInbox(mailInboxId);
      if (health.status !== "ok") {
        const httpStatus = health.httpStatus;
        if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
          const permissionHint =
            httpStatus === 403
              ? " If this is a permission-whitelisted AgentMail key, include inbox_read for boot healthcheck and message_send for verification delivery."
              : "";
          throw new Error(
            `visitorAuth: AgentMail inbox "${mailInboxId}" healthcheck failed with HTTP ${httpStatus}: ${health.detail}. ` +
              `Check the AgentMail env vars referenced by augments/visitorAuth/augment.yaml and restart.${permissionHint}`,
          );
        }
        console.warn(
          `[visitor-auth] AgentMail inbox "${mailInboxId}" healthcheck failed: ${health.detail}. ` +
            `First send will surface the real error.`,
        );
      }

      // F11: periodic rate-limiter sweep. Hourly cadence is well below the
      // 24h window so inactive entries are evicted within a window of their
      // last activity. unref() so the timer doesn't hold the event loop open
      // (mirrors how launchd-managed processes shut down on SIGTERM).
      const RATE_LIMIT_SWEEP_INTERVAL_MS = opts._rateLimitSweepIntervalMs ?? 60 * 60_000; // 1h
      rateLimiterSweepHandle = setInterval(() => {
        const t = now();
        const evicted = rateLimiter.sweep(t);
        opts._onRateLimitSweep?.(evicted, t);
      }, RATE_LIMIT_SWEEP_INTERVAL_MS);
      rateLimiterSweepHandle.unref();

      booted = true;
    },
    async onTurnStart(turn: TurnState) {
      if (!turn.peer) return;
      const peerId = turn.peer.id;
      // F10: amortized eviction of stale recentByPeer / lastSeenByPeer entries.
      // Runs once every RECENT_PEER_SWEEP_EVERY turns to keep the per-turn cost
      // O(1) on average.
      onTurnStartCounter++;
      if (onTurnStartCounter % RECENT_PEER_SWEEP_EVERY === 0) {
        const cutoff = now() - RECENT_PEER_TTL_MS;
        for (const [id, lastSeen] of lastSeenByPeer) {
          if (lastSeen < cutoff) {
            lastSeenByPeer.delete(id);
            recentByPeer.delete(id);
          }
        }
      }
      // Track liveness for the next sweep. Always update — even when there's
      // no inbound text, the peer is active.
      lastSeenByPeer.set(peerId, now());
      // Pull the visitor's text from the inbound message payload.
      const payload = turn.trigger.payload as
        | { parts?: Array<{ kind: string; text?: string }> }
        | undefined;
      const text = (payload?.parts ?? [])
        .filter((p) => p.kind === "text" && typeof p.text === "string")
        .map((p) => p.text!)
        .join("\n");
      if (!text) return;
      const messageId = (turn.trigger.payload as { metadata?: { messageId?: string } })?.metadata
        ?.messageId;
      const list = recentByPeer.get(peerId) ?? [];
      list.push({ text, messageId });
      while (list.length > RECENT_MESSAGES) list.shift();
      recentByPeer.set(peerId, list);
    },
    async onShutdown() {
      if (rateLimiterSweepHandle !== null) {
        clearInterval(rateLimiterSweepHandle);
        rateLimiterSweepHandle = null;
      }
      if (booted) {
        store.close();
        booted = false;
      }
    },
    async context(turn: TurnState): Promise<ContextBlock[]> {
      if (!booted) return [];
      if (!turn.peer) return [];

      const t = now();

      // Verified-by-id branch: peer.id starts with vis_ → look up by visitor id.
      // Walk listVerifiedVisitors (small at operator scale) to find the row.
      if (turn.peer.id.startsWith("vis_")) {
        const all = store.listVerifiedVisitors();
        const row = all.find((r) => r.visitorId === turn.peer!.id);
        if (!row || row.revoked) return [];
        store.touchVerifiedVisitor(row.email, t);
        const verifiedAgo = humanRelativeMs(t - row.verifiedAt);
        if (row.reverifyDueAt <= t) {
          return [
            block(`Verified email: ${row.email} — reverification due. Visitor should reverify.`),
          ];
        }
        return [block(`Verified email: ${row.email} (verified ${verifiedAgo}).`)];
      }

      // Anonymous branch: peer.id ~ anon-<threadId> → look up by token.
      const recent = store.findMostRecentTokenForPeer(turn.peer.id, t);
      if (!recent) return [];
      if (recent.consumed) {
        // Edge case: peer.id is still anon-* but token was consumed —
        // verification happened but the chat tab hasn't applied the new
        // token yet. No block; the next request will arrive as vis_*.
        return [];
      }
      if (recent.expiresAt <= t) {
        return [
          block(
            verificationDelivery === "console"
              ? `Console verification link for ${recent.email} expired. Visitor may request a new one.`
              : `Verification email to ${recent.email} expired. Visitor may request a new one.`,
          ),
        ];
      }
      const sentMin = Math.max(0, Math.floor((t - recent.issuedAt) / 60_000));
      const expiresMin = Math.max(1, Math.ceil((recent.expiresAt - t) / 60_000));
      return [
        block(
          verificationDelivery === "console"
            ? `Verification link for ${recent.email} was printed to the local agent console ${sentMin}m ago; no email was sent. It expires in ${expiresMin}m. Awaiting click.`
            : `Verification email sent to ${recent.email} (sent ${sentMin}m ago, expires in ${expiresMin}m). Awaiting click.`,
        ),
      ];
    },
  };

  return augment;
}

function block(content: string): ContextBlock {
  return {
    source: "visitor-auth",
    content,
    placement: "preamble",
    provenance: "augment",
    priority: "normal",
    eviction: "drop",
    origin: "system",
    ttl: "session",
  };
}

function humanRelativeMs(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Best-effort anonymous→recognized peer-id migration on the layeredMemory
 * SQLite file. Runs ONE UPDATE statement; logs + continues on any error so
 * verify-success is not blocked by an unrelated DB issue. Skipped when
 * `dbPath` is null/undefined or the file does not exist.
 */
function migratePeerIdOnVerify(
  dbPath: string | null | undefined,
  oldPeerId: string,
  newPeerId: string,
): void {
  if (!dbPath) return;
  if (!existsSync(dbPath)) {
    console.warn(
      `[visitor-auth] layeredMemory db "${dbPath}" not found; skipping peer-id migration for ${oldPeerId}`,
    );
    return;
  }
  // No-op when ids are identical (re-verify after token-expiry where peer
  // already arrives as vis_*; nothing to migrate).
  if (oldPeerId === newPeerId) return;
  try {
    const changes = reassignSqliteMemoryPeerId(dbPath, oldPeerId, newPeerId);
    if (changes > 0) {
      console.info(`[visitor-auth] migrated ${changes} memory row(s) ${oldPeerId} → ${newPeerId}`);
    }
  } catch (err) {
    console.warn(
      `[visitor-auth] peer-id migration failed for ${oldPeerId} → ${newPeerId}: ${(err as Error).message}`,
    );
  }
}

// Internal-only re-exports for Task 7+ (avoid duplicating types in tests).
export type { VisitorAuthOptions };

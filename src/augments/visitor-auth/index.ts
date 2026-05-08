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
import { Database } from "bun:sqlite";
import { z } from "zod";
import { defineTool } from "../../helpers";
import { createAgentMailClient, type AgentMailClient } from "../../agentmail-client";
import { createVisitorToken, deriveSigningKey } from "../../transports/visitor-token";
import type { Augment, ContextBlock, ToolExecuteContext, TurnState } from "../../types";
import type {
  RecentVisitorMessage,
  RequestAuthResult,
  VisitorAuthAugmentExtras,
  VisitorAuthOptions,
} from "./types";
import {
  createSqliteVisitorAuthStore,
  type SqliteVisitorAuthStoreConfig,
} from "./storage/sqlite-store";
import type { VisitorAuthStore } from "./storage/types";
import { emailAppearsInRecentMessages, isWellFormedEmail } from "./email-validation";
import { createVisitorAuthRateLimiter, type VisitorAuthRateLimiter } from "./rate-limiter";
import {
  buildVerifyConfirmPage,
  buildVerifyFailurePage,
  buildVerifySuccessPage,
} from "./verify-page";

const DEFAULT_TOKEN_TTL_MIN = 15;
const DEFAULT_REVERIFY_DAYS = 90;
const DEFAULT_RATE_LIMIT = { perHour: 1, perDay: 3 };
const VERIFY_PATH = "/visitor-auth/verify";

/** Internal options exposed for tests — production callers do not pass these. */
export interface VisitorAuthInternalOptions extends VisitorAuthOptions {
  /** Test-only AgentMail client override. Production constructs from agentMail.apiKey. */
  _agentMailClient?: AgentMailClient;
  /** Test-only clock injection. Production uses Date.now. */
  _now?: () => number;
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
  if (!opts.agentMail?.apiKey || !opts.agentMail?.inboxId) {
    throw new Error("visitorAuth: agentMail.apiKey and agentMail.inboxId are required");
  }
  if (!opts.signingKey || typeof opts.signingKey !== "string") {
    throw new Error("visitorAuth: signingKey is required (set VISITOR_SIGNING_KEY in .env)");
  }
  if (!opts.dbPath) {
    throw new Error("visitorAuth: dbPath is required");
  }
}

function looksLikePlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

export function visitorAuth(opts: VisitorAuthInternalOptions): Augment & VisitorAuthAugmentExtras {
  validateOptions(opts);

  const now = opts._now ?? (() => Date.now());
  const tokenTtlMin = opts.tokenTtlMinutes ?? DEFAULT_TOKEN_TTL_MIN;
  const reverifyDays = opts.reverifyAfterDays ?? DEFAULT_REVERIFY_DAYS;
  const rateLimitCaps = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  const subjectPrefix = opts.agentMail.subjectPrefix ?? "[Verify] ";
  const agentBinding = opts.agentBinding ?? "auggy";

  const storeConfig: SqliteVisitorAuthStoreConfig = { dbPath: opts.dbPath };
  const store: VisitorAuthStore = createSqliteVisitorAuthStore(storeConfig);
  const rateLimiter: VisitorAuthRateLimiter = createVisitorAuthRateLimiter(rateLimitCaps);

  const agentMail: AgentMailClient =
    opts._agentMailClient ??
    createAgentMailClient({
      apiKey: opts.agentMail.apiKey,
      apiBaseUrl: opts.agentMail.apiBaseUrl,
    });

  // Per-peer recent-message buffer for email-in-recent-message validation.
  // Holds up to RECENT_MESSAGES per peerId. Populated by onTurnStart from the
  // turn's inbound message (Task 7).
  const RECENT_MESSAGES = 4;
  const recentByPeer = new Map<string, RecentVisitorMessage[]>();

  // Cached HMAC signing key — derived once at boot.
  let signingCryptoKey: CryptoKey | null = null;

  // Bootflag — context() and the route handler must noop until onBoot completed.
  let booted = false;

  function buildVerifyUrl(token: string): string {
    const base = opts.publicUrl.endsWith("/") ? opts.publicUrl.slice(0, -1) : opts.publicUrl;
    return `${base}${VERIFY_PATH}?token=${encodeURIComponent(token)}`;
  }

  function buildEmailBody(
    verifyUrl: string,
    ttlMinutes: number,
  ): { subject: string; text: string } {
    const subject = `${subjectPrefix}Verify your email`;
    const text =
      `Click the link below to verify your email.\n\n` +
      `${verifyUrl}\n\n` +
      `The link expires in ${ttlMinutes} minutes and may only be used once. ` +
      `If you didn't request this, ignore this email.`;
    return { subject, text };
  }

  const requestAuthTool = defineTool({
    name: "request_auth",
    description:
      "Send a verification email to a visitor's claimed address. Use this to promote an anonymous visitor to recognized identity. method: 'email' is the only supported value at v1. Returns status: 'sent' | 'rejected' | 'failed'.",
    category: "communication",
    input: z.object({
      method: z.literal("email"),
      email: z.string(),
    }),
    execute: async (
      input: { method: "email"; email: string },
      ctx?: ToolExecuteContext,
    ): Promise<string> => {
      const fail = (status: "rejected" | "failed", message: string): string =>
        JSON.stringify({ status, message } satisfies RequestAuthResult);

      if (!booted) {
        return fail("failed", "visitorAuth has not finished booting; try again shortly.");
      }
      if (!ctx?.peer) {
        return fail("failed", "request_auth requires turn context with a peer identity.");
      }
      if (input.method !== "email") {
        return fail(
          "rejected",
          `method "${input.method}" not supported in this build; only "email" is available.`,
        );
      }
      const email = input.email.trim().toLowerCase();
      if (!isWellFormedEmail(email)) {
        return fail("rejected", "Email address is malformed.");
      }

      // Email-in-recent-message validation (fix #4).
      const recent = recentByPeer.get(ctx.peer.id) ?? [];
      const match = emailAppearsInRecentMessages(email, recent);
      if (!match.matched) {
        return fail(
          "rejected",
          "Email was not found in the visitor's recent messages. Refusing to send to an address the visitor did not type.",
        );
      }

      // Per-email rate limit (fix H1: threadId rotation bypass).
      // Keying on email prevents an attacker from rotating peer.id / threadId
      // to escape the rate limit. The "email:" prefix namespaces the key so
      // future per-IP keying (e.g. "ip:...") can coexist without collision.
      const t = now();
      const rlKey = `email:${email}`;
      const rl = rateLimiter.check(rlKey, t);
      if (!rl.allowed) {
        const wait = Math.ceil(rl.retryAfterSec / 60);
        return fail(
          "rejected",
          `Verification rate limit reached for this visitor (${rl.reason}). Try again in ~${wait} minute(s).`,
        );
      }

      // Invalidate any prior open token for this peer; only one open at a time.
      store.invalidateOpenTokensForPeer(ctx.peer.id, t);

      // Mint a fresh token + write the row + build URL.
      const token = crypto.randomUUID();
      const ttlMs = tokenTtlMin * 60_000;
      store.issueToken({
        token,
        email,
        peerId: ctx.peer.id,
        threadId: ctx.threadId,
        expiresAt: t + ttlMs,
        // `||` (not `??`) so empty-string from emailAppearsInRecentMessages
        // (when the recent message had no messageId) becomes null, not "".
        sourceMessageId: match.messageId || null,
      });
      const verifyUrl = buildVerifyUrl(token);
      const { subject, text } = buildEmailBody(verifyUrl, tokenTtlMin);

      // Send via agentmail-client.ts (direct — see plan §"Spec deviation").
      const sendResult = await agentMail.send({
        inboxId: opts.agentMail.inboxId,
        to: [email],
        subject,
        text,
        labels: ["visitor-auth", "verify"],
      });

      if (sendResult.status !== "sent") {
        // Mark the token consumed so it can't be redeemed despite the visitor never receiving it.
        // (Lower-cost than leaving live tokens for failed sends.)
        store.invalidateOpenTokensForPeer(ctx.peer.id, t + 1);
        return fail(
          "failed",
          `Failed to send verification email: ${sendResult.detail ?? "unknown error"}`,
        );
      }

      // Record the rate-limit tick AFTER successful send (keyed to email, not peer).
      rateLimiter.record(rlKey, t);

      return JSON.stringify({
        status: "sent",
        message: `Verification email sent to ${email}. The link expires in ${tokenTtlMin} minutes.`,
        expiresInSec: Math.floor(ttlMs / 1000),
      } satisfies RequestAuthResult);
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
    return !!(row?.revoked);
  }

  const augment: Augment & { isVisitorRevoked: (visitorId: string) => boolean } = {
    name: "visitor-auth",
    capabilities: ["tools", "context"],
    tools: [requestAuthTool],
    isVisitorRevoked,
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
        handler: async (req, _opts) => {
          if (!booted || !signingCryptoKey) {
            return new Response(buildVerifyFailurePage({ reason: "unknown" }), {
              status: 503,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          const url = new URL(req.url);
          const token = url.searchParams.get("token");
          // UUID-shape validation — still reject malformed tokens early so the
          // confirm page is never shown for obviously wrong inputs.
          if (
            !token ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
          ) {
            return new Response(buildVerifyFailurePage({ reason: "malformed" }), {
              status: 400,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }
          // Do NOT touch the store — token is consumed only by POST.
          return new Response(
            buildVerifyConfirmPage({ token, publicUrl: opts.publicUrl }),
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
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
        handler: async (req, _opts) => {
          if (!booted || !signingCryptoKey) {
            return new Response(buildVerifyFailurePage({ reason: "unknown" }), {
              status: 503,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }

          // Read token from form-encoded body or JSON body.
          let token: string | null = null;
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
            // Malformed body — fall through to UUID validation below (token stays null).
          }

          // UUID-shape validation.
          if (
            !token ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
          ) {
            return new Response(buildVerifyFailurePage({ reason: "malformed" }), {
              status: 400,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }

          const t = now();
          const consume = store.consumeToken(token, t);
          if (!consume.consumed) {
            const status = store.tokenStatus(token, t);
            const reason: "unknown" | "expired" | "consumed" =
              status === "unknown" ? "unknown" : status === "expired" ? "expired" : "consumed";
            const httpStatus = status === "unknown" ? 404 : 410;
            return new Response(buildVerifyFailurePage({ reason }), {
              status: httpStatus,
              headers: { "content-type": "text/html; charset=utf-8" },
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
          const minted = await createVisitorToken(
            signingCryptoKey,
            agentBinding,
            ttlSec,
            reuseVisitorId,
          );

          // Record / touch the verified-visitor row:
          //   - Active (non-revoked) row: touch lastSeenAt, preserve visitorId.
          //   - Revoked row: un-revoke + rotate to new visitorId (avoids INSERT
          //     UNIQUE-constraint collision on email).
          //   - No row: fresh INSERT.
          if (existing && !existing.revoked) {
            store.touchVerifiedVisitor(consume.email!, t);
          } else if (existing && existing.revoked) {
            store.unrevokeAndRotate(
              consume.email!,
              minted.payload.visitorId,
              t,
              t + ttlSec * 1000,
            );
          } else {
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
          }

          // Anonymous→recognized peer-id migration. The verify route knows the
          // OLD peer-id (consume.peerId from the token row) and the NEW vis_<uuid>
          // (minted above; reuses existing visitorId on re-verify). Best-effort;
          // failures are logged and don't block success.
          migratePeerIdOnVerify(
            opts.layeredMemoryDbPath === undefined ? "./memory.db" : opts.layeredMemoryDbPath,
            consume.peerId!,
            minted.payload.visitorId,
          );

          // Operator notification on first verify per email (optional).
          if (opts.notifyOnFirstVerify) {
            const cfg = opts.notifyOnFirstVerify;
            if (!store.hasNotifiedFirstVerifyFor(consume.email!)) {
              // Mark BEFORE the send so a transient AgentMail outage doesn't
              // result in repeated notifications.
              store.markNotifiedFirstVerifyFor(consume.email!, t);
              const subject = `${cfg.subjectPrefix ?? "[New verified visitor] "}${consume.email}`;
              const text = `A new visitor verified their email: ${consume.email!} (vis_id: ${minted.payload.visitorId}).`;
              try {
                await agentMail.send({
                  inboxId: opts.agentMail.inboxId,
                  to: [cfg.to],
                  subject,
                  text,
                  labels: ["visitor-auth", "first-verify-operator-note"],
                });
              } catch (err) {
                console.warn(
                  `[visitor-auth] first-verify operator notification failed: ${(err as Error).message}`,
                );
              }
            }
          }

          return new Response(
            buildVerifySuccessPage({ visitorToken: minted.token, email: consume.email! }),
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        },
      },
    ],
    async onBoot() {
      // Fail-fast on placeholder env-var leakage (operator forgot to set .env).
      if (looksLikePlaceholder(opts.agentMail.apiKey)) {
        throw new Error(
          `visitorAuth: AGENTMAIL_API_KEY is unresolved (got "${opts.agentMail.apiKey}"). Set it in .env and restart.`,
        );
      }
      if (looksLikePlaceholder(opts.agentMail.inboxId)) {
        throw new Error(
          `visitorAuth: AGENTMAIL_INBOX_ID is unresolved. Set it in .env and restart.`,
        );
      }
      if (looksLikePlaceholder(opts.signingKey)) {
        throw new Error(
          "visitorAuth: VISITOR_SIGNING_KEY is unresolved. Set it in .env and restart (the same value webTransport uses).",
        );
      }

      store.initialize();
      signingCryptoKey = await deriveSigningKey(opts.signingKey);

      // Best-effort AgentMail healthcheck — a transient outage shouldn't
      // prevent boot, but surface it loudly so the operator notices.
      const health = await agentMail.getInbox(opts.agentMail.inboxId);
      if (health.status !== "ok") {
        console.warn(
          `[visitor-auth] AgentMail inbox "${opts.agentMail.inboxId}" healthcheck failed: ${health.detail}. ` +
            `First send will surface the real error.`,
        );
      }

      booted = true;
    },
    async onTurnStart(turn: TurnState) {
      if (!turn.peer) return;
      const peerId = turn.peer.id;
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
          block(`Verification email to ${recent.email} expired. Visitor may request a new one.`),
        ];
      }
      const sentMin = Math.max(0, Math.floor((t - recent.issuedAt) / 60_000));
      const expiresMin = Math.max(1, Math.ceil((recent.expiresAt - t) / 60_000));
      return [
        block(
          `Verification email sent to ${recent.email} (sent ${sentMin}m ago, expires in ${expiresMin}m). Awaiting click.`,
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
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readwrite: true });
    db.run("PRAGMA journal_mode = WAL");
    const result = db
      .prepare(`UPDATE entries SET peer_id = ? WHERE peer_id = ?`)
      .run(newPeerId, oldPeerId);
    if (result.changes > 0) {
      console.info(
        `[visitor-auth] migrated ${result.changes} memory row(s) ${oldPeerId} → ${newPeerId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[visitor-auth] peer-id migration failed for ${oldPeerId} → ${newPeerId}: ${(err as Error).message}`,
    );
  } finally {
    // Guarantee close on every path (success, mid-statement throw, anything).
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors — db is already in an unrecoverable state.
      }
    }
  }
}

// Internal-only re-exports for Task 7+ (avoid duplicating types in tests).
export type { VisitorAuthOptions };

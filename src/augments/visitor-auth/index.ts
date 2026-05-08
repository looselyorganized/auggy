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

import { z } from "zod";
import { defineTool } from "../../helpers";
import { createAgentMailClient, type AgentMailClient } from "../../agentmail-client";
import {
  createVisitorToken,
  deriveSigningKey,
} from "../../transports/visitor-token";
import type {
  Augment,
  ContextBlock,
  ToolExecuteContext,
  TurnState,
} from "../../types";
import type {
  RecentVisitorMessage,
  RequestAuthResult,
  VisitorAuthOptions,
} from "./types";
import {
  createSqliteVisitorAuthStore,
  type SqliteVisitorAuthStoreConfig,
} from "./storage/sqlite-store";
import type { VisitorAuthStore } from "./storage/types";
import {
  emailAppearsInRecentMessages,
  isWellFormedEmail,
} from "./email-validation";
import {
  createVisitorAuthRateLimiter,
  type VisitorAuthRateLimiter,
} from "./rate-limiter";
import {
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

export function visitorAuth(opts: VisitorAuthInternalOptions): Augment {
  validateOptions(opts);

  const now = opts._now ?? (() => Date.now());
  const tokenTtlMin = opts.tokenTtlMinutes ?? DEFAULT_TOKEN_TTL_MIN;
  const reverifyDays = opts.reverifyAfterDays ?? DEFAULT_REVERIFY_DAYS;
  const rateLimitCaps = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  const subjectPrefix = opts.agentMail.subjectPrefix ?? "[Verify] ";

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

  // Stub tool wired by Task 7 (request_auth). Skeleton uses a placeholder so
  // this commit still typechecks.
  const requestAuthTool = defineTool({
    name: "request_auth",
    description:
      "Send a verification email to a visitor's claimed address. Use to promote an anonymous visitor to recognized. method: 'email'.",
    category: "communication",
    input: z.object({
      method: z.literal("email"),
      email: z.string(),
    }),
    execute: async (_input, _ctx?: ToolExecuteContext): Promise<string> => {
      // Filled in by Task 7.
      return JSON.stringify({
        status: "failed",
        message: "request_auth: not yet implemented",
      } satisfies RequestAuthResult);
    },
  });

  return {
    name: "visitor-auth",
    capabilities: ["tools", "context"],
    tools: [requestAuthTool],
    httpRoutes: [
      {
        method: "GET",
        path: VERIFY_PATH,
        auth: "none",
        rateLimit: { maxPerMinute: 60 },
        handler: async (_req, _opts) => {
          // Filled in by Task 8.
          return new Response(buildVerifyFailurePage({ reason: "unknown" }), {
            status: 501,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
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
      try {
        // The agentmail-client doesn't expose inboxes.get yet. Task 11 wires
        // a real call when we extend the client. For the skeleton we do a
        // benign no-op.
      } catch (err) {
        console.warn(
          `[visitor-auth] AgentMail healthcheck failed: ${(err as Error).message}. First send will surface the real error.`,
        );
      }

      booted = true;
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
      // Filled in by Task 10 (context block).
      return [];
    },
  };
}

// Internal-only re-exports for Task 7+ (avoid duplicating types in tests).
export type { VisitorAuthOptions };

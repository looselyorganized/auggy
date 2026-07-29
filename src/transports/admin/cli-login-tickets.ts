import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CONSOLE_CLI_LOGIN_TICKET_TTL_MS = 30_000;
export const CONSOLE_CLI_LOGIN_TICKET_PATH_PREFIX = "/console/cli-login/";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_PENDING_TICKETS = 64;

interface PendingTicket {
  bearerDigest: Buffer;
  origin: string;
  expiresAt: number;
}

export interface ConsoleCliLoginTicketStore {
  issue(args: { bearer: string; origin: string }): {
    token: string;
    expiresInSeconds: number;
  };
  consume(args: {
    token: string;
    bearer: string;
    origin: string;
  }): { ok: true; nextPath: "/console/chat" } | { ok: false };
}

export function createConsoleCliLoginTicketStore(
  options: {
    now?: () => number;
    randomToken?: () => string;
    maxPendingTickets?: number;
    ttlMs?: number;
  } = {},
): ConsoleCliLoginTicketStore {
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const maxPendingTickets = options.maxPendingTickets ?? DEFAULT_MAX_PENDING_TICKETS;
  const ttlMs = options.ttlMs ?? CONSOLE_CLI_LOGIN_TICKET_TTL_MS;
  const pending = new Map<string, PendingTicket>();

  function pruneExpired(at: number): void {
    for (const [digest, ticket] of pending) {
      if (ticket.expiresAt <= at) pending.delete(digest);
    }
  }

  return {
    issue({ bearer, origin }) {
      const issuedAt = now();
      pruneExpired(issuedAt);
      if (pending.size >= maxPendingTickets) {
        throw new Error("too many pending Console sign-in tickets");
      }

      let token = "";
      let digest = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        token = randomToken();
        if (!TOKEN_RE.test(token)) {
          throw new Error("Console sign-in ticket generator returned an invalid token");
        }
        digest = tokenDigest(token);
        if (!pending.has(digest)) break;
        token = "";
      }
      if (!token) throw new Error("Console sign-in ticket collision");

      pending.set(digest, {
        bearerDigest: bearerDigest(bearer),
        origin,
        expiresAt: issuedAt + ttlMs,
      });
      return {
        token,
        expiresInSeconds: Math.ceil(ttlMs / 1000),
      };
    },

    consume({ token, bearer, origin }) {
      if (!TOKEN_RE.test(token)) return { ok: false };
      const digest = tokenDigest(token);
      const ticket = pending.get(digest);
      if (!ticket) return { ok: false };

      // A ticket is single-use even when presented against the wrong origin or
      // bearer. This prevents a copied capability from being probed repeatedly.
      pending.delete(digest);
      if (ticket.expiresAt <= now()) return { ok: false };
      if (ticket.origin !== origin) return { ok: false };
      if (!safeBufferEqual(ticket.bearerDigest, bearerDigest(bearer))) return { ok: false };
      return { ok: true, nextPath: "/console/chat" };
    },
  };
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function bearerDigest(bearer: string): Buffer {
  return createHash("sha256").update(`auggy-console-cli:${bearer}`).digest();
}

function safeBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
